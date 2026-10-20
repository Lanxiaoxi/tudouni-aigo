package cggraph

// Opening, migrating and closing the index database.
//
// One connection, WAL mode, and the write path serialized by the store's own
// mutex rather than by SQLite's busy handler. A single-writer design is right
// here because the only writer is this process's indexer: two concurrent writers
// would mean two indexings of the same tree fighting over the same rows.

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
)

// DB is the index database.
type DB struct {
	sql  *sql.DB
	path string
}

// DefaultDBName is the file inside the index directory.
const DefaultDBName = "graph.db"

// IndexDirName is the directory, relative to a workspace root, that holds the
// index.
//
// It sits **inside** the workspace's state directory (`<workspace>/.tudouni/index`)
// rather than beside it, because one workspace means one directory to ignore, to
// back up or to delete — a second dot-directory at the repository root was a thing
// people had to learn about, and every one of them had to remember to ignore it.
//
// It is a **subdirectory** rather than a sibling of the state files so that wiping
// the index can never take the permission policy, the sessions or the logs with it:
// the index is a rebuildable cache, and `rm -rf .tudouni/index` is a sentence
// somebody should be able to say without checking what else lives there.
const IndexDirName = paths.RuntimeDirName + "/index"

// Open opens or creates the index under `workspaceRoot`.
func Open(workspaceRoot string) (*DB, error) {
	dir := filepath.Join(workspaceRoot, IndexDirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("cggraph: create index dir: %w", err)
	}
	return OpenPath(filepath.Join(dir, DefaultDBName))
}

// OpenPath opens or creates the database at `path`.
func OpenPath(path string) (*DB, error) {
	dsn := path + "?_pragma=journal_mode(WAL)" +
		"&_pragma=busy_timeout(5000)" +
		"&_pragma=foreign_keys(0)" +
		"&_pragma=synchronous(NORMAL)"
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("cggraph: open %s: %w", path, err)
	}
	// One connection: writers serialize by design, and a pool would let two
	// goroutines deadlock on the same table lock while both hold a statement.
	sqlDB.SetMaxOpenConns(1)

	db := &DB{sql: sqlDB, path: path}
	if err := db.migrate(); err != nil {
		sqlDB.Close()
		return nil, err
	}
	return db, nil
}

// Path is the database file.
func (d *DB) Path() string { return d.path }

// SQL exposes the underlying handle for callers that need a query this package
// does not wrap. It is an escape hatch, not the normal way in.
func (d *DB) SQL() *sql.DB { return d.sql }

// Close releases the handle.
func (d *DB) Close() error { return d.sql.Close() }

// migrate creates the schema and records the version.
//
// `CREATE TABLE IF NOT EXISTS` makes this idempotent, which is what lets the same
// call serve both a fresh database and an existing one. A version mismatch is a
// hard error rather than a silent upgrade: this tool's schema is a cache, so the
// correct response to an unexpected version is to rebuild it, and that decision
// belongs to the caller with a message rather than to a migration that guesses.
func (d *DB) migrate() error {
	if _, err := d.sql.Exec(Schema()); err != nil {
		return fmt.Errorf("cggraph: apply schema: %w", err)
	}

	var existing int
	err := d.sql.QueryRow("SELECT COALESCE(MAX(version), 0) FROM schema_versions").Scan(&existing)
	if err != nil {
		return fmt.Errorf("cggraph: read schema version: %w", err)
	}
	switch {
	case existing == 0:
		_, err = d.sql.Exec(
			"INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)",
			SchemaVersion, time.Now().UnixMilli(), "initial schema")
		if err != nil {
			return fmt.Errorf("cggraph: record schema version: %w", err)
		}
	case existing != SchemaVersion:
		return fmt.Errorf(
			"cggraph: %s has schema version %d, this build expects %d; delete the index and re-build it",
			d.path, existing, SchemaVersion)
	}
	return nil
}

