package builtin

// code_explore: the single code-intelligence tool.
//
// The design follows the reference implementation, which exposes exactly one tool rather than
// a family (search / callers / callees / files / impact). The reasoning holds up: a family
// forces the model to choose before it understands the code, and each choice costs a round
// trip. One tool that returns definitions *and* their source *and* their call sites is fewer
// round trips and, more importantly, one decision instead of four.
//
// Two things differ from the reference, both because of what this build actually has:
//
//   - **No natural-language query.** The reference resolves a question through FTS5. This
//     index has no full-text table (a deliberate omission), so `query` is a bag of symbol
//     names, file names, or short identifiers. The description says so plainly rather than
//     inviting a question it cannot answer.
//   - **Ambiguity is shown.** Where the resolver chose between tied candidates it says which
//     ones, and which it picked. The reference silently takes the first. A model that can see
//     the tie can decide whether the answer matters; a model that cannot will repeat a guess
//     as a fact.
//
// The output is line-numbered verbatim source, which is what makes one call substitute for a
// Read loop. The tool tells the model to treat the shown source as already read.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cggraph"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// codeExplore limits. Each bounds one axis of the worst case, because a generous default on a
// large symbol is what turns one tool call into a wall of text that stays in the window.
const (
	// CodeExploreToolName is the model-facing name.
	//
	// A constant rather than a literal because three places spell it and they have to
	// agree: this tool's registration, the runtime's live un-registration when the
	// switch goes off, and the registry's `Missing` entry that the start-up notice
	// names. A rename that missed one of the three would leave the model with a tool
	// that is in the schema and not in the registry.
	CodeExploreToolName = "code_explore"
	// CODE_EXPLORE_MAX_FILES is how many files may contribute source by default.
	CODE_EXPLORE_MAX_FILES = 12
	// CODE_EXPLORE_MAX_FILES_CAP bounds what the model may ask for.
	CODE_EXPLORE_MAX_FILES_CAP = 40
	// CODE_EXPLORE_MAX_SYMBOLS is how many definitions are resolved per query term.
	CODE_EXPLORE_MAX_SYMBOLS = 6
	// CODE_EXPLORE_MAX_SITES caps callers and callees per symbol.
	CODE_EXPLORE_MAX_SITES = 10
	// CODE_EXPLORE_MAX_SOURCE_LINES truncates one symbol's body.
	//
	// A 2000-line function is a real thing, and pasting it displaces everything else in the
	// window. The truncation says how many lines were withheld so the model can ask again
	// with a narrower query rather than assume the function ends there.
	CODE_EXPLORE_MAX_SOURCE_LINES = 120
	// CODE_EXPLORE_MAX_OUTPUT_CHARS is the total budget.
	CODE_EXPLORE_MAX_OUTPUT_CHARS = 32000
	// CODE_EXPLORE_IMPACT_DEPTH is how far the blast radius walks.
	CODE_EXPLORE_IMPACT_DEPTH = 2
)

// CgParserBinary locates the index parser for this platform.
//
// Returns false when this build carries none — a development build, or a platform that ships
// without it. That is not fatal: the index can still be queried, it just cannot be rebuilt, and
// the tool says so instead of pretending the answer is current.
func CgParserBinary() (string, bool) {
	triple, ok := hostTriple()
	if !ok {
		return "", false
	}
	name := "cg-parse"
	if runtime.GOOS == "windows" {
		name = "cg-parse.exe"
	}
	candidate := filepath.Join(paths.VendorCG(), triple, name)
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate, true
	}
	return "", false
}

