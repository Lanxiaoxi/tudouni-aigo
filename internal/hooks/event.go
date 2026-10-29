// Package hooks runs the user's own commands at fixed points in a turn.
//
// It is a deliberately narrow layer: the runtime decides *when*, the user's script
// decides *what*, and the two meet over one JSON object on stdin and (at most) one
// on stdout. Nothing here knows what a tool is, what an approval is, or what a
// session file looks like — the callers hand in an Envelope and read back a
// Result, and `internal/agent` / `internal/runtime` are the only places that know
// where those two belong.
//
// Four rules shape everything in this package, and each one exists because the
// alternative is a failure that cannot be seen afterwards:
//
//  1. **The order is written down, not discovered.** Hooks of one event run
//     serially in configuration order, the first `deny` short-circuits, `ask` is
//     sticky, and a `none` never votes. A combination whose outcome depended on
//     which hook finished first would produce "it looked allowed but was not"
//     exactly once, in production.
//  2. **A gate fails closed; an observer does not.** `pre_tool_use` and
//     `permission_request` refuse the call when the hook times out, crashes or
//     writes nonsense. For every other event the same failure is only recorded:
//     a broken formatter must never wedge a turn.
//  3. **Context goes to the request tail, never into history.** `additional_context`
//     is returned as text for the caller to append to the payload; this package has
//     no way to write to a session, which is what makes "the session stays
//     replayable" true rather than a promise.
//  4. **The executable is the user's.** A hook is not sandboxed — it runs with the
//     same trust as the shell tool — but it is also never loaded from a workspace
//     (see `internal/runtime`), because a cloned repository is not a statement
//     about what may run on this machine.
package hooks

import (
	"encoding/json"
	"strings"
)

// Event names one fixed point a hook may be attached to.
//
// The names are lowercase and stable: they are what a user writes in
// `hooks.json`, what a script reads out of `hook_event_name`, and what an audit
// reader searches for.
type Event string

const (
	// EventSessionStart fires once, after the runtime is assembled and before the
	// first request.
	EventSessionStart Event = "session_start"
	// EventUserPromptSubmit fires before a person's message enters history.
	// Refusing it means the turn never starts, which is why the runtime returns a
	// PromptBlocked rather than an empty answer.
	EventUserPromptSubmit Event = "user_prompt_submit"
	// EventPreToolUse fires after the arguments parse and before the permission
	// gate. It is the one event that may rewrite arguments.
	EventPreToolUse Event = "pre_tool_use"
	// EventPostToolUse fires once a batch of tool calls has settled, in the
	// model's order, before the results enter history.
	EventPostToolUse Event = "post_tool_use"
	// EventPermissionRequest fires when the gate is about to ask a person, and may
	// answer instead of them.
	EventPermissionRequest Event = "permission_request"
	// EventStop fires when a turn ended normally, and `block` asks for one more
	// round.
	EventStop Event = "stop"
	// EventSessionEnd fires while the session's audit sink is still open.
	EventSessionEnd Event = "session_end"
	// EventSubagentStart fires after a child's route is resolved and before the
	// child session exists.
	EventSubagentStart Event = "subagent_start"
	// EventSubagentStop fires when a child has settled.
	EventSubagentStop Event = "subagent_stop"
	// EventPreCompact fires before a summary is generated.
	EventPreCompact Event = "pre_compact"
)

// Events is every event this build understands, in the order the design lists
// them. It is used by config validation and by `--hooks`, so the two can never
// disagree about which names are legal.
var Events = []Event{
	EventSessionStart,
	EventUserPromptSubmit,
	EventPreToolUse,
	EventPostToolUse,
	EventPermissionRequest,
	EventStop,
	EventSessionEnd,
	EventSubagentStart,
	EventSubagentStop,
	EventPreCompact,
}

// Valid reports whether the event is one of the ten above.
func (e Event) Valid() bool {
	for _, known := range Events {
		if e == known {
			return true
		}
	}
	return false
}

// Gate reports whether this event guards an action, which is what decides the
// default of `fail_closed`.
//
// The two gate events default to failing closed and everything else to failing
// open, and the asymmetry is the point rather than a tuning choice: a guardrail
// that breaks must not silently become transparent, while a formatter that breaks
// must not be able to stop a conversation.
func (e Event) Gate() bool {
	return e == EventPreToolUse || e == EventPermissionRequest
}

// ToolEvent reports whether a tool name is what the matcher is matched against.
func (e Event) ToolEvent() bool {
	return e == EventPreToolUse || e == EventPostToolUse || e == EventPermissionRequest
}

