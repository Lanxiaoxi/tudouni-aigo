package protocol

import (
	"context"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// The turn: starting one, running it, stopping it.
//
// A turn is one exchange — the person's message, every model step it takes, and
// the answer — and everything that can only be reasoned about while exactly one of
// them is in flight lives here. The facts this file is organised around are:
//
//   - **turns never overlap.** `startTurnWith` begins with `joinTurn`, so the only
//     instant at which the message list is consistent is between turns. That is
//     also the only instant at which "is this session finished?" has an answer,
//     which is why `finishTurn` — not the agent — asks the goal driver whether
//     another round is allowed.
//   - **a person's message stops the turn it lands on.** `startTurn` opens with
//     `requestStop`, so a `user_message` sent while a turn runs is the stop
//     button and a new message in one act, not a queue forming behind work the
//     person has superseded. The reserved goal round keeps the plain waiting
//     semantics: it is only ever fired after the previous turn's `done` anyway.
//   - **a stop has two halves.** A context reaches work already in flight (a
//     request waiting for its first byte, a shell command), and a flag answers a
//     synchronous question ("did somebody ask to stop during this turn"). Both are
//     created together in `startTurnWith` so they cannot disagree about which turn
//     they describe, and both are released by `requestStop`.
// JoinTurn waits for the running turn to finish, for a caller that needs a
// consistent message list.
func (s *Server) joinTurn() {
	s.turnMu.Lock()
	done := s.turnDone
	s.turnMu.Unlock()
	<-done
}

// startTurn begins a turn started by a person.
//
// A message that lands on a **running** turn stops it first — the same stop the
// stop button sends — and takes over once it has wound down. Waiting politely
// instead would park the read loop behind the old turn for as long as it likes to
// run: the loop is stdin's only reader, and an approval the old turn asked for
// while it was parked could never be read — the turn would wait forever on an
// answer its own front end had already given.
func (s *Server) startTurn(text string) {
	s.requestStop()
	s.startTurnWith(text, nil)
}

// startGoalTurn begins a turn the goal driver reserved.
//
// It goes through the same function as a person's turn on purpose: an automatic
// round has to wait for whatever is running, and it must not be a second
// scheduler. The reservation travels with the turn so the runtime can refuse it
// when the turn actually starts — the queue is where a goal edit, a pause, or a
// person's message can land in between.
func (s *Server) startGoalTurn(round GoalRound) bool {
	if round == nil {
		return false
	}
	return s.startTurnWith("", round)
}

func (s *Server) startTurnWith(text string, round GoalRound) bool {
	// Wait for the previous turn: two turns must never interleave, because the
	// message list is only consistent between steps.
	s.joinTurn()

	s.mu.Lock()
	s.stop = false
	// A fresh context per turn, created in the same critical section that clears the
	// flag, so the two can never disagree about which turn they describe. The
	// previous one is released here rather than left to the garbage collector: it
	// may still have goroutines parked on it, and cancelling is what wakes them.
	if s.turnCancel != nil {
		s.turnCancel()
	}
	s.turnCtx, s.turnCancel = context.WithCancel(context.Background())
	s.mu.Unlock()

	done := make(chan struct{})
	s.turnMu.Lock()
	s.turnDone = done
	s.goalRound = round
	s.turnMu.Unlock()

	runtime := s.current()
	if runtime == nil {
		s.clearGoalRound()
		close(done)
		s.notice("warn", "session", i18n.T("channels.model.no_session"))
		return false
	}

	// The turn runs on its own goroutine so the read loop keeps turning. That is
	// not a performance choice: if the loop were busy running the turn it could
	// never read the `permission_response` that the turn is waiting for, and the
	// two would deadlock.
	go func() {
		defer close(done)
		s.runTurn(runtime, text)
	}()
	return true
}

// clearGoalRound drops the reservation the next turn would have run.
func (s *Server) clearGoalRound() {
	s.turnMu.Lock()
	s.goalRound = nil
	s.turnMu.Unlock()
}

func (s *Server) pendingGoalRound() GoalRound {
	s.turnMu.Lock()
	defer s.turnMu.Unlock()
	return s.goalRound
}

func (s *Server) runTurn(runtime Runtime, text string) {
	ctx := s.turnContext()

	// A reserved round takes the path that composes its own opening message. A
	// stale reservation means no turn ran, and then there is nothing to report —
	// falling through to `RunTurn("")` would ask the model to answer an empty
	// question, which is a real turn spent on nothing.
	if round := s.pendingGoalRound(); round != nil {
		answer, err, ran := s.runGoalRound(ctx, runtime, round)
		if !ran {
			return
		}
		s.finishTurn(runtime, answer, err)
		return
	}

	answer, err := runtime.RunTurn(ctx, text)
	s.finishTurn(runtime, answer, err)
}

// runGoalRound runs one reserved round, or reports that it was refused.
func (s *Server) runGoalRound(ctx context.Context, runtime Runtime, round GoalRound) (string, error, bool) {
	s.clearGoalRound()
	runner, ok := runtime.(GoalRoundRunner)
	if !ok {
		return "", nil, false
	}
	answer, started, err := runner.StartGoalRound(ctx, round)
	if !started {
		return "", nil, false
	}
	return answer, err, true
}

// finishTurn reports a finished turn and then asks the goal driver whether another
// round is allowed.
//
// The order matters and it is the whole reason the hook is here rather than in the
// agent: by this point the answer has been sent, the session file holds the turn,
// the message list is consistent, and no other turn is running. That is the only
// instant at which "is this session finished?" has a well-defined answer.
func (s *Server) finishTurn(runtime Runtime, answer string, err error) {
	if err != nil {
		if isCancel(err) {
			s.notice("warn", "cancelled", i18n.T("channels.run_failed", "problem", err.Error()))
		} else {
			s.notice("warn", "model", i18n.T("channels.run_failed", "problem", err.Error()))
		}
	}

	s.mu.Lock()
	s.mu.Unlock()

	// The answer goes out after RunTurn returns, never from the event handler:
	// the handler runs before the answer exists, so sending it there would send
	// an empty string.
	s.Send(map[string]any{
		"v": VERSION, "t": OutUI, "kind": UIRunFinished,
		"answer": answer, "run_id": s.lastRun(),
	})

	// One more snapshot to close the turn: the task list may have changed on the
	// last step, and the panel should not be a turn behind.
	s.Send(s.stateMessage(false))

	// Whatever the runtime has to say about the session's credential, said now.
	//
	// It is collected **here** because this is the first moment the turn that earned
	// it is over, and the events are about that turn ("the token was replaced and
	// the request went out again"): sent while it was still running, the line would
	// arrive under a turn that is still drawing. The interface is an optional one,
	// like the goal hooks — a runtime that knows nothing about tokens does not
	// implement it, and this layer stays ignorant of what a credential is.
	if talker, ok := runtime.(interface{ DrainAuthNotices() []map[string]any }); ok {
		for _, item := range talker.DrainAuthNotices() {
			envelope := map[string]any{"v": VERSION, "t": OutNotice}
			for key, value := range item {
				envelope[key] = value
			}
			s.Send(envelope)
		}
	}

	// A reserved round is queued on its **own** goroutine, and it waits for this
	// turn's `done` first. Calling back into `startTurn` from here would deadlock:
	// that path begins with `joinTurn`, which waits for the very `done` this
	// function has not closed yet.
	scheduler, ok := runtime.(GoalRoundScheduler)
	if !ok {
		return
	}
	// **Before** the driver is asked, and this order is the whole point: a goal the
	// model created during a turn a person started becomes armed here, and the
	// driver then sees an armed, active goal and continues it. Asking the driver
	// first would mean every goal created this way was refused once for not being
	// armed yet — a round silently not taken, and the session stopping for no
	// reason the log explains.
	if armer, ok := runtime.(GoalArmer); ok {
		armer.ArmFromTurn()
	}
	round := s.reservedGoalRound(scheduler, err)
	if round == nil {
		return
	}
	done := s.currentTurnDone()
	go func() {
		<-done
		s.startGoalTurn(round)
	}()
}

// reservedGoalRound asks the runtime whether another round is allowed, and returns
// the reservation if it is.
//
// `stopped` is this server's own flag rather than the runtime's, because the
// question is "did somebody ask to stop **during this turn**" — and this flag is
// cleared at the start of every turn precisely so it can answer that. A stop inside
// a round has to turn continuation off, not merely end the round: an interrupt that
// is followed by another round is an interrupt that does not work.
func (s *Server) reservedGoalRound(scheduler GoalRoundScheduler, outcome error) GoalRound {
	var reserved GoalRound
	scheduler.ObserveTurn(outcome, s.ShouldStop(), func(round GoalRound) bool {
		if reserved != nil {
			// One at a time. A runtime that asked twice would be building a queue
			// it has no way to drain.
			return false
		}
		reserved = round
		return true
	})
	if reserved == nil {
		// The loop stopped. It may also have disarmed the goal, and the status
		// snapshot already sent was built before that decision — so one more goes
		// out, or the interface keeps reporting a session as ready to continue
		// after it has stopped. A queued round sends its own snapshots instead.
		s.Send(s.stateMessage(false))
	}
	return reserved
}

func (s *Server) currentTurnDone() <-chan struct{} {
	s.turnMu.Lock()
	defer s.turnMu.Unlock()
	return s.turnDone
}

// RequestStop asks the current turn to stop at its next safe point.
func (s *Server) RequestStop() { s.requestStop() }

func (s *Server) requestStop() {
	s.mu.Lock()
	s.stop = true
	cancel := s.turnCancel
	s.mu.Unlock()

	// The context goes first, and before anything else, because it is the half
	// that reaches work already in flight. Cancelling it is what makes a stop feel
	// immediate instead of arriving at the next safe point.
	if cancel != nil {
		cancel()
	}

	// A turn parked on an approval or a question is not waiting on the context —
	// it is waiting on `pending`. Releasing those waiters is what turns "stop" into
	// an answer (refused, unavailable) instead of a goroutine that only wakes when
	// the front end goes away.
	s.pending.abandonAll()
}

// turnContext is this turn's cancellation, for the goroutine running it.
//
// It cannot be nil in practice — every path that starts a turn creates it first —
// but a background context is substituted rather than returning nil, because a nil
// context reaching `http.NewRequestWithContext` is a panic and "the turn has no
// cancellation" is a legal state for an in-process caller.
func (s *Server) turnContext() context.Context {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.turnCtx == nil {
		return context.Background()
	}
	return s.turnCtx
}

// ShouldStop reports whether this turn has been asked to stop.
func (s *Server) ShouldStop() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stop
}

