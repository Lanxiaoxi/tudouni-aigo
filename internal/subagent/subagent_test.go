package subagent

import (
	"os"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// fakeModel is a scripted chat client.
//
// It records what it was asked, which is where most of these assertions read
// from: the properties that matter about a subagent — what it can see, what it
// can call, whether it can ask — are all facts about the request that was sent,
// not about a value this package returns.
type fakeModel struct {
	script []model.ModelResponse
	calls  []model.CompleteOptions
	// seen accumulates the tool names offered on every request, so a test can ask
	// "was the delegating tool ever visible to the child".
	seen []string
	// prompts accumulates the message lists, so a test can ask what the child was
	// told.
	prompts [][]map[string]any
}

func (f *fakeModel) Complete(messages []map[string]any, toolSchemas []map[string]any,
	options model.CompleteOptions) (model.ModelResponse, error) {
	f.prompts = append(f.prompts, messages)
	for _, schema := range toolSchemas {
		function, _ := schema["function"].(map[string]any)
		name, _ := function["name"].(string)
		f.seen = append(f.seen, name)
	}

	index := len(f.calls)
	f.calls = append(f.calls, options)
	if index < len(f.script) {
		return f.script[index], nil
	}
	text := "done"
	return model.ModelResponse{Content: &text}, nil
}

func (f *fakeModel) SwitchModel(string) bool { return true }

func (f *fakeModel) Install(model.Route) bool { return true }

func (f *fakeModel) SetReasoning(bool, string) {}

func (f *fakeModel) ModelName() string { return "fake" }

func (f *fakeModel) ProviderName() string { return "test" }

func (f *fakeModel) BaseURL() string { return "http://localhost" }

func (f *fakeModel) Route() model.Route { return model.Route{Name: "test"} }

func (f *fakeModel) SameEndpoint(model.Route) bool { return true }

// offered reports whether a tool name was ever sent to the child.
func (f *fakeModel) offered(name string) bool {
	for _, seen := range f.seen {
		if seen == name {
			return true
		}
	}
	return false
}

// textResponse and toolCallResponse are the two script entries the tests use.
func textResponse(text string) model.ModelResponse {
	return model.ModelResponse{Content: &text}
}

func toolCallResponse(id, name, arguments string) model.ModelResponse {
	return model.ModelResponse{ToolCalls: []model.ToolCall{{ID: id, Name: name, Arguments: arguments}}}
}

// fakeResolver hands back one client and records what route was asked for.
type fakeResolver struct {
	chat      model.ChatModel
	requested []Route
	parents   [][2]string
	err       error
}

func (f *fakeResolver) ResolveChild(route Route, parentModel, parentProvider string) (ChildChat, error) {
	f.requested = append(f.requested, route)
	f.parents = append(f.parents, [2]string{parentModel, parentProvider})
	if f.err != nil {
		return ChildChat{}, f.err
	}
	return ChildChat{
		Chat:     f.chat,
		Model:    "fake",
		Provider: state.Provider{Name: "test", APIKey: "k", BaseURL: "http://localhost"},
	}, nil
}

// harness is one built tool plus what a test needs to inspect what it did.
type harness struct {
	tool   tools.Tool
	parent *state.Session
	// store is the child-session store the tool was built with. It is kept so a test
	// can make a write fail on purpose: "the child's transcript could not be saved"
	// is a failure that leaves no other trace, and the only way to reach it is to
	// break the sink the tool already holds.
	store    *state.SessionStore
	logs     *audit.JsonlSink
	resolver *fakeResolver
	events   []map[string]any
	child    *fakeModel
	warnings []string
}

// newHarness assembles the tool the way the runtime does, against a temporary
// workspace so the child's artifact store lands somewhere disposable.
func newHarness(t *testing.T, child *fakeModel, extraTools ...tools.Tool) *harness {
	t.Helper()
	// The child's artifact directory is derived from the working directory, so the
	// test runs somewhere disposable rather than in the repository. t.Chdir
	// restores it even if the test fails.
	t.Chdir(t.TempDir())

	parent := state.NewSession("20260101-120000", t.TempDir())

	registry := tools.NewRegistry()
	if err := registry.Register(tools.Tool{
		Name:         "read_file",
		Description:  "read",
		Risk:         security.RiskLow,
		ParallelSafe: true,
		Schema:       tools.ObjectSchema(map[string]any{"path": tools.StringSchema("path")}, "path"),
		Handler: func(map[string]any) (tools.Result, error) {
			return tools.TextResult("contents"), nil
		},
	}); err != nil {
		t.Fatal(err)
	}
	for _, tool := range extraTools {
		if err := registry.Register(tool); err != nil {
			t.Fatal(err)
		}
	}

	store, err := state.NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	logs, err := audit.NewJsonlSink(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	resolver := &fakeResolver{chat: child}
	h := &harness{parent: parent, store: store, logs: logs, resolver: resolver, child: child}

	built, ok := Build(Config{
		Chat:     child,
		Store:    store,
		Logs:     logs,
		Catalog:  state.Registry{},
		Resolver: resolver,
		Parent:   parent,
		Tools:    registry,
		Policy:   security.NewPolicy(),
		OnEvent: func(record map[string]any) {
			// The runtime's own event path writes the audit log, and the test
			// harness has to do the same: the delegation's usage line is read back
			// out of that log, so a harness that only collected records in memory
			// would report every child as having cost nothing.
			if err := logs.Write(record); err != nil {
				t.Errorf("audit write failed: %v", err)
			}
			h.events = append(h.events, record)
		},
		Warn: func(text string) { h.warnings = append(h.warnings, text) },
		// The tool has to be in the parent's registry for the clone test to mean
		// anything, so it is registered after Build and before the call.
		MaxDepth: DefaultMaxDepth,
	})
	if !ok {
		t.Fatal("Build returned no tool for a depth of three")
	}
	h.tool = built
	if err := registry.Register(built); err != nil {
		t.Fatal(err)
	}
	return h
}

// call runs one delegation the way the agent would, through Execute, so schema
// validation and argument decoding are exercised as well.
func (h *harness) call(t *testing.T, arguments map[string]any) tools.Result {
	t.Helper()
	result, err := h.tool.Execute(arguments)
	if err != nil {
		t.Fatalf("the tool returned an error rather than a result: %v", err)
	}
	return result
}

// TestTheChildCannotDelegateAgain is the recursion guard.
//
// The assertion is on the **tool schemas that were sent**, not on a registry
// lookup: a child that could see the tool would be able to call it, and hiding it
// from the schema is what actually stops the recursion.
func TestTheChildCannotDelegateAgain(t *testing.T) {
	child := &fakeModel{script: []model.ModelResponse{textResponse("child answer")}}
	h := newHarness(t, child)

	result := h.call(t, map[string]any{"prompt": "count the widgets"})

	if !strings.Contains(result.Text, "child answer") {
		t.Fatalf("the parent did not get the child's answer: %q", result.Text)
	}
	if child.offered("subagent") {
		t.Error("the child was offered the delegating tool; it could recurse")
	}
	if !child.offered("read_file") {
		t.Error("the child was not offered the parent's ordinary tools")
	}
}

// TestTheChildStartsFromNothing pins the difference between spawn and fork: what
// the child receives is the task, and none of the parent's conversation.
func TestTheChildStartsFromNothing(t *testing.T) {
	child := &fakeModel{script: []model.ModelResponse{textResponse("ok")}}
	h := newHarness(t, child)

	h.parent.Append(map[string]any{"role": "user", "content": "the parent's secret plan"})
	h.call(t, map[string]any{"prompt": "a self-contained task"})

	if len(child.prompts) == 0 {
		t.Fatal("the child was never called")
	}
	sent := child.prompts[0]
	var texts []string
	for _, message := range sent {
		if text, ok := state.MessageText(message); ok {
			texts = append(texts, text)
		}
	}
	joined := strings.Join(texts, "\n")

	if strings.Contains(joined, "the parent's secret plan") {
		t.Error("the child was sent the parent's conversation; this is supposed to be spawn, not fork")
	}
	if !strings.Contains(joined, "a self-contained task") {
		t.Errorf("the child was not sent the task; it saw: %s", joined)
	}
	// The scope declaration has to travel with the task, because it is a property
	// of this agent and the child cannot discover it any other way.
	if !strings.Contains(joined, "子 agent") {
		t.Error("the child was not told it is a delegated agent with a fixed scope")
	}
	// The first message is the system prompt, and there is exactly one.
	if role, _ := sent[0]["role"].(string); role != "system" {
		t.Errorf("the child's first message is %q, not the system prompt", role)
	}
}

// TestTheChildGetsNoDeltaSink is the streaming guard.
//
// One delta sink belongs to the interface. A child writing into it would
// interleave two answers on screen, and the parent's own text would be lost.
func TestTheChildGetsNoDeltaSink(t *testing.T) {
	child := &fakeModel{script: []model.ModelResponse{textResponse("ok")}}
	h := newHarness(t, child)
	h.call(t, map[string]any{"prompt": "anything"})

	for index, options := range child.calls {
		if options.OnDelta != nil {
			t.Errorf("call %d handed the child a delta sink; the interface would show two answers at once", index)
		}
	}
}

// TestTheChildsEventsAreForwardedWithItsID is what lets a front end say "a
// subagent is running" instead of showing nothing until the answer appears.
func TestTheChildsEventsAreForwardedWithItsID(t *testing.T) {
	child := &fakeModel{script: []model.ModelResponse{textResponse("ok")}}
	h := newHarness(t, child)
	h.call(t, map[string]any{"prompt": "anything"})

	var forwarded int
	for _, record := range h.events {
		// The marker is the test's own subject, so the filter is on it rather than
		// on `subagent_id`: every delegation record carries that id, including the
		// parent's own two lifecycle lines and its tool result.
		if origin, _ := record[ChildOriginKey].(bool); !origin {
			continue
		}
		id, _ := record["subagent_id"].(string)
		forwarded++
		if !IsChildID(id) {
			t.Errorf("forwarded record carries %q, which is not a child id", id)
		}
		if !strings.HasPrefix(id, ChildID(h.parent.SessionID, 1)) {
			t.Errorf("forwarded record carries %q, which is not a child of this session", id)
		}
	}
	if forwarded == 0 {
		t.Error("no child event was forwarded to the parent's hook")
	}

	// The delegation's own two lines are on the parent's stream as well, and they
	// are **not** marked as a child's: they are the parent's record of having
	// delegated, and the parent's `tool_result` for the call carries the child's id
	// for correlation without being a child's record itself. Marking either would
	// drop the delegation's answer from the transcript.
	var started, finished bool
	for _, record := range h.events {
		if origin, _ := record[ChildOriginKey].(bool); origin {
			continue
		}
		switch record["kind"] {
		case KindDelegationStarted:
			started = true
		case KindDelegationFinished:
			finished = true
		}
	}
	if !started || !finished {
		t.Errorf("the delegation itself was not recorded on the parent's own stream (started=%v finished=%v)",
			started, finished)
	}
}

// TestTheChildsRouteIsReportedWhereTheFrontEndRuns is the regression for the line
// this used to write to stderr.
//
// The tool runs inside a runtime that a full-screen front end started as its child
// process, so the runtime's stderr **is** that interface's terminal: the line landed
// in the alternate screen and the next redraw erased it. It was therefore invisible
// rather than loud, which is the opposite of what a diagnostic is for. The fact
// still has to travel — the status bar shows the parent's route, not the child's —
// so it travels as an audit record the protocol layer turns into a notice.
func TestTheChildsRouteIsReportedWhereTheFrontEndRuns(t *testing.T) {
	child := &fakeModel{script: []model.ModelResponse{textResponse("ok")}}
	h := newHarness(t, child)

	h.call(t, map[string]any{"prompt": "anything"})

	var started map[string]any
	for _, record := range h.events {
		if record["kind"] == KindSubagentStarted {
			started = record
		}
	}
	if started == nil {
		t.Fatal("the child's route was never reported as a record")
	}
	// The parent's own record, not a child's: it is the tool reporting on the
	// delegation it just started, and a front end that saw it marked as a child's
	// would have to route it back through the delegation's own transcript.
	if origin, _ := started[ChildOriginKey].(bool); origin {
		t.Error("the route report came through the child's path; the parent's own account is what carries it")
	}
	if got, _ := started["subagent_id"].(string); !IsChildID(got) {
		t.Errorf("the route report names %q, which is not a child id", got)
	}
	if model, _ := started["model"].(string); model != "fake" {
		t.Errorf("the route report names model %q, want the resolved one", model)
	}
	if provider, _ := started["provider"].(string); provider != "test" {
		t.Errorf("the route report names provider %q, want the resolved one", provider)
	}
	// And nothing was written to the sink that goes to the terminal.
	if len(h.warnings) != 0 {
		t.Errorf("the delegation reported %d diagnostic(s) outside the record channel: %q",
			len(h.warnings), h.warnings)
	}
}

// TestAChildSessionThatCannotBeSavedIsRecorded is the other half of the same rule.
//
// `checkpointChild` used to answer a failed write with a stderr line, so the one
// failure a delegation can suffer that leaves **no other trace** was written where
// nobody could read it: the parent still receives the child's answer, so nothing on
// the parent's side says the child's transcript is gone.
func TestAChildSessionThatCannotBeSavedIsRecorded(t *testing.T) {
	child := &fakeModel{script: []model.ModelResponse{textResponse("ok")}}
	h := newHarness(t, child)

	// Sabotage the write the way a full disk would: the store's file for the child
	// cannot be created, because a directory is already sitting on its name.
	blocked := ChildID(h.parent.SessionID, 1)
	path, err := h.store.Path(blocked)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}

	result := h.call(t, map[string]any{"prompt": "anything"})
	if !strings.Contains(result.Text, "ok") {
		t.Fatalf("the parent did not get the answer anyway: %q", result.Text)
	}

	var problem map[string]any
	for _, record := range h.events {
		if record["kind"] == KindSubagentProblem {
			problem = record
		}
	}
	if problem == nil {
		t.Fatal("a child session that could not be saved was not recorded anywhere")
	}
	if id, _ := problem["subagent_id"].(string); id != blocked {
		t.Errorf("the problem record names %q, want %q", id, blocked)
	}
	if reason, _ := problem["reason"].(string); reason == "" {
		t.Error("the problem record does not say why the write failed")
	}
	if len(h.warnings) != 0 {
		t.Errorf("the failure went to the terminal instead of the record channel: %q", h.warnings)
	}
}

// TestTheChildsSessionIsWrittenDown is the property that makes a delegation
// auditable afterwards: the child's whole transcript is a session of its own,
// carrying the lineage and the resolved route.
func TestTheChildsSessionIsWrittenDown(t *testing.T) {
	child := &fakeModel{script: []model.ModelResponse{textResponse("child answer")}}
	h := newHarness(t, child)
	h.call(t, map[string]any{"prompt": "count the widgets", "description": "count widgets"})

	ids := h.store.ListIDs()
	if len(ids) != 1 {
		t.Fatalf("expected exactly one saved child session, got %v", ids)
	}
	childID := ids[0]
	if !IsChildID(childID) {
		t.Errorf("the saved session %q is not named as a child", childID)
	}
	saved, err := h.store.Load(childID)
	if err != nil {
		t.Fatalf("the child session does not load: %v", err)
	}
	if got := DepthOf(saved); got != 1 {
		t.Errorf("the child session records depth %d, want 1", got)
	}
	if got, _ := saved.Metadata[ParentKey].(string); got != h.parent.SessionID {
		t.Errorf("the child session records parent %v, want %q", saved.Metadata[ParentKey], h.parent.SessionID)
	}
	if got, _ := saved.Metadata[LabelKey].(string); got != "count widgets" {
		t.Errorf("the child session records label %v", saved.Metadata[LabelKey])
	}
	// The resolved route is recorded, so a transcript is never attributed to a
	// model that did not produce it.
	if selection, ok := state.LoadSelection(saved.Metadata); !ok || selection.Model != "fake" {
		t.Errorf("the child session does not record the route it ran on: %+v", saved.Metadata)
	}
	if saved.StepCount() == 0 {
		t.Error("the child session has no assistant messages; nothing was written down")
	}
}

// TestTheChildsUsageReachesTheParent covers the one number the parent cannot
// otherwise see: delegation moves token cost out of the parent's context, and the
// result has to say how much was moved.
func TestTheChildsUsageReachesTheParent(t *testing.T) {
	usage := &model.TokenUsage{PromptTokens: 1234, CachedTokens: 1000, CompletionTokens: 56}
	child := &fakeModel{script: []model.ModelResponse{
		{Content: strPtr("child answer"), Usage: usage},
	}}
	h := newHarness(t, child)

	result := h.call(t, map[string]any{"prompt": "count the widgets"})

	if !strings.Contains(result.Text, "1.2k") {
		t.Errorf("the result does not report the child's input tokens: %q", result.Text)
	}
	if !strings.Contains(result.Text, "56") {
		t.Errorf("the result does not report the child's output tokens: %q", result.Text)
	}
	if !strings.Contains(result.Text, "1 次模型调用") {
		t.Errorf("the result does not report the child's model calls: %q", result.Text)
	}
}

// TestAnEmptyPromptIsRefusedRatherThanDelegated is the failure that would
// otherwise cost a whole child context: a model that delegates a task it never
// described, and a child that has to guess.
func TestAnEmptyPromptIsRefusedRatherThanDelegated(t *testing.T) {
	child := &fakeModel{}
	h := newHarness(t, child)

	result := h.call(t, map[string]any{"prompt": "   "})

	if len(child.prompts) != 0 {
		t.Error("a child was started for an empty prompt")
	}
	if !strings.Contains(result.Text, "prompt") {
		t.Errorf("the refusal does not say what was wrong: %q", result.Text)
	}
	if len(h.store.ListIDs()) != 0 {
		t.Error("a session was created for a delegation that never ran")
	}
}

// TestDepthAtTheLimitIsRefusedWithTheNumber is the cap.
//
// The assertion on the number matters: "I cannot delegate" sends the parent
// looking for a missing tool, while "the limit is 3 and you are at 3" tells it to
// do the work itself.
func TestDepthAtTheLimitIsRefusedWithTheNumber(t *testing.T) {
	child := &fakeModel{}
	h := newHarness(t, child)

	// Put the parent itself at the limit, which is what a child at depth
	// MaxDepth-1 sees.
	h.parent.Metadata[DepthKey] = DefaultMaxDepth

	result := h.call(t, map[string]any{"prompt": "anything"})

	if len(child.prompts) != 0 {
		t.Error("a child was started past the depth limit")
	}
	if !strings.Contains(result.Text, "3") {
		t.Errorf("the refusal does not name the limit: %q", result.Text)
	}
}

// TestBuildReturnsNothingWhenDelegationIsOff pins the difference between "no
// tool" and "a tool that always refuses".
func TestBuildReturnsNothingWhenDelegationIsOff(t *testing.T) {
	for _, depth := range []int{0, -1} {
		if _, ok := Build(Config{Resolver: &fakeResolver{}, MaxDepth: depth}); ok {
			t.Errorf("Build returned a tool at MaxDepth %d", depth)
		}
	}
	// No resolver is the same shape of problem: the tool could be registered and
	// every call would fail, so it is not registered at all.
	if _, ok := Build(Config{MaxDepth: 3}); ok {
		t.Error("Build returned a tool with no route resolver; every call would fail")
	}
}

// TestARouteFailureDoesNotStartAChild keeps the cost where it belongs: a
// misconfigured route is one failed tool call, not a half-built agent.
func TestARouteFailureDoesNotStartAChild(t *testing.T) {
	child := &fakeModel{}
	h := newHarness(t, child)
	h.resolver.err = errNoRoute{}

	result := h.call(t, map[string]any{"prompt": "anything"})

	if len(child.prompts) != 0 {
		t.Error("a child was started on a route that could not be resolved")
	}
	if len(h.store.ListIDs()) != 0 {
		t.Error("a session was created for a delegation that never started")
	}
	if !strings.Contains(result.Text, "委派失败") {
		t.Errorf("the parent was not told the delegation failed: %q", result.Text)
	}
}

// TestADeniedToolInsideTheChildDoesNotAskTheUser is the permission decision.
//
// The child is built with no asker and autopilot **off**, so a call needing
// approval is refused. The test runs the whole loop with a medium-risk tool: if
// the child inherited the parent's asker the call would be put to a person, and if
// the gate were treated as "nobody to ask, so allow" (which is what this program's
// autopilot switch means) the handler would run. Neither may happen.
//
// The handler setting `ran` is the assertion that matters: a test that only
// inspected the audit could pass while the tool actually executed.
func TestADeniedToolInsideTheChildDoesNotAskTheUser(t *testing.T) {
	ran := false
	child := &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "needs_approval", `{"value":"x"}`),
		textResponse("I was not allowed to do that"),
	}}

	h := newHarness(t, child, tools.Tool{
		Name:        "needs_approval",
		Description: "a medium-risk tool",
		Risk:        security.RiskMedium,
		Schema:      tools.ObjectSchema(map[string]any{"value": tools.StringSchema("value")}, "value"),
		Handler: func(map[string]any) (tools.Result, error) {
			ran = true
			return tools.TextResult("ran"), nil
		},
	})

	result := h.call(t, map[string]any{"prompt": "do the thing that needs approval"})

	if ran {
		t.Error("the child ran a tool that needed approval; it has no authority of its own")
	}
	if !strings.Contains(result.Text, "I was not allowed") {
		t.Errorf("the parent did not get the child's report of the refusal: %q", result.Text)
	}

	// The refusal has to be recorded on the child's stream, otherwise "why did it
	// not do the obvious thing" has no answer afterwards. `no_asker` is the
	// expected outcome specifically: it says the gate refused because there was
	// nobody to ask, which is the fact a reader needs.
	var outcome string
	for _, record := range h.events {
		if record["kind"] != "permission" {
			continue
		}
		if name, _ := record["tool"].(string); name != "needs_approval" {
			continue
		}
		outcome, _ = record["outcome"].(string)
	}
	if outcome != security.OutcomeNoAsker {
		t.Errorf("the child's permission verdict was recorded as %q, want %q", outcome, security.OutcomeNoAsker)
	}
}

