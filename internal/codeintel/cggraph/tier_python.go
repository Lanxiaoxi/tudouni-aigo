package cggraph

// The Python language tier.
//
// Rules ported from CodeGraph's Python handling:
//
//	import-resolver.ts  findPythonModuleFile      dotted module → file
//	import-resolver.ts  extractPythonImports      the import table's shape
//	name-matcher.ts     pythonLocalType / pythonMembers / pythonRefClass
//	                    (receiver-typed method resolution)
//
// The rules that matter, in the order the resolver applies them:
//
//  1. **A module is a file, a package is a directory with `__init__.py`.** `a.b.c`
//     maps to `a/b/c.py`, or `a/b/c/__init__.py` for a package.
//  2. **`from x import y` binds `y` in the local scope.** So a name is reachable if it
//     was imported, or defined in the same module, or a builtin.
//  3. **Underscore prefix is private by convention**, and the reference implementation
//     honours it for cross-module binding.
//  4. **`self.m` resolves on the enclosing class**, which requires knowing which class
//     a reference sits inside — decided by line range.
//
// Python is the second tier on purpose: its rule set is the smallest of the languages in
// scope (22 language branches in the reference's name-matcher, against Go's 46), so it is
// the cheapest way to find out whether the tier interface is the right shape.
//
// NOT ported, and why:
//
//   - `pythonRefClass`'s namespace-module handling (`import a.b` then `a.b.Cls`), which
//     needs the import-mapping layer's rich `ImportMapping` shape. This tier keeps the
//     dotted-path form.
//   - Local-type inference from assignments and annotations (`x = Foo()`, `x: Foo`).
//     `self.m` is inferred, because it is the dominant case; a local variable's type is
//     not, so such a reference falls to unique-or-drop rather than guessing.

import (
	"path/filepath"
	"strings"
)

// pythonTier implements LanguageTier for Python.
type pythonTier struct {
	// repoPrefix is the module path, unused by the current rules but kept so the tier
	// can honour import roots when a future rule needs them.
	repoPrefix string
}

func (t *pythonTier) Name() string { return "python" }

// Visible applies Python's module-boundary rule.
//
// Python has no `export` keyword: every module-level name is importable, and the
// convention is that a leading underscore means "internal". The reference implementation
// honours that convention for cross-module binding, so `_helper` defined in one module is
// not a candidate for a reference in another.
//
// Dunder names (`__init__`, `__str__`) are the exception the convention makes explicit:
// they are protocol hooks the language itself calls across modules, so they stay visible.
func (t *pythonTier) Visible(candidate *Candidate, ref *pendingRef) bool {
	if pythonSameModule(candidate.FilePath, ref.FromFileName) {
		return true
	}
	name := candidate.Name
	if strings.HasPrefix(name, "__") && strings.HasSuffix(name, "__") {
		return true
	}
	if strings.HasPrefix(name, "_") {
		return false
	}
	return true
}

// pythonSameModule reports whether two files are the SAME module.
//
// A module is one file, not one directory: `pkg/a.py` and `pkg/b.py` share a package but
// are different modules, and an underscore-prefixed name in one is not visible from the
// other. An earlier version compared directories, which made every module in a package
// look like the same scope and silently disabled the private-name rule.
//
// The one deliberate widening: a package's `__init__.py` counts as the same module as
// its children, because it is where a package re-exports them (`from .a import helper`),
// so a private name reached through the package's own surface stays reachable.
func pythonSameModule(a, b string) bool {
	na := normalizeSlash(a)
	nb := normalizeSlash(b)
	if na == nb {
		return true
	}
	dirA := normalizeSlash(filepath.Dir(a))
	dirB := normalizeSlash(filepath.Dir(b))
	if dirA != dirB {
		return false
	}
	return strings.HasSuffix(na, "/__init__.py") || strings.HasSuffix(nb, "/__init__.py")
}

