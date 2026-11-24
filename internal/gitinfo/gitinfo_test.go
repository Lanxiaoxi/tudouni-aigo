package gitinfo

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func needGit(t *testing.T) {
	t.Helper()
	if !Available() {
		t.Skip("git is not on PATH")
	}
}

// git runs a git command in dir with a fixed identity and no global config.
func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=T", "-c", "user.email=t@example.com",
		"-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main"}, args...)...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newRepo(t *testing.T) string {
	t.Helper()
	needGit(t)
	dir := t.TempDir()
	git(t, dir, "init", "-q")
	return dir
}

func find(t *testing.T, status *Status, path string) Entry {
	t.Helper()
	for _, e := range status.Entries {
		if e.Path == path {
			return e
		}
	}
	t.Fatalf("no entry for %q in %+v", path, status.Entries)
	return Entry{}
}

func TestParseStatusPorcelainV2(t *testing.T) {
	out := strings.Join([]string{
		"# branch.oid 0123456789abcdef0123456789abcdef01234567",
		"# branch.head main",
		"# branch.upstream origin/main",
		"# branch.ab +3 -2",
		"1 MM N... 100644 100644 100644 aaaa bbbb both.go",
		"2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.go",
		"old name.go",
		"u UU N... 100644 100644 100644 100644 a b c conflict.go",
		"? new file.txt",
		"",
	}, "\x00")
	p := parseStatus(out)
	if p.Branch != "main" || p.Upstream != "origin/main" || p.Ahead != 3 || p.Behind != 2 || p.Detached || p.Unborn {
		t.Fatalf("header: %+v", p)
	}
	if len(p.Entries) != 4 {
		t.Fatalf("entries: %+v", p.Entries)
	}
	if e := p.Entries[0]; e.Index != "M" || e.Worktree != "M" || e.Path != "both.go" {
		t.Errorf("MM: %+v", e)
	}
	if e := p.Entries[1]; e.Path != "new name.go" || e.OrigPath != "old name.go" || e.Index != "R" || e.Worktree != "." {
		t.Errorf("rename: %+v", e)
	}
	if e := p.Entries[2]; !e.Conflict || e.Index != "U" || e.Path != "conflict.go" {
		t.Errorf("conflict: %+v", e)
	}
	if e := p.Entries[3]; !e.Untracked || e.Index != "?" || e.Path != "new file.txt" {
		t.Errorf("untracked: %+v", e)
	}

	detached := parseStatus("# branch.oid abc\x00# branch.head (detached)\x00")
	if !detached.Detached || detached.Branch != "" {
		t.Errorf("detached: %+v", detached)
	}
	unborn := parseStatus("# branch.oid (initial)\x00# branch.head main\x00")
	if !unborn.Unborn || unborn.OID != "" {
		t.Errorf("unborn: %+v", unborn)
	}
}

func TestRelativize(t *testing.T) {
	if p, ok := relativize("ws/a.go", "ws/", false); !ok || p != "a.go" {
		t.Errorf("inside: %q %v", p, ok)
	}
	if _, ok := relativize("other/a.go", "ws/", false); ok {
		t.Error("outside must be dropped")
	}
	if p, _ := relativize("other/a.go", "ws/", true); p != "../other/a.go" {
		t.Errorf("origin outside: %q", p)
	}
	if p, _ := relativize("a/other.go", "a/ws/", true); p != "../other.go" {
		t.Errorf("sibling: %q", p)
	}
	if p, ok := relativize("x.go", "", false); !ok || p != "x.go" {
		t.Errorf("root workspace: %q %v", p, ok)
	}
}