// Mode is how this runtime was asked to behave, in the words a hook reads.
const (
	ModeInteractive = "interactive"
	ModeAutopilot   = "autopilot"
)

// Scope tells a hook it is running inside a delegated child agent.
//
// An empty (nil) Scope means "the main session", which is the common case and
// therefore the one that costs nothing on the wire: the field is omitted, and a
// script that never looks at it keeps working.
type Scope struct {
	ID    string `json:"id"`
	Depth int    `json:"depth"`
	Label string `json:"label,omitempty"`
}

// ToolPayload groups the fields that describe one tool call.
//
// It is a struct with `json:"-"` fields rather than being inlined into Envelope
// so the Go side can pass one value around; the wire shape is flat, and
// Envelope.MarshalJSON is what flattens it.
type ToolPayload struct {
	Name string
	// Input is the arguments the call will run with. For `pre_tool_use` it is the
	// **accumulated** view: each hook sees what the hooks before it produced, which
	// is what makes two rewriters compose instead of fight.
	Input map[string]any
	Risk  string
	// CallID and Status/Result belong to `post_tool_use` (and to
	// `permission_request`, which has no result yet).
	CallID     string
	Status     string
	Result     string
	DurationMs int
	Truncated  bool
}

// Envelope is one event as a hook sees it.
//
// The zero value is not meaningful — callers fill in at least Event and SessionID
// — and the per-event fields below are simply absent from the JSON when they do
// not apply. That is deliberate: a `post_tool_use` record does not carry
// `prompt`, and a script testing for its presence is testing the event name
// twice over.
type Envelope struct {
	Event     Event
	SessionID string
	RunID     string
	Step      int
	Cwd       string
	Workspace string
	Mode      string
	Autopilot bool
	HookName  string
	Subagent  *Scope

	Tool *ToolPayload

	// session_start
	Source   string
	Model    string
	Provider string

	// user_prompt_submit
	Prompt string

	// stop
	StopReason           string
	LastAssistantMessage string
	Autonomous           bool

	// session_end
	Reason string

	// permission_request
	PolicyDecision string

	// pre_compact
	FoldPoint int
	Messages  int
	Before    int

	// subagent_start / subagent_stop
	Background bool
	TaskChars  int
	Usage      map[string]any
}

// Base is the part of an envelope that is the same for every event in one run:
// which session, which directory, whether anybody is watching, and whether this is
// a delegated child.
//
// It exists so a caller can hold one value and stamp envelope after envelope out of
// it. The alternative — every call site assembling the five common fields — is how
// one event ends up reporting the wrong mode, and the mode is what a hook branches
// on to decide whether "ask a human" is even possible.
type Base struct {
	SessionID string
	Workspace string
	Cwd       string
	// Mode is `interactive` or `autopilot`.
	Mode string
	// Subagent is nil for the main session.
	Subagent *Scope
}

// Envelope starts an envelope for one event.
//
// `step` and the run id are left to the caller: they are per-turn facts the agent
// owns, and a base that carried them would be a value that goes stale the moment
// the next step begins.
func (b Base) Envelope(event Event) Envelope {
	envelope := Envelope{
		Event:     event,
		SessionID: b.SessionID,
		Workspace: b.Workspace,
		Cwd:       b.Cwd,
		Mode:      b.Mode,
		Autopilot: b.Mode == ModeAutopilot,
		Subagent:  b.Subagent,
	}
	if envelope.Cwd == "" {
		envelope.Cwd = b.Workspace
	}
	return envelope
}

// ModeFor names the mode for a run.
func ModeFor(autopilot bool) string {
	if autopilot {
		return ModeAutopilot
	}
	return ModeInteractive
}

// clip makes the payload safe to hand to a process.
//
// The limits are on **fields**, not on the JSON: a hook that is told "this result
// was truncated" can decide to go and read the file itself, while a hook that
// receives half a JSON document can only fail. `truncated` is therefore a fact
// the script can see, and it is set by this function rather than by each caller
// so no event can forget it.
func (e Envelope) clip() (Envelope, bool) {
	cut := false
	if e.Prompt != "" {
		if clipped, truncated := clipText(e.Prompt, InputPromptBytes); truncated {
			e.Prompt, cut = clipped, true
		}
	}
	if e.LastAssistantMessage != "" {
		if clipped, truncated := clipText(e.LastAssistantMessage, InputLastMessageBytes); truncated {
			e.LastAssistantMessage, cut = clipped, true
		}
	}
	if e.Tool != nil && e.Tool.Result != "" {
		if clipped, truncated := clipText(e.Tool.Result, InputToolResultBytes); truncated {
			e.Tool = &ToolPayload{
				Name:       e.Tool.Name,
				Input:      e.Tool.Input,
				Risk:       e.Tool.Risk,
				CallID:     e.Tool.CallID,
				Status:     e.Tool.Status,
				Result:     clipped,
				DurationMs: e.Tool.DurationMs,
				Truncated:  true,
			}
			cut = true
		}
	}
	return e, cut
}