// Stats is what `cg status` reports.
type Stats struct {
	Files      int
	Nodes      int
	Edges      int
	Unresolved int
	Pending    int
	SizeBytes  int64
	Journal    string
	// Deferred counts files that produced NO symbols at all — the coverage hole. A language
	// whose files all land here is a parser gap the user needs to see.
	Deferred int
	// Heuristic counts files the grammar rejected but the line scanner could read. They have
	// symbols but no call graph, which is a different fact from an empty file and must not be
	// reported as one.
	Heuristic           int
	DeferredByLanguage  map[string]int
	HeuristicByLanguage map[string]int
	// AmbiguousEdges counts edges whose target was chosen from several equally-scored
	// candidates. A rising number means resolution is guessing more.
	AmbiguousEdges int
}

// Stats reads the counts.
func (d *DB) Stats() (Stats, error) {
	var s Stats
	queries := []struct {
		query string
		into  *int
	}{
		{"SELECT COUNT(*) FROM files", &s.Files},
		{"SELECT COUNT(*) FROM nodes", &s.Nodes},
		{"SELECT COUNT(*) FROM edges", &s.Edges},
		{"SELECT COUNT(*) FROM unresolved_refs", &s.Unresolved},
		{"SELECT COUNT(*) FROM unresolved_refs WHERE status = 'pending'", &s.Pending},
		{"SELECT COUNT(*) FROM files WHERE parse_error IS NOT NULL AND node_count = 0", &s.Deferred},
		{"SELECT COUNT(*) FROM files WHERE parse_error IS NOT NULL AND node_count > 0", &s.Heuristic},
		{`SELECT COUNT(*) FROM edges WHERE metadata LIKE '%"ambiguous":true%'`, &s.AmbiguousEdges},
	}
	for _, q := range queries {
		if err := d.sql.QueryRow(q.query).Scan(q.into); err != nil {
			return s, fmt.Errorf("cggraph: stats %q: %w", q.query, err)
		}
	}
	if info, err := os.Stat(d.path); err == nil {
		s.SizeBytes = info.Size()
	}
	_ = d.sql.QueryRow("PRAGMA journal_mode").Scan(&s.Journal)

	// Per-language counts, so a report can say "45 C files" rather than "45 files".
	s.DeferredByLanguage = d.countByLanguage(`SELECT language, COUNT(*) FROM files WHERE parse_error IS NOT NULL AND node_count = 0 GROUP BY language`)
	s.HeuristicByLanguage = d.countByLanguage(`SELECT language, COUNT(*) FROM files WHERE parse_error IS NOT NULL AND node_count > 0 GROUP BY language`)
	return s, nil
}

// countByLanguage runs a (language, count) query into a map.
func (d *DB) countByLanguage(query string) map[string]int {
	rows, err := d.sql.Query(query)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var language string
		var count int
		if rows.Scan(&language, &count) == nil {
			out[language] = count
		}
	}
	return out
}

// DeferredFile is one file extraction declined.
type DeferredFile struct {
	Path     string
	Language string
	Reason   string
}

// DeferredFiles lists the files extraction produced no nodes for.
func (d *DB) DeferredFiles(ctx context.Context, limit int) ([]DeferredFile, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := d.sql.QueryContext(ctx, `
		SELECT path, language, COALESCE(parse_error, '')
		FROM files
		WHERE parse_error IS NOT NULL AND node_count = 0
		ORDER BY path
		LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("cggraph: deferred files: %w", err)
	}
	defer rows.Close()

	var out []DeferredFile
	for rows.Next() {
		var file DeferredFile
		if err := rows.Scan(&file.Path, &file.Language, &file.Reason); err != nil {
			return nil, err
		}
		out = append(out, file)
	}
	return out, rows.Err()
}

// Clear empties every table without dropping the schema.
//
// Used by a full re-index. Deleting rows rather than deleting the file keeps the
// open handles of any reader valid; the alternative (unlink and recreate) is what
// breaks a long-lived reader on Windows, where an open file cannot be removed.
func (d *DB) Clear() error {
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, table := range []string{"edges", "unresolved_refs", "nodes", "files"} {
		if _, err := tx.Exec("DELETE FROM " + table); err != nil {
			return fmt.Errorf("cggraph: clear %s: %w", table, err)
		}
	}
	return tx.Commit()
}
