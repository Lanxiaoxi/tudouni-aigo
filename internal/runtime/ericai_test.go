package runtime

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/config"
)

// ── JWT expiry ────────────────────────────────────────────────────────────────

func makeJWT(claims map[string]any) string {
	payload, _ := json.Marshal(claims)
	body := base64.RawURLEncoding.EncodeToString(payload)
	return "header." + body + ".signature"
}

func TestDecodeExpiryReadsThePayloadWithoutAJwtLibrary(t *testing.T) {
	exp := float64(time.Now().Add(time.Hour).Unix())
	token := makeJWT(map[string]any{"exp": exp})
	got, ok := DecodeExpiry(token)
	if !ok || got != exp {
		t.Fatalf("DecodeExpiry = %v (%v), want %v", got, ok, exp)
	}
}

func TestDecodeExpiryRejectsEverythingUnusable(t *testing.T) {
	bad := []string{
		"",
		"not-a-jwt",
		"two.parts",
		"header." + base64.RawURLEncoding.EncodeToString([]byte("not json")) + ".sig",
		makeJWT(map[string]any{"exp": "soon"}),
	}
	for _, token := range bad {
		if _, ok := DecodeExpiry(token); ok {
			t.Errorf("DecodeExpiry(%q) unexpectedly succeeded", token)
		}
	}
}

func TestNeedsRefreshIsTrueForAnUnparseableToken(t *testing.T) {
	// An unreadable token is one whose state nobody knows: trying the refresh
	// flow beats trusting it.
	if !NeedsRefresh("", time.Now()) {
		t.Fatal("an empty token must count as stale")
	}
	if !NeedsRefresh("garbage", time.Now()) {
		t.Fatal("an unreadable token must count as stale")
	}

	fresh := makeJWT(map[string]any{"exp": float64(time.Now().Add(2 * time.Hour).Unix())})
	if NeedsRefresh(fresh, time.Now()) {
		t.Fatal("a token with an hour left must not need refreshing")
	}
	almostGone := makeJWT(map[string]any{"exp": float64(time.Now().Add(60 * time.Second).Unix())})
	if !NeedsRefresh(almostGone, time.Now()) {
		t.Fatal("a token with a minute left must need refreshing")
	}
}

// ── write-back ────────────────────────────────────────────────────────────────

func TestWriteBackChangesOneFieldAndKeepsEverythingElse(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	original := `{
  "$comment": "hand-edited, keep me",
  "providers": {
    "deepseek": {"api_key": "sk-other", "models": []},
    "ericai": {"api_key": "old.jwt", "base_url": "https://eric.example"}
  },
  "ui": {"language": "en"}
}`
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := ericWriteBack(path, "new.jwt"); err != nil {
		t.Fatal(err)
	}

	decoded, err := configReadForTest(path)
	if err != nil {
		t.Fatal(err)
	}
	if comment := decoded["$comment"]; comment != "hand-edited, keep me" {
		t.Fatalf("the $comment key was dropped: %v", comment)
	}
	providers := decoded["providers"].(map[string]any)
	deepseek := providers["deepseek"].(map[string]any)
	if deepseek["api_key"] != "sk-other" {
		t.Fatal("another provider's key was touched")
	}
	eric := providers["ericai"].(map[string]any)
	if eric["api_key"] != "new.jwt" {
		t.Fatalf("the ericai key was not replaced: %v", eric["api_key"])
	}
	if eric["base_url"] != "https://eric.example" {
		t.Fatal("the ericai route lost a sibling field")
	}

	// The temp file must be gone: a leftover .tmp next to a file of keys is the
	// half-written config the rename was supposed to prevent.
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("a temp file survived: %s", entry.Name())
		}
	}
}

