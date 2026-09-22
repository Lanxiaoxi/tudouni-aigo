package runtime

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/agent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/process"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/proxy"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/skills"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/subagent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/version"
)

// hostTriple maps this machine onto the ripgrep release triple whose build is
// vendored under `tools/vendor/rg/`.
//
// It is a deliberate second table rather than a use of `internal/release`'s
// `Targets`: that package builds archives and must not be imported by the runtime
// (and the runtime must not depend on a build-time concern). The two agree on the
// strings, and `paths` looks the binary up by exactly this name.
func hostTriple() (string, bool) {
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "windows/amd64":
		return "x86_64-pc-windows-msvc", true
	case "linux/amd64":
		return "x86_64-unknown-linux-musl", true
	default:
		return "", false
	}
}

// Booted is what stage one produced: everything that needs the disk and nothing
// that needs a model.
type Booted struct {
	Store *state.SessionStore
	Logs  *audit.JsonlSink
}

// Boot makes the directories and opens the two append-only stores.
func Boot() (Booted, error) {
	runtimeDir := paths.WorkspaceRuntimeDir()
	store, err := state.NewSessionStore(runtimeDir + "/sessions")
	if err != nil {
		return Booted{}, err
	}
	logs, err := audit.NewJsonlSink(runtimeDir + "/logs")
	if err != nil {
		return Booted{}, err
	}
	return Booted{Store: store, Logs: logs}, nil
}

// ResolveSession picks the session a run should start on.
//
// A missing id means "new", and so does an id whose file is not there — the same
// rule as `--session`: a name that does not exist yet is a new session with that
// name, which is how a person gives a session a memorable id.
func ResolveSession(store *state.SessionStore, sessionID string) (*state.Session, bool, error) {
	if sessionID == "" {
		id := store.NewSessionID()
		return state.NewSession(id, paths.WorkspaceDir()), false, nil
	}
	if !state.IsValidSessionID(sessionID) {
		return nil, false, errorf("%s", i18n.T("check.session_id.invalid",
			"name", sessionID, "dir", paths.RuntimeDirName))
	}
	if !store.Exists(sessionID) {
		return state.NewSession(sessionID, paths.WorkspaceDir()), false, nil
	}
	session, err := store.Load(sessionID)
	if err != nil {
		return nil, false, err
	}
	session.Resumed = true
	return session, true, nil
}

// PreviewChars bounds the one-line preview in the session list.
const PreviewChars = 40

// SessionListLimit bounds how many sessions the picker shows.
const SessionListLimit = 50

// subagentMaxDepth is how deep delegation may go: the top-level agent is depth 0,
// so a value of 3 permits three nested levels. It is a constant rather than a
// config field because the number is a budget on the session's own account, and a
// setting nobody asked for is a setting nobody will find.
const subagentMaxDepth = subagent.DefaultMaxDepth

// SessionSummaries lists saved sessions, newest first.
//
// The order is by **creation time**, not by id. `--session demo` is not a
// timestamp, and sorting by id would put it in the wrong place — while the
// question the list answers is "which one was I working on", and that is almost
// always the most recent.
func SessionSummaries(store *state.SessionStore, limit int) []map[string]any {
	// Delegated agents share this store, and their sessions are not sessions
	// anybody resumes: one belongs to a task that is already over, and picking it
	// opens a transcript whose other half is the parent. They are told apart by
	// name, so drawing the picker never has to open one.
	ids := store.ListParentIDs()
	type entry struct {
		created  float64
		modified *float64
		id       string
	}
	entries := make([]entry, 0, len(ids))
	for _, id := range ids {
		session, err := store.Load(id)
		created := 0.0
		if err == nil {
			created = session.CreatedAt
		}
		_, modified := store.FileTimes(id)
		entries = append(entries, entry{created: created, modified: modified, id: id})
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].created > entries[j].created })

	if limit > 0 && len(entries) > limit {
		entries = entries[:limit]
	}

	out := make([]map[string]any, 0, len(entries))
	for _, item := range entries {
		row := map[string]any{
			"session_id": item.id,
			"messages":   0,
			"steps":      0,
			"todos":      "",
			"preview":    "",
		}
		if item.modified != nil {
			row["modified_at"] = *item.modified
		} else {
			row["modified_at"] = nil
		}

		session, err := store.Load(item.id)
		if err != nil {
			// A file that cannot be read stays in the list with the reason in place
			// of the preview. Dropping it would hide a real problem, and the user
			// asking "why is one session gone" has no way to find out.
			row["preview"] = i18n.T("session.preview.unreadable", "kind", err.Error())
			out = append(out, row)
			continue
		}
		row["messages"] = len(session.Messages)
		row["steps"] = session.StepCount()
		if line := todoProgressLine(session.Metadata); line != "" {
			row["todos"] = line
		}
		row["preview"] = firstUserPreview(session)
		out = append(out, row)
	}
	return out
}

func firstUserPreview(session *state.Session) string {
	for _, message := range session.Messages {
		role, _ := message["role"].(string)
		if role != "user" {
			continue
		}
		text, ok := state.MessageText(message)
		if !ok {
			continue
		}
		text = strings.Join(strings.Fields(text), " ")
		runes := []rune(text)
		if len(runes) > PreviewChars {
			return string(runes[:PreviewChars]) + "…"
		}
		return text
	}
	return ""
}

func todoProgressLine(metadata map[string]any) string {
	board := builtin.NewTodoBoard(metadata)
	return board.ProgressLine()
}

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
	// OnDelta reports stream increments. The step is the runtime's own, because a
	// front end cannot derive which step is streaming from the audit stream: a
	// step's `model_call` record is written after that step's chunks.
	OnDelta func(step int, text, reasoning string, reset bool)
	// OnEventHook receives every audit record after it has been written down. The
	// protocol server subscribes here; without it the audit log would be the only
	// way to see what happened, and a front end would have nothing to draw.
	OnEventHook func(record map[string]any)
}

// Runtime is one assembled session.
type Runtime struct {
	SessionIDValue string
	SessionValue   *state.Session
	Store          *state.SessionStore
	Logs           *audit.JsonlSink
	Tools          *tools.Registry
	Policy         security.Policy
	Memory         *security.Memory
	Agent          *agent.Agent
	Jobs           *builtin.JobBoard
	// Subagents is the tally of delegations in flight. Nil when delegation is
	// unavailable, which is also the panel's "there are none".
	Subagents   *subagent.Board
	Chat        model.ChatModel
	WebCfg      WebConfig
	McpCfg      []McpServerSpec
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

	// ContextValue is the session's context ledger: which artifacts are in play,
	// at what level, and what has been folded away.
	ContextValue *context.Manager
	// Skills is the loaded-skill board, which the payload tail renders from.
	Skills *builtin.SkillBoard
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
	mcpMounts map[string]*mcpMount

	notices    []map[string]any
	mcpNames   []string
	httpClient *http.Client
	startedAt  time.Time

	// OnEventHook is where the protocol server subscribes. It is a field rather
	// than an interface so the runtime does not have to know that a protocol
	// server exists — it only knows somebody wants the records.
	OnEventHook func(record map[string]any)
}

// PreflightCheck reports what the user has to fix before anything can run.
//
// It exists for one caller and one reason: the TUI. Its parent process does not
// assemble a runtime (the real one lives in the `--runtime-stdio` child), but it
// **has to ask this question before entering the alternate screen**. The alternate
// screen has no scrollback, so a child process's configuration error printed after
// `tea.WithAltScreen()` is a truncated, unscrollable mess — the user is left inside a
// full-screen interface looking at a dead runtime with no readable reason. Asking
// first means the sentence lands on an ordinary terminal, where it can be read and
// scrolled.
//
// A nil return means "nothing to report"; it is not a promise that a turn will
// succeed.
func PreflightCheck() error {
	catalog, err := state.Load(catalogPath())
	if err != nil {
		return err
	}
	if !catalog.Usable() {
		return &NoModelError{Catalog: catalog}
	}
	if _, err := LoadPermissions(); err != nil {
		return err
	}
	if _, err := LoadWebConfig(); err != nil {
		return err
	}
	if _, _, err := LoadMcpServers(); err != nil {
		return err
	}
	return nil
}

