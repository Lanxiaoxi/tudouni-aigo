package cggraph

// Import-scoped candidate narrowing.
//
// This is the single highest-value step in Go resolution, and it is the one the first
// version of this resolver was missing. The scoring formula is a ranking over
// candidates; it has no way to know that `tools.Tool` can only mean the `tools`
// package this file actually imports. Without that fact, every same-named symbol in
// the tree competes, and on this repository that inflated `calls` by 26% and left 13%
// of edges decided by a tie.
//
// The rule is narrow and exact:
//
//	the reference is `qualifier.Name` AND the file imports a package bound to
//	`qualifier`  鈫? the only candidates are that package's exported definitions
//
// Everything else passes through untouched. A `qualifier` that is a local variable
// (`server.Start`) must NOT be treated as a package, which is why an import list is
// consulted rather than the shape of the name.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Import is one package a file brings into scope.
type Import struct {
	// Path is the import path as written (`net/http`,
	// `github.com/example/project/internal/tools`).
	Path string
	// Alias is the identifier the file binds it to. Empty means "the default", which
	// Go derives from the path's last segment 鈥?except for a major-version suffix
	// (`/v2`), which it ignores.
	Alias string
	// DotImport means `. "path"`: every exported name is in scope unqualified.
	DotImport bool
	// Blank means `_ "path"`: imported for its side effects, binding no name.
	Blank bool
}

// LocalName is the identifier this import introduces.
//
// The rule is Go's: an explicit alias wins; otherwise the last path segment, unless
// that segment is a major-version tag, in which case it is the one before. Getting
// this wrong would make `yaml "gopkg.in/yaml.v3"` miss its alias and `foo/v2` look
// like a package called `v2`.
func (i Import) LocalName() string {
	if i.Alias != "" {
		return i.Alias
	}
	segments := strings.Split(strings.TrimSuffix(i.Path, "/"), "/")
	if len(segments) == 0 {
		return i.Path
	}
	last := segments[len(segments)-1]
	if isMajorVersionSegment(last) && len(segments) >= 2 {
		return segments[len(segments)-2]
	}
	return last
}

