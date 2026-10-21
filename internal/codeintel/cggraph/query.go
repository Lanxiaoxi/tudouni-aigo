package cggraph

// Query API: what an explore output is built from.
//
// The point of the index is to answer "where is X, who calls it, what would break"
// in one query instead of a grep-and-read loop. These are those queries. They are
// plain SQL over the tables rather than a graph abstraction: the graph is a handful
// of joins, and a query layer that hid them would make it harder to see what a call
// actually costs.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

// Symbol is one definition.
type Symbol struct {
	ID            string
	Kind          string
	Name          string
	QualifiedName string
	FilePath      string
	Language      string
	StartLine     int
	EndLine       int
	Signature     string
	Docstring     string
	IsExported    *bool
}

// CallSite is one edge into or out of a symbol.
type CallSite struct {
	Kind     string
	FilePath string
	Line     int
	// Symbol is the *other* endpoint's display name: the caller for Callers, the
	// callee for Callees. NodeID is the same endpoint's stable id, which is what a
	// second hop must follow. Names are not unique — two packages may each define
	// Run — so traversing by Symbol would either stop at one hop (no id ever
	// matches a name) or merge unrelated symbols.
	Symbol     string
	NodeID     string
	Ambiguous  bool
	Candidates []string
}

// FindSymbols searches by name.
//
// Three match strengths in one query, in that order: exact, then prefix, then
// qualified-name suffix. A caller that asked for `Run` should see `Run` before
// `RunAll`, and a caller that asked for `cli.Run` should find it even though the
// stored name is `Run`.
func (d *DB) FindSymbols(ctx context.Context, name string, limit int) ([]Symbol, error) {
	if limit <= 0 {
		limit = 20
	}
	// `%` and `_` are legal in identifiers (`fmt_Print`, `%` in a doc name), so a
	// term has to be escaped before it becomes a pattern. Without this, `_` matches
	// any character and a bare `%` matches every symbol in the index.
	rows, err := d.sql.QueryContext(ctx, `
		SELECT id, kind, name, qualified_name, file_path, language,
		       start_line, end_line, COALESCE(signature, ''), COALESCE(docstring, ''), is_exported
		FROM nodes
		WHERE name = ? OR name LIKE ? ESCAPE '\' OR qualified_name LIKE ? ESCAPE '\'
		ORDER BY
			CASE WHEN name = ? THEN 0
			     WHEN name LIKE ? ESCAPE '\' THEN 1
			     ELSE 2 END,
			length(qualified_name),
			file_path,
			start_line
		LIMIT ?`,
		name, likePrefix(name), likeContains(name),
		name, likePrefix(name),
		limit)
	if err != nil {
		return nil, fmt.Errorf("cggraph: find symbols: %w", err)
	}
	defer rows.Close()

	var out []Symbol
	for rows.Next() {
		var (
			sym        Symbol
			isExported sql.NullInt64
		)
		if err := rows.Scan(
			&sym.ID, &sym.Kind, &sym.Name, &sym.QualifiedName, &sym.FilePath, &sym.Language,
			&sym.StartLine, &sym.EndLine, &sym.Signature, &sym.Docstring, &isExported,
		); err != nil {
			return nil, fmt.Errorf("cggraph: scan symbol: %w", err)
		}
		if isExported.Valid {
			value := isExported.Int64 != 0
			sym.IsExported = &value
		}
		out = append(out, sym)
	}
	return out, rows.Err()
}