// OpenRuntime assembles a runtime.
//
// The order matters and is not arbitrary: the catalogue has to be read before a
// model can be chosen, the model before the agent, and the tool registry before the
// agent too — because the task list and the skill board are members of that
// registry and are bound to this session's metadata.
func OpenRuntime(options Options) (*Runtime, error) {
	catalog, err := state.Load(catalogPath())
	if err != nil {
		return nil, err
	}
	if !catalog.Usable() {
		return nil, &NoModelError{Catalog: catalog}
	}

	permissions, err := LoadPermissions()
	if err != nil {
		return nil, err
	}
	webCfg, err := LoadWebConfig()
	if err != nil {
		return nil, err
	}
	mcpSpecs, mcpNames, err := LoadMcpServers()
	if err != nil {
		return nil, err
	}

	session := options.Session
	defaultProvider, _ := catalog.DefaultProvider()
	defaultModel, _ := catalog.DefaultModel()

	modelState := state.NewSessionModel(session.Metadata, defaultModel.ID, defaultProvider.Name)
	chosen, chosenProvider, err := resolveModel(modelState, catalog)
	if err != nil {
		return nil, err
	}
	// A model may name its own default level; until now that field was read and
	// validated and then dropped, so a route declaring `reasoning_effort: low`
	// still came up at the global default. It applies only when nobody has
	// chosen: a level someone picked is not something this may overwrite.
	if !modelState.EffortChosen() {
		if ref, ok := catalog.Find(chosen, chosenProvider.Name); ok && ref.DefaultEffort != "" {
			modelState.SelectEffort(ref.DefaultEffort, 0)
		}
	}

	chat, err := model.New(model.Options{
		Route:    routeOf(chosenProvider, chosen, session.SessionID),
		Thinking: modelState.Thinking(),
		Effort:   modelState.Effort(),
	})
	if err != nil {
		return nil, err
	}

	workspace, err := tools.NewWorkspace(paths.WorkspaceDir())
	if err != nil {
		return nil, err
	}

	runtimeValue := &Runtime{
		SessionIDValue: session.SessionID,
		SessionValue:   session,
		Store:          options.Booted.Store,
		Logs:           options.Booted.Logs,
		Policy:         security.Policy{AutoApprove: permissions.AutoApprove, DenyTools: permissions.DenyTools},
		Chat:           chat,
		WebCfg:         webCfg,
		McpCfg:         mcpSpecs,
		Permissions:    permissions,
		Autopilot:      options.Autopilot,
		Debug:          options.Debug,
		Stream:         options.Stream,
		MaxSteps:       options.MaxSteps,
		Resumed:        options.Resumed,
		ModelState:     modelState,
		Catalog:        catalog,
		mcpNames:       mcpNames,
		httpClient:     &http.Client{Timeout: 120 * time.Second},
		startedAt:      time.Now(),
	}
	if runtimeValue.MaxSteps == 0 {
		runtimeValue.MaxSteps = agent.DefaultMaxSteps
	}

	// [context] The "xx / yy" in the usage line needs a yy, and the endpoint does not
	// report a window — it comes from the catalogue. With no entry there is no
	// denominator, so the interface reports usage without a percentage; a wrong
	// percentage is worse than none, because it gets believed. Saying so beats
	// leaving somebody to wonder why the ratio vanished.
	if _, ok := catalog.Find(chat.ModelName(), chat.ProviderName()); !ok {
		runtimeValue.notices = append(runtimeValue.notices, notice("warn", "context",
			i18n.T("notice.context.missing_window", "model", chat.ModelName())))
	} else if window := runtimeValue.modelWindow(); window == nil {
		runtimeValue.notices = append(runtimeValue.notices, notice("warn", "context",
			i18n.T("notice.context.missing_window", "model", chat.ModelName())))
	}

	// Which AGENT.md files this session's prompt actually carries, and which were
	// refused or cut short.
	//
	// `NewSession` read the file and stored the report in the session metadata;
	// these are the reporter's own sentences. They were written and then never
	// called, so a workspace with an oversized or unreadable AGENT.md started a
	// session where the file silently did nothing — the failure mode the design
	// notes single out, because a file that is clearly present and has no effect
	// sends a person looking for the problem in the prompt rather than in the file.
	runtimeValue.notices = append(runtimeValue.notices, agentMDNotices(session)...)

	// The EricAI token, and it is handled **here rather than in the entry point**.
	//
	// The catalogue above was read once, and this session's client is holding the
	// key that was in it at that moment — so a refresh is only real if this
	// process installs the new key on the client it is about to use. Doing it in
	// `main` (which is where it used to live) refreshed the file for the *next*
	// run and told a full-screen interface nothing, because its stderr is dropped.
	//
	// `--ericai` decides whether any of this exists: with the flag the token is
	// checked here, before the first turn, and again before every later model call
	// (authCheck). Without it there is no auth state at all, so the check below is
	// a nil read and an authentication failure is reported like any other fatal
	// error.
	runtimeValue.initAuth(options.EricAI)
	if options.EricAI {
		runtimeValue.StartupAuth()
	}

	memory, err := MemoryFromPermissions()
	if err != nil {
		return nil, err
	}
	memory.Sink = func(text string) { warn(text) }
	runtimeValue.Memory = memory

	jobs, jobTools := builtin.NewJobs(workspace, session.SessionID)
	runtimeValue.Jobs = jobs

	// Skills are scanned from disk, never from a path the model supplies. The
	// user-level directories live outside the workspace, and write_file cannot
	// reach them either, so for that half "only a person can change a skill" is
	// guaranteed by the operating system.
	skillLoader := skills.NewLoader()

	// The network tools. fetch_web needs no key and is always there; web_search
	// needs one, and without a key it is **not registered at all** rather than
	// registered and apologising — a tool the model can see but that never works
	// costs a round trip every time it is tried, and teaches it that tools lie.
	extra := append([]tools.Tool{}, jobTools...)
	extra = append(extra, builtin.NewFetchWeb(runtimeValue.httpClient))
	hasFetch := true

	// The goal tools. Their commit goes straight to the session store rather than
	// waiting for the next step boundary: a goal change is a decision about what
	// the session is for, and losing it to a Ctrl+C that lands a second later
	// would leave the model and the file disagreeing about which job is running.
	goalTools := builtin.NewGoalTools(session.Metadata, session, runtimeValue.checkpoint)
	runtimeValue.Goal = goalTools.Board
	extra = append(extra, goalTools.All...)

	// The driver is built here and not armed. A resumed session must never begin
	// autonomous work on its own, and "built unarmed" is the only version of that
	// rule a future change cannot forget to apply: there is no path from loading a
	// session to an armed goal.
	runtimeValue.Driver = NewDriver(runtimeValue)

	hasSearch := false
	if tool, ok := builtin.NewWebSearch(runtimeValue.WebCfg.TavilyAPIKey,
		runtimeValue.WebCfg.TavilyBaseURL, runtimeValue.httpClient); ok {
		extra = append(extra, tool)
		hasSearch = true
	} else {
		runtimeValue.notices = append(runtimeValue.notices, notice("warn", "web",
			i18n.T("notice.web.no_key", "path", paths.ExampleConfigPath())))
	}

	registry, err := builtin.CreateRegistry(builtin.Assembly{
		Workspace:     workspace,
		TodoMetadata:  session.Metadata,
		Questioner:    questionerOf(options.Channels),
		HasJobs:       true,
		HasWebFetch:   hasFetch,
		HasWebSearch:  hasSearch,
		SkillLoader:   skillLoader,
		SkillMetadata: session.Metadata,
		Extra:         extra,
	})
	if err != nil {
		jobs.Close()
		return nil, err
	}
	runtimeValue.Tools = registry.Tools
	runtimeValue.Skills = registry.Skills

	// Delegation, registered after the registry exists because a subagent needs a
	// **copy of the parent's whole tool set** to work from — and that set is only
	// assembled by this point. The tool is built here rather than inside the
	// registry because it needs the chat client, the catalogue and the resolver:
	// assembly, which `internal/tools/builtin` has no business knowing about.
	//
	// The child's payload tail carries the loaded-skill bodies and nothing else.
	// The task list and the skill catalogue are the parent's working memory, and
	// handing them to a child invites it to update a plan it is not running.
	//
	// The board is created before the tool because the tool announces itself to it.
	// A tool built without one still delegates; nothing on screen would say so.
	runtimeValue.Subagents = subagent.NewBoard(security.PerfClock)
	if subagentTool, ok := subagent.Build(subagent.Config{
		Chat:       runtimeValue.Chat,
		Store:      options.Booted.Store,
		Logs:       options.Booted.Logs,
		Catalog:    catalog,
		Resolver:   runtimeValue,
		Parent:     session,
		Tools:      registry.Tools,
		Policy:     runtimeValue.Policy,
		Memory:     memory,
		Notes:      notesFrom(runtimeValue.Skills),
		OnEvent:    runtimeValue.onEvent,
		Board:      runtimeValue.Subagents,
		ShouldStop: options.ShouldStop,
		Warn:       func(text string) { warn("%s", text) },
		MaxDepth:   subagentMaxDepth,
		MaxSteps:   runtimeValue.MaxSteps,
		Thinking:   modelState.Thinking(),
		Effort:     modelState.Effort(),
		Debug:      options.Debug,
		Clock:      security.PerfClock,
	}); ok {
		if err := registry.Tools.Register(subagentTool); err != nil {
			jobs.Close()
			return nil, err
		}
		runtimeValue.notices = append(runtimeValue.notices, notice("info", "subagent",
			i18n.T("notice.subagent.enabled", "tool", subagentTool.Name, "depth", subagentMaxDepth)))
	} else {
		// No tool, so nothing can delegate and a board would be a list that is
		// empty forever. Nil is the state the panel renderer already reads as
		// "there are none", so this is one fewer shape to handle downstream.
		runtimeValue.Subagents = nil
	}

	// Configured servers are announced but **not mounted**: a server is a program
	// that runs on this machine with this user's privileges, so starting one is a
	// decision a person makes rather than a consequence of a config file existing.
	if line := mcpNotice(mcpSpecs); line != "" {
		runtimeValue.notices = append(runtimeValue.notices, notice("info", "mcp", line))
	}

	for range registry.Missing {
		// **The two branches have to stay separate.** "This platform is not
		// supported" and "it is supported but the file is gone" are different
		// problems with different remedies — one needs a line of code, the other
		// needs one command. Merging them into "the engine is missing" sends the
		// first person off to re-run a fetch script, and the script cannot possibly
		// fix it. That is the worst kind of wrong answer: it costs an afternoon and
		// the problem is exactly where it was.
		if triple, ok := hostTriple(); ok {
			runtimeValue.notices = append(runtimeValue.notices, notice("warn", "grep",
				i18n.T("notice.grep.missing_binary", "triple", triple)))
		} else {
			runtimeValue.notices = append(runtimeValue.notices, notice("warn", "grep",
				i18n.T("notice.grep.unsupported_platform", "platform", runtime.GOOS+"/"+runtime.GOARCH)))
		}
	}

	// [MCP] A workspace-level mcp.json is deliberately **not** read: `command` in
	// that file is code executed at start-up, and a file inside the workspace can
	// arrive with a cloned repository. Its existence therefore means somebody wrote
	// a server list in the old place where it does nothing — the same symptom as a
	// malformed skill file, and just as silent.
	if info, err := os.Stat(filepath.Join(paths.WorkspaceRuntimeDir(), "mcp.json")); err == nil && !info.IsDir() {
		runtimeValue.notices = append(runtimeValue.notices, notice("warn", "mcp",
			i18n.T("notice.mcp.ignored_workspace_file",
				"path", filepath.Join(paths.WorkspaceRuntimeDir(), "mcp.json"),
				"file", MCPFile())))
	}

	// [config] Notes the catalogue collected while reading — today that is the
	// leftover `.env`. It is worth a line of its own: a `.env` holds **keys**, and
	// "I filled in a key and it says it found none" is the only symptom it has.
	for _, line := range catalog.Notes {
		runtimeValue.notices = append(runtimeValue.notices, notice("warn", "config", line))
	}
	// [catalog] What is wrong with each route. Reported here rather than only in the
	// "no model at all" error, because one unusable route among three is not a
	// reason to refuse to start — it is a reason to say so.
	for _, line := range catalog.Problems {
		runtimeValue.notices = append(runtimeValue.notices, notice("warn", "catalog", line))
	}

	// [network] Which path requests take: a proxy, or none.
	//
	// Said out loud because this is the one fact about a request that a person
	// cannot see anywhere else, and its absence has already cost real debugging
	// time: a machine whose browser loaded the gateway fine while every model call
	// died on a TLS handshake timeout, with nothing on screen to say the two were
	// taking different routes. A message in a log is cheap next to that.
	if problem := proxy.Problem(); problem != "" {
		runtimeValue.notices = append(runtimeValue.notices, notice("warn", "network",
			i18n.T("notice.proxy.problem", "problem", problem)))
	}
	if configured, source := proxy.Resolve(); configured != nil {
		runtimeValue.notices = append(runtimeValue.notices, notice("info", "network",
			i18n.T("notice.proxy.in_use", "url", configured.String(), "source", source)))
	} else {
		runtimeValue.notices = append(runtimeValue.notices, notice("info", "network",
			i18n.T("notice.proxy.direct")))
	}

	asker := security.AskFunc(nil)
	if options.Channels.AskerFactory != nil {
		// The trust-group lookup is what makes the `a` key at an approval mean
		// "release this server's tools, as they are right now". Passing nil here is
		// not a smaller version of the feature — it removes the key entirely, and
		// the person is left approving an external server's tools one at a time.
		asker = options.Channels.AskerFactory(memory, runtimeValue.McpTrustGroup)
	}

	// The context system. Assembled after the tools (the store is rooted at this
	// session's own directory) and before the agent (which needs it to decide what
	// a payload looks like).
	ctxManager, processor, missingBodies, err := openContext(session, runtimeValue.Chat, catalog)
	if err != nil {
		jobs.Close()
		return nil, err
	}
	runtimeValue.ContextValue = ctxManager
	for _, artifactID := range missingBodies {
		runtimeValue.notices = append(runtimeValue.notices, notice("warn", "context",
			i18n.T("notice.context.missing_body", "id", artifactID)))
	}

	// [background] Two lines, and they have to stay separate: their remedies are
	// completely different.
	//
	// The first: a previous process left jobs behind. That session did not end
	// cleanly (the window was closed, or the process was killed), so those commands
	// **may still be running**, and this session can neither see nor control them.
	// It deliberately does not try: doing so would mean killing the pids it wrote
	// down, and pids are reused — killing the wrong one is far worse than leaving a
	// few orphans. So the notice asks the person to look, rather than performing an
	// action this program cannot honestly stand behind.
	if jobs.Leftovers > 0 {
		runtimeValue.notices = append(runtimeValue.notices, notice("warn", "jobs",
			i18n.T("notice.jobs.leftovers", "n", jobs.Leftovers)))
	}
	// The second: the kernel-level sweep is unavailable, so the guarantee a person
	// believes they have — "closing this also collects the background jobs" — is
	// weaker than they think. A silent downgrade of a guarantee is a lie of
	// omission. Losing it does not mean commands will leak: a normal exit, an
	// exception and Ctrl+C all still run close().
	if problem, ok := process.JobObjectProblem(); ok {
		runtimeValue.notices = append(runtimeValue.notices, notice("warn", "jobs",
			i18n.T("notice.jobs.no_job_object", "problem", problem)))
	}

	// The registered-tools table, and **it goes to stdout**: it is the one start-up
	// line that is part of the session's own output rather than a diagnostic. What
	// the model can actually call is the answer to "why did it not do the obvious
	// thing", and a person reading a transcript wants it there.
	//
	// It is built from the registry itself, so a tool that failed to register — a
	// missing ripgrep build, a missing search key — is visibly absent rather than
	// silently listed.
	runtimeValue.notices = append(runtimeValue.notices, outNotice("info", "tools",
		i18n.T("notice.tools.header")+"\n"+renderRegisteredTools(registry.Tools)))

	runtimeValue.Agent = agent.New(agent.Config{
		Chat:         chat,
		Tools:        registry.Tools,
		Policy:       runtimeValue.Policy,
		Ask:          asker,
		Memory:       memory,
		Session:      session,
		Model:        modelState,
		EffortLevels: runtimeValue.managedLevels(),
		MaxSteps:     runtimeValue.MaxSteps,
		Autopilot:    options.Autopilot,
		Debug:        options.Debug,
		Clock:        security.PerfClock,
		ShouldStop:   options.ShouldStop,
		OnDelta:      deltaSink(options),
		OnCheckpoint: runtimeValue.checkpoint,
		OnEvent:      runtimeValue.onEvent,
		Notes:        runtimeValue.notes,
		// The pre-request check. It goes in as one more thing the retry loop does
		// before an attempt, and it is deliberately **not** called anything about
		// models: "is the credential still good" is asked at the same moment
		// "should the half-written answer be dropped" is, because both are
		// questions about the attempt that is starting.
		//
		// Both hooks are registered unconditionally, and both are nil-safe: without
		// `--ericai` there is no auth state, so the check returns immediately and
		// the recovery answers false. Registering them conditionally instead would
		// put "does this session manage a credential" in a second place, and the
		// retry loop has no business knowing the answer.
		BeforeEach: runtimeValue.authCheck,
		OnFatal:    runtimeValue.RecoverAuth,
		Context:    ctxManager,
		Processor:  processor,
	})
	runtimeValue.OnEventHook = options.OnEventHook
	return runtimeValue, nil
}

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

