// Package codeintel keeps the code index in step with the working tree.
//
// The index itself lives in internal/codeintel/cggraph; this package is the piece that decides
// *when* to rebuild it, which turns out to be a design question rather than a scheduling one.
//
// The tempting answer — rebuild after the tools that write files — does not work. An agent
// edits code through more paths than any tool list can enumerate: a shell command (`echo > f`,
// `sed -i`, a Python script), `git checkout`, a code generator, a subagent, a background job
// that finishes later, an MCP server, or the person themself in an editor. Watching writes is
// incomplete by construction, and the failure mode is the worst one available: a confident
// answer built from code that no longer exists.
//
// So freshness is derived from the filesystem instead. A stat comparison costs tens of
// milliseconds and cannot miss a write, because it does not care who made it.
package codeintel

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cggraph"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cgparse"
)

// State is what a freshness check concluded.
type State int

const (
	// Current means the index matched the working tree; nothing was done.
	Current State = iota
	// Synced means the index was behind and has been brought up to date.
	Synced
	// StaleTooLarge means the index is behind by more than the inline budget allowed, so it
	// was left alone. A caller should tell the reader rather than block.
	StaleTooLarge
	// Unavailable means freshness cannot be maintained: the index or the parser binary is
	// missing. Answers may be stale and nothing here can fix that.
	Unavailable
	// Failed means a rebuild was attempted and errored.
	Failed
	// Busy means another update — this process's panel action, or another session's
	// runtime — is writing the index right now, so this call neither rebuilt nor was
	// able to look. It is **not** an error: the caller answers from the index it has,
	// with a sentence saying why that answer may be behind.
	Busy
)

// String renders the state for a log line.
func (s State) String() string {
	switch s {
	case Current:
		return "current"
	case Synced:
		return "synced"
	case StaleTooLarge:
		return "stale-too-large"
	case Unavailable:
		return "unavailable"
	case Failed:
		return "failed"
	case Busy:
		return "busy"
	}
	return "unknown"
}

// Report is the outcome of one EnsureFresh call.
type Report struct {
	State State
	// Files is the number of files that had diverged (Synced/StaleTooLarge) — not the number
	// of files indexed, which is a property of the tree, not of this call.
	Files int
	// Added, Changed and Removed break that down.
	Added   int
	Changed int
	Removed int
	// Detail is a human-readable explanation, empty when there is nothing to say.
	Detail string
	// Elapsed is how long this call took.
	Elapsed time.Duration
}

// The inline rebuild budget is a latency budget, not a correctness one: an
// incremental rebuild of a handful of files costs ~200ms, while a large
// divergence means someone pulled a branch or a generator ran, and blocking a
// query for ten seconds to find that out is worse than answering from a stale
// index with a warning. Above the budget the caller is told, and a human or
// the model decides.
//
// The two callers pay for the catch-up differently, so they carry different
// budgets:
//   - MaxInlineTool bounds what a query may wait for. The model is reading the
//     answer, so the ceiling stays tight.
//   - MaxInlineWarmup bounds the background pass at session open. Nobody is
//     waiting on it — it overlaps reading and typing — so it may absorb a
//     larger divergence on the way to making that first query free.
const (
	MaxInlineTool    = 15
	MaxInlineWarmup  = 30
)

// Refresher keeps one workspace's index fresh.
//
// One instance per workspace **per process**, shared by every caller: `mu` is what keeps
// two parallel tool calls from rebuilding the index at the same time. It is not enough on
// its own — one desktop window runs one runtime child per conversation, so two of these
// can sit over one index — which is why every write path also takes the cross-process
// claim in lock.go. Queries stay read-only, so a tool that uses this can still be declared
// parallel-safe: the writes happen here, serialized twice, and never contend on the
// database.
type Refresher struct {
	root       string
	parserPath string

	mu sync.Mutex

	// repos is the selection of repositories the index covers, read from
	// config.json at construction and on every ReloadSelection. The walk and
	// the staleness check must both use it, so it lives on the refresher
	// rather than being passed down call by call: a call site that forgot it
	// would compare the index against a different tree than the one it was
	// built from, and report stale forever.
	repos []string
}

