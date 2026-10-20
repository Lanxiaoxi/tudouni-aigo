package cggraph

// The Rust language tier.
//
// Rules ported from CodeGraph's Rust handling:
//
//	name-matcher.ts   isRustItemVisibleFrom    the module visibility rule
//	name-matcher.ts   rustModuleDir/Name       file → module mapping
//	name-matcher.ts   isRustNameInScope        prelude and variant rules
//	import-resolver.ts resolveRustPathReference / collectRustUseBindings
//
// Rust's visibility is the interesting part, and it is simpler than it looks: a non-`pub`
// item is visible to its own module and the modules INSIDE it, never to a sibling module
// or another crate. A `mod.rs`, `lib.rs` or `main.rs` IS its directory's module; any other
// file is a child module of its directory, named after the file.
//
//	// src/build/patch.rs declares `type Result` with no pub
//	src/build/patch.rs        ← sees it (own module)
//	src/build/patch/sub.rs    ← sees it (module inside it)
//	src/other.rs              ← does not
//
// The prelude rule matters for the same reason Go's builtin rule does: `Ok`, `Result`,
// `Some`, `None` and `Box` are the prelude's unless the file defines or imports a project
// item of that name. A `struct Ok` in a test module is legal Rust, and without this check
// every `Ok(...)` in the tree binds to it.

import (
	"path/filepath"
	"strings"
)

// rustTier implements LanguageTier for Rust.
type rustTier struct{}

func (t *rustTier) Name() string { return "rust" }

// rustModuleItemKinds are the node kinds whose `pub` decides visibility.
//
// A method inside an `impl` carries no `pub` of its own — the trait or the impl decides —
// so methods are excluded here; the reference implementation makes the same exclusion.
var rustModuleItemKinds = map[string]bool{
	"function": true, "struct": true, "enum": true, "union": true,
	"type_alias": true, "trait": true, "constant": true, "variable": true,
}

// Visible applies Rust's module-visibility rule.
func (t *rustTier) Visible(candidate *Candidate, ref *pendingRef) bool {
	if candidate.Language != "rust" {
		return true
	}
	// Only a PRIVATE item is scoped. `pub`, `pub(crate)`, `pub(super)` and `pub(in path)`
	// all widen it beyond the module, and this tier treats them as visible — the
	// distinction between them is a second-order rule that the reference implementation
	// also does not make for bare-name binding.
	if candidate.Visibility != "private" {
		return true
	}
	if !rustModuleItemKinds[candidate.Kind] {
		return true
	}
	// Visible in its own module and the modules inside it.
	if normalizeSlash(candidate.FilePath) == normalizeSlash(ref.FromFileName) {
		return true
	}
	dir := rustModuleDir(candidate.FilePath)
	return strings.HasPrefix(normalizeSlash(ref.FromFileName), normalizeSlash(dir)+"/")
}

// rustModuleDir maps a file to the directory that is its module.
//
// `mod.rs`, `lib.rs` and `main.rs` are their directory. Any other file is a child module
// named after it, so its "module directory" is that name appended to the directory —
// which is what makes `src/build/patch.rs` cover `src/build/patch/*.rs` and nothing else
// in `src/build/`.
func rustModuleDir(filePath string) string {
	normalized := strings.ReplaceAll(filePath, "\\", "/")
	base := normalized
	if slash := strings.LastIndexByte(normalized, '/'); slash >= 0 {
		base = normalized[slash+1:]
	}
	dir := normalized[:len(normalized)-len(base)]
	dir = strings.TrimSuffix(dir, "/")

	switch base {
	case "mod.rs", "lib.rs", "main.rs":
		return dir
	}
	stem := strings.TrimSuffix(base, ".rs")
	if dir == "" {
		return stem
	}
	return dir + "/" + stem
}

