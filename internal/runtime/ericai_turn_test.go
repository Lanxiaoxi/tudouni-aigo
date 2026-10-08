package runtime

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/agent"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
)

// ── the whole turn, against an endpoint that refuses a dead token ─────────────
//
// `auth_session_test.go` tests the two hooks in isolation: it calls `authCheck`
// and `RecoverAuth` itself and inspects the client afterwards. That answers "did
// the hook do its job" but not the question a person actually asks — **what
// happens to my next message** — and the two are not the same, because the hooks
// only matter through the retry loop that calls them.
//
// So these tests run a real model call: a real `model.OpenAICompatible` against a
// real HTTP endpoint that answers 401 for the token it does not honour, driven
// through `agent.CallWithRetry` with the **same two hooks `OpenRuntime` installs**
// (`composition.go`, `BeforeEach: runtimeValue.authCheck`, `OnFatal:
// runtimeValue.RecoverAuth`). Only the three Entra calls are stubbed, exactly as in
// the rest of this package's auth tests.
//
// The two states under test are the TUI's and the desktop's, and the difference
// between them is one command-line flag:
//
//   - with `--ericai`, the pre-request check moves the client onto a fresh token
//     **before the request goes out**, so the endpoint never refuses anything;
//   - without it, there is no auth state at all, so the first message after the
//     token dies is a 401 and so is every message after it, for the life of the
//     process.

// ericGateway is a model endpoint that honours exactly one token at a time.
//
// "Honours one token" rather than "refuses one" because that is the shape of the
// failure: the endpoint does not care where a token came from, only whether it is
// the current one. Moving the accepted key is how a test says "the token that was
// good a moment ago is not good any more" — a revocation, or a refresh that
// happened elsewhere.
type ericGateway struct {
	server *httptest.Server

	mu     sync.Mutex
	accept string
	seen   []string
}

func newEricGateway(t *testing.T, accept string) *ericGateway {
	t.Helper()
	gateway := &ericGateway{accept: accept}
	gateway.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gateway.mu.Lock()
		gateway.seen = append(gateway.seen, r.Header.Get("Authorization"))
		accept := gateway.accept
		gateway.mu.Unlock()

		if r.Header.Get("Authorization") != "Bearer "+accept {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"the access token is not valid"}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		payload, _ := json.Marshal(map[string]any{
			"choices": []any{map[string]any{
				"message": map[string]any{"role": "assistant", "content": "ok"},
			}},
			"usage": map[string]any{"prompt_tokens": 1, "completion_tokens": 1},
		})
		_, _ = w.Write(payload)
	}))
	t.Cleanup(gateway.server.Close)
	return gateway
}

// allow moves the endpoint onto a different token, which is how a test says the
// one it was honouring has been revoked.
func (g *ericGateway) allow(key string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.accept = key
}

// requests is every Authorization header the endpoint was sent, in order.
func (g *ericGateway) requests() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.seen...)
}

// modelTurn is one model call through the loop and the hooks a real session uses.
//
// It is deliberately the same two hooks `OpenRuntime` installs rather than a
// reimplementation of them: the property under test is "a turn repairs itself",
// and a turn is what the retry loop plus those two hooks add up to.
func (h *authHarness) modelTurn(t *testing.T) error {
	t.Helper()
	_, err := agent.CallWithRetry(
		h.runtime.Chat,
		[]map[string]any{{"role": "user", "content": "hello"}},
		nil,
		model.CompleteOptions{},
		agent.RetryHooks{
			BeforeEach: h.runtime.authCheck,
			OnFatal:    h.runtime.RecoverAuth,
		},
	)
	return err
}

// stubRefreshSequence makes each silent refresh hand back the next token in the
// list, so a test can tell "the second refresh" from "the same refresh twice".
func (h *authHarness) stubRefreshSequence(t *testing.T, tokens ...string) {
	t.Helper()
	original := ericRefreshFn
	t.Cleanup(func() { ericRefreshFn = original })
	ericRefreshFn = func(string) (ericTokenResponse, error) {
		token := tokens[min(h.refreshes, len(tokens)-1)]
		h.refreshes++
		return ericTokenResponse{AccessToken: token, RefreshToken: "rotated-refresh"}, nil
	}
	if err := ericSaveRefreshToken("stored-refresh"); err != nil {
		t.Fatal(err)
	}
}