// StatsLine implements protocol.Runtime.
//
// One line, three facts, all of them counted from the audit log rather than tracked
// separately: a running total in memory would be a second source for the same fact,
// and the two would drift in a way nobody can see. It is the same log `--audit`
// reads, so the two reports agree.
//
// It is **deliberately cumulative** for tokens and steps, because that matches
// "how much has this cost", which is what the reader is asking. The one exception is
// the duration, and its label says so: "this turn" is a different question from
// "this session", and mixing the two would make neither answerable.
func (r *Runtime) StatsLine() string {
	var events []map[string]any
	if r.Logs != nil {
		events, _ = r.Logs.Read(r.SessionIDValue)
	}
	summary := state.Summarize(events)
	usage, _ := summary["usage"].(map[string]any)
	prompt := intPtr(usage["prompt"])

	var builder strings.Builder
	// No successful model call yet (an auth failure on the first turn, say): there
	// is nothing to report, and a line reading "hit rate —" is noise.
	if prompt != nil && *prompt > 0 {
		cached := intPtr(usage["cached"])
		builder.WriteString(i18n.T("stats.usage",
			"prompt", *prompt,
			"cached", deref(cached),
			"hit_rate", state.HitRate(*prompt, deref(cached))))
	}
	// The output rate rides on the same "at least one successful call" guard rather
	// than on its own: completion tokens with no prompt tokens cannot happen (a
	// response always reports both or neither), and splitting the condition would
	// be two tests for one fact that could disagree.
	//
	// It is stated as a cumulative average over the session — "1874 tokens at an
	// average of 38 tok/s" — because that is the question this line answers: this
	// report is per turn, and the previous turn's total is what a person compares
	// the current one against. The per-step figure lives in the transcript.
	//
	// **The segment is omitted, not filled with a dash, when there is no
	// denominator.** A log recorded before `duration_ms` was summed — or one whose
	// successful calls reported no duration — would otherwise print
	// "avg — tok/s" on every turn for ever, which is a claim about a measurement
	// nobody was waiting for. This is the same rule the status bar's segment
	// follows; `OutputRate`'s em dash is for the reports that have a slot to fill.
	if prompt != nil && *prompt > 0 {
		completion := intPtr(usage["completion"])
		if completion != nil {
			if rate, ok := state.OutputRateText(*completion, deref(intPtr(usage["model_ms"]))); ok {
				builder.WriteString(i18n.T("stats.rate",
					"completion", *completion, "rate", rate))
			}
		}
	}
	if ms, ok := lastTurnMs(events); ok {
		builder.WriteString(i18n.T("stats.turn", "value", msText(int(ms))))
	}
	// Two facts about the context figure, both stated in the README: it is what the
	// **last request** actually sent, not "now" (the next one adds this turn's answer
	// and tool results, so it is a lower bound), and it includes the cached part —
	// the window question wants the total, the money question wants the miss, and the
	// miss is already on this line as the hit rate.
	if used := intPtr(summary["last_prompt_tokens"]); used != nil {
		if window := intPtr(r.modelWindow()); window != nil && *window > 0 {
			// Above 100% is reported as it is, never clamped: that turn could not
			// go out, and smoothing the only clue makes it read as "just barely fit".
			percent := float64(*used) / float64(*window) * 100
			builder.WriteString(i18n.T("stats.context.ratio",
				"used", state.TokensText(used), "window", state.TokensText(window),
				"percent", fmt.Sprintf("%.1f", percent)))
		} else {
			builder.WriteString(i18n.T("stats.context.used_only", "used", state.TokensText(used)))
		}
	}
	return builder.String()
}