// NewCodeExplore builds the tool, or reports false when this workspace has no index.
//
// Not registering is the right default: a tool that can only ever answer "there is no
// index" costs the model a schema in every request and a round trip to learn nothing. The
// registry records the absence in its notice instead, so the capability is visibly missing
// rather than silently broken.
//
// `refresher` is **passed in** rather than built here, because the runtime owns one per
// workspace: the panel's init/sync and this tool's inline freshness check must serialize
// on the same mutex, or two of them can rebuild the same index inside one process. Nil
// means the caller has no index handle, which is also "no tool".
func NewCodeExplore(workspace *tools.Workspace, refresher *codeintel.Refresher) (tools.Tool, bool) {
	if workspace == nil || refresher == nil {
		return tools.Tool{}, false
	}
	root := workspace.Root()
	dbPath := filepath.Join(root, filepath.FromSlash(cggraph.IndexDirName), cggraph.DefaultDBName)
	if info, err := os.Stat(dbPath); err != nil || info.IsDir() {
		return tools.Tool{}, false
	}
	// The parser binary is optional here: without it the index can still be queried, it
	// just cannot be brought up to date, and the tool answers with a warning about that.

	return tools.Tool{
		Name: CodeExploreToolName,
		Description: "Find definitions and the code around them in ONE call: returns the " +
			"verbatim source of matching symbols with line numbers (treat what is shown as " +
			"already read — do not re-open those files), plus who calls them and what they " +
			"call. Prefer this over grep/read when the question is about a named symbol, what " +
			"it does, what breaks if it changes, or where a piece of behaviour lives. " +
			"query is symbol names, file names, or short identifiers separated by spaces — " +
			"not a natural-language question. When a call site is marked ambiguous, the " +
			"resolver tied between candidates and picked the first; check before relying on it.",
		Risk:         security.RiskLow,
		ParallelSafe: true,
		Schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{
					"type": "string",
					"description": "Symbol names, file names, or short identifiers, space " +
						"separated, e.g. \"Render resolveTier cggraph/db.go\". Every term is " +
						"looked up; terms that match nothing are listed back as not found.",
				},
				"max_files": map[string]any{
					"type":        "number",
					"description": fmt.Sprintf("Maximum files whose source is included (default %d, cap %d)", CODE_EXPLORE_MAX_FILES, CODE_EXPLORE_MAX_FILES_CAP),
				},
			},
			"required": []string{"query"},
		},
		Handler: func(ctx context.Context, arguments map[string]any) (tools.Result, error) {
			return runCodeExplore(ctx, refresher, arguments)
		},
	}, true
}

