package model

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// TestTheSessionPlaceholderIsReplaced pins the one thing a vendor's
// per-conversation header needs.
//
// The point of the placeholder is that the configuration file names the header —
// `x-opencode-session`, or whatever the next vendor calls theirs — while the
// program supplies the value. Neither side has to know the other's vocabulary.
func TestTheSessionPlaceholderIsReplaced(t *testing.T) {
	server, _, headers := dialectGateway(t, `{"choices":[{"message":{"content":"ok"}}]}`)
	adapter := newTestAdapter(t, Options{
		Route: Route{
			Name: "go", APIKey: "k", BaseURL: server.URL, Model: "m",
			SessionID: "ses_7f3a",
			Headers: map[string]string{
				"User-Agent":            "tudouni/0.2",
				"x-opencode-session":    SessionPlaceholder,
				"x-session-with-prefix": "conv:" + SessionPlaceholder,
			},
		},
	})

	completeOnce(t, adapter)

	sent := (*headers)[0]
	if got := sent.Get("x-opencode-session"); got != "ses_7f3a" {
		t.Errorf("x-opencode-session = %q, want the session id", got)
	}
	// A value that merely contains the placeholder is substituted inside it, so a
	// vendor whose header wants a prefix is not forced to take the raw id.
	if got := sent.Get("x-session-with-prefix"); got != "conv:ses_7f3a" {
		t.Errorf("x-session-with-prefix = %q, want the id substituted in place", got)
	}
	if got := sent.Get("User-Agent"); got != "tudouni/0.2" {
		t.Errorf("User-Agent = %q, want it untouched by templating", got)
	}
}

// TestAnEmptyHeaderIsNotSent is the half that is easy to leave out, and it is the
// half that matters.
//
// `x-opencode-session:` with nothing after it is read by a gateway as a client
// claiming a session and then failing to name one — a defect in the caller —
// whereas omitting the header is a client that simply does not do sessions. The
// two are treated differently, and only one of them is true here.
func TestAnEmptyHeaderIsNotSent(t *testing.T) {
	server, _, headers := dialectGateway(t, `{"choices":[{"message":{"content":"ok"}}]}`)
	adapter := newTestAdapter(t, Options{
		Route: Route{
			Name: "go", APIKey: "k", BaseURL: server.URL, Model: "m",
			// No session: a build that was given none must not invent one.
			Headers: map[string]string{
				"User-Agent":         "tudouni/0.2",
				"x-opencode-session": SessionPlaceholder,
				"x-blank":            "",
			},
		},
	})

	completeOnce(t, adapter)

	sent := (*headers)[0]
	if _, present := sent["X-Opencode-Session"]; present {
		t.Errorf("an empty session header was sent: %#v", sent["X-Opencode-Session"])
	}
	if _, present := sent["X-Blank"]; present {
		t.Errorf("an empty configured header was sent: %#v", sent["X-Blank"])
	}
	// The ones that do have values still go out: dropping the empty one must not
	// drop the rest.
	if got := sent.Get("User-Agent"); got != "tudouni/0.2" {
		t.Errorf("User-Agent = %q, want it still sent", got)
	}
}

// thinkingOnlyGateway behaves like a model that cannot be told to stop thinking:
// any request that mentions reasoning is refused, and the wording is the one a real
// gateway used.
func thinkingOnlyGateway(t *testing.T) (*httptest.Server, *[]map[string]any) {
	t.Helper()
	var mu sync.Mutex
	bodies := &[]map[string]any{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		*bodies = append(*bodies, body)
		mu.Unlock()

		// The refusal is about being *told* not to think. `reasoning_effort: "none"` is
		// what this program sends for that, and it is what two real models refused by
		// name — glm-5.3 and kimi-k2.7-code. A body that says nothing about reasoning
		// is accepted, which is the whole mechanism.
		if off, present := body["reasoning_effort"]; present && off == offEffort {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"type":"invalid_request_error","message":` +
				`"GLM-5.3 is a thinking-only model; disabling thinking (reasoning_effort='none') is not supported."}}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	t.Cleanup(server.Close)
	return server, bodies
}

// TestAModelThatCannotStopThinkingIsAskedAgainWithoutTheInstruction covers the
// measured incompatibility this exists for.
//
// A thinking-only model refuses `reasoning_effort: "none"` by name — measured on
// glm-5.3, glm-5.2 and kimi-k2.7-code, with two different wordings — and the request
// cannot be made to comply. So it is sent again saying nothing about reasoning, while
// the explicit instruction is kept for the first attempt, because on a model that
// merely *defaults* to thinking on, silence would make `/thinking off` a no-op that
// still bills for thinking.
func TestAModelThatCannotStopThinkingIsAskedAgainWithoutTheInstruction(t *testing.T) {
	server, bodies := thinkingOnlyGateway(t)
	adapter := newTestAdapter(t, Options{
		Route:    route(server.URL, "thinking-only-model", StyleOpenAI),
		Thinking: false, Effort: "high",
	})

	response := completeOnce(t, adapter)

	if response.Content == nil || *response.Content != "ok" {
		t.Fatalf("Content = %#v, want the retry to have succeeded", response.Content)
	}
	if len(*bodies) != 2 {
		t.Fatalf("the endpoint saw %d requests, want 2 (the refusal and the retry)", len(*bodies))
	}
	// The first attempt is the explicit instruction, not silence: on a model that
	// can comply, that is what makes the switch real.
	if got := (*bodies)[0]["reasoning_effort"]; got != offEffort {
		t.Errorf("the first attempt sent reasoning_effort = %v, want %q", got, offEffort)
	}
	// The retry says nothing at all about reasoning. This is the state that no model
	// has been observed to refuse.
	if _, present := (*bodies)[1]["reasoning_effort"]; present {
		t.Errorf("the retry still carried reasoning_effort: %#v", (*bodies)[1])
	}
	if _, present := (*bodies)[1]["thinking"]; present {
		t.Errorf("the retry carried a thinking field: %#v", (*bodies)[1])
	}
}

// TestTheThinkingRefusalIsRememberedPerModel keeps the recovery from being paid for
// twice: the knowledge cost one refused request, and every later turn on the same
// endpoint uses it.
func TestTheThinkingRefusalIsRememberedPerModel(t *testing.T) {
	server, bodies := thinkingOnlyGateway(t)
	adapter := newTestAdapter(t, Options{
		Route:    route(server.URL, "remembered-thinking-only", StyleOpenAI),
		Thinking: false, Effort: "high",
	})

	completeOnce(t, adapter)
	if len(*bodies) != 2 {
		t.Fatalf("first turn: %d requests, want 2", len(*bodies))
	}

	completeOnce(t, adapter)
	if len(*bodies) != 3 {
		t.Fatalf("second turn: %d requests in total, want 3 — the refusal was rediscovered", len(*bodies))
	}
	if _, present := (*bodies)[2]["thinking"]; present {
		t.Errorf("the second turn asked again with the marker: %#v", (*bodies)[2])
	}
}

// TestATransientFailureIsNotTreatedAsAThinkingRefusal keeps the narrow match
// narrow: a rate limit or a bad key must surface as itself rather than being
// retried as though the reasoning switch were the problem.
func TestATransientFailureIsNotTreatedAsAThinkingRefusal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	}))
	t.Cleanup(server.Close)

	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleOpenAI)})
	_, err := adapter.Complete([]map[string]any{{"role": "user", "content": "hi"}}, nil, CompleteOptions{})
	if err == nil {
		t.Fatal("a 429 was reported as success")
	}
	if !strings.Contains(err.Error(), "429") {
		t.Errorf("the error does not report the real status: %v", err)
	}
}