func TestCleanRel(t *testing.T) {
	for _, bad := range []string{"", ".", "..", "../x", "/abs", "a/../../x", `C:\x`, "C:/x"} {
		if _, err := cleanRel(bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
	if got, err := cleanRel(`a\b/./c.go`); err != nil || got != "a/b/c.go" {
		t.Errorf("clean: %q %v", got, err)
	}
	// A leading dash is a name, not an option (the `--` handles it in git).
	if got, err := cleanRel("--output=x"); err != nil || got != "--output=x" {
		t.Errorf("dash: %q %v", got, err)
	}
}

func TestNotARepoIsNotAnError(t *testing.T) {
	needGit(t)
	// A temp dir is outside any repository unless the machine's temp dir is itself
	// inside one, which would make this test meaningless.
	dir := t.TempDir()
	if _, err := Open(context.Background(), dir); err != ErrNotRepo {
		t.Skipf("temp dir is inside a repository (%v)", err)
	}
	status, err := GetStatus(context.Background(), dir)
	if err != nil || status.Repo || len(status.Entries) != 0 {
		t.Fatalf("status = %+v, err = %v", status, err)
	}
}

func TestStatusStagedAndUnstagedSameFile(t *testing.T) {
	dir := newRepo(t)
	write(t, filepath.Join(dir, "a.txt"), "one\n")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-q", "-m", "init")

	write(t, filepath.Join(dir, "a.txt"), "one\ntwo\n")
	git(t, dir, "add", "a.txt")
	write(t, filepath.Join(dir, "a.txt"), "one\ntwo\nthree\n")
	write(t, filepath.Join(dir, "dir", "new.txt"), "n\n")

	status, err := GetStatus(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Repo || status.Branch != "main" || status.Unborn || status.Detached || len(status.Head) != 7 {
		t.Fatalf("header: %+v", status)
	}
	if e := find(t, status, "a.txt"); e.Index != "M" || e.Worktree != "M" {
		t.Errorf("staged and unstaged must both show: %+v", e)
	}
	if e := find(t, status, "dir/new.txt"); !e.Untracked {
		t.Errorf("untracked files are listed one by one: %+v", e)
	}

	// Diffs: worktree shows only the unstaged line, index only the staged one.
	wt, err := GetDiff(context.Background(), dir, "a.txt", SourceWorktree)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(wt.Diff, "+three") || strings.Contains(wt.Diff, "+two") {
		t.Errorf("worktree diff: %q", wt.Diff)
	}
	ix, err := GetDiff(context.Background(), dir, "a.txt", SourceIndex)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ix.Diff, "+two") || strings.Contains(ix.Diff, "+three") {
		t.Errorf("index diff: %q", ix.Diff)
	}
	un, err := GetDiff(context.Background(), dir, "dir/new.txt", SourceUntracked)
	if err != nil {
		t.Fatalf("an untracked diff exits 1 by design and must not be an error: %v", err)
	}
	if !strings.Contains(un.Diff, "+n") || un.Binary {
		t.Errorf("untracked diff: %+v", un)
	}
}

func TestStatusUnbornBranchAndStagedAdd(t *testing.T) {
	dir := newRepo(t)
	write(t, filepath.Join(dir, "a.txt"), "x\n")
	git(t, dir, "add", "a.txt")
	status, err := GetStatus(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Unborn || status.Head != "" {
		t.Fatalf("unborn: %+v", status)
	}
	if e := find(t, status, "a.txt"); e.Index != "A" {
		t.Errorf("%+v", e)
	}
	ix, err := GetDiff(context.Background(), dir, "a.txt", SourceIndex)
	if err != nil || !strings.Contains(ix.Diff, "+x") {
		t.Fatalf("staged diff on an unborn branch: %+v %v", ix, err)
	}
}

func TestStatusRepoRootAboveWorkspace(t *testing.T) {
	dir := newRepo(t)
	write(t, filepath.Join(dir, "outside.txt"), "o\n")
	write(t, filepath.Join(dir, "ws", "inside.txt"), "i\n")
	write(t, filepath.Join(dir, "ws", "sub", "deep.txt"), "d\n")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-q", "-m", "init")
	write(t, filepath.Join(dir, "outside.txt"), "o2\n")
	write(t, filepath.Join(dir, "ws", "inside.txt"), "i2\n")
	write(t, filepath.Join(dir, "ws", "sub", "deep.txt"), "d2\n")
	write(t, filepath.Join(dir, "other", "u.txt"), "u\n")

	ws := filepath.Join(dir, "ws")
	status, err := GetStatus(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Entries) != 2 {
		t.Fatalf("only workspace entries may appear: %+v", status.Entries)
	}
	find(t, status, "inside.txt")
	find(t, status, "sub/deep.txt")

	// And the diff path is workspace-relative too.
	d, err := GetDiff(context.Background(), ws, "sub/deep.txt", SourceWorktree)
	if err != nil || !strings.Contains(d.Diff, "+d2") {
		t.Fatalf("diff from a subdirectory workspace: %+v %v", d, err)
	}
}

func TestStatusRename(t *testing.T) {
	dir := newRepo(t)
	write(t, filepath.Join(dir, "old.txt"), strings.Repeat("some stable content line\n", 10))
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-q", "-m", "init")
	git(t, dir, "mv", "old.txt", "new name.txt")

	status, err := GetStatus(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	e := find(t, status, "new name.txt")
	if e.Index != "R" || e.OrigPath != "old.txt" {
		t.Fatalf("rename: %+v", e)
	}
	d, err := GetDiff(context.Background(), dir, "new name.txt", SourceIndex)
	if err != nil {
		t.Fatal(err)
	}
	if d.OldPath != "old.txt" || !strings.Contains(d.Diff, "rename from old.txt") {
		t.Fatalf("a staged rename diff must be one rename, not delete+add: %+v", d)
	}
}

func TestStatusConflictAndOperation(t *testing.T) {
	dir := newRepo(t)
	write(t, filepath.Join(dir, "c.txt"), "base\n")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-q", "-m", "base")
	git(t, dir, "checkout", "-q", "-b", "side")
	write(t, filepath.Join(dir, "c.txt"), "side\n")
	git(t, dir, "commit", "-q", "-am", "side")
	git(t, dir, "checkout", "-q", "main")
	write(t, filepath.Join(dir, "c.txt"), "main\n")
	git(t, dir, "commit", "-q", "-am", "main")
	// The merge is expected to fail with a conflict.
	cmd := exec.Command("git", "-c", "user.name=T", "-c", "user.email=t@example.com", "merge", "side")
	cmd.Dir = dir
	_, _ = cmd.CombinedOutput()

	status, err := GetStatus(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if status.Operation != "merge" {
		t.Fatalf("operation = %q", status.Operation)
	}
	if e := find(t, status, "c.txt"); !e.Conflict || e.Index != "U" || e.Worktree != "U" {
		t.Fatalf("conflict: %+v", e)
	}
}

func TestStatusDetachedHead(t *testing.T) {
	dir := newRepo(t)
	write(t, filepath.Join(dir, "a.txt"), "1\n")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-q", "-m", "one")
	git(t, dir, "checkout", "-q", "--detach")
	status, err := GetStatus(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Detached || status.Branch != "" || status.Head == "" {
		t.Fatalf("detached: %+v", status)
	}
}

func TestBinaryAndTruncatedDiffs(t *testing.T) {
	dir := newRepo(t)
	write(t, filepath.Join(dir, "b.bin"), "A\x00B\x00\x01\x02")
	write(t, filepath.Join(dir, "big.txt"), "start\n")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-q", "-m", "init")

	write(t, filepath.Join(dir, "b.bin"), "A\x00B\x00\x03\x04\x05")
	d, err := GetDiff(context.Background(), dir, "b.bin", SourceWorktree)
	if err != nil {
		t.Fatal(err)
	}
	if !d.Binary || d.Diff != "" {
		t.Fatalf("binary: %+v", d)
	}
	write(t, filepath.Join(dir, "new.bin"), "\x00\x01\x02\x03")
	d, err = GetDiff(context.Background(), dir, "new.bin", SourceUntracked)
	if err != nil || !d.Binary {
		t.Fatalf("untracked binary: %+v %v", d, err)
	}

	var sb strings.Builder
	for i := 0; i < 40000; i++ {
		fmt.Fprintf(&sb, "a line of text number %d\n", i)
	}
	write(t, filepath.Join(dir, "big.txt"), sb.String())
	d, err = GetDiff(context.Background(), dir, "big.txt", SourceWorktree)
	if err != nil {
		t.Fatal(err)
	}
	if !d.Truncated || len(d.Diff) == 0 || len(d.Diff) > MaxDiffBytes {
		t.Fatalf("truncation: truncated=%v len=%d", d.Truncated, len(d.Diff))
	}
}

func TestLiteralPathspecsAndDashNames(t *testing.T) {
	dir := newRepo(t)
	write(t, filepath.Join(dir, "a.txt"), "a\n")
	// Brackets are legal in Windows filenames (unlike `*`) and are a glob class in
	// a pathspec: unescaped, `[a].txt` would match `a.txt`.
	write(t, filepath.Join(dir, "[a].txt"), "bracket\n")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-q", "-m", "init")
	write(t, filepath.Join(dir, "a.txt"), "a changed\n")
	write(t, filepath.Join(dir, "[a].txt"), "bracket changed\n")
	d, err := GetDiff(context.Background(), dir, "[a].txt", SourceWorktree)
	if err != nil || !strings.Contains(d.Diff, "bracket changed") || strings.Contains(d.Diff, "a changed") {
		t.Fatalf("[a].txt diff must not include a.txt: %+v %v", d, err)
	}
	if _, err := GetDiff(context.Background(), dir, "x", "bogus"); err == nil {
		t.Error("unknown source must be refused")
	}
}

func TestEntriesCap(t *testing.T) {
	dir := newRepo(t)
	for i := 0; i < MaxEntries+5; i++ {
		write(t, filepath.Join(dir, "many", fmt.Sprintf("f%05d.txt", i)), "x")
	}
	status, err := GetStatus(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Entries) != MaxEntries || !status.Truncated {
		t.Fatalf("entries=%d truncated=%v", len(status.Entries), status.Truncated)
	}
}
