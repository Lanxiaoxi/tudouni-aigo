// Package protocol is the contract between a front end and the runtime.
//
// The runtime is a child process whose stdin/stdout carry JSONL: one JSON
// object per line, UTF-8, newline terminated, flushed every line. The front end
// draws the interface and answers the two questions the runtime cannot answer
// on its own (approval, and asking the user something). Everything else is the
// runtime's job.
//
// Two numbers travel in an envelope, and they are not the same thing:
//
//   - VERSION (`v`) is the shape of the envelope. Not agreeing on it is a hard
//     failure — a line we cannot parse is worse than no line.
//   - PROTOCOL (`init.protocol`) is the semantic version of the conversation.
//     Not agreeing on it is survivable: a front end that does not know `delta`
//     simply ignores it, which is why the full answer still arrives in
//     `ui(run_finished).answer`.
//
// Messages are maps rather than structs on purpose. Both sides upgrade
// independently, and the rule that makes that safe is "ignore what you do not
// recognise, keep going". A struct with strict unmarshalling breaks that rule by
// design.
package protocol

// VERSION is the envelope version. This is the one hard failure point.
const VERSION = 1

// PROTOCOL is the semantic version of the conversation.
//
// 2 added `delta` and `delta_reset`. An older front end needs no change: it
// ignores the two unknown message kinds, and the complete answer still arrives
// in `ui(run_finished).answer`.
const PROTOCOL = 2

// Message keys used by every envelope.
const (
	KeyVersion = "v"
	KeyType    = "t"
	KeyKind    = "kind"
)

// Message kinds travelling front end -> runtime.
const (
	InUserMessage        = "user_message"
	InPermissionResponse = "permission_response"
	InQuestionResponse   = "question_response"
	InSessionSwitch      = "session_switch"
	InSessionList        = "session_list"
	InInterrupt          = "interrupt"
	InSetAutopilot       = "set_autopilot"
	InSetModel           = "set_model"
	InSetThinking        = "set_thinking"
	InSetEffort          = "set_effort"
	InStatus             = "status"
	InTools              = "tools"
	InMCP                = "mcp"
	InCompact            = "compact"
	InContext            = "context"
	InSkills             = "skills"
	InGoal               = "goal"
	InRefreshState       = "refresh_state"
	InShutdown           = "shutdown"
)

// Message kinds travelling runtime -> front end.
const (
	OutInit              = "init"
	OutSessionLoad       = "session_load"
	OutEvent             = "event"
	OutUI                = "ui"
	OutNotice            = "notice"
	OutSessions          = "sessions"
	OutPermissionRequest = "permission_request"
	OutQuestionRequest   = "question_request"
	OutDelta             = "delta"
	OutDeltaReset        = "delta_reset"
)

// Channels a delta can arrive on. They must be routed by this field: both
// channels carry strings, and guessing wrong puts a stretch of the model
// thinking out loud into the answer.
const (
	DeltaText      = "text"
	DeltaReasoning = "reasoning"
)

// Kinds of the `ui` message. None of them enter the audit log.
const (
	UIState       = "state"
	UIStatus      = "status"
	UITools       = "tools"
	UIMCP         = "mcp"
	UIContext     = "context"
	UISkills      = "skills"
	UICompacted   = "compacted"
	UIRunFinished = "run_finished"
)

// Decisions a front end may return for a permission request.
//
// `always_group` means "I agree to release this group"; which tools that covers
// is looked up by the runtime from the snapshot it holds under the request id.
// Letting the client name the tools would let the client rewrite the policy.
var Decisions = []string{"allow", "deny", "always", "always_group"}

// Actions the `mcp` message accepts.
var MCPActions = []string{"list", "load", "unload"}

// GoalActions are the commands a person may give about the session's goal.
//
// They are the human half of the goal tools, and the reason they exist as commands
// at all: a goal the model created for itself has to be visible and stoppable
// without the person having to ask a model to stop it. `clear` in particular is
// only ever a command — the tools cannot delete another person's goal.
//
// The spellings live here rather than being re-exported from the state package: the
// wire vocabulary is this package's business, and a protocol constant that aliased
// a storage one would move the day somebody renamed a field.
const (
	GoalPause  = "pause"
	GoalResume = "resume"
	GoalClear  = "clear"
)

// GoalActions is the wire's own list, for the error message that names them.
var GoalActions = []string{GoalPause, GoalResume, GoalClear}

// Answers a front end may return for a question. The third value the runtime
// can produce — `unavailable`, nobody to ask — is never sent by a front end.
const (
	QuestionAnswered    = "answered"
	QuestionSkipped     = "skipped"
	QuestionUnavailable = "unavailable"
)

// TrustLevels are the levels that may be auto-approved from a config file.
// `high` is deliberately absent: risk levels are declared per tool, so
// "auto-approve everything high" would silently widen as tools are added.
var TrustLevels = []string{"low", "medium"}

// RequiredKeys lists the keys a message of the given kind must carry. It is
// used by tests and by the debug dump; the runtime itself tolerates missing
// optional keys rather than crashing on them.
var RequiredKeys = map[string][]string{
	InUserMessage:        {"v", "t", "text"},
	InPermissionResponse: {"v", "t", "id", "decision"},
	InQuestionResponse:   {"v", "t", "id", "status"},
	InSessionSwitch:      {"v", "t"},
	InSessionList:        {"v", "t"},
	InInterrupt:          {"v", "t"},
	InSetAutopilot:       {"v", "t", "on"},
	InSetModel:           {"v", "t", "model"},
	InSetThinking:        {"v", "t", "on"},
	InSetEffort:          {"v", "t", "effort"},
	InStatus:             {"v", "t"},
	InTools:              {"v", "t"},
	InMCP:                {"v", "t", "action"},
	InCompact:            {"v", "t"},
	InContext:            {"v", "t"},
	InGoal:               {"v", "t", "action"},
	InRefreshState:       {"v", "t"},
	InShutdown:           {"v", "t"},
}