// deref reads a nullable count as a plain number, for the cases where the caller has
// already established that "absent" and "zero" mean the same thing.
func deref(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

// ProgressLine implements protocol.Runtime.
func (r *Runtime) ProgressLine() string {
	return builtin.NewTodoBoard(r.SessionValue.Metadata).ProgressLine()
}

// JobsProgressLine implements protocol.Runtime: the human's one-line view of the
// background jobs, or "" when there is nothing hanging.
func (r *Runtime) JobsProgressLine() string {
	if r.Jobs == nil {
		return ""
	}
	return r.Jobs.ProgressLine()
}

// GoalLine implements protocol.Runtime: the goal as one line for the transcript,
// or "" when this session has none.
//
// "" for no goal, rather than a line saying there is none: the line terminal
// re-states this after every turn, and a sentence about the absence of a goal is a
// sentence that would appear in every session that never had one. The `/goal`
// command answers the question explicitly for anybody who asks it.
func (r *Runtime) GoalLine() string {
	goal, ok := state.LoadGoal(r.SessionValue.Metadata)
	if !ok {
		return ""
	}
	line := i18n.T("goal.line",
		"objective", goal.Objective,
		"phase", string(goal.Phase),
		"rounds", goal.RoundsText())
	if !r.GoalArmed() {
		line += i18n.T("goal.line.disarmed")
	}
	return line
}

// lastTurnMs is the wall time of the most recent turn, and whether there is one.
//
// Paired **by run_id**, not taken as the last `run_finished` line: when a turn dies
// before it finishes (Ctrl+C, a killed process) the last such line belongs to the
// *previous* turn, and reporting it as "this turn" gives a number that is completely
// unrelated and completely plausible.
func lastTurnMs(events []map[string]any) (int64, bool) {
	runID := ""
	for _, event := range events {
		if stringOf(event["kind"]) == "run_started" {
			runID = stringOf(event["run_id"])
		}
	}
	if runID == "" {
		return 0, false
	}
	for index := len(events) - 1; index >= 0; index-- {
		event := events[index]
		if stringOf(event["kind"]) != "run_finished" || stringOf(event["run_id"]) != runID {
			continue
		}
		if value := intPtr(event["duration_ms"]); value != nil {
			return int64(*value), true
		}
		return 0, false
	}
	return 0, false
}

// msText is a duration as a person reads it. Kept in step with the audit report's
// own rendering: one number shown two ways reads as two numbers.
func msText(ms int) string {
	switch {
	case ms >= 60_000:
		return fmt.Sprintf("%dm%02ds", ms/60_000, (ms%60_000)/1000)
	case ms >= 1_000:
		return fmt.Sprintf("%.1fs", float64(ms)/1000)
	default:
		return fmt.Sprintf("%dms", ms)
	}
}

func stringOf(value any) string {
	text, _ := value.(string)
	return text
}

// NoModelError means no usable route is configured. It carries the catalogue so the
// message can list what was read and what was wrong with each route.
type NoModelError struct{ Catalog state.Registry }

func (e *NoModelError) Error() string { return "no usable model route" }

func catalogPath() string { return "" }

func questionerOf(channels protocol.Channels) builtin.Questioner {
	if channels.Questioner == nil {
		return nil
	}
	questioner := channels.Questioner
	return func(args builtin.AskArgs) builtin.Answer {
		answer := questioner(protocol.AskUserArgs{
			Question: args.Question, Header: args.Header,
			Options: args.Options, MultiSelect: args.MultiSelect,
		})
		return builtin.Answer{Text: answer.Text, Status: answer.Status, HumanWaitMs: answer.HumanWaitMs}
	}
}

// resolveModel picks the model and route this session should use.
//
// Priority: the session's own choice, then the first model on the default route,
// then any other usable route. The last step exists because a session can outlive
// the route it was using — a key removed from the config, say — and refusing to
// start would strand a session that is otherwise fine.
func resolveModel(modelState *state.SessionModel, catalog state.Registry) (string, state.Provider, error) {
	selected := modelState.Selected()
	provider := modelState.SelectedProvider()

	if provider != "" {
		if route, ok := catalog.ProviderByName(provider); ok {
			if ref, found := route.Find(selected); found {
				return ref.ID, route, nil
			}
		}
	}
	if ref, ok := catalog.Find(selected, ""); ok {
		route, _ := catalog.ProviderByName(ref.Provider)
		return ref.ID, route, nil
	}
	if ref, ok := catalog.DefaultModel(); ok {
		route, _ := catalog.ProviderByName(ref.Provider)
		return ref.ID, route, nil
	}
	for _, route := range catalog.Providers {
		if route.Usable() && len(route.Models) > 0 {
			return route.Models[0].ID, route, nil
		}
	}
	return "", state.Provider{}, errorf("no usable model route")
}

// ResolveChild builds the chat client a delegated subagent runs on.
//
// It implements subagent.RouteResolver. The interface lives in the subagent
// package and the implementation lives here because resolving a route means
// knowing the catalogue and which keys are usable — assembly, which the subagent
// package deliberately does not do.
//
// The default is the route this session is **currently** on, not the one it
// started on: a user who switched models mid-session and then delegated would
// otherwise get the old model answering, with nothing on screen saying so.
func (r *Runtime) ResolveChild(route subagent.Route, parentModel, parentProvider string) (subagent.ChildChat, error) {
	// A selection built from the request, so the existing resolution rules apply
	// unchanged: an explicit `provider` is a hard constraint, and a bare model
	// name is looked up across the catalogue. Reimplementing that here is how the
	// `/model` command and delegation would end up disagreeing about what a given
	// model name means.
	selection := state.Selection{
		Model:    firstNonEmpty(route.Model, parentModel),
		Provider: firstNonEmpty(route.Provider, parentProvider),
		Thinking: r.ModelState.Thinking(),
		Effort:   firstNonEmpty(route.Effort, r.ModelState.Effort()),
	}
	metadata := map[string]any{}
	state.StoreSelection(metadata, selection, 0)
	if _, ok := state.LoadSelection(metadata); !ok {
		return subagent.ChildChat{}, errorf("no model named for the subagent")
	}

	modelState := state.NewSessionModel(metadata, selection.Model, selection.Provider)
	chosen, provider, err := resolveModel(modelState, r.Catalog)
	if err != nil {
		return subagent.ChildChat{}, err
	}
	// The key has to be present, and this is the one check the store cannot make:
	// a route with no key is in the catalogue but cannot answer, and a subagent
	// built on it would fail on its first model call with a message about
	// credentials rather than about the delegation.
	if provider.APIKey == "" {
		return subagent.ChildChat{}, fmt.Errorf("route %s has no API key", provider.Name)
	}

	thinking, effort := modelState.Thinking(), modelState.Effort()
	if route.Effort == "" {
		// An explicit reasoning level for the child would need `reasoning_effort`
		// handling on the request path, which the parent's own `/model` command
		// already covers. Until a caller can actually set ChildEffort, the
		// session's level is the honest answer — and it is the predictable one,
		// since changing a route here would otherwise silently change how hard the
		// model thinks.
		effort = r.ModelState.Effort()
	}

	// The **parent's** session id, deliberately, not the child's own. A delegated
	// call belongs to the same conversation, which is what a gateway asking for a
	// per-conversation identifier is asking about — routing and cache affinity are
	// about the work, and the work is the same session. The child's own id is not
	// available here in any case: it is minted by the spawn path, which calls this
	// resolver before it creates the child session, and threading it through would
	// mean teaching the subagent package about request headers for a distinction the
	// gateway does not make.
	childChat, err := model.New(model.Options{
		Route:    routeOf(provider, chosen, r.SessionIDValue),
		Thinking: thinking,
		Effort:   effort,
	})
	if err != nil {
		return subagent.ChildChat{}, err
	}

	return subagent.ChildChat{
		Chat:     childChat,
		Model:    chosen,
		Provider: provider,
	}, nil
}

// routeOf turns one catalogue entry into the model package's route value.
//
// It is the **only** place the two descriptions of a route meet, which is the
// point of it existing: the catalogue says where requests go, and the model
// package says how to send them, and neither has to know the other's field names
// beyond this one conversion. A new route capability is added here once, instead
// of at every construction site — and there is more than one, because delegated
// subagents build their own adapter.
//
// The session id is threaded through here for the same reason. A vendor that asks
// for a per-conversation header gets one without the model package knowing that
// vendor's name and without the configuration file naming a session it cannot see:
// the configuration writes the placeholder, and this is where the value is filled
// in.
func routeOf(provider state.Provider, modelID, sessionID string) model.Route {
	return model.Route{
		Name:      provider.Name,
		APIKey:    provider.APIKey,
		BaseURL:   provider.BaseURL,
		Model:     modelID,
		SessionID: sessionID,
		Verify:    provider.Verify,
		Style:     model.NormalizeStyle(provider.APIStyle),
		Headers:   provider.Headers,
	}
}

// notesFrom is the payload tail a delegated subagent gets: the bodies of the
// skills that are loaded, and nothing else.
//
// The parent's own tail (see notes below) carries four parts, and three of them
// are deliberately withheld from a child. The task list is the parent's stated
// plan and a child has its own task — showing it the parent's list invites it to
// mark steps done that it never ran. The skill *catalogue* is a menu for
// choosing, and which skill to use was the parent's decision, already made before
// it delegated. The background-job warning is about this session's processes, and
// a child cannot delegate at all.
func notesFrom(skills *builtin.SkillBoard) func() string {
	if skills == nil {
		return nil
	}
	return skills.Note
}

// firstNonEmpty returns the first value that is not blank.
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// OnDelegationChanged reports that a subagent started or finished.
//
// It is the seam the protocol server uses to push a fresh snapshot at the two
// moments a delegation changes what the screen should say. It takes no arguments
// because the state itself is read back through `StateMessage` — handing the
// payload through here would give the runtime a second definition of what a
// snapshot is.
//
// The body is empty on purpose: the board is already up to date by the time this
// is called (the delegation announced itself before the event went out), so there
// is nothing for the runtime to do. The method exists so the server can ask "may
// I tell somebody about this" without knowing what a board is.
func (r *Runtime) OnDelegationChanged() {}

// subagentPanel renders the delegations in flight for a front end.
//
// A nil board and an empty board both produce an empty list, never nil: a front
// end that has to tell "there are none" apart from "the runtime did not say" is
// a front end with a second definition of the panel's shape, and the first bug it
// produces is a crash on the empty case.
func (r *Runtime) subagentPanel() []any {
	rows := r.Subagents.Panel()
	out := make([]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, row)
	}
	return out
}

