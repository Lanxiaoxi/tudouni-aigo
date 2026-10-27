package cggraph

// Staleness and deletion.
//
// Both are about the index agreeing with the working tree, which is the difference between
// an answer that is merely incomplete and one that is confidently wrong. The tests use the
// store directly rather than Index() so they need no cg-parse binary.

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// indexFile writes `body` to disk and records it as indexed with its real stat.
func indexFile(t *testing.T, db *DB, dir, rel, body string) string {
	t.Helper()
	path := writeTempSourceAt(t, dir, rel, body)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", rel, err)
	}
	err = db.WriteFile(context.Background(), FileRecord{
		Path:        path,
		ContentHash: hashOf(path),
		Language:    "go",
		Size:        info.Size(),
		ModifiedAt:  info.ModTime().UnixMilli(),
		NodeCount:   1,
	}, []StoredNode{{
		ID: "file:" + path, Kind: "file", Name: filepath.Base(path),
		FilePath: path, Language: "go", StartLine: 1,
	}}, nil, nil)
	if err != nil {
		t.Fatalf("write file record for %s: %v", rel, err)
	}
	return path
}

// TestStalenessCleanWhenTreeMatches is the case that must stay quiet: a current index must not
// tell the model its data is stale, or every answer gets discounted.
func TestStalenessCleanWhenTreeMatches(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	indexFile(t, db, dir, "a.go", "package a\n")
	indexFile(t, db, dir, "b.go", "package a\n")

	status, err := db.CheckStaleness(context.Background(), dir, nil)
	if err != nil {
		t.Fatalf("CheckStaleness: %v", err)
	}
	if status.Stale() {
		t.Errorf("stale with an unchanged tree: %+v", status)
	}
	if status.Summarise() != "" {
		t.Errorf("Summarise = %q, want empty for a current index", status.Summarise())
	}
	if status.Checked != 2 {
		t.Errorf("checked %d files, want 2", status.Checked)
	}
}

// TestStalenessDetectsModified is the common case: the agent edited a file and the index has
// not caught up.
func TestStalenessDetectsModified(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	path := indexFile(t, db, dir, "a.go", "package a\n")

	// Rewrite with a different size, which is what an edit looks like to a stat.
	if err := os.WriteFile(path, []byte("package a\n\nfunc Added() {}\n"), 0o644); err != nil {
		t.Fatalf("rewrite: %v", err)
	}

	status, err := db.CheckStaleness(context.Background(), dir, nil)
	if err != nil {
		t.Fatalf("CheckStaleness: %v", err)
	}
	if status.Changed != 1 {
		t.Errorf("Changed = %d, want 1 (%+v)", status.Changed, status)
	}
	if status.Summarise() == "" {
		t.Error("Summarise is empty for a stale index")
	}
}

// TestStalenessDetectsAddedAndRemoved covers the two directions a file list can diverge.
func TestStalenessDetectsAddedAndRemoved(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	removedPath := indexFile(t, db, dir, "gone.go", "package a\n")
	indexFile(t, db, dir, "stays.go", "package a\n")

	if err := os.Remove(removedPath); err != nil {
		t.Fatalf("remove: %v", err)
	}
	writeTempSourceAt(t, dir, "new.go", "package a\n")

	status, err := db.CheckStaleness(context.Background(), dir, nil)
	if err != nil {
		t.Fatalf("CheckStaleness: %v", err)
	}
	if status.Removed != 1 {
		t.Errorf("Removed = %d, want 1 (%+v)", status.Removed, status)
	}
	if status.Added != 1 {
		t.Errorf("Added = %d, want 1 (%+v)", status.Added, status)
	}
}

// TestStalenessIgnoresUnindexableFiles keeps the walk from reporting a file the indexer would
// refuse anyway: a `.txt` appearing must not make the index look stale.
func TestStalenessIgnoresUnindexableFiles(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	indexFile(t, db, dir, "a.go", "package a\n")
	writeTempSourceAt(t, dir, "notes.txt", "not source\n")
	writeTempSourceAt(t, dir, "node_modules/x.js", "module.exports = 1\n")

	status, err := db.CheckStaleness(context.Background(), dir, nil)
	if err != nil {
		t.Fatalf("CheckStaleness: %v", err)
	}
	if status.Added != 0 {
		t.Errorf("Added = %d, want 0: files the indexer would refuse are not divergence (%+v)",
			status.Added, status)
	}
}

