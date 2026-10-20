package builtin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// git_snapshot limits.
const (
	// GIT_SNAPSHOT_MAX_FILES caps the file list. Counts and summaries always
	// reflect the full set, so truncation is visible rather than silent.
	GIT_SNAPSHOT_MAX_FILES = 200
	// GIT_SNAPSHOT_TIMEOUT bounds the total wall-clock time for all git commands.
	GIT_SNAPSHOT_TIMEOUT = 15 * time.Second
)

// --- Result types ---

// gitSnapshotResult is the JSON structure returned to the model.
type gitSnapshotResult struct {
	Detail        string               `json:"detail"`
	Scope         snapshotScope        `json:"scope"`
	Repository    snapshotRepository   `json:"repository"`
	State         snapshotState        `json:"state"`
	Counts        snapshotCounts       `json:"counts"`
	Files         []snapshotFile       `json:"files"`
	DiffSummary   *snapshotDiffSummary `json:"diff_summary,omitempty"`
	RecentCommits []snapshotCommit     `json:"recent_commits,omitempty"`
	Truncation    snapshotTruncation   `json:"truncation"`
	Warnings      []string             `json:"warnings"`
}

type snapshotScope struct {
	RepositoryWide bool     `json:"repository_wide"`
	Pathspecs      []string `json:"pathspecs"`
}

type snapshotRepository struct {
	Root     string  `json:"root"`
	Branch   *string `json:"branch"`
	Head     *string `json:"head"`
	Upstream *string `json:"upstream"`
	Ahead    *int    `json:"ahead"`
	Behind   *int    `json:"behind"`
}

type snapshotState struct {
	// ScopeClean answers "is this query's scope clean": the whole repository
	// when no pathspecs were given, the requested paths when they were. It
	// always reflects what this call actually observed.
	ScopeClean bool `json:"scope_clean"`
	// RepositoryClean answers "is the whole repository clean". It is null when
	// the query was scoped: a scoped result must never be mistaken for the
	// repository state.
	RepositoryClean *bool `json:"repository_clean"`
	DetachedHead         bool  `json:"detached_head"`
	UnbornBranch         bool  `json:"unborn_branch"`
	MergeInProgress      bool  `json:"merge_in_progress"`
	RebaseInProgress     bool  `json:"rebase_in_progress"`
	CherryPickInProgress bool  `json:"cherry_pick_in_progress"`
	RevertInProgress     bool  `json:"revert_in_progress"`
}

type snapshotCounts struct {
	ChangedFiles int `json:"changed_files"`
	Staged       int `json:"staged"`
	Unstaged     int `json:"unstaged"`
	Untracked    int `json:"untracked"`
	Conflicted   int `json:"conflicted"`
}

type snapshotFile struct {
	Path           string        `json:"path"`
	OriginalPath   *string       `json:"original_path,omitempty"`
	IndexStatus    string        `json:"index_status"`
	WorktreeStatus string        `json:"worktree_status"`
	Conflicted     bool          `json:"conflicted"`
	Binary         *bool         `json:"binary,omitempty"`
	StagedDiff     *snapshotDiff `json:"staged_diff,omitempty"`
	UnstagedDiff   *snapshotDiff `json:"unstaged_diff,omitempty"`
}

type snapshotDiff struct {
	Insertions int `json:"insertions"`
	Deletions  int `json:"deletions"`
}

type snapshotDiffSummary struct {
	Staged   snapshotDiffTotals `json:"staged"`
	Unstaged snapshotDiffTotals `json:"unstaged"`
}

type snapshotDiffTotals struct {
	FilesChanged int `json:"files_changed"`
	Insertions   int `json:"insertions"`
	Deletions    int `json:"deletions"`
}

type snapshotCommit struct {
	Hash      string `json:"hash"`
	Subject   string `json:"subject"`
	Author    string `json:"author"`
	Timestamp string `json:"timestamp"`
}

type snapshotTruncation struct {
	FilesTruncated bool `json:"files_truncated"`
	TotalFiles     int  `json:"total_files"`
	ReturnedFiles  int  `json:"returned_files"`
}

// --- Tool constructor ---