// openContext assembles the context system for one session.
//
// Three things happen here that are individually easy to get wrong:
//
//  1. the artifact store is rooted at **this session's** directory, so two
//     sessions in one workspace cannot reach each other's bodies;
//  2. saved context state is restored, and a session written before this layer
//     existed has its inline tool bodies turned into artifacts — without that,
//     an old session's tool results stay inline forever and the first degradation
//     has nothing to act on;
//  3. artifacts whose bodies are gone are **reported**, not swallowed: "the
//     session opened but some content is unavailable" is something the person has
//     to know, because the alternative is a model silently working from a
//     reference it can never fetch.
//
// The budget comes from the model's declared window. A model that declares none
// gets the budget switched off rather than a guess: an invented ceiling degrades
// a context that would have fit, and then "why can the model not see the whole
// file" has no answer anywhere.
func openContext(session *state.Session, chat model.ChatModel, catalog state.Registry) (*context.Manager, *context.ToolResultProcessor, []string, error) {
	store := context.OpenArtifactStore(paths.SessionArtifactsDir(session.SessionID), nil)
	missing := store.Load()

	var restored *context.ContextState
	if session.Context != nil {
		saved, err := context.ContextStateFromJSON(session.Context)
		if err != nil {
			// A context record this version cannot read is reported and dropped.
			// The artifacts are still on disk and the messages are still in
			// history, so the session opens with a fresh ledger rather than
			// refusing to open at all.
			warn("could not read the saved context state: %v", err)
		} else {
			restored = saved
		}
	}

	var window *int
	if ref, ok := catalog.Find(chat.ModelName(), chat.ProviderName()); ok && ref.Window != nil {
		value := *ref.Window
		window = &value
	}

	manager := context.NewManager(store, restored, context.NewBudget(window),
		func(current *context.ContextState) {
			// The checkpoint reads the Session, so the Session has to point at the
			// live state. Doing this on every change rather than at the end of the
			// turn is what makes a killed process recover to where it really was.
			session.Context = current
		})

	// Legacy sessions: tool bodies are sitting in history as text. Hydrate
	// collects them into the store and gives each a full-level item — which is
	// what happened before, made explicit so it can be degraded later.
	if _, err := manager.Hydrate(session.Messages, context.ZoneDynamic, 0); err != nil {
		return nil, nil, missing, err
	}

	return manager, context.DefaultProcessor(), missing, nil
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
	r.SessionValue.Context = r.contextHandle()
	if err := r.Store.Save(r.SessionValue); err != nil {
		warn("%s", i18n.T("save.failed", "what", "saving the session", "problem", err.Error()))
	}
}

// contextHandle is the serialisable half of the context ledger. The artifact bodies
// are on disk; only references travel.
//
// It returns the live state object rather than a copy: the state is the manager's
// working memory and the checkpoint is a read of it. Copying here would mean two
// objects claiming to be "the context", and the one written to disk would stop
// tracking the one being degraded.
func (r *Runtime) contextHandle() any {
	if r.ContextValue == nil {
		return nil
	}
	return r.ContextValue.State
}

// Context is the session's context ledger, or nil when the layer is off.
func (r *Runtime) Context() *context.Manager { return r.ContextValue }

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
	if r.OnEventHook != nil {
		r.OnEventHook(record)
	}
}

// notes is the trailing block appended to every request payload.
//
// Six parts, in this order: the skill catalogue, the loaded skill bodies, the
// goal, the task list, the background-job warning, and the delegations in flight.
// None of them enters the session's messages: all six are this run's working
// memory, not something either party said.
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
		if part := skills.CatalogPart(r.SessionValue.Metadata, catalog); part != "" {
			parts = append(parts, part)
		}
		if note := r.Skills.Note(); note != "" {
			parts = append(parts, note)
		}
	}
	// The goal, if this session has one. It is rendered from the same board the
	// goal tools write through, so the model cannot be told one thing here and
	// another thing by get_goal.
	if r.Goal != nil {
		if goal, ok := state.LoadGoal(r.SessionValue.Metadata); ok {
			parts = append(parts, state.GoalText(goal, r.activation()))
		}
	}
	// The task list the model maintains itself. It has to be here rather than left
	// in the history: the whole point of the list is to be in front of the model
	// when it decides what to do next, and the history holds N stale copies.
	if note := builtin.NewTodoBoard(r.SessionValue.Metadata).Note(); note != "" {
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
	return r.SessionValue.Messages
}

// ClearStop implements protocol.Runtime.
func (r *Runtime) ClearStop() {}

// MarkStop implements the optional protocol.Runtime stopper.
func (r *Runtime) MarkStop() {}

// RunTurn implements protocol.Runtime.
func (r *Runtime) RunTurn(text string) (string, error) {
	return r.Agent.Run(text)
}

// SetAutopilot implements protocol.Runtime.
func (r *Runtime) SetAutopilot(on bool) { r.Agent.SetAutopilot(on) }

// Close implements protocol.Runtime.
func (r *Runtime) Close() error {
	if r.Jobs != nil {
		if err := r.Jobs.Close(); err != nil {
			warn("%s", i18n.T("close.jobs_failed", "problem", err.Error()))
		}
	}
	// A mounted server is a child process. Leaving children behind on exit is how
	// ports and file handles stay held after the window is closed.
	for _, problem := range r.CloseMcp() {
		warn("%s", problem)
	}
	return nil
}

// InitFields implements protocol.Runtime.
func (r *Runtime) InitFields() map[string]any {
	rows := make([]any, 0, r.Tools.Len())
	for _, tool := range r.Tools.All() {
		rows = append(rows, map[string]any{
			"name":          tool.Name,
			"risk":          string(tool.Risk),
			"parallel_safe": tool.ParallelSafe,
			"interactive":   tool.Interactive,
		})
	}
	notices := make([]any, 0, len(r.notices))
	for _, item := range r.notices {
		notices = append(notices, item)
	}

	provider := r.Chat.ProviderName()
	return map[string]any{
		"session_id":     r.SessionIDValue,
		"resumed":        r.Resumed,
		"model":          r.Chat.ModelName(),
		"provider":       provider,
		"thinking":       r.ModelState.Thinking(),
		"effort":         r.ModelState.Effort(),
		"effort_levels":  r.managedLevels(),
		"model_catalog":  r.modelCatalog(),
		"workspace":      paths.WorkspaceDir(),
		"max_steps":      r.MaxSteps,
		"stream":         r.Stream,
		"context_tokens": r.contextTokens(),
		"tools":          rows,
		"permissions":    r.nonDefaultPermissions(),
		"audit_path":     r.auditPath(),
		"notices":        notices,
	}
}