// TestDeleteFileRemovesEverything is the gap that made deleted code keep answering queries:
// nodes, edges in both directions, refs and the row itself must all go.
func TestDeleteFileRemovesEverything(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

	gonePath := writeTempSourceAt(t, dir, "gone.go", "package a\n")
	staysPath := writeTempSourceAt(t, dir, "stays.go", "package a\n")

	// `stays.go` calls into `gone.go`, so deleting the latter must also drop the incoming
	// edge — otherwise the edge dangles at a node id that no longer exists.
	if err := db.WriteFile(ctx, FileRecord{
		Path: gonePath, ContentHash: "h1", Language: "go", Size: 10, ModifiedAt: 1, NodeCount: 1,
	}, []StoredNode{{ID: "fn:gone", Kind: "function", Name: "Gone", QualifiedName: "Gone",
		FilePath: gonePath, Language: "go", StartLine: 1}}, nil, nil); err != nil {
		t.Fatalf("write gone: %v", err)
	}
	if err := db.WriteFile(ctx, FileRecord{
		Path: staysPath, ContentHash: "h2", Language: "go", Size: 10, ModifiedAt: 1, NodeCount: 1,
	}, []StoredNode{{ID: "fn:stays", Kind: "function", Name: "Stays", QualifiedName: "Stays",
		FilePath: staysPath, Language: "go", StartLine: 1}}, []StoredEdge{{
		Source: "fn:stays", Target: "fn:gone", Kind: "calls",
	}}, nil); err != nil {
		t.Fatalf("write stays: %v", err)
	}

	if err := db.DeleteFile(ctx, gonePath); err != nil {
		t.Fatalf("DeleteFile: %v", err)
	}

	var nodes, edges int
	if err := db.sql.QueryRow(`SELECT COUNT(*) FROM nodes WHERE id = 'fn:gone'`).Scan(&nodes); err != nil {
		t.Fatalf("count nodes: %v", err)
	}
	if nodes != 0 {
		t.Errorf("%d nodes left for a deleted file", nodes)
	}
	if err := db.sql.QueryRow(`SELECT COUNT(*) FROM edges WHERE target = 'fn:gone'`).Scan(&edges); err != nil {
		t.Fatalf("count edges: %v", err)
	}
	if edges != 0 {
		t.Errorf("%d edges still point at a node from the deleted file", edges)
	}
	var files int
	if err := db.sql.QueryRow(`SELECT COUNT(*) FROM files WHERE path = ?`, gonePath).Scan(&files); err != nil {
		t.Fatalf("count files: %v", err)
	}
	if files != 0 {
		t.Error("the files row survived DeleteFile")
	}

	// The surviving file must be untouched.
	var stays int
	if err := db.sql.QueryRow(`SELECT COUNT(*) FROM nodes WHERE id = 'fn:stays'`).Scan(&stays); err != nil {
		t.Fatalf("count stays: %v", err)
	}
	if stays != 1 {
		t.Error("DeleteFile removed a node belonging to another file")
	}
}

// TestTouchFileRefreshesStat pins the cache behaviour that keeps a re-hashed-but-unchanged file
// on the stat-only fast path next run.
func TestTouchFileRefreshesStat(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

	path := indexFile(t, db, dir, "a.go", "package a\n")
	if err := db.TouchFile(ctx, path, 999, 12345); err != nil {
		t.Fatalf("TouchFile: %v", err)
	}
	var size, modifiedAt int64
	if err := db.sql.QueryRow(`SELECT size, modified_at FROM files WHERE path = ?`, path).
		Scan(&size, &modifiedAt); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if size != 999 || modifiedAt != 12345 {
		t.Errorf("stat = (%d, %d), want (999, 12345)", size, modifiedAt)
	}
}
