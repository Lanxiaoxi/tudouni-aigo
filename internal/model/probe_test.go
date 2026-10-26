package model

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// probeGateway answers with a fixed status and body, recording each request.
type probeCall struct {
	body map[string]any
	path string
}

func probeGateway(t *testing.T, status int, response string) (*httptest.Server, *[]probeCall) {
	t.Helper()
	calls := &[]probeCall{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("reading the request body: %v", err)
		}
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("the request body is not JSON: %v (%s)", err, raw)
		}
		*calls = append(*calls, probeCall{body: body, path: r.URL.Path})

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(response))
	}))
	t.Cleanup(server.Close)
	return server, calls
}

// TestProbeReportsEachLevelVerbatim pins the bargain the whole feature runs on:
// the level is sent exactly as chosen (a probe that translated the level would
// report an answer the request never asked for), thinking is on (a level the
// endpoint takes only while thinking is not a level), and the request is small
// in whatever way each protocol allows.
func TestProbeReportsEachLevelVerbatim(t *testing.T) {
	server, calls := probeGateway(t, 200, `{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleOpenAI)})

	for _, level := range []string{"low", "xhigh", "max"} {
		outcome, err := adapter.ProbeEffort(level)
		if err != nil {
			t.Fatalf("ProbeEffort(%s): %v", level, err)
		}
		if outcome != ProbeOK {
			t.Errorf("ProbeEffort(%s) = %s, want ok", level, outcome)
		}
	}
	if len(*calls) != 3 {
		t.Fatalf("the gateway saw %d requests, want 3", len(*calls))
	}
	for i, level := range []string{"low", "xhigh", "max"} {
		body := (*calls)[i].body
		if got := body["reasoning_effort"]; got != level {
			t.Errorf("attempt %d sent reasoning_effort = %v, want %q (sent verbatim)", i, got, level)
		}
		if got := body["messages"]; len(got.([]any)) != 1 {
			t.Errorf("the probe carried %v messages, want one", got)
		}
		if (*calls)[i].path != "/chat/completions" {
			t.Errorf("the probe went to %s, want the chat completions path", (*calls)[i].path)
		}
	}
}

// TestProbeOnTheMessagesShapeAsksForThinkingAtTheFloor pins the two numbers a
// probe sends on the Messages shape: the floor budget and the answer room that
// exceeds it. `max_tokens` must **exceed** `budget_tokens` or the request is
// invalid at every level — a probe that sent a one-word answer room would read
// as "the level is not supported" while the true fault is this program's.
func TestProbeOnTheMessagesShapeAsksForThinkingAtTheFloor(t *testing.T) {
	server, calls := probeGateway(t, 200, `{"content":[{"type":"text","text":"ok"}]}`)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "claude-x", StyleAnthropic)})

	if outcome, err := adapter.ProbeEffort("xhigh"); err != nil || outcome != ProbeOK {
		t.Fatalf("ProbeEffort = (%s, %v), want ok", outcome, err)
	}
	body := (*calls)[0].body
	thinking, _ := body["thinking"].(map[string]any)
	if thinking == nil {
		t.Fatalf("the probe did not ask for thinking: %#v", body)
	}
	if got := thinking["type"]; got != "enabled" {
		t.Errorf("thinking.type = %v, want enabled", got)
	}
	budget, _ := thinking["budget_tokens"].(float64)
	if budget != probeThinkingFloor {
		t.Errorf("budget_tokens = %v, want the probe floor %d", budget, probeThinkingFloor)
	}
	maxTokens, _ := body["max_tokens"].(float64)
	if maxTokens <= budget {
		t.Errorf("max_tokens = %v does not exceed budget_tokens = %v: the request is invalid", maxTokens, budget)
	}
	if maxTokens > probeThinkingFloor+probeAnswerRoom {
		t.Errorf("max_tokens = %v, want the probe's small room %d", maxTokens, probeThinkingFloor+probeAnswerRoom)
	}
}

// TestProbeAsksTheResponsesShapeForTheSmallRoom is the same rule on the third
// wire: the effort goes out verbatim under `reasoning.effort`, and the answer
// room is capped rather than left to the endpoint's default.
func TestProbeAsksTheResponsesShapeForTheSmallRoom(t *testing.T) {
	server, calls := probeGateway(t, 200, `{"output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],"status":"completed"}`)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "gpt-x", StyleResponses)})

	if outcome, err := adapter.ProbeEffort("xhigh"); err != nil || outcome != ProbeOK {
		t.Fatalf("ProbeEffort = (%s, %v), want ok", outcome, err)
	}
	body := (*calls)[0].body
	reasoning, _ := body["reasoning"].(map[string]any)
	if reasoning == nil {
		t.Fatalf("the probe did not ask for reasoning: %#v", body)
	}
	if got := reasoning["effort"]; got != "xhigh" {
		t.Errorf("reasoning.effort = %v, want xhigh (sent verbatim)", got)
	}
	if got := body["max_output_tokens"]; got != float64(probeAnswerRoom) {
		t.Errorf("max_output_tokens = %v, want the probe room %d", got, probeAnswerRoom)
	}
}

// TestProbeReadsA400ThatNamesTheLevelAsARefusal is the other half of the bargain:
// only a 400 that names the parameter **and** complains about its value is a
// refusal of the level. The words are the endpoint's, and the match is narrow
// for the reason `isThinkingRefusal` gives — `reasoning_effort` is the vocabulary
// endpoints use for other problems too.
func TestProbeReadsA400ThatNamesTheLevelAsARefusal(t *testing.T) {
	refusals := []struct {
		name string
		body string
	}{
		{"the level is not supported", `{"error":{"message":"reasoning_effort 'xhigh' is not supported by this model"}}`},
		{"an invalid value", `{"error":{"message":"invalid value for reasoning_effort: 'minimal' is not a valid effort"}}`},
		{"the thinking shape's refusal", `{"error":{"message":"Invalid thinking config: effort 'xhigh' is unsupported"}}`},
	}
	for _, item := range refusals {
		t.Run(item.name, func(t *testing.T) {
			server, _ := probeGateway(t, 400, item.body)
			adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleOpenAI)})
			outcome, err := adapter.ProbeEffort("xhigh")
			if outcome != ProbeRejected {
				t.Errorf("ProbeEffort = %s, want rejected (%s)", outcome, item.body)
			}
			if err != nil {
				t.Errorf("a refusal carries no error, got %v", err)
			}
		})
	}
}

