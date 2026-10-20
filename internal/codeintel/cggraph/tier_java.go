package cggraph

// The Java language tier.
//
// Rules ported from CodeGraph's `isJavaTypeVisible` (src/resolution/name-matcher.ts) and
// the Java half of its import resolver.
//
// Java's scoping rule is the one that matters and it is simple at the top:
//
//   - a type is reachable if it is in the SAME PACKAGE, or explicitly imported, or
//     qualified by its package on the reference line;
//   - a same-package type needs no import, which is why package is compared rather than
//     the "is it imported" question alone;
//   - `private` members are scoped to their class, `protected`/package-private to the
//     package.
//
// A package is a directory, and the package declaration inside the file is the authority
// — the directory is only a convention. This tier reads the declaration rather than
// trusting the path, because Java projects do place files off-package.
//
// Deliberately NOT ported from the reference's 60-line version: nested-type visibility
// through an owner chain, `new Outer.Inner()` qualifier analysis, and enum-constant
// resolution through `case` labels and static imports. Each of those needs a per-line
// reading of the reference site, and getting them wrong yields a confident wrong answer —
// which the tier contract forbids. Unported cases fall through to the permissive answer,
// so they cost accuracy on nested and enum-constant references, never correctness on the
// common case.

import (
	"path/filepath"
	"regexp"
	"strings"
)

// javaTier implements LanguageTier for Java.
type javaTier struct{}

func (t *javaTier) Name() string { return "java" }

// Visible applies Java's package/member visibility rule.
func (t *javaTier) Visible(candidate *Candidate, ref *pendingRef) bool {
	if candidate.Language != "java" {
		return true
	}
	// A private MEMBER is visible only inside its own class. `private` on a type is
	// unusual (nested types), and is treated the same way: only its own file sees it.
	if candidate.Visibility == "private" {
		return normalizeSlash(candidate.FilePath) == normalizeSlash(ref.FromFileName)
	}
	// Package-private (no modifier) and protected both reach across the package.
	if normalizeSlash(candidate.FilePath) == normalizeSlash(ref.FromFileName) {
		return true
	}
	return javaPackageOf(candidate.FilePath) == javaPackageOf(ref.FromFileName)
}

// Narrow restricts candidates using the file's imports.
func (t *javaTier) Narrow(ref *pendingRef, imports map[string]Import, candidates []Candidate) ([]Candidate, bool) {
	qualifier, _, unqualified := SplitGoQualified(ref.Name)
	if unqualified || qualifier == "" {
		return candidates, false
	}
	// A qualifier is one of three things in Java:
	//
	//	an import's local name   → that type's members
	//	a type name in scope     → its static members (unchanged here)
	//	a package segment        → `java.util.Map`
	//
	// Only the first is a hard narrowing. The second is what a static member call looks
	// like and must not be emptied; the third is a fully-qualified name, which the import
	// table does not describe.
	imported, ok := imports[qualifier]
	if !ok {
		return candidates, false
	}
	if imported.Path == "" || strings.HasPrefix(imported.Path, "java.") ||
		strings.HasPrefix(imported.Path, "javax.") {
		// A JDK import: nothing in this tree can be its target.
		return nil, true
	}
	// `import a.b.C` — the reference `C.member` is C's, so narrow to the file that
	// declares C.
	target := imported.Path
	if slash := strings.LastIndexByte(target, '/'); slash >= 0 {
		target = target[slash+1:]
	}
	if dot := strings.LastIndexByte(target, '.'); dot >= 0 {
		target = target[dot+1:]
	}
	if target == "" {
		return candidates, false
	}

	var narrowed []Candidate
	for _, cand := range candidates {
		if cand.Name == target ||
			strings.HasSuffix(normalizeSlash(candidateFilePath(&cand)), normalizeSlash(imported.Path)+".java") {
			narrowed = append(narrowed, cand)
		}
	}
	if len(narrowed) == 0 {
		return candidates, false
	}
	return narrowed, true
}

// candidateFilePath is a small helper so Narrow reads uniformly.
func candidateFilePath(cand *Candidate) string { return cand.FilePath }

// ReceiverType returns "" — Java receiver inference needs a type checker.
func (t *javaTier) ReceiverType(ref *pendingRef, file *sourceFile) string { return "" }

// IsBuiltin applies Java's language-name rule.
//
// Java has no predeclared function names the way Go and Python do; `System`, `String` and
// the wrapper classes are types from `java.lang`, which is auto-imported. A reference to
// one is never a project definition, so they are listed here for the same reason Go lists
// `len`.
func (t *javaTier) IsBuiltin(name string) bool {
	return javaLangTypes[name]
}

var javaPackageRE = regexp.MustCompile(`(?m)^\s*package\s+([\w.]+)\s*;`)

// javaPackageOf reads a file's package declaration.
//
// The declaration is authoritative: a Java file states its package, and trusting the
// directory instead would be wrong exactly where it matters (a file placed off-package
// compiles fine and is still in the declared package).
//
// The result is the package as a dotted path with slashes, which matches how an import
// path is stored. A file with no declaration is in the default package, whose "name" is
// its directory — two default-package files share a package only if their directories do.
func javaPackageOf(filePath string) string {
	text := readSourceText(filePath)
	if text != "" {
		if match := javaPackageRE.FindStringSubmatch(text); match != nil {
			return strings.ReplaceAll(match[1], ".", "/")
		}
	}
	return normalizeSlash(filepath.Dir(filePath))
}

// readSourceText reads a file, returning "" on failure.
//
// A tiny uncached helper for the tier's visibility check, which runs once per candidate
// rather than once per reference. The per-batch cache in Resolver covers the hot path
// (receiver inference); this one is for the cold path where a failed read must simply
// yield the permissive answer.
func readSourceText(path string) string {
	file := &sourceFile{path: path}
	return file.Text()
}

// javaLangTypes are the `java.lang` types a bare reference resolves to.
//
// `java.lang` is auto-imported, so these names are in scope in every Java file without an
// import — which makes them the Java equivalent of a builtin: a project class sharing one
// of these names would be shadowed by the language's own.
var javaLangTypes = map[string]bool{
	"Object": true, "String": true, "Class": true, "System": true, "Math": true,
	"Integer": true, "Long": true, "Double": true, "Float": true, "Short": true,
	"Byte": true, "Boolean": true, "Character": true, "Number": true, "Void": true,
	"StringBuilder": true, "StringBuffer": true, "CharSequence": true,
	"Exception": true, "RuntimeException": true, "Error": true, "Throwable": true,
	"IllegalArgumentException": true, "IllegalStateException": true,
	"NullPointerException": true, "UnsupportedOperationException": true,
	"IndexOutOfBoundsException": true, "ClassCastException": true,
	"ArithmeticException": true, "InterruptedException": true,
	"Thread": true, "Runnable": true, "Iterable": true, "Comparable": true,
	"Cloneable": true, "AutoCloseable": true, "Enum": true, "Record": true,
	"Iterator": true, "Deprecated": true, "Override": true, "SuppressWarnings": true,
	"FunctionalInterface": true, "SafeVarargs": true,
}
