package cggraph

// The Go language tier.
//
// Every rule here was previously inlined in resolve.go as `if ref.FromLanguage == "go"`,
// which is exactly the shape that makes a second language impossible: the neutral loop
// has to know one language's details. Moving them behind the tier interface leaves the
// loop language-agnostic and makes each rule visible and testable on its own.

import (
	"path/filepath"
	"strings"
)

// goTier implements LanguageTier for Go.
type goTier struct {
	// repoPrefix is the module path, needed to map an import path onto a directory.
	repoPrefix string
}

func (t *goTier) Name() string { return "go" }

// Visible applies Go's export rule.
func (t *goTier) Visible(candidate *Candidate, ref *pendingRef) bool {
	return GoVisibleAcrossFiles(candidate.Name, candidate.FilePath, ref.FromFileName)
}

// Narrow restricts candidates to the imported package a qualifier names.
func (t *goTier) Narrow(ref *pendingRef, imports map[string]Import, candidates []Candidate) ([]Candidate, bool) {
	return narrowToImport(ref, imports, candidates, t.repoPrefix)
}

// ReceiverType infers the receiver's type from the file's local declarations.
func (t *goTier) ReceiverType(ref *pendingRef, file *sourceFile) string {
	receiver, method, isCall := splitReceiverCall(ref.Name)
	if !isCall || method == "" {
		return ""
	}
	decls := parseLocalDecls(file.Text(), 1)
	return receiverTypeAt(decls, receiver, ref.Line)
}

// IsBuiltin applies Go's predeclared-identifier rule.
func (t *goTier) IsBuiltin(name string) bool {
	return IsGoBuiltin(name)
}

// goImportPathToDir is the Go half of import-path mapping: a module path plus a
// repository-relative suffix.
//
// Kept separate from the tier's Narrow so the mapping is testable without a database.
func goImportPathToDir(importPath, repoPrefix string) string {
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
	// No module prefix known: a path whose first segment has no dot is in-repo. That is
	// the same rule the go tool uses to tell a module path from a standard one.
	first := normalized
	if slash := strings.IndexByte(normalized, '/'); slash >= 0 {
		first = normalized[:slash]
	}
	if strings.Contains(first, ".") {
		return ""
	}
	return normalized
}

// goPackageDir is the directory that forms a Go package.
func goPackageDir(filePath string) string {
	return filepath.Dir(filePath)
}
