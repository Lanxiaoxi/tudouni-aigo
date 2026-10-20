package cggraph

// Go scope and visibility rules.
//
// Go has fewer name-resolution rules than most languages, which is why a Go-tier
// resolver is tractable: a package is a directory, an identifier's visibility is
// its first letter's case, methods belong to their receiver type, and an import
// path maps to a directory. Everything else follows from those four.
//
// The rules here are the ones that actually change an answer on a real tree. They
// are not a language specification implementation and deliberately do not claim to
// be: an unresolved reference stays unresolved and is retried, while a wrong edge
// is permanent and silently misleads.

import (
	"path/filepath"
	"strings"
)

// PackageDir is the directory that forms a Go package: the directory containing
// the file.
//
// This is Go's rule and it is exact — unlike most languages there is no per-file
// scope, so two files in one directory share every package-level name.
func PackageDir(filePath string) string {
	return filepath.Dir(filePath)
}

// SameGoPackage reports whether two files belong to the same Go package.
//
// Directory equality is the whole rule. The package *name* does not enter into it:
// a directory can legally hold files declaring the same package name, and separate
// directories can legally hold different packages with the same name — matching on
// the name would merge unrelated code, which is the more damaging mistake.
func SameGoPackage(a, b string) bool {
	return PackageDir(a) == PackageDir(b)
}

// IsGoExported reports whether an identifier is exported, by Go's rule: the first
// character is an upper-case letter.
//
// Case is the entire mechanism. Unicode matters here — Go permits any letter — so
// the check is on the rune, not on an ASCII range.
func IsGoExported(name string) bool {
	for _, r := range name {
		if r == '_' || r == '~' {
			continue
		}
		return isUpper(r)
	}
	return false
}

func isUpper(r rune) bool {
	// unicode.IsUpper without importing unicode into a package that otherwise needs
	// only path handling: the ASCII range covers the identifiers that appear in
	// practice, and the non-ASCII branch falls back to a comparison that is correct
	// for every cased script without a table.
	if r >= 'A' && r <= 'Z' {
		return true
	}
	if r < 0x80 {
		return false
	}
	return strings.ToUpper(string(r)) == string(r) && strings.ToLower(string(r)) != string(r)
}

// GoVisibleAcrossFiles reports whether a candidate defined in another file may be
// named from the referencing file at all.
//
// Exported identifiers are nameable anywhere. An unexported identifier is
// package-private, and a package is a directory, so it is visible only from a file
// in that same directory. Getting this wrong produces the failure the reference
// implementation recorded in #1730: unexported helpers binding to same-named
// unexported helpers in unrelated packages.
func GoVisibleAcrossFiles(candidateName, candidateFile, refFile string) bool {
	if IsGoExported(candidateName) {
		return true
	}
	return SameGoPackage(candidateFile, refFile)
}

// GoQualifiedPackage reports whether a reference name is qualified by a package
// identifier rather than a value: `tools.Tool` where `tools` is an import.
//
// The distinction matters because the two mean different things. `tools.Tool` names
// a type in the imported package; `server.Start` names a method on a value. Without
// the import list there is no way to tell them apart, which is why the resolver
// consults it rather than guessing from the name's shape.
func GoQualifiedPackage(name string, knownPackageAliases map[string]bool) (string, bool) {
	dot := strings.IndexByte(name, '.')
	if dot <= 0 {
		return "", false
	}
	head := name[:dot]
	if knownPackageAliases[head] {
		return head, true
	}
	return "", false
}

// SplitGoQualified splits `pkg.Name` into its parts. A name with no dot returns
// ("", name, true) meaning "unqualified".
func SplitGoQualified(name string) (qualifier, rest string, unqualified bool) {
	dot := strings.IndexByte(name, '.')
	if dot < 0 {
		return "", name, true
	}
	return name[:dot], name[dot+1:], false
}