// StateMessage implements protocol.Runtime.
func (r *Runtime) StateMessage(withCatalog bool) map[string]any {
	payload := map[string]any{
		"todos":            r.todos(),
		"skills":           []any{},
		"jobs":             panelOf(r.Jobs),
		"subagents":        r.subagentPanel(),
		"messages":         len(r.Messages()),
		"steps":            r.SessionValue.StepCount(),
		"model":            r.Chat.ModelName(),
		"model_provider":   r.Chat.ProviderName(),
		"model_window":     r.modelWindow(),
		"thinking":         r.ModelState.Thinking(),
		"effort":           r.ModelState.Effort(),
		"effort_levels":    r.managedLevels(),
		"autopilot":        r.Agent.Autopilot(),
		"granted_tools":    r.Memory.Tools(),
		"granted_prefixes": formattedRules(r.Memory.Prefixes()),
		"denied_tools":     r.Policy.DenyTools,
		"risk_scope":       r.riskScope(),
		"agents_md":        agentsMDRows(r.SessionValue),
		"mcp":              []any{},
		// Always present, in both the "there is one" and "there is not" shapes: a
		// front end with two cases to draw has two places to get the empty one
		// wrong.
		"goal": r.GoalPanel(),
	}
	// Empty lists go out as `[]`, never as `null`. A front end that has to tell
	// "there are none" apart from "the runtime did not say" is a front end with a
	// second definition of the panel's shape, and the first bug it produces is a
	// crash on the empty case.
	if payload["granted_tools"] == nil {
		payload["granted_tools"] = []string{}
	}
	if payload["denied_tools"] == nil {
		payload["denied_tools"] = []string{}
	}
	if payload["granted_prefixes"] == nil {
		payload["granted_prefixes"] = []string{}
	}
	if withCatalog {
		payload["skill_catalog"] = []any{}
	}
	return payload
}

// StatusMessage implements protocol.Runtime.
func (r *Runtime) StatusMessage() map[string]any {
	var events []map[string]any
	if r.Logs != nil {
		events, _ = r.Logs.Read(r.SessionIDValue)
	}
	summary := state.Summarize(events)

	counters, _ := summary["counters"].(map[string]any)
	usage, _ := summary["usage"].(map[string]any)

	lastPrompt := intOrNil(summary["last_prompt_tokens"])
	window := r.modelWindow()

	startedAt := "started: new"
	if r.Resumed {
		startedAt = "started: resumed"
	}

	// A status screen must be answerable before anything has run — that is exactly
	// when somebody wants to look at it. Each of these is a nil-safe read rather
	// than an invariant, so building the payload can never be the thing that fails.
	autopilot := false
	if r.Agent != nil {
		autopilot = r.Agent.Autopilot()
	}
	messages, steps := 0, 0
	if r.SessionValue != nil {
		messages = len(r.SessionValue.Messages)
		steps = r.SessionValue.StepCount()
	}
	toolCount := 0
	if r.Tools != nil {
		toolCount = r.Tools.Len()
	}

	status := map[string]any{
		"session": map[string]any{
			"id":        r.SessionIDValue,
			"resumed":   r.Resumed,
			"workspace": paths.WorkspaceDir(),
			"messages":  messages,
			"steps":     steps,
		},
		"model": map[string]any{
			"provider":  r.Chat.ProviderName(),
			"current":   r.Chat.ModelName(),
			"selected":  r.ModelState.Selected(),
			"last_used": r.ModelState.LastUsed(),
			"since":     r.ModelState.SelectedSince(),
			"window":    window,
			"base_url":  r.Chat.BaseURL(),
			// The two thinking knobs are session-level settings, exactly like the
			// model, so they live in the same group: "what is it using" means who,
			// which route, whether it thinks, and how hard.
			//
			// It is an **object**, not the effort string. A front end reading
			// `reasoning["thinking"]` off a string gets nothing, falls back to its
			// own default, and reports "thinking: on" for a session where it is off.
			"reasoning": map[string]any{
				"thinking": r.ModelState.Thinking(),
				"effort":   r.ModelState.Effort(),
			},
		},
		"counters": counters,
		"usage":    usage,
		// The context ledger travels with the status screen rather than only with
		// `/context`: "how much can it see, and how much did the budget drop" is
		// part of the question `/status` exists to answer. Nil means this runtime
		// has no context layer, which is a different statement from a zero row.
		"context": r.contextLedger(),
		"meta": map[string]any{
			"max_steps":   r.MaxSteps,
			"stream":      r.Stream,
			"autopilot":   autopilot,
			"tool_count":  toolCount,
			"audit_path":  r.auditPath(),
			"permissions": r.nonDefaultPermissions(),
			"started":     startedAt,
			// Which file the catalogue came from. It is a fact rather than
			// decoration: it is the answer to "why did my edit not take effect".
			"catalog": r.Catalog.Source,
		},
	}
	return map[string]any{
		"status":             status,
		"last_prompt_tokens": lastPrompt,
		"context_tokens":     window,
	}
}

// ToolsMessage implements protocol.Runtime.
func (r *Runtime) ToolsMessage() map[string]any {
	rows := make([]any, 0, r.Tools.Len())
	for _, tool := range r.Tools.All() {
		disposition := r.Policy.Disposition(tool.Name, tool.Risk)
		var command any
		if parameter, ok := security.CommandParameter(tool.Name); ok {
			command = parameter
		}
		rows = append(rows, map[string]any{
			"name":          tool.Name,
			"risk":          string(tool.Risk),
			"disposition":   disposition,
			"parallel_safe": tool.ParallelSafe,
			"interactive":   tool.Interactive,
			"external":      tool.External,
			"granted":       r.Memory.Has(tool.Name),
			"command":       command,
		})
	}
	return map[string]any{
		"tools":            rows,
		"granted_prefixes": formattedRules(r.Memory.Prefixes()),
	}
}

// ContextMessage implements protocol.Runtime.
//
// The nesting is deliberate and matches what the interface reads: the outer
// object is "the context feature", the inner one is "the ledger". An empty outer
// object has to make a front end print "there is no context management here"
// rather than a row of zeroes — a row of zeroes reads as "enabled, and it did
// nothing", which is a different and false statement.
//
// Three numbers travel together on purpose: used, limit and the compaction
// line. Reported alone, "151k" is neither big nor small. The third one is what
// answers "when does it compact by itself".
func (r *Runtime) ContextMessage() map[string]any {
	if r.ContextValue == nil {
		return map[string]any{}
	}
	return map[string]any{"context": r.contextPayload()}
}

// contextLedger is the context layer's own numbers, or nil when there is none.
//
// Nil rather than an empty object: an empty object makes a front end print a row
// of zeroes, which reads as "the context system is on and did nothing". "There is
// no context management here" is a different and true statement.
func (r *Runtime) contextLedger() any {
	if r.ContextValue == nil {
		return nil
	}
	return r.ContextValue.Stats()
}

func (r *Runtime) contextPayload() map[string]any {
	if r.ContextValue == nil {
		return nil
	}
	// Measure before reporting. The estimate is normally left behind by a
	// request, so `/context` on a session that has not sent one yet would show
	// zero tokens — and a ledger that reads zero on its own first screen teaches
	// the reader to distrust it. The cost is one linear scan, the same order as
	// the estimate the request path already computes every step.
	if r.Agent != nil {
		r.Agent.RefreshEstimate()
	}
	payload := map[string]any{
		"context": r.ContextValue.Stats(),
		"window":  r.modelWindow(),
	}
	if r.SessionValue != nil {
		payload["messages"] = len(r.SessionValue.Messages)
		if state, ok := context.LoadCompaction(r.SessionValue.Metadata); ok {
			payload["active"] = state.Active()
			payload["folded"] = state.FoldedMessages
			payload["generation"] = state.Generation
			payload["summary_id"] = state.SummaryID
			if artifact, present := r.ContextValue.Store.Get(state.SummaryID); present {
				payload["summary_chars"] = artifact.Chars
			}
		} else {
			payload["active"] = false
			payload["folded"] = 0
		}
	}
	return payload
}

// SkillsMessage implements protocol.Runtime.
//
// It lists what **this session** can load, not what a fresh scan would find: the
// board rescans on read, so a skill added while the session is open appears here
// and is immediately loadable. A catalogue that shows a skill the loader cannot
// find is the one state this must never be in.
func (r *Runtime) SkillsMessage() map[string]any {
	empty := map[string]any{
		"skills": []any{}, "active": []any{}, "roots": []any{},
		"problems": []any{}, "shadowed": []any{},
	}
	if r.Skills == nil || r.SessionValue == nil {
		return empty
	}
	catalog := r.Skills.Catalog()

	rows := make([]any, 0, len(catalog.Skills))
	for _, skill := range catalog.Skills {
		shadowed := make([]any, 0)
		for _, path := range skill.Shadowed() {
			shadowed = append(shadowed, path)
		}
		rows = append(rows, map[string]any{
			"name":        skill.Name,
			"description": skill.Description,
			"path":        skill.Path,
			"shadowed":    shadowed,
		})
	}

	active := make([]any, 0)
	for _, name := range skills.ActiveNames(r.SessionValue.Metadata) {
		active = append(active, name)
	}

	roots := make([]any, 0, len(catalog.Roots))
	for _, root := range catalog.Roots {
		roots = append(roots, root)
	}

	// Problems are rendered here rather than sent as codes: the sentence belongs to
	// the interface's language, and every front end would otherwise carry a copy of
	// the same switch.
	problems := make([]any, 0, len(catalog.Problems))
	for _, problem := range catalog.Problems {
		problems = append(problems, skills.RenderProblem(problem))
	}
	shadowedLines := make([]any, 0, len(catalog.Shadowed))
	for _, problem := range catalog.Shadowed {
		shadowedLines = append(shadowedLines, skills.RenderProblem(problem))
	}

	return map[string]any{
		"skills":   rows,
		"active":   active,
		"roots":    roots,
		"problems": problems,
		"shadowed": shadowedLines,
	}
}

