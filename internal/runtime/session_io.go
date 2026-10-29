package runtime

import (
	"context"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/skills"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/subagent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

// deltaSink decides whether stream increments go anywhere.
//
// `--no-stream` has to be honoured **here**, not only in the request body. The
// switch means "deliver the answer in one piece", and a front end that still
// received deltas would draw it growing word by word while `init.stream` and the
// status bar both said streaming was off — the interface and its own report
// disagreeing about the most visible thing on the screen.
//
// Nil is the honest signal: the agent asks the adapter for a stream only when
// somebody is listening, so this also keeps `stream` out of the request body.
func deltaSink(options Options) func(step int, text, reasoning string, reset bool) {
	if !options.Stream {
		return nil
	}
	return options.OnDelta
}

// Checkpoint writes the session down. It is the public name for what the agent
// calls between whole steps, and it exists because the goal layer has two more
// writers of session state: the goal tools, which commit a decision about what the
// session is for, and the driver, which commits a spent round number. Both need
// that write to happen before they return rather than at the next step boundary,
// and both live outside this file.
func (r *Runtime) Checkpoint() { r.checkpoint() }

func (r *Runtime) checkpoint() {
	if r.Store == nil || r.SessionValue == nil {
		return
	}
	r.SessionValue.SetContext(r.contextHandle())
	if err := r.Store.Save(r.SessionValue); err != nil {
		warn("%s", i18n.T("save.failed", "what", "saving the session", "problem", err.Error()))
	}
}

// auditRecord is the record as it is written to the log.
//
// `child_origin` is dropped, and dropping it is what keeps "the audit log is the
// protocol" true at the byte level: it is a note from this program to its own
// protocol layer, and a reader of the log has no use for it — a child's records
// are in the child's own file, so which file a line came from already answers the
// question it asks.
//
// The map is copied only when there is something to drop, because this runs once
// per event on every turn and the common case is a record with nothing to remove.
func auditRecord(record map[string]any) map[string]any {
	if _, present := record[subagent.ChildOriginKey]; !present {
		return record
	}
	trimmed := make(map[string]any, len(record))
	for key, value := range record {
		if key == subagent.ChildOriginKey {
			continue
		}
		trimmed[key] = value
	}
	return trimmed
}

func (r *Runtime) onEvent(record map[string]any) {
	// The audit first, protocol second — in that order, so a front end that dies
	// mid-turn cannot cost the record. And a failed audit write is swallowed: an
	// observation failure must never damage what is being observed, and the caller
	// here is sometimes holding a half-written message list.
	if r.Logs != nil {
		if err := r.Logs.Write(auditRecord(record)); err != nil {
			warn("audit write failed: %v", err)
		}
	}
	// The usage ledger rides the same stream. It sees the record as emitted —
	// before `auditRecord` trims the child-origin marker — but it reads none of
	// the fields that marker exists for, so the copy `auditRecord` would make
	// would be spent for nothing.
	if r.Usage != nil {
		r.Usage.Observe(record)
	}
	if r.OnEventHook != nil {
		r.OnEventHook(record)
	}
}

// notes is the trailing block appended to every request payload.
//
// Seven parts, in this order: the skill catalogue, the loaded skill bodies, the
// workspace memory, the goal, the task list, the background-job warning, and the
// delegations in flight. None of them enters the session's messages: all seven are
// this run's working memory, not something either party said.
//
// **The order is by how costly it is to miss.** The catalogue is a menu; the goal
// and the task list are what the model is doing and why; the jobs and the
// delegations are the two places where not reading the notice causes an error
// (treating a command that is still running as one that succeeded), and the end of
// the payload sits closest to the token the model is about to generate — which is
// also the most expensive and the only position that should differ between two
// consecutive requests.
//
// The goal goes **above** the task list because it is the more durable of the two:
// a task list is this turn's plan and the goal is what the plan is for, so a model
// reading them in that order reads "why, then what". It also has to be in the tail
// rather than left in the history for the same reason the list does — the history
// holds N stale copies, and compaction is what folds the oldest of them away first.
func (r *Runtime) notes() string {
	var parts []string
	// The skill catalogue goes out every round rather than into the system prompt.
	// The prompt is written once when the session is created, and skills can be
	// added at any time — so a restored session would be permanently blind to
	// every skill added since. The cost is about thirty tokens per skill per
	// round, and the tail sits outside the cached prefix anyway.
	if r.Skills != nil {
		catalog := r.Skills.Catalog()
		if part := skills.CatalogPart(r.metaSnapshot(), catalog); part != "" {
			parts = append(parts, part)
		}
		if note := r.Skills.Note(); note != "" {
			parts = append(parts, note)
		}
	}
	// [memory] What this workspace already knows about this turn. It goes here — above
	// the goal and the task list — because those two describe *this* turn and have to
	// stay closest to the token being generated, while a memory is background reference
	// material: read it, judge whether it still applies, then get on with the work.
	if note := r.memoryNote(); note != "" {
		parts = append(parts, note)
	}
	// The goal, if this session has one. It is rendered from the same board the
	// goal tools write through, so the model cannot be told one thing here and
	// another thing by get_goal.
	if r.Goal != nil {
		if goal, ok := r.goal(); ok {
			parts = append(parts, state.GoalText(goal, r.activation()))
		}
	}
	// The task list the model maintains itself. It has to be here rather than left
	// in the history: the whole point of the list is to be in front of the model
	// when it decides what to do next, and the history holds N stale copies.
	if note := builtin.NewTodoBoard(r.meta()).Note(); note != "" {
		parts = append(parts, note)
	}
	if r.Jobs != nil {
		if note := r.Jobs.Note(); note != "" {
			parts = append(parts, note)
		}
	}
	// Delegations go after the jobs, which is the same ordering rule: the nearer
	// the end of the payload, the more expensive it is to miss. A job that is
	// still running is a command whose result does not exist yet; a delegation in
	// flight is work the parent itself is blocked on, so it is the least likely of
	// the two to be misread — but it is also the only evidence that the work was
	// ever started, which is what a resumed session needs.
	if r.Subagents != nil {
		if note := r.Subagents.Note(); note != "" {
			parts = append(parts, note)
		}
	}
	return strings.Join(parts, "\n\n")
}

// --- protocol.Runtime -------------------------------------------------------

// activation reads the live authorization for the goal.
//
// A resumed session always answers "disarmed". That is the rule the design turns
// on: reopening a session must never resume autonomous work, because the person
// who asked for it is not necessarily the person now looking at the screen. The
// check is written as a direct test of Resumed rather than left to the field's
// zero value, so that a later change arming goals during assembly has to decide
// about this case explicitly instead of inheriting it.
func (r *Runtime) activation() state.Activation {
	if r.Resumed || !r.goalActivated {
		return state.ActivationDisarmed
	}
	return state.ActivationArmed
}

// SessionID implements protocol.Runtime.
func (r *Runtime) SessionID() string { return r.SessionIDValue }

// Messages implements protocol.Runtime.
func (r *Runtime) Messages() []map[string]any {
	if r.SessionValue == nil {
		return []map[string]any{}
	}
	return r.SessionValue.MessagesSnapshot()
}

// RunTurn implements protocol.Runtime.
//
// The opening message is composed here rather than passed through as a bare string,
// because this is the one point where a user's text can be scanned for pictures:
// `attachPictures` resolves whatever the message names, stores the bytes, and
// returns the body — which is a plain string whenever nothing was attached, so a
// session that never used the feature sends exactly what it always sent.
func (r *Runtime) RunTurn(ctx context.Context, text string) (string, error) {
	// The code-intelligence switch is a workspace fact stored in a file, and this
	// process may not be the one that flipped it. Reconcile before the agent builds
	// the turn's tool schema, or a second window keeps a tool set the person has
	// already turned off (or misses one they turned on).
	r.refreshCodeIntelPermission()

	// `user_prompt_submit` runs **before** anything is appended, and a refusal
	// leaves the session exactly as it was.
	//
	// The ordering is the whole contract: a turn a hook refused did not happen, so
	// there is no user message, no assistant answer and no run — and a front end
	// told "that was refused" has a true story to tell. Appending first and
	// unwinding afterwards would leave a session claiming the person said something
	// that produced nothing, which is indistinguishable from a crash.
	if err := r.fireUserPromptSubmit(text); err != nil {
		return "", err
	}
	// The turn's hook context lives exactly as long as the turn, and the defer is
	// what makes that true on every exit — an answer, a cancellation, a model
	// failure. A note that survived its turn would be re-injected into a request
	// that has nothing to do with the tool calls it describes.
	defer r.HookContext.ClearTurn()

	// [memory] The turn-start retrieval happens **before** the agent runs, so the first
	// request of the turn already carries what this workspace knows. It is the only
	// trigger that sees the person's own words rather than an error, and that is where a
	// collaboration preference is found.
	r.recallForTurn(text)
	return r.Agent.RunMessages(ctx, r.turnMessages(text))
}

// SetAutopilot implements protocol.Runtime.
func (r *Runtime) SetAutopilot(on bool) { r.Agent.SetAutopilot(on) }

// Close implements protocol.Runtime.
func (r *Runtime) Close() error {
	// `session_end` goes **first**, while the audit sink is still open: the hook's
	// own `hook_result` record has to land in the same file as everything else it
	// observed, and a hook fired after the sink closes is a hook whose output nobody
	// can ever read.
	//
	// It is fired on every close path that the runtime itself controls (a session
	// switch, a delete of the mounted session, process shutdown). `reason` is
	// `shutdown` rather than `switch` because this method cannot tell the two apart
	// — see `CloseForSwitch`, which the protocol layer calls instead when it does.
	r.fireSessionEnd(hookReasonShutdown)

	if r.Jobs != nil {
		if err := r.Jobs.Close(); err != nil {
			warn("%s", i18n.T("close.jobs_failed", "problem", err.Error()))
		}
	}
	// The audit sink holds its session's file open between records (see
	// `audit.JsonlSink`). Letting the descriptor go here rather than at process
	// exit is what keeps "one open file per session" from also meaning "one open
	// file per session that outlives the shutdown path".
	if r.Logs != nil {
		if err := r.Logs.Close(); err != nil {
			warn("%s", i18n.T("close.logs_failed", "problem", err.Error()))
		}
	}
	// Same reason as the audit sink above: a resident handle per shared store is
	// one the shutdown path lets go of, and a later append reopens it.
	if r.Usage != nil {
		if err := r.Usage.Close(); err != nil {
			warn("usage ledger close failed: %v", err)
		}
	}
	// A mounted server is a child process. Leaving children behind on exit is how
	// ports and file handles stay held after the window is closed.
	for _, problem := range r.CloseMcp() {
		warn("%s", problem)
	}
	return nil
}

// The two values `session_end.reason` can take.
//
// They are distinct because a hook that writes a session report, or bumps a
// counter, needs to tell "this session was put away" from "this person switched to
// another one and will be back". A single value would make the answer "somebody
// closed something", which is not worth collecting.
const (
	hookReasonShutdown = "shutdown"
	hookReasonSwitch   = "switch"
)

// CloseForSwitch closes this runtime because another session is being mounted.
//
// It exists so `session_end.reason` can be told apart, and it is the method the
// protocol layer calls on a switch. `Close` remains the shutdown path, including
// the one the process exit takes, so a close nobody labelled is never reported as a
// switch.
func (r *Runtime) CloseForSwitch() error {
	r.fireSessionEnd(hookReasonSwitch)
	return r.Close()
}
