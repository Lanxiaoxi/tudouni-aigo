package gitinfo

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path"
	"strings"
	"unicode/utf8"
)

// MaxDiffBytes caps one diff. A generated file or a lockfile can produce tens of
// megabytes of diff, and the panel cannot render that usefully; what matters is
// that the cut is reported, not silent.
const MaxDiffBytes = 512 * 1024

// Diff sources, as on the wire.
const (
	SourceWorktree  = "worktree"
	SourceIndex     = "index"
	SourceUntracked = "untracked"
)

// ErrBadPath means the path is not a plain path inside the workspace.
var ErrBadPath = errors.New("path must be relative and inside the workspace")

// DiffResult is the wire shape of `git_diff`.
type DiffResult struct {
	Path      string `json:"path"`
	Source    string `json:"source"`
	OldPath   string `json:"old_path"`
	Diff      string `json:"diff"`
	Binary    bool   `json:"binary"`
	Truncated bool   `json:"truncated"`
}

// GetDiff produces the unified diff of one file.
//
//	worktree   unstaged changes: index -> working tree
//	index      staged changes:   HEAD  -> index (an unborn branch diffs against empty)
//	untracked  the whole file as an addition, via `--no-index` against /dev/null
//
// rel is relative to dir (the workspace). The caller is expected to have run it
// through the workspace boundary check already; the validation here is the second
// line, because this is the function that turns a string into git arguments.
func GetDiff(ctx context.Context, dir, rel, source string) (*DiffResult, error) {
	clean, err := cleanRel(rel)
	if err != nil {
		return nil, err
	}
	if source != SourceWorktree && source != SourceIndex && source != SourceUntracked {
		return nil, fmt.Errorf("unknown diff source %q", source)
	}
	if _, err := Open(ctx, dir); err != nil {
		return nil, err
	}

	result := &DiffResult{Path: clean, Source: source}
	// --no-ext-diff and --no-textconv: both run programs named in the repository's
	// own config, and a viewer must not execute what a clone brought along.
	base := []string{"diff", "--no-color", "--no-ext-diff", "--no-textconv"}

	var args []string
	switch source {
	case SourceWorktree:
		args = append(base, "--", literal(clean))
	case SourceIndex:
		args = append(base, "--cached", "-M")
		specs := []string{literal(clean)}
		if orig := renameOrigin(ctx, dir, clean); orig != "" {
			// Both sides of a rename have to be in the pathspec, or git sees a
			// deletion and an addition instead of one rename.
			result.OldPath = orig
			specs = append(specs, literal(orig))
		}
		args = append(args, "--")
		args = append(args, specs...)
	case SourceUntracked:
		// `--no-index` takes paths, not pathspecs, so there is no magic to escape;
		// `--` still ends option parsing for a name that starts with a dash.
		args = append(base, "--no-index", "--", "/dev/null", clean)
	}

	out, stderr, code, truncated, err := runLimited(ctx, dir, MaxDiffBytes, args...)
	if err != nil {
		return nil, err
	}
	// `--no-index` exits 1 when the files differ, which for an untracked file is
	// always. Treating that as failure would make every untracked diff an error.
	ok := code == 0 || (source == SourceUntracked && code == 1)
	if !ok && !truncated {
		return nil, fmt.Errorf("git diff failed (exit %d): %s", code, strings.TrimSpace(stderr))
	}

	if isBinaryDiff(out) {
		result.Binary = true
		return result, nil
	}
	if truncated {
		out = trimToRune(out)
		result.Truncated = true
	}
	result.Diff = out
	return result, nil
}

// cleanRel validates and normalises a workspace-relative path.
func cleanRel(rel string) (string, error) {
	rel = strings.ReplaceAll(rel, "\\", "/")
	if rel == "" || rel == "." || strings.HasPrefix(rel, "/") || strings.Contains(rel, ":") && len(rel) > 1 && rel[1] == ':' {
		return "", ErrBadPath
	}
	clean := path.Clean(rel)
	if clean == ".." || strings.HasPrefix(clean, "../") || clean == "." {
		return "", ErrBadPath
	}
	return clean, nil
}

// renameOrigin finds where a staged rename came from, or "".
func renameOrigin(ctx context.Context, dir, rel string) string {
	// The whole staged set is inspected, not just `rel`: a pathspec naming only the
	// new path hides the old one, and git then has nothing to pair it with. With
	// `--relative` the names come back in workspace terms, which is what the next
	// `git diff` takes as a pathspec.
	out, _, code, err := run(ctx, dir, "diff", "--cached", "-M", "--name-status", "-z",
		"--relative", "--no-ext-diff", "--", ".")
	if err != nil || code != 0 {
		return ""
	}
	// -z name-status: "R100\0old\0new\0", "M\0path\0".
	pieces := strings.Split(out, "\x00")
	for i := 0; i < len(pieces); i++ {
		status := pieces[i]
		if status == "" {
			continue
		}
		if status[0] == 'R' || status[0] == 'C' {
			if i+2 < len(pieces) {
				if pieces[i+2] == rel && status[0] == 'R' {
					return pieces[i+1]
				}
				i += 2
			}
			continue
		}
		i++ // a single-path record
	}
	return ""
}

// isBinaryDiff recognises git's two ways of saying "this is not text".
func isBinaryDiff(out string) bool {
	if strings.HasPrefix(out, "Binary files ") || strings.Contains(out, "\nBinary files ") {
		return true
	}
	return strings.Contains(out, "\nGIT binary patch")
}

// trimToRune cuts a possibly mid-character tail so the string stays valid UTF-8.
func trimToRune(s string) string {
	for i := 0; i < utf8.UTFMax && len(s) > 0; i++ {
		if r, size := utf8.DecodeLastRuneInString(s); r == utf8.RuneError && size <= 1 {
			s = s[:len(s)-1]
			continue
		}
		break
	}
	return s
}

// limitWriter keeps the first `max` bytes and cancels the command when more
// arrive, so a multi-gigabyte diff costs neither memory nor wall-clock time.
type limitWriter struct {
	buf       bytes.Buffer
	max       int
	cancel    context.CancelFunc
	truncated bool
}

func (w *limitWriter) Write(p []byte) (int, error) {
	room := w.max - w.buf.Len()
	if room >= len(p) {
		w.buf.Write(p)
		return len(p), nil
	}
	if room > 0 {
		w.buf.Write(p[:room])
	}
	w.truncated = true
	w.cancel()
	// Report everything as written: returning short would make exec fail the copy
	// with ErrShortWrite and hide the real reason we stopped.
	return len(p), nil
}

// runLimited runs git capturing at most max bytes of stdout.
func runLimited(ctx context.Context, dir string, max int, args ...string) (stdout, stderr string, code int, truncated bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", gitArgs(args)...)
	cmd.Dir = dir
	cmd.Env = gitEnv()
	out := &limitWriter{max: max, cancel: cancel}
	var errBuf bytes.Buffer
	cmd.Stdout = out
	cmd.Stderr = &errBuf
	runErr := cmd.Run()
	if runErr != nil && !out.truncated {
		var exit *exec.ExitError
		if errors.As(runErr, &exit) {
			return out.buf.String(), errBuf.String(), exit.ExitCode(), false, nil
		}
		return "", "", -1, false, runErr
	}
	return out.buf.String(), errBuf.String(), 0, out.truncated, nil
}
