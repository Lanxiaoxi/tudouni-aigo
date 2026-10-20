package cggraph

// Cross-file Go method ownership.
//
// Ported from CodeGraph's `goCrossFileMethodContainsEdges`
// (src/resolution/callback-synthesizer.ts).
//
// In Go a type's methods are commonly declared in a different file from the `type`
// declaration itself (`type User struct{…}` in `user.go`, `func (u *User) Save()` in
// `user_store.go`). Extraction can only attach the struct→method `contains` edge when
// the receiver type is in the SAME file — the owner lookup is scoped to the file being
// parsed — so a cross-file method is left contained by its file but not by its type.
//
// That orphan is not cosmetic. It breaks member outlines, every callers/callees/impact
// traversal that goes through a type's `contains` edges, and the `implements`
// method-set computation, which derives a struct's method set from exactly those edges.
// On this repository it was the whole reason 10 of 54 `implements` edges were missing:
// `Runtime`'s methods live across several files in `internal/runtime`, so `Runtime`'s
// derived method set was short and the interfaces it satisfies did not match.
//
// The link is deterministic rather than heuristic: Go guarantees a method's receiver
// type is declared in the same PACKAGE as the method, and a package is a single
// directory. Go also forbids duplicate type names within a package, so a same-name
// same-directory match is unambiguous.

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

// SynthesizeGoMethodOwners adds the missing type→method `contains` edges.
//
// Returns how many were added. Must run BEFORE SynthesizeGoImplements: the implementer
// pass reads method sets off these edges, so running it first under-counts every struct
// whose methods are split across files.
func (r *Resolver) SynthesizeGoMethodOwners(ctx context.Context) (int, error) {
	rows, err := r.db.sql.QueryContext(ctx, `
		SELECT id, name, qualified_name, file_path, start_line
		FROM nodes
		WHERE language = 'go' AND kind = 'method'
		ORDER BY file_path, start_line`)
	if err != nil {
		return 0, fmt.Errorf("cggraph: go methods: %w", err)
	}

	type method struct {
		id        string
		name      string
		qualified string
		filePath  string
		startLine int
	}
	var methods []method
	for rows.Next() {
		var m method
		if err := rows.Scan(&m.id, &m.name, &m.qualified, &m.filePath, &m.startLine); err != nil {
			rows.Close()
			return 0, err
		}
		methods = append(methods, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	// Which methods already have a type parent. One query rather than one per method:
	// on a large tree the per-method version is tens of thousands of round trips.
	hasTypeParent, err := r.methodsWithTypeParent(ctx)
	if err != nil {
		return 0, err
	}

	// Candidate owners, indexed by (directory, name). A type name is unique within a
	// package, so the pair identifies at most one owner.
	owners, err := r.goTypeOwnersByNameAndDir(ctx)
	if err != nil {
		return 0, err
	}

	var edges []StoredEdge
	seen := map[string]bool{}
	for _, m := range methods {
		// The receiver type is encoded in the qualified name as `Recv::name`.
		sep := strings.LastIndex(m.qualified, "::")
		if sep <= 0 {
			continue
		}
		receiver := m.qualified[:sep]
		if receiver == "" {
			continue
		}
		if hasTypeParent[m.id] {
			continue
		}
		dir := normalizeSlash(filepath.Dir(m.filePath))
		ownerID, ok := owners[dir+"\x00"+receiver]
		if !ok {
			continue
		}
		key := ownerID + ">" + m.id
		if seen[key] {
			continue
		}
		seen[key] = true
		edges = append(edges, StoredEdge{
			Source: ownerID,
			Target: m.id,
			Kind:   "contains",
			Line:   intPtr(m.startLine),
			// No provenance, matching same-file extraction: this is the edge the
			// extractor would have written had the declaration been in the same file.
			// The metadata tag is what lets a refresh replace it.
			Metadata: map[string]any{"synthesizedBy": "go-method-contains"},
		})
	}

	if len(edges) == 0 {
		return 0, nil
	}
	if err := r.writeEdges(ctx, edges); err != nil {
		return 0, err
	}
	return len(edges), nil
}

// methodsWithTypeParent reports which methods already have a type-kind `contains`
// parent — the same-file case, which extraction handled.
func (r *Resolver) methodsWithTypeParent(ctx context.Context) (map[string]bool, error) {
	rows, err := r.db.sql.QueryContext(ctx, `
		SELECT DISTINCT e.target
		FROM edges e
		JOIN nodes src ON src.id = e.source
		WHERE e.kind = 'contains'
		  AND src.kind IN ('struct', 'class', 'interface', 'enum', 'type_alias')`)
	if err != nil {
		return nil, fmt.Errorf("cggraph: methods with type parent: %w", err)
	}
	defer rows.Close()

	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// goTypeOwnersByNameAndDir indexes Go type nodes by (normalized directory, name).
func (r *Resolver) goTypeOwnersByNameAndDir(ctx context.Context) (map[string]string, error) {
	rows, err := r.db.sql.QueryContext(ctx, `
		SELECT id, name, file_path
		FROM nodes
		WHERE language = 'go'
		  AND kind IN ('struct', 'class', 'interface', 'enum', 'type_alias')`)
	if err != nil {
		return nil, fmt.Errorf("cggraph: go type owners: %w", err)
	}
	defer rows.Close()

	out := map[string]string{}
	for rows.Next() {
		var id, name, filePath string
		if err := rows.Scan(&id, &name, &filePath); err != nil {
			return nil, err
		}
		dir := normalizeSlash(filepath.Dir(filePath))
		// First wins. Go forbids a duplicate type name in a package, so a second entry
		// can only come from an indexing artefact (a stale row), and keeping the first
		// is the stable choice.
		key := dir + "\x00" + name
		if _, exists := out[key]; !exists {
			out[key] = id
		}
	}
	return out, rows.Err()
}