// Compact implements protocol.Runtime.
//
// "no_context" is reported by this layer rather than by the agent: a runtime
// built without the context system cannot compact at all, and that is a
// different answer from "there was nothing to fold" — the user's move differs
// (nothing to do versus nothing to do here).
func (r *Runtime) Compact() (map[string]any, error) {
	if r.Agent == nil || r.ContextValue == nil {
		return map[string]any{
			"compaction": map[string]any{"status": "no_context"},
		}, nil
	}
	return map[string]any{
		"compaction": r.Agent.CompactNow(),
		"context":    r.contextPayload(),
	}, nil
}

// SessionSummaries implements protocol.Runtime.
func (r *Runtime) SessionSummaries() []map[string]any {
	return SessionSummaries(r.Store, SessionListLimit)
}

// SetModel implements protocol.Runtime.
//
// Name resolution, in this order and for this reason:
//
//  1. `provider/model` splits on the slash;
//  2. a bare name that is **a route** resolves to that route's first model — checked
//     *before* the model lookup, because a route whose name happens to equal a model
//     name (`/model flash`) would otherwise switch models when the user meant the
//     route. The two differ on the bill;
//  3. otherwise it is a model id, and an id that exists on two routes is refused
//     rather than guessed: the two answers differ in billing and in compliance.
//
// A model that is already the current one answers "already" rather than reporting a
// switch — the interface echoes that sentence verbatim, and "switched to X from X"
// reads like something happened.
func (r *Runtime) SetModel(name string) (bool, string) {
	catalog := r.Catalog

	wanted := strings.TrimSpace(name)
	providerName := ""
	if split := strings.Index(wanted, "/"); split >= 0 {
		providerName = strings.TrimSpace(wanted[:split])
		wanted = strings.TrimSpace(wanted[split+1:])
	}

	if wanted == "" && providerName != "" {
		found, ok := catalog.ProviderByName(providerName)
		if !ok {
			return false, i18n.T("model.select.no_route", "route", providerName, "names", strings.Join(routeNames(catalog), ", "))
		}
		if len(found.Models) == 0 {
			return false, i18n.T("model.select.route_empty", "route", providerName)
		}
		wanted = found.Models[0].ID
	} else if providerName == "" {
		if found, ok := catalog.ProviderByName(wanted); ok {
			if len(found.Models) == 0 {
				return false, i18n.T("model.select.route_empty", "route", wanted)
			}
			providerName, wanted = wanted, found.Models[0].ID
		}
	}

	ref, ok := catalog.Find(wanted, providerName)
	if !ok {
		if hits := catalog.Ambiguous(wanted); len(hits) > 1 {
			var names []string
			for _, hit := range hits {
				names = append(names, hit.Qualified())
			}
			return false, i18n.T("model.select.ambiguous", "name", wanted, "names", strings.Join(names, ", "))
		}
		var known []string
		for _, model := range catalog.Models() {
			known = append(known, model.ID)
		}
		if len(known) == 0 {
			known = []string{i18n.T("model.select.none_known")}
		}
		return false, i18n.T("model.select.unknown", "name", wanted, "known", strings.Join(known, ", "))
	}

	route, ok := catalog.ProviderByName(ref.Provider)
	if !ok {
		return false, i18n.T("model.select.route_gone", "route", ref.Provider)
	}
	if !route.Usable() {
		return false, i18n.T("model.select.no_key", "route", ref.Provider, "path", r.Catalog.Source)
	}

	if r.ModelState.Selected() == ref.ID && r.ModelState.SelectedProvider() == ref.Provider {
		return true, i18n.T("model.select.already", "name", ref.Qualified())
	}

	previous := r.ModelState.RouteName()

	// The adapter has to accept the change before the session records it. Recording
	// first would leave the session claiming a model the client is not using, and
	// nothing anywhere would report the divergence.
	//
	// **Same route or another route is a real distinction.** Renaming the model on
	// the same route only changes one request field; moving to another route changes
	// the key and the endpoint, which is what `Install` is for. Using `SwitchModel`
	// for both is the worst shape of bug available here: the interface, the session
	// and the audit all say the new route while the request keeps going to the old
	// endpoint on the old key.
	if !r.switchChat(ref, route) {
		return false, i18n.T("model.select.no_switch", "kind", fmt.Sprintf("%T", r.Chat), "path", r.Catalog.Source)
	}
	r.ModelState.SelectRoute(ref.Provider, ref.ID, 0)
	r.applyDefaultEffortFor(ref)
	r.syncReasoning()
	r.checkpoint()

	if previous == "" {
		previous = i18n.T("model.select.unknown_previous")
	}
	return true, i18n.T("model.select.switched", "name", ref.Qualified(), "previous", previous)
}

// switchChat moves the adapter onto one catalogue entry, choosing the cheap path
// when it can.
func (r *Runtime) switchChat(ref state.ModelRef, route state.Provider) bool {
	if r.sameRoute(route) {
		return r.Chat.SwitchModel(ref.ID)
	}
	// Another route: the key, the endpoint and the protocol have to move as well.
	// An adapter that cannot do that is refused rather than renamed, because
	// renaming alone leaves the request going to the old endpoint on the old key
	// while `/status` and the session record both say the new route.
	return r.Chat.Install(routeOf(route, ref.ID, r.SessionIDValue))
}

// sameRoute reports whether the adapter is already pointed at this route.
//
// The comparison is now the whole route rather than a field of it — the same
// test, extended to the parts that did not exist when it was written. It matters
// that the protocol and the extra headers are compared too: a route that changed
// from chat completions to Messages, or that gained a header the vendor now
// requires, is a different endpoint in every sense that matters, and taking the
// cheap "rename the model" path across that change is how the screen ends up
// describing a route that is not the one being talked to.
//
// An adapter that does not describe itself as a route at all falls back to the
// name test: refusing to switch would be worse than a conservative answer, and
// the only adapters in this program do implement it.
func (r *Runtime) sameRoute(route state.Provider) bool {
	if r.Chat.ProviderName() != route.Name {
		return false
	}
	return r.Chat.SameEndpoint(routeOf(route, r.Chat.ModelName(), r.SessionIDValue))
}

// managedLevels is the effort vocabulary the runtime offers and enforces: the
// list the model in use declares, or the broad default when it declares none.
//
// It is asked of the catalogue every time rather than remembered in a field. A
// cached copy was tried and removed the same day: it made "which levels apply"
// have two answers — the field and the catalogue — and a runtime built anywhere
// other than the assembly path had an empty field, so it silently offered the
// broad vocabulary for a model that had declared a narrow one. The catalogue is
// the only thing that knows, so it is the only thing asked.
func (r *Runtime) managedLevels() []string {
	return r.Catalog.EffortLevelsFor(r.ModelState.Selected(), r.ModelState.SelectedProvider())
}

// applyDefaultEffortFor moves the session onto a model's own default level.
//
// Only when nobody has chosen one. A level a person set is not this function's
// to overwrite, even when the new model would rather have another — and when the
// new model cannot take it, the refusal comes from the endpoint at the next
// request, which is the one place that actually knows. Silently meeting the new
// model halfway is what this deliberately does not do: it would change the
// request while leaving the chosen level on screen unchanged.
func (r *Runtime) applyDefaultEffortFor(ref state.ModelRef) {
	if r.ModelState.EffortChosen() || ref.DefaultEffort == "" {
		return
	}
	if r.ModelState.Effort() != ref.DefaultEffort {
		r.ModelState.SelectEffort(ref.DefaultEffort, 0)
	}
}

// syncReasoning hands both thinking knobs back to the adapter.
//
// One place does this, and it is called from both paths that can change what
// `/effort` may offer — composing a session and switching models — because two
// call sites resolving the same question is two answers waiting to disagree.
func (r *Runtime) syncReasoning() {
	r.Chat.SetReasoning(r.ModelState.Thinking(), r.ModelState.Effort())
}

// routeNames lists the configured route names, for a "no such route" message that
// tells the user what there is.
func routeNames(catalog state.Registry) []string {
	out := make([]string, 0, len(catalog.Providers))
	for _, provider := range catalog.Providers {
		out = append(out, provider.Name)
	}
	return out
}

// SetThinking implements protocol.Runtime.
func (r *Runtime) SetThinking(on bool) (bool, string) {
	r.ModelState.SelectThinking(on, 0)
	r.Chat.SetReasoning(on, r.ModelState.Effort())
	r.checkpoint()
	if on {
		return true, i18n.T("thinking.select.on", "effort", r.ModelState.Effort())
	}
	return true, i18n.T("thinking.select.off")
}

