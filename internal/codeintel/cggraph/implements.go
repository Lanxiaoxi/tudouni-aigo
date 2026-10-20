package cggraph

// Go implicit interface satisfaction.
//
// Ported from CodeGraph's `goImplementsEdges`
// (src/resolution/callback-synthesizer.ts). Go has no `implements` keyword: a type
// satisfies an interface structurally when its method set covers the interface's. The
// reference implementation synthesizes the missing `implements` edge by matching
// method sets, and everything below follows its rules rather than inventing gentler
// ones — including the deliberate over-approximations it documents, because a reviewer
// comparing the two graphs should see the same edges.
//
// The rules, in the order they matter:
//
//   - **Implementers are structs and defined types.** A defined type declares methods
//     as a struct does (`type formSource map[string][]string` with `TrySet`) and is
//     stored as a `type_alias` owning them through `contains` edges. A type with no
//     methods is no implementer.
//   - **Both method sets include what embedding brings in**, at any depth. An
//     interface has the methods of the interfaces it embeds; a struct has the methods
//     promoted from what it embeds.
//   - **A type that embeds the interface keeps that edge** and gets no synthesized one.
//   - **Empty interfaces (`any`) are skipped**, or every type would implement them.
//   - **Signatures must agree on parameter and result counts.** Go wants the
//     signatures identical; the counts are what the stored text settles for certain.
//     A signature that does not read rules nothing out.
//   - **Types are not compared.** A promoted name counts even where Go would find it
//     ambiguous. This is the reference implementation's stated over-approximation.
//
// Not ported: the gRPC client/server arity bridge (`goGrpcServerArity`), which needs a
// read of `...grpc.CallOption` signatures to link a generated client interface to the
// struct serving it. It only fires on gRPC-generated code, and this tree has none.

import (
	"context"
	"fmt"
)

// maxImplementsPerInterface caps how many implementers one interface records.
//
// The reference implementation caps its channel callbacks at the same kind of number;
// an interface with a single-method method set (`String()`, `Close()`) matches a large
// share of a tree, and every one of those edges is noise past the first few.
const maxImplementsPerInterface = 200