// NewGitSnapshot builds the git_snapshot tool. Like read_file, it is bound to
// the workspace: repo_path is resolved through SafePath, and the tool is
// read-only, low-risk, and parallel-safe.
func NewGitSnapshot(workspace *tools.Workspace) tools.Tool {
	return tools.Tool{
		Name: "git_snapshot",
		Description: "获取 Git 仓库的结构化快照，包含当前分支、HEAD、上游分支、" +
			"已暂存文件、未暂存文件、未跟踪文件、冲突文件，以及当前是否正在进行 merge 或 rebase 等操作。\n" +
			"使用 detail=\"minimal\" 快速确认仓库状态。\n" +
			"在开始任务、完成较大修改或提交前，使用 detail=\"standard\"。" +
			"standard 模式还会返回已暂存和未暂存的 diff 统计及最近提交。\n" +
			"该工具用于提供仓库级上下文和修改摘要，不返回完整 diff。" +
			"需要查看具体代码变化时，通过 shell 执行 git diff。",
		Risk:         security.RiskLow,
		ParallelSafe: true,
		Schema: tools.ObjectSchema(map[string]any{
			"repo_path": tools.StringSchema(
				"仓库内的路径。省略则使用当前工作区根目录"),
			"detail": tools.StringSchema(
				"minimal 返回仓库和文件状态；standard 还返回 diff 统计和最近提交",
				tools.Enum("minimal", "standard"),
				tools.Default("standard")),
			"log_limit": tools.IntSchema(
				"standard 模式下返回的最近提交数量",
				tools.Default(5), tools.Minimum(0), tools.Maximum(20)),
			"paths": tools.ArraySchema(
				"可选的路径范围（相对于仓库），用于限定返回的文件状态和 diff 统计范围",
				tools.StringSchema("路径", tools.MinLength(1))),
		}),
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			return gitSnapshot(workspace, ctx, args)
		},
	}
}

// --- Handler ---