// escapeLike turns a search term into a literal LIKE operand. The backslash is
// escaped first, or escaping `%` would produce a pattern whose own escape
// character is then escaped again.
func escapeLike(term string) string {
	term = strings.ReplaceAll(term, `\`, `\\`)
	term = strings.ReplaceAll(term, `%`, `\%`)
	return strings.ReplaceAll(term, `_`, `\_`)
}

func likePrefix(term string) string   { return escapeLike(term) + "%" }
func likeContains(term string) string { return "%" + escapeLike(term) + "%" }

// SymbolByID loads one definition.
func (d *DB) SymbolByID(ctx context.Context, id string) (Symbol, bool, error) {
	var (
		sym        Symbol
		isExported sql.NullInt64
	)
	err := d.dbRow(ctx, id, &sym, &isExported)
	if err == sql.ErrNoRows {
		return Symbol{}, false, nil
	}
	if err != nil {
		return Symbol{}, false, err
	}
	if isExported.Valid {
		value := isExported.Int64 != 0
		sym.IsExported = &value
	}
	return sym, true, nil
}

func (d *DB) dbRow(ctx context.Context, id string, sym *Symbol, isExported *sql.NullInt64) error {
	return d.sql.QueryRowContext(ctx, `
		SELECT id, kind, name, qualified_name, file_path, language,
		       start_line, end_line, COALESCE(signature, ''), COALESCE(docstring, ''), is_exported
		FROM nodes WHERE id = ?`, id).Scan(
		&sym.ID, &sym.Kind, &sym.Name, &sym.QualifiedName, &sym.FilePath, &sym.Language,
		&sym.StartLine, &sym.EndLine, &sym.Signature, &sym.Docstring, isExported)
}

// Callers returns the edges pointing at a symbol.
func (d *DB) Callers(ctx context.Context, id string, limit int) ([]CallSite, error) {
	return d.sites(ctx, `
		SELECT e.kind, n.file_path, COALESCE(e.line, 0), n.name, n.id, e.metadata
		FROM edges e
		JOIN nodes n ON n.id = e.source
		WHERE e.target = ?
		ORDER BY n.file_path, e.line
		LIMIT ?`, id, limit)
}

// Callees returns the edges leading out of a symbol.
func (d *DB) Callees(ctx context.Context, id string, limit int) ([]CallSite, error) {
	return d.sites(ctx, `
		SELECT e.kind, n.file_path, COALESCE(e.line, 0), n.name, n.id, e.metadata
		FROM edges e
		JOIN nodes n ON n.id = e.target
		WHERE e.source = ?
		ORDER BY e.line, n.name
		LIMIT ?`, id, limit)
}

func (d *DB) sites(ctx context.Context, query, id string, limit int) ([]CallSite, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := d.sql.QueryContext(ctx, query, id, limit)
	if err != nil {
		return nil, fmt.Errorf("cggraph: call sites: %w", err)
	}
	defer rows.Close()

	var out []CallSite
	for rows.Next() {
		var (
			site     CallSite
			metadata sql.NullString
		)
		if err := rows.Scan(&site.Kind, &site.FilePath, &site.Line, &site.Symbol, &site.NodeID, &metadata); err != nil {
			return nil, fmt.Errorf("cggraph: scan call site: %w", err)
		}
		if metadata.Valid && metadata.String != "" {
			var decoded struct {
				Ambiguous  bool     `json:"ambiguous"`
				Candidates []string `json:"candidates"`
			}
			if err := json.Unmarshal([]byte(metadata.String), &decoded); err == nil {
				site.Ambiguous = decoded.Ambiguous
				site.Candidates = decoded.Candidates
			}
		}
		out = append(out, site)
	}
	return out, rows.Err()
}

// Impact returns every symbol reachable within `depth` hops along the dependency
// edges that carry change: calls, references, instantiations, and the type
// relations (extends / implements / overrides).
//
// Breadth-first with a depth cap, tracking the shortest depth each node was reached
// at. Recording the shallowest depth is what keeps a node first reached by a long
// path from stopping the search: expanding it only at that depth would hide the
// nearer dependents the limit is supposed to include.
//
// Two details are load-bearing:
//
//   - the queue carries **ids**, not display names. A name only matches `nodes.name`
//     inside its own definition, never `edges.target`, so a name-keyed second hop
//     silently returns nothing and makes every impact "one hop deep" while claiming
//     the requested depth.
//   - `contains` and `imports` edges are not dependents. The file that contains a
//     symbol would otherwise be reported as its first "caller", which is both wrong
//     and, since it is an id the search cannot expand, enough to make the result
//     look plausible while saying nothing.
func (d *DB) Impact(ctx context.Context, id string, depth int) ([]CallSite, error) {
	if depth <= 0 {
		depth = 2
	}
	type visit struct {
		id    string
		depth int
	}
	seen := map[string]int{id: 0}
	queue := []visit{{id: id, depth: 0}}

	var out []CallSite
	for len(queue) > 0 {
		head := queue[0]
		queue = queue[1:]
		if head.depth >= depth {
			continue
		}
		callers, err := d.Callers(ctx, head.id, 200)
		if err != nil {
			return nil, err
		}
		for _, site := range callers {
			if !impactEdge(site.Kind) || site.NodeID == "" {
				continue
			}
			if seenDepth, ok := seen[site.NodeID]; ok && seenDepth <= head.depth+1 {
				continue
			}
			seen[site.NodeID] = head.depth + 1
			out = append(out, site)
			queue = append(queue, visit{id: site.NodeID, depth: head.depth + 1})
		}
	}
	return out, nil
}

// impactEdge reports whether an incoming edge means "changing the target can break
// the source". `contains` is the file→symbol relation and `imports` is file-level,
// so neither is a dependent in the sense impact asks about. `extends`, `implements`
// and `overrides` are: an interface change reaches every implementer even when
// nobody calls the interface method directly.
func impactEdge(kind string) bool {
	switch kind {
	case "calls", "references", "instantiates", "extends", "implements", "overrides":
		return true
	default:
		return false
	}
}

// NodeNamesForFile returns the definitions in one file, in line order.
func (d *DB) NodeNamesForFile(ctx context.Context, filePath string) ([]Symbol, error) {
	rows, err := d.sql.QueryContext(ctx, `
		SELECT id, kind, name, qualified_name, file_path, language,
		       start_line, end_line, COALESCE(signature, ''), COALESCE(docstring, ''), is_exported
		FROM nodes WHERE file_path = ? ORDER BY start_line`, filePath)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Symbol
	for rows.Next() {
		var (
			sym        Symbol
			isExported sql.NullInt64
		)
		if err := rows.Scan(
			&sym.ID, &sym.Kind, &sym.Name, &sym.QualifiedName, &sym.FilePath, &sym.Language,
			&sym.StartLine, &sym.EndLine, &sym.Signature, &sym.Docstring, &isExported,
		); err != nil {
			return nil, err
		}
		if isExported.Valid {
			value := isExported.Int64 != 0
			sym.IsExported = &value
		}
		out = append(out, sym)
	}
	return out, rows.Err()
}

// AmbiguousEdgeCount reports how many edges were decided by a tie.
//
// Exposed because it is the one number that says how much of the graph is confident:
// a rising count means the resolver is guessing more, which is a signal worth having
// without reading every edge.
func (d *DB) AmbiguousEdgeCount(ctx context.Context) (int, error) {
	var count int
	err := d.sql.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM edges WHERE metadata LIKE '%"ambiguous":true%'`).Scan(&count)
	return count, err
}