// runCodeExplore answers one query.
func runCodeExplore(ctx context.Context, refresher *codeintel.Refresher, arguments map[string]any) (tools.Result, error) {
	root := refresher.Root()
	query, _ := arguments["query"].(string)
	query = strings.TrimSpace(query)
	if query == "" {
		return tools.Result{}, fmt.Errorf("code_explore: query is required")
	}
	maxFiles := CODE_EXPLORE_MAX_FILES
	if raw, ok := arguments["max_files"].(float64); ok && raw > 0 {
		maxFiles = int(raw)
		if maxFiles > CODE_EXPLORE_MAX_FILES_CAP {
			maxFiles = CODE_EXPLORE_MAX_FILES_CAP
		}
	}

	db, err := cggraph.Open(root)
	if err != nil {
		// A database that cannot be opened is a broken index, which is different from an
		// absent one (that is handled at registration). Say which.
		return tools.Result{}, fmt.Errorf("code_explore: cannot open the index at %s: %w",
			filepath.Join(root, filepath.FromSlash(cggraph.IndexDirName), cggraph.DefaultDBName), err)
	}
	defer db.Close()

	// Freshness first, so the banner precedes every conclusion drawn below.
	var warnings []string
	report, refreshErr := refresher.EnsureFresh(ctx)
	switch {
	case refreshErr != nil:
		warnings = append(warnings, "could not check whether the index is current: "+
			refreshErr.Error()+"; results may be stale")
	case report.State == codeintel.Synced:
		// Worth saying: the model asked a question about code it may have just changed, and
		// knowing the index caught up explains why an answer includes that change.
		warnings = append(warnings, fmt.Sprintf(
			"index was behind and has been updated (%s) before answering",
			divergenceSummary(report)))
	case report.Detail != "":
		warnings = append(warnings, report.Detail+
			"; symbols added or renamed by those edits may be missing or stale, so treat file "+
			"contents as authoritative")
	}

	terms := strings.Fields(query)
	source := &sourceReader{root: root, cache: map[string][]string{}}
	budget := &outputBudget{remaining: CODE_EXPLORE_MAX_OUTPUT_CHARS}

	writer := &strings.Builder{}
	for _, warning := range warnings {
		fmt.Fprintf(writer, "WARNING: %s\n\n", warning)
	}
	fmt.Fprintf(writer, "code index: %s\n\n", root)

	notFound := make([]string, 0, len(terms))
	filesUsed := 0
	seenFiles := map[string]bool{}
	seenSymbols := map[string]bool{}

	for _, term := range terms {
		symbols, err := db.FindSymbols(ctx, term, CODE_EXPLORE_MAX_SYMBOLS)
		if err != nil {
			return tools.Result{}, fmt.Errorf("code_explore: look up %q: %w", term, err)
		}
		// A query term that names a file rather than a symbol still deserves an answer: list
		// what that file declares, which is what a reader wants from "cggraph/db.go".
		if len(symbols) == 0 {
			if fileSymbols, ok := symbolsInFile(ctx, db, root, term); ok {
				symbols = fileSymbols
			}
		}
		if len(symbols) == 0 {
			notFound = append(notFound, term)
			continue
		}

		for _, symbol := range symbols {
			if seenSymbols[symbol.ID] {
				continue
			}
			seenSymbols[symbol.ID] = true

			// Source is budgeted per file: the same file rarely needs showing twice, and
			// counting it once is what keeps a multi-symbol query inside one call.
			includeSource := false
			if !seenFiles[symbol.FilePath] && filesUsed < maxFiles {
				includeSource = true
				seenFiles[symbol.FilePath] = true
				filesUsed++
			}

			renderSymbol(ctx, root, writer, db, source, budget, symbol, includeSource)
		}
	}

	if len(notFound) > 0 {
		sort.Strings(notFound)
		fmt.Fprintf(writer, "not found in the index: %s\n", strings.Join(notFound, ", "))
		fmt.Fprintln(writer, "(if these were added or renamed just now, the index is behind — "+
			"re-run the indexer, or read the file directly)")
	}
	if budget.remaining < 0 {
		fmt.Fprintf(writer, "\n[output truncated: %d characters over budget; narrow the query]\n",
			-budget.remaining)
	}

	return tools.Result{Text: writer.String()}, nil
}

// symbolsInFile resolves a query term that names a file, returning what it declares.
//
// Matched on suffix so both `db.go` and `cggraph/db.go` work: the model rarely types the full
// path, and the full path is rarely what distinguishes two files in a conversation.
func symbolsInFile(ctx context.Context, db *cggraph.DB, root, term string) ([]cggraph.Symbol, bool) {
	// A term with no separator is unlikely to be a path; try anyway, since `main.go` is one.
	candidates := []string{
		filepath.Join(root, filepath.FromSlash(term)),
		filepath.Join(root, filepath.FromSlash(strings.ReplaceAll(term, "\\", "/"))),
	}
	for _, path := range candidates {
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			continue
		}
		symbols, err := db.NodeNamesForFile(ctx, path)
		if err != nil || len(symbols) == 0 {
			return nil, false
		}
		if len(symbols) > CODE_EXPLORE_MAX_SYMBOLS {
			symbols = symbols[:CODE_EXPLORE_MAX_SYMBOLS]
		}
		return symbols, true
	}
	return nil, false
}

