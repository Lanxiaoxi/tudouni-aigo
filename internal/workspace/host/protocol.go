package host

import "fmt"

// HostProtocol is the version of the workspace-host wire protocol.
//
// It is **not** the envelope version (`"v":1`, shared with the session protocol)
// and it is not the program version. The envelope says how a line is framed;
// this says which messages a host understands. Both ends upgrade on their own
// schedule, so the number is announced in `host_init` and a front end that sees
// one it does not know can say so instead of guessing.
//
// The authoritative description is docs/spec/workspace-host-protocol.md.
const HostProtocol = 1

// envelopeVersion is the `"v"` every line carries.
const envelopeVersion = 1

// Messages a front end sends. Every one of them may carry a `req`; a request that
// does carry one gets exactly one `result` back.
const (
	MsgFsList      = "fs_list"
	MsgFsStat      = "fs_stat"
	MsgFsRead      = "fs_read"
	MsgFsReadBytes = "fs_read_bytes"
	MsgFsSearch    = "fs_search"

	MsgGitStatus = "git_status"
	MsgGitDiff   = "git_diff"

	MsgTermList   = "term_list"
	MsgTermCreate = "term_create"
	MsgTermAttach = "term_attach"
	MsgTermDetach = "term_detach"
	MsgTermInput  = "term_input"
	MsgTermResize = "term_resize"
	MsgTermKill   = "term_kill"
	MsgTermClose  = "term_close"

	MsgShutdown = "shutdown"
)

// Messages the host sends on its own initiative (or, for `result` and `error`,
// in answer to something).
const (
	MsgHostInit       = "host_init"
	MsgResult         = "result"
	MsgError          = "error"
	MsgWorkspaceEvent = "workspace_event"
	MsgTermOutput     = "term_output"
	MsgTermExit       = "term_exit"
	MsgTermGap        = "term_gap"
)

// RequestNames lists what a front end may send, in spec order.
var RequestNames = []string{
	MsgFsList, MsgFsStat, MsgFsRead, MsgFsReadBytes, MsgFsSearch,
	MsgGitStatus, MsgGitDiff,
	MsgTermList, MsgTermCreate, MsgTermAttach, MsgTermDetach,
	MsgTermInput, MsgTermResize, MsgTermKill, MsgTermClose,
	MsgShutdown,
}

// PushNames lists what the host sends.
var PushNames = []string{
	MsgHostInit, MsgResult, MsgError, MsgWorkspaceEvent,
	MsgTermOutput, MsgTermExit, MsgTermGap,
}

// MessageNames is every `t` this protocol defines, requests first. It exists so a
// test on the desktop side can compare its own list against this one: the two
// ends are written in different languages, and a name that drifts on one side is
// otherwise only found when a panel silently stops updating.
var MessageNames = append(append([]string{}, RequestNames...), PushNames...)

// Error codes carried by a failed `result` (and by a bare `error` push).
const (
	CodeBadRequest  = "bad_request"
	CodeNotFound    = "not_found"
	CodePathEscape  = "path_escape"
	CodeTooLarge    = "too_large"
	CodeNotGit      = "not_git"
	CodeUnsupported = "unsupported"
	CodeInternal    = "internal"
	CodeBadVersion  = "bad_version"
)

// wireError is a failure that will be reported to the front end as-is.
type wireError struct {
	Code    string
	Message string
}

func (e *wireError) Error() string { return e.Code + ": " + e.Message }

func errf(code, format string, args ...any) *wireError {
	return &wireError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Capabilities is what this host can do, announced in `host_init`.
//
// `SystemOpen` is always false here and is not a mistake: "open with the default
// program" is a statement about the machine the person is sitting at, and a host
// may be running on the far end of an SSH channel. The desktop decides that for
// itself, and a remote workspace must never call it.
type Capabilities struct {
	Files                bool `json:"files"`
	FileWatch            bool `json:"file_watch"`
	FileRangeRead        bool `json:"file_range_read"`
	Git                  bool `json:"git"`
	Terminal             bool `json:"terminal"`
	TerminalOutputReplay bool `json:"terminal_output_replay"`
	SystemOpen           bool `json:"system_open"`
}