// New builds a refresher.
//
// `parserPath` may be empty: that means this build cannot rebuild the index, and EnsureFresh
// reports Unavailable rather than failing. A development build without the parser binary must
// still be able to query an index built earlier.
func New(root, parserPath string) *Refresher {
	return &Refresher{root: root, parserPath: parserPath, repos: LoadConfig(root).Repos}
}

// Root is the workspace this refresher maintains.
func (r *Refresher) Root() string { return r.root }

// Repos is the saved repository selection; empty means "the whole workspace".
func (r *Refresher) Repos() []string { return r.repos }

// Scope is the tree view the index is built and checked against, derived from
// the saved selection. Nil-safe: an unset refresher sees the whole tree.
func (r *Refresher) Scope() *cggraph.Scope {
	if r == nil {
		return nil
	}
	return ResolveScopes(r.root, r.repos)
}

// ReloadSelection re-reads the repository selection from config.json.
//
// The file is the shared fact, not this field: another conversation's runtime
// can change the selection while this process is running, and the next panel
// status must reflect it — the same reason the enabled switch has its
// refresh path.
func (r *Refresher) ReloadSelection() {
	if r == nil {
		return
	}
	r.repos = LoadConfig(r.root).Repos
}

// EnsureFresh compares the index against the working tree and rebuilds if it is
// behind.
//
// Safe for concurrent use, and it **never waits**: both locks are tried rather than
// taken. A query that blocks for minutes behind somebody else's rebuild is worse than
// an answer that says "the index is being updated" — the model can act on the second
// and cannot act on the first. The deliberate path (`Rebuild`) is where waiting is the
// right behaviour, because a person is watching a progress line there.
//
// `maxInline` is this call's inline rebuild budget, supplied by the caller rather
// than stored on the refresher because the two callers pay for the catch-up
// differently: the tool's is MaxInlineTool, the warm-up's is MaxInlineWarmup.
func (r *Refresher) EnsureFresh(ctx context.Context, maxInline int) (report Report, err error) {
	started := time.Now()

	// Named returns, not a local: a deferred assignment to a local would land on the copy that
	// has already been returned, leaving Elapsed permanently zero.
	report = Report{State: Current}
	defer func() { report.Elapsed = time.Since(started) }()

	if !r.mu.TryLock() {
		report.State = Busy
		report.Detail = "this session is updating the index right now, so the answer below may be behind"
		return report, nil
	}
	defer r.mu.Unlock()

	// The cross-process claim, same rule: try once, never wait. A failed claim is not
	// an error and not proof of staleness — it is "somebody else owns the tree".
	lock, lockErr := Acquire(r.root, 0)
	if lockErr != nil {
		// A real IO error is not "somebody else is building": reporting it as Busy
		// sends the reader to wait for a session that does not exist.
		if !errors.Is(lockErr, ErrLocked) {
			report.State = Failed
			report.Detail = "could not claim the index: " + lockErr.Error()
			return report, nil
		}
		report.State = Busy
		if holder := Holder(r.root); holder != "" {
			report.Detail = "another session (pid " + holder +
				") is updating the index right now, so the answer below may be behind"
		} else {
			report.Detail = "another session is updating the index right now, so the answer below may be behind"
		}
		return report, nil
	}
	defer lock.Release()
	stopKeepAlive := lock.KeepAlive(time.Minute)
	defer stopKeepAlive()

	if detail, missing := r.indexMissing(); missing {
		report.State = Unavailable
		report.Detail = detail
		return report, nil
	}

	db, err := cggraph.Open(r.root)
	if err != nil {
		report.State = Unavailable
		report.Detail = "no usable index: " + err.Error()
		return report, nil
	}
	defer db.Close()

	status, err := db.CheckStaleness(ctx, r.root, r.Scope())
	if err != nil {
		// A failed check is not proof of freshness. Say so instead of claiming Current.
		report.State = Failed
		report.Detail = "could not compare the index with the working tree: " + err.Error()
		return report, nil
	}
	if !status.Stale() {
		return report, nil
	}

	report.Added, report.Changed, report.Removed = status.Added, status.Changed, status.Removed
	report.Files = status.Difference()

	if r.parserPath == "" {
		report.State = Unavailable
		report.Detail = "the parser binary is not available in this build, so the index cannot be updated"
		return report, nil
	}
	if report.Files > maxInline {
		report.State = StaleTooLarge
		report.Detail = fmt.Sprintf("%d files differ, above the %d-file inline rebuild budget",
			report.Files, maxInline)
		return report, nil
	}

	if err := r.rebuild(ctx, db); err != nil {
		report.State = Failed
		report.Detail = "rebuilding the index failed: " + err.Error()
		return report, nil
	}
	report.State = Synced
	return report, nil
}