// Narrow restricts candidates using the file's `use` declarations.
//
// Rust has three path roots that mean something relative to the current module —
// `crate::`, `self::`, `super::` — and one that names another crate. A qualified
// reference starting with `crate`/`self`/`super` is narrowed by resolving the module path
// to a directory; any other single-segment qualifier is a type, not a module, and is left
// alone.
func (t *rustTier) Narrow(ref *pendingRef, imports map[string]Import, candidates []Candidate) ([]Candidate, bool) {
	qualifier, rest, unqualified := SplitGoQualifiedDoubleColon(ref.Name)
	if unqualified || qualifier == "" {
		return candidates, false
	}
	_ = rest

	var dir string
	switch qualifier {
	case "crate":
		// `crate::a::b::Name` — relative to the crate root, which is the directory
		// containing `src/`.
		dir = rustCrateRoot(ref.FromFileName)
	case "self":
		dir = rustModuleDir(ref.FromFileName)
	case "super":
		// The parent module: one level up from this file's module directory.
		dir = rustModuleDir(ref.FromFileName)
		if slash := strings.LastIndexByte(dir, '/'); slash >= 0 {
			dir = dir[:slash]
		} else {
			dir = ""
		}
	default:
		// An imported module, or a type. An import of a module narrows; anything else
		// (`Widget::new` where Widget is a struct) does not, which is why the reference
		// implementation checks that the prefix is a real module path before narrowing.
		imported, ok := imports[qualifier]
		if !ok || imported.Path == "" {
			return candidates, false
		}
		dir = rustImportPathToDir(imported.Path)
	}
	if dir == "" {
		return candidates, false
	}

	var narrowed []Candidate
	for _, cand := range candidates {
		if strings.HasPrefix(normalizeSlash(cand.FilePath), normalizeSlash(dir)) {
			narrowed = append(narrowed, cand)
		}
	}
	// A path that matches nothing is a reference to another crate (`clap::Command`), which
	// this tree does not contain.
	return narrowed, true
}

// rustCrateRoot returns the directory that holds the crate's modules.
//
// A crate root is the directory containing `src/lib.rs` / `src/main.rs`, so a file at
// `src/runtime/task/mod.rs` has the crate root `src`. Without a `src` directory the
// repository root is the crate root.
func rustCrateRoot(filePath string) string {
	normalized := strings.ReplaceAll(filePath, "\\", "/")
	if index := strings.Index(normalized, "src/"); index >= 0 {
		return normalized[:index] + "src"
	}
	return ""
}

// rustImportPathToDir maps a `use` path onto a directory prefix.
//
// A Rust use path is a module path, not a file path: `use crate::runtime::task` names
// `src/runtime/task/mod.rs` or `src/runtime/task.rs`. Matching on the path's tail keeps
// this independent of where the crate root sits.
func rustImportPathToDir(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	normalized := strings.ReplaceAll(path, "::", "/")
	normalized = strings.TrimPrefix(normalized, "crate/")
	return normalized
}

// ReceiverType infers the type of `self`, which is the enclosing impl's type.
//
// `self.method()` inside an `impl Foo` must resolve on `Foo`. This is the one receiver
// inference Rust needs and the one that pays, mirroring Python's `self` rule.
func (t *rustTier) ReceiverType(ref *pendingRef, file *sourceFile) string {
	receiver, method, isCall := splitReceiverCall(ref.Name)
	if !isCall || method == "" {
		return ""
	}
	// Rust uses `::` for associated functions and `.` for method calls; only the latter
	// has a receiver whose type could be `self`.
	if receiver != "self" {
		return ""
	}
	implType, ok := enclosingRustImpl(file.Text(), ref.Line)
	if !ok {
		return ""
	}
	return implType
}

// IsBuiltin applies Rust's prelude rule.
func (t *rustTier) IsBuiltin(name string) bool {
	return rustPrelude[name]
}

// enclosingRustImpl finds the `impl Type` block containing `line`.
//
// Text scanning rather than parsing, and bracket-counting rather than indentation:
// Rust's blocks are brace-delimited, so depth is cheap and exact. The innermost open
// `impl` at the line wins, which handles a nested `impl` inside a function body.
func enclosingRustImpl(text string, line int) (string, bool) {
	if text == "" || line <= 0 {
		return "", false
	}
	lines := strings.Split(text, "\n")
	if line > len(lines) {
		line = len(lines)
	}

	// Walk backwards for the nearest `impl ... {` that is still open at `line`.
	for i := line - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		typeName, ok := parseRustImplHeader(trimmed)
		if !ok {
			continue
		}
		if rustBraceDepthAt(lines, i, line-1) > 0 {
			return typeName, true
		}
	}
	return "", false
}

