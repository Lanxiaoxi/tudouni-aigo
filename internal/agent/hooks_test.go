package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/hooks"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// The integration tests use a **scripted** runner rather than real processes: what
// is under test here is placement — where the hook's answer lands, what the session
// contains afterwards, which call sees which arguments — and a real process would
// add wall time without making any of those questions better answered. The executor
// itself is covered in internal/hooks with real processes.
type fakeRunner struct {
	byEvent map[hooks.Event][]hooks.Result
	// envelopes records what was fired, so a test can ask which tool, which
	// arguments, and in what order.
	envelopes []hooks.Envelope
	// fire lets one test inspect state at the moment a hook runs.
	fire func(envelope hooks.Envelope) (hooks.Result, bool)
}

func (f *fakeRunner) Fire(_ context.Context, envelope hooks.Envelope) hooks.Result {
	f.envelopes = append(f.envelopes, envelope)
	if f.fire != nil {
		if result, handled := f.fire(envelope); handled {
			return result
		}
	}
	if list, present := f.byEvent[envelope.Event]; len(list) > 0 && present {
		result := list[0]
		f.byEvent[envelope.Event] = list[1:]
		return result
	}
	return hooks.Result{}
}

// Has is the agent's optional "is anybody listening" question, and answering it
// here is what makes the scripted runner behave like a real `*hooks.Set`: an event
// with nothing queued is an event nobody configured.
//
// Without it the agent would have to assume a test double listens to everything, and
// the assertions about *which* envelopes were fired would be about the double rather
// than about the call site.
func (f *fakeRunner) Has(event hooks.Event) bool {
	return len(f.byEvent[event]) > 0
}

// addHook puts a scripted answer in the queue for one event.
func (f *fakeRunner) addHook(event hooks.Event, results ...hooks.Result) {
	if f.byEvent == nil {
		f.byEvent = map[hooks.Event][]hooks.Result{}
	}
	f.byEvent[event] = append(f.byEvent[event], results...)
}

// hookHarness is a harness with a hook runner and its own context installed.
type hookHarness struct {
	*harness
	runner *fakeRunner
	tail   *hooks.Context
	stop   bool
	stops  []StopNotice
}

func newHookHarness(t *testing.T, chat model.ChatModel, ask security.AskFunc) *hookHarness {
	t.Helper()
	base := newHarness(t, chat, ask)
	h := &hookHarness{harness: base, runner: &fakeRunner{}, tail: &hooks.Context{}}
	base.agent.Hooks = h.runner
	base.agent.HookContext = h.tail
	base.agent.HookBase = hooks.Base{
		SessionID: base.session.SessionID,
		Workspace: "/workspace",
		Cwd:       "/workspace",
		Mode:      hooks.ModeInteractive,
	}
	base.agent.HookStop = func(notice StopNotice) bool {
		h.stops = append(h.stops, notice)
		return h.stop
	}
	return h
}

// lastPayload is the messages of the most recent request, flattened for assertions.
func (h *hookHarness) lastPayload() string {
	return flattenPayload(h.model().seen[len(h.model().seen)-1])
}

func flattenPayload(messages []map[string]any) string {
	var builder strings.Builder
	for _, message := range messages {
		if content, ok := message["content"].(string); ok {
			builder.WriteString(content)
			builder.WriteString("\n")
		}
	}
	return builder.String()
}

// overrideHandler replaces one tool's handler.
//
// A tool is a value in the registry, so mutating the copy `Get` returned would
// change nothing — the tool has to be taken out and put back. That is also why the
// tests can be sure the handler they observe is the one the agent calls.
func overrideHandler(t *testing.T, h *hookHarness, name string,
	handler func(context.Context, map[string]any) (tools.Result, error)) {
	t.Helper()
	tool, known := h.tools.Get(name)
	if !known {
		t.Fatalf("no tool named %s", name)
	}
	h.tools.Unregister(name)
	tool.Handler = handler
	if err := h.tools.Register(tool); err != nil {
		t.Fatalf("re-registering %s: %v", name, err)
	}
}

