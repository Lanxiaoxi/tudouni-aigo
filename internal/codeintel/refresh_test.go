package codeintel

// The freshness trigger.
//
// The tests that matter are the ones about *deciding*: clean means do nothing, a small
// divergence means rebuild inline, a large one means refuse and say so. The rebuild itself is
// exercised by the gated end-to-end test, because it needs the parser binary.

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cggraph"
)

// seedIndex writes `body` to `rel` and records it as indexed with its real stat.
func seedIndex(t *testing.T, db *cggraph.DB, dir, rel, body string) string {
	t.Helper()
	path := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", rel, err)
	}
	err = db.WriteFile(context.Background(), cggraph.FileRecord{
		Path: path, ContentHash: "h-" + rel, Language: "go",
		Size: info.Size(), ModifiedAt: info.ModTime().UnixMilli(), NodeCount: 1,
	}, []cggraph.StoredNode{{
		ID: "file:" + path, Kind: "file", Name: filepath.Base(path),
		FilePath: path, Language: "go", StartLine: 1,
	}}, nil, nil)
	if err != nil {
		t.Fatalf("seed %s: %v", rel, err)
	}
	return path
}

// TestEnsureFreshCurrentDoesNothing is the common case and must be free: a current index is not
// rebuilt, and the report says nothing happened.
func TestEnsureFreshCurrentDoesNothing(t *testing.T) {
	dir := t.TempDir()
	db, err := cggraph.Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	seedIndex(t, db, dir, "a.go", "package a\n")
	db.Close()

	// parserPath is deliberately wrong-but-present: if the implementation rebuilt anything, the
	// exec would fail and the state would be Failed instead of Current.
	refresher := New(dir, filepath.Join(dir, "does-not-exist"))
	report, err := refresher.EnsureFresh(context.Background())
	if err != nil {
		t.Fatalf("EnsureFresh: %v", err)
	}
	if report.State != Current {
		t.Errorf("state = %s, want current (%+v)", report.State, report)
	}
	if report.Files != 0 {
		t.Errorf("Files = %d, want 0", report.Files)
	}
}

// TestEnsureFreshWithoutParserReportsUnavailable pins the degradation path: a build with no
// parser binary must report that it cannot refresh, not claim the index is current and not fail
// the query.
func TestEnsureFreshWithoutParserReportsUnavailable(t *testing.T) {
	dir := t.TempDir()
	db, err := cggraph.Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	path := seedIndex(t, db, dir, "a.go", "package a\n")
	db.Close()

	if err := os.WriteFile(path, []byte("package a\n\nfunc Added() {}\n"), 0o644); err != nil {
		t.Fatalf("rewrite: %v", err)
	}

	report, err := New(dir, "").EnsureFresh(context.Background())
	if err != nil {
		t.Fatalf("EnsureFresh: %v", err)
	}
	if report.State != Unavailable {
		t.Errorf("state = %s, want unavailable", report.State)
	}
	if report.Files != 1 {
		t.Errorf("Files = %d, want 1 (the divergence is still reported)", report.Files)
	}
	if report.Detail == "" {
		t.Error("no explanation for an index that cannot be refreshed")
	}
}

// TestEnsureFreshRefusesLargeDivergence is the latency guard: a branch switch is not something
// to rebuild inside a query.
func TestEnsureFreshRefusesLargeDivergence(t *testing.T) {
	dir := t.TempDir()
	db, err := cggraph.Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	var paths []string
	for _, name := range []string{"a.go", "b.go", "c.go", "d.go"} {
		paths = append(paths, seedIndex(t, db, dir, name, "package a\n"))
	}
	db.Close()

	for _, path := range paths {
		if err := os.WriteFile(path, []byte("package a\n\nfunc X() {}\n"), 0o644); err != nil {
			t.Fatalf("rewrite: %v", err)
		}
	}

	refresher := New(dir, filepath.Join(dir, "does-not-exist"))
	refresher.SetMaxInline(2)
	report, err := refresher.EnsureFresh(context.Background())
	if err != nil {
		t.Fatalf("EnsureFresh: %v", err)
	}
	if report.State != StaleTooLarge {
		t.Errorf("state = %s, want stale-too-large", report.State)
	}
	if report.Files != 4 {
		t.Errorf("Files = %d, want 4", report.Files)
	}
	if report.Detail == "" {
		t.Error("no explanation for refusing the rebuild")
	}
}

// TestCheckOnlyNeverWrites pins the read-only variant: a caller that only wants to display
// freshness must not rebuild.
func TestCheckOnlyNeverWrites(t *testing.T) {
	dir := t.TempDir()
	db, err := cggraph.Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	path := seedIndex(t, db, dir, "a.go", "package a\n")
	db.Close()

	if err := os.WriteFile(path, []byte("package a\n\nfunc Added() {}\n"), 0o644); err != nil {
		t.Fatalf("rewrite: %v", err)
	}

	refresher := New(dir, filepath.Join(dir, "does-not-exist"))
	report, err := refresher.CheckOnly(context.Background())
	if err != nil {
		t.Fatalf("CheckOnly: %v", err)
	}
	if report.State != StaleTooLarge {
		t.Errorf("state = %s, want a stale report", report.State)
	}

	// The index must still be stale afterwards: CheckOnly is not EnsureFresh.
	again, err := refresher.CheckOnly(context.Background())
	if err != nil {
		t.Fatalf("CheckOnly: %v", err)
	}
	if again.Files != report.Files {
		t.Errorf("divergence changed between checks (%d then %d): CheckOnly wrote something",
			report.Files, again.Files)
	}
}

// TestEnsureFreshWithoutIndex reports unavailable rather than panicking, so a workspace that was
// never indexed still answers.
func TestEnsureFreshWithoutIndex(t *testing.T) {
	report, err := New(t.TempDir(), "").EnsureFresh(context.Background())
	if err != nil {
		t.Fatalf("EnsureFresh: %v", err)
	}
	if report.State != Unavailable {
		t.Errorf("state = %s, want unavailable", report.State)
	}
}

// TestStateRendering keeps log lines honest: every state must name itself.
func TestStateRendering(t *testing.T) {
	for _, state := range []State{Current, Synced, StaleTooLarge, Unavailable, Failed} {
		if state.String() == "unknown" {
			t.Errorf("state %d renders as unknown", state)
		}
	}
}
