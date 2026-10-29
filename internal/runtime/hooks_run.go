package runtime

import (
	"context"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/agent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/hooks"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// The runtime's half of the hook wiring: the two events that belong to a **turn**
// rather than to a tool call.
//
// They live here and not in `internal/agent` for one reason each, and the two
// reasons are the same one twice: a turn's lifetime is the runtime's. `session_*`
// needs a runtime that exists before the first turn and outlives the last one;
// `stop` needs to know whether the turn was started by a person or by the goal
// driver, and that answer is in the session's history, which the runtime owns the
// reading of.

// fireSessionStart runs `session_start` once, while the runtime is whole and before
// the first request.
//
// `source` distinguishes the three ways a runtime comes up, and it is a field
// rather than something a hook infers: `resume` and `switch` both open an existing
// session, and a hook that wants to greet a new session has no other way to tell
// whether this one is new.
//
// The context it injects is turn-scoped, so it reaches the **first** request and
// no later one. That is what makes "session_start said the repo uses pnpm" show up
// exactly where it was meant to.
func (r *Runtime) fireSessionStart(source string) {
	if r.Hooks == nil || !r.Hooks.Has(hooks.EventSessionStart) {
		return
	}
	envelope := r.hookBase().Envelope(hooks.EventSessionStart)
	envelope.Source = source
	// Nil-safe: a runtime assembled by hand has no client, and a hook that would like
	// to know the model has to be told "nothing" rather than crash the path that
	// describes the session.
	if r.Chat != nil {
		envelope.Model = r.Chat.ModelName()
		envelope.Provider = r.Chat.ProviderName()
	}
	result := r.Hooks.Fire(context.Background(), envelope)
	r.HookContext.AddTurnParts(result.Parts)
}

// fireSessionEnd runs `session_end` while the audit sink is still open.
//
// It is the last hook a session fires and the first one whose records could be
// lost, so the ordering in `Close` is explicit: hooks, then the sinks. A session_end
// hook that reports into a closed sink is a hook nobody can ever see the output of.
//
// **Once.** `CloseForSwitch` labels the close and then calls `Close`, and a second
// firing would mean a hook that writes a session report wrote two.
func (r *Runtime) fireSessionEnd(reason string) {
	if r.Hooks == nil || !r.Hooks.Has(hooks.EventSessionEnd) {
		return
	}
	r.sessionEndOnce.Do(func() {
		envelope := r.hookBase().Envelope(hooks.EventSessionEnd)
		envelope.Reason = reason
		r.Hooks.Fire(context.Background(), envelope)
	})
}

// fireUserPromptSubmit runs `user_prompt_submit` before the message enters history.
//
// A refusal is returned as `*hooks.PromptBlocked` and **nothing is appended**: the
// turn did not happen, and a session that recorded "the person said this" followed
// by no answer would be a transcript of a turn that never ran. The front end turns
// the error into a notice; it is not an answer and it must not be drawn as one.
func (r *Runtime) fireUserPromptSubmit(text string) error {
	if r.Hooks == nil || !r.Hooks.Has(hooks.EventUserPromptSubmit) {
		return nil
	}
	envelope := r.hookBase().Envelope(hooks.EventUserPromptSubmit)
	envelope.Prompt = text
	result := r.Hooks.Fire(context.Background(), envelope)
	if result.Decision == hooks.DecisionDeny {
		hook := result.DeniedBy
		reason := result.Reason
		if reason == "" {
			reason = "the message was refused"
		}
		return &hooks.PromptBlocked{Hook: hook, Reason: reason}
	}
	r.HookContext.AddTurnParts(result.Parts)
	return nil
}

// firePreCompact is `Runtime.HookPreCompact`'s body: the text handed to the
// summarising model.
//
// Its answer goes into the **summary's own prompt**, not into the next request's
// tail and above all not into the fold boundary. See `agent.Config.HookPreCompact`.
func (r *Runtime) firePreCompact(foldPoint, messages, before int) string {
	if r.Hooks == nil || !r.Hooks.Has(hooks.EventPreCompact) {
		return ""
	}
	envelope := r.hookBase().Envelope(hooks.EventPreCompact)
	envelope.FoldPoint = foldPoint
	envelope.Messages = messages
	envelope.Before = before
	result := r.Hooks.Fire(context.Background(), envelope)
	return result.Context
}

// stopHook answers the agent's `stop` question.
//
// It returns whether the turn gets one more round. Three facts shape the answer:
//
//   - **`autonomous` ignores `block`.** Continuing a goal is the driver's decision,
//     and a hook competing with it would make "why did this session keep running"
//     have two answers that were bound to disagree. The request is recorded (the
//     `hook_result` row is written by the runner either way) and then dropped.
//   - **the reason reaches the person, not the model.** A `stop` hook that asks for
//     another round is describing work it wants done; the model gets the loop's own
//     note (see `agent.stopContinueNote`) rather than the hook's words, because the
//     hook's words are addressed to whoever configured it.
//   - **a notice goes out**, so a turn that visibly continues has a line saying why.
//     Without it the second answer would appear as the model talking to itself.
func (r *Runtime) stopHook(stop agent.StopNotice) bool {
	if r.Hooks == nil || !r.Hooks.Has(hooks.EventStop) {
		return false
	}
	envelope := r.hookBase().Envelope(hooks.EventStop)
	envelope.StopReason = stop.StopReason
	envelope.LastAssistantMessage = stop.LastAssistantMessage
	envelope.Autonomous = stop.Autonomous
	result := r.Hooks.Fire(context.Background(), envelope)

	if result.Decision != hooks.DecisionDeny {
		// `deny` is the runner's dialect for `block` on this event (they are the
		// same word, and the decision protocol says `block` is a deny alias).
		return false
	}
	if stop.Autonomous {
		r.queueHookNotice(notice("info", "hooks",
			i18n.T("notice.hooks.continue_turn", "reason", "ignored: this was an automatic goal round")))
		return false
	}
	r.queueHookNotice(notice("info", "hooks",
		i18n.T("notice.hooks.continue_turn", "reason", hookReason(result))))
	return true
}

// queueHookNotice holds one line until the turn it belongs to is over.
//
// `r.notices` cannot be used for this: it is read once when `init` is built, and a
// line appended after that is a line no front end ever draws. The queue exists for
// the same reason `ericAuth` has one.
func (r *Runtime) queueHookNotice(item map[string]any) {
	r.hookNoticesMu.Lock()
	defer r.hookNoticesMu.Unlock()
	r.hookNotices = append(r.hookNotices, item)
}

// hookReason is the short sentence that says which hook asked and what it said.
func hookReason(result hooks.Result) string {
	hook := result.DeniedBy
	reason := result.Reason
	if reason == "" {
		reason = "no reason was given"
	}
	if hook == "" {
		return reason
	}
	return hook + ": " + reason
}

// hookBase is the envelope template for this runtime.
//
// The mode is read from the live session rather than from the assembly-time flag:
// `SetAutopilot` changes it from the interface, and a hook deciding whether a person
// can be asked has to see the mode of the call in front of it.
//
// A runtime assembled by hand (a test) may have no workspace and no agent; both are
// read nil-safely, because the alternative is a panic on a path whose whole job is to
// describe a session that already started.
func (r *Runtime) hookBase() hooks.Base {
	workspace := ""
	if r.Workspace != nil {
		workspace = r.Workspace.Root()
	}
	autopilot := r.Agent != nil && r.Agent.Autopilot()
	return hooks.Base{
		SessionID: r.SessionIDValue,
		Workspace: workspace,
		Cwd:       workspace,
		Mode:      hooks.ModeFor(autopilot),
	}
}

// DrainHookNotices returns and clears the notices the hook layer produced while the
// session was running — today, one line when a `stop` hook continues a turn.
//
// The protocol server calls it the same way it drains the credential notices (see
// `protocol.Server.finishTurn`), and for the same reason: a line about a turn
// belongs after the turn, and a front end drawing it mid-turn would put it under an
// answer that is still arriving.
func (r *Runtime) DrainHookNotices() []map[string]any {
	r.hookNoticesMu.Lock()
	defer r.hookNoticesMu.Unlock()
	if len(r.hookNotices) == 0 {
		return nil
	}
	pending := r.hookNotices
	r.hookNotices = nil
	return pending
}
