package cggraph

// The resolver: turning unresolved references into edges.
//
// The loop is the one the reference implementation uses, minus the parts that need
// a language tier this tool does not implement:
//
//	for each pending ref:
//	    reject it outright if it names something outside the repository
//	    look up same-named definitions
//	    drop the ones the language's visibility rules exclude
//	    score the survivors, pick one, record the tie if there was one
//	    write an edge, or park the ref as failed
//
// A ref that cannot be resolved is parked with status='failed' rather than deleted.
// That is what makes the index converge: a reference that arrived before the file
// defining its target was indexed gets another chance on the next pass, instead of
// being silently lost.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

// ResolveStats is what one resolve pass did.
type ResolveStats struct {
	Attempted int
	Resolved  int
	Failed    int
	Ambiguous int
	Skipped   int
}

// Resolver runs resolution against one database.
type Resolver struct {
	db *DB
	// batchSize bounds how many refs are loaded at once. Resolution holds each
	// batch's candidates in memory, and a popular name on a large tree has thousands
	// of same-named definitions.
	batchSize int
	// repoPrefix is the module path (`github.com/owner/repo`), used to map an import
	// path onto a directory. Empty means "infer from the tree", which treats a path
	// with no dot in its first segment as in-repo.
	repoPrefix string
	// tiers are the per-language rules, keyed by the extractor's language name.
	//
	// A language with no tier runs the neutral path: everything visible, no import
	// narrowing, no receiver inference. That is deliberate — adding a language must
	// never change another language's output.
	tiers map[string]LanguageTier
	// pathAliases maps a TypeScript path-alias prefix to the directory it stands for.
	pathAliases map[string]string
	// sources caches file bodies across one batch, for tiers that read source.
	sources map[string]*sourceFile
}

// NewResolver builds a resolver.
func NewResolver(db *DB) *Resolver {
	r := &Resolver{db: db, batchSize: 2000, sources: map[string]*sourceFile{}}
	// Tiers are registered unconditionally; their language-specific settings (a module
	// prefix, a path alias table) are applied by the setters below.
	r.registerAllTiers()
	return r
}

// registerAllTiers installs every language tier.
//
// One place that lists them all, so adding a language is one line here plus its file —
// and so a reader can see at a glance which languages have rules and which fall through
// to the neutral path.
func (r *Resolver) registerAllTiers() {
	r.declareTier(&goTier{repoPrefix: r.repoPrefix})
	r.declareTier(&pythonTier{repoPrefix: r.repoPrefix})
	r.declareTier(&rustTier{})
	r.declareTier(&javaTier{})
	r.declareTier(&kotlinTier{})
	r.declareTier(&cTier{language: "c"})
	r.declareTier(&cTier{language: "cpp"})
	for _, language := range jsLanguages {
		r.declareTier(&jsTier{language: language, aliases: r.pathAliases})
	}
}

// source returns the cached source file for a path.
func (r *Resolver) source(path string) *sourceFile {
	if r.sources == nil {
		r.sources = map[string]*sourceFile{}
	}
	if file, ok := r.sources[path]; ok {
		return file
	}
	file := &sourceFile{path: path}
	r.sources[path] = file
	return file
}

// SetRepoPrefix sets the module path used for import narrowing.
// SetRepoPrefix sets the module path, used by the Go tier (import path → directory) and
// the Rust tier (crate-relative paths).
func (r *Resolver) SetRepoPrefix(prefix string) {
	r.repoPrefix = prefix
	r.registerAllTiers()
}

// SetPathAliases installs the TypeScript path-alias table (`@/*` → `src/*`).
//
// Aliases are a build-tool convention rather than a language feature, so they come from
// tsconfig and cannot be inferred: a resolver without them sees `@/components/Foo` as a
// bare package specifier and treats it as an external dependency.
func (r *Resolver) SetPathAliases(aliases map[string]string) {
	r.pathAliases = aliases
	r.registerAllTiers()
}