// --- pre_tool_use -----------------------------------------------------------

func TestAPreToolUseDenyStopsTheCallBeforeTheHandler(t *testing.T) {
	// The handler must not be entered at all: a guardrail that runs the thing it
	// refused is not a guardrail.
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "write_file", `{"path":"a.txt","content":"x"}`),
		textResponse("ok"),
	}}, security.AlwaysAllow)
	h.runner.addHook(hooks.EventPreToolUse, hooks.Result{
		Decision: hooks.DecisionDeny,
		Reason:   "hook 拒绝：no writes to a.txt（hook: no-writes）。不要重试同样的调用。",
		DeniedBy: "no-writes",
	})

	handled := false
	overrideHandler(t, h, "write_file", func(context.Context, map[string]any) (tools.Result, error) {
		handled = true
		return tools.TextResult("written"), nil
	})

	if _, err := h.agent.Run(context.Background(), "write it"); err != nil {
		t.Fatal(err)
	}
	if handled {
		t.Fatal("the handler ran for a call a hook had refused")
	}
	// The model is told, in the refusal text, which hook refused.
	toolMessages := toolTexts(h.session)
	if len(toolMessages) != 1 || !strings.Contains(toolMessages[0], "no-writes") {
		t.Fatalf("tool results = %#v, want the hook's sentence", toolMessages)
	}
	if !strings.Contains(toolMessages[0], "不要重试") {
		t.Fatalf("tool result = %q, want the do-not-retry instruction", toolMessages[0])
	}
}

func TestAPreToolUseAskForcesTheQuestion(t *testing.T) {
	// `ask` from a hook has to reach a person even where the policy would have
	// released the call: that is the whole point of a guardrail being more specific
	// than a risk level.
	asked := 0
	ask := func(string, security.RiskLevel, map[string]any) bool {
		asked++
		return true
	}
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "read_file", `{"path":"a.txt"}`),
		textResponse("ok"),
	}}, ask)
	h.runner.addHook(hooks.EventPreToolUse, hooks.Result{
		Decision: hooks.DecisionAsk, Reason: "check", Ask: "checker",
	})

	if _, err := h.agent.Run(context.Background(), "read it"); err != nil {
		t.Fatal(err)
	}
	if asked != 1 {
		t.Fatalf("asked = %d, want the person asked once", asked)
	}
	if outcome := permissionOutcome(h.events); outcome != security.OutcomeHookForcedAsk {
		t.Fatalf("outcome = %q, want %q", outcome, security.OutcomeHookForcedAsk)
	}
}

func TestAPreToolUseAskInAutopilotIsARefusal(t *testing.T) {
	// Autopilot's definition is "there is nobody to ask", so an `ask` there is the
	// same fail-closed answer a missing asker already gets.
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "read_file", `{"path":"a.txt"}`),
		textResponse("ok"),
	}}, security.AlwaysAllow)
	h.agent.SetAutopilot(true)
	h.runner.addHook(hooks.EventPreToolUse, hooks.Result{
		Decision: hooks.DecisionAsk, Reason: "check", Ask: "checker",
	})

	if _, err := h.agent.Run(context.Background(), "read it"); err != nil {
		t.Fatal(err)
	}
	if outcome := permissionOutcome(h.events); outcome != security.OutcomeHookNoAsker {
		t.Fatalf("outcome = %q, want %q", outcome, security.OutcomeHookNoAsker)
	}
	// And the hook's own envelope says the mode, because that is what a script
	// branches on to decide whether asking is even possible.
	if mode := h.runner.envelopes[0].Mode; mode != hooks.ModeAutopilot {
		t.Fatalf("mode = %q, want autopilot", mode)
	}
}

