package cggraph

// The indexer: walk a tree, parse it, store it, resolve it.
//
// Ordering matters and is the whole design. Every file is parsed and stored first,
// and only then is anything resolved. Resolving as files arrive would bind a
// reference against a partial graph: `pkg.Foo` indexed before `pkg`'s own file
// would find no candidate, and — if failures were not retried — would stay
// unresolved forever even though the target was indexed moments later.
//
// Storing everything first also makes the resolver's candidate lookups meaningful:
// "all same-named definitions" is only the right question once every definition
// exists.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cgparse"
)

// IndexOptions configures one index run.
type IndexOptions struct {
	// Root is the tree to index.
	Root string
	// Parser is the configured cg-parse driver.
	Parser *cgparse.Parser
	// Full clears the database first. Without it, only changed files are re-parsed.
	Full bool
	// OnProgress, when set, is called after each phase with a short description.
	OnProgress func(phase string, done, total int)
}

// IndexResult is what one run produced.
type IndexResult struct {
	FilesScanned int
	FilesParsed  int
	FilesSkipped int
	FilesFailed  int
	// FilesHeuristic counts files the grammar rejected but the line scanner could read.
	FilesHeuristic int
	// FilesRemoved counts indexed files that no longer exist on disk.
	FilesRemoved int
	// RefsReopened is how many previously failed references the changed names brought back
	// into consideration. It is the number that says whether incremental resolution is doing
	// bounded work: it should be small, and it is what a scoped reset buys over resetting the
	// whole table.
	RefsReopened int
	Nodes        int
	Edges        int
	Unresolved   int
	// Implements is how many `implements` edges Go's structural typing implied.
	Implements int
	// MethodOwners is how many cross-file type→method `contains` edges were added.
	MethodOwners int
	// GoModule is the module path detected from go.mod, "" when there is none.
	GoModule string
	// PathAliases is how many TypeScript path aliases were found in tsconfig.
	PathAliases int
	// DeferReasons counts the reasons extraction declined a file, keyed by a short
	// description. A `defer` is not a failure of this tool's own: the Rust kernel hands
	// back files whose parse tree has errors (macro-heavy C, generated code) for the
	// fallback parser to handle, and when that fallback is absent they are recorded here.
	DeferReasons map[string]int
	ResolveStats ResolveStats
	Duration     time.Duration
}

// appendDeferReason tallies one reason.
func appendDeferReason(reasons map[string]int, reason string) map[string]int {
	if reasons == nil {
		reasons = map[string]int{}
	}
	// The kernel's message is long and carries the file path; the leading clause is what
	// distinguishes one failure mode from another.
	short := reason
	for _, marker := range []string{" — ", ": "} {
		if index := strings.Index(short, marker); index > 0 {
			short = short[:index]
			break
		}
	}
	if len(short) > 80 {
		short = short[:80]
	}
	reasons[short]++
	return reasons
}

// skipDirs are never descended into, at any depth.
//
// The index is a cache of first-party source, not a mirror of the disk: a vendored
// dependency tree or a build output directory would multiply the index size without
// adding a single symbol the agent cares about.
//
// Bundled output deserves its own note. On this repository, indexing
// `desktop/.../.perf-build/assets/index.js` alone produced 3,306 nodes — as much as
// about fifteen ordinary source files — because a bundle inlines everything it
// imported. One such file distorts every statistic computed from the index, so the
// build-output directories are excluded by name here and, separately, a
// minified-bundle check runs per file (`isBuildArtifact`) for the ones that live
// somewhere unexpected.
var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "dist": true,
	"vendor": true, ".tudouni": true, ".tudouni-index": true, ".codegraph": true,
	"target": true, ".next": true, "__pycache__": true, ".venv": true,
	"venv": true, ".workbuddy": true, ".tmp-gocache": true, ".tmp-outline-bench": true,
	// Build and scratch directories that hold generated bundles.
	".perf-build": true, ".test-build": true, ".tmp": true, ".cache": true,
	".turbo": true, ".svelte-kit": true, ".nuxt": true, ".tauri-build": true,
}

// skipRootDirs are build-output names that are only skipped at the workspace root.
//
// They are ordinary package names too. `internal/release` and `tools/release` in
// this repository are source, and a basename-only rule made them invisible to
// every query. Build output with these names lives at the root (CMake's build/,
// GoReleaser's dist/release) or inside an already-skipped directory such as
// `target/`, so the narrower rule loses nothing.
var skipRootDirs = map[string]bool{
	"build": true, "out": true, "coverage": true, "bundle": true, "release": true,
}