func configReadForTest(path string) (map[string]any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ── refresh: every failure degrades, none blocks ─────────────────────────────

func TestRefreshDegradesWithAnExplanationWhenThereIsNoRoute(t *testing.T) {
	// RefreshEricAI reads the user config; a machine without an ericai route must
	// get an explanation rather than a panic or a partial write. The path is
	// pointed at a throwaway config so the test does not depend on — or, worse,
	// wait on — whatever the machine running it happens to have configured.
	configPath := filepath.Join(t.TempDir(), "config.json")
	t.Setenv(config.FileEnv, configPath)
	body := `{"providers": {"deepseek": {"api_key": "sk-other"}}}`
	if err := os.WriteFile(configPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := RefreshEricAI(RefreshOptions{})
	if err == nil || !strings.Contains(err.Error(), "no ericai route") {
		t.Fatalf("err = %v, want a sentence about the missing route", err)
	}
}

// ── the sequence the feature promises: log in once, then never again ─────────

// TestTheFirstRunLogsInAndTheSecondRunRefreshesSilently walks the real refresh and
// the real device-code flow with only the three network calls stubbed out. It is the
// regression test for the bug users saw: the first run logged in, threw the login's
// refresh_token away, and so every later run logged in again.
//
// It also pins the other half of that fix — the login's instructions reach the
// caller's reporter. Written to stderr directly, they were invisible to the
// full-screen front end, which is how "the token needs a browser" turned into a
// session that simply stopped working with no explanation on screen.
func TestTheFirstRunLogsInAndTheSecondRunRefreshesSilently(t *testing.T) {
	// A throwaway home and config: the refresh-token store lives under the home
	// directory, so both have to move for the test to be hermetic.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	configPath := filepath.Join(t.TempDir(), "config.json")
	t.Setenv(config.FileEnv, configPath)

	stale := makeJWT(map[string]any{"exp": float64(time.Now().Add(time.Minute).Unix())})
	fresh := makeJWT(map[string]any{"exp": float64(time.Now().Add(time.Hour).Unix())})
	fresher := makeJWT(map[string]any{"exp": float64(time.Now().Add(2 * time.Hour).Unix())})
	writeEricConfig(t, configPath, stale)

	logins, polls := 0, 0
	var refreshedWith []string
	var reported []string
	originalRequest, originalPost, originalRefresh := ericRequestDeviceCodeFn, ericPostTokenFn, ericRefreshFn
	t.Cleanup(func() {
		ericRequestDeviceCodeFn, ericPostTokenFn, ericRefreshFn = originalRequest, originalPost, originalRefresh
	})

	ericRequestDeviceCodeFn = func() (ericLoginPrompt, error) {
		logins++
		// Interval 1 keeps the poll loop's mandatory sleep down to a second.
		return ericLoginPrompt{
			DeviceCode: "device-1", UserCode: "ABCD-EFGH",
			VerificationURI: "https://microsoft.com/devicelogin", Interval: 1, ExpiresIn: 900,
		}, nil
	}
	ericPostTokenFn = func(url.Values) (ericTokenResponse, error) {
		polls++
		// Entra only includes this field because the request asked for
		// offline_access; the login is the one place a refresh token is born.
		return ericTokenResponse{AccessToken: fresh, RefreshToken: "refresh-1"}, nil
	}
	ericRefreshFn = func(token string) (ericTokenResponse, error) {
		refreshedWith = append(refreshedWith, token)
		return ericTokenResponse{AccessToken: fresher, RefreshToken: "refresh-2"}, nil
	}
	report := func(line string) { reported = append(reported, line) }

	// Run 1: nothing stored yet, so exactly one interactive login.
	result, err := RefreshEricAI(RefreshOptions{Reporter: report})
	if err != nil {
		t.Fatalf("the first run failed: %v", err)
	}
	if !strings.Contains(result.Status, "token refreshed") {
		t.Fatalf("the first run said %q, want a refreshed token", result.Status)
	}
	if result.Key != fresh || result.Minutes <= 0 {
		t.Fatalf("the first run returned key=%v minutes=%d, want the new token and its lifetime", result.Key != "", result.Minutes)
	}
	if logins != 1 || polls != 1 {
		t.Fatalf("logins/polls after the first run = %d/%d, want 1/1", logins, polls)
	}
	// The code and the URI have to arrive through the reporter, or a session that
	// needs a browser login can never be completed.
	joined := strings.Join(reported, "\n")
	if !strings.Contains(joined, "ABCD-EFGH") || !strings.Contains(joined, "https://microsoft.com/devicelogin") {
		t.Fatalf("the login instructions did not reach the reporter: %q", joined)
	}
	if got := ericLoadRefreshToken(); got != "refresh-1" {
		t.Fatalf("the refresh token from the login was not stored: %q", got)
	}
	if got := storedEricKey(t, configPath); got != fresh {
		t.Fatalf("the config key = %q, want the freshly minted access token", got)
	}

	// Run 2: the store has to buy silence. Stale again, so a refresh is due —
	// but no browser, which is the whole point.
	writeEricConfig(t, configPath, stale)
	second, err := RefreshEricAI(RefreshOptions{})
	if err != nil {
		t.Fatalf("the second run failed: %v", err)
	}
	if !strings.Contains(second.Status, "token refreshed") {
		t.Fatalf("the second run said %q, want a refreshed token", second.Status)
	}
	if logins != 1 {
		t.Fatalf("the second run opened another login (logins = %d); the refresh token was not reused", logins)
	}
	if len(refreshedWith) != 1 || refreshedWith[0] != "refresh-1" {
		t.Fatalf("the second run refreshed with %v, want the stored refresh-1", refreshedWith)
	}
	if got := storedEricKey(t, configPath); got != fresher {
		t.Fatalf("the config key = %q, want the refreshed access token", got)
	}
	// Entra rotates refresh tokens; the rotated one has to replace the old, or
	// the run after next starts from a token that is already spent.
	if got := ericLoadRefreshToken(); got != "refresh-2" {
		t.Fatalf("the rotated refresh token was not stored: %q", got)
	}
}

// TestEveryTokenRequestAsksForOfflineAccess pins the other half of the chain:
// Entra issues a refresh_token only when the original scope asked for
// offline_access, so dropping it from either request silently restores the
// login-every-run behaviour with no error anywhere.
func TestEveryTokenRequestAsksForOfflineAccess(t *testing.T) {
	forms := map[string]url.Values{
		"device code": ericDeviceCodeForm(),
		"refresh":     ericRefreshForm("stored-refresh-token"),
	}
	for name, form := range forms {
		scope := form.Get("scope")
		if !strings.Contains(scope, ericOfflineAccess) {
			t.Errorf("the %s request asked for scope %q, which lacks %s", name, scope, ericOfflineAccess)
		}
		if !strings.Contains(scope, ericScope) {
			t.Errorf("the %s request asked for scope %q, which lacks the API scope %s", name, scope, ericScope)
		}
	}
}

func writeEricConfig(t *testing.T, path, key string) {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"providers": map[string]any{
			EricAIProvider: map[string]any{"api_key": key, "base_url": "https://eric.example"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
}

func storedEricKey(t *testing.T, path string) string {
	t.Helper()
	decoded, err := configReadForTest(path)
	if err != nil {
		t.Fatal(err)
	}
	providers, _ := decoded["providers"].(map[string]any)
	item, _ := providers[EricAIProvider].(map[string]any)
	key, _ := item["api_key"].(string)
	return key
}