// ResolveAll resolves every pending reference.
func (r *Resolver) ResolveAll(ctx context.Context) (ResolveStats, error) {
	var stats ResolveStats

	lastID := 0
	for {
		if err := ctx.Err(); err != nil {
			return stats, err
		}
		batch, err := r.loadRefBatch(ctx, lastID)
		if err != nil {
			return stats, err
		}
		if len(batch) == 0 {
			return stats, nil
		}
		lastID = batch[len(batch)-1].rowID

		edges, failed, ambiguous, skipped, err := r.resolveBatch(ctx, batch)
		if err != nil {
			return stats, err
		}
		stats.Attempted += len(batch)
		stats.Resolved += len(edges)
		stats.Failed += len(failed)
		stats.Ambiguous += ambiguous
		stats.Skipped += skipped

		if err := r.persist(ctx, edges, failed); err != nil {
			return stats, err
		}
	}
}

// pendingRef is a row from unresolved_refs plus the fields resolution needs.
type pendingRef struct {
	rowID int
	Reference
	Candidates []string
}

func (r *Resolver) loadRefBatch(ctx context.Context, afterID int) ([]pendingRef, error) {
	rows, err := r.db.sql.QueryContext(ctx, `
		SELECT id, from_node_id, reference_name, reference_kind, line, col,
		       candidates, file_path, language
		FROM unresolved_refs
		WHERE status = 'pending' AND id > ?
		ORDER BY id
		LIMIT ?`, afterID, r.batchSize)
	if err != nil {
		return nil, fmt.Errorf("cggraph: load refs: %w", err)
	}
	defer rows.Close()

	var out []pendingRef
	for rows.Next() {
		var (
			ref     pendingRef
			candRaw sql.NullString
		)
		if err := rows.Scan(
			&ref.rowID, &ref.FromNodeID, &ref.Name, &ref.Kind, &ref.Line, &ref.Column,
			&candRaw, &ref.FromFileName, &ref.FromLanguage,
		); err != nil {
			return nil, fmt.Errorf("cggraph: scan ref: %w", err)
		}
		if candRaw.Valid && candRaw.String != "" {
			_ = json.Unmarshal([]byte(candRaw.String), &ref.Candidates)
		}
		out = append(out, ref)
	}
	return out, rows.Err()
}

// resolvedEdge is an edge the resolver decided on, together with the ref row it
// came from.
//
// The row id travels with the edge because the two must move together: clearing the
// ref by its own key would need every field that identifies it (name, kind, line,
// column), and any of those being slightly different from what was loaded would
// leave the ref in place and create the edge again on the next pass. The id is
// exact.
type resolvedEdge struct {
	StoredEdge
	refRowID  int
	Ambiguous bool
}

// failedRef is a ref to park for a later pass.
type failedRef struct {
	rowID  int
	name   string
	reason string
}