// TestEveryTurnOfASessionWithoutTheFlagIsRefused is the desktop's state, and the
// reported symptom exactly.
//
// The session opens with a token that is still good — which is why nothing looks
// wrong at first — and the endpoint stops honouring it. From then on **every**
// message is a 401: the pre-request check has no auth state to consult, and the
// refusal is reported like any other fatal error. Nothing is refreshed, nothing is
// installed, and no later turn behaves differently from the first.
func TestEveryTurnOfASessionWithoutTheFlagIsRefused(t *testing.T) {
	gateway := newEricGateway(t, "the-token-the-endpoint-still-honours")
	h := newAuthHarnessAt(t, minutesFromNow(70), false, gateway.server.URL)
	h.stubRefresh(t, freshToken(t, 70, "never-minted"), "rotated-refresh")

	for turn := 1; turn <= 3; turn++ {
		err := h.modelTurn(t)
		if err == nil {
			t.Fatalf("turn %d succeeded; a session with no managed token is supposed to be refused", turn)
		}
		if !model.IsCredential(err) {
			t.Fatalf("turn %d failed with %v, want the endpoint's refusal", turn, err)
		}
	}

	// The refusals are the endpoint's, not a local mistake: every turn really did
	// reach it.
	if got := len(gateway.requests()); got != 3 {
		t.Errorf("the endpoint saw %d requests, want 3", got)
	}
	// And nothing tried to repair it — this is the whole of "the desktop never
	// refreshes": there is nothing there to do the refreshing.
	if h.refreshes != 0 {
		t.Errorf("a session without --ericai refreshed %d times, want 0", h.refreshes)
	}
}

// TestWithTheFlagTheTurnRepairsItselfBeforeItGoesOut is the TUI's state, and the
// contrast that makes the flag the whole story.
//
// The token is ten minutes from expiry, so the pre-request check replaces it
// **before the first attempt**. The endpoint therefore never refuses anything: the
// session outlives its token with nobody typing anything, which is the property the
// feature exists for.
func TestWithTheFlagTheTurnRepairsItselfBeforeItGoesOut(t *testing.T) {
	fresh := freshToken(t, 70, "installed-before-the-request")
	gateway := newEricGateway(t, fresh)
	// Two minutes left: inside RefreshThreshold, so the check fires.
	h := newAuthHarnessAt(t, minutesFromNow(2), true, gateway.server.URL)
	h.stubRefresh(t, fresh, "rotated-refresh")

	if err := h.modelTurn(t); err != nil {
		t.Fatalf("the turn failed even though the token could be refreshed: %v", err)
	}
	if h.refreshes != 1 {
		t.Fatalf("the refresh ran %d times, want 1", h.refreshes)
	}
	requests := gateway.requests()
	if len(requests) != 1 {
		t.Fatalf("the endpoint saw %d requests, want 1: the request was sent with a dead token first", len(requests))
	}
	if requests[0] != "Bearer "+fresh {
		t.Errorf("the request carried %q, want the refreshed token", requests[0])
	}
}

// TestARefusalIsRecoveredOnceForTheLifeOfTheProcess pins a **defect**, and this
// comment says so rather than describing it as a rule.
//
// The 401 recovery is the half the clock cannot see: a revoked token, or a machine
// whose clock disagrees with the server's, looks perfectly fresh to `NeedsRefresh`.
// The refusal is the only evidence, and it is answered with a forced refresh plus
// one retry — which works, once.
//
// `ericAuth.recovered` is latched with a `CompareAndSwap` that is **never reset**,
// so the second refusal of a process's life is not offered a refresh at all, even
// hours later and even though refreshing would have produced a token the endpoint
// accepts. `Agent.recoveredFatal` — the latch that actually bounds the retry loop —
// is cleared at the start of every turn, and its own comment says why a latch that
// survived the turn is wrong: it "would silently refuse to recover the next time the
// token really did expire".
//
// So the two latches disagree, and this one is both redundant (the loop is already
// bounded per turn) and over-broad. It bites hardest in exactly the front end that
// keeps a process alive for days.
//
// **If the latch is ever scoped to one refusal episode, this test has to be
// inverted rather than deleted**: turn two below should then succeed, and the
// refresh count should be 2.
func TestARefusalIsRecoveredOnceForTheLifeOfTheProcess(t *testing.T) {
	first, second := freshToken(t, 70, "minted-by-the-first-recovery"), freshToken(t, 70, "minted-by-the-second")
	// The endpoint honours only what the next refresh will mint, so the token the
	// client is holding is refused — the case the clock cannot see.
	gateway := newEricGateway(t, first)
	h := newAuthHarnessAt(t, minutesFromNow(70), true, gateway.server.URL)
	h.stubRefreshSequence(t, first, second)

	// ── turn one: refused, refreshed, sent again, answered ──
	if err := h.modelTurn(t); err != nil {
		t.Fatalf("the first refusal was not recovered: %v", err)
	}
	if h.refreshes != 1 {
		t.Fatalf("the first turn refreshed %d times, want 1", h.refreshes)
	}

	// ── the token that recovery installed is revoked a while later ──
	gateway.allow(second)

	// ── turn two: refused again, and nothing offers it a refresh ──
	err := h.modelTurn(t)
	if err == nil {
		t.Fatal("turn two succeeded, so the latch has been scoped per turn and this test needs inverting")
	}
	if !model.IsCredential(err) {
		t.Fatalf("turn two failed with %v, want the endpoint's refusal", err)
	}
	if h.refreshes != 1 {
		t.Errorf(
			"the second refusal was offered a refresh (%d refreshes in total, want 1); "+
				"this test pins the defect, so a count of 2 means the latch was scoped per turn and these assertions must be inverted",
			h.refreshes,
		)
	}
	if got := h.runtime.Chat.Route().APIKey; got != first {
		t.Errorf("the client moved to %q without a refresh having been asked for", got)
	}
}