// SynthesizeGoImplements creates the `implements` edges Go's structural typing implies.
//
// Returns how many edges were added. Idempotent: an edge that already exists is not
// added again, so a re-run after a sync does not duplicate.
func (r *Resolver) SynthesizeGoImplements(ctx context.Context) (int, error) {
	implementers, err := r.goImplementers(ctx)
	if err != nil {
		return 0, err
	}
	interfaces, err := r.goInterfaces(ctx)
	if err != nil {
		return 0, err
	}
	if len(implementers) == 0 || len(interfaces) == 0 {
		return 0, nil
	}

	// The kinds of type whose methods embedding passes on. Needed by isGoEmbedding,
	// which must know whether an edge's target is a type at all.
	kindOf := make(map[string]string, len(implementers)+len(interfaces))
	for _, node := range implementers {
		kindOf[node.id] = node.kind
	}
	for _, node := range interfaces {
		kindOf[node.id] = "interface"
	}

	// Memoized: an embedded base is read once however many types embed it.
	ownMemo := make(map[string]map[string][]string) // id → method name → signatures
	ownMethods := func(id string) map[string][]string {
		if methods, ok := ownMemo[id]; ok {
			return methods
		}
		methods, err := r.ownMethodsOf(ctx, id)
		if err != nil {
			methods = map[string][]string{}
		}
		ownMemo[id] = methods
		return methods
	}

	embedMemo, err := r.goEmbeddings(ctx, kindOf)
	if err != nil {
		return 0, err
	}

	embedClosure := func(id string) []string {
		direct := embedMemo[id]
		if len(direct) == 0 {
			return []string{id}
		}
		reached := map[string]bool{id: true}
		pending := []string{id}
		for len(pending) > 0 {
			at := pending[len(pending)-1]
			pending = pending[:len(pending)-1]
			for _, target := range embedMemo[at] {
				if reached[target] {
					continue
				}
				reached[target] = true
				pending = append(pending, target)
			}
		}
		out := make([]string, 0, len(reached))
		for id := range reached {
			out = append(out, id)
		}
		return out
	}

	// Own methods plus every embedded type's, as name → signatures.
	methodSet := func(id string) map[string][]string {
		types := embedClosure(id)
		if len(types) == 1 {
			return ownMethods(id)
		}
		merged := map[string][]string{}
		for _, t := range types {
			for name, signatures := range ownMethods(t) {
				merged[name] = append(merged[name], signatures...)
			}
		}
		return merged
	}

	// Arity per method name, or a nil entry meaning "does not read, so rules nothing
	// out" — the reference implementation's tri-state.
	arities := func(id string) map[string]map[string]bool {
		out := map[string]map[string]bool{}
		for _, t := range embedClosure(id) {
			for name, signatures := range ownMethods(t) {
				set := out[name]
				if set == nil {
					set = map[string]bool{}
					out[name] = set
				}
				for _, signature := range signatures {
					arity, ok := goSignatureArity(signature)
					if !ok {
						// One unreadable declaration makes the name rule nothing out.
						out[name] = nil
						break
					}
					if out[name] == nil {
						break
					}
					set[arity] = true
				}
			}
		}
		return out
	}

	candidates := make([]goType, 0, len(implementers))
	candidateMethods := make(map[string]map[string][]string, len(implementers))
	for _, node := range implementers {
		have := methodSet(node.id)
		if len(have) == 0 {
			continue
		}
		candidates = append(candidates, node)
		candidateMethods[node.id] = have
	}

	added := 0
	var edges []StoredEdge
	seen := map[string]bool{}

	for _, iface := range interfaces {
		if err := ctx.Err(); err != nil {
			return added, err
		}
		want := methodSet(iface.id)
		// An empty interface (`any`, `interface{}`) would match every type.
		if len(want) == 0 {
			continue
		}
		wantedArity := arities(iface.id)

		perInterface := 0
		for _, cand := range candidates {
			if perInterface >= maxImplementsPerInterface {
				break
			}
			have := candidateMethods[cand.id]
			if !methodSetCovers(have, want) {
				continue
			}
			// The type already declares the embedding; a synthesized edge would say the
			// same thing twice.
			if containsString(embedMemo[cand.id], iface.id) {
				continue
			}
			if !aritiesFit(arities(cand.id), wantedArity, want) {
				continue
			}
			key := cand.id + ">" + iface.id
			if seen[key] {
				continue
			}
			seen[key] = true
			edges = append(edges, StoredEdge{
				Source:     cand.id,
				Target:     iface.id,
				Kind:       "implements",
				Line:       intPtr(cand.startLine),
				Provenance: "heuristic",
				Metadata: map[string]any{
					"synthesizedBy": "go-implements",
					"via":           iface.name,
					"registeredAt":  fmt.Sprintf("%s:%d", cand.filePath, cand.startLine),
				},
			})
			perInterface++
		}
	}

	if len(edges) == 0 {
		return 0, nil
	}
	if err := r.writeEdges(ctx, edges); err != nil {
		return 0, err
	}
	return len(edges), nil
}

// goType is the minimum a node needs to be an implementer or an interface.
type goType struct {
	id        string
	kind      string
	name      string
	filePath  string
	startLine int
}

func (r *Resolver) goImplementers(ctx context.Context) ([]goType, error) {
	// Structs and defined types both declare methods and both satisfy interfaces.
	// `type_alias` covers `type formSource map[string][]string`, which owns its methods
	// the way a struct does.
	rows, err := r.db.sql.QueryContext(ctx, `
		SELECT id, kind, name, file_path, start_line
		FROM nodes
		WHERE language = 'go' AND kind IN ('struct', 'type_alias')
		ORDER BY file_path, start_line`)
	if err != nil {
		return nil, fmt.Errorf("cggraph: go implementers: %w", err)
	}
	defer rows.Close()

	var out []goType
	for rows.Next() {
		var node goType
		if err := rows.Scan(&node.id, &node.kind, &node.name, &node.filePath, &node.startLine); err != nil {
			return nil, err
		}
		out = append(out, node)
	}
	return out, rows.Err()
}