func (r *Resolver) resolveBatch(ctx context.Context, batch []pendingRef) (
	edges []resolvedEdge, failed []failedRef, ambiguous, skipped int, err error,
) {
	// Candidate lookups are cached per batch: a batch is ordered by id, and refs in
	// one file tend to share names, so the same query would otherwise repeat.
	cache := make(map[string][]Candidate, len(batch))
	// Receiver declarations are cached per file for the same reason, one step up:
	// Import lists are cached per file too, and they are what makes narrowing
	// possible at all.
	importCache := make(map[string]map[string]Import, 8)

	for i := range batch {
		ref := &batch[i]
		if err := ctx.Err(); err != nil {
			return nil, nil, 0, 0, err
		}

		// Cheap rejections first, before touching the database.
		if reason, reject := rejectRef(ref); reject {
			failed = append(failed, failedRef{rowID: ref.rowID, name: ref.Name, reason: reason})
			skipped++
			continue
		}

		// The language's rules, or nil for a language with no tier.
		tier := r.tierFor(ref.FromLanguage)

		// A language builtin is never a project definition.
		if tier != nil && tier.IsBuiltin(ref.Name) {
			failed = append(failed, failedRef{
				rowID: ref.rowID, name: ref.Name, reason: "language builtin",
			})
			skipped++
			continue
		}

		// Receiver type inference, which is what makes method calls tractable. Done
		// before candidate lookup so the narrowed set is what gets scored.
		if tier != nil {
			ref.ReceiverType = tier.ReceiverType(ref, r.source(ref.FromFileName))
		}

		lookupName := lookupKey(ref)
		candidates, ok := cache[lookupName]
		if !ok {
			candidates, err = r.candidatesFor(ctx, lookupName, ref.FromLanguage)
			if err != nil {
				return nil, nil, 0, 0, err
			}
			cache[lookupName] = candidates
		}
		if len(candidates) == 0 {
			failed = append(failed, failedRef{rowID: ref.rowID, name: ref.Name, reason: "no same-named definition"})
			continue
		}

		// Import narrowing. Applied before visibility and scoring because it is the
		// strongest fact available: `tools.Tool` means a specific package, not any
		// symbol named `Tool`.
		if tier != nil {
			imports, ok := importCache[ref.FromFileName]
			if !ok {
				imports, err = r.importsForFile(ctx, ref.FromFileName)
				if err != nil {
					return nil, nil, 0, 0, err
				}
				importCache[ref.FromFileName] = imports
			}
			narrowed, applied := tier.Narrow(ref, imports, candidates)
			if applied {
				if len(narrowed) == 0 {
					// A qualified reference whose package is outside this tree (or whose
					// package holds no such name) has no correct answer. Leaving it
					// unresolved is right; falling back to a global name match would
					// manufacture a wrong edge.
					failed = append(failed, failedRef{
						rowID: ref.rowID, name: ref.Name,
						reason: "qualified name not found in the imported package",
					})
					continue
				}
				candidates = narrowed
			}
		}

		// Language visibility rules, applied before scoring so an invisible candidate
		// cannot win and then be rejected — that ordering is what let the reference
		// implementation fall through to a worse match.
		visible := candidates[:0:0]
		for _, cand := range candidates {
			if tier != nil && !tier.Visible(&cand, ref) {
				continue
			}
			visible = append(visible, cand)
		}
		if len(visible) == 0 {
			failed = append(failed, failedRef{rowID: ref.rowID, name: ref.Name, reason: "all candidates are out of scope"})
			continue
		}

		// A function-as-value reference is resolved by unique-or-drop, never by scoring.
		//
		// "A wrong callback edge is worse than none" (the reference implementation's own
		// words): a callback that does not exist is a missing dependency, while a callback
		// bound to the wrong function claims a registration that never happens. Scoring
		// cannot express that asymmetry — its whole job is to pick a winner from a set
		// that may have no right answer.
		//
		// On this repository this single rule is what brought `references` from +124% down:
		// most of those edges were scored picks that should have stayed unresolved.
		if isFunctionRef(ref.Kind) {
			winner := selectFunctionRef(ref, visible)
			if winner == nil {
				failed = append(failed, failedRef{
					rowID: ref.rowID, name: ref.Name,
					reason: "function_ref: no unique candidate",
				})
				continue
			}
			edges = append(edges, resolvedEdge{
				StoredEdge: StoredEdge{
					Source:     ref.FromNodeID,
					Target:     winner.ID,
					Kind:       "references",
					Line:       intPtr(ref.Line),
					Column:     intPtr(ref.Column),
					Provenance: "heuristic",
				},
				refRowID: ref.rowID,
			})
			continue
		}

		// A receiver-qualified call whose receiver type could not be inferred is resolved
		// by unique-or-drop over methods, never by scoring.
		//
		// This is the `resolveMethodOnType` rule from the reference implementation: a
		// method is matched by `TypeName::methodName`, so a call through a receiver of
		// unknown type may bind only when exactly one method of that name exists anywhere
		// in the tree. Scoring a set of same-named methods instead picks one by directory
		// proximity, which is how `inputQueue.push` bound to an unrelated `push` and how
		// `EventEnvelope.t` bound to a TypeScript translation helper.
		//
		// Inferring the receiver type is what makes the strict path possible; when it
		// works the candidate set is already narrowed and standard scoring applies.
		// A receiver-qualified reference resolved through a method, with the receiver type
		// unknown, is decided by unique-or-drop rather than by scoring.
		//
		// `instantiates` is included with `calls` because both name something reached
		// through a receiver: `pkg.New(...)` and `new Foo()` are the same shape to the
		// extractor, and treating them differently would let one path guess while the
		// other refused.
		if ref.FromLanguage == "go" && ref.ReceiverType == "" &&
			(ref.Kind == "calls" || ref.Kind == "instantiates") {
			if receiver, method, isCall := splitReceiverCall(ref.Name); isCall && method != "" {
				_ = receiver
				winner := uniqueMethodCandidate(visible)
				if winner == nil {
					failed = append(failed, failedRef{
						rowID: ref.rowID, name: ref.Name,
						reason: "method call with uninferred receiver and no unique target",
					})
					continue
				}
				edges = append(edges, resolvedEdge{
					StoredEdge: StoredEdge{
						Source:     ref.FromNodeID,
						Target:     winner.ID,
						Kind:       edgeKindForRef(ref.Kind),
						Line:       intPtr(ref.Line),
						Column:     intPtr(ref.Column),
						Provenance: "heuristic",
					},
					refRowID: ref.rowID,
				})
				continue
			}
		}

		selection := Select(&ref.Reference, visible)
		if selection.Winner == nil {
			failed = append(failed, failedRef{rowID: ref.rowID, name: ref.Name, reason: "no candidate scored"})
			continue
		}

		edge := resolvedEdge{
			StoredEdge: StoredEdge{
				Source:     ref.FromNodeID,
				Target:     selection.Winner.ID,
				Kind:       edgeKindForRef(ref.Kind),
				Line:       intPtr(ref.Line),
				Column:     intPtr(ref.Column),
				Provenance: "heuristic",
			},
			refRowID:  ref.rowID,
			Ambiguous: selection.Ambiguous,
		}
		if selection.Ambiguous {
			ambiguous++
			edge.Metadata = tieMetadata(selection)
		}
		edges = append(edges, edge)
	}
	return edges, failed, ambiguous, skipped, nil
}

