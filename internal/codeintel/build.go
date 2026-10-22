package codeintel

// The deliberate build path — the two buttons on the panel, and the one thing
// `EnsureFresh` is not allowed to do.
//
// `EnsureFresh` decides *whether* to rebuild behind a query, and it is deliberately
// timid: above its inline budget (MaxInlineTool for a query, MaxInlineWarmup for the
// session warm-up) divergent files it reports instead of building, so a question
// never blocks for minutes on somebody else's branch switch. Init and sync are
// the other half of that contract — a person has said "do it, I am waiting" — and they
// differ from it in two ways that matter:
//
//   - they **wait** for the lock instead of giving up on it, because a person who
//     clicked and is watching a progress line can reasonably wait for another session's
//     rebuild to finish;
//   - they **report progress**, which is the only reason a multi-minute build is
//     tolerable at all: a button that produces nothing for ninety seconds looks broken.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cggraph"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cgparse"
)

// RebuildLockWait is how long a deliberate build waits for another process.
//
// Two minutes rather than the query path's zero: the common contention is one desktop
// window with two conversations, where the other side's build is an ordinary index
// pass rather than a hung process. Past this, saying "another session is updating it"
// is more useful than making the person wait longer for a button that looks stuck.
const RebuildLockWait = 2 * time.Minute

// BuildOptions configures one build.
type BuildOptions struct {
	// Full clears the database first. `init` means full: it is the button a person
	// presses when they want the index rebuilt rather than topped up.
	Full bool
	// OnProgress is called as phases advance. Rates are the indexer's business; the
	// caller decides how often to turn them into a message.
	OnProgress func(phase string, done, total int)
	// Concurrency and ChunkSize are the parser's batching. Zero means the
	// parser's own defaults, which is what the panel uses: the numbers were tuned
	// against this repository and a settings knob nobody can measure is worse than
	// the tuned default.
	Concurrency int
	ChunkSize   int
}

// Build runs one index pass over root.
//
// **The caller holds the lock.** This is the low-level form, used by `Rebuild` (which
// does hold it) and by the CLI — splitting acquisition from work is what keeps the
// lock protocol in one file instead of three.
func Build(ctx context.Context, root, parserPath string, options BuildOptions) (cggraph.IndexResult, error) {
	var result cggraph.IndexResult
	if parserPath == "" {
		return result, fmt.Errorf("codeintel: this build carries no index parser, so the index cannot be built")
	}

	db, err := cggraph.Open(root)
	if err != nil {
		return result, fmt.Errorf("codeintel: open index: %w", err)
	}
	defer db.Close()

	parser := &cgparse.Parser{
		Binary:      parserPath,
		Concurrency: options.Concurrency,
		ChunkSize:   options.ChunkSize,
	}
	result, err = cggraph.Index(ctx, db, cggraph.IndexOptions{
		Root:       root,
		Parser:     parser,
		Full:       options.Full,
		OnProgress: options.OnProgress,
	})
	if err != nil {
		return result, fmt.Errorf("codeintel: index %s: %w", root, err)
	}
	return result, nil
}

