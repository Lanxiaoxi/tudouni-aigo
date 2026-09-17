package runtime

import (
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/agent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/skills"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/version"
)

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

// SessionSummaries lists saved sessions, newest first.
//
// The order is by **creation time**, not by id. `--session demo` is not a
// timestamp, and sorting by id would put it in the wrong place — while the
// question the list answers is "which one was I working on", and that is almost
// always the most recent.
func SessionSummaries(store *state.SessionStore, limit int) []map[string]any {
	ids := store.ListIDs()
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

	// ShouldStop is the per-turn cancellation flag.
	ShouldStop func() bool
	// OnDelta reports stream increments.
	OnDelta func(text, reasoning string, reset bool)
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
	Chat           model.ChatModel
	WebCfg         WebConfig
	McpCfg         []McpServerSpec
	Permissions    PermissionConfig
	Autopilot      bool
	Debug          bool
	Stream         bool
	MaxSteps       int
	Resumed        bool
	ModelState     *state.SessionModel
	Catalog        state.Registry

	// ContextValue is the session's context ledger: which artifacts are in play,
	// at what level, and what has been folded away.
	ContextValue *context.Manager
	// Skills is the loaded-skill board, which the payload tail renders from.
	Skills *builtin.SkillBoard

	notices    []map[string]any
	mcpNames   []string
	httpClient *http.Client
	startedAt  time.Time

	// OnEventHook is where the protocol server subscribes. It is a field rather
	// than an interface so the runtime does not have to know that a protocol
	// server exists — it only knows somebody wants the records.
	OnEventHook func(record map[string]any)
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

	chat := model.New(model.Options{
		APIKey:   chosenProvider.APIKey,
		BaseURL:  chosenProvider.BaseURL,
		Model:    chosen,
		Provider: chosenProvider.Name,
		Verify:   chosenProvider.Verify,
		Thinking: modelState.Thinking(),
		Effort:   modelState.Effort(),
	})

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

	memory, err := MemoryFromPermissions()
	if err != nil {
		return nil, err
	}
	memory.Sink = func(text string) { warn(text) }
	runtimeValue.Memory = memory

	jobs, jobTools := builtin.NewJobs(workspace)
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

	for _, name := range registry.Missing {
		runtimeValue.notices = append(runtimeValue.notices, notice("warn", "grep",
			i18n.T("notice.grep.missing_binary", "triple", name)))
	}

	asker := security.AskFunc(nil)
	if options.Channels.AskerFactory != nil {
		asker = options.Channels.AskerFactory(memory, nil)
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

	runtimeValue.Agent = agent.New(agent.Config{
		Chat:         chat,
		Tools:        registry.Tools,
		Policy:       runtimeValue.Policy,
		Ask:          asker,
		Memory:       memory,
		Session:      session,
		Model:        modelState,
		MaxSteps:     runtimeValue.MaxSteps,
		Autopilot:    options.Autopilot,
		Debug:        options.Debug,
		Clock:        security.PerfClock,
		ShouldStop:   options.ShouldStop,
		OnDelta:      options.OnDelta,
		OnCheckpoint: runtimeValue.checkpoint,
		OnEvent:      runtimeValue.onEvent,
		Notes:        runtimeValue.notes,
		Context:      ctxManager,
		Processor:    processor,
	})
	runtimeValue.OnEventHook = options.OnEventHook
	return runtimeValue, nil
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

func (r *Runtime) onEvent(record map[string]any) {
	// Audit first, protocol second — in that order, so a front end that dies
	// mid-turn cannot cost the record. And a failed audit write is swallowed: an
	// observation failure must never damage what is being observed, and the caller
	// here is sometimes holding a half-written message list.
	if r.Logs != nil {
		if err := r.Logs.Write(record); err != nil {
			warn("audit write failed: %v", err)
		}
	}
	if r.OnEventHook != nil {
		r.OnEventHook(record)
	}
}

// notes is the trailing block appended to every request payload.
//
// It carries the task list and the background-job warning, and it never enters the
// session's messages: both are this run's working memory, not something either
// party said.
func (r *Runtime) notes() string {
	var parts []string
	if r.Jobs != nil {
		if note := r.Jobs.Note(); note != "" {
			parts = append(parts, note)
		}
	}
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
	return strings.Join(parts, "\n\n")
}

// --- protocol.Runtime -------------------------------------------------------

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
		"effort_levels":  state.EffortLevels,
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
		"messages":         len(r.Messages()),
		"steps":            r.SessionValue.StepCount(),
		"model":            r.Chat.ModelName(),
		"model_provider":   r.Chat.ProviderName(),
		"model_window":     r.modelWindow(),
		"thinking":         r.ModelState.Thinking(),
		"effort":           r.ModelState.Effort(),
		"effort_levels":    state.EffortLevels,
		"autopilot":        r.Agent.Autopilot(),
		"granted_tools":    r.Memory.Tools(),
		"granted_prefixes": formattedRules(r.Memory.Prefixes()),
		"denied_tools":     r.Policy.DenyTools,
		"risk_scope":       r.riskScope(),
		"agents_md":        agentsMDRows(r.SessionValue),
		"mcp":              []any{},
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

	status := map[string]any{
		"session": map[string]any{
			"id":        r.SessionIDValue,
			"resumed":   r.Resumed,
			"workspace": paths.WorkspaceDir(),
			"messages":  len(r.Messages()),
			"steps":     r.SessionValue.StepCount(),
		},
		"model": map[string]any{
			"provider":  r.Chat.ProviderName(),
			"current":   r.Chat.ModelName(),
			"selected":  r.ModelState.Selected(),
			"last_used": r.ModelState.LastUsed(),
			"since":     r.ModelState.SelectedSince(),
			"window":    window,
			"base_url":  r.Chat.BaseURL(),
			"reasoning": r.ModelState.Effort(),
		},
		"counters": counters,
		"usage":    usage,
		"meta": map[string]any{
			"max_steps":   r.MaxSteps,
			"stream":      r.Stream,
			"autopilot":   r.Agent.Autopilot(),
			"tool_count":  r.Tools.Len(),
			"audit_path":  r.auditPath(),
			"permissions": r.nonDefaultPermissions(),
			"started":     startedAt,
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

// MCPMessage implements protocol.Runtime.
func (r *Runtime) MCPMessage(action string, servers []string) (map[string]any, []string) {
	// No MCP host is assembled in this build, so the panel says so instead of
	// showing an empty list that would read as "everything is unmounted".
	return nil, []string{i18n.T("channels.mcp.no_host")}
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
func (r *Runtime) SetModel(name string) (bool, string) {
	catalog := r.Catalog
	ref, ok := catalog.Find(name, "")
	if !ok {
		if hits := catalog.Ambiguous(name); len(hits) > 1 {
			var names []string
			for _, hit := range hits {
				names = append(names, hit.Provider)
			}
			return false, i18n.T("model.select.ambiguous", "name", name, "names", strings.Join(names, ", "))
		}
		var known []string
		for _, model := range catalog.Models() {
			known = append(known, model.ID)
		}
		if len(known) == 0 {
			known = []string{i18n.T("model.select.none_known")}
		}
		return false, i18n.T("model.select.unknown", "name", name, "known", strings.Join(known, ", "))
	}
	route, ok := catalog.ProviderByName(ref.Provider)
	if !ok || !route.Usable() {
		return false, i18n.T("model.select.no_key", "route", ref.Provider, "path", r.Catalog.Source)
	}
	previous := r.ModelState.RouteName()

	// The adapter has to accept the change before the session records it. Recording
	// first would leave the session claiming a model the client is not using, and
	// nothing anywhere would report the divergence.
	if !r.Chat.SwitchModel(ref.ID) {
		return false, i18n.T("model.select.no_switch", "kind", fmt.Sprintf("%T", r.Chat), "path", r.Catalog.Source)
	}
	r.ModelState.SelectRoute(ref.Provider, ref.ID, 0)
	r.checkpoint()

	if previous == "" {
		previous = i18n.T("model.select.unknown_previous")
	}
	return true, i18n.T("model.select.switched", "name", ref.ID, "previous", previous)
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
func (r *Runtime) SetEffort(level string) (bool, string) {
	if state.IsOff(level) {
		return false, i18n.T("effort.select.off_word", "levels", strings.Join(state.EffortLevels, " / "))
	}
	resolved, ok := state.ResolveEffort(level)
	if !ok {
		return false, i18n.T("effort.select.unknown",
			"effort", level,
			"levels", strings.Join(state.EffortLevels, " / "),
			"aliases", strings.Join(sortedAliases(), " / "))
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

func (r *Runtime) todos() []any {
	raw, ok := r.SessionValue.Metadata[builtin.TodosKey]
	if !ok {
		return []any{}
	}
	if list, ok := raw.([]any); ok {
		return list
	}
	return []any{}
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
	for _, model := range r.Catalog.Models() {
		rows = append(rows, model.AsRow(model.ID == r.Chat.ModelName() && model.Provider == r.Chat.ProviderName()))
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

func notice(level, code, text string) map[string]any {
	return map[string]any{"level": level, "code": code, "text": text}
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

func sortedAliases() []string {
	out := make([]string, 0, len(state.EffortAliases))
	for alias := range state.EffortAliases {
		out = append(out, alias)
	}
	sort.Strings(out)
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

// warn writes a diagnostic to stderr.
//
// Never to stdout: stdout carries the protocol when this process is a child, and
// prose mixed into it corrupts the stream for every reader that is parsing it.
func warn(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

// Version is the build identification reported by --version.
func Version() string { return version.Current() }
