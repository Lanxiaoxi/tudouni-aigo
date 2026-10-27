package cggraph

// The scope: which part of a workspace one index database covers.
//
// A workspace can contain several independent repositories — separate clones,
// a sub-clone inside the root, a copied-in source tree. The indexer is given
// a **scope**: the directories to walk and the exclusions that keep one
// scope's walk from descending into another scope's territory (a selected
// sub-repo is carved out of the root's walk, which is what makes a selection
// a partition of the tree).
//
// Everything downstream of the walk — staleness, project-config detection —
// takes the same Scope, so "what is in the index" and "what does the index
// compare against" cannot drift apart.

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Scope is one index's view of the working tree.
type Scope struct {
	// root is the workspace root: the directory every scope directory sits
	// under, and the fallback for settings lookups.
	root string
	// dirs are the absolute directories to walk.
	dirs []string
	// excludes are the absolute directories a walk of `root` must skip —
	// the selected sub-repos, when the root itself is also a scope.
	excludes []string
}

// NewScope builds a scope for one workspace root.
//
// `roots` and `excludes` are absolute; empty roots fall back to [root]. The
// single-argument whole-tree behaviour of every earlier index is
// NewScope(root, nil, nil).
func NewScope(root string, roots, excludes []string) *Scope {
	abs := root
	if a, err := filepath.Abs(root); err == nil {
		abs = a
	}
	dirs := roots
	if len(dirs) == 0 {
		dirs = []string{abs}
	}
	// Normalise and deduplicate so the scope's own arithmetic never compares
	// two spellings of the same directory.
	seen := make(map[string]struct{}, len(dirs))
	uniq := make([]string, 0, len(dirs))
	for _, dir := range dirs {
		dir = filepath.Clean(dir)
		if _, ok := seen[dir]; ok {
			continue
		}
		seen[dir] = struct{}{}
		uniq = append(uniq, dir)
	}
	sort.Strings(uniq)
	ex := make([]string, 0, len(excludes))
	exSeen := make(map[string]struct{}, len(excludes))
	for _, dir := range excludes {
		dir = filepath.Clean(dir)
		if _, ok := exSeen[dir]; ok {
			continue
		}
		exSeen[dir] = struct{}{}
		ex = append(ex, dir)
	}
	return &Scope{root: abs, dirs: uniq, excludes: ex}
}

// DirsWithExcludes returns (dir, isRoot) pairs to walk: every scope directory,
// and for the root one the exclusion list.
func (s *Scope) DirsWithExcludes() (dirs []string, excludes map[string]struct{}) {
	excludes = make(map[string]struct{}, len(s.excludes))
	for _, dir := range s.excludes {
		excludes[dir] = struct{}{}
	}
	dirs = make([]string, 0, len(s.dirs))
	dirs = append(dirs, s.dirs...)
	return dirs, excludes
}

// IsRoot reports whether dir is the scope's walk of the workspace root.
func (s *Scope) IsRoot(dir string) bool {
	return filepath.Clean(dir) == filepath.Clean(s.root)
}

// Contains reports whether an absolute path falls inside the scope.
func (s *Scope) Contains(path string) bool {
	for _, dir := range s.dirs {
		if underPath(path, dir) {
			return true
		}
	}
	return false
}

// OwnerDir returns the scope directory that owns an absolute path — longest
// match, so a file in a sub-repo never falls back to the root's settings —
// or the root when none of the scope directories contains it.
func (s *Scope) OwnerDir(path string) string {
	best := s.root
	bestLen := -1
	for _, dir := range s.dirs {
		if underPath(path, dir) && len(dir) > bestLen {
			best, bestLen = dir, len(dir)
		}
	}
	return best
}

// underPath reports whether path equals dir or sits inside it.
func underPath(path, dir string) bool {
	if path == dir {
		return true
	}
	p, d := filepath.ToSlash(path), filepath.ToSlash(dir)
	d = strings.TrimSuffix(d, "/")
	return len(p) > len(d) && strings.HasPrefix(p, d+"/")
}

// Dirs returns the scope's walk directories.
func (s *Scope) Dirs() []string {
	out := make([]string, len(s.dirs))
	copy(out, s.dirs)
	return out
}

// scanScopes is the scope-aware form of scanTree: nil is the whole tree.
func scanScopes(root string, scope *Scope) ([]scannedFile, error) {
	if scope == nil {
		return scanTree(root)
	}
	dirs, excludes := scope.DirsWithExcludes()
	var out []scannedFile
	for _, dir := range dirs {
		files, err := scanDir(dir, excludes)
		if err != nil {
			return nil, err
		}
		out = append(out, files...)
	}
	// The per-directory walks are individually sorted; one final sort keeps
	// the whole-scope order deterministic, which is what makes two indexings
	// of an unchanged tree produce the same database bytes.
	sort.Slice(out, func(i, j int) bool { return out[i].path < out[j].path })
	return out, nil
}

// scanDir collects indexable files under one directory, skipping `excludes`
// when it meets them. Excludes only bite on the root's walk — a sub-repo's
// walk starts inside its own territory, where the exclusion would wrongly
// prune its very first directory.
func scanDir(dir string, excludes map[string]struct{}) ([]scannedFile, error) {
	var out []scannedFile
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			if _, excluded := excludes[filepath.Clean(path)]; excluded {
				return filepath.SkipDir
			}
			if skipDirs[entry.Name()] {
				return filepath.SkipDir
			}
			if skipRootDirs[entry.Name()] && path == filepath.Join(dir, entry.Name()) {
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
	return out, err
}