func (r *Resolver) goInterfaces(ctx context.Context) ([]goType, error) {
	rows, err := r.db.sql.QueryContext(ctx, `
		SELECT id, kind, name, file_path, start_line
		FROM nodes
		WHERE language = 'go' AND kind = 'interface'
		ORDER BY file_path, start_line`)
	if err != nil {
		return nil, fmt.Errorf("cggraph: go interfaces: %w", err)
	}
	defer rows.Close()

	var out []goType
	for rows.Next() {
		var node goType
		if err := rows.Scan(&node.id, &node.kind, &node.name, &node.filePath, &node.startLine); err != nil {
			return nil, err
		}
		out = append(out, node)
	}
	return out, rows.Err()
}

// ownMethodsOf reads one type's own methods: name → its declarations' signatures.
//
// Read off `contains` edges, which is how both the reference implementation and this
// index record ownership — a method's `qualified_name` (`Agent::Run`) also carries the
// owner, but the edge is the authoritative link and does not depend on name parsing.
func (r *Resolver) ownMethodsOf(ctx context.Context, id string) (map[string][]string, error) {
	rows, err := r.db.sql.QueryContext(ctx, `
		SELECT n.name, COALESCE(n.signature, '')
		FROM edges e
		JOIN nodes n ON n.id = e.target
		WHERE e.source = ? AND e.kind = 'contains' AND n.kind = 'method'`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string][]string{}
	for rows.Next() {
		var name, signature string
		if err := rows.Scan(&name, &signature); err != nil {
			return nil, err
		}
		out[name] = append(out[name], signature)
	}
	return out, rows.Err()
}

// goEmbeddings maps each type to the types it embeds.
//
// Only the two kinds that mean embedding in Go: an interface embeds interfaces, a
// struct embeds any of the three. A `heuristic` edge is excluded because those are the
// synthesized ones this pass writes — following them would build a method set out of
// its own output.
func (r *Resolver) goEmbeddings(ctx context.Context, kindOf map[string]string) (map[string][]string, error) {
	rows, err := r.db.sql.QueryContext(ctx, `
		SELECT e.source, e.target, e.kind, COALESCE(e.provenance, '')
		FROM edges e
		WHERE e.kind IN ('extends', 'implements')
		  AND e.source IN (SELECT id FROM nodes WHERE language = 'go' AND kind IN ('struct', 'type_alias', 'interface'))`)
	if err != nil {
		return nil, fmt.Errorf("cggraph: go embeddings: %w", err)
	}
	defer rows.Close()

	out := map[string][]string{}
	for rows.Next() {
		var source, target, kind, provenance string
		if err := rows.Scan(&source, &target, &kind, &provenance); err != nil {
			return nil, err
		}
		// Synthesized edges are never followed: this pass writes them.
		if provenance == "heuristic" {
			continue
		}
		to, ok := kindOf[target]
		if !ok {
			// The embedding did not resolve to a type in this tree (`io.Closer`).
			continue
		}
		// An interface embeds only interfaces; a struct embeds structs, defined types
		// and interfaces.
		from := kindOf[source]
		if from == "interface" && to != "interface" {
			continue
		}
		out[source] = append(out[source], target)
	}
	return out, rows.Err()
}

// methodSetCovers reports whether `have` includes every name in `want`.
func methodSetCovers(have, want map[string][]string) bool {
	if len(have) < len(want) {
		return false
	}
	for name := range want {
		if _, ok := have[name]; !ok {
			return false
		}
	}
	return true
}

// aritiesFit applies the parameter/result count check.
//
// A nil entry on either side means "unreadable, rules nothing out" — the reference
// implementation's tri-state, kept because a stricter reading would reject real
// implementations whose signatures the extractor rendered in a shape this parser does
// not handle.
func aritiesFit(have, want map[string]map[string]bool, wantNames map[string][]string) bool {
	for name := range wantNames {
		wanted, wantKnown := want[name]
		got, haveKnown := have[name]
		if !wantKnown || !haveKnown || wanted == nil || got == nil {
			continue
		}
		fits := false
		for arity := range wanted {
			if got[arity] {
				fits = true
				break
			}
		}
		if !fits {
			return false
		}
	}
	return true
}

// writeEdges inserts synthesized edges, ignoring duplicates.
func (r *Resolver) writeEdges(ctx context.Context, edges []StoredEdge) error {
	tx, err := r.db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := insertEdges(ctx, tx, edges); err != nil {
		return err
	}
	return tx.Commit()
}

func containsString(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}
