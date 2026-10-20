// Command cg builds and queries the code index.
//
// The subcommands mirror the reference tool's, because the workflow they encode is
// the right one: build the index deliberately (`init` / `index`), keep it fresh
// (`sync`), then query it cheaply and repeatedly (`explore`, `callers`, `callees`,
// `impact`, `status`). Nothing here runs an agent or talks to a model — this is a
// code-intelligence CLI, and the runtime consumes it as a subprocess.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cggraph"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cgparse"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		var usage usageError
		if errors.As(err, &usage) {
			fmt.Fprintln(os.Stderr, string(usage))
			os.Exit(2)
		}
		fmt.Fprintln(os.Stderr, "cg:", err)
		os.Exit(1)
	}
}

type usageError string

func (e usageError) Error() string { return string(e) }

const usage = `cg — build and query a code index

usage:
  cg init [path]              build the index for a workspace (default: .)
  cg index [path]             rebuild the index from scratch
  cg sync [path]              update the index for changed files only
  cg status [path]            report what the index holds
  cg explore <query>          definitions, call sites and snippets in one call
  cg callers <symbol>         who calls this
  cg callees <symbol>         what this calls
  cg impact <symbol>          what breaks if this changes (--depth N)
  cg nodes <file>             the definitions in one file
  cg version

environment:
  CG_PARSE   path to cg-parse (default: beside this binary, then PATH)
`

func run(argv []string) error {
	if len(argv) == 0 {
		return usageError(usage)
	}
	command := argv[0]
	args := argv[1:]

	switch command {
	case "help", "-h", "--help":
		fmt.Print(usage)
		return nil
	case "version", "-v", "--version":
		fmt.Println("cg", versionString())
		return nil
	case "init", "index":
		return cmdIndex(args, command == "index")
	case "sync":
		return cmdIndex(args, false)
	case "status":
		return cmdStatus(args)
	case "explore":
		return cmdExplore(args)
	case "callers":
		return cmdEdge(args, "callers")
	case "callees":
		return cmdEdge(args, "callees")
	case "impact":
		return cmdImpact(args)
	case "nodes":
		return cmdNodes(args)
	default:
		return usageError("unknown command " + command + "\n\n" + usage)
	}
}

func versionString() string {
	return "0.1.0"
}

// resolveParser finds the cg-parse binary.
//
// Order: the explicit environment variable, then beside this executable (the
// packaged layout, matching how the vendored ripgrep is found), then PATH for a
// development build. Returning an error rather than silently degrading is
// deliberate: a CLI that quietly indexes nothing is worse than one that says why.
func resolveParser() (string, error) {
	if env := os.Getenv("CG_PARSE"); env != "" {
		if info, err := os.Stat(env); err == nil && !info.IsDir() {
			return env, nil
		}
		return "", fmt.Errorf("CG_PARSE=%s does not exist", env)
	}
	names := []string{"cg-parse", "cg-parse.exe"}
	if self, err := os.Executable(); err == nil {
		for _, name := range names {
			candidate := filepath.Join(filepath.Dir(self), name)
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				return candidate, nil
			}
		}
	}
	for _, name := range names {
		if path, err := execLookPath(name); err == nil {
			return path, nil
		}
	}
	return "", errors.New("cg-parse not found: put it beside cg, set CG_PARSE, or add it to PATH")
}

func rootArg(args []string) string {
	for _, arg := range args {
		if !strings.HasPrefix(arg, "-") {
			return arg
		}
	}
	return "."
}

func withContext(fn func(context.Context) error) error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return fn(ctx)
}

func openIndex(root string) (*cggraph.DB, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return cggraph.Open(absolute)
}