// TestTheChildsContextLedgerIsPersisted covers the part of a delegation that is
// invisible until it is too late.
//
// A tool result big enough to be stored becomes an artifact reference, and the
// reference is only meaningful if the child's own session file carries the ledger
// that names it. If the ledger reached the file only from the second checkpoint
// on, a delegation interrupted on its first step would come back with a
// transcript whose reads had silently vanished.
func TestTheChildsContextLedgerIsPersisted(t *testing.T) {
	body := strings.Repeat("widget inventory line\n", 400)
	child := &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "big_read", `{"path":"inventory.txt"}`),
		textResponse("there are four widgets"),
	}}

	h := newHarness(t, child, tools.Tool{
		Name:         "big_read",
		Description:  "read something large",
		Risk:         security.RiskLow,
		ParallelSafe: true,
		Schema:       tools.ObjectSchema(map[string]any{"path": tools.StringSchema("path")}, "path"),
		Handler: func(map[string]any) (tools.Result, error) {
			return tools.TextResult(body), nil
		},
	})

	h.call(t, map[string]any{"prompt": "read the inventory and count"})

	ids := h.store.ListIDs()
	if len(ids) != 1 {
		t.Fatalf("expected one saved child session, got %v", ids)
	}
	saved, err := h.store.Load(ids[0])
	if err != nil {
		t.Fatalf("the child session does not load: %v", err)
	}
	if saved.Context == nil {
		t.Fatal("the child session carries no context ledger; its artifact references point at nothing")
	}
	ledger, err := context.ContextStateFromJSON(saved.Context)
	if err != nil {
		t.Fatalf("the saved ledger does not decode: %v", err)
	}
	if len(ledger.Items) == 0 {
		t.Error("the ledger is empty, so nothing the child read is recoverable from its session")
	}
}