// Narrow restricts candidates using the file's imports.
//
// Python's import forms, and what each means for a qualified reference:
//
//	import a.b.c          binds `a`          → `a.b.c.X` is reachable through it
//	from a.b import c     binds `c`          → `c` and `c.X` are reachable
//	from . import c       binds `c` (relative)
//
// The distinction that matters: a reference `c.X` where `c` is bound by `from a.b
// import c` means "the thing named c, then a member of it" — and `c` may be a module or
// a class. Without a richer binding model the tier keeps both readings available by
// narrowing on the import's TARGET path rather than on the local name alone.
func (t *pythonTier) Narrow(ref *pendingRef, imports map[string]Import, candidates []Candidate) ([]Candidate, bool) {
	qualifier, _, unqualified := SplitGoQualified(ref.Name)
	if unqualified || qualifier == "" {
		return candidates, false
	}

	// The qualifier is a local name bound by an import. Look it up by its local name;
	// `Import.LocalName` already handles the `from a.b import c` case by storing `c`.
	imported, ok := imports[qualifier]
	if !ok {
		// The qualifier is a local variable, a class name in this module, or `self`.
		// None of those is narrowed here: receiver inference handles `self`, and a
		// same-module class is already visible.
		return candidates, false
	}
	if imported.Path == "" {
		return candidates, false
	}

	// Keep the candidates whose file is the module the import names, or lives inside that
	// package. A dotted module (`a.b.c`) is a file; a package (`a.b`) holds the module's
	// own definitions in `__init__.py` and re-exports its children.
	dir := pythonModuleDir(imported.Path)
	if dir == "" {
		// A relative import (`.`, `..`) has no fixed path to match against, and a
		// stdlib or third-party module has no directory in this tree. Either way, no
		// narrowing is possible — and returning "narrowed to nothing" would claim the
		// reference cannot resolve, which is wrong for a relative import.
		return candidates, false
	}

	var narrowed []Candidate
	for _, cand := range candidates {
		if pythonInModuleDir(cand.FilePath, dir) {
			narrowed = append(narrowed, cand)
		}
	}
	return narrowed, true
}

// pythonModuleDir turns a dotted module path into a repository-relative directory prefix.
//
//	`app.api.routes` → `app/api/routes`
//	`app.api`        → `app/api`
//
// A leading dot means a relative import, which has no fixed prefix. An absolute import
// naming a third-party package (`requests`) also has no directory here; the caller
// distinguishes the two by whether any candidate matched.
func pythonModuleDir(modulePath string) string {
	path := strings.TrimSpace(modulePath)
	if path == "" || strings.HasPrefix(path, ".") {
		return ""
	}
	return strings.ReplaceAll(path, ".", "/")
}

// pythonInModuleDir reports whether a file belongs to the module the dotted path names.
//
// Both shapes count: `app/api/routes.py` (a module) and `app/api/routes/__init__.py`
// (a package). The suffix comparison is what lets this work without knowing the
// repository root, matching the reference implementation's `endsWith` helper.
func pythonInModuleDir(filePath, moduleDir string) bool {
	normalized := normalizeSlash(filePath)
	want := normalizeSlash(moduleDir)

	if normalized == want+".py" || strings.HasSuffix(normalized, "/"+want+".py") {
		return true
	}
	if normalized == want+"/__init__.py" || strings.HasSuffix(normalized, "/"+want+"/__init__.py") {
		return true
	}
	// A name defined inside the package's own modules is reachable through the package
	// only if `__init__.py` re-exports it, which this tier cannot see. Staying out of
	// that guess is intentional: `from a.b import c` where c lives in `a/b/d.py` is a
	// re-export, and the reference implementation resolves it by walking the package's
	// `__init__`, not by matching the directory.
	return false
}

// ReceiverType infers the type of `self`, which is the enclosing class.
//
// This is the one receiver inference Python needs and the one that pays: `self.foo()`
// inside a class must resolve on that class, and there is exactly one enclosing class at
// any line — the reference implementation finds it by line range
// (`startLine <= ref.line && endLine >= ref.line`, innermost win).
//
// A receiver other than `self`/`cls` is not inferred. `x.foo()` needs the type of `x`,
// which needs assignment and annotation tracking; guessing it would break the rule that
// this tier never returns a confident wrong answer.
func (t *pythonTier) ReceiverType(ref *pendingRef, file *sourceFile) string {
	receiver, method, isCall := splitReceiverCall(ref.Name)
	if !isCall || method == "" {
		return ""
	}
	// `self`/`cls` are the implicit-instance and implicit-class receivers.
	if receiver != "self" && receiver != "cls" {
		return ""
	}
	className, ok := enclosingPythonClass(file.Text(), ref.Line)
	if !ok {
		return ""
	}
	// `cls` on a classmethod is the class itself; `self` is an instance of it. Both
	// resolve methods on the same type, so the class name is the answer either way.
	return className
}