func TestAHookAllowOnlySkipsTheQuestion(t *testing.T) {
	asked := 0
	ask := func(string, security.RiskLevel, map[string]any) bool {
		asked++
		return false
	}
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "write_file", `{"path":"a.txt","content":"x"}`),
		textResponse("ok"),
	}}, ask)
	h.runner.addHook(hooks.EventPreToolUse, hooks.Result{Decision: hooks.DecisionAllow})

	if _, err := h.agent.Run(context.Background(), "write it"); err != nil {
		t.Fatal(err)
	}
	if asked != 0 {
		t.Fatalf("asked = %d, want nobody asked", asked)
	}
	if outcome := permissionOutcome(h.events); outcome != security.OutcomeHookAllowed {
		t.Fatalf("outcome = %q, want %q", outcome, security.OutcomeHookAllowed)
	}
}

func TestAPolicyDenyBeatsAHookAllow(t *testing.T) {
	// "May not" is not "need not ask". This is the first row of the priority table
	// and the one a hook must never be able to overrule.
	handled := false
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "write_file", `{"path":"a.txt","content":"x"}`),
		textResponse("ok"),
	}}, security.AlwaysAllow)
	h.agent.Policy = security.Policy{DenyTools: []string{"write_file"}, AutoApprove: []string{"low"}}
	h.runner.addHook(hooks.EventPreToolUse, hooks.Result{Decision: hooks.DecisionAllow})

	overrideHandler(t, h, "write_file", func(context.Context, map[string]any) (tools.Result, error) {
		handled = true
		return tools.TextResult("written"), nil
	})

	if _, err := h.agent.Run(context.Background(), "write it"); err != nil {
		t.Fatal(err)
	}
	if handled {
		t.Fatal("a hook's allow overrode the policy's deny")
	}
	if outcome := permissionOutcome(h.events); outcome != security.OutcomePolicyDenied {
		t.Fatalf("outcome = %q, want policy_denied", outcome)
	}
}

// --- updated_input ---------------------------------------------------------

func TestARewriteReachesTheHandler(t *testing.T) {
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "write_file", `{"path":"a.txt","content":"npm install"}`),
		textResponse("ok"),
	}}, security.AlwaysAllow)
	h.runner.addHook(hooks.EventPreToolUse, hooks.Result{
		Rewritten: true,
		Updated:   map[string]any{"content": "pnpm install"},
	})

	var seen map[string]any
	overrideHandler(t, h, "write_file", func(_ context.Context, arguments map[string]any) (tools.Result, error) {
		seen = arguments
		return tools.TextResult("written"), nil
	})

	if _, err := h.agent.Run(context.Background(), "write it"); err != nil {
		t.Fatal(err)
	}
	if seen["content"] != "pnpm install" {
		t.Fatalf("handler saw %v, want the rewritten arguments", seen["content"])
	}
	if seen["path"] != "a.txt" {
		t.Fatalf("handler saw %v, want the untouched key kept", seen["path"])
	}
	// And the audit says the input was rewritten, with previews rather than bodies.
	if !hasEventField(h.events, "updated_input", true) {
		t.Fatalf("no hook_result recorded the rewrite: %#v", hookRecords(h.events))
	}
}

func TestARewriteThatDoesNotValidateIsInvalidArguments(t *testing.T) {
	// Falling back to the model's original would run something the model did not ask
	// for while the model believed its edit had been applied — the worst of both.
	handled := false
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "write_file", `{"path":"a.txt","content":"x"}`),
		textResponse("ok"),
	}}, security.AlwaysAllow)
	h.runner.addHook(hooks.EventPreToolUse, hooks.Result{
		Rewritten: true,
		// `path` is required and has a min length; deleting it makes the call
		// unrunnable.
		Updated: map[string]any{"path": nil},
	})

	overrideHandler(t, h, "write_file", func(context.Context, map[string]any) (tools.Result, error) {
		handled = true
		return tools.TextResult("written"), nil
	})

	if _, err := h.agent.Run(context.Background(), "write it"); err != nil {
		t.Fatal(err)
	}
	if handled {
		t.Fatal("a call whose rewritten arguments are invalid was run anyway")
	}
	toolMessages := toolTexts(h.session)
	if len(toolMessages) != 1 || !strings.Contains(toolMessages[0], "hook 改写后的参数不合法") {
		t.Fatalf("tool results = %#v, want the rewrite named as the cause", toolMessages)
	}
}