// TestA400AboutSomethingElseIsNotARefusalOfTheLevel is the guard on the narrow
// match: a 400 that merely **mentions** the parameter — a required thinking
// replay, a missing history field — is not an answer about the level, and a
// probe that read it one would delete a working level from the file.
func TestA400AboutSomethingElseIsNotARefusalOfTheLevel(t *testing.T) {
	bodies := []string{
		`{"error":{"message":"The ` + "`reasoning_content`" + ` in the thinking mode must be passed back to the API"}}`,
		`{"error":{"message":"invalid request: messages must not be empty"}}`,
	}
	for _, item := range bodies {
		t.Run(item, func(t *testing.T) {
			server, _ := probeGateway(t, 400, item)
			adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleOpenAI)})
			outcome, err := adapter.ProbeEffort("high")
			if outcome != ProbeUncertain {
				t.Errorf("ProbeEffort = %s, want uncertain: %s", outcome, item)
			}
			if err == nil {
				t.Error("the uncertain answer carries the endpoint's sentence; got no error")
			}
		})
	}
}

// TestARefusalThatIsNotAboutTheLevelIsUncertainWithTheSentence covers the
// statuses a level refusal cannot be: authentication (the whole probe is
// pointless, and the sentence says so), rate limit, and an upstream error.
// None of them may read as "the level does not exist".
func TestARefusalThatIsNotAboutTheLevelIsUncertainWithTheSentence(t *testing.T) {
	cases := []struct {
		status int
		body   string
	}{
		{401, `{"error":{"message":"Missing API key"}}`},
		{403, `{"error":{"message":"permission denied"}}`},
		{429, `{"error":{"message":"rate limited, try again later"}}`},
		{502, `{"error":{"message":"upstream error"}}`},
	}
	for _, item := range cases {
		t.Run(item.body, func(t *testing.T) {
			server, _ := probeGateway(t, item.status, item.body)
			adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleOpenAI)})
			outcome, err := adapter.ProbeEffort("high")
			if outcome != ProbeUncertain {
				t.Errorf("HTTP %d read as %s, want uncertain", item.status, outcome)
			}
			if err == nil || !strings.Contains(err.Error(), "HTTP "+strconv.Itoa(item.status)) {
				t.Errorf("the uncertain answer must carry the status: %v", err)
			}
		})
	}
}

// TestAProbeThatNeverArrivesIsUncertain is the rule for a network failure: a
// probe that did not reach an answer is not a refusal, and classifying it one
// would delete a level on a blip.
func TestAProbeThatNeverArrivesIsUncertain(t *testing.T) {
	server, _ := probeGateway(t, 200, `{}`)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleOpenAI)})
	server.Close()

	outcome, err := adapter.ProbeEffort("high")
	if outcome != ProbeUncertain {
		t.Errorf("ProbeEffort = %s, want uncertain for a request that never arrived", outcome)
	}
	if err == nil {
		t.Error("the failure carries a sentence")
	}
}