func cmdIndex(args []string, full bool) error {
	root := rootArg(args)
	binary, err := resolveParser()
	if err != nil {
		return err
	}
	db, err := openIndex(root)
	if err != nil {
		return err
	}
	defer db.Close()

	return withContext(func(ctx context.Context) error {
		started := time.Now()
		lastPhase := ""
		result, err := cggraph.Index(ctx, db, cggraph.IndexOptions{
			Root:   root,
			Parser: &cgparse.Parser{Binary: binary, Concurrency: 4, ChunkSize: 32},
			Full:   full,
			OnProgress: func(phase string, done, total int) {
				if phase != lastPhase {
					fmt.Fprintf(os.Stderr, "  %s…\n", phase)
					lastPhase = phase
				}
			},
		})
		if err != nil {
			return err
		}
		fmt.Printf("indexed %d files (%d skipped, %d heuristic, %d deferred) in %s\n",
			result.FilesParsed, result.FilesSkipped, result.FilesHeuristic, result.FilesFailed,
			time.Since(started).Round(time.Millisecond))
		fmt.Printf("  nodes %d   edges %d   unresolved %d\n",
			result.Nodes, result.Edges, result.Unresolved)
		fmt.Printf("  resolved %d   unresolved after resolve %d   ambiguous %d\n",
			result.ResolveStats.Resolved, result.ResolveStats.Failed, result.ResolveStats.Ambiguous)
		// Deferral is reported separately from "failed": it is the extractor declining a
		// file it cannot parse without errors, not this tool breaking.
		if len(result.DeferReasons) > 0 {
			reasons := make([]string, 0, len(result.DeferReasons))
			for reason := range result.DeferReasons {
				reasons = append(reasons, reason)
			}
			sort.Strings(reasons)
			fmt.Printf("  deferred %d file(s):\n", result.FilesFailed)
			for _, reason := range reasons {
				fmt.Printf("    %-60s %d\n", cggraph.TruncateForDisplay(reason, 60), result.DeferReasons[reason])
			}
		}
		fmt.Printf("  index: %s\n", db.Path())
		return nil
	})
}

func cmdStatus(args []string) error {
	db, err := openIndex(rootArg(args))
	if err != nil {
		return err
	}
	defer db.Close()

	stats, err := db.Stats()
	if err != nil {
		return err
	}
	fmt.Printf("index: %s\n", db.Path())
	fmt.Printf("  files %d   nodes %d   edges %d\n", stats.Files, stats.Nodes, stats.Edges)
	fmt.Printf("  unresolved refs %d (pending %d)\n", stats.Unresolved, stats.Pending)
	fmt.Printf("  ambiguous edges %d (%.1f%% of edges)\n",
		stats.AmbiguousEdges, percent(stats.AmbiguousEdges, stats.Edges))
	fmt.Printf("  size %.1f MB   journal %s\n", float64(stats.SizeBytes)/(1<<20), stats.Journal)

	// Two distinct gaps, reported separately because they mean different things: a file with
	// no symbols at all is invisible to every query, while a heuristically-read file has
	// symbols but no call graph.
	if stats.Heuristic > 0 {
		fmt.Printf("\n  heuristic %d file(s) — symbols only, no call graph:\n", stats.Heuristic)
		languages := make([]string, 0, len(stats.HeuristicByLanguage))
		for language := range stats.HeuristicByLanguage {
			languages = append(languages, language)
		}
		sort.Strings(languages)
		for _, language := range languages {
			fmt.Printf("    %-14s %d\n", language, stats.HeuristicByLanguage[language])
		}
		fmt.Println("  (tree-sitter's grammar rejects these; a C compiler accepts them.")
		fmt.Println("   Names and locations are reliable, call edges are absent.)")
	}

	// A file whose language has no working parser is the one failure mode a user must
	// see: the index looks complete while whole files are missing from it.
	if stats.Deferred > 0 {
		fmt.Printf("\n  deferred %d file(s) — extraction produced no symbols:\n", stats.Deferred)
		languages := make([]string, 0, len(stats.DeferredByLanguage))
		for language := range stats.DeferredByLanguage {
			languages = append(languages, language)
		}
		sort.Strings(languages)
		for _, language := range languages {
			fmt.Printf("    %-14s %d\n", language, stats.DeferredByLanguage[language])
		}
		files, err := db.DeferredFiles(context.Background(), 5)
		if err == nil {
			for _, file := range files {
				fmt.Printf("      %s\n        %s\n", shortPath(file.Path), cggraph.TruncateForDisplay(file.Reason, 100))
			}
			if len(files) < stats.Deferred {
				fmt.Printf("      … and %d more\n", stats.Deferred-len(files))
			}
		}
		fmt.Println("  (C/C++ files with syntax errors are handed to a WASM fallback parser,")
		fmt.Println("   which this build does not carry; go/typescript/rust/python parse fully.)")
	}
	return nil
}

