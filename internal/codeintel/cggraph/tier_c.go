package cggraph

// The C and C++ language tier.
//
// C and C++ are the hardest pair in scope, and the reason is structural rather than
// incidental: there is no module system. A program is a set of translation units, and
// what one unit sees of another is decided by the preprocessor — `#include` splices
// another file's text in place. Without running the preprocessor, "what is visible here"
// has no exact answer.
//
// So this tier implements the rules that CAN be decided from the source text, which are
// the ones that prevent the damaging errors:
//
//  1. **Translation-unit locality.** A `static` function, an anonymous-namespace member,
//     and a type defined in a SOURCE file (`.c`/`.cc`/`.cpp`) are private to that unit.
//     Another unit sees them only if it `#include`s the defining file.
//     (Ported from `isStaticCFunction` and `isCppTranslationUnitLocal`.)
//  2. **A header is shared.** A type or function declared in a `.h`/`.hpp` is part of
//     every unit that includes it, so it is visible everywhere.
//  3. **`static` is read from the declaration.** The modifier sits on the declaration, so
//     the tier reads the declaration line rather than any usage.
//
// The rule this prevents, in the reference implementation's own words: on a 2,109-file
// betaflight tree, 145 cross-file calls resolved onto a `static` in another `.c` — a
// function that file's unit defines for itself, which no other unit can name.
//
// NOT implemented, and why each needs the preprocessor or a parser:
//
//   - macro-expanded names           (`cpp-macro-visibility`, 364 lines)
//   - `typedef`/`using` chains       (`cpp-type-aliases`, 698 lines)
//   - namespace composition          (`cpp-namespaces`, 120 lines)
//   - class supertype traversal      (`cpp-supertypes`, 351 lines)
//   - function-pointer dispatch      (`c-fnptr-synthesizer`, 1,384 lines)
//   - `#if`/`#ifdef` feature variants (`c-feature-variants`, 288 lines)
//
// Those are deliberately out of scope. A reference this tier cannot decide stays
// unresolved or carries the ambiguous mark, which is the correct outcome: the alternative
// is a confident edge onto a same-named `static` in an unrelated file.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// cTier implements LanguageTier for C and C++.
//
// One implementation for both because the rule that matters — translation-unit locality
// — is C's, and C++ inherits it unchanged. The differences (namespaces, templates,
// classes) are exactly the parts that need a parser, so they are not attempted.
type cTier struct {
	language string
}

func (t *cTier) Name() string { return t.language }

// cSourceExt matches a file that forms a translation unit.
//
// `.h`/`.hpp` are not here: a header is included into units and owns nothing by itself.
// Objective-C's `.m`/`.mm` are included because they are translation units too, and the
// reference implementation treats them the same way.
var cSourceExt = regexp.MustCompile(`(?i)\.(c|cc|cpp|cxx|c\+\+|m|mm)$`)

// cHeaderExt matches a header.
var cHeaderExt = regexp.MustCompile(`(?i)\.(h|hh|hpp|hxx|h\+\+|ipp|inl)$`)

// cTypeKinds are the kinds that can be translation-unit-local.
var cTypeKinds = map[string]bool{
	"struct": true, "union": true, "enum": true, "class": true,
	"interface": true, "type_alias": true,
}

// Visible applies translation-unit locality.
func (t *cTier) Visible(candidate *Candidate, ref *pendingRef) bool {
	if !isCLanguage(candidate.Language) || !isCLanguage(ref.FromLanguage) {
		return true
	}
	sameFile := normalizeSlash(candidate.FilePath) == normalizeSlash(ref.FromFileName)
	if sameFile {
		return true
	}
	// A header is shared by every unit that includes it.
	if cHeaderExt.MatchString(candidate.FilePath) {
		return true
	}
	// Only a source file can own a private symbol.
	if !cSourceExt.MatchString(candidate.FilePath) {
		return true
	}

	// A `static` function is this unit's alone, unless the referencing file includes the
	// defining file — the hiredis pattern, where `async.c` includes `dict.c`.
	if candidate.Kind == "function" && cFunctionIsStatic(candidate) {
		return cIncludesFile(ref.FromFileName, candidate.FilePath)
	}

	// A type defined in a source file is this unit's too.
	if cTypeKinds[candidate.Kind] {
		return cIncludesFile(ref.FromFileName, candidate.FilePath)
	}

	// A member of an anonymous namespace is this unit's:
	//
	//	namespace { void helper(); }
	//
	// The qualifier check is textual because the extractor records an anonymous namespace
	// under an empty name.
	if cInAnonymousNamespace(candidate) {
		return cIncludesFile(ref.FromFileName, candidate.FilePath)
	}

	return true
}