// SetEffort implements protocol.Runtime.
//
// The list it checks against is the one the model in use declares, so a level a
// neighbouring model takes is refused here with a sentence naming what this one
// takes, rather than travelling to the endpoint to earn a bare 400.
func (r *Runtime) SetEffort(level string) (bool, string) {
	levels := r.managedLevels()
	if state.IsOff(level) {
		return false, i18n.T("effort.select.off_word", "levels", strings.Join(levels, " / "))
	}
	resolved, ok := state.ResolveEffort(level, levels)
	if !ok {
		return false, i18n.T("effort.select.unknown",
			"effort", level,
			"levels", strings.Join(levels, " / "))
	}
	r.ModelState.SelectEffort(resolved, 0)
	r.Chat.SetReasoning(r.ModelState.Thinking(), resolved)
	r.checkpoint()
	if !r.ModelState.Thinking() {
		return true, i18n.T("effort.select.ok_off", "level", resolved)
	}
	return true, i18n.T("effort.select.ok", "level", resolved)
}

// --- helpers ----------------------------------------------------------------

// todos is the task list as the panel payload carries it.
//
// The reading of the two stored shapes lives in `builtin.TodoRows`, not here: this
// function used to accept only the `[]any` a session file decodes to, so a list the
// model had just written (a `[]map[string]any` in live metadata) came back as "no
// tasks" for the whole session — the rail's Tasks block stayed empty until the
// session was resumed, which is the one moment the list has been through JSON.
func (r *Runtime) todos() []any {
	return builtin.TodoRows(r.SessionValue.Metadata)
}

func (r *Runtime) modelWindow() any {
	ref, ok := r.Catalog.Find(r.Chat.ModelName(), r.Chat.ProviderName())
	if !ok || ref.Window == nil {
		return nil
	}
	return *ref.Window
}

func (r *Runtime) contextTokens() any { return r.modelWindow() }

func (r *Runtime) modelCatalog() map[string]any {
	rows := make([]any, 0)
	aliases := make([]any, 0)
	current := r.Chat.ModelName()
	currentProvider := r.Chat.ProviderName()
	for _, model := range r.Catalog.Models() {
		isCurrent := model.ID == current && model.Provider == currentProvider
		// The row for the model in use carries the level actually set, which may
		// not be that model's default; every other row carries what picking it
		// would give. A row that reported the declared default while the session
		// ran on something else would describe a request nobody is making.
		effort := ""
		if isCurrent {
			effort = r.ModelState.Effort()
		}
		rows = append(rows, model.AsRow(isCurrent, effort))
	}
	return map[string]any{"models": rows, "aliases": aliases}
}

func (r *Runtime) riskScope() []any {
	rows := make([]any, 0, 3)
	for _, risk := range []security.RiskLevel{security.RiskLow, security.RiskMedium, security.RiskHigh} {
		disposition := "ask"
		if r.Policy.AutoApproves(risk) {
			disposition = "auto"
		}
		rows = append(rows, map[string]any{"risk": string(risk), "disposition": disposition})
	}
	return rows
}

// nonDefaultPermissions reports only what differs from the default, so the
// interface can leave the line out entirely on an ordinary run.
//
// Deciding what counts as non-default is the configuration's knowledge; a front end
// hard-coding its own idea of "default" would be a second source for the same fact,
// and it drifts by *failing to show something it should*.
func (r *Runtime) nonDefaultPermissions() map[string]any {
	out := map[string]any{}
	if !sameStrings(r.Permissions.AutoApprove, []string{string(security.RiskLow)}) {
		out["auto_approve"] = r.Permissions.AutoApprove
	}
	if len(r.Permissions.AutoApproveTools) > 0 {
		out["auto_approve_tools"] = r.Permissions.AutoApproveTools
	}
	if len(r.Permissions.DenyTools) > 0 {
		out["deny_tools"] = r.Permissions.DenyTools
	}
	if len(r.Permissions.ShellAllow) > 0 {
		out["shell_allow"] = formattedRules(r.Permissions.ShellAllow)
	}
	return out
}

func (r *Runtime) auditPath() string {
	if r.Logs == nil {
		return ""
	}
	path, err := r.Logs.Path(r.SessionIDValue)
	if err != nil {
		return ""
	}
	return path
}

// agentMDNotices turns the AGENT.md report stored in a session's metadata back into
// the start-up lines about it.
//
// The report is read back from the session rather than from disk, for the reason
// `AgentMDForDisplay` gives for doing the same: a restored session has to describe
// the prompt it actually carries. The file may have been fixed, deleted or grown
// since, and a notice about today's copy would be a statement about a different
// session's prompt.
//
// A session with no AGENT.md has no record and produces no lines: not having the file
// is the normal state, and a line for it would bury the cases that do matter.
func agentMDNotices(session *state.Session) []map[string]any {
	if session == nil {
		return nil
	}
	block, ok := session.Metadata[state.AgentMDSessionKey].(map[string]any)
	if !ok {
		return nil
	}
	var report state.AgentMDReport
	if loaded, ok := block["loaded"].([]any); ok {
		for _, item := range loaded {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			report.Loaded = append(report.Loaded, state.AgentMDLoaded{
				Path:       stringOf(entry["path"]),
				Lines:      intOf(entry["lines"]),
				TotalLines: intOf(entry["total_lines"]),
				Dropped:    intOf(entry["dropped"]),
				Omitted:    intOf(entry["omitted"]),
			})
		}
	}
	if failures, ok := block["failures"].([]any); ok {
		for _, item := range failures {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			report.Failures = append(report.Failures, state.AgentMDFailure{
				Path:   stringOf(entry["path"]),
				Reason: stringOf(entry["reason"]),
			})
		}
	}
	if !report.HasAnything() {
		return nil
	}
	out := make([]map[string]any, 0, 2)
	for _, line := range state.AgentMDNotices(report, paths.WorkspaceDir()) {
		out = append(out, notice(line[0], line[1], line[2]))
	}
	return out
}

// intOf reads a whole number out of a decoded JSON object.
//
// It exists here rather than being shared with the agent-facing helpers because the
// shapes differ: this side reads what `encoding/json` produced (float64 for every
// number) out of stored metadata, and a missing or mistyped field is not an error —
// the count it feeds is a display figure, and zero is the honest reading of "not
// recorded".
func intOf(value any) int {
	switch number := value.(type) {
	case int:
		return number
	case int64:
		return int(number)
	case float64:
		return int(number)
	default:
		return 0
	}
}

// notice builds one start-up line.//
// `stream` says where it belongs: "err" for diagnostics, "out" for the one thing
// that is part of the session's own output. The distinction is not cosmetic — the
// line REPL's stdout is a documented contract (`tudouni-aigo > chat.txt` has to contain
// the conversation and nothing else), so a notice that lands on the wrong stream
// either pollutes the transcript or hides a warning where nobody reads it.
func notice(level, code, text string) map[string]any {
	return map[string]any{"level": level, "code": code, "text": text, "stream": "err"}
}

// outNotice is a notice that belongs on stdout. There is exactly one kind — the
// list of registered tools — and it is there because the previous generation put it
// there and the ordering of the start-up output is a contract too.
func outNotice(level, code, text string) map[string]any {
	return map[string]any{"level": level, "code": code, "text": text, "stream": "out"}
}

// renderRegisteredTools is the one-row-per-tool part of the start-up table.
//
// Sorted by the registry already, so two runs of the same build produce the same
// text — a diff of two sessions means something only if the constant part really is
// constant.
func renderRegisteredTools(registry *tools.Registry) string {
	rows := make([]string, 0, registry.Len())
	for _, tool := range registry.All() {
		rows = append(rows, i18n.T("notice.tools.row", "name", tool.Name, "risk", string(tool.Risk)))
	}
	return strings.Join(rows, "\n")
}

func panelOf(jobs *builtin.JobBoard) []any {
	if jobs == nil {
		return []any{}
	}
	rows := jobs.Panel()
	out := make([]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, row)
	}
	return out
}

func agentsMDRows(session *state.Session) []any {
	rows := state.AgentMDForDisplay(session.Metadata[state.AgentMDSessionKey], paths.WorkspaceDir())
	out := make([]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, row)
	}
	return out
}

func formattedRules(rules []security.Rule) []string {
	out := make([]string, 0, len(rules))
	for _, rule := range rules {
		if text, err := security.FormatRule(rule); err == nil {
			out = append(out, text)
		}
	}
	return out
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}

func intOrNil(value any) any {
	switch number := value.(type) {
	case int:
		return number
	case float64:
		return int(number)
	default:
		return nil
	}
}

// intPtr reads a nullable number out of an audit record or a summary map. The
// pointer matters: "no reading yet" and "zero" are different facts, and a stats line
// that prints 0 for both tells the reader something false.
func intPtr(value any) *int {
	switch number := value.(type) {
	case int:
		return &number
	case int64:
		converted := int(number)
		return &converted
	case float64:
		converted := int(number)
		return &converted
	default:
		return nil
	}
}

// warn writes a diagnostic to stderr.
//
// Never to stdout: stdout carries the protocol when this process is a child, and
// prose mixed into it corrupts the stream for every reader that is parsing it.
func warn(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

// Version is the build identification reported by --version.
func Version() string { return version.Current() }
