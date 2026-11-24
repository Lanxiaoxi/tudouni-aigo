// Package gitinfo answers "what does git say about this workspace" for the
// workspace host: status with staged and unstaged kept apart, and file diffs.
//
// It shells out to the `git` binary rather than linking a library, for the same
// reason `git_snapshot` does: the answers have to match what the person sees
// when they run git themselves, including their config and their git version's
// quirks. Everything here is read-only.
//
// Two rules hold throughout:
//
//   - Arguments are always an array, paths come after `--` and are wrapped as
//     literal pathspecs, so a file named `--output=x` or `:(top)*` is just a name.
//   - The workspace may sit below the repository root. Only what is inside the
//     workspace is reported, and every path is rewritten relative to the
//     workspace, because that is the only coordinate system the front end has.
package gitinfo

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var (
	// ErrNoGit means the `git` executable is not available.
	ErrNoGit = errors.New("git is not installed or not on PATH")
	// ErrNotRepo means the directory is not inside a git work tree. It is a normal
	// state for a workspace, not a failure.
	ErrNotRepo = errors.New("not a git repository")
)

// commandTimeout bounds a single git invocation. A hung `git status` on a huge
// tree or a dead network drive must not wedge the host's request loop.
const commandTimeout = 20 * time.Second

// Repo is where a workspace sits inside its repository.
type Repo struct {
	// Dir is the workspace directory every command runs in.
	Dir string
	// GitDir is the absolute path of the git directory (where MERGE_HEAD lives).
	GitDir string
	// Prefix is the workspace's path relative to the repository root, with a
	// trailing `/`, or "" when the workspace is the root. git reports paths from
	// the root, and this is what turns them into workspace paths.
	Prefix string
}

// Available reports whether a git executable can be found.
func Available() bool {
	_, err := exec.LookPath("git")
	return err == nil
}

// Open locates the repository containing dir.
func Open(ctx context.Context, dir string) (*Repo, error) {
	if !Available() {
		return nil, ErrNoGit
	}
	// One call for all three facts. `--show-prefix` is the load-bearing one: it
	// is computed by git from its own view of the paths, so it stays right when
	// the workspace is reached through a symlink or a differently-cased path.
	out, stderr, code, err := run(ctx, dir, "rev-parse", "--absolute-git-dir", "--show-prefix")
	if err != nil {
		return nil, err
	}
	if code != 0 {
		if strings.Contains(stderr, "not a git repository") {
			return nil, ErrNotRepo
		}
		// "dubious ownership" and friends: report as not-a-repo with the cause
		// available to a log, rather than failing the whole panel.
		return nil, ErrNotRepo
	}
	lines := strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n")
	if len(lines) < 1 || strings.TrimSpace(lines[0]) == "" {
		return nil, ErrNotRepo
	}
	repo := &Repo{Dir: dir, GitDir: filepath.FromSlash(strings.TrimSpace(lines[0]))}
	if len(lines) > 1 {
		repo.Prefix = strings.TrimSpace(lines[1])
	}
	return repo, nil
}

// Operation reports a multi-step operation in progress, by the marker files git
// leaves in its directory. Rebase is checked first because a rebase that stops on
// a conflict also leaves CHERRY_PICK_HEAD behind, and "rebase" is the truth.
func (r *Repo) Operation() string {
	exists := func(name string) bool {
		_, err := os.Stat(filepath.Join(r.GitDir, name))
		return err == nil
	}
	switch {
	case exists("rebase-merge"), exists("rebase-apply"):
		return "rebase"
	case exists("MERGE_HEAD"):
		return "merge"
	case exists("CHERRY_PICK_HEAD"):
		return "cherry-pick"
	case exists("REVERT_HEAD"):
		return "revert"
	case exists("BISECT_LOG"):
		return "bisect"
	}
	return ""
}

// gitEnv is the environment for every git child.
//
//   - GIT_OPTIONAL_LOCKS=0: `git status` normally refreshes the index and takes
//     index.lock to write it back. The host polls; it must never be the reason a
//     person's own `git commit` fails with "index.lock exists".
//   - LC_ALL=C: output we match on ("Binary files ... differ", "not a git
//     repository") is translated otherwise.
//   - GIT_TERMINAL_PROMPT=0: nothing here may wait for a person.
func gitEnv() []string {
	return append(os.Environ(),
		"GIT_OPTIONAL_LOCKS=0",
		"LC_ALL=C",
		"GIT_TERMINAL_PROMPT=0",
	)
}

// gitArgs prefixes the arguments every invocation shares. `core.quotepath=off`
// keeps non-ASCII names readable in the text outputs (the -z outputs are never
// quoted anyway).
func gitArgs(args []string) []string {
	return append([]string{"-c", "core.quotepath=off"}, args...)
}

// run executes git and returns its output. err is non-nil only when git could not
// be started; a non-zero exit is reported through code.
func run(ctx context.Context, dir string, args ...string) (stdout, stderr string, code int, err error) {
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", gitArgs(args)...)
	cmd.Dir = dir
	cmd.Env = gitEnv()
	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	runErr := cmd.Run()
	if runErr != nil {
		var exit *exec.ExitError
		if errors.As(runErr, &exit) {
			return out.String(), errBuf.String(), exit.ExitCode(), nil
		}
		return "", "", -1, runErr
	}
	return out.String(), errBuf.String(), 0, nil
}

// literal turns a workspace-relative path into a pathspec that matches exactly
// that path: no globbing, no magic prefixes.
func literal(path string) string { return ":(literal)" + path }