// renderSymbol writes one definition, its source, and its call sites.
func renderSymbol(ctx context.Context, root string, writer *strings.Builder, db *cggraph.DB,
	source *sourceReader, budget *outputBudget, symbol cggraph.Symbol, includeSource bool) {

	where := fmt.Sprintf("%s:%d", relativePath(root, symbol.FilePath), symbol.StartLine)
	if symbol.EndLine > symbol.StartLine {
		where = fmt.Sprintf("%s:%d-%d", relativePath(root, symbol.FilePath), symbol.StartLine, symbol.EndLine)
	}
	fmt.Fprintf(writer, "## %s %s  %s\n", symbol.Kind, symbol.Name, where)
	if symbol.Signature != "" {
		fmt.Fprintf(writer, "%s\n", strings.TrimSpace(symbol.Signature))
	}

	if includeSource {
		lines := source.lines(symbol.FilePath)
		if lines == nil {
			fmt.Fprintf(writer, "(source unavailable: %s)\n", relativePath(root, symbol.FilePath))
		} else {
			start, end := symbol.StartLine, symbol.EndLine
			if start < 1 {
				start = 1
			}
			if end > len(lines) {
				end = len(lines)
			}
			truncated := false
			if end-start+1 > CODE_EXPLORE_MAX_SOURCE_LINES {
				end = start + CODE_EXPLORE_MAX_SOURCE_LINES - 1
				truncated = true
			}
			if end >= start {
				budget.write(writer, formatNumbered(lines, start, end))
				if truncated {
					fmt.Fprintf(writer, "... [%d more lines not shown; narrow the query]\n",
						symbol.EndLine-end)
				}
			}
		}
	}

	// Callers: who would break if this changes.
	callers, err := db.Callers(ctx, symbol.ID, CODE_EXPLORE_MAX_SITES)
	if err == nil && countCallSites(callers) > 0 {
		fmt.Fprintf(writer, "callers (%d):\n", countCallSites(callers))
		renderSites(ctx, root, writer, db, callers)
	} else if err != nil {
		fmt.Fprintf(writer, "callers: unavailable (%v)\n", err)
	}

	// Callees: what this depends on.
	callees, err := db.Callees(ctx, symbol.ID, CODE_EXPLORE_MAX_SITES)
	if err == nil && countCallSites(callees) > 0 {
		fmt.Fprintf(writer, "callees (%d):\n", countCallSites(callees))
		renderSites(ctx, root, writer, db, callees)
	}

	// Blast radius, as a number rather than a listing: the listing is what the model gets
	// from a follow-up query on a specific symbol, and printing it for every hit is how one
	// call becomes a wall.
	if reach, err := db.Impact(ctx, symbol.ID, CODE_EXPLORE_IMPACT_DEPTH); err == nil && len(reach) > 0 {
		fmt.Fprintf(writer, "blast radius: %d symbol(s) within %d hop(s)\n",
			len(reach), CODE_EXPLORE_IMPACT_DEPTH)
	}
	fmt.Fprintln(writer)
}

// renderSites writes call sites, marking the ambiguous ones with their alternatives.
func renderSites(ctx context.Context, root string, writer *strings.Builder, db *cggraph.DB, sites []cggraph.CallSite) {
	shown := 0
	for _, site := range sites {
		// Containment is not a call. `file.go contains Render` says where a symbol is
		// declared, which the heading already said, and listing it under "callers" invites
		// the model to treat a file as a caller.
		if site.Kind == "contains" {
			continue
		}
		shown++
		fmt.Fprintf(writer, "  %s:%d  %s\n", relativePath(root, site.FilePath), site.Line, site.Symbol)
		if !site.Ambiguous || len(site.Candidates) == 0 {
			continue
		}
		alternatives, err := db.DescribeCandidates(ctx, site.Candidates)
		if err != nil || len(alternatives) == 0 {
			fmt.Fprintf(writer, "    AMBIGUOUS: %d tied candidates\n", len(site.Candidates))
			continue
		}
		names := make([]string, 0, len(alternatives))
		for index, alternative := range alternatives {
			marker := ""
			if index == 0 {
				marker = " (chosen)"
			}
			names = append(names, fmt.Sprintf("%s %s:%d%s", alternative.Name,
				relativePath(root, alternative.FilePath), alternative.Line, marker))
		}
		fmt.Fprintf(writer, "    AMBIGUOUS: tied between %s\n", strings.Join(names, " | "))
	}
}