// TestTheResultNames the child so an interface can draw it under its call.
//
// The correlation an interface needs is already in the stream: the parent's
// `tool_call` carries the call id, and the matching `tool_result` carries whatever
// the tool put in its audit map. This asserts the second half exists, because
// without it the badge and the transcript cannot be connected at all.
func TestTheResultNamesTheChild(t *testing.T) {
	child := &fakeModel{script: []model.ModelResponse{textResponse("ok")}}
	h := newHarness(t, child)

	result := h.call(t, map[string]any{"prompt": "anything"})

	id, _ := result.Audit["subagent_id"].(string)
	if id == "" {
		t.Fatalf("the tool result carries no subagent_id, so nothing ties it to the child: %v", result.Audit)
	}
	if !IsChildID(id) {
		t.Errorf("subagent_id = %q, which is not a child id", id)
	}
	// It has to be the child that actually ran, not merely a plausible id.
	if ids := h.store.ListIDs(); len(ids) != 1 || ids[0] != id {
		t.Errorf("subagent_id = %q but the saved session is %v", id, h.store.ListIDs())
	}
}

// TestTheLabelIsNotCarriedOverFromThePreviousDelegation is the bug that made two
// tests fail only when they ran together.
//
// The label lives on the tool rather than in the arguments, so a model that
// describes one delegation and omits the description on the next would leave the
// second one wearing the first one's name — on the status bar and in the child's
// own session file, where it is the only human-readable clue about what that child
// was asked to do. A shared value that survives a call is a value that has to be
// cleared at the start of one.
func TestTheLabelIsNotCarriedOverFromThePreviousDelegation(t *testing.T) {
	child := &fakeModel{script: []model.ModelResponse{
		textResponse("first"), textResponse("second"),
	}}
	h := newHarness(t, child)

	h.call(t, map[string]any{"prompt": "the first task", "description": "count widgets"})
	h.call(t, map[string]any{"prompt": "the second task"})

	ids := h.store.ListIDs()
	if len(ids) != 2 {
		t.Fatalf("expected two saved child sessions, got %v", ids)
	}
	second, err := h.store.Load(ids[1])
	if err != nil {
		t.Fatal(err)
	}
	if label, present := second.Metadata[LabelKey]; present {
		t.Errorf("the second delegation inherited the first one's label: %v", label)
	}
}

// TestTheParentRouteIsTheDefault checks that a delegation with no route
// configured runs on the parent's own model and route.
func TestTheParentRouteIsTheDefault(t *testing.T) {
	child := &fakeModel{script: []model.ModelResponse{textResponse("ok")}}
	h := newHarness(t, child)

	h.call(t, map[string]any{"prompt": "anything"})

	if len(h.resolver.requested) != 1 {
		t.Fatalf("the resolver was asked %d times, want 1", len(h.resolver.requested))
	}
	route := h.resolver.requested[0]
	if route.Model != "" || route.Provider != "" {
		t.Errorf("the tool asked for an explicit route (%+v); the default is the parent's", route)
	}
	parent := h.resolver.parents[0]
	if parent[0] != "fake" || parent[1] != "test" {
		t.Errorf("the resolver was given the parent route %v, want [fake test]", parent)
	}
}

// errNoRoute is a resolver failure for the tests above.
type errNoRoute struct{}

func (errNoRoute) Error() string { return "no such route" }

func strPtr(text string) *string { return &text }