// CandidateRef is one plausible alternative for an ambiguous edge.
//
// Rendered instead of a node id because an id is useless to a reader: "struct:5f1c53c4" says
// nothing about which `Tool` the resolver was weighing. A name, a path and a line do.
type CandidateRef struct {
	ID       string
	Name     string
	Kind     string
	FilePath string
	Line     int
}

// DescribeCandidates resolves candidate ids to something readable.
//
// The ids come from an edge's metadata, where resolution recorded the tie. Order is preserved
// so the winner stays first and a reader can see which one was chosen.
func (d *DB) DescribeCandidates(ctx context.Context, ids []string) ([]CandidateRef, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	out := make([]CandidateRef, 0, len(ids))
	for _, id := range ids {
		var ref CandidateRef
		err := d.sql.QueryRowContext(ctx, `
			SELECT id, name, kind, file_path, start_line FROM nodes WHERE id = ?`, id).Scan(
			&ref.ID, &ref.Name, &ref.Kind, &ref.FilePath, &ref.Line)
		if err == sql.ErrNoRows {
			// A candidate can vanish between resolution and query (a file was re-indexed).
			// Keeping the id is more honest than dropping the alternative silently.
			out = append(out, CandidateRef{ID: id, Name: "(gone)"})
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("cggraph: describe candidate %s: %w", id, err)
		}
		out = append(out, ref)
	}
	return out, nil
}

// TruncateForDisplay shortens a string for a one-line summary.
func TruncateForDisplay(text string, limit int) string {
	text = strings.TrimSpace(text)
	if len(text) <= limit {
		return text
	}
	return text[:limit] + "…"
}
