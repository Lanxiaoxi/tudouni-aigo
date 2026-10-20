// Package cggraph is the code index: schema, storage, and the resolver that turns
// unresolved references into edges.
//
// The schema follows CodeGraph's v11 layout (see `internal/cgparse` for the
// extraction side). It is adopted rather than invented because the shape is proven
// against real repositories: nodes and edges as flat tables with the indices that
// make "who calls this" a single lookup, unresolved refs kept in their own table so
// an incremental sync can retry exactly what failed, and files carrying a content
// hash so change detection is a hash compare rather than a re-parse.
package cggraph

// SchemaVersion is this package's schema version. It is written into
// `schema_versions` so a database built by an older binary is refused rather than
// read with the wrong expectations.
const SchemaVersion = 1

// schemaDDL is the whole schema.
//
// Notes on choices that are load-bearing:
//
//   - `nodes.id` is a TEXT primary key, not an autoincrement rowid. Ids come from
//     the extractor and are stable for a given symbol; an integer key would
//     renumber on every re-index and break every edge that referenced it.
//   - `edges` has a UNIQUE index over (source, target, kind, line, col) so a
//     re-resolve that rediscovers the same edge is a no-op instead of a duplicate.
//     The `IFNULL(..., -1)` wrappers are required: in SQLite a NULL never equals
//     NULL, so a plain composite unique index would admit unlimited duplicates of
//     an edge whose line/col are NULL.
//   - `unresolved_refs.status` exists so a failed resolve is retried later rather
//     than lost. Without it, a reference that arrived before its target file was
//     indexed would silently never resolve.
//   - Indices are created with the tables rather than lazily: bulk loading into an
//     unindexed table and building the indices afterwards is faster, but it makes
//     the incremental path (which this tool uses far more often) pay a full table
//     scan. The index set here is what `explore`, `callers` and `impact` need.
const schemaDDL = `
CREATE TABLE IF NOT EXISTS schema_versions (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,
    description TEXT
);

-- One row per indexed file. content_hash is what makes incremental sync cheap:
-- a (size, mtime) match plus a hash compare skips a re-parse entirely.
CREATE TABLE IF NOT EXISTS files (
    path         TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    language     TEXT NOT NULL,
    size         INTEGER NOT NULL,
    modified_at  INTEGER NOT NULL,
    indexed_at   INTEGER NOT NULL,
    node_count   INTEGER DEFAULT 0,
    errors       TEXT,
    generated    INTEGER NOT NULL DEFAULT 0,
    -- parse_error records why extraction produced no nodes, or NULL when it succeeded.
    --
    -- Separate from content_hash, which must hold the file's real hash so change
    -- detection keeps working: an earlier version padded the hash with a failure marker,
    -- which made the next run see "changed" and retry every broken file forever.
    parse_error  TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
    id             TEXT PRIMARY KEY,
    kind           TEXT NOT NULL,
    name           TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    language       TEXT NOT NULL,
    start_line     INTEGER NOT NULL,
    end_line       INTEGER NOT NULL,
    start_column   INTEGER NOT NULL,
    end_column     INTEGER NOT NULL,
    docstring      TEXT,
    signature      TEXT,
    visibility     TEXT,
    -- Tri-state: NULL means the extractor did not report the flag. Storing 0 for
    -- "unreported" would make Go methods look unexported, and Go resolution
    -- depends on the difference.
    is_exported    INTEGER,
    is_async       INTEGER,
    is_static      INTEGER,
    is_abstract    INTEGER,
    decorators      TEXT,
    type_parameters TEXT,
    return_type     TEXT,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT NOT NULL,
    target     TEXT NOT NULL,
    kind       TEXT NOT NULL,
    metadata   TEXT,
    line       INTEGER,
    col        INTEGER,
    provenance TEXT
);

CREATE TABLE IF NOT EXISTS unresolved_refs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node_id   TEXT NOT NULL,
    reference_name TEXT NOT NULL,
    reference_kind TEXT NOT NULL,
    line           INTEGER NOT NULL,
    col            INTEGER NOT NULL,
    candidates     TEXT,
    file_path      TEXT NOT NULL DEFAULT '',
    language       TEXT NOT NULL DEFAULT 'unknown',
    status         TEXT NOT NULL DEFAULT 'pending',
    name_tail      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_nodes_name           ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_lower_name     ON nodes(lower(name));
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path      ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_file_line      ON nodes(file_path, start_line);
CREATE INDEX IF NOT EXISTS idx_nodes_language       ON nodes(language);
CREATE INDEX IF NOT EXISTS idx_nodes_kind           ON nodes(kind, file_path, start_line, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_identity
    ON edges(source, target, kind, IFNULL(line, -1), IFNULL(col, -1));
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);
CREATE INDEX IF NOT EXISTS idx_edges_kind        ON edges(kind);

CREATE INDEX IF NOT EXISTS idx_unresolved_status    ON unresolved_refs(status);
CREATE INDEX IF NOT EXISTS idx_unresolved_name      ON unresolved_refs(reference_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_from_node ON unresolved_refs(from_node_id);
CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
CREATE INDEX IF NOT EXISTS idx_unresolved_failed_tail
    ON unresolved_refs(name_tail) WHERE status = 'failed';
`

// indexesDDL is separate so a future migration can drop and rebuild indices
// without touching table definitions.
const indexesDDL = ``

// Schema returns the DDL a new database needs.
func Schema() string { return schemaDDL }
