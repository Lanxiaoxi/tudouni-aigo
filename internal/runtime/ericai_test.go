package runtime

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

// ── ensure: every failure degrades, none blocks ──────────────────────────────

func TestEnsureDegradesWithAnExplanationWhenThereIsNoRoute(t *testing.T) {
	// EnsureEricAI reads the real user config; a machine without an ericai route
	// must get a sentence, not an error and not a partial start-up.
	message := EnsureEricAI()
	if message == "" {
		t.Fatal("a degraded run must still say something")
	}
	if strings.HasPrefix(message, "[ericai] token refreshed") {
		t.Fatal("a machine without the route cannot have had its token refreshed")
	}
}