func TestNobodyElseInTheChainSeesTheOriginalArguments(t *testing.T) {
	// Two rewriters compose: the second hook sees what the first one left.
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "write_file", `{"path":"a.txt","content":"one"}`),
		textResponse("ok"),
	}}, security.AlwaysAllow)
	// Two answers queued for one event: the runner is called once by the agent and
	// the scripted fake returns them in order — which is what a chain of two hooks
	// produces.
	h.runner.addHook(hooks.EventPreToolUse,
		hooks.Result{Rewritten: true, Updated: map[string]any{"content": "two"}},
		hooks.Result{})

	if _, err := h.agent.Run(context.Background(), "write it"); err != nil {
		t.Fatal(err)
	}
	// One envelope per batch: the agent fires the chain once and the chain composes
	// internally, so the second hook's view is exercised in internal/hooks (where
	// there are real processes). What this asserts is that the agent fires **once**
	// for one call.
	if len(h.runner.envelopes) != 1 {
		t.Fatalf("envelopes = %d, want one per call", len(h.runner.envelopes))
	}
	if h.runner.envelopes[0].Tool.Input["content"] != "one" {
		t.Fatalf("the chain was handed %v, want the model's own arguments",
			h.runner.envelopes[0].Tool.Input)
	}
}

// --- post_tool_use ---------------------------------------------------------

func TestPostToolUseContextReachesTheNextRequestOnly(t *testing.T) {
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "read_file", `{"path":"a.txt"}`),
		textResponse("done"),
	}}, security.AlwaysAllow)
	h.runner.addHook(hooks.EventPostToolUse, hooks.Result{
		Parts:   []hooks.Part{{Hook: "pnpm-guard", Event: hooks.EventPostToolUse, Text: "The repository uses pnpm; do not run npm install."}},
		Context: "<hook_context>…</hook_context>",
	})

	before := h.session.MessageCount()
	if _, err := h.agent.Run(context.Background(), "read it"); err != nil {
		t.Fatal(err)
	}

	// The first request (the one that produced the tool call) cannot carry it: the
	// batch had not settled yet.
	first := flattenPayload(h.model().seen[0])
	if strings.Contains(first, "pnpm") {
		t.Fatalf("the note was in the request that preceded it: %q", first)
	}
	// The second one can — and does, in the tail.
	second := flattenPayload(h.model().seen[1])
	if !strings.Contains(second, "The repository uses pnpm") {
		t.Fatalf("the note did not reach the next request: %q", second)
	}
	if !strings.Contains(second, `hook="pnpm-guard"`) {
		t.Fatalf("the note lost its source tag: %q", second)
	}

	// The session is unchanged by it: the history holds what happened, and a note
	// that entered it would make the file a record of something nobody said.
	if strings.Contains(flattenPayload(h.session.MessagesSnapshot()), "pnpm") {
		t.Fatal("the note entered the session")
	}
	if h.session.MessageCount() <= before {
		t.Fatal("the turn wrote nothing at all, so the check above is vacuous")
	}
}

func TestTheBatchContextIsReplacedByTheNextBatch(t *testing.T) {
	// Two tool-calling steps: the first batch's note must not still be there when
	// the second batch's request goes out.
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "read_file", `{"path":"a.txt"}`),
		toolCallResponse("c2", "read_file", `{"path":"b.txt"}`),
		textResponse("done"),
	}}, security.AlwaysAllow)
	h.runner.addHook(hooks.EventPostToolUse,
		hooks.Result{Parts: []hooks.Part{{Hook: "first", Event: hooks.EventPostToolUse, Text: "NOTE-ONE"}}},
		hooks.Result{Parts: []hooks.Part{{Hook: "second", Event: hooks.EventPostToolUse, Text: "NOTE-TWO"}}})

	if _, err := h.agent.Run(context.Background(), "read both"); err != nil {
		t.Fatal(err)
	}
	third := flattenPayload(h.model().seen[2])
	if !strings.Contains(third, "NOTE-TWO") {
		t.Fatalf("the second batch's note is missing: %q", third)
	}
	if strings.Contains(third, "NOTE-ONE") {
		t.Fatalf("the first batch's note survived: %q", third)
	}
}

