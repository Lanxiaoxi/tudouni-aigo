package subagent

import (
	"strconv"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// TestChildIDsAreAlwaysUsableFileNames is the one property that cannot be
// recovered from: the id becomes a file name in the session store, so an id the
// store rejects is a delegation that fails at the save step, long after the child
// did the work.
//
// It is checked against the store's own validator rather than against a copy of
// the rule, because a copy is what would drift.
func TestChildIDsAreAlwaysUsableFileNames(t *testing.T) {
	parents := []string{
		"20260101-120000",
		"demo",
		"sub-20260101-120000-1",
		// Every character the store rejects, plus a length that forces the parent
		// segment to be cut. The id has to come back usable anyway.
		"a/b\\c:d*e?f|g<h>i\"j",
		strings.Repeat("x", 64),
		strings.Repeat("y", 200),
		"",
	}

	for _, parent := range parents {
		for _, seq := range []int{1, 2, 10, 999} {
			id := ChildID(parent, seq)
			if !state.IsValidSessionID(id) {
				t.Errorf("ChildID(%q, %d) = %q, which the session store rejects", parent, seq, id)
			}
			if !IsChildID(id) {
				t.Errorf("ChildID(%q, %d) = %q, which does not read as a child", parent, seq, id)
			}
			if !strings.HasSuffix(id, "-"+strconv.Itoa(seq)) {
				t.Errorf("ChildID(%q, %d) = %q, which does not end in the sequence number", parent, seq, id)
			}
		}
	}
}

// TestChildIDsOfOneParentDoNotCollide pins the other half: the sequence number is
// what makes two delegations from one session distinguishable, so it has to
// survive the truncation that a long parent id forces.
func TestChildIDsOfOneParentDoNotCollide(t *testing.T) {
	parent := strings.Repeat("z", 200)
	seen := map[string]bool{}
	for seq := 1; seq <= 50; seq++ {
		id := ChildID(parent, seq)
		if seen[id] {
			t.Fatalf("ChildID produced %q twice for %q", id, parent)
		}
		seen[id] = true
	}
}

// TestIsChildIDDoesNotClaimOrdinarySessions matters because the session picker
// stops listing anything this returns true for. A false positive hides somebody's
// real conversation from the list, which is worse than showing a subagent.
func TestIsChildIDDoesNotClaimOrdinarySessions(t *testing.T) {
	if IsChildID("20260101-120000") {
		t.Error("a timestamped session id was taken for a subagent")
	}
	if IsChildID("demo") {
		t.Error("a named session id was taken for a subagent")
	}
	if IsChildID("submarine") {
		t.Error("a session whose name merely starts with sub was taken for a subagent")
	}
	if !IsChildID("sub-20260101-120000-1") {
		t.Error("a child id was not recognised")
	}
}

// TestDepthComesOutOfMetadata is the whole reason depth is stored rather than
// tracked in memory: a restored child arrives with fresh runtime state, and a
// depth that started at zero again would let it delegate as if it were top-level.
func TestDepthComesOutOfMetadata(t *testing.T) {
	cases := []struct {
		name     string
		metadata map[string]any
		want     int
	}{
		{"absent means top level", map[string]any{}, 0},
		{"nil metadata means top level", nil, 0},
		{"int", map[string]any{DepthKey: 2}, 2},
		{"int64 from a decode", map[string]any{DepthKey: int64(2)}, 2},
		{"float64 from JSON", map[string]any{DepthKey: float64(2)}, 2},
		{"string from a hand-edited file", map[string]any{DepthKey: "2"}, 2},
		// A negative depth is nonsense rather than a way to escape the cap, and it
		// reads as top level — the safe direction, since a depth of 0 is the most
		// restricted position there is.
		{"negative is clamped", map[string]any{DepthKey: -5}, 0},
		{"unreadable is top level", map[string]any{DepthKey: "deep"}, 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			session := &state.Session{Metadata: tc.metadata}
			if got := DepthOf(session); got != tc.want {
				t.Fatalf("DepthOf = %d, want %d", got, tc.want)
			}
		})
	}
}

// TestChildMetadataCarriesLineage checks the three facts the child's own file has
// to be able to answer later: how deep it is, who delegated it, and what it was
// asked to do.
func TestChildMetadataCarriesLineage(t *testing.T) {
	parent := &state.Session{SessionID: "20260101-120000"}
	metadata := ChildMetadata(parent, 2, "look at the parser")

	if got := DepthOfMetadata(metadata); got != 2 {
		t.Errorf("depth = %d, want 2", got)
	}
	if got, _ := metadata[ParentKey].(string); got != "20260101-120000" {
		t.Errorf("parent = %v, want the delegating session id", metadata[ParentKey])
	}
	if got, _ := metadata[LabelKey].(string); got != "look at the parser" {
		t.Errorf("label = %v", metadata[LabelKey])
	}
}