// countCallSites counts the sites renderSites would print.
func countCallSites(sites []cggraph.CallSite) int {
	count := 0
	for _, site := range sites {
		if site.Kind != "contains" {
			count++
		}
	}
	return count
}

// sourceReader reads files once per call and caches their lines.
//
// A query naming five symbols in one file must not read that file five times, and the source
// is re-read from disk rather than from the index on purpose: the index stores positions, and
// the authoritative text is the file. If the index is stale the source shown is current, which
// is the more useful of the two.
type sourceReader struct {
	root  string
	cache map[string][]string
}

// lines returns the file's lines, or nil when it cannot be read.
func (r *sourceReader) lines(path string) []string {
	if cached, ok := r.cache[path]; ok {
		return cached
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		r.cache[path] = nil
		return nil
	}
	lines := strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n")
	r.cache[path] = lines
	return lines
}

// formatNumbered renders a 1-based inclusive line range with line numbers.
//
// Line numbers are the whole point: without them the model cannot cite a location, cannot ask
// for a range, and cannot edit precisely, so it falls back to reading the file again — which
// is the round trip this tool exists to remove.
func formatNumbered(lines []string, start, end int) string {
	width := len(itoa(end))
	var out strings.Builder
	for number := start; number <= end && number <= len(lines); number++ {
		text := lines[number-1]
		// Tabs are kept: a Go file's indentation is tabs and rewriting them would make the
		// shown source differ from the file, which matters when it is used for an edit.
		fmt.Fprintf(&out, "%*d| %s\n", width, number, truncateLine(text, 400))
	}
	return out.String()
}

// truncateLine caps one source line.
//
// Generated or minified source defeats a per-file budget with a single line; the line number is
// still the locator the model needs.
func truncateLine(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit] + " …"
}

// outputBudget tracks the remaining character budget.
type outputBudget struct {
	remaining int
}

// write appends text while charging it against the budget.
//
// Over-budget text is still written once — a truncated answer that silently stops mid-function
// is worse than one that says it stopped — but the final notice reports the overshoot so the
// model knows to narrow the query rather than assume completeness.
func (b *outputBudget) write(writer *strings.Builder, text string) {
	b.remaining -= len(text)
	writer.WriteString(text)
}

// divergenceSummary renders a refresh report as "2 modified, 1 added".
func divergenceSummary(report codeintel.Report) string {
	parts := make([]string, 0, 3)
	if report.Changed > 0 {
		parts = append(parts, itoa(report.Changed)+" modified")
	}
	if report.Added > 0 {
		parts = append(parts, itoa(report.Added)+" added")
	}
	if report.Removed > 0 {
		parts = append(parts, itoa(report.Removed)+" deleted")
	}
	if len(parts) == 0 {
		return itoa(report.Files) + " changed"
	}
	return strings.Join(parts, ", ")
}

// relativePath renders a path relative to the workspace, using forward slashes.
//
// The model should see `internal/memory/entry.go`, not an absolute Windows path: the relative
// form is what it can pass back, and it is far shorter. Stripping the real root is what makes
// this correct — matching on markers like "/tools/" collapsed `internal/tools/tool.go` into
// `tools/tool.go` and made every path ambiguous between packages.
func relativePath(root, path string) string {
	slashed := filepath.ToSlash(path)
	rootSlashed := strings.TrimSuffix(filepath.ToSlash(root), "/")
	if rootSlashed != "" && strings.HasPrefix(slashed, rootSlashed+"/") {
		return slashed[len(rootSlashed)+1:]
	}
	return slashed
}
