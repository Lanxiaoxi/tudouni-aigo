package context

import (
	"strings"
	"testing"
)

// TestAMissingLedgerEntryStillSendsTheBody covers the one case where the renderer had
// nothing to look up.
//
// When the context state fails to decode, the ledger is dropped while the history keeps
// its artifact ids. Falling back to `message["content"]` looks like "send a little too
// much" — the comment said so — but in this shape that field **is** the reference line,
// `[artifact art_… · 12480 字符 · read_file]`, and not a byte of body. Every tool result
// in the session then became a pointer the model could not follow, silently, and the
// "the content is gone, run it again" line never appeared either.
func TestAMissingLedgerEntryStillSendsTheBody(t *testing.T) {
	h := newHarness(t, windowOf(100_000))
	artifact, err := h.store.Create(bigText(40), "file",
		ArtifactSource{Tool: "read_file"}, map[string]any{"lines": 40})
	if err != nil {
		t.Fatal(err)
	}
	// Deliberately **not** added to the manager: this is the state after a ledger that
	// did not restore.
	message := map[string]any{
		"role":        "tool",
		"content":     BuildReference(artifact.ID, artifact.Chars, "read_file"),
		"artifact_id": artifact.ID,
	}

	rendered := h.renderer.RenderToolContent(message)
	if rendered == message["content"] {
		t.Fatalf("the reference line was sent as the body: %q", rendered)
	}
	if !strings.Contains(rendered, "第 1 行") {
		t.Errorf("the body did not reach the payload: %q", rendered)
	}
}