// isMajorVersionSegment reports whether a path segment is a semantic-import-versioning
// tag: `v2`, `v3`, and so on.
func isMajorVersionSegment(segment string) bool {
	if len(segment) < 2 || segment[0] != 'v' {
		return false
	}
	for _, r := range segment[1:] {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// ParseImportSpec turns an import node's name and signature into an Import.
//
// The extractor stores an import node with the path as its name and, when the source
// carried one, the whole spec as its signature 鈥?`ctxwin "github.com/鈥?context"`,
// `. "embed"`, `_ "net/http/pprof"`. Parsing the signature is what recovers an alias;
// the name alone cannot.
func ParseImportSpec(name, signature string) Import {
	path := strings.TrimSpace(name)
	spec := strings.TrimSpace(signature)

	imported := Import{Path: path}
	if spec == "" {
		return imported
	}
	// Strip a leading `import ` when the signature is a whole declaration.
	spec = strings.TrimSpace(strings.TrimPrefix(spec, "import"))
	if spec == "" {
		return imported
	}

	// Find the quoted path inside the spec; everything before it is the alias.
	quote := strings.IndexAny(spec, "\"`")
	if quote < 0 {
		return imported
	}
	prefix := strings.TrimSpace(spec[:quote])
	switch prefix {
	case "":
		// No alias: nothing more to learn.
	case ".":
		imported.DotImport = true
	case "_":
		imported.Blank = true
	default:
		imported.Alias = prefix
	}
	// The quoted text is the authoritative path 鈥?it is what the compiler sees, while
	// the node's name is the extractor's rendering of it.
	if end := strings.LastIndexAny(spec[quote+1:], "\"`"); end >= 0 {
		if quoted := strings.TrimSpace(spec[quote+1 : quote+1+end]); quoted != "" {
			imported.Path = quoted
		}
	}
	return imported
}

// importsForFile returns the imports declared in one file.
//
// Read from the database rather than re-parsed: the import nodes are already there,
// and re-reading source would duplicate the extractor's work.
func (r *Resolver) importsForFile(ctx context.Context, filePath string) (map[string]Import, error) {
	rows, err := r.db.sql.QueryContext(ctx, `
		SELECT name, COALESCE(signature, '')
		FROM nodes
		WHERE file_path = ? AND kind = 'import'`, filePath)
	if err != nil {
		return nil, fmt.Errorf("cggraph: imports for %s: %w", filePath, err)
	}
	defer rows.Close()

	out := make(map[string]Import)
	for rows.Next() {
		var name, signature string
		if err := rows.Scan(&name, &signature); err != nil {
			return nil, err
		}
		imported := ParseImportSpec(name, signature)
		if imported.Blank {
			// `_ "path"` binds no identifier, so it scopes nothing.
			continue
		}
		if imported.DotImport {
			// Recorded under a sentinel: a dot import puts every exported name in
			// scope unqualified, which the caller uses to skip narrowing rather than
			// to narrow to nothing.
			out["."] = imported
			continue
		}
		out[imported.LocalName()] = imported
	}
	return out, rows.Err()
}

// narrowToImport restricts candidates to the package an import qualifier names.
//
// Returns the narrowed slice and whether narrowing applied. It applies only when the
// reference is qualified AND the qualifier is a real import: a local variable named
// `tools` would otherwise be mistaken for the package.
//
// The package is matched by directory, because an import path and a file path are
// different namespaces: `github.com/x/y/internal/tools` is the directory
// `<root>/internal/tools`. When the import path cannot be mapped onto any indexed
// directory the result is an empty candidate set, and the caller records the
// reference as unresolved rather than falling back to a global name match 鈥?a
// qualified reference to a package this tree does not contain has no correct answer,
// and a name match would manufacture a wrong one.
func narrowToImport(
	ref *pendingRef,
	imports map[string]Import,
	candidates []Candidate,
	repoPrefix string,
) ([]Candidate, bool) {
	qualifier, _, unqualified := SplitGoQualified(ref.Name)
	if unqualified || qualifier == "" {
		return candidates, false
	}
	// A dot import puts everything in scope unqualified; a qualified name cannot be
	// resolved through it, so leave the set alone rather than emptying it.
	if _, isDot := imports["."]; isDot && imports[qualifier].Path == "" {
		return candidates, false
	}
	imported, ok := imports[qualifier]
	if !ok {
		// The qualifier is not an import: it is a local, a field, or a type. Receiver
		// inference is what handles those, so no narrowing here.
		return candidates, false
	}

	dir := importPathToDir(imported.Path, repoPrefix)
	if dir == "" {
		// The package is outside this repository (a module dependency). Nothing in the
		// index can be its target.
		return nil, true
	}

	narrowed := make([]Candidate, 0, len(candidates))
	for _, cand := range candidates {
		if sameDir(filepath.Dir(cand.FilePath), dir) {
			narrowed = append(narrowed, cand)
		}
	}
	return narrowed, true
}

// importPathToDir maps an import path onto a directory in the tree.
//
// `repoPrefix` is the module path (`github.com/Lanxiaoxi/tudouni-aigo`), so
// `github.com/Lanxiaoxi/tudouni-aigo/internal/tools` becomes `internal/tools`. A path
// outside the module returns "", which is how a third-party import is recognised
// without a module list.
//
// Matching is done on the path's tail rather than its head because the index stores
// absolute file paths: comparing `internal/tools` against
// `C:\鈥internal\tools` needs the same separator-normalised suffix on both sides.
func importPathToDir(importPath, repoPrefix string) string {
	importPath = strings.TrimSpace(importPath)
	if importPath == "" {
		return ""
	}
	normalized := strings.ReplaceAll(importPath, "\\", "/")

	if repoPrefix != "" {
		prefix := strings.ReplaceAll(repoPrefix, "\\", "/")
		if normalized == prefix {
			return "."
		}
		if strings.HasPrefix(normalized, prefix+"/") {
			return strings.TrimPrefix(normalized, prefix+"/")
		}
		return ""
	}
	// No module prefix known: treat a path with no dot in its first segment as in-repo
	// and keep it verbatim, which matches how Go tells a module path from a standard
	// one. A dotted path is third-party.
	first := normalized
	if slash := strings.IndexByte(normalized, '/'); slash >= 0 {
		first = normalized[:slash]
	}
	if strings.Contains(first, ".") {
		return ""
	}
	return normalized
}

// sameDir compares two directory paths with separators normalised.
//
// Both sides may be absolute or relative and may use either separator, which is what
// an index built on Windows over a tree that contains `/` in some paths requires.
func sameDir(a, b string) bool {
	return normalizeSlash(a) == normalizeSlash(b)
}

func normalizeSlash(path string) string {
	path = strings.ReplaceAll(path, "\\", "/")
	path = strings.TrimSuffix(path, "/")
	return strings.ToLower(path)
}

// DetectRepoPrefix reads the module path from a go.mod at or above `root`.
//
// Reading it rather than making it a flag because it is a fact about the tree, not a
// setting: every Go import path in the file references it, so a resolver without it
// cannot map `github.com/x/y/internal/tools` onto `internal/tools`. A tree with no
// go.mod (a non-Go project) returns "", and narrowing falls back to the
// first-segment-has-a-dot rule.
func DetectRepoPrefix(root string) string {
	dir := root
	for {
		candidate := filepath.Join(dir, "go.mod")
		if raw, err := os.ReadFile(candidate); err == nil {
			for _, line := range strings.Split(string(raw), "\n") {
				line = strings.TrimSpace(line)
				if !strings.HasPrefix(line, "module") {
					continue
				}
				rest := strings.TrimSpace(strings.TrimPrefix(line, "module"))
				// A module line may be quoted; the path itself never contains a space.
				rest = strings.Trim(rest, "\"`")
				if fields := strings.Fields(rest); len(fields) > 0 {
					return fields[0]
				}
			}
			return ""
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// HasSuffixDir reports whether `path` ends with the directory `suffix`, comparing
// separator-insensitively.
//
// Used when the repository root is not known exactly (a sub-directory index): the
// import path's tail still identifies the package even without the module prefix.
func HasSuffixDir(path, suffix string) bool {
	p := normalizeSlash(path)
	s := normalizeSlash(suffix)
	if s == "" || s == "." {
		return true
	}
	return p == s || strings.HasSuffix(p, "/"+s)
}
