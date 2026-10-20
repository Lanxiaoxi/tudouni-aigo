package codeintel

// One writer across processes.
//
// `Refresher.mu` serialises the rebuilds inside one process, and that is not enough
// for this build: a desktop window runs **one runtime child per conversation**
// (see the desktop's `store.ts`), so two conversations on one workspace are two
// processes, two `Refresher`s and one SQLite file. SQLite's own `busy_timeout` (5s
// here) cannot cover the case — a full index pass takes minutes on a large tree —
// so the second writer would fail with "database is locked" halfway through and the
// panel would report a failure that says nothing about what actually happened.
//
// So the lock is a file, claimed with `O_EXCL`. It is advisory (nothing stops a
// person deleting it) and that is the right level: the only thing it has to do is
// keep two of *this program's* processes from rebuilding the same tree at once.
//
// The claim carries a pid and a timestamp because the one failure mode a lock file
// has is a process that died while holding it. A lock older than
// `LockStaleAfter` is taken over rather than waited on for ever: the alternative is
// a workspace whose index can never be updated again until somebody knows to delete
// a hidden file.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cggraph"
)

const (
	// LockName is the lock file inside the index directory.
	LockName = "lock"
	// LockStaleAfter is when an existing claim is treated as abandoned.
	//
	// Fifteen minutes is deliberately far above any real rebuild: the failure it
	// has to catch is a killed process, not a slow one, and a lock that expires
	// during a legitimate long build would let a second process in — the thing this
	// file exists to prevent.
	LockStaleAfter = 15 * time.Minute
	// LockPollInterval is how often a waiting caller retries.
	LockPollInterval = 100 * time.Millisecond
)

// ErrLocked is what a caller gets when another process holds the index.
//
// It is a sentinel rather than a formatted error because the callers answer
// differently: `EnsureFresh` reports it to the model as "the index is being updated",
// and a panel action shows it as a sentence. Deciding which is the caller's job.
var ErrLocked = errors.New("another session is updating this workspace's code index")

// Lock is one held claim on a workspace's index.
type Lock struct {
	path string
	held bool
}

// LockPath is where the claim lives for a workspace.
func LockPath(root string) string {
	return filepath.Join(root, filepath.FromSlash(cggraph.IndexDirName), LockName)
}

// Acquire claims the workspace's index.
//
// `wait` is how long to keep trying: zero means "ask once", which is what a query
// wants (a query must not block behind somebody else's rebuild), and a positive
// duration is what a deliberate init/sync wants.
//
// A claim by a process that has since died is taken over after `LockStaleAfter`, and
// so is one whose timestamp cannot be read at all — an unparsable lock is far more
// likely to be a half-written file from a crash than a claim worth honouring.
func Acquire(root string, wait time.Duration) (*Lock, error) {
	path := LockPath(root)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("codeintel: create index directory: %w", err)
	}

	deadline := time.Now().Add(wait)
	for {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			// The claim's own bytes are for the *next* reader, not for this one:
			// a lock nobody can attribute is a lock somebody deletes by hand.
			fmt.Fprintf(file, "%d\n%d\n", os.Getpid(), time.Now().UnixNano())
			file.Close()
			return &Lock{path: path, held: true}, nil
		}
		if !os.IsExist(err) {
			return nil, fmt.Errorf("codeintel: claim %s: %w", path, err)
		}

		if staleLock(path) {
			// Removing a stale claim races with another waiter doing the same
			// thing; both then retry and exactly one wins the `O_EXCL`, so the
			// loser simply loops. Remove errors are ignored for the same reason:
			// if it is gone already, the next attempt is the one that matters.
			os.Remove(path)
			continue
		}
		if wait <= 0 || time.Now().After(deadline) {
			return nil, ErrLocked
		}
		time.Sleep(LockPollInterval)
	}
}

// staleLock reports whether the claim at `path` should be taken over.
//
// A missing file is not stale: the caller's own retry will succeed, and reporting
// it here would send the loop round a `continue` that claims nothing.
func staleLock(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	if time.Since(info.ModTime()) > LockStaleAfter {
		return true
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) < 2 {
		// A claim written by something that died between `O_EXCL` and the write.
		// Age is the only evidence available, and ModTime already said it is fresh,
		// so treat it as held: a false takeover risks two writers, which is worse
		// than a delay that the same stale rule will clear.
		return false
	}
	nanos, err := strconv.ParseInt(strings.TrimSpace(lines[1]), 10, 64)
	if err != nil {
		return true
	}
	return time.Since(time.Unix(0, nanos)) > LockStaleAfter
}

// Release gives the claim back.
//
// Idempotent: a second call does nothing, which matters because the callers release
// in a `defer` that can run after a failed acquire path took the same `defer`.
func (l *Lock) Release() {
	if l == nil || !l.held {
		return
	}
	l.held = false
	os.Remove(l.path)
}

// Holder is who claims the index, for a message that has to name them.
//
// Empty when the lock is free or unreadable — a sentence that says "another session"
// is still true, and inventing a pid for a file that is gone would be worse.
func Holder(root string) string {
	raw, err := os.ReadFile(LockPath(root))
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) == 0 {
		return ""
	}
	pid := strings.TrimSpace(lines[0])
	if _, err := strconv.Atoi(pid); err != nil {
		return ""
	}
	return pid
}