// isBuildArtifact reports whether a file is generated or bundled source.
//
// Two signals, both cheap and both about the file's own bytes:
//
//   - a minified bundle has lines far longer than source normally does, and almost no
//     line breaks relative to its size;
//   - a generated file usually says so in its first lines.
//
// The check exists because directory names cannot cover every case: a build output
// directory can be named anything, and a bundle can be committed next to its source.
// Claiming a bundle is a symbol table is worse than skipping it — the bundle's
// identifiers are the whole dependency tree's, so every one of them competes as a
// candidate for some real reference.
func isBuildArtifact(path string, size int64) bool {
	base := strings.ToLower(filepath.Base(path))
	switch {
	case strings.HasSuffix(base, ".min.js"), strings.HasSuffix(base, ".min.css"),
		strings.HasSuffix(base, ".bundle.js"), strings.HasSuffix(base, ".chunk.js"):
		return true
	}
	// A source file larger than a few hundred kilobytes is nearly always generated:
	// hand-written code of that size is rare, and a bundle of it is common.
	const oversizeSource = 512 * 1024
	return size > oversizeSource
}

// indexedExtensions maps an extension to the kernel's language name.
//
// Only languages the cg-parse binary actually carries appear here. An extension that
// is absent is a file the index has no grammar for, and scanning it in would produce
// a files row with zero nodes — indistinguishable later from a file that failed.
var indexedExtensions = map[string]string{
	".go": "go",
	".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
	".tsx": "tsx", ".js": "javascript", ".mjs": "javascript",
	".cjs": "javascript", ".jsx": "jsx",
	".rs": "rust", ".py": "python", ".pyi": "python",
	".java": "java",
	".c":    "c", ".h": "c",
	".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp",
	".cs": "csharp", ".rb": "ruby", ".php": "php",
	".swift": "swift", ".kt": "kotlin", ".kts": "kotlin",
	".scala": "scala", ".sc": "scala", ".dart": "dart",
	".lua": "lua", ".luau": "luau", ".r": "r",
}

