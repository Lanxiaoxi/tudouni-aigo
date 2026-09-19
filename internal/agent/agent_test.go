package agent

import (
	"errors"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// fakeModel plays a scripted sequence of responses.
//
// It is a script rather than a simulation because the tests here are about what the
// loop does with a given answer — a real model would make them flaky and would not
// make them stronger.
type fakeModel struct {
	script    []model.ModelResponse
	errs      []error
	calls     int
	switched  bool
	installed bool
	thinking  bool
	effort    string
	// seen records the messages of every request, so a test can ask what actually
	// went out — the payload is not the history, and the difference is the point
	// of several rules (the trailing note, the nudge).
	seen [][]map[string]any
}

func (f *fakeModel) Complete(messages []map[string]any, toolSchemas []map[string]any,
	options model.CompleteOptions) (model.ModelResponse, error) {
	copied := make([]map[string]any, len(messages))
	copy(copied, messages)
	f.seen = append(f.seen, copied)
	index := f.calls
	f.calls++
	if index < len(f.errs) && f.errs[index] != nil {
		return model.ModelResponse{}, f.errs[index]
	}
	if index < len(f.script) {
		return f.script[index], nil
	}
	text := "done"
	return model.ModelResponse{Content: &text}, nil
}

func (f *fakeModel) SwitchModel(name string) bool { f.switched = true; return true }

// Install is the route change. The fake records it separately from SwitchModel so
// a test can tell "the model was renamed" from "the key and the endpoint moved",
// which are different capabilities with different costs.
func (f *fakeModel) Install(route model.Route) bool {
	f.installed = true
	return true
}

func (f *fakeModel) SetReasoning(thinking bool, effort string) {
	f.thinking, f.effort = thinking, effort
}

func (f *fakeModel) ModelName() string { return "fake" }

func (f *fakeModel) ProviderName() string { return "test" }

func (f *fakeModel) BaseURL() string { return "http://localhost" }

func (f *fakeModel) Route() model.Route { return model.Route{Name: "test"} }

func (f *fakeModel) SameEndpoint(model.Route) bool { return true }

// harness is one assembled agent plus what the tests need to inspect.
type harness struct {
	agent   *Agent
	session *state.Session
	events  []map[string]any
	saves   int
	tools   *tools.Registry
	// eventHook lets a test watch the event stream in real time. The buffer above
	// can only be read after the turn, which is not good enough for a question
	// about **ordering** — "how many results had been emitted by the time this
	// approval happened" is exactly that kind of question.
	eventHook func(record map[string]any)
}

func newHarness(t *testing.T, chat model.ChatModel, ask security.AskFunc) *harness {
	t.Helper()

	registry := tools.NewRegistry()
	writeTool := tools.Tool{
		Name:        "write_file",
		Description: "write",
		Risk:        security.RiskMedium,
		Schema: tools.ObjectSchema(map[string]any{
			"path":    tools.StringSchema("path", tools.MinLength(1)),
			"content": tools.StringSchema("content"),
		}, "path", "content"),
		Handler: func(arguments map[string]any) (tools.Result, error) {
			return tools.TextResult("Written: " + arguments["path"].(string)), nil
		},
	}
	if err := registry.Register(writeTool); err != nil {
		t.Fatal(err)
	}
	editTool := tools.Tool{
		Name:        "edit_file",
		Description: "edit",
		Risk:        security.RiskMedium,
		Schema: tools.ObjectSchema(map[string]any{
			"path":       tools.StringSchema("path", tools.MinLength(1)),
			"old_string": tools.StringSchema("old"),
			"new_string": tools.StringSchema("new"),
		}, "path", "old_string", "new_string"),
		Handler: func(arguments map[string]any) (tools.Result, error) {
			return tools.TextResult("edited"), nil
		},
	}
	if err := registry.Register(editTool); err != nil {
		t.Fatal(err)
	}
	readTool := tools.Tool{
		Name:         "read_file",
		Description:  "read",
		Risk:         security.RiskLow,
		ParallelSafe: true,
		Schema: tools.ObjectSchema(map[string]any{
			"path": tools.StringSchema("path", tools.MinLength(1)),
		}, "path"),
		Handler: func(arguments map[string]any) (tools.Result, error) {
			return tools.TextResult("contents"), nil
		},
	}
	if err := registry.Register(readTool); err != nil {
		t.Fatal(err)
	}

	session := state.NewSession("test-session", t.TempDir())
	h := &harness{session: session, tools: registry}

	h.agent = New(Config{
		Chat:     chat,
		Tools:    registry,
		Policy:   security.NewPolicy(),
		Ask:      ask,
		Session:  session,
		MaxSteps: 4,
		OnCheckpoint: func() {
			h.saves++
			h.checkConsistency(t)
		},
		OnEvent: func(record map[string]any) {
			h.events = append(h.events, record)
			if h.eventHook != nil {
				h.eventHook(record)
			}
		},
	})
	return h
}

// checkConsistency enforces the one invariant that cannot be repaired later: every
// assistant message carrying tool_calls is followed by a result for each id.
//
// A violation makes the session permanently unsendable — the endpoint answers 400
// for every later turn and the error reads like "the context is too long".
func (h *harness) checkConsistency(t *testing.T) {
	t.Helper()
	pending := map[string]bool{}
	for _, message := range h.session.Messages {
		role, _ := message["role"].(string)
		switch role {
		case "assistant":
			if pendingCount := len(pending); pendingCount > 0 {
				t.Fatalf("a checkpoint saw an assistant message before all tool results arrived: %v", pending)
			}
			calls, _ := message["tool_calls"].([]any)
			for _, item := range calls {
				call, _ := item.(map[string]any)
				id, _ := call["id"].(string)
				pending[id] = true
			}
		case "tool":
			id, _ := message["tool_call_id"].(string)
			delete(pending, id)
		}
	}
}

func toolCallResponse(id, name, arguments string) model.ModelResponse {
	return model.ModelResponse{ToolCalls: []model.ToolCall{{ID: id, Name: name, Arguments: arguments}}}
}

func textResponse(text string) model.ModelResponse { return model.ModelResponse{Content: &text} }

// reasoningOnlyResponse is the failure this guard exists for: a step that
// produced thinking and nothing else. `Content` stays nil — the pointer being
// nil, not an empty string, is what a gateway sends when it answers with
// `content: null`.
func reasoningOnlyResponse(reasoning string) model.ModelResponse {
	return model.ModelResponse{Reasoning: &reasoning}
}

// TestReasoningOnlyStepIsNudgedBack — a step with no content and no tool call is
// not an answer. The turn asks once more, and the second attempt's answer is the
// turn's answer.
func TestReasoningOnlyStepIsNudgedBack(t *testing.T) {
	chat := &fakeModel{script: []model.ModelResponse{
		reasoningOnlyResponse("thinking hard about it"),
		textResponse("here it is"),
	}}
	h := newHarness(t, chat, security.AlwaysAllow)

	answer, err := h.agent.Run("hi")
	if err != nil {
		t.Fatalf("a nudged turn must not fail: %v", err)
	}
	if answer != "here it is" {
		t.Fatalf("answer = %q, want the second attempt's text", answer)
	}
	if chat.calls != 2 {
		t.Fatalf("model calls = %d, want 2 (the empty step plus the retry)", chat.calls)
	}
	if reason := lastStopReason(h.events); reason != StopAnswered {
		t.Fatalf("stop_reason = %q, want %q", reason, StopAnswered)
	}
}

// TestReasoningOnlyStepIsNotPersisted — the empty reply must not enter history.
//
// An assistant message with `content: null` and no tool call is a turn that never
// happened: replayed into every later request it is noise, and it makes the
// session file claim the model said something.
func TestReasoningOnlyStepIsNotPersisted(t *testing.T) {
	chat := &fakeModel{script: []model.ModelResponse{
		reasoningOnlyResponse("thinking hard about it"),
		textResponse("here it is"),
	}}
	h := newHarness(t, chat, security.AlwaysAllow)

	if _, err := h.agent.Run("hi"); err != nil {
		t.Fatal(err)
	}
	for _, message := range h.session.Messages {
		if message["role"] != "assistant" {
			continue
		}
		if content, _ := message["content"].(string); strings.TrimSpace(content) == "" {
			t.Fatalf("an empty assistant message reached the session: %#v", message)
		}
	}
}

// TestEmptyTurnIsNotAnswered — when the second attempt is empty too, the turn
// ends as its own outcome. "Answered" over a blank screen is the report this
// exists to prevent, and the error carries it in words as well as in the enum.
func TestEmptyTurnIsNotAnswered(t *testing.T) {
	chat := &fakeModel{script: []model.ModelResponse{
		reasoningOnlyResponse("thinking, attempt one"),
		reasoningOnlyResponse("thinking, attempt two"),
	}}
	h := newHarness(t, chat, security.AlwaysAllow)

	answer, err := h.agent.Run("hi")
	if err == nil {
		t.Fatal("an empty turn must report an error, not an empty answer")
	}
	var empty *EmptyResponse
	if !errors.As(err, &empty) {
		t.Fatalf("error = %#v, want *EmptyResponse", err)
	}
	if answer != "" {
		t.Fatalf("answer = %q, want empty", answer)
	}
	if reason := lastStopReason(h.events); reason != StopEmptyResponse {
		t.Fatalf("stop_reason = %q, want %q", reason, StopEmptyResponse)
	}
	if chat.calls != 2 {
		t.Fatalf("model calls = %d, want 2 (one nudge, then stop)", chat.calls)
	}
}

// TestNudgeRidesThePayloadOnly — the nudge is a fact about this request, so it
// goes out with it and never enters the conversation.
func TestNudgeRidesThePayloadOnly(t *testing.T) {
	chat := &fakeModel{script: []model.ModelResponse{
		reasoningOnlyResponse("thinking"),
		textResponse("answer"),
	}}
	h := newHarness(t, chat, security.AlwaysAllow)

	if _, err := h.agent.Run("hi"); err != nil {
		t.Fatal(err)
	}
	for _, message := range h.session.Messages {
		if content, _ := message["content"].(string); strings.Contains(content, "用户看不到思考过程") {
			t.Fatalf("the nudge was written into history: %#v", message)
		}
	}
	if len(chat.seen) != 2 {
		t.Fatalf("requests seen = %d, want 2", len(chat.seen))
	}
	if payloadMentions(chat.seen[0], "用户看不到思考过程") {
		t.Error("the first request already carried the nudge")
	}
	if !payloadMentions(chat.seen[1], "用户看不到思考过程") {
		t.Error("the retry did not carry the nudge: the model is never told that nothing was visible")
	}
}

// payloadMentions reports whether any message of a request carries the text.
func payloadMentions(messages []map[string]any, text string) bool {
	for _, message := range messages {
		if content, ok := message["content"].(string); ok && strings.Contains(content, text) {
			return true
		}
	}
	return false
}

func TestAnsweredTurn(t *testing.T) {
	chat := &fakeModel{script: []model.ModelResponse{textResponse("hello")}}
	h := newHarness(t, chat, security.AlwaysAllow)

	answer, err := h.agent.Run("hi")
	if err != nil {
		t.Fatal(err)
	}
	if answer != "hello" {
		t.Fatalf("answer = %q, want hello", answer)
	}
	if h.saves == 0 {
		t.Fatal("the session was never checkpointed")
	}
	if reason := lastStopReason(h.events); reason != StopAnswered {
		t.Fatalf("stop_reason = %q, want %q", reason, StopAnswered)
	}
}

func TestToolCallThenAnswer(t *testing.T) {
	chat := &fakeModel{script: []model.ModelResponse{
		toolCallResponse("call_1", "read_file", `{"path":"a.txt"}`),
		textResponse("read it"),
	}}
	h := newHarness(t, chat, security.AlwaysAllow)

	answer, err := h.agent.Run("read a.txt")
	if err != nil {
		t.Fatal(err)
	}
	if answer != "read it" {
		t.Fatalf("answer = %q", answer)
	}

	// The result must be in the history, paired with the call.
	found := false
	for _, message := range h.session.Messages {
		if role, _ := message["role"].(string); role != "tool" {
			continue
		}
		if id, _ := message["tool_call_id"].(string); id == "call_1" {
			found = true
		}
	}
	if !found {
		t.Fatal("the tool result never reached the session")
	}
	if !hasEvent(h.events, "tool_call") || !hasEvent(h.events, "tool_result") {
		t.Fatal("tool events were not emitted")
	}
}

func TestDeniedCallNeverRuns(t *testing.T) {
	chat := &fakeModel{script: []model.ModelResponse{
		toolCallResponse("call_1", "write_file", `{"path":"a.txt","content":"x"}`),
		textResponse("understood"),
	}}
	refuse := func(string, security.RiskLevel, map[string]any) bool { return false }
	h := newHarness(t, chat, refuse)

	if _, err := h.agent.Run("write it"); err != nil {
		t.Fatal(err)
	}

	var text string
	for _, message := range h.session.Messages {
		if role, _ := message["role"].(string); role == "tool" {
			text, _ = message["content"].(string)
		}
	}
	if !strings.Contains(text, "权限拒绝") {
		t.Fatalf("the refusal text never reached the model: %q", text)
	}
	if !hasEventWith(h.events, "permission", "outcome", OutcomeUserDenied) {
		t.Fatal("the denial was not recorded in the audit")
	}
}

func TestStepLimitIsNotAnError(t *testing.T) {
	// Always ask for a tool, so the turn never finishes on its own.
	chat := &fakeModel{}
	for index := 0; index < 10; index++ {
		chat.script = append(chat.script, toolCallResponse("call", "read_file", `{"path":"a"}`))
	}
	h := newHarness(t, chat, security.AlwaysAllow)

	_, err := h.agent.Run("loop")
	var limit *StepLimitExceeded
	if !errors.As(err, &limit) {
		t.Fatalf("err = %v, want StepLimitExceeded", err)
	}
	if reason := lastStopReason(h.events); reason != StopMaxSteps {
		t.Fatalf("stop_reason = %q, want %q", reason, StopMaxSteps)
	}
	// A step limit is not a model failure: the session must still be sendable.
	if _, isModelError := err.(*model.Error); isModelError {
		t.Fatal("the step limit must not be reported as a model error")
	}
}

func TestFatalErrorIsNotRetried(t *testing.T) {
	chat := &fakeModel{
		errs: []error{model.AsFatal("bad key")},
	}
	h := newHarness(t, chat, security.AlwaysAllow)

	_, err := h.agent.Run("hi")
	if err == nil {
		t.Fatal("a fatal error must be reported")
	}
	if chat.calls != 1 {
		t.Fatalf("model calls = %d, want 1 — a fatal error must not be retried", chat.calls)
	}
	if reason := lastStopReason(h.events); reason != StopModelFatal {
		t.Fatalf("stop_reason = %q, want %q", reason, StopModelFatal)
	}
	// The session is left consistent: only system and user, no dangling calls.
	for _, message := range h.session.Messages {
		if _, hasCalls := message["tool_calls"]; hasCalls {
			t.Fatal("a failed model call left a dangling assistant message")
		}
	}
}

func TestTransientErrorIsRetriedThenReported(t *testing.T) {
	chat := &fakeModel{errs: []error{
		model.AsTransient("503"),
		model.AsTransient("503"),
		model.AsTransient("503"),
	}}
	h := newHarness(t, chat, security.AlwaysAllow)

	if _, err := h.agent.Run("hi"); err == nil {
		t.Fatal("giving up must be reported")
	}
	if chat.calls != MaxAttempts {
		t.Fatalf("model calls = %d, want %d", chat.calls, MaxAttempts)
	}
	if reason := lastStopReason(h.events); reason != StopModelError {
		t.Fatalf("stop_reason = %q", reason)
	}
	attempts := 0
	for _, event := range h.events {
		if event["kind"] == "model_call" {
			attempts++
		}
	}
	if attempts != MaxAttempts {
		t.Fatalf("recorded attempts = %d, want %d", attempts, MaxAttempts)
	}
}

func TestArgumentsArePreviewedNotStoredWhole(t *testing.T) {
	long := strings.Repeat("x", 4000)
	chat := &fakeModel{script: []model.ModelResponse{
		toolCallResponse("call_1", "write_file", `{"path":"a.txt","content":"`+long+`"}`),
		textResponse("ok"),
	}}
	h := newHarness(t, chat, security.AlwaysAllow)

	if _, err := h.agent.Run("write"); err != nil {
		t.Fatal(err)
	}
	for _, event := range h.events {
		if event["kind"] != "tool_call" && event["kind"] != "permission" {
			continue
		}
		arguments, _ := event["arguments"].(string)
		if len(arguments) > AuditPreviewLimit+40 {
			t.Fatalf("%s stored %d characters of arguments; the audit records a preview", event["kind"], len(arguments))
		}
	}
}

func TestUnknownToolIsReportedNotCrashed(t *testing.T) {
	chat := &fakeModel{script: []model.ModelResponse{
		toolCallResponse("call_1", "no_such_tool", `{}`),
		textResponse("ok"),
	}}
	h := newHarness(t, chat, security.AlwaysAllow)

	if _, err := h.agent.Run("go"); err != nil {
		t.Fatal(err)
	}
	var text string
	for _, message := range h.session.Messages {
		if role, _ := message["role"].(string); role == "tool" {
			text, _ = message["content"].(string)
		}
	}
	if !strings.Contains(text, "没有这个工具") {
		t.Fatalf("the model was not told the tool does not exist: %q", text)
	}
}

func TestExistingRequestIsDeniedWhenNobodyCanBeAsked(t *testing.T) {
	// No asker at all: the gate must refuse rather than release.
	chat := &fakeModel{script: []model.ModelResponse{
		toolCallResponse("call_1", "write_file", `{"path":"a.txt","content":"x"}`),
		textResponse("understood"),
	}}
	h := newHarness(t, chat, nil)

	if _, err := h.agent.Run("write"); err != nil {
		t.Fatal(err)
	}
	if !hasEventWith(h.events, "permission", "outcome", OutcomeNoAsker) {
		t.Fatal("a missing approval channel must be recorded, and must fail closed")
	}
	var text string
	for _, message := range h.session.Messages {
		if role, _ := message["role"].(string); role == "tool" {
			text, _ = message["content"].(string)
		}
	}
	if !strings.Contains(text, "权限拒绝") {
		t.Fatalf("the call was not refused: %q", text)
	}
}

func TestInconsistentArgumentsAreReportedAsInvalid(t *testing.T) {
	chat := &fakeModel{script: []model.ModelResponse{
		toolCallResponse("call_1", "read_file", `{"path":""}`),
		textResponse("ok"),
	}}
	h := newHarness(t, chat, security.AlwaysAllow)

	if _, err := h.agent.Run("go"); err != nil {
		t.Fatal(err)
	}
	if !hasEventWith(h.events, "tool_result", "status", statusInvalidArgs) {
		t.Fatal("an empty path must be reported as invalid arguments")
	}
}

func lastStopReason(events []map[string]any) string {
	for index := len(events) - 1; index >= 0; index-- {
		if events[index]["kind"] == "run_finished" {
			reason, _ := events[index]["stop_reason"].(string)
			return reason
		}
	}
	return ""
}

func hasEvent(events []map[string]any, kind string) bool {
	for _, event := range events {
		if event["kind"] == kind {
			return true
		}
	}
	return false
}

func hasEventWith(events []map[string]any, kind, key string, value any) bool {
	for _, event := range events {
		if event["kind"] != kind {
			continue
		}
		if event[key] == value {
			return true
		}
	}
	return false
}

const (
	OutcomeUserDenied = security.OutcomeUserDenied
	OutcomeNoAsker    = security.OutcomeNoAsker
)
