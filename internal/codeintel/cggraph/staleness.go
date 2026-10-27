package cggraph

// How far the index is behind the working tree.
//
// This exists because a stale answer is worse than no answer. An agent that edits a file and
// immediately asks where a symbol is used will get the graph from before its edit, and nothing
// in that result says so — the model then treats a stale fact as a current one. The check is
// deliberately cheap (stat only, never reading contents) so it can run before every query.
//
// The official tool solves the same problem with a live file-system watcher and a staleness
// banner; this is the banner without the watcher, because the runtime is tool-call driven
// rather than a long-lived daemon.

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
)

// Staleness is the result of comparing the index against the tree.
type Staleness struct {
	// Changed counts indexed files whose size or modification time moved.
	Changed int
	// Removed counts indexed files that no longer exist.
	Removed int
	// Added counts indexable files on disk that the index has never seen.
	Added int
	// Checked counts indexed files examined.
	Checked int
	// IndexedAt is when the index's rows were last written. A no-change sync
	// writes nothing, so this is the last pass that actually changed the graph.
	IndexedAt time.Time
}

// Stale reports whether anything diverged.
func (s Staleness) Stale() bool { return s.Changed+s.Removed+s.Added > 0 }

// Difference is the total number of divergences, for a one-line message.
func (s Staleness) Difference() int { return s.Changed + s.Removed + s.Added }

// Summarise renders the divergence for a human or a model, or "" when current.
//
// The wording matters: it has to make clear that the results that follow may be out of date,
// and what to do about it, without being so alarming that the answer is distrusted when the
// index happens to be current.
func (s Staleness) Summarise() string {
	if !s.Stale() {
		return ""
	}
	parts := make([]string, 0, 3)
	if s.Changed > 0 {
		parts = append(parts, fmt.Sprintf("%d modified", s.Changed))
	}
	if s.Added > 0 {
		parts = append(parts, fmt.Sprintf("%d added", s.Added))
	}
	if s.Removed > 0 {
		parts = append(parts, fmt.Sprintf("%d deleted", s.Removed))
	}
	return "index is behind the working tree: " + strings.Join(parts, ", ") +
		" since it was built. Symbols added or renamed by those edits may be missing or stale; " +
		"treat file contents as authoritative and re-run the indexer if the answer looks wrong."
}

// CheckStaleness compares the indexed files against the tree.
//
// Cost is one stat per indexed file plus one directory walk, with no file contents read — on
// the order of milliseconds for a few thousand files, which is why every query can afford it.
//
// A missing database or a never-built index reports not-stale: there is nothing to be stale
// relative to, and the tool is not registered in that case anyway.
//
// `scope` is the same view of the tree the index was built with: a nil scope is the whole
// tree. The walk must match the build's or the two sides of the comparison would disagree —
// a file inside a sub-repo that the build carved out of the root's walk would be counted
// as "added" on every check, and the index would look stale forever.
func (d *DB) CheckStaleness(ctx context.Context, root string, scope *Scope) (Staleness, error) {
	var result Staleness

	rows, err := d.sql.QueryContext(ctx, `SELECT path, size, modified_at FROM files`)
	if err != nil {
		return result, err
	}
	defer rows.Close()

	indexed := make(map[string]struct{}, 1024)
	for rows.Next() {
		var path string
		var size, modifiedAt int64
		if err := rows.Scan(&path, &size, &modifiedAt); err != nil {
			return result, err
		}
		result.Checked++
		indexed[path] = struct{}{}

		info, statErr := os.Stat(path)
		if statErr != nil {
			result.Removed++
			continue
		}
		if info.Size() != size || info.ModTime().UnixMilli() != modifiedAt {
			result.Changed++
		}
	}
	if err := rows.Err(); err != nil {
		return result, err
	}

	// Files on disk the index has never seen. The walk shares scanTree's filtering, so a
	// file it would refuse to index is not reported as missing from the index.
	onDisk, err := scanScopes(root, scope)
	if err != nil {
		return result, err
	}
	for _, file := range onDisk {
		if _, ok := indexed[file.path]; !ok {
			result.Added++
		}
	}

	if result.IndexedAt, err = d.lastIndexedAt(ctx); err != nil {
		return result, err
	}
	return result, nil
}

// lastIndexedAt is when this index's contents were last written by a pass.
//
// `indexed_at`, not `modified_at`: the latter is the source file's own mtime, so a
// repository whose files were last touched years ago would report that the index
// was built years ago the moment it finished. They are different questions and the
// panel asks this one.
func (d *DB) lastIndexedAt(ctx context.Context) (time.Time, error) {
	var stamp int64
	err := d.sql.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(indexed_at), 0) FROM files`).Scan(&stamp)
	if err != nil {
		return time.Time{}, err
	}
	if stamp == 0 {
		return time.Time{}, nil
	}
	return time.UnixMilli(stamp), nil
}

// measure single change
