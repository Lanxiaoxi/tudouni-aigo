package runtime

import (
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/subagent"
)

// ── the key a delegated subagent ships ─────────────────────────────────────────
//
// `ResolveChild` reads the key from the catalogue, and the catalogue is read once
// at open. The session's live client, by contrast, is the copy that `authCheck`
// and `RecoverAuth` keep current for the life of the process — so a session left
// open past its token's ~70 minute lifetime is healthy on screen while the
// catalogue's `api_key` is exactly one refresh behind. The reported symptom: the
// parent answers every message, the moment it delegates the child ships the
// catalogue's dead token, earns one 401, and has no recovery hook to retry with.
//
// These tests pin the repair from the child's side: a child resolved while the
// parent is on a refreshed token must carry the token the parent is **sending**,
// not the one the catalogue held at open.

// TestResolveChildShipsTheTokenTheParentIsSending reproduces the refresh that a
// long session earns on its own and asks for a child immediately after.
//
// Both facts are asserted, and the second is the one that used to fail: the
// catalogue **still holds the old token** — nothing re-reads it — so a resolver
// that reads the catalogue is, after this refresh, guaranteed to hand the child
// a token the endpoint already revoked.
func TestResolveChildShipsTheTokenTheParentIsSending(t *testing.T) {
	old := minutesFromNow(2) // inside RefreshThreshold: the pre-request check fires
	fresh := freshToken(t, 70, "the-refreshed-token")

	h := newAuthHarness(t, old, true)
	h.stubRefresh(t, fresh, "rotated-refresh")

	// The parent's next turn starts with the pre-request check, and it is that
	// check — not anything about the child — that moves the client forward.
	h.runtime.authCheck()

	if got := h.runtime.Chat.Route().APIKey; got != fresh {
		t.Fatalf("the parent's client is on %q after the check, want the refreshed token", got)
	}
	// The catalogue is the fossil: the refresh wrote the config file and the live
	// client, never the registry this resolver reads.
	catalogueRoute, ok := h.runtime.Catalog.ProviderByName(EricAIProvider)
	if !ok {
		t.Fatal("the test config's route disappeared from the catalogue")
	}
	if got := catalogueRoute.APIKey; got != old {
		t.Fatalf("the catalogue was re-read by the refresh (%q), so the test no longer models a long session", got)
	}

	child, err := h.runtime.ResolveChild(subagent.Route{}, "eric-chat", EricAIProvider)
	if err != nil {
		t.Fatalf("resolving the child failed: %v", err)
	}
	if got := child.Provider.APIKey; got != fresh {
		t.Errorf("the child ships %q, want the token the parent is sending — the catalogue's copy is %d minutes past its refresh", got, 70)
	}
}

// TestResolveChildOnTheParentRouteKeepsTheCatalogueKeyWhenThereIsNoDrift covers
// the session nothing has happened in: one token, one age, catalogue and live
// client in agreement. The repair must not change what a healthy session hands
// a child — the child still rides the same route, model and key it always did.
func TestResolveChildOnTheParentRouteKeepsTheCatalogueKeyWhenThereIsNoDrift(t *testing.T) {
	key := freshToken(t, 70, "the-token-at-open")
	h := newAuthHarness(t, key, true)

	// No refresh is due: the check is a no-op, and the catalogue and the live
	// client agree on the token.
	h.runtime.authCheck()
	if h.refreshes != 0 {
		t.Fatalf("a fresh token was refreshed %d times, want 0", h.refreshes)
	}

	child, err := h.runtime.ResolveChild(subagent.Route{}, "eric-chat", EricAIProvider)
	if err != nil {
		t.Fatalf("resolving the child failed: %v", err)
	}
	if got := child.Provider.APIKey; got != key {
		t.Errorf("the child ships %q, want the token the session opened on", got)
	}
}