// Narrow restricts candidates using the file's `#include` directives.
//
// C has no import table in the extracted graph — a `#include` is a preprocessor directive,
// not a binding — so this tier reads the directives from the source. A qualifier in C++
// (`ns::Name`, `Class::method`) is narrowed to the namespace or class it names; a plain C
// reference has no qualifier and is never narrowed here.
func (t *cTier) Narrow(ref *pendingRef, imports map[string]Import, candidates []Candidate) ([]Candidate, bool) {
	if t.language != "cpp" {
		// A C reference is either bare or a struct member; neither is narrowed by an
		// include, because an include brings in names rather than a namespace.
		return candidates, false
	}
	qualifier, _, unqualified := SplitGoQualifiedDoubleColon(ref.Name)
	if unqualified || qualifier == "" {
		return candidates, false
	}
	// A C++ qualifier is a namespace or a class. Both are recorded in a qualified name as
	// a `::` prefix, so narrowing is a prefix test rather than a directory lookup.
	var narrowed []Candidate
	for _, cand := range candidates {
		qn := cand.QualifiedName
		if strings.HasPrefix(qn, qualifier+"::") || strings.Contains(qn, "::"+qualifier+"::") {
			narrowed = append(narrowed, cand)
		}
	}
	if len(narrowed) == 0 {
		// The qualifier names something this tree does not declare under that name — a
		// standard-library or third-party symbol.
		return candidates, false
	}
	return narrowed, true
}

// ReceiverType returns "" — C/C++ receiver inference needs a parser.
func (t *cTier) ReceiverType(ref *pendingRef, file *sourceFile) string { return "" }

// IsBuiltin applies the C/C++ standard-library-name rule.
func (t *cTier) IsBuiltin(name string) bool {
	return cStdlibNames[name]
}

// isCLanguage reports whether a language is C or C++.
func isCLanguage(language string) bool {
	switch language {
	case "c", "cpp", "objc":
		return true
	}
	return false
}

// cFunctionIsStatic reports whether a function's declaration carries `static`.
//
// Read from the declaration line and the one before it: a declaration can wrap
// (`static void\nhelper(...)`), and the modifier always precedes the return type. The
// reference implementation reads the same two lines for the same reason.
//
// The check is on `(^|[\s;}])static\s` so a name containing "static" (`is_static`) does not
// match.
var cStaticRE = regexp.MustCompile(`(^|[\s;}])static\s`)

func cFunctionIsStatic(candidate *Candidate) bool {
	text := readSourceText(candidate.FilePath)
	if text == "" {
		return false
	}
	lines := strings.Split(text, "\n")
	index := candidate.StartLine - 1
	if index < 0 || index >= len(lines) {
		return false
	}
	// The declaration plus its predecessor, for a wrapped modifier.
	head := lines[index]
	if index > 0 {
		head = lines[index-1] + "\n" + head
	}
	return cStaticRE.MatchString(head)
}

// cInAnonymousNamespace reports whether an item is declared inside an anonymous namespace.
//
// The extractor cannot name an anonymous namespace, so an item in one has a qualified name
// with an empty leading segment (`::helper`) or no namespace segment at all. The textual
// check for `namespace {` is what decides.
func cInAnonymousNamespace(candidate *Candidate) bool {
	text := readSourceText(candidate.FilePath)
	if text == "" {
		return false
	}
	lines := strings.Split(text, "\n")
	index := candidate.StartLine - 1
	if index < 0 || index >= len(lines) {
		return false
	}
	// Walk backwards for an unclosed `namespace {`.
	depth := 0
	for i := index; i >= 0; i-- {
		line := lines[i]
		depth += cBraceDelta(line)
		if strings.Contains(line, "namespace") && !strings.Contains(line, "::") {
			// `namespace {` with no name is anonymous.
			rest := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "namespace"))
			if strings.HasPrefix(rest, "{") || rest == "" {
				return depth > 0
			}
		}
	}
	return false
}

// cIncludesFile reports whether `fromFile` includes `targetFile`, directly or through one
// intermediate header.
//
// One hop, not full transitive closure: `a.c` includes `b.h` which includes `c.h` is
// common, and following it makes "is this static function's file reachable" answerable for
// the ordinary layout. Deeper chains are left unresolved rather than guessed.
func cIncludesFile(fromFile, targetFile string) bool {
	if normalizeSlash(fromFile) == normalizeSlash(targetFile) {
		return true
	}
	includes := cIncludeTargets(fromFile)
	target := normalizeSlash(filepath.Base(targetFile))
	targetStem := strings.TrimSuffix(target, filepath.Ext(target))

	for _, include := range includes {
		base := normalizeSlash(filepath.Base(include))
		stem := strings.TrimSuffix(base, filepath.Ext(base))
		if base == target || stem == targetStem {
			return true
		}
	}
	// One hop: does an included header include the target?
	for _, include := range includes {
		headerPath := resolveCInclude(fromFile, include)
		if headerPath == "" {
			continue
		}
		for _, nested := range cIncludeTargets(headerPath) {
			base := normalizeSlash(filepath.Base(nested))
			stem := strings.TrimSuffix(base, filepath.Ext(base))
			if base == target || stem == targetStem {
				return true
			}
		}
	}
	return false
}

