package builtin

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// gitAvailable reports whether a git binary can be found. The snapshot tool
// shells out to git, so on a machine without one the tests are skipped rather
// than failing — the tool itself would simply not work there.
func gitAvailable(t *testing.T) bool {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not on PATH; git_snapshot cannot be exercised")
		return false
	}
	return true
}

// testGitRepo creates a fresh repository in root with one commit in it, and
// returns a workspace bound to it. Every mutation goes through plain os calls
// and a git CLI helper, so the fixtures never depend on the tool under test.
func testGitRepo(t *testing.T, root string) *tools.Workspace {
	t.Helper()
	gitAvailable(t)
	t.Setenv("GIT_AUTHOR_NAME", "Test Author")
	t.Setenv("GIT_AUTHOR_EMAIL", "test@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "Test Author")
	t.Setenv("GIT_COMMITTER_EMAIL", "test@example.com")
	// CI / corporate git builds can force hooks, ask for credentials or
	// rewrite history; the fixtures need deterministic, side-effect-free runs.
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_TERMINAL_PROMPT", "0")

	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return string(out)
	}

	git(root, "init", "-b", "main")
	git(root, "config", "user.name", "Test Author")
	git(root, "config", "user.email", "test@example.com")

	if err := os.WriteFile(filepath.Join(root, "alpha.txt"), []byte("one\ntwo\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(root, "add", "alpha.txt")
	git(root, "commit", "-m", "first commit")

	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	return workspace
}

// snapshotCall runs the tool through Execute, the way the agent loop does, so
// schema validation, defaults and coercion are all exercised.
func snapshotCall(t *testing.T, workspace *tools.Workspace, args map[string]any) gitSnapshotResult {
	t.Helper()
	tool := NewGitSnapshot(workspace)
	if args == nil {
		args = map[string]any{}
	}
	result, err := tool.Execute(context.Background(), args)
	if err != nil {
		t.Fatalf("git_snapshot failed: %v", err)
	}
	var parsed gitSnapshotResult
	if err := json.Unmarshal([]byte(result.Text), &parsed); err != nil {
		t.Fatalf("result is not JSON:\n%s", result.Text)
	}
	return parsed
}

// writeFileAt writes inside the repo root and returns the repo-relative path.
func writeRepoFile(t *testing.T, root, rel, content string) string {
	t.Helper()
	target := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return rel
}

func TestGitSnapshotCleanRepository(t *testing.T) {
	root := t.TempDir()
	workspace := testGitRepo(t, root)

	snap := snapshotCall(t, workspace, map[string]any{"detail": "minimal"})

	if snap.Detail != "minimal" {
		t.Errorf("detail = %q, want minimal", snap.Detail)
	}
	if !snap.State.ScopeClean {
		t.Errorf("state.scope_clean = false on a fresh repo; files: %+v", snap.Files)
	}
	if snap.State.RepositoryClean == nil || !*snap.State.RepositoryClean {
		t.Errorf("repository_clean = %v, want true on an unscoped clean repo", snap.State.RepositoryClean)
	}
	if snap.Counts.ChangedFiles != 0 {
		t.Errorf("counts.changed_files = %d, want 0", snap.Counts.ChangedFiles)
	}
	if snap.Repository.Branch == nil || *snap.Repository.Branch != "main" {
		t.Errorf("branch = %v, want main", snap.Repository.Branch)
	}
	if snap.Repository.Head == nil || len(*snap.Repository.Head) < 7 {
		t.Errorf("head = %v, want a short hash (7+ chars)", snap.Repository.Head)
	}
	if snap.State.UnbornBranch {
		t.Error("unborn_branch = true after a commit")
	}
	// minimal must not carry the standard-mode extras.
	if snap.DiffSummary != nil {
		t.Errorf("minimal returned a diff summary: %+v", snap.DiffSummary)
	}
	if len(snap.RecentCommits) != 0 {
		t.Errorf("minimal returned commits: %+v", snap.RecentCommits)
	}
	if !snap.Scope.RepositoryWide {
		t.Error("repository_wide = false without pathspecs")
	}
	if snap.Truncation.TotalFiles != 0 || snap.Truncation.ReturnedFiles != 0 {
		t.Errorf("truncation = %+v, want zeros", snap.Truncation)
	}
}

func TestGitSnapshotStandardDetails(t *testing.T) {
	root := t.TempDir()
	workspace := testGitRepo(t, root)

	// Staged change.
	writeRepoFile(t, root, "beta.txt", "staged line one\nstaged line two\nstaged line three\n")
	runRepoGit(t, root, "add", "beta.txt")
	// Unstaged change to the tracked file (two lines added, one removed).
	writeRepoFile(t, root, "alpha.txt", "one\nTWO\nthree\nextra\n")
	// Untracked file.
	writeRepoFile(t, root, "gamma.txt", "untracked\n")

	snap := snapshotCall(t, workspace, nil) // detail defaults to standard

	if snap.Detail != "standard" {
		t.Errorf("detail = %q, want standard (default)", snap.Detail)
	}
	if snap.State.ScopeClean {
		t.Error("state.scope_clean = true with pending changes")
	}
	if snap.State.RepositoryClean != nil && *snap.State.RepositoryClean {
		t.Errorf("repository_clean = %v, want false on an unscoped dirty repo", *snap.State.RepositoryClean)
	}
	if snap.Counts.ChangedFiles != 3 || snap.Counts.Staged != 1 || snap.Counts.Unstaged != 1 || snap.Counts.Untracked != 1 {
		t.Errorf("counts = %+v, want changed=3 staged=1 unstaged=1 untracked=1", snap.Counts)
	}

	byPath := map[string]snapshotFile{}
	for _, f := range snap.Files {
		byPath[f.Path] = f
	}

	beta := byPath["beta.txt"]
	if beta.IndexStatus != "added" || beta.WorktreeStatus != "unchanged" {
		t.Errorf("beta = index %q worktree %q, want added/unchanged", beta.IndexStatus, beta.WorktreeStatus)
	}
	if beta.StagedDiff == nil || beta.StagedDiff.Insertions != 3 || beta.StagedDiff.Deletions != 0 {
		t.Errorf("beta staged_diff = %+v, want +3/-0", beta.StagedDiff)
	}
	if beta.UnstagedDiff != nil {
		t.Errorf("beta unstaged_diff = %+v, want nil", beta.UnstagedDiff)
	}

	alpha := byPath["alpha.txt"]
	if alpha.IndexStatus != "unchanged" || alpha.WorktreeStatus != "modified" {
		t.Errorf("alpha = index %q worktree %q, want unchanged/modified", alpha.IndexStatus, alpha.WorktreeStatus)
	}
	if alpha.UnstagedDiff == nil || alpha.UnstagedDiff.Insertions != 2 || alpha.UnstagedDiff.Deletions != 1 {
		t.Errorf("alpha unstaged_diff = %+v, want +2/-1", alpha.UnstagedDiff)
	}
	if alpha.StagedDiff != nil {
		t.Errorf("alpha staged_diff = %+v, want nil", alpha.StagedDiff)
	}

	gamma := byPath["gamma.txt"]
	if gamma.WorktreeStatus != "untracked" {
		t.Errorf("gamma worktree = %q, want untracked", gamma.WorktreeStatus)
	}
	if gamma.StagedDiff != nil || gamma.UnstagedDiff != nil {
		t.Errorf("gamma should carry no diff stats, got %+v / %+v", gamma.StagedDiff, gamma.UnstagedDiff)
	}

	if snap.DiffSummary == nil {
		t.Fatal("standard returned no diff summary")
	}
	if got := snap.DiffSummary.Staged; got.FilesChanged != 1 || got.Insertions != 3 || got.Deletions != 0 {
		t.Errorf("diff_summary.staged = %+v, want 1 file +3/-0", got)
	}
	if got := snap.DiffSummary.Unstaged; got.FilesChanged != 1 || got.Insertions != 2 || got.Deletions != 1 {
		t.Errorf("diff_summary.unstaged = %+v, want 1 file +2/-1", got)
	}

	if len(snap.RecentCommits) != 1 {
		t.Fatalf("recent_commits = %d entries, want 1", len(snap.RecentCommits))
	}
	commit := snap.RecentCommits[0]
	if commit.Subject != "first commit" || commit.Author != "Test Author" {
		t.Errorf("commit = %+v, want subject %q author %q", commit, "first commit", "Test Author")
	}
	if len(commit.Hash) < 7 || commit.Timestamp == "" {
		t.Errorf("commit hash %q timestamp %q, want a short hash (7+ chars) and non-empty timestamp", commit.Hash, commit.Timestamp)
	}
	if snap.Warnings != nil && len(snap.Warnings) != 0 {
		t.Errorf("unexpected warnings: %v", snap.Warnings)
	}
}

func TestGitSnapshotModifiedModifiedFile(t *testing.T) {
	root := t.TempDir()
	workspace := testGitRepo(t, root)

	// Stage a change, then change the same file again without staging:
	// porcelain v2 reports this as "MM".
	writeRepoFile(t, root, "alpha.txt", "one\ntwo\nthree\nstaged extra\n")
	runRepoGit(t, root, "add", "alpha.txt")
	writeRepoFile(t, root, "alpha.txt", "one\ntwo\nthree\nstaged extra\nworktree extra\n")

	snap := snapshotCall(t, workspace, map[string]any{"detail": "minimal"})

	if snap.Counts.ChangedFiles != 1 {
		t.Fatalf("changed_files = %d, want 1", snap.Counts.ChangedFiles)
	}
	if snap.Counts.Staged != 1 || snap.Counts.Unstaged != 1 {
		t.Errorf("counts staged=%d unstaged=%d, want 1/1 (an MM file counts in both)", snap.Counts.Staged, snap.Counts.Unstaged)
	}
	if len(snap.Files) != 1 {
		t.Fatalf("files = %d, want 1", len(snap.Files))
	}
	f := snap.Files[0]
	if f.IndexStatus != "modified" || f.WorktreeStatus != "modified" {
		t.Errorf("alpha = index %q worktree %q, want modified/modified", f.IndexStatus, f.WorktreeStatus)
	}
}

func TestGitSnapshotRenamedFile(t *testing.T) {
	root := t.TempDir()
	workspace := testGitRepo(t, root)

	runRepoGit(t, root, "mv", "alpha.txt", "renamed_alpha.txt")

	snap := snapshotCall(t, workspace, map[string]any{"detail": "minimal"})

	if snap.Counts.ChangedFiles != 1 {
		t.Fatalf("changed_files = %d, want 1: %+v", snap.Counts.ChangedFiles, snap.Files)
	}
	f := snap.Files[0]
	if f.IndexStatus != "renamed" {
		t.Errorf("index_status = %q, want renamed", f.IndexStatus)
	}
	if f.Path != "renamed_alpha.txt" {
		t.Errorf("path = %q, want renamed_alpha.txt", f.Path)
	}
	if f.OriginalPath == nil || *f.OriginalPath != "alpha.txt" {
		t.Errorf("original_path = %v, want alpha.txt", f.OriginalPath)
	}
}

func TestGitSnapshotLogLimit(t *testing.T) {
	root := t.TempDir()
	workspace := testGitRepo(t, root)

	msgs := []string{"second commit", "third commit"}
	for i, msg := range msgs {
		// Each commit needs its own new file: rewriting the same file with
		// the same content would leave nothing to commit.
		writeRepoFile(t, root, fmt.Sprintf("n%d.txt", i), "x\n")
		runRepoGit(t, root, "add", fmt.Sprintf("n%d.txt", i))
		runRepoGit(t, root, "commit", "-m", msg)
	}

	snap := snapshotCall(t, workspace, map[string]any{"log_limit": 2})
	if len(snap.RecentCommits) != 2 {
		t.Fatalf("recent_commits = %d, want 2", len(snap.RecentCommits))
	}
	if snap.RecentCommits[0].Subject != "third commit" || snap.RecentCommits[1].Subject != "second commit" {
		t.Errorf("commits out of order: %+v", snap.RecentCommits)
	}

	// log_limit 0 is an explicit "no history" request.
	empty := snapshotCall(t, workspace, map[string]any{"log_limit": 0})
	if len(empty.RecentCommits) != 0 {
		t.Errorf("log_limit=0 returned %d commits", len(empty.RecentCommits))
	}
}

func TestGitSnapshotUnbornBranch(t *testing.T) {
	gitAvailable(t)
	t.Setenv("GIT_AUTHOR_NAME", "Test Author")
	t.Setenv("GIT_AUTHOR_EMAIL", "test@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "Test Author")
	t.Setenv("GIT_COMMITTER_EMAIL", "test@example.com")
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_TERMINAL_PROMPT", "0")

	root := t.TempDir()
	out, err := exec.Command("git", "init", "-b", "main", root).CombinedOutput()
	if err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	writeRepoFile(t, root, "pending.txt", "never committed\n")

	snap := snapshotCall(t, workspace, nil)

	if !snap.State.UnbornBranch {
		t.Error("unborn_branch = false on a fresh init")
	}
	if snap.Repository.Head != nil {
		t.Errorf("head = %v, want nil on an unborn branch", *snap.Repository.Head)
	}
	if snap.State.ScopeClean {
		t.Error("state.scope_clean = true with an untracked file pending")
	}
	if snap.Counts.Untracked != 1 {
		t.Errorf("untracked = %d, want 1", snap.Counts.Untracked)
	}
	if snap.DiffSummary == nil {
		t.Error("standard on an unborn branch should still return a diff summary")
	}
	if len(snap.RecentCommits) != 0 {
		t.Errorf("recent_commits = %d on an unborn branch, want 0", len(snap.RecentCommits))
	}
	if len(snap.Warnings) != 0 {
		t.Errorf("unexpected warnings on an unborn branch: %v", snap.Warnings)
	}
}

func TestGitSnapshotPathspecScope(t *testing.T) {
	root := t.TempDir()
	workspace := testGitRepo(t, root)

	// Changes both inside and outside the requested pathspec.
	writeRepoFile(t, root, "alpha.txt", "one\ntwo\nthree\nmodified\n")
	// Seed the docs directory with a tracked file first: an untracked
	// *directory* is reported as one "? docs/" entry, so the directory must
	// already exist in the index for guide.txt to show up on its own.
	writeRepoFile(t, root, filepath.Join("docs", "seed.txt"), "seed\n")
	runRepoGit(t, root, "add", "docs/seed.txt")
	runRepoGit(t, root, "commit", "-m", "add docs seed")
	writeRepoFile(t, root, filepath.Join("docs", "guide.txt"), "docs\n")

	snap := snapshotCall(t, workspace, map[string]any{
		"paths": []any{"docs/"},
	})

	if snap.Scope.RepositoryWide {
		t.Error("repository_wide = true with pathspecs")
	}
	if len(snap.Scope.Pathspecs) != 1 || snap.Scope.Pathspecs[0] != "docs/" {
		t.Errorf("pathspecs = %v, want [docs/]", snap.Scope.Pathspecs)
	}
	if len(snap.Files) != 1 || snap.Files[0].Path != "docs/guide.txt" {
		t.Errorf("files = %+v, want only the docs file", snap.Files)
	}
	if snap.State.RepositoryClean != nil {
		t.Errorf("repository_clean = %v, want null when scoped", *snap.State.RepositoryClean)
	}
}

func TestGitSnapshotMergeInProgress(t *testing.T) {
	root := t.TempDir()
	workspace := testGitRepo(t, root)
	git := func(args ...string) (string, error) {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		out, err := cmd.CombinedOutput()
		return string(out), err
	}

	// Branch A: divergent commits, then start a merge that conflicts.
	runRepoGit(t, root, "commit", "-m", "base extra", "--allow-empty")
	runRepoGit(t, root, "checkout", "-b", "feature")
	writeRepoFile(t, root, "alpha.txt", "one\nFEATURE\ntwo\n")
	runRepoGit(t, root, "commit", "-am", "feature change")
	runRepoGit(t, root, "checkout", "main")
	writeRepoFile(t, root, "alpha.txt", "one\nMAIN\ntwo\n")
	runRepoGit(t, root, "commit", "-am", "main change")

	if _, err := git("merge", "feature"); err != nil {
		// A conflict is exactly what we want: git exits non-zero here.
	}

	snap := snapshotCall(t, workspace, map[string]any{"detail": "minimal"})

	if !snap.State.MergeInProgress {
		t.Error("merge_in_progress = false during a conflicted merge")
	}
	if snap.State.RebaseInProgress || snap.State.CherryPickInProgress || snap.State.RevertInProgress {
		t.Errorf("an unrelated special state is set: %+v", snap.State)
	}
	if snap.Counts.Conflicted == 0 {
		t.Errorf("conflicted = 0 during a conflicted merge; files: %+v", snap.Files)
	}
	// The merge leaves a dirty working tree, so clean must be false even if
	// every file were somehow staged.
	if snap.State.ScopeClean {
		t.Error("state.scope_clean = true mid-merge")
	}
}

func TestGitSnapshotNotARepository(t *testing.T) {
	gitAvailable(t)
	workspace, err := tools.NewWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tool := NewGitSnapshot(workspace)
	result, err := tool.Execute(context.Background(), nil)
	if err != nil {
		t.Fatalf("not-a-repo should be a text result, got error: %v", err)
	}
	if !strings.Contains(result.Text, "Git 仓库") {
		t.Errorf("result = %q, want a not-a-repository message", result.Text)
	}
}

func TestGitSnapshotRepoPathOutsideWorkspace(t *testing.T) {
	root := t.TempDir()
	workspace := testGitRepo(t, root)

	outside := t.TempDir()
	tool := NewGitSnapshot(workspace)
	result, err := tool.Execute(context.Background(), map[string]any{"repo_path": outside})
	if err != nil {
		t.Fatalf("escape should be a text result, got error: %v", err)
	}
	if !strings.Contains(result.Text, "路径越界") {
		t.Errorf("result = %q, want a path-escape refusal", result.Text)
	}
}

func TestGitSnapshotRepoPathInsideSubdirectory(t *testing.T) {
	root := t.TempDir()
	workspace := testGitRepo(t, root)

	sub := filepath.Join(root, "deep", "nest")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	// deep/ must exist in the index, otherwise git reports the whole
	// untracked directory as one "? deep/" entry instead of the file.
	writeRepoFile(t, root, filepath.Join("deep", "seed.txt"), "seed\n")
	runRepoGit(t, root, "add", "deep/seed.txt")
	runRepoGit(t, root, "commit", "-m", "add deep seed")
	writeRepoFile(t, root, filepath.Join("deep", "nested.txt"), "nested\n")

	rel, err := filepath.Rel(root, sub)
	if err != nil {
		t.Fatal(err)
	}
	snap := snapshotCall(t, workspace, map[string]any{"repo_path": filepath.ToSlash(rel), "detail": "minimal"})

	// The snapshot must still be about the whole repository.
	if snap.Repository.Branch == nil || *snap.Repository.Branch != "main" {
		t.Errorf("branch = %v from a subdirectory, want main", snap.Repository.Branch)
	}
	if snap.Counts.Untracked != 1 {
		t.Errorf("untracked = %d from a subdirectory, want 1", snap.Counts.Untracked)
	}
	if len(snap.Files) != 1 || snap.Files[0].Path != filepath.ToSlash(filepath.Join("deep", "nested.txt")) {
		t.Errorf("files = %+v, want the nested untracked file", snap.Files)
	}
}

func TestGitSnapshotRejectsUnknownArguments(t *testing.T) {
	root := t.TempDir()
	workspace := testGitRepo(t, root)
	tool := NewGitSnapshot(workspace)
	_, err := tool.Execute(context.Background(), map[string]any{"bogus": true})
	if err == nil {
		t.Error("an unknown argument was accepted")
	}
}

func TestGitSnapshotBinaryFileFlag(t *testing.T) {
	root := t.TempDir()
	workspace := testGitRepo(t, root)

	// A small "binary": NUL bytes make git treat it as non-text.
	bin := make([]byte, 64)
	for i := range bin {
		bin[i] = byte(i)
	}
	if err := os.WriteFile(filepath.Join(root, "blob.bin"), bin, 0o644); err != nil {
		t.Fatal(err)
	}
	runRepoGit(t, root, "add", "blob.bin")

	snap := snapshotCall(t, workspace, nil)

	if len(snap.Files) != 1 {
		t.Fatalf("files = %+v, want one entry", snap.Files)
	}
	f := snap.Files[0]
	if f.Binary == nil || !*f.Binary {
		t.Errorf("binary = %v, want true for a NUL-laden staged file", f.Binary)
	}
	// A binary file has no line stats, only the flag.
	if f.StagedDiff != nil {
		t.Errorf("staged_diff = %+v, want nil for a binary", f.StagedDiff)
	}
	if snap.DiffSummary == nil || snap.DiffSummary.Staged.FilesChanged != 1 {
		t.Errorf("diff_summary.staged = %+v, want 1 changed file", snap.DiffSummary)
	}
}

// --- helpers shared with the tests above ---

func runRepoGit(t *testing.T, root string, args ...string) {
	t.Helper()
	gitAvailable(t)
	cmd := exec.Command("git", args...)
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	_ = out
}