// rejectRef applies the checks that need no candidate list.
//
// These are the rejections that cost nothing and prevent the most damage: a
// reference to a predeclared identifier or a keyword can never name a project
// symbol, and binding one produces an edge that is both wrong and impossible to
// explain to a caller.
func rejectRef(ref *pendingRef) (reason string, reject bool) {
	// A generic type parameter is lexically scoped inside its own declaration; nothing
	// outside it can name one. This check is language-neutral because every language
	// with generics spells them the same way.
	//
	// The damage when it is missing is large and silent: on this repository TypeScript's
	// `<T>` matched the project's own `T` function (the i18n lookup) and produced 1,324
	// `references` edges, all false.
	if IsGenericTypeParameter(ref.Name) {
		return "generic type parameter", true
	}

	if ref.FromLanguage != "go" {
		return "", false
	}

	name := ref.Name

	// `len`, `append`, `make`, `string`, `error` and friends are predeclared. On
	// this repository they accounted for the largest single block of failed refs
	// (1946 `len`, 1009 `append`, 338 `make`) before this check existed, and each
	// one that found a same-named project symbol became a wrong edge.
	if unqualified := !strings.ContainsAny(name, "."); unqualified {
		if IsGoBuiltin(name) {
			return "Go predeclared identifier", true
		}
		if IsGoKeyword(name) {
			return "Go keyword", true
		}
	}

	// A standard-library qualifier names something outside the repository:
	// `fmt.Sprintf`, `strings.TrimSpace`, `testing.T.Fatalf`. The qualifier is only
	// recognised as a library when it cannot be a project package identifier, which is
	// the case for the predeclared form of an import path's last segment.
	//
	// The third return value is named `unqualified`, not `qualified` — an earlier
	// version of this check inverted it and silently never rejected anything, which is
	// why `fmt.Sprintf` and `strings.TrimSpace` still filled the failed-ref table.
	if qualifier, _, unqualified := SplitGoQualified(name); !unqualified {
		if isStdlibQualifier(qualifier) {
			return "standard-library qualifier " + qualifier, true
		}
	}

	return "", false
}

