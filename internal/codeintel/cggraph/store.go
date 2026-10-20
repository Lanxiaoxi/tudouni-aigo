package cggraph

// Writing extracted files into the index.
//
// The write path is deliberately boring: one transaction per file, upsert the file
// row, delete that file's nodes (cascading to their edges), insert the new ones.
// "Delete and reinsert per file" rather than "diff against what is there" because a
// file's node ids change with every line shift (the id hashes the qualified name
// and position), so a diff would report every node as changed after any edit above
// it. Deleting the file's rows and writing them again is both simpler and, on a
// whole-file basis, cheaper.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cgparse"
)

// StoredNode is a node as it goes into the database.
type StoredNode struct {
	ID             string
	Kind           string
	Name           string
	QualifiedName  string
	FilePath       string
	Language       string
	StartLine      int
	EndLine        int
	StartColumn    int
	EndColumn      int
	Docstring      string
	Signature      string
	Visibility     string
	IsExported     *bool
	IsAsync        *bool
	IsStatic       *bool
	IsAbstract     *bool
	Decorators     []string
	TypeParameters []string
	ReturnType     string
}

// StoredEdge is an edge as it goes into the database.
type StoredEdge struct {
	Source     string
	Target     string
	Kind       string
	Line       *int
	Column     *int
	Provenance string
	Metadata   map[string]any
}

// StoredRef is an unresolved reference as it goes into the database.
type StoredRef struct {
	FromNodeID    string
	ReferenceName string
	ReferenceKind string
	Line          int
	Column        int
	Candidates    []string
	FilePath      string
	Language      string
}

// FileRecord is the per-file bookkeeping row.
type FileRecord struct {
	Path        string
	ContentHash string
	Language    string
	Size        int64
	ModifiedAt  int64
	NodeCount   int
	Generated   bool
	// ParseError is why extraction produced no nodes, "" when it succeeded.
	//
	// A failed file still gets a row, so the next run retries it rather than treating it
	// as indexed-and-empty — but the reason travels here rather than inside ContentHash,
	// so change detection still compares real hashes.
	ParseError string
}

