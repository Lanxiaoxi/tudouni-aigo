package context

import (
	"fmt"
	"path/filepath"
	"testing"
)

// TestClipStaysInsideItsBudget pins the accounting in `clip`.
//
// The separator is the newline **between** two lines, so a run of n lines owes n-1 of
// them. The code charged one to the first line instead and none to the rest, which
// under-counted by n-2 — and the snippet is then joined and sent, so the budget it was
// measured against was not the budget it met. The unlimited branch a few lines above
// keeps the correct account, which is how the two came apart.
//
// A budget of zero is not covered: it holds one character back for the ellipsis, so
// the degenerate case is one character over by design ("it was cut" has to be visible).
func TestClipStaysInsideItsBudget(t *testing.T) {
	lines := make([]string, 200)
	for index := range lines {
		lines[index] = "x"
	}
	for _, budget := range []int{1, 2, 10, 100, 1000} {
		maxChars := budget
		snippet := clip(lines, 1, len(lines), len(lines), &maxChars)
		if got := runeLen(snippet.Text); got > budget {
			t.Errorf("a budget of %d produced %d characters: %q", budget, got, snippet.Text)
		}
	}
}

// TestTheCacheEvictsTheOldestEntry: the eviction said FIFO and ranged over a map, which
// has no order at all — the entry it dropped could be the one that had just been read
// from disk, so the comment described a cache the code did not implement. Only the hit
// rate moves, which is exactly why a wrong comment here survives: nothing fails, the
// disk is simply read more often than the design says.
func TestTheCacheEvictsTheOldestEntry(t *testing.T) {
	store := OpenArtifactStore(filepath.Join(t.TempDir(), "artifacts"), nil)

	const extra = 8
	for index := 0; index < CacheEntries+extra; index++ {
		store.rememberLocked(fmt.Sprintf("art_%03d", index), "body")
	}

	for index := 0; index < CacheEntries+extra; index++ {
		id := fmt.Sprintf("art_%03d", index)
		_, present := store.cache[id]
		if want := index >= extra; present != want {
			t.Fatalf("%s present=%v, want %v: the cache is not holding the newest %d entries",
				id, present, want, CacheEntries)
		}
	}
}
