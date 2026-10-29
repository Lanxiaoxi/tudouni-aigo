package runtime

import (
	"net/http"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/agent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	ctxwin "github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/files"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/hooks"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/memory"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	sshlib "github.com/Lanxiaoxi/tudouni-aigo/internal/ssh"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/subagent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/terminal"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/usage"
)

// Options configures one runtime.
type Options struct {
	Booted    Booted
	Session   *state.Session
	Channels  protocol.Channels
	Autopilot bool
	Debug     bool
	Stream    bool
	MaxSteps  int
	Resumed   bool
	// FallbackModel and FallbackEffort are start-up arguments the parent gives a
	// fresh session: what a person last used in this workspace, remembered by the
	// front end and passed in because the runtime has no workspace-level memory of
	// its own (the TUI does not keep one either).
	//
	// **Fallback** is the whole word: the session's own stored selection always
	// wins — a resumed session opened on a remembered model would be a second
	// description of the same intent that drifts the day the two are edited
	// separately. And a name that is no longer in the catalogue is not an
	// error: the person edited the configuration out from under the memory,
	// which is exactly the situation a fallback exists for, so the catalogue's
	// own default is used instead.
	FallbackModel  string
	FallbackEffort string
	// EricAI is `--ericai`: manage this session's token. It is the switch for
	// everything in auth_session.go — without it nothing inspects a token, nothing
	// is refreshed, and an authentication refusal is reported like any other fatal
	// error.
	//
	// It is a start-up decision rather than a per-turn one because a session's
	// route is fixed when the client is built: "is this the route whose token I
	// manage" is answered once, at open, and the answer is the resolved provider.
	//
	// One consequence, stated because it is a real limit rather than a detail:
	// switching to another route mid-session (`/model`) does not put that route
	// under management. A session that starts on a plain key and is moved onto the
	// managed one keeps reporting its 401s, which is the conservative direction —
	// the alternative is guessing that a route named in a config is one whose token
	// this process is entitled to replace.
	EricAI bool

	// ShouldStop is the per-turn cancellation flag.
	ShouldStop func() bool
	// NoHooks is `--no-hooks`: do not read the hooks file at all.
	//
	// It exists because a broken hook is the one failure a person cannot work around
	// from inside a session — the guardrail refuses the very tool calls they would
	// use to fix it. Switched off, the session starts and the notice says so.
	NoHooks bool
	// Report is where an instruction a person has to **act on** goes once the
	// session is running: today, the device code and verification URI of the
	// managed-token login (`--ericai`).
	//
	// Nil means "this process's own stderr", which is the right answer for an
	// in-process front end that owns a terminal, and useless under
	// `--runtime-stdio` — there the child's stderr is drained and dropped by the
	// front end that started it (see protocol.Client.Start), so a login waiting on
	// a code nobody was shown looks exactly like a session that has hung. See
	// protocol.RuntimeHooks.Report.
	Report func(level, text string)
	// OnDelta reports stream increments. The step is the runtime's own, because a
	// front end cannot derive which step is streaming from the audit stream: a
	// step's `model_call` record is written after that step's chunks.
	OnDelta func(step int, text, reasoning string, reset bool)
	// OnEventHook receives every audit record after it has been written down. The
	// protocol server subscribes here; without it the audit log would be the only
	// way to see what happened, and a front end would have nothing to draw.
	OnEventHook func(record map[string]any)
	// OnTerminalEvent carries one terminal event to the front end. See
	// protocol.RuntimeHooks.OnTerminalEvent for why the destination is passed in
	// rather than reached for: the shells are process-scoped and the connection is
	// not.
	//
	// Nil is the ordinary case for an in-process front end with nowhere to draw a
	// byte stream. The terminals still run and are still listed; only the stream
	// has no reader.
	OnTerminalEvent func(payload map[string]any)
	// OnCodeIntelEvent carries one code-index event to the front end — a build's
	// progress and its outcome. See protocol.RuntimeHooks.OnCodeIntelEvent.
	//
	// Nil is the ordinary case for an in-process front end: the build still runs and
	// the index is still written; only the progress has no reader.
	OnCodeIntelEvent func(payload map[string]any)
}