// percent is count/total as a percentage, 0 when total is 0.
func percent(count, total int) float64 {
	if total == 0 {
		return 0
	}
	return 100 * float64(count) / float64(total)
}

func cmdExplore(args []string) error {
	query := strings.Join(args, " ")
	if strings.TrimSpace(query) == "" {
		return usageError("cg explore <query>")
	}
	db, err := openIndex(".")
	if err != nil {
		return err
	}
	defer db.Close()

	return withContext(func(ctx context.Context) error {
		symbols, err := db.FindSymbols(ctx, query, 10)
		if err != nil {
			return err
		}
		if len(symbols) == 0 {
			fmt.Printf("no definition matches %q\n", query)
			return nil
		}
		for _, sym := range symbols {
			fmt.Printf("%s  %s  %s:%d-%d\n",
				sym.Kind, sym.Name, shortPath(sym.FilePath), sym.StartLine, sym.EndLine)
			if sym.Signature != "" {
				fmt.Printf("    %s\n", cggraph.TruncateForDisplay(sym.Signature, 120))
			}
			callers, err := db.Callers(ctx, sym.ID, 8)
			if err != nil {
				return err
			}
			if len(callers) > 0 {
				fmt.Printf("    callers (%d):\n", len(callers))
				uncertain := 0
				for _, site := range callers {
					if site.Ambiguous {
						uncertain++
					}
					fmt.Printf("      %s:%d %s\n", shortPath(site.FilePath), site.Line, site.Symbol)
					printAmbiguity(ctx, db, site, "        ")
				}
				// A count the reader can act on: "one of these might be wrong" is a
				// different instruction from "all of these are certain".
				if uncertain > 0 {
					fmt.Printf("      ⚠ %d of %d caller edges are ambiguous — the target was one of\n"+
						"        several equally plausible symbols; check before relying on them.\n",
						uncertain, len(callers))
				}
			}
			fmt.Println()
		}
		return nil
	})
}

// printAmbiguity renders an ambiguous edge's alternatives.
//
// This is the point of recording the tie during resolution: a reader — or an agent — can see
// that `Open` resolved to `DB.Open` rather than `Store.Open`, and judge whether that matters.
// Without it the edge reads as a fact.
func printAmbiguity(ctx context.Context, db *cggraph.DB, site cggraph.CallSite, indent string) {
	if !site.Ambiguous || len(site.Candidates) == 0 {
		return
	}
	refs, err := db.DescribeCandidates(ctx, site.Candidates)
	if err != nil || len(refs) == 0 {
		return
	}
	fmt.Printf("%sambiguous: %d candidates, chose the first\n", indent, len(refs))
	for i, ref := range refs {
		marker := " "
		if i == 0 {
			marker = "→"
		}
		fmt.Printf("%s  %s %s (%s:%d)\n", indent, marker, ref.Name, shortPath(ref.FilePath), ref.Line)
	}
}