// cIncludeRE matches `#include "x.h"` and `#include <x.h>`.
var cIncludeRE = regexp.MustCompile(`(?m)^\s*#\s*include\s*[<"]([^>"]+)[>"]`)

// cIncludeTargets lists the paths a file includes.
func cIncludeTargets(filePath string) []string {
	text := readSourceText(filePath)
	if text == "" {
		return nil
	}
	var out []string
	for _, match := range cIncludeRE.FindAllStringSubmatch(text, -1) {
		out = append(out, match[1])
	}
	return out
}

// resolveCInclude turns an include specifier into a path relative to the including file.
//
// Only the quoted form is resolved: `#include "x.h"` is relative to the including file's
// directory first, while `#include <x.h>` is a system or include-path lookup that this
// tool cannot perform.
func resolveCInclude(fromFile, specifier string) string {
	if specifier == "" {
		return ""
	}
	dir := filepath.Dir(fromFile)
	candidate := filepath.Join(dir, specifier)
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate
	}
	return ""
}

// cBraceDelta is the net brace change across one line, skipping comments and strings.
func cBraceDelta(line string) int {
	delta := 0
	inString := false
	for i := 0; i < len(line); i++ {
		c := line[i]
		if inString {
			if c == '\\' {
				i++
				continue
			}
			if c == '"' {
				inString = false
			}
			continue
		}
		switch {
		case c == '/' && i+1 < len(line) && (line[i+1] == '/' || line[i+1] == '*'):
			return delta
		case c == '"':
			inString = true
		case c == '{':
			delta++
		case c == '}':
			delta--
		}
	}
	return delta
}

// cStdlibNames are the C/C++ standard-library names in scope everywhere.
//
// A reference to one is never a project definition. The list keeps the names that appear
// as bare references and whose collision with a project symbol is plausible — the C
// library's functions, and the C++ standard library's most-used types.
var cStdlibNames = map[string]bool{
	// C library functions.
	"printf": true, "fprintf": true, "sprintf": true, "snprintf": true,
	"malloc": true, "calloc": true, "realloc": true, "free": true,
	"memcpy": true, "memset": true, "memmove": true, "memcmp": true,
	"strlen": true, "strcmp": true, "strncmp": true, "strcpy": true,
	"strncpy": true, "strcat": true, "strchr": true, "strstr": true,
	"strdup": true, "strtol": true, "strtod": true, "atoi": true, "atof": true,
	"fopen": true, "fclose": true, "fread": true, "fwrite": true, "fflush": true,
	"fseek": true, "ftell": true, "fgets": true, "fputs": true, "fputc": true,
	"getenv": true, "setenv": true, "exit": true, "abort": true, "assert": true,
	"qsort": true, "bsearch": true, "rand": true, "srand": true,
	"open": true, "close": true, "read": true, "write": true, "ioctl": true,
	"poll": true, "select": true, "mmap": true, "munmap": true, "fork": true,
	"execve": true, "waitpid": true, "signal": true, "kill": true,
	"pthread_create": true, "pthread_join": true, "pthread_mutex_lock": true,
	"pthread_mutex_unlock": true, "pthread_mutex_init": true,
	"errno": true, "perror": true,
	// Types.
	"size_t": true, "ssize_t": true, "off_t": true, "pid_t": true, "time_t": true,
	"int8_t": true, "int16_t": true, "int32_t": true, "int64_t": true,
	"uint8_t": true, "uint16_t": true, "uint32_t": true, "uint64_t": true,
	"intptr_t": true, "uintptr_t": true, "ptrdiff_t": true, "wchar_t": true,
	"FILE": true, "DIR": true, "va_list": true, "bool": true, "true": true,
	"false": true, "NULL": true,
	// C++ standard library.
	"std": true, "string": true, "vector": true, "map": true, "set": true,
	"unordered_map": true, "unordered_set": true, "deque": true, "queue": true,
	"stack": true, "list": true, "array": true, "pair": true, "tuple": true,
	"optional": true, "variant": true, "function": true, "shared_ptr": true,
	"unique_ptr": true, "weak_ptr": true, "make_shared": true, "make_unique": true,
	"move": true, "forward": true, "swap": true, "cout": true, "cerr": true,
	"cin": true, "endl": true, "string_view": true,
}