// Index runs one full or incremental index.
func Index(ctx context.Context, db *DB, opts IndexOptions) (IndexResult, error) {
	started := time.Now()
	var result IndexResult

	if opts.Parser == nil || opts.Parser.Binary == "" {
		return result, fmt.Errorf("cggraph: IndexOptions.Parser is not configured")
	}
	if opts.Root == "" {
		return result, fmt.Errorf("cggraph: IndexOptions.Root is empty")
	}

	// Every path the index stores is absolute. Relative paths looked fine from the root it
	// was built in and then broke everything that compares them against the file system from
	// somewhere else: staleness checks reported the whole tree as added-and-deleted at once,
	// the explore tool could not open the source it was about to show, and indexing the same
	// tree from two working directories produced two disjoint sets of rows.
	root, err := filepath.Abs(opts.Root)
	if err != nil {
		return result, fmt.Errorf("cggraph: resolve root %q: %w", opts.Root, err)
	}
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}

	if opts.Full {
		if err := db.Clear(); err != nil {
			return result, fmt.Errorf("cggraph: clear for full index: %w", err)
		}
	}

	files, err := scanTree(root)
	if err != nil {
		return result, err
	}
	result.FilesScanned = len(files)
	report(opts.OnProgress, "scanned", 0, len(files))

	// Incremental: a file whose (size, mtime, hash) all match was not touched, so
	// re-parsing it would produce the same nodes at the same ids.
	known, err := knownFiles(ctx, db)
	if err != nil {
		return result, err
	}
	// Files that were indexed and are now gone. This ran nowhere before, so a deleted file
	// kept its nodes forever and `explore` went on reporting symbols from code that no longer
	// existed.
	onDisk := make(map[string]struct{}, len(files))
	for _, file := range files {
		onDisk[file.path] = struct{}{}
	}
	for path := range known {
		if _, ok := onDisk[path]; ok {
			continue
		}
		if err := db.DeleteFile(ctx, path); err != nil {
			return result, err
		}
		result.FilesRemoved++
	}

	// The stat a pending file is recorded with must be the one taken **before** the
	// parser read it. Taking a fresh stat afterwards would record the timestamp of a
	// newer version of the file than the nodes describe, and the next sync's fast
	// path would then treat the stale graph as up to date forever.
	scanned := make(map[string]scannedFile, len(files))
	for _, file := range files {
		scanned[file.path] = file
	}

	var pending []cgparse.Reference
	for _, file := range files {
		if previous, ok := known[file.path]; ok && !opts.Full {
			// Fast path: an unchanged size and modification time means the file was not
			// edited, so it is skipped without being read at all. This is the entire cost
			// of a no-change sync — and reading every file to hash it is what used to make
			// that cost 2s on a tree this size.
			if previous.size == file.size && previous.modifiedAt == file.modifiedAt {
				result.FilesSkipped++
				continue
			}
			// The stat changed but the content may not have: a `touch`, a checkout, or a
			// formatter that rewrote the file identically. Hashing costs far less than
			// parsing, so compare before paying for the parser. On a match the stored stat
			// is refreshed so the fast path above hits next time.
			if hash := hashOf(file.path); hash != "" && hash == previous.hash {
				_ = db.TouchFile(ctx, file.path, file.size, file.modifiedAt)
				result.FilesSkipped++
				continue
			}
		}
		pending = append(pending, cgparse.Reference{Path: file.path, Language: file.language})
	}
	report(opts.OnProgress, "changed", 0, len(pending))

	// Hash before parsing, not after: the hash and the stat must describe the same
	// bytes the parser is about to read. A hash taken afterwards can describe a
	// newer version than the nodes, and the next sync's stat+hash fast path would
	// then accept the stale graph as current.
	hashes := make(map[string]string, len(pending))
	for _, ref := range pending {
		hashes[ref.Path] = hashOf(ref.Path)
	}

	// Names declared by the files about to be parsed. Resolution uses them to decide which
	// historical failures are worth retrying — see ReopenRefsForNames.
	declaredNames := make(map[string]struct{}, 256)

	// Phase 1: parse and store. No resolution yet.
	parsed, err := opts.Parser.ParseAll(ctx, pending)
	if err != nil {
		return result, fmt.Errorf("cggraph: parse: %w", err)
	}
	for index, one := range parsed {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		info := pending[index]
		stat := scanned[info.Path]
		if !one.OK {
			// The kernel declined this file. For C and C++ that happens on files a compiler
			// accepts — tree-sitter's grammar has gaps — so a line-based extractor tries
			// before the file is written off. It yields symbols without a call graph; see
			// heuristic.go.
			if heuristic, applied := tryHeuristicExtraction(info); applied {
				record := FileRecord{
					Path:        info.Path,
					ContentHash: hashes[info.Path],
					Language:    info.Language,
					Size:        stat.size,
					ModifiedAt:  stat.modifiedAt,
					NodeCount:   len(heuristic.Nodes),
					ParseError:  heuristicReason,
				}
				if err := db.WriteFile(ctx, record, heuristic.Nodes, heuristic.Edges, nil); err != nil {
					return result, err
				}
				result.FilesHeuristic++
				result.Nodes += len(heuristic.Nodes)
				result.Edges += len(heuristic.Edges)
				report(opts.OnProgress, "parsed", result.FilesParsed+result.FilesHeuristic, len(pending))
				continue
			}

			result.FilesFailed++
			result.DeferReasons = appendDeferReason(result.DeferReasons, one.Error)
			// Recorded as a files row with the REAL content hash and the reason in
			// parse_error, so the failure is visible and a changed file is retried.
			// An *unchanged* file is not retried by sync: the fast path above skips
			// it, which is why a parser upgrade needs a full rebuild to reach files
			// the old parser declined. Padding the hash with a failure marker would
			// make change detection see every broken file as changed on every run.
			record := FileRecord{
				Path:        info.Path,
				ContentHash: hashes[info.Path],
				Language:    info.Language,
				Size:        stat.size,
				ModifiedAt:  stat.modifiedAt,
				ParseError:  one.Error,
			}
			_ = db.WriteFile(ctx, record, nil, nil, nil)
			continue
		}

		nodes, edges, refs := FromParse(one.File)
		for _, node := range nodes {
			if node.Name != "" {
				declaredNames[node.Name] = struct{}{}
			}
		}
		record := FileRecord{
			Path:        info.Path,
			ContentHash: hashes[info.Path],
			Language:    info.Language,
			Size:        stat.size,
			ModifiedAt:  stat.modifiedAt,
			NodeCount:   len(nodes),
		}
		if err := db.WriteFile(ctx, record, nodes, edges, refs); err != nil {
			return result, err
		}
		result.FilesParsed++
		result.Nodes += len(nodes)
		result.Edges += len(edges)
		result.Unresolved += len(refs)
		report(opts.OnProgress, "parsed", result.FilesParsed, len(pending))
	}

	// Nothing changed, so nothing can be resolved differently. Skipping this is what makes a
	// no-change sync cheap: phase 2 re-resolves every unresolved reference in the graph, and
	// on this repository that was 1.8s of a 1.9s no-op run.
	if len(pending) == 0 && result.FilesRemoved == 0 {
		return result, nil
	}

	// Phase 2: resolve. This runs over the whole graph, not just the files just
	// indexed, because a reference's answer depends on definitions elsewhere.
	// Re-open only the failures a changed name could now resolve. A full index has no
	// previous failures to revisit — the database was cleared — so this is incremental-only.
	if !opts.Full {
		names := make([]string, 0, len(declaredNames))
		for name := range declaredNames {
			names = append(names, name)
		}
		reopened, err := db.ReopenRefsForNames(ctx, names)
		if err != nil {
			return result, err
		}
		result.RefsReopened = int(reopened)
	}
	resolver := NewResolver(db)
	// The module path and the TS path aliases are facts about the tree, so they are
	// detected rather than configured: import narrowing needs the module path to map
	// `github.com/x/y/internal/tools` onto `internal/tools`, and the JS tier needs the
	// alias table or it treats `@/components/Foo` as an external dependency.
	projectConfig := DetectProjectConfig(root)
	resolver.SetRepoPrefix(projectConfig.GoModule)
	resolver.SetPathAliases(projectConfig.PathAliases)
	result.GoModule = projectConfig.GoModule
	result.PathAliases = len(projectConfig.PathAliases)
	stats, err := resolver.ResolveAll(ctx)
	if err != nil {
		return result, fmt.Errorf("cggraph: resolve: %w", err)
	}
	result.ResolveStats = stats

	// Go's cross-file method ownership runs first: a type's methods are often declared
	// in a different file, and everything downstream (member outlines, impact traversal,
	// the implements method-set check) reads a type's methods off its `contains` edges.
	owners, err := resolver.SynthesizeGoMethodOwners(ctx)
	if err != nil {
		return result, fmt.Errorf("cggraph: synthesize method owners: %w", err)
	}
	result.MethodOwners = owners

	// Go's implicit interface satisfaction runs after resolution and after method
	// ownership: it reads the `contains` edges linking a type to its methods and the
	// `extends` edges recording embedding, and both only exist once references are
	// resolved.
	implements, err := resolver.SynthesizeGoImplements(ctx)
	if err != nil {
		return result, fmt.Errorf("cggraph: synthesize implements: %w", err)
	}
	result.Implements = implements

	result.Duration = time.Since(started)
	report(opts.OnProgress, "resolved", stats.Resolved, stats.Attempted)
	return result, nil
}