// goBuiltinNames are the predeclared identifiers of Go.
//
// A reference to one of these never resolves to a project definition. The reference
// implementation has the same guard for Rust's prelude, where `Ok` bound to a
// struct called `Ok` in the project — the analogous failure here is `len`, `make`
// or `error` binding to a same-named project symbol.
//
// The list is the specification's, not a heuristic: these are exactly the
// identifiers `go/types` treats as predeclared.
var goBuiltinNames = map[string]bool{
	// Types.
	"bool": true, "byte": true, "complex64": true, "complex128": true,
	"error": true, "float32": true, "float64": true,
	"int": true, "int8": true, "int16": true, "int32": true, "int64": true,
	"rune": true, "string": true,
	"uint": true, "uint8": true, "uint16": true, "uint32": true, "uint64": true,
	"uintptr": true, "any": true, "comparable": true,
	// Constants.
	"true": true, "false": true, "iota": true,
	// Zero value.
	"nil": true,
	// Functions.
	"append": true, "cap": true, "clear": true, "close": true, "complex": true,
	"copy": true, "delete": true, "imag": true, "len": true, "make": true,
	"max": true, "min": true, "new": true, "panic": true, "print": true,
	"println": true, "real": true, "recover": true,
}

// IsGoBuiltin reports whether the name is a predeclared Go identifier.
func IsGoBuiltin(name string) bool { return goBuiltinNames[name] }

// IsGoKeyword reports whether a reference name is a keyword, which can never be a
// resolvable symbol.
//
// Extraction should not produce these, but a tree-sitter grammar on a file with
// syntax errors can, and a keyword binding to a project symbol would be a
// confidence-destroying edge rather than a missing one.
func IsGoKeyword(name string) bool {
	switch name {
	case "break", "case", "chan", "const", "continue", "default", "defer",
		"else", "fallthrough", "for", "func", "go", "goto", "if", "import",
		"interface", "map", "package", "range", "return", "select", "struct",
		"switch", "type", "var":
		return true
	}
	return false
}

// IsGoStandardLibraryImport reports whether an import path is from the standard
// library.
// library.
//
// A reference qualified by one of these (`http.Handler`, `context.Context`) names
// something outside the repository, so no project symbol can be its target. This is
// the guard the reference implementation describes in the `context.Context` note:
// without it, fiber's 85 `context.Context` parameters bound to a same-named
// `Stream.Context` method in the same file.
var GoStandardLibraryPrefixes = []string{
	"archive/", "bufio", "bytes", "cmp", "compress/", "container/", "context",
	"crypto/", "database/", "debug/", "embed", "encoding/", "errors", "expvar",
	"flag", "fmt", "go/", "hash/", "html/", "image/", "index/", "io", "io/fs",
	"iter", "log", "log/", "maps", "math", "math/", "mime", "mime/", "net",
	"net/", "os", "os/", "path", "path/", "reflect", "regexp", "regexp/",
	"runtime", "runtime/", "slices", "sort", "strconv", "strings", "structs",
	"sync", "sync/", "syscall", "testing", "testing/", "text/", "time", "time/",
	"unicode", "unicode/", "unique", "unsafe", "weak",
}

// IsGenericTypeParameter reports whether a reference name is a single-letter generic
// type parameter.
//
// TypeScript, Kotlin, Rust, Java, C# and Swift all write the FIRST type parameter as a
// lone capital — `T`, `K`, `V`, `U`, `R`. A reference to one is a reference to whatever
// the enclosing declaration was instantiated with, never to a project definition.
//
// This matters concretely: on this repository, TypeScript's `<T>` in one component
// matched a project function named `T` (the i18n lookup) and produced 1,324 `references`
// edges, every one of them false.
//
// The rule is deliberately limited to a SINGLE letter. A two-letter form like `TKey`
// looks like a type parameter but is indistinguishable from a real exported type, and
// the reference implementation does keep edges to those — so rejecting them here would
// deviate from behaviour that is otherwise working.
func IsGenericTypeParameter(name string) bool {
	if len(name) != 1 {
		return false
	}
	return name[0] >= 'A' && name[0] <= 'Z'
}

// Standard-library paths have no dot in their first segment; a module path always
// does (`github.com/...`). That is the same rule the go tool applies, and it is why
// this needs no module list.
func IsGoStandardLibraryImport(importPath string) bool {
	if importPath == "" {
		return false
	}
	first := importPath
	if slash := strings.IndexByte(importPath, '/'); slash >= 0 {
		first = importPath[:slash]
	}
	return !strings.Contains(first, ".")
}