// MarshalJSON writes the flat object a hook reads on stdin.
//
// Flat rather than nested (`tool_name` beside `session_id`) because that is the
// shape every implementation in this space converged on, and a script that was
// written for one of them should not need a translation table to run here.
func (e Envelope) MarshalJSON() ([]byte, error) {
	object := map[string]any{
		"hook_event_name": string(e.Event),
		"session_id":      e.SessionID,
		"cwd":             e.Cwd,
		"workspace":       e.Workspace,
		"mode":            e.Mode,
		"autopilot":       e.Autopilot,
		"hook_name":       e.HookName,
	}
	if e.RunID != "" {
		object["run_id"] = e.RunID
	}
	if e.Step != 0 {
		object["step"] = e.Step
	}
	if e.Subagent != nil {
		object["subagent"] = e.Subagent
	}
	if tool := e.Tool; tool != nil {
		object["tool_name"] = tool.Name
		object["tool_input"] = tool.Input
		if tool.Risk != "" {
			object["tool_risk"] = tool.Risk
		}
		if tool.CallID != "" {
			object["tool_call_id"] = tool.CallID
		}
		if tool.Status != "" {
			object["tool_status"] = tool.Status
		}
		if tool.Result != "" || tool.Status != "" {
			object["tool_result"] = tool.Result
		}
		if tool.Status != "" {
			object["duration_ms"] = tool.DurationMs
			object["truncated"] = tool.Truncated
		}
	}
	for key, value := range map[string]string{
		"source":          e.Source,
		"model":           e.Model,
		"provider":        e.Provider,
		"prompt":          e.Prompt,
		"stop_reason":     e.StopReason,
		"reason":          e.Reason,
		"policy_decision": e.PolicyDecision,
	} {
		if value != "" {
			object[key] = value
		}
	}
	if e.LastAssistantMessage != "" {
		object["last_assistant_message"] = e.LastAssistantMessage
	}
	if e.Event == EventStop {
		// Present even when false: "this was not an automatic round" is a fact a
		// hook may branch on, and an absent field would read as "unknown".
		object["autonomous"] = e.Autonomous
	}
	if e.Event == EventPreCompact {
		object["fold_point"] = e.FoldPoint
		object["messages"] = e.Messages
		object["before"] = e.Before
	}
	if e.Event == EventSubagentStart {
		object["background"] = e.Background
		object["task_chars"] = e.TaskChars
	}
	if e.Event == EventSubagentStop {
		object["background"] = e.Background
		if e.Usage != nil {
			object["usage"] = e.Usage
		}
	}
	return json.Marshal(object)
}

// ContinueNoteKey marks, in a message this runtime appends, the note that a
// `stop` hook's `block` produced.
//
// It exists (in `internal/state`) so that such a note is not mistaken for a
// person's message when the history is scanned for who started the turn.
const ContinueNoteKey = "__hook_continue"

// clipText cuts text to at most `limit` bytes without splitting a rune, and says
// whether it did.
func clipText(text string, limit int) (string, bool) {
	if limit <= 0 || len(text) <= limit {
		return text, false
	}
	cut := limit
	for cut > 0 && !isRuneStart(text[cut]) {
		cut--
	}
	if cut <= 0 {
		return "", true
	}
	return text[:cut], true
}

// isRuneStart reports whether b begins a UTF-8 sequence.
func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }

// clipRunes is the interface-facing cut: runes, because the marker is appended to
// text a person reads.
func clipRunes(text string, limit int) (string, int, bool) {
	if limit <= 0 {
		return text, 0, false
	}
	count := 0
	for index := range text {
		if count == limit {
			return text[:index], count, true
		}
		count++
	}
	return text, count, false
}

// previewText flattens newlines and truncates, the same way the audit log's tool
// previews do: one line, and a marker that says how much was cut.
func previewText(text string, limit int) string {
	flat := strings.ReplaceAll(text, "\n", "\\n")
	prefix, _, truncated := clipRunes(flat, limit)
	if !truncated {
		return prefix
	}
	return prefix + "…"
}