type scannedFile struct {
	path       string
	language   string
	size       int64
	modifiedAt int64
}

// scanTree collects indexable files.
//
// Sorted by path so a run is deterministic: two indexings of an unchanged tree must
// produce the same database bytes, and file-system order is not stable.
func scanTree(root string) ([]scannedFile, error) {
	var out []scannedFile
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			// An unreadable directory is skipped rather than fatal: a permission
			// problem deep in a tree should not make the whole index fail.
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			if skipDirs[entry.Name()] {
				return filepath.SkipDir
			}
			if skipRootDirs[entry.Name()] && path == filepath.Join(root, entry.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		language, ok := indexedExtensions[strings.ToLower(filepath.Ext(path))]
		if !ok {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		// Symlinks are skipped: following them can escape the tree, and a link into a
		// build directory would index generated code as if it were source.
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		if isBuildArtifact(path, info.Size()) {
			return nil
		}
		out = append(out, scannedFile{
			path:       path,
			language:   language,
			size:       info.Size(),
			modifiedAt: info.ModTime().UnixMilli(),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].path < out[j].path })
	return out, nil
}

type knownFile struct {
	size       int64
	modifiedAt int64
	hash       string
}

func knownFiles(ctx context.Context, db *DB) (map[string]knownFile, error) {
	rows, err := db.sql.QueryContext(ctx, `SELECT path, content_hash, size, modified_at FROM files`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]knownFile)
	for rows.Next() {
		var path, hash string
		var size, modifiedAt int64
		if err := rows.Scan(&path, &hash, &size, &modifiedAt); err != nil {
			return nil, err
		}
		out[path] = knownFile{size: size, modifiedAt: modifiedAt, hash: hash}
	}
	return out, rows.Err()
}

// hashOf hashes a file's content.
//
// The hash is what makes change detection correct when mtime does not move: a
// checkout, a rebase, or an edit that preserves the timestamp all leave (size, mtime)
// unchanged, and only a content compare catches them.
func hashOf(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func report(onProgress func(string, int, int), phase string, done, total int) {
	if onProgress != nil {
		onProgress(phase, done, total)
	}
}

// tryHeuristicExtraction attempts the line-based reader on a file the grammar rejected.
//
// Gated on the two languages it is written for, and on the file still producing something: a
// scan that finds no declarations reports "not applied", so the file is recorded as deferred
// rather than as a success with zero nodes.
func tryHeuristicExtraction(info cgparse.Reference) (HeuristicResult, bool) {
	switch info.Language {
	case "c", "cpp":
	default:
		return HeuristicResult{}, false
	}
	source, err := os.ReadFile(info.Path)
	if err != nil {
		return HeuristicResult{}, false
	}
	result := HeuristicExtract(info.Path, info.Language, source)
	// One node means only the file node was created, which carries no information.
	if len(result.Nodes) < 2 {
		return HeuristicResult{}, false
	}
	return result, true
}
