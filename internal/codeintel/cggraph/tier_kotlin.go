package cggraph

// The Kotlin language tier.
//
// Kotlin's scoping is Java's, which is not an accident: it runs on the JVM, compiles to
// the same package/class model, and interoperates with Java's. So the rules ported here
// mirror the Java tier's, with the differences Kotlin actually has:
//
//   - `internal` is module-wide visibility (visible inside the compilation module), which
//     Java has no equivalent of. It is treated as package-and-below, matching the
//     reference implementation's permissive treatment.
//   - `private` on a top-level declaration is FILE-private, not class-private. This is the
//     one rule that differs materially from Java and the one that matters most, because
//     Kotlin files routinely hold several top-level declarations.
//   - A file's package comes from its `package` line, exactly as in Java.
//   - An import can bring in a top-level function, not only a type — so narrowing by
//     import must consider function names too.
//
// Not ported: the reference implementation's Kotlin standard-library chain recognition
// (`isKotlinStdChainTarget`, `isKotlinNumberBitwise`, `isKotlinPreconditionCall`). Those
// suppress specific false positives from `kotlin.*` extension functions; without them this
// tier may bind a stdlib-named reference to a project symbol, but only where the names
// collide.

import (
	"path/filepath"
	"regexp"
	"strings"
)

// kotlinTier implements LanguageTier for Kotlin.
type kotlinTier struct{}

func (t *kotlinTier) Name() string { return "kotlin" }

// Visible applies Kotlin's visibility rule.
func (t *kotlinTier) Visible(candidate *Candidate, ref *pendingRef) bool {
	if candidate.Language != "kotlin" {
		return true
	}
	sameFile := normalizeSlash(candidate.FilePath) == normalizeSlash(ref.FromFileName)

	// `private` on a top-level declaration is file-private; on a class member it is
	// class-private. Both are satisfied by "same file", because a nested member lives in
	// the file that declares its class.
	if candidate.Visibility == "private" {
		return sameFile
	}
	// `internal` and `protected` both reach across the package in practice (internal is
	// module-wide, protected reaches subclasses, which may be in another package).
	if candidate.Visibility == "internal" || candidate.Visibility == "protected" {
		return sameFile || kotlinPackageOf(candidate.FilePath) == kotlinPackageOf(ref.FromFileName)
	}
	if sameFile {
		return true
	}
	return kotlinPackageOf(candidate.FilePath) == kotlinPackageOf(ref.FromFileName)
}

// Narrow restricts candidates using the file's imports.
//
// Kotlin's import forms:
//
//	import a.b.C            a type
//	import a.b.c            a top-level function
//	import a.b.*            everything in a package
//	import a.b.C.D          a nested type
//
// A qualifier that is an import is narrowed to the imported declaration. A wildcard import
// narrows nothing, because the set it brings in is not enumerated here.
func (t *kotlinTier) Narrow(ref *pendingRef, imports map[string]Import, candidates []Candidate) ([]Candidate, bool) {
	qualifier, _, unqualified := SplitGoQualified(ref.Name)
	if unqualified || qualifier == "" {
		return candidates, false
	}
	imported, ok := imports[qualifier]
	if !ok {
		return candidates, false
	}
	if imported.Path == "" || strings.Contains(imported.Path, "*") {
		// A wildcard import names no single declaration.
		return candidates, false
	}
	if strings.HasPrefix(imported.Path, "kotlin.") || strings.HasPrefix(imported.Path, "kotlinx.") ||
		strings.HasPrefix(imported.Path, "java.") || strings.HasPrefix(imported.Path, "javax.") {
		// A stdlib or JDK import: nothing here can be its target.
		return nil, true
	}
	// The imported declaration's simple name is the last `.`-segment; the reference's
	// member must be a member of it.
	simple := imported.Path
	if dot := strings.LastIndexByte(simple, '.'); dot >= 0 {
		simple = simple[dot+1:]
	}
	if simple == "" {
		return candidates, false
	}

	var narrowed []Candidate
	for _, cand := range candidates {
		if cand.Name == simple {
			narrowed = append(narrowed, cand)
		}
	}
	if len(narrowed) == 0 {
		return candidates, false
	}
	return narrowed, true
}

// ReceiverType returns "" — Kotlin receiver inference needs a type checker.
func (t *kotlinTier) ReceiverType(ref *pendingRef, file *sourceFile) string { return "" }

// IsBuiltin applies Kotlin's default-imported names.
func (t *kotlinTier) IsBuiltin(name string) bool { return kotlinDefaults[name] }

var kotlinPackageRE = regexp.MustCompile(`(?m)^\s*package\s+([\w.]+)\s*$`)

// kotlinPackageOf reads a file's package declaration.
func kotlinPackageOf(filePath string) string {
	text := readSourceText(filePath)
	if text != "" {
		if match := kotlinPackageRE.FindStringSubmatch(text); match != nil {
			return strings.ReplaceAll(match[1], ".", "/")
		}
	}
	return normalizeSlash(filepath.Dir(filePath))
}

// kotlinDefaults are the names Kotlin imports into every file.
//
// `kotlin.*`, `kotlin.collections.*`, `kotlin.io.*` and friends are default imports, so
// these names are in scope everywhere without an `import` line — the Kotlin equivalent of
// Java's `java.lang`. The list keeps the names that appear as bare references and whose
// collision with a project symbol is plausible.
var kotlinDefaults = map[string]bool{
	// Types.
	"Any": true, "Nothing": true, "Unit": true, "String": true, "Char": true,
	"Boolean": true, "Byte": true, "Short": true, "Int": true, "Long": true,
	"Float": true, "Double": true, "Number": true, "Array": true,
	"List": true, "MutableList": true, "Set": true, "MutableSet": true,
	"Map": true, "MutableMap": true, "Collection": true, "Iterable": true,
	"Sequence": true, "Pair": true, "Triple": true, "Result": true,
	"Comparable": true, "Enum": true, "Throwable": true, "Exception": true,
	"RuntimeException": true, "IllegalArgumentException": true,
	"IllegalStateException": true, "IndexOutOfBoundsException": true,
	"NullPointerException": true, "UnsupportedOperationException": true,
	"Function": true, "Lazy": true, "Regex": true, "CharSequence": true,
	// Top-level functions.
	"println": true, "print": true, "require": true, "requireNotNull": true,
	"check": true, "checkNotNull": true, "error": true, "TODO": true,
	"listOf": true, "mutableListOf": true, "setOf": true, "mutableSetOf": true,
	"mapOf": true, "mutableMapOf": true, "arrayOf": true, "emptyList": true,
	"emptySet": true, "emptyMap": true, "listOfNotNull": true,
	"lazy": true, "let": true, "run": true, "with": true, "apply": true,
	"also": true, "takeIf": true, "takeUnless": true, "repeat": true,
	"synchronized": true, "measureTimeMillis": true, "runCatching": true,
	// Annotations.
	"Deprecated": true, "Suppress": true, "JvmStatic": true, "JvmField": true,
	"JvmOverloads": true, "JvmName": true, "Throws": true,
}
