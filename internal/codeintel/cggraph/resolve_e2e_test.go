package cggraph

import (
	"context"
	"testing"
)

// TestImportNarrowingEndToEnd is the check that the machinery is actually wired in:
// unit tests can all pass while the resolver never calls narrowToImport.
func TestImportNarrowingEndToEnd(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	ctx := context.Background()

	// Two files in different packages, each defining `Tool`. The importing file
	// imports only the first, so `tools.Tool` must bind to the first and never the
	// second.
	nodes := []StoredNode{
		{ID: "file:a", Kind: "file", Name: "a.go", FilePath: "internal/tools/a.go", Language: "go", StartLine: 1},
		{ID: "struct:tool-a", Kind: "struct", Name: "Tool", QualifiedName: "Tool",
			FilePath: "internal/tools/a.go", Language: "go", StartLine: 5},
		{ID: "file:b", Kind: "file", Name: "b.go", FilePath: "internal/other/b.go", Language: "go", StartLine: 1},
		{ID: "struct:tool-b", Kind: "struct", Name: "Tool", QualifiedName: "Tool",
			FilePath: "internal/other/b.go", Language: "go", StartLine: 5},
		{ID: "file:c", Kind: "file", Name: "c.go", FilePath: "internal/app/c.go", Language: "go", StartLine: 1},
		{ID: "function:use", Kind: "function", Name: "use", QualifiedName: "use",
			FilePath: "internal/app/c.go", Language: "go", StartLine: 10},
		{ID: "import:tools", Kind: "import", Name: "github.com/x/y/internal/tools",
			QualifiedName: "github.com/x/y/internal/tools",
			FilePath:      "internal/app/c.go", Language: "go", StartLine: 3,
			Signature: `"github.com/x/y/internal/tools"`},
	}
	for _, node := range nodes {
		if err := db.WriteFile(ctx, FileRecord{
			Path: node.FilePath, ContentHash: "h", Language: "go", NodeCount: 1,
		}, []StoredNode{node}, nil, nil); err != nil {
			t.Fatalf("write node %s: %v", node.ID, err)
		}
	}

	// One qualified ref that the import narrows, and one that it does not.
	refs := []StoredRef{
		{FromNodeID: "function:use", ReferenceName: "tools.Tool", ReferenceKind: "references",
			Line: 12, Column: 2, FilePath: "internal/app/c.go", Language: "go"},
	}
	if err := db.WriteFile(ctx, FileRecord{
		Path: "internal/app/c.go", ContentHash: "h2", Language: "go", NodeCount: 2,
	}, nil, nil, refs); err != nil {
		t.Fatalf("write refs: %v", err)
	}
	// WriteFile deleted the file's nodes above (it replaces the file's rows), so put
	// them back — the refs row survives because it was written in the same call.
	if err := db.WriteFile(ctx, FileRecord{
		Path: "internal/app/c.go", ContentHash: "h2", Language: "go", NodeCount: 2,
	}, []StoredNode{
		{ID: "file:c", Kind: "file", Name: "c.go", FilePath: "internal/app/c.go", Language: "go", StartLine: 1},
		{ID: "function:use", Kind: "function", Name: "use", QualifiedName: "use",
			FilePath: "internal/app/c.go", Language: "go", StartLine: 10},
		{ID: "import:tools", Kind: "import", Name: "github.com/x/y/internal/tools",
			QualifiedName: "github.com/x/y/internal/tools",
			FilePath:      "internal/app/c.go", Language: "go", StartLine: 3,
			Signature: `"github.com/x/y/internal/tools"`},
	}, nil, refs); err != nil {
		t.Fatalf("rewrite: %v", err)
	}

	resolver := NewResolver(db)
	resolver.SetRepoPrefix("github.com/x/y")
	stats, err := resolver.ResolveAll(ctx)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if stats.Resolved != 1 {
		t.Fatalf("resolved = %d, want 1 (stats: %+v)", stats.Resolved, stats)
	}

	var target string
	if err := db.SQL().QueryRow(`SELECT target FROM edges WHERE source = 'function:use'`).Scan(&target); err != nil {
		t.Fatalf("read edge: %v", err)
	}
	if target != "struct:tool-a" {
		t.Errorf("bound to %q, want struct:tool-a (the imported package's Tool)", target)
	}
}