func TestPostToolUseHookSeesTheSettledResult(t *testing.T) {
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "read_file", `{"path":"a.txt"}`),
		textResponse("done"),
	}}, security.AlwaysAllow)
	// A no-op answer: the hook is configured, so it runs, and what it says is not the
	// subject of this test — the envelope is.
	h.runner.addHook(hooks.EventPostToolUse, hooks.Result{})

	if _, err := h.agent.Run(context.Background(), "read it"); err != nil {
		t.Fatal(err)
	}
	var envelope *hooks.Envelope
	for index := range h.runner.envelopes {
		if h.runner.envelopes[index].Event == hooks.EventPostToolUse {
			envelope = &h.runner.envelopes[index]
		}
	}
	if envelope == nil {
		t.Fatal("no post_tool_use was fired")
	}
	if envelope.Tool.Status != statusOK {
		t.Fatalf("status = %q, want the settled status", envelope.Tool.Status)
	}
	if envelope.Tool.Result != "contents" {
		t.Fatalf("result = %q, want the handler's text", envelope.Tool.Result)
	}
	if envelope.Tool.CallID != "c1" {
		t.Fatalf("call id = %q", envelope.Tool.CallID)
	}
}

// --- stop ------------------------------------------------------------------

func TestAStopBlockContinuesTheTurn(t *testing.T) {
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		textResponse("first answer"),
		textResponse("second answer"),
	}}, security.AlwaysAllow)
	// One block, then agreement.
	h.stop = true
	blocks := 0
	h.agent.HookStop = func(notice StopNotice) bool {
		blocks++
		h.stops = append(h.stops, notice)
		return blocks == 1
	}

	answer, err := h.agent.Run(context.Background(), "do it")
	if err != nil {
		t.Fatal(err)
	}
	if answer != "second answer" {
		t.Fatalf("answer = %q, want the continuation's answer", answer)
	}
	if len(h.stops) != 2 {
		t.Fatalf("stop hooks = %d, want two (one block, one agreement)", len(h.stops))
	}
	if h.stops[0].LastAssistantMessage != "first answer" {
		t.Fatalf("the hook was told %q, want the answer it is judging", h.stops[0].LastAssistantMessage)
	}
	// Both answers are in history: the continuation adds a message, it does not
	// retract one.
	if texts := assistantTexts(h.session); len(texts) != 2 {
		t.Fatalf("assistant messages = %v, want both answers kept", texts)
	}
	// The model was told why it is still running, in the request tail.
	second := flattenPayload(h.model().seen[1])
	if !strings.Contains(second, "stop hook 要求继续") {
		t.Fatalf("the continuation note is missing: %q", second)
	}
}

func TestTheStopBlockBudgetIsBounded(t *testing.T) {
	// A hook that always says "continue" must not be able to keep one turn alive for
	// ever — and the bound is per turn, so the next turn gets its own.
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		textResponse("a"), textResponse("b"), textResponse("c"), textResponse("d"),
		textResponse("e"), textResponse("f"), textResponse("g"),
	}}, security.AlwaysAllow)
	h.stop = true
	blocks := 0
	h.agent.HookStop = func(StopNotice) bool {
		blocks++
		return true
	}

	if _, err := h.agent.Run(context.Background(), "go"); err != nil {
		t.Fatal(err)
	}
	if blocks != maxStopBlocks {
		t.Fatalf("stop hooks = %d, want exactly %d", blocks, maxStopBlocks)
	}
}