func gitSnapshot(workspace *tools.Workspace, ctx context.Context, args map[string]any) (tools.Result, error) {
	// 1. Parse arguments.
	workDir := workspace.Root()
	if repoPath, ok := args["repo_path"].(string); ok && repoPath != "" {
		resolved, err := workspace.SafePath(repoPath)
		if err != nil {
			return tools.TextResult("路径越界：" + repoPath), nil
		}
		info, err := os.Stat(resolved)
		if err != nil {
			return tools.TextResult("路径不存在：" + repoPath), nil
		}
		if !info.IsDir() {
			resolved = filepath.Dir(resolved)
		}
		workDir = resolved
	}

	detail := "standard"
	if d, ok := args["detail"].(string); ok && d != "" {
		detail = d
	}

	logLimit := 5
	if l, ok := args["log_limit"].(int); ok {
		logLimit = l
	}

	var pathspecs []string
	if p, ok := args["paths"].([]any); ok {
		for _, item := range p {
			if s, ok := item.(string); ok && s != "" {
				pathspecs = append(pathspecs, s)
			}
		}
	}
	hasPaths := len(pathspecs) > 0

	// 2. Create a timeout-bounded context for all git commands.
	gitCtx, cancel := context.WithTimeout(ctx, GIT_SNAPSHOT_TIMEOUT)
	defer cancel()

	// 3. Find the repo root and git directory.
	repoRoot, gitDir, err := gitRepoRoot(gitCtx, workDir)
	if err != nil {
		return tools.TextResult(err.Error()), nil
	}

	// 4. Run git status --porcelain=v2 --branch -z [-- pathspecs].
	// The default untracked mode (normal) is deliberate: an untracked directory
	// is reported as one "? dir/" entry, exactly like `git status --short`.
	// `--untracked-files=all` was tried instead, but on some git/Windows builds
	// it silently drops every untracked entry from porcelain v2 output.
	statusArgs := []string{"status", "--porcelain=v2", "--branch", "-z"}
	statusArgs = appendPathspecs(statusArgs, pathspecs)
	statusOut, stderr, statusCode, runErr := runGit(gitCtx, workDir, statusArgs...)
	if runErr != nil {
		return tools.TextResult("git 不可用：" + runErr.Error()), nil
	}
	if statusCode != 0 {
		return tools.TextResult("git status 失败（退出码 " + strconv.Itoa(statusCode) +
			"）：" + strings.TrimSpace(stderr)), nil
	}

	// 5. Parse status output.
	repo, state, files, counts := parsePorcelainV2(statusOut)
	repo.Root = repoRoot

	// 6. Detect special states (merge, rebase, cherry-pick, revert).
	specialStates := detectSpecialStates(gitDir)
	state.MergeInProgress = specialStates.MergeInProgress
	state.RebaseInProgress = specialStates.RebaseInProgress
	state.CherryPickInProgress = specialStates.CherryPickInProgress
	state.RevertInProgress = specialStates.RevertInProgress

	// 7. Set clean state: ScopeClean always describes what this call observed;
	// RepositoryClean only when the observation was repository-wide.
	state.ScopeClean = counts.ChangedFiles == 0
	if !hasPaths {
		state.RepositoryClean = &state.ScopeClean
	}

	// 8. Standard mode: gather diff stats and recent commits.
	var warnings []string
	var diffSummary *snapshotDiffSummary
	var recentCommits []snapshotCommit

	if detail == "standard" {
		stagedNS, stagedWarn := runNumstat(gitCtx, workDir, true, pathspecs)
		if stagedWarn != "" {
			warnings = append(warnings, stagedWarn)
		}
		unstagedNS, unstagedWarn := runNumstat(gitCtx, workDir, false, pathspecs)
		if unstagedWarn != "" {
			warnings = append(warnings, unstagedWarn)
		}

		// Populate per-file diff stats from the numstat maps.
		for i := range files {
			path := files[i].Path
			if sd, ok := stagedNS.stats[path]; ok {
				files[i].StagedDiff = sd
			}
			if ud, ok := unstagedNS.stats[path]; ok {
				files[i].UnstagedDiff = ud
			}
			isBinary := stagedNS.binary[path] || unstagedNS.binary[path]
			if isBinary {
				b := true
				files[i].Binary = &b
			} else if files[i].StagedDiff != nil || files[i].UnstagedDiff != nil {
				b := false
				files[i].Binary = &b
			}
		}

		diffSummary = &snapshotDiffSummary{
			Staged:   computeDiffTotals(stagedNS),
			Unstaged: computeDiffTotals(unstagedNS),
		}

		if logLimit > 0 {
			commits, logWarn := runLog(gitCtx, workDir, logLimit)
			if logWarn != "" {
				warnings = append(warnings, logWarn)
			}
			recentCommits = commits
		}
	}

	// 9. Sort files by path for deterministic truncation.
	sort.Slice(files, func(i, j int) bool {
		return files[i].Path < files[j].Path
	})

	// 10. Truncate file list.
	totalFiles := len(files)
	truncated := false
	if totalFiles > GIT_SNAPSHOT_MAX_FILES {
		files = files[:GIT_SNAPSHOT_MAX_FILES]
		truncated = true
	}

	// 11. Assemble result.
	if pathspecs == nil {
		pathspecs = []string{}
	}
	if warnings == nil {
		warnings = []string{}
	}
	if files == nil {
		files = []snapshotFile{}
	}

	result := gitSnapshotResult{
		Detail: detail,
		Scope: snapshotScope{
			RepositoryWide: !hasPaths,
			Pathspecs:      pathspecs,
		},
		Repository:    repo,
		State:         state,
		Counts:        counts,
		Files:         files,
		DiffSummary:   diffSummary,
		RecentCommits: recentCommits,
		Truncation: snapshotTruncation{
			FilesTruncated: truncated,
			TotalFiles:     totalFiles,
			ReturnedFiles:  len(files),
		},
		Warnings: warnings,
	}

	jsonBytes, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return tools.TextResult("内部错误：无法序列化快照结果"), nil
	}
	return tools.Result{
		Text: string(jsonBytes),
		Audit: map[string]any{
			"detail":        detail,
			"changed_files": counts.ChangedFiles,
			"scope_clean":   state.ScopeClean,
		},
	}, nil
}

// --- Git command runner ---

// runGit executes one git command and returns stdout, stderr, exit code, and
// a non-nil error only when the command could not start at all.
func runGit(ctx context.Context, dir string, args ...string) (stdout, stderr string, exitCode int, err error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	var stdoutBuf, stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf
	runErr := cmd.Run()
	if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			return stdoutBuf.String(), stderrBuf.String(), exitErr.ExitCode(), nil
		}
		return "", "", -1, runErr
	}
	return stdoutBuf.String(), stderrBuf.String(), 0, nil
}