// Runtime is one assembled session.
type Runtime struct {
	SessionIDValue string
	SessionValue   *state.Session
	Store          *state.SessionStore
	Logs           *audit.JsonlSink
	// Usage is the cross-workspace usage ledger (`internal/usage`). It is on
	// `Booted` for the same reason `Logs` is — the file follows the user, not
	// the session — and nil means it could not be opened, which the usage panel
	// reports rather than papering over with an empty answer.
	Usage *usage.Ledger
	Tools *tools.Registry
	Policy         security.Policy
	Memory         *security.Memory
	Agent          *agent.Agent
	Jobs           *builtin.JobBoard
	// Subagents is the tally of delegations in flight. Nil when delegation is
	// unavailable, which is also the panel's "there are none".
	Subagents *subagent.Board
	// subagentStopper is the delegating tool, kept for the one operation that
	// belongs to the runtime rather than to a turn: stopping one background
	// delegation on the user's behalf. Nil when delegation is unavailable.
	subagentStopper interface {
		Stop(id string) bool
	}
	Chat        model.ChatModel
	WebCfg      WebConfig
	// McpCfg is the server list last read from disk. It is guarded by cfgMu
	// because `/mcp load` writes it from the protocol's read loop while the
	// `ui(state)` snapshot reads it on the turn's goroutine.
	McpCfg      []McpServerSpec
	cfgMu       sync.RWMutex
	Permissions PermissionConfig
	Autopilot   bool
	Debug       bool
	Stream      bool
	MaxSteps    int
	Resumed     bool
	ModelState  *state.SessionModel
	Catalog     state.Registry
	// auth is the session's token state: which route to keep fresh, and how to
	// install a new key on the live client. Nil unless `--ericai` asked for it, and
	// every method that reads it treats nil as "not mine to manage". See
	// auth_session.go.
	auth *ericAuth
	// report is where an instruction a person has to act on goes once the session
	// is running: today, the device code and URI of the managed-token login. Nil
	// means "this process's own stderr", which is right for an in-process front end
	// and useless under `--runtime-stdio`, where stderr is drained by the parent.
	// See Options.Report.
	report func(level, text string)

	// ContextValue is the session's context ledger: which artifacts are in play,
	// at what level, and what has been folded away.
	ContextValue *ctxwin.Manager
	// Workspace is the boundary around the directory the agent works in. It is
	// kept on the runtime rather than passed to each caller because attach-time
	// work (resolving a picture the user named) has to go through the **same**
	// boundary as the file tools: a second path check is how one door ends up
	// guarded and another does not.
	Workspace *tools.Workspace
	// Files answers `file_list` / `file_read`. It shares the boundary above rather
	// than resolving the root again — see files.NewServiceFromWorkspace — so a
	// front end browsing the workspace and the agent reading a file cannot end up
	// with two different ideas of where the workspace is.
	Files *files.Service
	// Terminals owns this workspace's shells. It is **not** built here: it comes
	// from `Booted`, which is created once per process, because a terminal has to
	// outlive the session that happened to be mounted when it was created.
	Terminals *terminal.Manager
	// SSH owns this workspace's remote sessions, and it comes from `Booted` for the
	// same reason the terminals do. See `Booted.SSH`.
	SSH *sshlib.Manager
	// Skills is the loaded-skill board, which the payload tail renders from.
	Skills *builtin.SkillBoard
	// WorkspaceMemory is this workspace's long-lived memory: past solutions, project
	// experience, and confirmed collaboration preferences. Nil means the directories
	// could not be created, which every caller treats as "no memory" rather than as an
	// error — see internal/runtime/memory.go.
	//
	// It is deliberately **not** called `Memory`: that name is already the approval
	// memory above, and two fields with one name is how "which memory did you mean"
	// becomes a bug nobody can see.
	WorkspaceMemory *memory.Workspace
	// memory is what one turn has recalled so far. Guarded by its own mutex because
	// the tool-failure trigger runs on parallel tool goroutines.
	memory memoryRecall
	// Goal is the session's long-running objective: the board the goal tools write
	// through and the payload tail reads. It is always present — a session with no
	// goal is the normal state, not a missing feature, and the tools have to exist
	// for one ever to be created.
	Goal *builtin.GoalBoard
	// goalActivated is whether this process may start autonomous rounds for the
	// goal. It is **not** restored from the session file, and there is no field for
	// it in the goal block: an authorization read back from disk is an
	// authorization nobody granted in this process.
	//
	// It is guarded by goalMu, and it has two writers: the driver disarms it
	// whenever a turn does not finish normally, and the command surface arms it
	// when a person asks for continuation. Both run on the session's own goroutine
	// — turns never overlap — but the lock is what makes "read it and act on it"
	// safe to reason about without depending on that.
	goalMu        sync.Mutex
	goalActivated bool
	// Driver decides whether the goal gets another round after a turn ends. It is
	// built with the runtime so that a session switch builds a new one; a driver
	// carried across sessions would hold a reservation for a goal that is no longer
	// loaded.
	Driver *Driver
	// mcpMounts is the servers currently up. Empty at start-up: mounting is a
	// decision a person makes, not a consequence of a config file existing.
	//
	// Guarded by mcpMu. `/mcp load` / `unload` wait for the running turn and then
	// write, but the reads are not all on that goroutine: `ui(mcp)` and the
	// `ui(state)` snapshot that follows it can both be drawn while a mount is in
	// flight, and a Go map read that overlaps a write is a hard crash rather than
	// a stale panel. Every reader goes through mcpMountsSnapshot.
	mcpMu     sync.Mutex
	mcpMounts map[string]*mcpMount

	notices    []map[string]any
	mcpNames   []string
	httpClient *http.Client
	startedAt  time.Time

	// OnEventHook is where the protocol server subscribes. It is a field rather
	// than an interface so the runtime does not have to know that a protocol
	// server exists — it only knows somebody wants the records.
	OnEventHook func(record map[string]any)
	// onTerminalEvent is where a terminal's events go. It is kept as a field so
	// that `Close` can unhook it — see the sink it installs in OpenRuntime.
	onTerminalEvent func(payload map[string]any)
	// onCodeIntelEvent is where an index build's progress and completion go, on the
	// same terms: nil means nobody is listening, which is true of the REPL and means
	// the build still runs but reports nowhere.
	//
	// It is a **separate field from onTerminalEvent** even though both end up as a
	// `ui` body: the two are written by different goroutines and un-hooked at
	// different moments, and one field serving two producers is how a session switch
	// ends up sending one of them to the previous connection.
	onCodeIntelEvent func(payload map[string]any)
	// CodeIntel is this workspace's index handle and its panel state. Nil only in
	// tests that build a Runtime by hand.
	CodeIntel *codeIntelState
	// Hooks is the user's configured scripts (see internal/hooks). Nil is the
	// ordinary state of a machine with no `hooks.json`, and every use is nil-safe.
	Hooks hooks.Configurable
	// HookContext is where a hook's `additional_context` collects for the payload
	// tail, with its two lifetimes (turn and batch). It is created with the runtime
	// whether or not any hook exists: the agent reads it on every request, and a nil
	// check there would be a second place to forget.
	HookContext *hooks.Context
	// hooksDisabled is `--no-hooks`, kept so `Close` and the notices can say which
	// state this session is in.
	hooksDisabled bool
	// hookNotices are lines the hook layer produced **while a turn was running**,
	// which cannot go into `notices` (that slice is read once, to build `init`).
	// They are queued and drained by the front end when the turn ends, the same way
	// a credential notice is — see DrainHookNotices.
	hookNoticesMu sync.Mutex
	hookNotices   []map[string]any
	// sessionEndOnce makes `session_end` fire exactly once per runtime. A session
	// switch and a shutdown close the same runtime through two different methods,
	// and a hook that writes a report must not write it twice.
	sessionEndOnce sync.Once
}

// meta is the guarded handle on this session's metadata.
//
// Every read or write that can overlap the turn's own goes through it. The
// boards hold this handle rather than the raw map for the same reason: the
// protocol's read loop (`/goal`, `/model`) and the turn's tool handlers both
// write the map, and a Go map that is written from two goroutines is a fatal
// error rather than a stale read.
func (r *Runtime) meta() *state.Meta {
	return r.SessionValue.Meta()
}

// metaSnapshot is the metadata as one consistent value, for readers that only
// want to look at it.
func (r *Runtime) metaSnapshot() map[string]any {
	return r.meta().Snapshot()
}

// goal is the session's goal, read under the metadata lock.
func (r *Runtime) goal() (state.Goal, bool) {
	var goal state.Goal
	var ok bool
	r.meta().Read(func(metadata map[string]any) { goal, ok = state.LoadGoal(metadata) })
	return goal, ok
}