// Warmup brings the index up to date in the background, for a caller that wants
// the next query to be fast without paying for it there.
//
// Fire-and-forget: the work runs on its own goroutine with its own context, so
// a caller that goes away a second later does not kill a pass that is already
// bounded by the inline budget. The report is discarded on purpose — the only
// consumer of an EnsureFresh report is the model-facing warning line, and a
// warm-up nobody asked about has no news to report.
//
// It does nothing when this build cannot rebuild: without the parser the pass
// can only end in "unavailable", and paying a full staleness scan to learn that
// would make the warm-up's own cost the worst case it exists to prevent.
func (r *Refresher) Warmup() {
	if r.parserPath == "" {
		return
	}
	go func() {
		_, _ = r.EnsureFresh(context.Background(), MaxInlineWarmup)
	}()
}

// indexMissing reports whether this workspace has never been indexed.
//
// Checked before opening, because Open migrates and therefore creates the file: opening a
// never-indexed workspace would otherwise report "current", which reads as "your index is up to
// date" when there is no index at all.
func (r *Refresher) indexMissing() (string, bool) {
	path := filepath.Join(r.root, cggraph.IndexDirName, cggraph.DefaultDBName)
	info, err := os.Stat(path)
	if err == nil && !info.IsDir() {
		return "", false
	}
	return "this workspace has no code index yet; run the indexer to build one", true
}

// rebuild runs one incremental index pass.
//
// r.mu is already held by the caller, so this is the only writer.
func (r *Refresher) rebuild(ctx context.Context, db *cggraph.DB) error {
	parser := &cgparse.Parser{Binary: r.parserPath}
	_, err := cggraph.Index(ctx, db, cggraph.IndexOptions{
		Root:   r.root,
		Parser: parser,
		Scope:  r.Scope(),
	})
	if err != nil {
		return fmt.Errorf("codeintel: index %s: %w", r.root, err)
	}
	return nil
}

// CheckOnly reports the divergence without rebuilding anything.
//
// For a caller that wants to display freshness without mutating the index — a status command,
// or a tool that would rather always answer immediately.
func (r *Refresher) CheckOnly(ctx context.Context) (Report, error) {
	started := time.Now()
	report := Report{State: Current}

	if detail, missing := r.indexMissing(); missing {
		report.State = Unavailable
		report.Detail = detail
		report.Elapsed = time.Since(started)
		return report, nil
	}

	db, err := cggraph.Open(r.root)
	if err != nil {
		report.State = Unavailable
		report.Detail = "no usable index: " + err.Error()
		report.Elapsed = time.Since(started)
		return report, nil
	}
	defer db.Close()

	status, err := db.CheckStaleness(ctx, r.root, r.Scope())
	if err != nil {
		report.State = Failed
		report.Detail = err.Error()
		report.Elapsed = time.Since(started)
		return report, nil
	}
	report.Added, report.Changed, report.Removed = status.Added, status.Changed, status.Removed
	report.Files = status.Difference()
	if status.Stale() {
		report.State = StaleTooLarge
		report.Detail = status.Summarise()
	}
	report.Elapsed = time.Since(started)
	return report, nil
}