// isStdlibQualifier reports whether a bare package identifier is more plausibly a
// standard-library package than a project one.
//
// This is an allow-list of the standard library's package names, not of its import
// paths: `exec` (not `os/exec`), `filepath` (not `path/filepath`), `atomic` (not
// `sync/atomic`), `sql` (not `database/sql`). The distinction matters because a
// qualified reference carries only the name the source bound, which is the package's
// identifier rather than its path — so listing paths would match nothing.
//
// A project package whose import name collides with one of these is legal Go and would
// be missed here. The alternative — treating every unqualified qualifier as in-project
// — is what let `fmt.Sprintf` bind to a project `Sprintf`, and a wrong edge is worse
// than a missing one.
var stdlibQualifiers = map[string]bool{
	// Single-segment packages.
	"archive": true, "bufio": true, "bytes": true, "cmp": true, "compress": true,
	"container": true, "context": true, "crypto": true, "database": true,
	"debug": true, "embed": true, "encoding": true, "errors": true, "expvar": true,
	"flag": true, "fmt": true, "go": true, "hash": true, "html": true, "image": true,
	"index": true, "io": true, "iter": true, "log": true, "maps": true, "math": true,
	"mime": true, "net": true, "os": true, "path": true, "reflect": true,
	"regexp": true, "runtime": true, "slices": true, "sort": true, "strconv": true,
	"strings": true, "structs": true, "sync": true, "syscall": true,
	"testing": true, "text": true, "time": true, "unicode": true, "unique": true,
	"unsafe": true, "weak": true,

	// Sub-package names: what a file actually binds when it imports `os/exec` or
	// `path/filepath`. These were the four that a test caught missing.
	"exec": true, "filepath": true, "atomic": true, "sql": true,
	"json": true, "xml": true, "gob": true, "base64": true, "hex": true,
	"binary": true, "csv": true, "pem": true, "asn1": true, "gzip": true,
	"flate": true, "tar": true, "zip": true, "template": true, "http": true,
	"url": true, "mail": true, "rpc": true, "smtp": true, "textproto": true,
	"signal": true, "user": true, "mmap": true, "pprof": true, "trace": true,
	"rand": true, "sha256": true, "sha1": true, "md5": true, "hmac": true,
	"aes": true, "cipher": true, "elliptic": true, "ecdsa": true, "rsa": true,
	"tls": true, "x509": true, "big": true, "bits": true, "cmplx": true,
	"utf8": true, "utf16": true, "ioutil": true, "suffixarray": true,
	"multipart": true, "httptest": true, "httputil": true, "cgi": true,
	"fcgi": true, "color": true, "draw": true, "gif": true, "jpeg": true,
	"png": true, "syntax": true, "scanner": true, "token": true, "parser": true,
	"ast": true, "printer": true, "format": true, "doc": true, "list": true,
	"build": true, "constant": true, "types": true, "importer": true,
	"gzipfile": true, "iotest": true, "quick": true, "fstest": true,
	"fs": true, "atomic2": true, "semaphore": true, "utf8string": true,
}

func isStdlibQualifier(name string) bool { return stdlibQualifiers[name] }

// visibleAcrossFiles applies the per-language visibility rule.
//
// Only Go has one implemented; for other languages this is permissive, which
// matches the tool's stated scope: Go resolution is exact, everything else degrades
// to name matching.
func visibleAcrossFiles(ref *pendingRef, cand *Candidate) bool {
	if ref.FromLanguage != "go" || cand.Language != "go" {
		return true
	}
	return GoVisibleAcrossFiles(cand.Name, cand.FilePath, ref.FromFileName)
}

// edgeKindForRef maps an internal reference kind onto the edge kind it becomes.
//
// `function_ref` is the case that needs the mapping: a function used as a value
// (a callback registration) is not a call, but the graph has no `callback` edge, so
// it becomes a `references` edge. It is deliberately not reported as `calls`, which
// would claim the function runs there.
func edgeKindForRef(referenceKind string) string {
	if referenceKind == "function_ref" {
		return "references"
	}
	if referenceKind == "" {
		return "references"
	}
	return referenceKind
}

// lookupKey is the name to search definitions for.
//
// A qualified reference is looked up by its tail first: `tools.Tool` should find
// `Tool`. Narrowing by package is a later step, and doing it here via the import
// list would reject the common case where the qualifier is a local variable rather
// than an import.
func lookupKey(ref *pendingRef) string {
	_, rest, unqualified := SplitGoQualified(ref.Name)
	if unqualified {
		return ref.Name
	}
	return rest
}