func TestAnAutonomousRoundIgnoresTheBlock(t *testing.T) {
	// Continuing a goal belongs to the driver; two sources of "continue" would
	// disagree about the round budget. The request is still made, and the answer is
	// overruled — which is what lets the runtime record that it happened.
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		textResponse("a"), textResponse("b"),
	}}, security.AlwaysAllow)
	h.agent.HookStop = func(notice StopNotice) bool {
		if !notice.Autonomous {
			t.Error("the hook was not told this was an automatic round")
		}
		return false
	}

	// The round's opening message **is** the goal prompt — that is how a round enters
	// history (see `Runtime.StartGoalRound`), and it is what lets the session answer
	// "who started this turn" afterwards. A plain `Run` would append a person's
	// message after it, and the turn would then correctly read as human.
	round := []map[string]any{{
		"role": "user", "content": "<goal_round>…</goal_round>",
		state.RuntimeNoteKey: true, state.GoalRoundKey: true,
	}}
	if _, err := h.agent.RunMessages(context.Background(), round); err != nil {
		t.Fatal(err)
	}
	// The loop's own decision is what ends it: `continueTurn` is offered the chance,
	// the runtime answers "no", and one model call happened.
	if texts := assistantTexts(h.session); len(texts) != 1 {
		t.Fatalf("assistant messages = %v, want the turn to have ended", texts)
	}
}

// --- the tail --------------------------------------------------------------

func TestHookContextSitsAtTheVeryEndOfTheTail(t *testing.T) {
	// Position is a rule, not a preference: the tail is outside the cached prefix,
	// and the last thing in it is the closest to the token being generated.
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		textResponse("ok"),
	}}, security.AlwaysAllow)
	h.agent.Notes = func() string { return "SOME-NOTE" }
	h.tail.AddTurn("guard", hooks.EventUserPromptSubmit, "FROM-THE-HOOK")

	if _, err := h.agent.Run(context.Background(), "hi"); err != nil {
		t.Fatal(err)
	}
	payload := flattenPayload(h.model().seen[0])
	noteIndex := strings.Index(payload, "SOME-NOTE")
	hookIndex := strings.Index(payload, "FROM-THE-HOOK")
	if noteIndex < 0 || hookIndex < 0 {
		t.Fatalf("payload = %q, want both parts", payload)
	}
	if hookIndex < noteIndex {
		t.Fatalf("the hook context came before the note: %q", payload)
	}
}

// --- the guardrail guard ---------------------------------------------------

func TestAWriteToTheHooksFileIsRefused(t *testing.T) {
	// §7.3: the model must not be able to rewrite its own guardrail. The check is on
	// the file tools by name, and `write_file` is the one that would do it.
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "write_file", `{"path":"hooks.json","content":"{}"}`),
		textResponse("ok"),
	}}, security.AlwaysAllow)
	root := t.TempDir()
	guarded := filepath.Join(root, "hooks.json")
	if err := os.WriteFile(guarded, []byte(`{"version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	h.agent.GuardrailPaths = []string{guarded}
	h.agent.GuardrailRoot = root

	handled := false
	overrideHandler(t, h, "write_file", func(context.Context, map[string]any) (tools.Result, error) {
		handled = true
		return tools.TextResult("written"), nil
	})

	if _, err := h.agent.Run(context.Background(), "rewrite the guardrail"); err != nil {
		t.Fatal(err)
	}
	if handled {
		t.Fatal("the guardrail file was written")
	}
	results := toolTexts(h.session)
	if len(results) != 1 || !strings.Contains(results[0], "guardrail") {
		t.Fatalf("tool results = %#v, want the refusal to say why", results)
	}
}

func TestAGuardrailPathIsComparedThroughDotDot(t *testing.T) {
	// A rule written against a string is one `..` or one symlink away from being
	// useless, so the comparison resolves first.
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "write_file", `{"path":"sub/../hooks.json","content":"{}"}`),
		textResponse("ok"),
	}}, security.AlwaysAllow)
	root := t.TempDir()
	guarded := filepath.Join(root, "hooks.json")
	if err := os.WriteFile(guarded, []byte(`{"version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	h.agent.GuardrailPaths = []string{guarded}
	h.agent.GuardrailRoot = root

	handled := false
	overrideHandler(t, h, "write_file", func(context.Context, map[string]any) (tools.Result, error) {
		handled = true
		return tools.TextResult("written"), nil
	})
	if _, err := h.agent.Run(context.Background(), "go"); err != nil {
		t.Fatal(err)
	}
	if handled {
		t.Fatal("a path spelled through `..` got around the guard")
	}
}

func TestTheGuardDoesNotRefuseOrdinaryFiles(t *testing.T) {
	// A guard that refuses more than it should is worse than none: it would make the
	// session unable to write anything.
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "write_file", `{"path":"src/main.go","content":"package main"}`),
		textResponse("ok"),
	}}, security.AlwaysAllow)
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "hooks.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	h.agent.GuardrailPaths = []string{filepath.Join(root, "hooks.json")}
	h.agent.GuardrailRoot = root

	handled := false
	overrideHandler(t, h, "write_file", func(context.Context, map[string]any) (tools.Result, error) {
		handled = true
		return tools.TextResult("written"), nil
	})
	if _, err := h.agent.Run(context.Background(), "go"); err != nil {
		t.Fatal(err)
	}
	if !handled {
		t.Fatalf("an ordinary file was refused: %#v", toolTexts(h.session))
	}
}

