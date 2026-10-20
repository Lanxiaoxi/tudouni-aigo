// Package codeintel keeps the code index in step with the working tree.
//
// The index itself lives in internal/codeintel/cggraph; this package is the piece that decides
// *when* to rebuild it, which turns out to be a design question rather than a scheduling one.
//
// The tempting answer 鈥?rebuild after the tools that write files 鈥?does not work. An agent
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
	}
	return "unknown"
}

// Report is the outcome of one EnsureFresh call.
type Report struct {
	State State
	// Files is the number of files that had diverged (Synced/StaleTooLarge) 鈥?not the number
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

// DefaultMaxInline is how many divergent files may be rebuilt inside a query.
//
// The number is a latency budget, not a correctness one. An incremental rebuild of a handful of
// files costs ~200ms; a large divergence means someone pulled a branch or a generator ran, and
// blocking a query for ten seconds to find that out is worse than answering from a stale index
// with a warning. Above the budget the caller is told, and a human or the model decides.
const DefaultMaxInline = 20

// Refresher keeps one workspace's index fresh.
//
// One instance per workspace, shared by every caller: the mutex is what keeps two parallel tool
// calls from rebuilding the index at the same time. Queries stay read-only, so a tool that uses
// this can still be declared parallel-safe 鈥?the write happens here, serialized, and never
// contends on the database.
type Refresher struct {
	root       string
	parserPath string
	maxInline  int

	mu sync.Mutex
}

// New builds a refresher.
//
// `parserPath` may be empty: that means this build cannot rebuild the index, and EnsureFresh
// reports Unavailable rather than failing. A development build without the parser binary must
// still be able to query an index built earlier.
func New(root, parserPath string) *Refresher {
	return &Refresher{root: root, parserPath: parserPath, maxInline: DefaultMaxInline}
}

// Root is the workspace this refresher maintains.
func (r *Refresher) Root() string { return r.root }

// SetMaxInline overrides the inline rebuild budget, for a caller that would rather never block.
func (r *Refresher) SetMaxInline(files int) {
	if files > 0 {
		r.maxInline = files
	}
}

// EnsureFresh compares the index against the working tree and rebuilds if it is behind.
//
// Safe for concurrent use: calls serialize on a mutex, so the second of two parallel queries
// waits for one rebuild instead of starting a second. It is also idempotent and cheap when
// clean, which is what makes it reasonable to call before every query.
func (r *Refresher) EnsureFresh(ctx context.Context) (report Report, err error) {
	started := time.Now()

	r.mu.Lock()
	defer r.mu.Unlock()

	// Named returns, not a local: a deferred assignment to a local would land on the copy that
	// has already been returned, leaving Elapsed permanently zero.
	report = Report{State: Current}
	defer func() { report.Elapsed = time.Since(started) }()

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

	status, err := db.CheckStaleness(ctx, r.root)
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
	if report.Files > r.maxInline {
		report.State = StaleTooLarge
		report.Detail = fmt.Sprintf("%d files differ, above the %d-file inline rebuild budget",
			report.Files, r.maxInline)
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
	})
	if err != nil {
		return fmt.Errorf("codeintel: index %s: %w", r.root, err)
	}
	return nil
}

// CheckOnly reports the divergence without rebuilding anything.
//
// For a caller that wants to display freshness without mutating the index 鈥?a status command,
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

	status, err := db.CheckStaleness(ctx, r.root)
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
