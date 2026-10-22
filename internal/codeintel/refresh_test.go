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
	"runtime"
	"testing"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cggraph"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
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
	report, err := refresher.EnsureFresh(context.Background(), MaxInlineTool)
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

	report, err := New(dir, "").EnsureFresh(context.Background(), MaxInlineTool)
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
	report, err := refresher.EnsureFresh(context.Background(), 2)
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
	report, err := New(t.TempDir(), "").EnsureFresh(context.Background(), MaxInlineTool)
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

// TestWarmupWithoutParserDoesNothing pins the no-op: a build that cannot rebuild
// must not even pay the staleness scan, so the warm-up's own cost never becomes
// the latency it exists to prevent. The probe is the database file — a pass that
// actually ran would have opened (and therefore created) it on its way to
// "unavailable", so a missing file is proof nothing ran.
func TestWarmupWithoutParserDoesNothing(t *testing.T) {
	dir := t.TempDir()
	refresher := New(dir, "")
	refresher.Warmup()

	// Warmup with no parser returns before starting a goroutine, so the check is
	// a single stat after a short settle: if the pass had run it would have
	// created the database, and it is not there.
	time.Sleep(50 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(dir, cggraph.IndexDirName, cggraph.DefaultDBName)); err == nil {
		t.Fatal("the warm-up touched the index database despite having no parser")
	}
}

// TestWarmupRebuildsBehindIndex is the real pass, gated on the parser binary the
// same way the decode tests are gated on theirs.
func TestWarmupRebuildsBehindIndex(t *testing.T) {
	binary := findCGBinary(t)
	if binary == "" {
		t.Skip("cg-parse not found")
	}

	dir := t.TempDir()
	db, err := cggraph.Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	path := seedIndex(t, db, dir, "a.go", "package a\n")
	db.Close()

	// The divergence a warm-up is meant to catch: a file changed after the index
	// was written.
	if err := os.WriteFile(path, []byte("package a\n\nfunc Added() {}\n"), 0o644); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if report, err := New(dir, binary).CheckOnly(context.Background()); err != nil || report.Files != 1 {
		t.Fatalf("setup: wanted exactly one divergent file, got %+v / %v", report, err)
	}

	refresher := New(dir, binary)
	refresher.Warmup()

	// Warmup is fire-and-forget, so poll until the pass has visibly finished:
	// the divergence is gone.
	deadline := time.Now().Add(30 * time.Second)
	for {
		report, err := refresher.CheckOnly(context.Background())
		if err != nil {
			t.Fatalf("CheckOnly: %v", err)
		}
		if report.Files == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the warm-up did not bring the index up to date (still %d divergent)", report.Files)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// findCGBinary locates the platform's parser binary, for a test that cannot
// import the package that knows where it lives (that package imports this one's
// tool, and the tool imports this one — a cycle).
func findCGBinary(t *testing.T) string {
	t.Helper()
	if env := os.Getenv("CG_PARSE_BIN"); env != "" {
		return env
	}
	triple := ""
	switch {
	case runtime.GOOS == "windows" && runtime.GOARCH == "amd64":
		triple = "x86_64-pc-windows-msvc"
	case runtime.GOOS == "linux" && runtime.GOARCH == "amd64":
		triple = "x86_64-unknown-linux-musl"
	}
	if triple == "" {
		return ""
	}
	name := "cg-parse"
	if runtime.GOOS == "windows" {
		name = "cg-parse.exe"
	}
	candidate := filepath.Join(paths.VendorCG(), triple, name)
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate
	}
	return ""
}