// WriteFile replaces one file's rows in a single transaction.
//
// Everything for the file goes in together or not at all: a half-written file would
// leave nodes whose references were never recorded, and the resolver would then
// treat a complete file as having no calls.
// DeleteFile removes a file and everything indexed from it.
//
// Mirror image of WriteFile's teardown, and it exists for a gap that mattered: without it a
// file deleted from disk stayed in the index forever, so `explore` kept reporting symbols from
// code that no longer existed and nothing ever contradicted it.
func (d *DB) DeleteFile(ctx context.Context, path string) error {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx,
		`DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?) OR target IN (SELECT id FROM nodes WHERE file_path = ?)`,
		path, path); err != nil {
		return fmt.Errorf("cggraph: delete edges for %s: %w", path, err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM unresolved_refs WHERE file_path = ?`, path); err != nil {
		return fmt.Errorf("cggraph: delete refs for %s: %w", path, err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM nodes WHERE file_path = ?`, path); err != nil {
		return fmt.Errorf("cggraph: delete nodes for %s: %w", path, err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM files WHERE path = ?`, path); err != nil {
		return fmt.Errorf("cggraph: delete file row for %s: %w", path, err)
	}
	return tx.Commit()
}

// ReopenRefsForNames sets previously failed references back to pending, but only those whose
// name could bind differently now.
//
// Why the scoping matters: a failed reference is not necessarily unresolvable — it failed
// because no definition of that name was visible from where it sits. A new or edited file can
// change that, but only for the names that file declares. Resetting the whole table instead
// (which is what ResetFailedRefs does) re-attempts every historical failure on every run: on
// this repository that is 36,862 rows to resolve 14 references, and it cost 2s of a 2.1s
// incremental index.
//
// Names are chunked because SQLite caps the number of bound parameters per statement, and a
// generated file can easily declare more names than that cap.
func (d *DB) ReopenRefsForNames(ctx context.Context, names []string) (int64, error) {
	if len(names) == 0 {
		return 0, nil
	}
	const chunk = 500
	var total int64
	for start := 0; start < len(names); start += chunk {
		end := start + chunk
		if end > len(names) {
			end = len(names)
		}
		batch := names[start:end]
		placeholders := make([]string, len(batch))
		arguments := make([]any, 0, len(batch))
		for index, name := range batch {
			placeholders[index] = "?"
			arguments = append(arguments, name)
		}
		query := `UPDATE unresolved_refs SET status = 'pending'
			WHERE status = 'failed' AND reference_name IN (` + strings.Join(placeholders, ",") + `)`
		result, err := d.sql.ExecContext(ctx, query, arguments...)
		if err != nil {
			return total, fmt.Errorf("cggraph: reopen refs: %w", err)
		}
		affected, _ := result.RowsAffected()
		total += affected
	}
	return total, nil
}

// TouchFile refreshes a file's recorded stat without touching its nodes.
//
// Used when the size or modification time changed but the content did not — a `touch`, a
// checkout, a formatter that rewrote identical bytes. The content hash still matches, so the
// parse would reproduce the same graph; only the stat needs updating, and doing so keeps the
// next sync on its stat-only fast path instead of re-hashing this file forever.
func (d *DB) TouchFile(ctx context.Context, path string, size, modifiedAt int64) error {
	_, err := d.sql.ExecContext(ctx,
		`UPDATE files SET size = ?, modified_at = ? WHERE path = ?`,
		size, modifiedAt, path)
	return err
}

func (d *DB) WriteFile(ctx context.Context, record FileRecord, nodes []StoredNode, edges []StoredEdge, refs []StoredRef) error {
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// The old node ids, captured before the rows go away. They are needed at the end to find
	// the incoming edges whose target no longer exists.
	oldIDs, err := nodeIDsForFile(ctx, tx, record.Path)
	if err != nil {
		return err
	}

	// Only this file's OUTGOING edges are deleted; they are recreated from the fresh parse and
	// the resolver.
	//
	// Deleting incoming edges too used to look right — the comment said the target was "about
	// to be recreated with a new id" — but a node id is a hash of (path, qualified name), so it
	// is stable as long as the symbol keeps its name. Deleting incoming edges therefore threw
	// away every resolved edge from other files into this one, and nothing recreated them: the
	// reference rows that produced them are deleted once they resolve. Touching a Go file with
	// 128 callers silently lost 128 `calls` edges. The scoped sweep below drops only the ones
	// that really are orphaned, which is the rename/remove case.
	if len(oldIDs) > 0 {
		if _, err := tx.ExecContext(ctx,
			"DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)",
			record.Path); err != nil {
			return fmt.Errorf("cggraph: delete outgoing edges for %s: %w", record.Path, err)
		}
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM unresolved_refs WHERE file_path = ?", record.Path); err != nil {
		return fmt.Errorf("cggraph: delete refs for %s: %w", record.Path, err)
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM nodes WHERE file_path = ?", record.Path); err != nil {
		return fmt.Errorf("cggraph: delete nodes for %s: %w", record.Path, err)
	}

	now := time.Now().UnixMilli()
	if err := insertFile(ctx, tx, record, now); err != nil {
		return err
	}
	if err := insertNodes(ctx, tx, nodes, now); err != nil {
		return err
	}
	if err := insertEdges(ctx, tx, edges); err != nil {
		return err
	}
	if err := insertRefs(ctx, tx, refs); err != nil {
		return err
	}

	// Incoming edges whose target vanished from this file — a renamed or removed symbol. Kept
	// scoped to the ids this file used to own, so the cost is bounded by that file's size
	// rather than the whole edge table.
	if len(oldIDs) > 0 {
		placeholders := make([]string, len(oldIDs))
		arguments := make([]any, 0, len(oldIDs)+1)
		for index, id := range oldIDs {
			placeholders[index] = "?"
			arguments = append(arguments, id)
		}
		arguments = append(arguments, record.Path)
		query := `DELETE FROM edges WHERE target IN (` + strings.Join(placeholders, ",") + `)
			AND target NOT IN (SELECT id FROM nodes WHERE file_path = ?)`
		if _, err := tx.ExecContext(ctx, query, arguments...); err != nil {
			return fmt.Errorf("cggraph: sweep orphaned edges for %s: %w", record.Path, err)
		}
	}

	return tx.Commit()
}

// nodeIDsForFile reads a file's node ids inside a transaction.
func nodeIDsForFile(ctx context.Context, tx *sql.Tx, path string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id FROM nodes WHERE file_path = ?`, path)
	if err != nil {
		return nil, fmt.Errorf("cggraph: read node ids for %s: %w", path, err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func insertFile(ctx context.Context, tx *sql.Tx, record FileRecord, now int64) error {
	generated := 0
	if record.Generated {
		generated = 1
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors, generated, parse_error)
		VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
		ON CONFLICT(path) DO UPDATE SET
			content_hash = excluded.content_hash,
			language     = excluded.language,
			size         = excluded.size,
			modified_at  = excluded.modified_at,
			indexed_at   = excluded.indexed_at,
			node_count   = excluded.node_count,
			errors       = excluded.errors,
			generated    = excluded.generated,
			parse_error  = excluded.parse_error`,
		record.Path, record.ContentHash, record.Language, record.Size,
		record.ModifiedAt, now, record.NodeCount, generated, nullString(record.ParseError))
	if err != nil {
		return fmt.Errorf("cggraph: insert file %s: %w", record.Path, err)
	}
	return nil
}

func insertNodes(ctx context.Context, tx *sql.Tx, nodes []StoredNode, now int64) error {
	if len(nodes) == 0 {
		return nil
	}
	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO nodes (
			id, kind, name, qualified_name, file_path, language,
			start_line, end_line, start_column, end_column,
			docstring, signature, visibility,
			is_exported, is_async, is_static, is_abstract,
			decorators, type_parameters, return_type, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			kind = excluded.kind,
			name = excluded.name,
			end_line = excluded.end_line,
			updated_at = excluded.updated_at`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, node := range nodes {
		_, err := stmt.ExecContext(ctx,
			node.ID, node.Kind, node.Name, node.QualifiedName, node.FilePath, node.Language,
			node.StartLine, node.EndLine, node.StartColumn, node.EndColumn,
			nullString(node.Docstring), nullString(node.Signature), nullString(node.Visibility),
			boolToSQL(node.IsExported), boolToSQL(node.IsAsync), boolToSQL(node.IsStatic), boolToSQL(node.IsAbstract),
			jsonOrNil(node.Decorators), jsonOrNil(node.TypeParameters), nullString(node.ReturnType), now)
		if err != nil {
			return fmt.Errorf("cggraph: insert node %s: %w", node.ID, err)
		}
	}
	return nil
}

func insertEdges(ctx context.Context, tx *sql.Tx, edges []StoredEdge) error {
	if len(edges) == 0 {
		return nil
	}
	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO edges (source, target, kind, metadata, line, col, provenance)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT DO NOTHING`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, edge := range edges {
		metadata := ""
		if len(edge.Metadata) > 0 {
			raw, err := json.Marshal(edge.Metadata)
			if err != nil {
				return fmt.Errorf("cggraph: encode edge metadata: %w", err)
			}
			metadata = string(raw)
		}
		_, err := stmt.ExecContext(ctx,
			edge.Source, edge.Target, edge.Kind, nullString(metadata),
			intOrNil(edge.Line), intOrNil(edge.Column), nullString(edge.Provenance))
		if err != nil {
			return fmt.Errorf("cggraph: insert edge %s->%s: %w", edge.Source, edge.Target, err)
		}
	}
	return nil
}

func insertRefs(ctx context.Context, tx *sql.Tx, refs []StoredRef) error {
	if len(refs) == 0 {
		return nil
	}
	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO unresolved_refs
			(from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language, status, name_tail)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, ref := range refs {
		_, err := stmt.ExecContext(ctx,
			ref.FromNodeID, ref.ReferenceName, ref.ReferenceKind, ref.Line, ref.Column,
			jsonOrNil(ref.Candidates), ref.FilePath, ref.Language, NameTail(ref.ReferenceName))
		if err != nil {
			return fmt.Errorf("cggraph: insert ref %s: %w", ref.ReferenceName, err)
		}
	}
	return nil
}

// NameTail is the last segment of a dotted or scoped reference name.
//
// Stored so a retry sweep can find "all refs whose tail is X" without a LIKE scan:
// `pkg.sub.Func` and `Func` share a tail, and both may bind to the same definition.
func NameTail(name string) string {
	last := name
	for i := len(name) - 1; i >= 0; i-- {
		switch name[i] {
		case '.', ':', '>':
			// `::` and `->` are two-character operators; skipping the whole run
			// keeps the tail from becoming an empty string on `Foo::bar`.
			j := i
			for j > 0 && (name[j-1] == ':' || name[j-1] == '-' || name[j-1] == '>') {
				j--
			}
			return name[i+1:]
		}
	}
	return last
}

func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func jsonOrNil(items []string) any {
	if len(items) == 0 {
		return nil
	}
	raw, err := json.Marshal(items)
	if err != nil {
		return nil
	}
	return string(raw)
}

// boolToSQL preserves the tri-state: nil (unreported) stays NULL.
func boolToSQL(value *bool) any {
	if value == nil {
		return nil
	}
	if *value {
		return 1
	}
	return 0
}

func intOrNil(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

// FromParse converts cgparse output into the stored form.
//
// The conversion is where the row views become plain values, so the rest of this
// package does not have to know the wire layout.
func FromParse(file *cgparse.File) ([]StoredNode, []StoredEdge, []StoredRef) {
	var nodes []StoredNode
	file.Nodes(func(_ int, row cgparse.NodeRow) bool {
		nodes = append(nodes, StoredNode{
			ID:             row.ID(file),
			Kind:           row.KindName(),
			Name:           row.Name(file),
			QualifiedName:  row.QualifiedName(file),
			FilePath:       file.Path,
			Language:       file.Lang,
			StartLine:      int(row.StartLine()),
			EndLine:        int(row.EndLine()),
			StartColumn:    int(row.StartColumn()),
			EndColumn:      int(row.EndColumn()),
			Docstring:      row.Docstring(file),
			Signature:      row.Signature(file),
			Visibility:     row.VisibilityName(),
			IsExported:     row.IsExported(),
			IsAsync:        row.BoolFlag(1),
			IsStatic:       row.BoolFlag(2),
			IsAbstract:     row.BoolFlag(3),
			Decorators:     row.Decorators(file),
			TypeParameters: row.TypeParameters(file),
			ReturnType:     row.ReturnType(file),
		})
		return true
	})

	var edges []StoredEdge
	file.Edges(func(_ int, row cgparse.EdgeRow) bool {
		source := ""
		if idx := row.SourceIndex(); idx != cgparse.None {
			if node, ok := file.NodeAt(int(idx)); ok {
				source = node.ID(file)
			}
		} else {
			source = row.SourceIDStr(file)
		}
		target := ""
		if idx := row.TargetIndex(); idx != cgparse.None {
			if node, ok := file.NodeAt(int(idx)); ok {
				target = node.ID(file)
			}
		} else {
			target = row.TargetIDStr(file)
		}
		edge := StoredEdge{Source: source, Target: target, Kind: row.KindName()}
		if line := row.Line(); line != cgparse.None {
			value := int(line)
			edge.Line = &value
		}
		if col := row.Column(); col != cgparse.None {
			value := int(col)
			edge.Column = &value
		}
		if provenance := row.Provenance(); provenance != 0 {
			edge.Provenance = provenanceName(provenance)
		}
		edges = append(edges, edge)
		return true
	})

	var refs []StoredRef
	file.Refs(func(_ int, row cgparse.RefRow) bool {
		from := ""
		if idx := row.FromIndex(); idx != cgparse.None {
			if node, ok := file.NodeAt(int(idx)); ok {
				from = node.ID(file)
			}
		} else {
			from = row.FromIDStr(file)
		}
		refs = append(refs, StoredRef{
			FromNodeID:    from,
			ReferenceName: row.ReferenceName(file),
			ReferenceKind: row.KindName(),
			Line:          int(row.Line()),
			Column:        int(row.Column()),
			Candidates:    row.Candidates(file),
			FilePath:      file.Path,
			Language:      file.Lang,
		})
		return true
	})

	return nodes, edges, refs
}

func provenanceName(code uint8) string {
	switch code {
	case 1:
		return "tree-sitter"
	case 2:
		return "scip"
	case 3:
		return "heuristic"
	}
	return ""
}
