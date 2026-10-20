package cggraph

import (
	"context"
	"testing"
)

// TestImplementsRespectsArity is the check that a type with the right method NAMES but
// the wrong parameter/result counts is not reported as implementing an interface.
//
// This is the case CodeGraph gets wrong on this very repository: its own baseline
// contains `Client -> Backend` even though `Client.Kill` is `()` and `Backend.Kill` is
// `() error`. Go's compiler rejects that, so the edge is a false positive.
func TestImplementsRespectsArity(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

	// One interface needing `Kill() error` and `Close() error`.
	// One struct declaring `Kill()` and `Close() int` — right names, wrong results.
	nodes := []StoredNode{
		{ID: "interface:backend", Kind: "interface", Name: "Backend", QualifiedName: "Backend",
			FilePath: "p.go", Language: "go", StartLine: 1},
		{ID: "method:iface-kill", Kind: "method", Name: "Kill", QualifiedName: "Backend::Kill",
			FilePath: "p.go", Language: "go", StartLine: 2, Signature: "() error"},
		{ID: "method:iface-close", Kind: "method", Name: "Close", QualifiedName: "Backend::Close",
			FilePath: "p.go", Language: "go", StartLine: 3, Signature: "() error"},

		{ID: "struct:client", Kind: "struct", Name: "Client", QualifiedName: "Client",
			FilePath: "p.go", Language: "go", StartLine: 10},
		{ID: "method:client-kill", Kind: "method", Name: "Kill", QualifiedName: "Client::Kill",
			FilePath: "p.go", Language: "go", StartLine: 11, Signature: "()"},
		{ID: "method:client-close", Kind: "method", Name: "Close", QualifiedName: "Client::Close",
			FilePath: "p.go", Language: "go", StartLine: 12, Signature: "() int"},

		// A second struct whose arities DO match, to prove the pass still fires.
		{ID: "struct:good", Kind: "struct", Name: "goodBackend", QualifiedName: "goodBackend",
			FilePath: "p.go", Language: "go", StartLine: 20},
		{ID: "method:good-kill", Kind: "method", Name: "Kill", QualifiedName: "goodBackend::Kill",
			FilePath: "p.go", Language: "go", StartLine: 21, Signature: "() error"},
		{ID: "method:good-close", Kind: "method", Name: "Close", QualifiedName: "goodBackend::Close",
			FilePath: "p.go", Language: "go", StartLine: 22, Signature: "() error"},
	}
	if err := db.WriteFile(ctx, FileRecord{
		Path: "p.go", ContentHash: "h", Language: "go", NodeCount: len(nodes),
	}, nodes, []StoredEdge{
		// The `contains` edges extraction would have written for same-file types.
		{Source: "interface:backend", Target: "method:iface-kill", Kind: "contains"},
		{Source: "interface:backend", Target: "method:iface-close", Kind: "contains"},
		{Source: "struct:client", Target: "method:client-kill", Kind: "contains"},
		{Source: "struct:client", Target: "method:client-close", Kind: "contains"},
		{Source: "struct:good", Target: "method:good-kill", Kind: "contains"},
		{Source: "struct:good", Target: "method:good-close", Kind: "contains"},
	}, nil); err != nil {
		t.Fatalf("write: %v", err)
	}

	resolver := NewResolver(db)
	if _, err := resolver.SynthesizeGoImplements(ctx); err != nil {
		t.Fatalf("synthesize: %v", err)
	}

	rows, err := db.SQL().Query(`SELECT source FROM edges WHERE kind = 'implements'`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	got := map[string]bool{}
	for rows.Next() {
		var source string
		rows.Scan(&source)
		got[source] = true
	}

	if got["struct:client"] {
		t.Error("Client implements Backend, but its Kill returns nothing where Backend's returns error")
	}
	if !got["struct:good"] {
		t.Error("goodBackend does not implement Backend, but every arity matches")
	}
}

// TestImplementsSkipsEmptyInterface pins the `any` rule: an interface with no methods
// would otherwise be implemented by every type in the tree.
func TestImplementsSkipsEmptyInterface(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

	nodes := []StoredNode{
		{ID: "interface:any", Kind: "interface", Name: "any", QualifiedName: "any",
			FilePath: "p.go", Language: "go", StartLine: 1},
		{ID: "struct:s", Kind: "struct", Name: "S", QualifiedName: "S",
			FilePath: "p.go", Language: "go", StartLine: 5},
		{ID: "method:m", Kind: "method", Name: "M", QualifiedName: "S::M",
			FilePath: "p.go", Language: "go", StartLine: 6, Signature: "()"},
	}
	if err := db.WriteFile(ctx, FileRecord{
		Path: "p.go", ContentHash: "h", Language: "go", NodeCount: len(nodes),
	}, nodes, []StoredEdge{
		{Source: "struct:s", Target: "method:m", Kind: "contains"},
	}, nil); err != nil {
		t.Fatalf("write: %v", err)
	}

	resolver := NewResolver(db)
	added, err := resolver.SynthesizeGoImplements(ctx)
	if err != nil {
		t.Fatalf("synthesize: %v", err)
	}
	if added != 0 {
		t.Errorf("added %d implements edges into an empty interface, want 0", added)
	}
}

// TestMethodOwnerLinksCrossFile is the Go rule that a method and its receiver type may
// be declared in different files of one package.
func TestMethodOwnerLinksCrossFile(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

	// `User` in one file, `(*User).Save` in another, same directory.
	if err := db.WriteFile(ctx, FileRecord{
		Path: "store/user.go", ContentHash: "h1", Language: "go", NodeCount: 1,
	}, []StoredNode{
		{ID: "struct:user", Kind: "struct", Name: "User", QualifiedName: "User",
			FilePath: "store/user.go", Language: "go", StartLine: 3},
	}, nil, nil); err != nil {
		t.Fatalf("write user: %v", err)
	}
	if err := db.WriteFile(ctx, FileRecord{
		Path: "store/user_store.go", ContentHash: "h2", Language: "go", NodeCount: 1,
	}, []StoredNode{
		{ID: "method:save", Kind: "method", Name: "Save", QualifiedName: "User::Save",
			FilePath: "store/user_store.go", Language: "go", StartLine: 5, Signature: "() error"},
	}, nil, nil); err != nil {
		t.Fatalf("write method: %v", err)
	}

	resolver := NewResolver(db)
	added, err := resolver.SynthesizeGoMethodOwners(ctx)
	if err != nil {
		t.Fatalf("synthesize owners: %v", err)
	}
	if added != 1 {
		t.Fatalf("added %d owner edges, want 1", added)
	}

	var source string
	if err := db.SQL().QueryRow(
		`SELECT source FROM edges WHERE target = 'method:save' AND kind = 'contains'`).Scan(&source); err != nil {
		t.Fatalf("read edge: %v", err)
	}
	if source != "struct:user" {
		t.Errorf("Save owned by %q, want struct:user", source)
	}
}

// A same-named type in a DIFFERENT package must not claim the method.
func TestMethodOwnerRespectsPackageBoundary(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

	if err := db.WriteFile(ctx, FileRecord{
		Path: "other/user.go", ContentHash: "h1", Language: "go", NodeCount: 1,
	}, []StoredNode{
		{ID: "struct:user-other", Kind: "struct", Name: "User", QualifiedName: "User",
			FilePath: "other/user.go", Language: "go", StartLine: 3},
	}, nil, nil); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := db.WriteFile(ctx, FileRecord{
		Path: "store/user_store.go", ContentHash: "h2", Language: "go", NodeCount: 1,
	}, []StoredNode{
		{ID: "method:save", Kind: "method", Name: "Save", QualifiedName: "User::Save",
			FilePath: "store/user_store.go", Language: "go", StartLine: 5},
	}, nil, nil); err != nil {
		t.Fatalf("write: %v", err)
	}

	resolver := NewResolver(db)
	added, err := resolver.SynthesizeGoMethodOwners(ctx)
	if err != nil {
		t.Fatalf("synthesize: %v", err)
	}
	if added != 0 {
		t.Errorf("added %d owner edges across a package boundary, want 0", added)
	}
}