// parseRustImplHeader extracts the type from `impl Foo {`, `impl<T> Foo<T> {`,
// `impl Trait for Foo {` and `unsafe impl Send for Foo {`.
func parseRustImplHeader(line string) (string, bool) {
	if !strings.Contains(line, "impl") {
		return "", false
	}
	rest := line
	if index := strings.Index(rest, "impl"); index >= 0 {
		rest = rest[index+len("impl"):]
	}
	rest = strings.TrimSpace(rest)

	// Skip generic parameters: `impl<T: Clone> Foo<T>` → `Foo<T>`.
	if strings.HasPrefix(rest, "<") {
		depth := 0
		for i := 0; i < len(rest); i++ {
			switch rest[i] {
			case '<':
				depth++
			case '>':
				depth--
				if depth == 0 {
					rest = strings.TrimSpace(rest[i+1:])
					i = len(rest)
				}
			}
		}
	}

	// `Trait for Foo` → take what follows `for`.
	if index := strings.Index(rest, " for "); index >= 0 {
		rest = strings.TrimSpace(rest[index+len(" for "):])
	}

	// The type name is up to the first of `{`, `<`, whitespace or `where`.
	end := len(rest)
	for i := 0; i < len(rest); i++ {
		c := rest[i]
		if c == '{' || c == '<' || c == ' ' || c == '\t' {
			end = i
			break
		}
	}
	name := strings.TrimSpace(rest[:end])
	if name == "" {
		return "", false
	}
	// A path-qualified type keeps its last segment, which is how a qualified name is
	// composed elsewhere in this package.
	if index := strings.LastIndex(name, "::"); index >= 0 {
		name = name[index+2:]
	}
	return name, true
}

// rustBraceDepthAt reports the brace depth at `target`, counting from `start`.
//
// A positive depth means the block opened at `start` is still open, which is what makes
// "is this line inside that impl" a question with an exact answer.
func rustBraceDepthAt(lines []string, start, target int) int {
	depth := 0
	for i := start; i <= target && i < len(lines); i++ {
		depth += rustBraceDelta(lines[i])
	}
	return depth
}

// rustBraceDelta is the net brace change across one line, skipping string literals and
// line comments.
func rustBraceDelta(line string) int {
	delta := 0
	inString := false
	inChar := false
	i := 0
	for i < len(line) {
		c := line[i]
		if inString {
			if c == '\\' {
				i += 2
				continue
			}
			if c == '"' {
				inString = false
			}
			i++
			continue
		}
		if inChar {
			if c == '\\' {
				i += 2
				continue
			}
			if c == '\'' {
				inChar = false
			}
			i++
			continue
		}
		switch {
		case c == '/' && i+1 < len(line) && line[i+1] == '/':
			return delta
		case c == '"':
			inString = true
		case c == '\'':
			// A lifetime (`'a`) is not a char literal; only a `'x'` shape is.
			if i+2 < len(line) && (line[i+2] == '\'' || (line[i+1] == '\\')) {
				inChar = true
			}
		case c == '{':
			delta++
		case c == '}':
			delta--
		}
		i++
	}
	return delta
}

// rustPrelude is Rust's prelude.
//
// A reference to one of these is the prelude's unless the file defines or imports a
// project item of that name. The reference implementation records the concrete failure
// this prevents: ripgrep's every `Some(x)` bound to its `EncodingMode::Some` variant and
// every `Ok(x)` to `ParseResult::Ok`.
var rustPrelude = map[string]bool{
	"Ok": true, "Err": true, "Some": true, "None": true, "Result": true, "Option": true,
	"Box": true, "Vec": true, "String": true, "str": true, "bool": true,
	"i8": true, "i16": true, "i32": true, "i64": true, "i128": true, "isize": true,
	"u8": true, "u16": true, "u32": true, "u64": true, "u128": true, "usize": true,
	"f32": true, "f64": true, "char": true,
	"Copy": true, "Clone": true, "Debug": true, "Default": true, "Eq": true,
	"PartialEq": true, "Ord": true, "PartialOrd": true, "Hash": true,
	"Send": true, "Sync": true, "Sized": true, "Drop": true, "Fn": true,
	"FnMut": true, "FnOnce": true, "Iterator": true, "IntoIterator": true,
	"From": true, "Into": true, "TryFrom": true, "TryInto": true, "AsRef": true,
	"AsMut": true, "ToOwned": true, "ToString": true,
	"Self": true, "self": true, "super": true, "crate": true,
}

// SplitGoQualifiedDoubleColon splits `a::b::C` at the FIRST `::`.
//
// Rust paths nest to the left (`crate::runtime::task::spawn`), so the first segment is the
// root and the rest is the path inside it — the opposite of `SplitGoQualified`'s
// last-dot rule, which exists for member access rather than module paths.
func SplitGoQualifiedDoubleColon(name string) (root, rest string, unqualified bool) {
	index := strings.Index(name, "::")
	if index < 0 {
		return "", name, true
	}
	return name[:index], name[index+2:], false
}

var _ = filepath.Dir