func cmdEdge(args []string, which string) error {
	name := ""
	for _, arg := range args {
		if !strings.HasPrefix(arg, "-") {
			name = arg
			break
		}
	}
	if name == "" {
		return usageError("cg " + which + " <symbol>")
	}
	db, err := openIndex(".")
	if err != nil {
		return err
	}
	defer db.Close()

	return withContext(func(ctx context.Context) error {
		symbols, err := db.FindSymbols(ctx, name, 3)
		if err != nil {
			return err
		}
		if len(symbols) == 0 {
			fmt.Printf("no definition matches %q\n", name)
			return nil
		}
		sym := symbols[0]
		var sites []cggraph.CallSite
		if which == "callers" {
			sites, err = db.Callers(ctx, sym.ID, 100)
		} else {
			sites, err = db.Callees(ctx, sym.ID, 100)
		}
		if err != nil {
			return err
		}
		fmt.Printf("%s %s (%s:%d)\n", sym.Kind, sym.Name, shortPath(sym.FilePath), sym.StartLine)
		if len(sites) == 0 {
			fmt.Printf("  no %s\n", which)
			return nil
		}
		uncertain := 0
		for _, site := range sites {
			if site.Ambiguous {
				uncertain++
			}
			fmt.Printf("  %-10s %s:%d  %s\n", site.Kind, shortPath(site.FilePath), site.Line, site.Symbol)
			printAmbiguity(ctx, db, site, "    ")
		}
		if uncertain > 0 {
			fmt.Printf("  ⚠ %d of %d edges are ambiguous (target chosen from tied candidates)\n",
				uncertain, len(sites))
		}
		return nil
	})
}

func cmdImpact(args []string) error {
	depth := 2
	name := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--depth" && i+1 < len(args) {
			fmt.Sscanf(args[i+1], "%d", &depth)
			i++
			continue
		}
		if !strings.HasPrefix(arg, "-") && name == "" {
			name = arg
		}
	}
	if name == "" {
		return usageError("cg impact <symbol> [--depth N]")
	}
	db, err := openIndex(".")
	if err != nil {
		return err
	}
	defer db.Close()

	return withContext(func(ctx context.Context) error {
		symbols, err := db.FindSymbols(ctx, name, 1)
		if err != nil {
			return err
		}
		if len(symbols) == 0 {
			fmt.Printf("no definition matches %q\n", name)
			return nil
		}
		sites, err := db.Impact(ctx, symbols[0].ID, depth)
		if err != nil {
			return err
		}
		fmt.Printf("impact of %s (depth %d): %d call sites\n", symbols[0].Name, depth, len(sites))
		for _, site := range sites {
			fmt.Printf("  %s:%d  %s\n", shortPath(site.FilePath), site.Line, site.Symbol)
		}
		return nil
	})
}

func cmdNodes(args []string) error {
	path := rootArg(args)
	db, err := openIndex(".")
	if err != nil {
		return err
	}
	defer db.Close()

	return withContext(func(ctx context.Context) error {
		absolute, _ := filepath.Abs(path)
		symbols, err := db.NodeNamesForFile(ctx, absolute)
		if err != nil {
			return err
		}
		if len(symbols) == 0 {
			fmt.Printf("no indexed definitions in %s\n", path)
			return nil
		}
		for _, sym := range symbols {
			fmt.Printf("%6d  %-10s %s\n", sym.StartLine, sym.Kind, sym.Name)
		}
		return nil
	})
}

func shortPath(path string) string {
	cleaned := filepath.ToSlash(path)
	for _, marker := range []string{"/internal/", "/cmd/", "/desktop/", "/tools/"} {
		if index := strings.LastIndex(cleaned, marker); index >= 0 {
			return cleaned[index+1:]
		}
	}
	if len(cleaned) > 48 {
		return "…" + cleaned[len(cleaned)-47:]
	}
	return cleaned
}

// jsonHelper is used by commands that grow a --json flag later.
func jsonHelper(value any) string {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return "{}"
	}
	return string(raw)
}

var _ = jsonHelper