// IsBuiltin applies Python's builtin-name rule.
func (t *pythonTier) IsBuiltin(name string) bool {
	return pythonBuiltins[name]
}

// enclosingPythonClass finds the innermost class whose body contains `line`.
//
// A line scanner, not a parser, for the same reason the rest of this tool is: it must
// work on any Python file without a compiler, and being one class wrong costs a narrowed
// candidate set that scoring still handles.
//
// Indentation is what decides the class body's extent, since Python has no closing brace.
// The function walks from the class line forward while indentation stays deeper than the
// class keyword's own.
func enclosingPythonClass(text string, line int) (string, bool) {
	if text == "" || line <= 0 {
		return "", false
	}
	lines := strings.Split(text, "\n")
	if line > len(lines) {
		line = len(lines)
	}

	// Walk backwards for the nearest `class X` at any indentation, then confirm `line`
	// is inside it. Backwards because the innermost class is the closest preceding
	// declaration; a nested class correctly wins over its parent.
	for i := line - 1; i >= 0; i-- {
		raw := lines[i]
		trimmed := strings.TrimLeft(raw, " \t")
		if !strings.HasPrefix(trimmed, "class ") {
			continue
		}
		name := pythonClassName(trimmed)
		if name == "" {
			continue
		}
		indent := len(raw) - len(trimmed)
		if pythonLineInsideBlock(lines, i, line-1, indent) {
			return name, true
		}
	}
	return "", false
}

// pythonClassName extracts `X` from `class X(Base):` / `class X:`.
func pythonClassName(decl string) string {
	rest := strings.TrimPrefix(decl, "class ")
	end := 0
	for end < len(rest) {
		c := rest[end]
		if c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (end > 0 && c >= '0' && c <= '9') {
			end++
			continue
		}
		break
	}
	return rest[:end]
}

// pythonLineInsideBlock reports whether `target` (0-based) is still inside the block that
// opens at `start` (0-based) with the given indentation.
//
// A blank line does not end a block; the first non-blank line at or below the block's own
// indentation does.
func pythonLineInsideBlock(lines []string, start, target, indent int) bool {
	for i := start + 1; i <= target && i < len(lines); i++ {
		raw := lines[i]
		trimmed := strings.TrimLeft(raw, " \t")
		if trimmed == "" {
			continue
		}
		if len(raw)-len(trimmed) <= indent {
			return false
		}
	}
	return target > start
}

// pythonBuiltins are Python's builtin names.
//
// A reference to one never resolves to a project definition. The list is the builtin
// namespace's, restricted to the names that appear as bare references in real code: the
// full set includes every exception class, which this table keeps only where a
// same-named project symbol is plausible.
var pythonBuiltins = map[string]bool{
	// Types and constructors.
	"int": true, "float": true, "complex": true, "bool": true, "str": true,
	"bytes": true, "bytearray": true, "list": true, "tuple": true, "dict": true,
	"set": true, "frozenset": true, "object": true, "type": true, "slice": true,
	"range": true, "memoryview": true, "property": true, "classmethod": true,
	"staticmethod": true, "super": true, "enumerate": true, "zip": true,
	"map": true, "filter": true, "reversed": true, "sorted": true, "iter": true,
	"next": true, "aiter": true, "anext": true, "all": true, "any": true,
	// Functions.
	"print": true, "len": true, "abs": true, "min": true, "max": true, "sum": true,
	"round": true, "pow": true, "divmod": true, "repr": true, "hash": true,
	"id": true, "dir": true, "vars": true, "getattr": true, "setattr": true,
	"delattr": true, "hasattr": true, "callable": true, "isinstance": true,
	"issubclass": true, "format": true, "ascii": true, "bin": true, "oct": true,
	"hex": true, "chr": true, "ord": true, "open": true, "input": true,
	"exec": true, "eval": true, "compile": true, "globals": true, "locals": true,
	"breakpoint": true,
	// Names and exceptions a bare reference actually uses.
	"None": true, "True": true, "False": true, "NotImplemented": true,
	"Ellipsis": true, "__name__": true, "__file__": true, "__doc__": true,
	"Exception": true, "BaseException": true, "ValueError": true, "TypeError": true,
	"KeyError": true, "IndexError": true, "AttributeError": true,
	"RuntimeError": true, "StopIteration": true, "OSError": true, "IOError": true,
	"NotImplementedError": true, "AssertionError": true, "ImportError": true,
}
