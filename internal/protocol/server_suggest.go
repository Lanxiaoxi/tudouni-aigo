package protocol

import (
	"context"
	"strings"
)

// Suggested replies, as this layer sees them: **when** to ask, and how to stop
// asking. What to ask and how is the runtime's business (see
// `runtime.SuggestReplies`), and this file knows nothing about models.
//
// The rules, each of which is about not disturbing the conversation:
//
//   - **Off the turn's goroutine.** `finishTurn` runs before the turn's `done`
//     is closed, and `startTurnWith` waits on `done` — so a side request made
//     inline would hold the person's next message behind it.
//   - **Cancelled by the next turn.** `startTurnWith` and `resetTurnState`
//     cancel it, so it never overlaps a turn for longer than the cancel takes to
//     reach the request, and a result that arrives late is dropped.
//   - **Only after a turn a person started ended with an answer**, with nothing
//     continuing on its own (`finishTurn` calls this only once the goal driver
//     has declined another round), no stop asked for, and the switch on.

// Suggester is what a runtime offers for suggested replies. Optional, like the
// goal hooks: a runtime without it simply never draws buttons.
type Suggester interface {
	SuggestReplies(ctx context.Context, runID, prompt, answer string) ([]string, error)
}

// SetSuggestionsEnabled turns the feature on or off for this process. On by
// default; the front end sends `set_suggestions` when the person has turned it
// off. Turning it off also cancels a request already in flight.
func (s *Server) SetSuggestionsEnabled(on bool) {
	s.mu.Lock()
	s.suggestionsOff = !on
	s.mu.Unlock()
	if !on {
		s.cancelSuggestion()
	}
}

// suggestAfter starts the side request for a turn that has just finished.
func (s *Server) suggestAfter(runtime Runtime, prompt, answer string, err error) {
	if err != nil || strings.TrimSpace(prompt) == "" || strings.TrimSpace(answer) == "" {
		return
	}
	suggester, ok := runtime.(Suggester)
	if !ok {
		return
	}
	runID := s.lastRun()
	if runID == "" {
		return
	}

	s.mu.Lock()
	if s.suggestionsOff || s.stop {
		s.mu.Unlock()
		return
	}
	// One at a time: a previous request still running belongs to a turn that is
	// no longer the last one.
	if s.suggestCancel != nil {
		s.suggestCancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.suggestCtx, s.suggestCancel = ctx, cancel
	s.mu.Unlock()

	go func() {
		defer cancel()
		replies, err := suggester.SuggestReplies(ctx, runID, prompt, answer)
		if err != nil || len(replies) == 0 {
			// Nothing to draw, and nothing to say: a button that is not there is
			// the whole failure mode of this feature.
			return
		}
		// Checked and sent under the same lock the cancel takes, so a turn that
		// starts between the answer arriving and the send cannot be followed by
		// buttons offering to answer the turn before it.
		s.mu.Lock()
		defer s.mu.Unlock()
		if ctx.Err() != nil || s.suggestCtx != ctx || s.runtime != runtime {
			return
		}
		s.Send(map[string]any{
			"v": VERSION, "t": OutUI, "kind": UISuggestions,
			"run_id": runID, "replies": replies,
		})
	}()
}

// cancelSuggestion abandons the side request in flight, if any.
func (s *Server) cancelSuggestion() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cancelSuggestionLocked()
}

// cancelSuggestionLocked is cancelSuggestion for a caller holding s.mu.
func (s *Server) cancelSuggestionLocked() {
	if s.suggestCancel != nil {
		s.suggestCancel()
	}
	s.suggestCtx, s.suggestCancel = nil, nil
}
