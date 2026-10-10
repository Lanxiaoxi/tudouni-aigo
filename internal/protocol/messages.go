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
//
// 3 corrects the `step` a `delta` carries. It used to be inferred here as "the
// last record's step plus one", which gave a turn's **first two** steps the same
// number — so a front end that groups a streaming block by that number never
// learned that the second step had begun. The field keeps its name, type and
// meaning; only its value is now right, which is why a front end written against
// 2 still parses every message it receives.
//
// 4 adds the workspace's two non-session capabilities: Files (`file_list`,
// `file_read`) and Terminal (`terminal_list`, `terminal_create`, `terminal_input`,
// `terminal_resize`, `terminal_kill`, plus the `terminal_*` kinds on the `ui`
// channel). Additive in the same way 2 was: a front end that knows neither simply
// never asks, and one that does not know `terminal_output` ignores a kind it cannot
// draw — which is why the state snapshot also carries the terminal list, and why a
// terminal's whole life is still observable from `ui(state)` alone.
const PROTOCOL = 4

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
	InSessionDelete      = "session_delete"
	InSessionArchive     = "session_archive"
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

	// Files. Workspace-scoped and read-only in this phase; `file_write` and the
	// rest are deliberately absent rather than declared and unimplemented.
	InFileList = "file_list"
	InFileRead = "file_read"

	// Terminal. Six verbs, and the split is the runtime's own model of a shell
	// rather than a convenience: a terminal is created once, written to many times,
	// resized when somebody's window changes, killed once, and — separately —
	// forgotten once it has ended. `terminal_close` is not a synonym for
	// `terminal_kill`: one ends a process, the other deletes a record, and the
	// runtime refuses to do the second to a terminal that still needs the first.
	InTerminalList   = "terminal_list"
	InTerminalCreate = "terminal_create"
	InTerminalInput  = "terminal_input"
	InTerminalResize = "terminal_resize"
	InTerminalKill   = "terminal_kill"
	InTerminalClose  = "terminal_close"
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
	// OutRuntimeExited is the client's own message, not the runtime's: it is what a
	// front end is told when the process behind the protocol has ended without being
	// asked to. It carries the exit code, and it exists because the runtime's stderr
	// no longer reaches the terminal (see Client.Start) — so the one failure that
	// used to be visible as a stray line has to be said out loud instead.
	OutRuntimeExited = "runtime_exited"
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

	// Files. The answer to `file_list`; `file_read` reuses the artifact
	// machinery and answers with its own kind.
	UIFiles     = "files"
	UIFileRead  = "file_read"
	UITerminals = "terminals"

	// Terminal. `terminal_created` is the answer to `terminal_create` (the new
	// terminal's own row); `terminal_output` is the asynchronous stream and is the
	// **only** kind that is high-frequency; `terminal_exit` carries the one status
	// transition a terminal actually has.
	//
	// **There is deliberately no `terminal_state`.** The design listed one, and it
	// was cut for the reason `mcp_servers`' `failed` state was cut before it: a
	// kind nothing can ever emit is a promise to every front end writing an
	// adapter, and it is one nobody has tested. The two transitions such a message
	// would carry are both already covered — creation answers with
	// `terminal_created`, and the only later transition is the exit, which has its
	// own kind because it carries the exit code and the reason.
	UITerminalCreated = "terminal_created"
	UITerminalOutput  = "terminal_output"
	UITerminalExit    = "terminal_exit"
)

// Terminal statuses. The runtime is the only source of truth for these; a front
// end displays what it is told and never derives a status of its own.
//
// **`starting` and `failed` are deliberately absent**, although the design lists
// both. Neither can appear on the wire: `Create` is synchronous, so by the time any
// answer travels the shell is either running or the attempt failed — and a failure
// produces no terminal at all, which means an error rather than a row to mark.
// Declaring them would put two values in every front end's switch that no message
// can ever carry.
const (
	TerminalRunning = "running"
	TerminalExited  = "exited"
	TerminalKilled  = "killed"
)

// Reasons a terminal can end, as `ui(terminal_exit).reason` carries them.
//
// They are spelled separately from the statuses above even though the two strings
// coincide today, because they answer different questions and a front end reads
// them from different fields: `status` is "what is this terminal now" and `reason`
// is "why did it end". Folding them into one constant would make a change to
// either vocabulary silently change both.
//
// **The distinction is not cosmetic.** A shell where somebody typed `exit` and one
// that this program killed want different things on screen, and both can report
// exit code 0 — so the reason is the only thing that tells them apart.
const (
	TerminalExitReasonExited = "exited"
	TerminalExitReasonKilled = "killed"
)

// Types a `file_list` row can carry.
const (
	FileTypeFile      = "file"
	FileTypeDirectory = "directory"
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

	// `path` is deliberately absent from both Files entries: an empty or missing
	// path means the workspace root, and a schema that listed it as required would
	// make "list the root" a message no front end could legally send.
	InFileList: {"v", "t"},
	InFileRead: {"v", "t", "path"},

	InTerminalList: {"v", "t"},
	// Nothing is required beyond the envelope: the cwd is optional (the workspace
	// root is the default) and the shell is the runtime's choice, not the client's.
	InTerminalCreate: {"v", "t"},
	// `data` may legitimately be the empty string, so the key has to be present
	// rather than non-empty — the same rule `text` follows on `user_message`.
	InTerminalInput:  {"v", "t", "terminal_id", "data"},
	InTerminalResize: {"v", "t", "terminal_id", "cols", "rows"},
	InTerminalKill:   {"v", "t", "terminal_id"},
	InTerminalClose:  {"v", "t", "terminal_id"},
}

// TerminalDefaults are the size a terminal is created with when the client does
// not say. 80x24 is the conventional terminal, and it is what a program reading
// the size before the first `terminal_resize` will believe — so it should be the
// least surprising number rather than an arbitrary one.
const (
	TerminalDefaultCols = 80
	TerminalDefaultRows = 24
)
