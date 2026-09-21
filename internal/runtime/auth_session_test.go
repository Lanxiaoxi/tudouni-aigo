package runtime

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/config"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// ── the in-session half of `--ericai` ─────────────────────────────────────────

// authHarness is a runtime with a real model client and a real config file, and
// nothing else.
//
// The client is built on a route whose base URL goes nowhere: none of these tests
// send a request, they are about what the session does to the **client** before one
// goes out. Refreshing is real, writing the config back is real, installing the key
// is real — only the three network calls of the token flow are stubbed.
type authHarness struct {
	runtime    *Runtime
	configPath string
	refreshes  int
}

func newAuthHarness(t *testing.T, key string, enabled bool) *authHarness {
	t.Helper()
	// A throwaway home: the refresh-token store lives under it, and a test that
	// inherited the real one would use — and rotate — a real credential.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	configPath := filepath.Join(t.TempDir(), "config.json")
	t.Setenv(config.FileEnv, configPath)
	body, err := json.Marshal(map[string]any{
		"providers": map[string]any{
			EricAIProvider: map[string]any{
				"api_key": key, "base_url": "https://eric.example",
				"models": []any{map[string]any{"id": "eric-chat"}},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, body, 0o600); err != nil {
		t.Fatal(err)
	}

	catalog, err := state.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	route, ok := catalog.ProviderByName(EricAIProvider)
	if !ok {
		t.Fatal("the test config did not produce a route")
	}
	chat, err := model.New(model.Options{Route: routeOf(route, "eric-chat", "ses_test")})
	if err != nil {
		t.Fatal(err)
	}

	harness := &authHarness{configPath: configPath}
	harness.runtime = &Runtime{
		SessionIDValue: "ses_test",
		Chat:           chat,
		Catalog:        catalog,
		ModelState:     state.NewSessionModel(map[string]any{}, "eric-chat", EricAIProvider),
	}
	harness.runtime.initAuth(enabled)
	return harness
}

// stubRefresh makes the silent refresh succeed with a new access token, and counts
// how often it was asked. It never touches the interactive flow: these tests are
// about when a refresh happens, and a device-code login would make them wait.
func (h *authHarness) stubRefresh(t *testing.T, access, refresh string) {
	t.Helper()
	original := ericRefreshFn
	t.Cleanup(func() { ericRefreshFn = original })
	ericRefreshFn = func(token string) (ericTokenResponse, error) {
		h.refreshes++
		return ericTokenResponse{AccessToken: access, RefreshToken: refresh}, nil
	}
	// The silent path needs a stored refresh token to exist at all; storing it is
	// what a previous login would have done.
	if err := ericSaveRefreshToken("stored-refresh"); err != nil {
		t.Fatal(err)
	}
}

func (h *authHarness) storedKey(t *testing.T) string {
	t.Helper()
	return storedEricKey(t, h.configPath)
}

func minutesFromNow(minutes int) string {
	return makeJWT(map[string]any{"exp": float64(time.Now().Add(time.Duration(minutes) * time.Minute).Unix())})
}

// freshToken builds a token that is **distinguishable** from any other, even one
// minted in the same second.
//
// `makeJWT` encodes only the claims it is given, and two tokens built from
// `minutesFromNow` within the same second are byte-identical — which is fine for
// "is this expired" and useless for "was the client moved onto the new one". The
// extra claim is the marker.
func freshToken(t *testing.T, minutes int, marker string) string {
	t.Helper()
	return makeJWT(map[string]any{
		"exp":    float64(time.Now().Add(time.Duration(minutes) * time.Minute).Unix()),
		"marker": marker,
	})
}

// TestThePreRequestCheckReplacesATokenThatIsAboutToExpire is the whole point of the
// feature: a session left open past the token's lifetime has to repair itself
// without anybody typing anything.
//
// Both halves are asserted, and the second is the one that used to be missing: the
// config file gets the new token **and** the client that will send the next request
// is carrying it. A refresh that only writes the file leaves every request failing
// with a 401 while the file looks perfectly healthy.
func TestThePreRequestCheckReplacesATokenThatIsAboutToExpire(t *testing.T) {
	h := newAuthHarness(t, minutesFromNow(2), true)
	fresh := freshToken(t, 70, "after-the-refresh")
	h.stubRefresh(t, fresh, "rotated-refresh")

	h.runtime.authCheck()

	if h.refreshes != 1 {
		t.Fatalf("the refresh ran %d times, want 1", h.refreshes)
	}
	if got := h.storedKey(t); got != fresh {
		t.Error("the config still holds the old token; the next run would read a dead key")
	}
	if got := h.runtime.Chat.Route().APIKey; got != fresh {
		t.Error("the live client is still sending the old token; every request would 401")
	}
	notices := h.runtime.DrainAuthNotices()
	if len(notices) != 1 {
		t.Fatalf("queued %d notices, want 1", len(notices))
	}
	if text, _ := notices[0]["text"].(string); !strings.Contains(text, "refreshed") {
		t.Errorf("the notice does not say what happened: %v", notices[0])
	}
}

// TestAFreshTokenCostsNothing — the check runs before every model call, so the
// common case has to be a decode and nothing else. No network, no write, and above
// all no notice: a line every turn saying "nothing needed doing" is noise that
// teaches people to ignore the one that matters.
func TestAFreshTokenCostsNothing(t *testing.T) {
	h := newAuthHarness(t, minutesFromNow(70), true)
	h.stubRefresh(t, minutesFromNow(70), "unused")

	h.runtime.authCheck()

	if h.refreshes != 0 {
		t.Fatalf("a token with an hour left was refreshed %d times, want 0", h.refreshes)
	}
	if got := h.storedKey(t); got == "" {
		t.Fatal("the config lost its key")
	}
	if notices := h.runtime.DrainAuthNotices(); len(notices) != 0 {
		t.Fatalf("a no-op queued a notice: %v", notices)
	}
}

// TestARefusalForcesARefreshTheClockWouldHaveSkipped is the case the check cannot
// see: the token's own `exp` says it is fine, and the endpoint disagrees — a revoked
// token, or a clock that has drifted.
//
// `force` is why the command-less design still handles it: the refusal is the
// evidence, so the freshness test is not consulted.
func TestARefusalForcesARefreshTheClockWouldHaveSkipped(t *testing.T) {
	h := newAuthHarness(t, minutesFromNow(70), true)
	fresh := freshToken(t, 70, "forced-by-a-refusal")
	h.stubRefresh(t, fresh, "rotated-refresh")
	refusal := &model.CredentialError{Msg: "HTTP 401 from https://eric.example: invalid token"}

	if !h.runtime.RecoverAuth(refusal) {
		t.Fatal("the refusal was not recovered; the session would keep sending a dead token")
	}
	if h.refreshes != 1 {
		t.Fatalf("the refresh ran %d times, want 1", h.refreshes)
	}
	if got := h.runtime.Chat.Route().APIKey; got != fresh {
		t.Error("the client was not moved onto the refreshed token")
	}
	if notices := h.runtime.DrainAuthNotices(); len(notices) == 0 {
		t.Error("the recovery said nothing; the person cannot tell why a turn was sent twice")
	}
}

// TestARefusalIsOnlyAnsweredOnce — the latch. An endpoint that refuses the
// *refreshed* token is not going to accept it on a third try, and a loop would turn
// one clear failure into a hang.
func TestARefusalIsOnlyAnsweredOnce(t *testing.T) {
	h := newAuthHarness(t, minutesFromNow(70), true)
	h.stubRefresh(t, freshToken(t, 70, "answered-once"), "rotated-refresh")
	refusal := &model.CredentialError{Msg: "HTTP 401"}

	if !h.runtime.RecoverAuth(refusal) {
		t.Fatal("the first refusal was not recovered")
	}
	if h.runtime.RecoverAuth(refusal) {
		t.Fatal("the second refusal was recovered too; a revoked token would be retried forever")
	}
	if h.refreshes != 1 {
		t.Errorf("the refresh ran %d times, want 1", h.refreshes)
	}
}

// TestAnOrdinaryFatalErrorIsNotRecovered — the recovery is narrow on purpose. A 400
// about the request is not something a new token can fix, and answering yes would
// send the same bad request again.
func TestAnOrdinaryFatalErrorIsNotRecovered(t *testing.T) {
	h := newAuthHarness(t, minutesFromNow(70), true)
	h.stubRefresh(t, minutesFromNow(70), "unused")

	if h.runtime.RecoverAuth(model.AsFatal("HTTP 400: unknown model")) {
		t.Fatal("a request-shaped failure was treated as a credential failure")
	}
	if h.refreshes != 0 {
		t.Errorf("a 400 triggered %d refreshes, want 0", h.refreshes)
	}
}

// TestWithoutTheFlagNothingIsManaged is the boundary the flag draws: a session
// started without `--ericai` does not inspect, refresh or install anything. Without
// this, the whole feature would be a silent side effect on every session that merely
// happens to have a route named ericai configured.
func TestWithoutTheFlagNothingIsManaged(t *testing.T) {
	original := minutesFromNow(2)
	h := newAuthHarness(t, original, false)
	h.stubRefresh(t, minutesFromNow(70), "unused")
	refusal := &model.CredentialError{Msg: "HTTP 401"}

	h.runtime.authCheck()
	if h.refreshes != 0 {
		t.Errorf("a session without --ericai refreshed %d times, want 0", h.refreshes)
	}
	if h.runtime.RecoverAuth(refusal) {
		t.Error("a session without --ericai recovered a 401; it must report it like any other fatal error")
	}
	if got := h.storedKey(t); got != original {
		t.Error("a session without --ericai wrote to the config")
	}
	if got := h.runtime.Chat.Route().APIKey; got != original {
		t.Error("a session without --ericai moved the client")
	}
}

// TestAStartupRefreshInstallsTheKeyAtOpen is `--ericai` itself: the token is checked
// before the session opens, and the client the session will use is moved onto it.
//
// The outcome travels as a **start-up notice**, because the protocol has not opened
// yet when this runs — and the device-code lines of an interactive login go to
// stderr, which is still an ordinary terminal at that moment.
func TestAStartupRefreshInstallsTheKeyAtOpen(t *testing.T) {
	h := newAuthHarness(t, minutesFromNow(1), true)
	fresh := freshToken(t, 70, "installed-at-open")
	h.stubRefresh(t, fresh, "rotated-refresh")

	h.runtime.StartupAuth()

	if h.refreshes != 1 {
		t.Fatalf("the refresh ran %d times, want 1", h.refreshes)
	}
	if got := h.runtime.Chat.Route().APIKey; got != fresh {
		t.Error("the start-up check wrote the file but left the client on the old token")
	}
	if len(h.runtime.notices) != 1 {
		t.Fatalf("queued %d start-up notices, want 1", len(h.runtime.notices))
	}
	if code, _ := h.runtime.notices[0]["code"].(string); code != "auth" {
		t.Errorf("the notice is not tagged as a credential notice: %v", h.runtime.notices[0])
	}
	// And it is a start-up notice **only**: the same sentence arriving again after
	// the first turn would read as a second refresh that never happened.
	if notices := h.runtime.DrainAuthNotices(); len(notices) != 0 {
		t.Errorf("the start-up notice was also queued for the first turn: %v", notices)
	}
}

// TestARefreshThatFailsIsSaidOutLoudAndDoesNotPretend — the failure path, and the
// one that decides whether a turn is sent again.
//
// The old token stays on disk and on the client, and nothing claims otherwise: the
// point of the notice is that a person can tell "it tried and could not" from "it
// never tried", because those two have different next steps.
func TestARefreshThatFailsIsSaidOutLoudAndDoesNotPretend(t *testing.T) {
	stale := minutesFromNow(70)
	h := newAuthHarness(t, stale, true)

	originalRefresh, originalTimeout := ericRefreshFn, ericTimeout
	t.Cleanup(func() { ericRefreshFn, ericTimeout = originalRefresh, originalTimeout })
	browserLogins := 0
	ericRefreshFn = func(string) (ericTokenResponse, error) {
		return ericTokenResponse{Error: "invalid_grant", Description: "the refresh token has been revoked"}, nil
	}
	originalDevice := ericRequestDeviceCodeFn
	t.Cleanup(func() { ericRequestDeviceCodeFn = originalDevice })
	ericRequestDeviceCodeFn = func() (ericLoginPrompt, error) {
		browserLogins++
		return ericLoginPrompt{DeviceCode: "device-1", UserCode: "ABCD", Interval: 1, ExpiresIn: 900}, nil
	}
	// The interactive fallback would otherwise poll for five minutes, which is a real
	// wait for a test that is about what happens when nothing works.
	ericTimeout = 0

	if err := ericSaveRefreshToken("stored-refresh"); err != nil {
		t.Fatal(err)
	}

	// The endpoint refused, so the clock's opinion is overruled — and every way of
	// getting a new token fails.
	if h.runtime.RecoverAuth(&model.CredentialError{Msg: "HTTP 401"}) {
		t.Fatal("reported a recoverable refusal with no new token to send")
	}
	if browserLogins != 1 {
		t.Fatalf("opened %d browser logins, want 1 (the stored refresh token was refused, so the fallback is the login)", browserLogins)
	}

	notices := h.runtime.DrainAuthNotices()
	if len(notices) != 1 {
		t.Fatalf("queued %d notices, want 1", len(notices))
	}
	level, _ := notices[0]["level"].(string)
	if level != "warn" {
		t.Errorf("level = %q, want a warning", level)
	}
	text, _ := notices[0]["text"].(string)
	if !strings.Contains(text, "the old token stays") {
		t.Errorf("the notice does not say the token was left alone: %q", text)
	}
	if got := h.storedKey(t); got != stale {
		t.Error("a failed refresh changed the key on disk")
	}
	if got := h.runtime.Chat.Route().APIKey; got != stale {
		t.Error("a failed refresh moved the client")
	}
}

// TestAnInteractiveLoginStillCompletesInsideTheRuntime — the start-up path must run
// the browser flow to the end when there is no stored refresh token, and the token it
// returns has to reach the client.
//
// The instructions themselves go through a reporter this file cannot observe (at
// start-up it is stderr, which is the right answer for a terminal), so what is pinned
// here is that the flow runs at all in this process — the property the entry point
// used to break by refreshing before any interface existed.
func TestAnInteractiveLoginStillCompletesInsideTheRuntime(t *testing.T) {
	h := newAuthHarness(t, minutesFromNow(0), true)

	originalDevice, originalPost := ericRequestDeviceCodeFn, ericPostTokenFn
	t.Cleanup(func() { ericRequestDeviceCodeFn, ericPostTokenFn = originalDevice, originalPost })

	// No stored refresh token: the silent path has nothing to redeem, so the
	// interactive flow runs. Interval 1 keeps the poll's mandatory sleep at a second.
	ericRequestDeviceCodeFn = func() (ericLoginPrompt, error) {
		return ericLoginPrompt{
			DeviceCode: "device-1", UserCode: "ABCD-EFGH",
			VerificationURI: "https://microsoft.com/devicelogin", Interval: 1, ExpiresIn: 900,
		}, nil
	}
	fresh := minutesFromNow(70)
	ericPostTokenFn = func(url.Values) (ericTokenResponse, error) {
		return ericTokenResponse{AccessToken: fresh, RefreshToken: "refresh-1"}, nil
	}

	h.runtime.StartupAuth()

	if got := h.runtime.Chat.Route().APIKey; got != fresh {
		t.Error("the interactive login's token did not reach the client")
	}
	if got := h.storedKey(t); got != fresh {
		t.Error("the interactive login's token was not written back")
	}
	// The refresh token from the login is the entire reason the next session is
	// silent, so losing it here would mean a browser login every time.
	if got := ericLoadRefreshToken(); got != "refresh-1" {
		t.Errorf("the login's refresh token was not stored: %q", got)
	}
}