// gitRepoRoot finds the repository root and .git directory from workDir.
func gitRepoRoot(ctx context.Context, dir string) (repoRoot, gitDir string, err error) {
	rootOut, _, code, runErr := runGit(ctx, dir, "rev-parse", "--show-toplevel")
	if runErr != nil {
		return "", "", fmt.Errorf("git 不可用：%v", runErr)
	}
	if code != 0 {
		return "", "", fmt.Errorf("不在 Git 仓库里：%s", dir)
	}
	repoRoot = strings.TrimSpace(rootOut)

	gitDirOut, _, code, runErr := runGit(ctx, dir, "rev-parse", "--git-dir")
	if runErr != nil {
		return repoRoot, "", fmt.Errorf("git 不可用：%v", runErr)
	}
	if code != 0 {
		return repoRoot, "", fmt.Errorf("无法确定 .git 目录")
	}
	gitDirRel := strings.TrimSpace(gitDirOut)
	if filepath.IsAbs(gitDirRel) {
		gitDir = gitDirRel
	} else {
		gitDir = filepath.Join(dir, gitDirRel)
	}
	if resolved, evalErr := filepath.EvalSymlinks(gitDir); evalErr == nil {
		gitDir = resolved
	}
	return repoRoot, gitDir, nil
}

// appendPathspecs adds "-- path1 path2 ..." to args when pathspecs is non-empty.
func appendPathspecs(args []string, pathspecs []string) []string {
	if len(pathspecs) > 0 {
		args = append(args, "--")
		args = append(args, pathspecs...)
	}
	return args
}

// --- Porcelain v2 parser ---

// parsePorcelainV2 parses the output of `git status --porcelain=v2 --branch -z`.
//
// The -z flag makes the output NUL-separated: every entry (including branch
// headers) is terminated by NUL, and paths are not quoted. Rename entries (type
// 2) use an extra NUL between the new path and the original path.
func parsePorcelainV2(output string) (repo snapshotRepository, state snapshotState, files []snapshotFile, counts snapshotCounts) {
	pieces := strings.Split(output, "\x00")

	for i := 0; i < len(pieces); i++ {
		piece := pieces[i]
		if piece == "" {
			continue
		}

		switch {
		case strings.HasPrefix(piece, "# branch.head "):
			branch := strings.TrimPrefix(piece, "# branch.head ")
			if branch == "(detached)" {
				state.DetachedHead = true
			} else {
				repo.Branch = &branch
			}

		case strings.HasPrefix(piece, "# branch.upstream "):
			upstream := strings.TrimPrefix(piece, "# branch.upstream ")
			repo.Upstream = &upstream

		case strings.HasPrefix(piece, "# branch.ab "):
			ab := strings.TrimPrefix(piece, "# branch.ab ")
			for _, p := range strings.Fields(ab) {
				if strings.HasPrefix(p, "+") {
					n, _ := strconv.Atoi(p[1:])
					repo.Ahead = &n
				} else if strings.HasPrefix(p, "-") {
					n, _ := strconv.Atoi(p[1:])
					repo.Behind = &n
				}
			}

		// Older git prints "# HEAD <hash>" instead of "# branch.oid <hash>".
		case strings.HasPrefix(piece, "# branch.oid ") || strings.HasPrefix(piece, "# HEAD "):
			oid := strings.TrimPrefix(strings.TrimPrefix(piece, "# branch.oid "), "# HEAD ")
			if oid == "(initial)" {
				state.UnbornBranch = true
			} else {
				short := oid
				if len(short) > 8 {
					short = short[:8]
				}
				repo.Head = &short
			}

		case len(piece) >= 2 && piece[0] == '1' && piece[1] == ' ':
			files = append(files, parseOrdinaryEntry(piece))

		case len(piece) >= 2 && piece[0] == '2' && piece[1] == ' ':
			file := parseRenameEntry(piece)
			// The original path is the next NUL-separated piece.
			if i+1 < len(pieces) {
				i++
				orig := pieces[i]
				if orig != "" {
					file.OriginalPath = &orig
				}
			}
			files = append(files, file)

		case len(piece) >= 2 && piece[0] == 'u' && piece[1] == ' ':
			file := parseUnmergedEntry(piece)
			file.Conflicted = true
			files = append(files, file)

		case strings.HasPrefix(piece, "? "):
			// Untracked: "? <path>"
			path := piece[2:]
			files = append(files, snapshotFile{
				Path:           path,
				IndexStatus:    "unchanged",
				WorktreeStatus: "untracked",
			})

		case len(piece) >= 2 && piece[0] == '!':
			// Ignored — not requested, skip.
		}
	}

	counts = computeCounts(files)
	return
}

