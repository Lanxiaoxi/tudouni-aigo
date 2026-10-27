package codeintel

// The repository selection: which repositories the workspace's index covers.
//
// A **repository** is a directory that owns its own `.git` — a directory, or a
// *file* (a submodule's marker). One marker, nothing else: the feature must work
// on any layout a person puts in a workspace, and `.git` is the only fact that
// is about the repository rather than about whatever build tool happens to be
// in it. A `go.mod` or a `tsconfig.json` says "there is a Go / TypeScript
// project here", which is narrower and language-biased; `.git` says "this
// subtree is managed as one unit", which is the boundary the index wants.
//
// **Deepest wins.** A workspace whose root is itself a repository and which
// contains a sub-clone has nested markers. Only the deepest marker of each
// nested chain is reported, so the reported set never overlaps: the root's
// range means "everything except the sub-repos that were picked separately",
// and a selection of both partitions the tree.
//
// The root itself is always a candidate, even without a `.git`: source that
// was copied in rather than cloned has no marker at all, and a workspace with
// nothing indexable would be a feature that quietly does not exist.

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cggraph"
)

// RootRepo is the sentinel for "the whole workspace" in a repo selection.
const RootRepo = ""

// hasGitMarker reports whether dir contains a `.git` entry, directory or file.
func hasGitMarker(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

// markerSkip is the set of directory names never descended into while looking
// for markers. Narrower than the indexer's skip list on purpose: a repository
// a person would want on the checklist can be named almost anything, and a
// marker inside node_modules or a build directory is never one.
var markerSkip = map[string]bool{
	".git": true, "node_modules": true,
	".tudouni": true, ".venv": true, "venv": true, "__pycache__": true,
	"dist": true, "target": true, ".next": true,
}

// DiscoverRepos lists the repositories under root: every directory with a
// `.git` marker that is not itself inside a deeper reported one, plus the
// root. Sorted with the root first and the rest by path, so a panel can draw
// the list as-is and two selections compare order-stably.
func DiscoverRepos(root string) []string {
	abs, err := filepath.Abs(root)
	if err != nil {
		return []string{RootRepo}
	}

	var found []string // workspace-relative, "" for the root itself
	_ = filepath.WalkDir(abs, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.IsDir() {
			return nil
		}
		if markerSkip[entry.Name()] {
			return filepath.SkipDir
		}
		if hasGitMarker(path) {
			rel := strings.ReplaceAll(filepath.ToSlash(path), string(filepath.Separator), "/")
			prefix := strings.ReplaceAll(filepath.ToSlash(abs), string(filepath.Separator), "/")
			if prefix != "" {
				rel = strings.TrimPrefix(strings.TrimPrefix(rel, prefix), "/")
			}
			found = append(found, rel)
		}
		return nil
	})

	// Drop any candidate that sits inside a deeper reported one: `a` with a
	// `.git` and `a/b` with its own `.git` — only `a/b` is reported, and `a`'s
	// range is understood to exclude it.
	reported := make([]string, 0, len(found))
	for _, outer := range found {
		if outer == "" {
			continue
		}
		nested := false
		for _, inner := range found {
			if inner != "" && inner != outer && strings.HasPrefix(inner, outer+"/") {
				nested = true
				break
			}
		}
		if !nested {
			reported = append(reported, outer)
		}
	}
	sort.Strings(reported)
	return append([]string{RootRepo}, reported...)
}

// ResolveScopes turns a saved selection into the cggraph scope the index is
// built and checked with.
//
// An empty selection means "nothing chosen yet" and falls back to the legacy
// behaviour — the whole tree as one scope — which is what every index built
// before the selection existed covers, and what an unselected workspace must
// keep doing.
//
// The sub-repos in the selection become **excludes** of the root's walk when
// the root is also selected: that carve-out is what makes a selection a
// partition of the tree — a file belongs to exactly one scope, and both the
// staleness check and the per-repo project config rely on it.
func ResolveScopes(root string, repos []string) *cggraph.Scope {
	abs, err := filepath.Abs(root)
	if err != nil {
		return cggraph.NewScope(root, nil, nil)
	}
	if len(repos) == 0 {
		return cggraph.NewScope(abs, nil, nil)
	}

	roots := make([]string, 0, len(repos))
	excludes := make([]string, 0, len(repos))
	hasRoot := false
	for _, rel := range repos {
		rel = strings.ReplaceAll(rel, "\\", "/")
		if rel == "" {
			hasRoot = true
			continue
		}
		target := filepath.Join(abs, filepath.FromSlash(rel))
		roots = append(roots, target)
		if hasRoot || rootIsSelected(repos) {
			// The exclusion only matters while the root's own walk is part of
			// the build; a selection of sub-repos only never walks the root.
			excludes = append(excludes, target)
		}
	}
	if hasRoot {
		roots = append(roots, abs)
	}
	if len(roots) == 0 {
		return cggraph.NewScope(abs, nil, nil)
	}
	return cggraph.NewScope(abs, roots, excludes)
}

// rootIsSelected reports whether the selection names the root.
func rootIsSelected(repos []string) bool {
	for _, rel := range repos {
		if strings.ReplaceAll(rel, "\\", "/") == "" {
			return true
		}
	}
	return false
}

// SelectionValid reports whether every entry of a selection is a directory
// that exists and carries a `.git` marker, or the root sentinel. The front
// end only offers what `DiscoverRepos` found, but the config file is a shared
// fact another process can write, and a path that is no longer a repository
// must not silently become an indexed scope.
func SelectionValid(root string, repos []string) (bool, string) {
	for _, rel := range repos {
		rel = strings.ReplaceAll(rel, "\\", "/")
		if rel == "" {
			continue
		}
		if strings.Contains(rel, "..") {
			return false, rel + " is not a valid repository path"
		}
		if !hasGitMarker(filepath.Join(root, filepath.FromSlash(rel))) {
			return false, rel + " is no longer a repository (no .git)"
		}
	}
	return true, ""
}
