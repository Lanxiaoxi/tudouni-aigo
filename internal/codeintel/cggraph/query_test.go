package cggraph

import (
	"context"
	"testing"
)

// queryDB builds a three-hop call chain plus the containment edge every file has.
//
// The chain is the shape the old implementation got wrong: it keyed the second hop
// by display name, which never matches an edge target, so depth 2 silently returned
// depth 1's answer.
func queryDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	ctx := context.Background()

	nodes := []StoredNode{
		{ID: "file:a", Kind: "file", Name: "a.go", FilePath: "a.go", Language: "go", StartLine: 1},
		{ID: "fn:leaf", Kind: "function", Name: "Leaf", QualifiedName: "Leaf", FilePath: "a.go", Language: "go", StartLine: 2},
		{ID: "fn:mid", Kind: "function", Name: "Mid", QualifiedName: "Mid", FilePath: "b.go", Language: "go", StartLine: 2},
		{ID: "fn:top", Kind: "function", Name: "Top", QualifiedName: "Top", FilePath: "c.go", Language: "go", StartLine: 2},
	}
	if err := db.WriteFile(ctx, FileRecord{Path: "a.go", ContentHash: "h", Language: "go", NodeCount: 2},
		nodes[:2], []StoredEdge{
			{Source: "file:a", Target: "fn:leaf", Kind: "contains"},
			{Source: "fn:mid", Target: "fn:leaf", Kind: "calls"},
		}, nil); err != nil {
		t.Fatalf("write a.go: %v", err)
	}
	if err := db.WriteFile(ctx, FileRecord{Path: "b.go", ContentHash: "h", Language: "go", NodeCount: 1},
		nodes[2:3], []StoredEdge{
			{Source: "fn:top", Target: "fn:mid", Kind: "calls"},
		}, nil); err != nil {
		t.Fatalf("write b.go: %v", err)
	}
	if err := db.WriteFile(ctx, FileRecord{Path: "c.go", ContentHash: "h", Language: "go", NodeCount: 1},
		nodes[3:], nil, nil); err != nil {
		t.Fatalf("write c.go: %v", err)
	}
	return db
}

func TestImpactReachesTheSecondHopAndSkipsContainment(t *testing.T) {
	db := queryDB(t)
	ctx := context.Background()

	one, err := db.Impact(ctx, "fn:leaf", 1)
	if err != nil {
		t.Fatalf("impact depth 1: %v", err)
	}
	if len(one) != 1 || one[0].NodeID != "fn:mid" {
		t.Fatalf("depth 1 = %+v, want only fn:mid", one)
	}

	two, err := db.Impact(ctx, "fn:leaf", 2)
	if err != nil {
		t.Fatalf("impact depth 2: %v", err)
	}
	got := map[string]bool{}
	for _, site := range two {
		if site.Kind == "contains" {
			t.Errorf("impact listed containment as a dependent: %+v", site)
		}
		got[site.NodeID] = true
	}
	if !got["fn:mid"] || !got["fn:top"] {
		t.Errorf("depth 2 = %v, want both fn:mid and fn:top", got)
	}
	if len(two) != 2 {
		t.Errorf("depth 2 returned %d sites, want 2", len(two))
	}
}

// TestFindSymbolsTreatsUnderscoreLiterally: `_` and `%` are LIKE wildcards, but they
// are also ordinary characters in identifiers. A query for fmt_Print must not return
// fmtXPrint, and a bare `%` must not return the whole index.
func TestFindSymbolsTreatsUnderscoreLiterally(t *testing.T) {
	db := queryDB(t)
	ctx := context.Background()

	nodes := []StoredNode{
		{ID: "fn:literal", Kind: "function", Name: "fmt_Print", QualifiedName: "fmt_Print", FilePath: "d.go", Language: "go", StartLine: 1},
		{ID: "fn:wild", Kind: "function", Name: "fmtXPrint", QualifiedName: "fmtXPrint", FilePath: "d.go", Language: "go", StartLine: 2},
	}
	if err := db.WriteFile(ctx, FileRecord{Path: "d.go", ContentHash: "h", Language: "go", NodeCount: 2},
		nodes, nil, nil); err != nil {
		t.Fatalf("write d.go: %v", err)
	}

	found, err := db.FindSymbols(ctx, "fmt_Print", 20)
	if err != nil {
		t.Fatalf("find fmt_Print: %v", err)
	}
	if len(found) != 1 || found[0].ID != "fn:literal" {
		t.Errorf("fmt_Print matched %+v, want only the literal name", found)
	}

	found, err = db.FindSymbols(ctx, "%", 20)
	if err != nil {
		t.Fatalf("find %%: %v", err)
	}
	if len(found) != 0 {
		t.Errorf("a bare %% matched %d symbols; it must match only a literal %%", len(found))
	}
}