// parseOrdinaryEntry parses a "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>" line.
func parseOrdinaryEntry(piece string) snapshotFile {
	parts := strings.SplitN(piece, " ", 9)
	if len(parts) < 9 {
		return snapshotFile{Path: piece}
	}
	xy := parts[1]
	return snapshotFile{
		Path:           parts[8],
		IndexStatus:    mapStatus(xy[0]),
		WorktreeStatus: mapStatus(xy[1]),
	}
}

// parseRenameEntry parses a "2 <XY> ... <X><score> <path>" line. The original
// path is consumed separately by the caller (it is the next NUL piece).
func parseRenameEntry(piece string) snapshotFile {
	parts := strings.SplitN(piece, " ", 10)
	if len(parts) < 10 {
		return snapshotFile{Path: piece}
	}
	xy := parts[1]
	return snapshotFile{
		Path:           parts[9],
		IndexStatus:    mapStatus(xy[0]),
		WorktreeStatus: mapStatus(xy[1]),
	}
}

// parseUnmergedEntry parses a "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>" line.
func parseUnmergedEntry(piece string) snapshotFile {
	parts := strings.SplitN(piece, " ", 11)
	if len(parts) < 11 {
		return snapshotFile{Path: piece}
	}
	xy := parts[1]
	return snapshotFile{
		Path:           parts[10],
		IndexStatus:    mapStatus(xy[0]),
		WorktreeStatus: mapStatus(xy[1]),
	}
}

// mapStatus converts a porcelain v2 status character to the design's stable
// status string.
func mapStatus(code byte) string {
	switch code {
	case '.':
		return "unchanged"
	case 'M':
		return "modified"
	case 'A':
		return "added"
	case 'D':
		return "deleted"
	case 'R':
		return "renamed"
	case 'C':
		return "copied"
	case 'U':
		return "unmerged"
	default:
		return "unknown"
	}
}

// computeCounts derives the count fields from the file list.
//
// A file can appear in multiple count buckets: e.g. an "MM" file is both staged
// and unstaged. Conflicted files are counted only in "conflicted" to avoid
// inflating staged/unstaged with merge-state entries.
func computeCounts(files []snapshotFile) snapshotCounts {
	var staged, unstaged, untracked, conflicted int
	for _, f := range files {
		if f.Conflicted {
			conflicted++
			continue
		}
		if f.IndexStatus != "unchanged" && f.IndexStatus != "untracked" {
			staged++
		}
		if f.WorktreeStatus == "untracked" {
			untracked++
		} else if f.WorktreeStatus != "unchanged" {
			unstaged++
		}
	}
	return snapshotCounts{
		ChangedFiles: len(files),
		Staged:       staged,
		Unstaged:     unstaged,
		Untracked:    untracked,
		Conflicted:   conflicted,
	}
}

// --- Numstat parser ---

type numstatResult struct {
	stats  map[string]*snapshotDiff
	binary map[string]bool
}

// runNumstat runs `git diff [--cached] --numstat -z` and parses the output.
//
// With -z, entries are NUL-separated and paths are not quoted. Rename entries
// (with default rename detection) use an extra NUL between new and old path;
// the parser skips non-numstat pieces that are old paths.
func runNumstat(ctx context.Context, dir string, cached bool, pathspecs []string) (numstatResult, string) {
	args := []string{"diff", "--numstat", "-z"}
	if cached {
		args = append(args, "--cached")
	}
	args = appendPathspecs(args, pathspecs)

	out, stderr, code, runErr := runGit(ctx, dir, args...)
	if runErr != nil {
		return numstatResult{}, "git diff 执行失败：" + runErr.Error()
	}
	if code != 0 {
		// An unborn branch has no HEAD to diff against: `git diff` exits 129
		// with "bad revision 'HEAD'". That is the empty state, not a failure.
		if strings.Contains(stderr, "bad revision 'HEAD'") {
			return numstatResult{}, ""
		}
		return numstatResult{}, "git diff 退出码 " + strconv.Itoa(code) + "：" + strings.TrimSpace(stderr)
	}
	return parseNumstat(out), ""
}