// Rebuild runs a deliberate build while holding both locks.
//
// Process-local first, then cross-process, and in that order: the local mutex is the
// one this process can wait on cheaply, and taking the file lock first would let two
// goroutines here both sit in `Acquire` polling for a claim that neither can hold
// because the other one is waiting on the mutex.
func (r *Refresher) Rebuild(ctx context.Context, options BuildOptions) (cggraph.IndexResult, error) {
	var result cggraph.IndexResult
	if r.parserPath == "" {
		return result, fmt.Errorf("this build carries no index parser, so the index cannot be rebuilt")
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	lock, err := Acquire(r.root, RebuildLockWait)
	if err != nil {
		if errors.Is(err, ErrLocked) {
			if holder := Holder(r.root); holder != "" {
				return result, fmt.Errorf("another session (pid %s) is updating this workspace's code index; try again when it finishes", holder)
			}
			return result, fmt.Errorf("another session is updating this workspace's code index; try again when it finishes")
		}
		return result, err
	}
	defer lock.Release()
	// Order matters: stop the heartbeat before releasing, or a tick can rewrite
	// the claim after Release has removed it. Deferred functions run in reverse.
	stopKeepAlive := lock.KeepAlive(time.Minute)
	defer stopKeepAlive()

	return Build(ctx, r.root, r.parserPath, options)
}

// CanRebuild reports whether this build can rebuild the index at all.
//
// False means the parser binary is missing from this installation: an existing index
// can still be queried, but nothing here can update it, and the panel has to say so
// rather than offering a button that always fails.
func (r *Refresher) CanRebuild() bool { return r.parserPath != "" }

// IndexSnapshot is what the index holds and how far behind it is.
//
// Every field is a fact the resolver can answer in milliseconds — `Stats` is four
// counts and `CheckStaleness` is one stat per indexed file — so the panel can ask for
// this each time it opens without the question becoming expensive.
type IndexSnapshot struct {
	// Indexed is whether an index database exists at all.
	Indexed bool
	// Path is the database's location, relative to the workspace, for display.
	Path string
	// SizeBytes is the database file's size on disk.
	SizeBytes int64

	Files, Nodes, Edges int
	Unresolved, Pending int
	AmbiguousEdges      int
	Deferred, Heuristic int
	DeferredByLanguage  map[string]int
	HeuristicByLanguage map[string]int

	// IndexedAt is when the index's rows were last written by a pass. A no-change
	// sync writes nothing, so this is the last pass that changed the graph.
	IndexedAt time.Time

	// Added, Changed and Removed are the divergence from the working tree.
	Added, Changed, Removed, Checked int

	// Problem says why the numbers could not be read, when they could not. Empty is
	// the normal state, including for "there is no index yet" — that is a state the
	// panel draws, not an error.
	Problem string
}

// Stale reports whether the working tree has moved past the index.
func (s IndexSnapshot) Stale() bool { return s.Added+s.Changed+s.Removed > 0 }

// SnapshotOptions configures one Snapshot call.
type SnapshotOptions struct {
	// SkipStaleness omits the working-tree comparison. A build in progress has
	// already emptied or half-written the graph, so the comparison would report
	// every file as "added" — a warning drawn beside the progress bar that says
	// the opposite of what the progress bar says. It is also the expensive half
	// of this call (one walk plus one stat per indexed file) and the panel asks
	// twice a second while it is building.
	SkipStaleness bool
}

// Snapshot reads the index's facts, without building anything.
func (r *Refresher) Snapshot(ctx context.Context, options SnapshotOptions) IndexSnapshot {
	snapshot := IndexSnapshot{
		Path: filepath.ToSlash(filepath.Join(cggraph.IndexDirName, cggraph.DefaultDBName)),
	}
	if _, missing := r.indexMissing(); missing {
		return snapshot
	}
	snapshot.Indexed = true

	db, err := cggraph.Open(r.root)
	if err != nil {
		snapshot.Problem = "the index cannot be opened: " + err.Error()
		return snapshot
	}
	defer db.Close()

	stats, err := db.Stats()
	if err != nil {
		snapshot.Problem = "the index's counts cannot be read: " + err.Error()
		return snapshot
	}
	snapshot.SizeBytes = stats.SizeBytes
	snapshot.Files = stats.Files
	snapshot.Nodes = stats.Nodes
	snapshot.Edges = stats.Edges
	snapshot.Unresolved = stats.Unresolved
	snapshot.Pending = stats.Pending
	snapshot.AmbiguousEdges = stats.AmbiguousEdges
	snapshot.Deferred = stats.Deferred
	snapshot.Heuristic = stats.Heuristic
	snapshot.DeferredByLanguage = stats.DeferredByLanguage
	snapshot.HeuristicByLanguage = stats.HeuristicByLanguage

	if options.SkipStaleness {
		return snapshot
	}
	staleness, err := db.CheckStaleness(ctx, r.root)
	if err != nil {
		// A failed comparison is not proof of freshness; the counts stay zero and the
		// problem says why, so the panel never draws "up to date" over an unknown.
		snapshot.Problem = "the index cannot be compared with the working tree: " + err.Error()
		return snapshot
	}
	snapshot.Added = staleness.Added
	snapshot.Changed = staleness.Changed
	snapshot.Removed = staleness.Removed
	snapshot.Checked = staleness.Checked
	snapshot.IndexedAt = staleness.IndexedAt
	return snapshot
}

// removeIndex deletes the index directory. Used by tests and by a future "forget the
// index" control; deliberately not reachable from the panel, because the schema
// mismatch path is the only place this program has ever needed it and there the
// rebuild replaces the file anyway.
func removeIndex(root string) error {
	return os.RemoveAll(filepath.Join(root, filepath.FromSlash(cggraph.IndexDirName)))
}