func TestTheGuardIgnoresShell(t *testing.T) {
	// Stated as a test because it is a documented limit rather than an oversight: a
	// shell command that mentions the path is **not** refused, because deciding
	// whether it writes the file means parsing a shell.
	h := newHookHarness(t, &fakeModel{script: []model.ModelResponse{
		toolCallResponse("c1", "write_file", `{"path":"notes.txt","content":"x"}`),
		textResponse("ok"),
	}}, security.AlwaysAllow)
	h.agent.GuardrailPaths = []string{filepath.Join(t.TempDir(), "hooks.json")}
	if refusal := h.agent.guardrailRefusal(&prepared{
		call:      model.ToolCall{Name: "shell"},
		tool:      tools.Tool{Name: "shell"},
		arguments: map[string]any{"command": "echo {} > hooks.json"},
	}); refusal != "" {
		t.Fatalf("a shell command was refused: %q", refusal)
	}
}

// --- helpers ---------------------------------------------------------------

func (h *hookHarness) model() *fakeModel {
	return h.harness.chat().(*fakeModel)
}

// chat reaches the harness's model through the agent's Config.
func (h *harness) chat() model.ChatModel { return h.agent.Chat }

// toolTexts returns the text of every tool message in the session.
func toolTexts(session *state.Session) []string {
	var out []string
	for _, message := range session.MessagesSnapshot() {
		if message["role"] != "tool" {
			continue
		}
		if text, ok := message["content"].(string); ok {
			out = append(out, text)
		}
	}
	return out
}

// assistantTexts returns the text of every assistant message with content.
func assistantTexts(session *state.Session) []string {
	var out []string
	for _, message := range session.MessagesSnapshot() {
		if message["role"] != "assistant" {
			continue
		}
		if text, ok := message["content"].(string); ok && strings.TrimSpace(text) != "" {
			out = append(out, text)
		}
	}
	return out
}

// permissionOutcome is the `outcome` of the last permission event.
func permissionOutcome(events []map[string]any) string {
	for index := len(events) - 1; index >= 0; index-- {
		if events[index]["kind"] != "permission" {
			continue
		}
		outcome, _ := events[index]["outcome"].(string)
		return outcome
	}
	return ""
}

// hookRecords are the `hook_result` events, in order.
func hookRecords(events []map[string]any) []map[string]any {
	var out []map[string]any
	for _, event := range events {
		if event["kind"] == "hook_result" {
			out = append(out, event)
		}
	}
	return out
}

// hasEventField asks whether any event of any kind carries this field with this
// value. It is the shape the rewrite check needs: the record's kind is
// `hook_result` and its meaning is the field.
func hasEventField(events []map[string]any, field string, value any) bool {
	for _, event := range events {
		if got, present := event[field]; present && got == value {
			return true
		}
	}
	return false
}