func parseNumstat(output string) numstatResult {
	result := numstatResult{
		stats:  make(map[string]*snapshotDiff),
		binary: make(map[string]bool),
	}
	pieces := strings.Split(output, "\x00")
	for _, piece := range pieces {
		if piece == "" {
			continue
		}
		// Each numstat entry starts with "<added>\t<deleted>\t<path>".
		// A piece that is an old path from a rename has no tab.
		tabIdx := strings.IndexByte(piece, '\t')
		if tabIdx <= 0 {
			continue
		}
		firstField := piece[:tabIdx]
		if !isNumstatField(firstField) {
			continue
		}
		parts := strings.SplitN(piece, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		added := parts[0]
		deleted := parts[1]
		path := parts[2]

		if added == "-" || deleted == "-" {
			result.binary[path] = true
		} else {
			ins, _ := strconv.Atoi(added)
			del, _ := strconv.Atoi(deleted)
			result.stats[path] = &snapshotDiff{
				Insertions: ins,
				Deletions:  del,
			}
		}
	}
	return result
}

// isNumstatField reports whether s is a valid first field (a number or "-").
func isNumstatField(s string) bool {
	if s == "-" {
		return true
	}
	_, err := strconv.Atoi(s)
	return err == nil
}

// computeDiffTotals sums the numstat into aggregate insertions/deletions/files_changed.
func computeDiffTotals(ns numstatResult) snapshotDiffTotals {
	totals := snapshotDiffTotals{}
	for _, d := range ns.stats {
		if d != nil {
			totals.FilesChanged++
			totals.Insertions += d.Insertions
			totals.Deletions += d.Deletions
		}
	}
	for _, b := range ns.binary {
		if b {
			totals.FilesChanged++
		}
	}
	return totals
}

// --- Log parser ---

// runLog runs `git log -n <limit>` with a NUL-separated format and parses the
// output into commit entries.
func runLog(ctx context.Context, dir string, limit int) ([]snapshotCommit, string) {
	format := "%h%x00%s%x00%an%x00%aI"
	out, stderr, code, runErr := runGit(ctx, dir, "log", "-n", strconv.Itoa(limit), "--format="+format)
	if runErr != nil {
		return nil, "git log 执行失败：" + runErr.Error()
	}
	if code != 0 {
		// "no commits yet" is a normal state for an unborn branch, not a warning.
		if strings.Contains(stderr, "does not have any commits yet") {
			return []snapshotCommit{}, ""
		}
		return nil, "git log 退出码 " + strconv.Itoa(code) + "：" + strings.TrimSpace(stderr)
	}
	return parseLog(out), ""
}

// parseLog splits the log output into commits. Each commit is one LF-separated
// line with four NUL-separated fields: hash, subject, author, timestamp.
func parseLog(output string) []snapshotCommit {
	var commits []snapshotCommit
	for _, line := range strings.Split(output, "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\x00", 4)
		if len(parts) < 4 {
			continue
		}
		commits = append(commits, snapshotCommit{
			Hash:      parts[0],
			Subject:   parts[1],
			Author:    parts[2],
			Timestamp: parts[3],
		})
	}
	return commits
}

// --- Special state detection ---

// detectSpecialStates checks the .git directory for the marker files that
// indicate an in-progress merge, rebase, cherry-pick, or revert.
func detectSpecialStates(gitDir string) snapshotState {
	return snapshotState{
		MergeInProgress:      fileExists(filepath.Join(gitDir, "MERGE_HEAD")),
		RebaseInProgress:     dirExists(filepath.Join(gitDir, "rebase-merge")) || dirExists(filepath.Join(gitDir, "rebase-apply")),
		CherryPickInProgress: fileExists(filepath.Join(gitDir, "CHERRY_PICK_HEAD")),
		RevertInProgress:     fileExists(filepath.Join(gitDir, "REVERT_HEAD")),
	}
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
