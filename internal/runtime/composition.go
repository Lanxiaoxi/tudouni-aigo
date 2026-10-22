package runtime

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/agent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cggraph"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/files"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/process"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/proxy"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/skills"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/subagent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/terminal"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

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

	// The picture loader is created **empty** and filled in once the context layer
	// exists. The order is forced by the dependencies rather than chosen: the chat
	// adapter needs the model's window to build its route, and the window comes
	// from the catalogue — so the adapter (and therefore the loader it carries) is
	// built before the artifact store it will read pictures from. Requests are
	// built long after assembly has finished, so the field is written once and read
	// only later.
	images := &artifactImages{}

	chat, err := model.New(model.Options{
		Route:    routeOf(chosenProvider, chosen, session.SessionID),
		Thinking: modelState.Thinking(),
		Effort:   modelState.Effort(),
		Images:   images.Load,
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
		Workspace:      workspace,
		// The file service shares the boundary just resolved rather than resolving
		// the root a second time: two resolutions of one root are two objects that
		// agree today and are free to stop agreeing tomorrow, and the day they
		// disagree one door is guarded and the other is not.
		Files:      files.NewServiceFromWorkspace(workspace),
		Terminals:  options.Booted.Terminals,
		SSH:        options.Booted.SSH,
		mcpNames:   mcpNames,
		httpClient: &http.Client{Timeout: 120 * time.Second},
		startedAt:  time.Now(),
		report:     options.Report,
	}
	if runtimeValue.MaxSteps == 0 {
		runtimeValue.MaxSteps = agent.DefaultMaxSteps
	}

	// [memory] The workspace's own memory. Opened **here**, before the tools are
	// assembled, because the three memory tools are registered from it and a runtime
	// that cannot open its memory directory must not offer tools that would then fail
	// on every call.
	//
	// A failure is not returned: it becomes a warning and the session runs without
	// memory. That is the design's rule, and it is also the only defensible one — a
	// workspace whose `.tudouni/memory` cannot be created (a read-only checkout, a
	// permission problem) is still a workspace somebody needs to work in.
	runtimeValue.openMemory()

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
	// checked before the first turn, and again before every later model call
	// (authCheck). Without it there is no auth state at all, so an authentication
	// failure is reported like any other fatal error.
	//
	// **The check itself is not run here.** It used to be, and that was wrong for
	// one reason: this function returns before the handshake is emitted, so an
	// interactive login would block `init` for its whole five-minute timeout — and
	// the instructions a person has to act on would arrive only after the device
	// code had already expired. Whoever knows the right moment calls it instead:
	// the protocol server, right after `emitOpening` (see Server.emitOpening), and
	// `cli.Run`, which prints the notices itself and so has to run the check first.
	runtimeValue.initAuth(options.EricAI)

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
	// The memory tools. Empty when the subsystem did not open, which is why this is an
	// append of a possibly-empty slice rather than a conditional registration: "there is
	// no memory here" and "there are no memory tools" are the same state.
	extra = append(extra, builtin.NewMemoryTools(runtimeValue.WorkspaceMemory).All...)
	hasFetch := true

	// The SSH tools. They are registered only when a manager exists, and the
	// manager carries the *user's* configuration rather than this session's — the
	// same rule the terminals follow, and for a sharper reason: a remote shell the
	// agent is halfway through a deployment in must not be torn down because
	// somebody switched sessions.
	extra = append(extra, builtin.NewSSHTools(runtimeValue.SSH)...)

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

	// The code index's handle, built here rather than inside the registry because it is
	// shared: the `code_explore` tool's inline freshness check and the panel's init/sync
	// must serialize on **one** mutex and one cross-process claim. Two refreshers over
	// one index would be two locks pretending to guard one write path.
	//
	// The parser binary is optional, and its absence is not an error: an index built
	// earlier can still be queried, it just cannot be brought up to date — a state the
	// panel shows and `code_explore` warns about. See internal/codeintel.
	parserPath, _ := builtin.CgParserBinary()
	refresher := codeintel.New(workspace.Root(), parserPath)
	codeIntelEnabled := codeintel.Enabled(workspace.Root())
	runtimeValue.CodeIntel = newCodeIntelState(workspace, refresher, codeIntelEnabled)

	registry, err := builtin.CreateRegistry(builtin.Assembly{
		Workspace:        workspace,
		TodoMetadata:     session.Metadata,
		Questioner:       questionerOf(options.Channels),
		HasJobs:          true,
		HasWebFetch:      hasFetch,
		HasWebSearch:     hasSearch,
		SkillLoader:      skillLoader,
		SkillMetadata:    session.Metadata,
		CodeIntel:        refresher,
		CodeIntelEnabled: codeIntelEnabled,
		Extra:            extra,
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
	// The collect tool is registered **before** the delegating tool builds its
	// child view: a child's tool set is a clone of the parent's registry made at
	// delegation time, and the exclusion by name (sessionScopedToolNames) needs
	// the name present in the parent's registry to mean anything.
	if collectTool, ok := subagent.BuildCollect(runtimeValue.Subagents); ok {
		if err := registry.Tools.Register(collectTool); err != nil {
			jobs.Close()
			return nil, err
		}
	}
	if handle, subagentTool, ok := subagent.BuildWithHandle(subagent.Config{
		Chat:          runtimeValue.Chat,
		Store:         options.Booted.Store,
		Logs:          options.Booted.Logs,
		Catalog:       catalog,
		Resolver:      runtimeValue,
		Parent:        session,
		Tools:         registry.Tools,
		Policy:        runtimeValue.Policy,
		Memory:        memory,
		Notes:         notesFrom(runtimeValue.Skills),
		OnEvent:       runtimeValue.onEvent,
		Board:         runtimeValue.Subagents,
		ShouldStop:    options.ShouldStop,
		Warn:          func(text string) { warn("%s", text) },
		MaxDepth:      subagentMaxDepth,
		MaxBackground: subagentMaxBackground,
		MaxSteps:      runtimeValue.MaxSteps,
		Thinking:      modelState.Thinking(),
		Effort:        modelState.Effort(),
		Debug:         options.Debug,
		Clock:         security.PerfClock,
	}); ok {
		if err := registry.Tools.Register(subagentTool); err != nil {
			jobs.Close()
			return nil, err
		}
		// Kept for SubagentStop: the runtime's own handle on the delegating
		// tool, so a stop request from the front end reaches the one child it
		// names without the runtime knowing how cancellation is stored.
		runtimeValue.subagentStopper = handle
		runtimeValue.notices = append(runtimeValue.notices, notice("info", "subagent",
			i18n.T("notice.subagent.enabled", "tool", subagentTool.Name, "depth", subagentMaxDepth)))
	} else {
		// No tool, so nothing can delegate and a board would be a list that is
		// empty forever. Nil is the state the panel renderer already reads as
		// "there are none", so this is one fewer shape to handle downstream.
		runtimeValue.Subagents = nil
	}

	// Servers are announced, and the ones that asked to come up with the session
	// are mounted here — which is the only place mounting happens without a person
	// asking for it, so the decision itself is recorded in mcp.json's `auto_load`
	// rather than inferred from the file existing.
	//
	// **Mounting runs before the notice**, and that order is the point: the line
	// then reports what is actually running instead of what was meant to be, so a
	// server that failed shows up as its own warning and the counts in the notice
	// can be trusted.
	autoNotes, autoFailed, autoMounted := runtimeValue.mcpAutoMount(mcpSpecs)
	for _, line := range autoNotes {
		runtimeValue.notices = append(runtimeValue.notices, notice("info", "mcp", line))
	}
	for _, line := range autoFailed {
		runtimeValue.notices = append(runtimeValue.notices, notice("warn", "mcp", line))
	}
	if line := mcpNotice(mcpSpecs, autoMounted); line != "" {
		runtimeValue.notices = append(runtimeValue.notices, notice("info", "mcp", line))
	}

	for _, missing := range registry.Missing {
		// **Switch on the name.** This used to ignore it and always emit the grep
		// sentence, which was invisible while grep was the only tool that could land
		// here — and became a lie the moment `code_explore` joined it: a workspace with
		// code intelligence turned on and no index yet would have been told its ripgrep
		// build was missing, sending the person to re-vendor a binary that was fine.
		//
		// The two branches inside grep stay separate for the original reason: "this
		// platform is not supported" and "it is supported but the file is gone" are
		// different problems with different remedies — one needs a line of code, the
		// other needs one command.
		switch missing {
		case builtin.CodeExploreToolName:
			runtimeValue.notices = append(runtimeValue.notices, notice("warn", "codeintel",
				i18n.T("notice.codeintel.no_index",
					"path", filepath.ToSlash(cggraph.IndexDirName+"/"+cggraph.DefaultDBName))))
		default:
			if triple, ok := hostTriple(); ok {
				runtimeValue.notices = append(runtimeValue.notices, notice("warn", "grep",
					i18n.T("notice.grep.missing_binary", "triple", triple)))
			} else {
				runtimeValue.notices = append(runtimeValue.notices, notice("warn", "grep",
					i18n.T("notice.grep.unsupported_platform", "platform", runtime.GOOS+"/"+runtime.GOARCH)))
			}
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
		// Said as well as the line above, not instead of it. "Requests go through
		// this proxy" is only true of the destinations the machine did not exclude,
		// and on the server this was reported from the exclusion is the entire point:
		// the model gateway is internal and the proxy cannot reach it. A notice that
		// named the proxy and stopped there would describe the login and misdescribe
		// the model calls.
		if skip := proxy.NoProxy(); skip != "" {
			runtimeValue.notices = append(runtimeValue.notices, notice("info", "network",
				i18n.T("notice.proxy.no_proxy", "list", skip)))
		}
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
	// The loader gets its store now that the store exists. See where it was
	// created for why the two are not built together.
	images.manager = ctxManager
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
		// [memory] The second automatic trigger. It is a **separate hook from OnEvent**
		// because the audit truncates a tool result to two hundred characters, and an
		// error's distinctive half is often at the end of it — a nested "caused by"
		// chain, a version number in the last line. Recall is the one consumer that has
		// to read the whole text.
		OnToolResult: runtimeValue.onToolResult,
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
		// The vision gate, and it is a **function** rather than the value it
		// returns: the model can be switched mid-session, and a bool captured here
		// would answer for the model this session started on. The renderer consults
		// it on every render, which is what makes "attached while a vision model was
		// in use, then switched away" behave rather than fail.
		//
		// A model that has not declared `vision` answers false, so the safe
		// direction is the default: a picture is described in words instead of being
		// sent to a model nobody promised could see, and the session keeps working.
		Vision: runtimeValue.modelVision,
	})
	runtimeValue.OnEventHook = options.OnEventHook
	runtimeValue.onTerminalEvent = options.OnTerminalEvent
	runtimeValue.onCodeIntelEvent = options.OnCodeIntelEvent

	// The terminal manager is process-scoped, so its sink has to be **pointed at
	// this runtime's connection** rather than built with it. That is the whole
	// reason `SetSink` exists: a session switch attaches a new runtime with a new
	// connection while the shells keep running, and the events have to follow the
	// connection.
	//
	// A nil hook leaves whatever sink was there, which is deliberate: an
	// in-process front end (the REPL) that never asks for a terminal should not
	// silently detach the sink a protocol front end installed on the same
	// manager — the two can be alive in one process during a test.
	if runtimeValue.Terminals != nil && options.OnTerminalEvent != nil {
		runtimeValue.Terminals.SetSink(func(event terminal.Event) {
			options.OnTerminalEvent(terminalEventPayload(event))
		})
	}
	return runtimeValue, nil
}