func (r *Resolver) candidatesFor(ctx context.Context, name, language string) ([]Candidate, error) {
	// Prefer same-language candidates: a cross-language namesake can never win a
	// scoring contest against a same-language one, and excluding them here keeps a
	// huge cross-language candidate set from being scored at all.
	rows, err := r.db.sql.QueryContext(ctx, `
		SELECT id, kind, name, qualified_name, file_path, language, start_line,
		       is_exported, COALESCE(visibility, '')
		FROM nodes
		WHERE name = ?
		ORDER BY CASE WHEN language = ? THEN 0 ELSE 1 END, id
		LIMIT 500`, name, language)
	if err != nil {
		return nil, fmt.Errorf("cggraph: candidates for %q: %w", name, err)
	}
	defer rows.Close()

	var out []Candidate
	for rows.Next() {
		var (
			cand       Candidate
			isExported sql.NullInt64
		)
		if err := rows.Scan(
			&cand.ID, &cand.Kind, &cand.Name, &cand.QualifiedName,
			&cand.FilePath, &cand.Language, &cand.StartLine, &isExported, &cand.Visibility,
		); err != nil {
			return nil, fmt.Errorf("cggraph: scan candidate: %w", err)
		}
		if isExported.Valid {
			value := isExported.Int64 != 0
			cand.IsExported = &value
		}
		out = append(out, cand)
	}
	return out, rows.Err()
}

// persist writes one batch's outcome.
//
// Edges and the refs they came from move in the same transaction: an edge whose ref
// was not cleared would be created twice on the next pass, and a ref cleared without
// its edge would vanish entirely.
func (r *Resolver) persist(ctx context.Context, edges []resolvedEdge, failed []failedRef) error {
	tx, err := r.db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if err := insertEdges(ctx, tx, toStoredEdges(edges)); err != nil {
		return err
	}

	if len(edges) > 0 {
		stmt, err := tx.PrepareContext(ctx, `DELETE FROM unresolved_refs WHERE id = ?`)
		if err != nil {
			return err
		}
		defer stmt.Close()
		for _, edge := range edges {
			if _, err := stmt.ExecContext(ctx, edge.refRowID); err != nil {
				return fmt.Errorf("cggraph: clear resolved ref %d: %w", edge.refRowID, err)
			}
		}
	}

	if len(failed) > 0 {
		stmt, err := tx.PrepareContext(ctx, `UPDATE unresolved_refs SET status = 'failed' WHERE id = ?`)
		if err != nil {
			return err
		}
		defer stmt.Close()
		for _, item := range failed {
			if _, err := stmt.ExecContext(ctx, item.rowID); err != nil {
				return fmt.Errorf("cggraph: park failed ref: %w", err)
			}
		}
	}

	return tx.Commit()
}

func toStoredEdges(edges []resolvedEdge) []StoredEdge {
	out := make([]StoredEdge, 0, len(edges))
	for _, edge := range edges {
		out = append(out, edge.StoredEdge)
	}
	return out
}

func tieMetadata(selection Selection) map[string]any {
	ids := make([]string, 0, len(selection.Tied))
	for _, cand := range selection.Tied {
		ids = append(ids, cand.ID)
	}
	return map[string]any{
		"ambiguous":  true,
		"candidates": ids,
		"score":      selection.Score,
	}
}

func intPtr(value int) *int { return &value }

func derefInt(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

// DeleteRefByID removes one ref, used by the retry path.
func (d *DB) DeleteRefByID(ctx context.Context, id int) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM unresolved_refs WHERE id = ?`, id)
	return err
}

// ResetFailedRefs puts failed refs back to pending so the next pass retries them.
//
// Called after new files are indexed: a ref that failed because its target had not
// arrived yet becomes resolvable once it has.
func (d *DB) ResetFailedRefs(ctx context.Context) (int64, error) {
	result, err := d.sql.ExecContext(ctx,
		`UPDATE unresolved_refs SET status = 'pending' WHERE status = 'failed'`)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// unresolvedTails is a debugging helper: which names failed most often.
func (d *DB) unresolvedTails(ctx context.Context, limit int) ([]string, error) {
	rows, err := d.sql.QueryContext(ctx, `
		SELECT name_tail, COUNT(*) AS n
		FROM unresolved_refs
		WHERE status = 'failed'
		GROUP BY name_tail
		ORDER BY n DESC
		LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var tail string
		var count int
		if err := rows.Scan(&tail, &count); err != nil {
			return nil, err
		}
		out = append(out, fmt.Sprintf("%s (%d)", tail, count))
	}
	return out, rows.Err()
}

var _ = strings.TrimSpace
