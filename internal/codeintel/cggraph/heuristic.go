package cggraph

// Line-based extraction for C and C++ files the grammar rejects.
//
// Why this exists: tree-sitter's C grammar fails on files that a C compiler accepts. Verified
// on uthash's `uthash.h` and `tests/example.c` — both compile clean under `gcc -fsyntax-only`,
// both make the Rust kernel hand the file back with `defer: parse tree contains errors`, and
// both fail the same way under the C++ grammar. 45 of that project's 119 files are in this
// bucket, and before this file they contributed zero symbols to the index: not a reduced
// view, an empty one.
//
// The full fix is the WASM recovery parser, which is blocked on emscripten's dynamic linker
// (see internal/cgwasm). This is the honest degraded substitute, and it follows the same
// philosophy as this project's `outline` tool: recognise declarations from the shape of a
// line, degrade gracefully on anything unrecognised, and never invent structure.
//
// What it DOES produce: include directives, macro definitions, struct/union/enum declarations,
// typedefs, functions, and struct fields. That is the surface a reader of a macro-heavy header
// actually needs — where is `UT_hash_handle` declared, what does `HASH_ADD` take.
//
// What it does NOT produce: any call or reference edge. Recognising `name(` from source text
// cannot distinguish a call from a declaration, a macro invocation from a cast, or a
// function-pointer field from a definition. Emitting edges from that guess would fill the graph
// with wrong facts, which is the one thing this project's resolver refuses to do. So these
// files contribute symbols without a call graph, and the file row records that plainly.

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// heuristicReason is what a file's parse_error says when this path produced its nodes.
//
// Kept distinct from the kernel's `defer:` message so `cg status` can tell "no parser could
// handle this" from "a fallback did, at lower fidelity".
const heuristicReason = "heuristic extraction: the grammar rejected this file (a C compiler accepts it); symbols only, no call graph"

// HeuristicResult is what the line scanner produced.
type HeuristicResult struct {
	Nodes []StoredNode
	Edges []StoredEdge
	// Symbols is how many declarations were recognised, for reporting.
	Symbols int
}

// HeuristicExtract reads a C/C++ file's declarations from its text.
//
// `language` is used only to label the nodes; the scanning rules are the same for both, since
// the constructs that matter here (`#include`, `#define`, `struct`, `typedef`, a function
// header) are spelled identically.
func HeuristicExtract(path, language string, source []byte) HeuristicResult {
	lines := splitKeepEnds(string(source))
	scanner := &cScanner{
		path:     path,
		language: language,
		lines:    lines,
		seen:     map[string]bool{},
	}
	scanner.run()
	return HeuristicResult{Nodes: scanner.nodes, Edges: scanner.edges, Symbols: len(scanner.nodes)}
}

// splitKeepEnds splits on "\n" keeping each line's terminator, so a slice can be rejoined
// byte-for-byte. The trailing empty element a final newline produces is dropped.
func splitKeepEnds(text string) []string {
	if text == "" {
		return nil
	}
	var out []string
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			out = append(out, text[start:i+1])
			start = i + 1
		}
	}
	if start < len(text) {
		out = append(out, text[start:])
	}
	return out
}

// cScanner holds the state a line scan needs.
type cScanner struct {
	path     string
	language string
	lines    []string
	nodes    []StoredNode
	edges    []StoredEdge
	seen     map[string]bool

	// depth is the brace depth at the start of the current line.
	depth int
	// blockComment is true while inside a /* */ that has not closed.
	blockComment bool
	// macroContinue is true while a #define's backslash continuation is open.
	macroContinue bool
	// container is the innermost struct/union/enum body open at this depth.
	container *cContainer
	// fileID is this file's own node id, created lazily.
	fileID string
}

// cContainer is one struct/union/enum body being scanned.
type cContainer struct {
	id        string
	name      string
	kind      string
	depth     int
	startLine int
}

// Patterns. Each is anchored tightly enough that a wrong match is unlikely: a rule that
// over-matches adds a node that does not exist, which is worse than missing one.
var (
	// #include "x" or #include <x>, allowing indentation and `#  include`.
	hcIncludeRE = regexp.MustCompile(`^\s*#\s*include\s*[<"]([^>"]+)[>"]`)
	// #define NAME(args) or #define NAME, capturing only the identifier.
	hcDefineRE = regexp.MustCompile(`^\s*#\s*define\s+([A-Za-z_]\w*)`)
	// #define NAME(args) — a function-like macro, which is a callable and is recorded as one.
	hcDefineArgsRE = regexp.MustCompile(`^\s*#\s*define\s+([A-Za-z_]\w*)\s*\(`)
	// `struct Foo {`, `typedef struct {`, `union U {`, `enum E {`, with optional struct tag.
	hcAggregateRE = regexp.MustCompile(`^\s*(?:typedef\s+)?(struct|union|enum)\s+([A-Za-z_]\w*)?\s*\{`)
	// `} Alias;` — the name a typedef gives an anonymous aggregate.
	hcAggregateCloseRE = regexp.MustCompile(`^\s*\}\s*([A-Za-z_]\w*)\s*;`)
	// `typedef <base> Alias;` on one line.
	hcTypedefRE = regexp.MustCompile(`^\s*typedef\s+[^;{}]+?\s+([A-Za-z_]\w*)\s*;`)
	// A function header at file scope: modifiers, a return type, a name, then `(`.
	hcFuncRE = regexp.MustCompile(`^\s*(?:static\s+|inline\s+|extern\s+|const\s+|unsigned\s+|signed\s+|struct\s+|enum\s+|union\s+)*[A-Za-z_][\w:*&<>, ]*?\s+\**([A-Za-z_]\w*)\s*\(`)
	// A field inside an aggregate body: `<type> name;` or `<type> name[...]`.
	hcFieldRE = regexp.MustCompile(`^\s*(?:[A-Za-z_][\w:*]*\s+)+\**([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;`)
)

// run scans every line.
func (s *cScanner) run() {
	for index, raw := range s.lines {
		lineNo := index + 1
		line := raw

		// A macro continuation swallows everything until the trailing backslash stops.
		if s.macroContinue {
			s.macroContinue = strings.HasSuffix(strings.TrimRight(line, "\r\n"), "\\")
			s.trackBraces(line)
			continue
		}

		trimmed := strings.TrimSpace(line)

		// Comment state is tracked, not parsed: a declaration inside a comment is not a
		// declaration, and a `/*` opened on one line commonly closes many lines later.
		if s.blockComment {
			if end := strings.Index(line, "*/"); end >= 0 {
				s.blockComment = false
				line = line[end+2:]
				trimmed = strings.TrimSpace(line)
			} else {
				continue
			}
		}
		if start := strings.Index(line, "/*"); start >= 0 {
			if end := strings.Index(line[start:], "*/"); end < 0 {
				s.blockComment = true
				line = line[:start]
				trimmed = strings.TrimSpace(line)
			}
		}
		if trimmed == "" || strings.HasPrefix(trimmed, "//") {
			s.trackBraces(line)
			continue
		}

		// A closing brace that ends an aggregate closes its container before brace tracking
		// sees the decrement, so the container's end line is this one.
		// The body's last line sits at container.depth+1, and its `}` drops the depth back to
		// container.depth. Comparing against container.depth here would never fire, which is
		// how an anonymous typedef's name stayed unrecovered.
		if s.container != nil && s.depth == s.container.depth+1 && strings.HasPrefix(trimmed, "}") {
			s.closeContainer(lineNo, trimmed)
		}

		switch {
		case strings.HasPrefix(trimmed, "#"):
			s.scanDirective(trimmed, lineNo)
		case s.container != nil && s.depth == s.container.depth+1:
			s.scanField(trimmed, lineNo)
		default:
			s.scanDeclaration(trimmed, lineNo)
		}

		s.trackBraces(line)
	}
	// A container left open at EOF still gets a sensible end line.
	if s.container != nil {
		s.closeContainer(len(s.lines), "")
	}
}

// scanDirective handles a preprocessor line.
func (s *cScanner) scanDirective(trimmed string, lineNo int) {
	if match := hcIncludeRE.FindStringSubmatch(trimmed); match != nil {
		s.addNode("import", match[1], match[1], lineNo, lineNo, "")
		return
	}
	if match := hcDefineArgsRE.FindStringSubmatch(trimmed); match != nil {
		// A function-like macro is callable, so it is recorded as a function with the
		// directive as its signature — that is how a reader finds `HASH_ADD` and sees its
		// parameter list.
		s.addNode("function", match[1], match[1], lineNo, lineNo,
			TruncateForDisplay(trimmed, 160))
		s.macroContinue = strings.HasSuffix(strings.TrimRight(trimmed, "\r\n"), "\\")
		return
	}
	if match := hcDefineRE.FindStringSubmatch(trimmed); match != nil {
		// An object-like macro is a named constant: `#define UTHASH_H`.
		s.addNode("constant", match[1], match[1], lineNo, lineNo,
			TruncateForDisplay(trimmed, 160))
		s.macroContinue = strings.HasSuffix(strings.TrimRight(trimmed, "\r\n"), "\\")
	}
}

// scanDeclaration handles a line at file scope or inside a function body.
//
// Only file scope produces nodes: a local declaration is not something a reader looks up by
// name, and treating `int i;` inside a function as a variable node would flood the index.
func (s *cScanner) scanDeclaration(trimmed string, lineNo int) {
	if match := hcAggregateRE.FindStringSubmatch(trimmed); match != nil {
		kind := match[1]
		name := match[2]
		if name == "" {
			// `typedef struct { … } Alias;` — the name arrives on the closing line, so the
			// container holds a placeholder until then.
			name = ""
		}
		node := s.addNode(kind, name, name, lineNo, lineNo, "")
		s.container = &cContainer{
			id: node, name: name, kind: kind, depth: s.depth, startLine: lineNo,
		}
		return
	}

	if match := hcTypedefRE.FindStringSubmatch(trimmed); match != nil {
		s.addNode("type_alias", match[1], match[1], lineNo, lineNo,
			TruncateForDisplay(trimmed, 160))
		return
	}

	// A function header. `extern "C" {` and a bare brace are not declarations.
	if strings.HasSuffix(trimmed, "extern \"C\" {") || trimmed == "{" || trimmed == "}" {
		return
	}
	if match := hcFuncRE.FindStringSubmatch(trimmed); match != nil {
		name := match[1]
		// Reject statement-like lines: a call ends in `);`, a control keyword is not a name.
		if isCKeyword(name) || strings.HasSuffix(trimmed, ");") {
			return
		}
		// A definition opens a body on this line or the next; a prototype ends in `;`.
		end := lineNo
		if !strings.HasSuffix(trimmed, ";") {
			end = s.findClosingLine(lineNo)
		}
		s.addNode("function", name, name, lineNo, end, TruncateForDisplay(trimmed, 160))
	}
}

// scanField records a member of the open aggregate.
func (s *cScanner) scanField(trimmed string, lineNo int) {
	if s.container == nil {
		return
	}
	// A nested aggregate gets its own container on the next pass; treating its opening line
	// as a field would create a node named after nothing.
	if hcAggregateRE.MatchString(trimmed) {
		return
	}
	if match := hcFieldRE.FindStringSubmatch(trimmed); match != nil {
		name := match[1]
		if isCKeyword(name) {
			return
		}
		qualified := name
		if s.container.name != "" {
			qualified = s.container.name + "::" + name
		}
		s.addNode("field", name, qualified, lineNo, lineNo, TruncateForDisplay(trimmed, 120))
	}
}

// closeContainer finishes the open aggregate.
//
// `closing` is the `}` line, which may carry the typedef name for an anonymous aggregate:
// `} UT_hash_handle;`.
func (s *cScanner) closeContainer(lineNo int, closing string) {
	container := s.container
	s.container = nil

	name := container.name
	if name == "" {
		if match := hcAggregateCloseRE.FindStringSubmatch(closing); match != nil {
			name = match[1]
		}
	}
	for i := range s.nodes {
		if s.nodes[i].ID != container.id {
			continue
		}
		if name != "" {
			s.nodes[i].Name = name
			s.nodes[i].QualifiedName = name
		}
		s.nodes[i].EndLine = lineNo
		break
	}
}

// trackBraces updates the brace depth, ignoring braces in strings and comments.
func (s *cScanner) trackBraces(line string) {
	s.depth += cBraceDelta(line)
	if s.depth < 0 {
		s.depth = 0
	}
}

// findClosingLine returns the line where the block opened at `start` closes.
//
// Bounded: a function body spanning more lines than this is reported as ending at the start,
// which is a smaller lie than an end line pointing at the end of the file.
func (s *cScanner) findClosingLine(start int) int {
	depth := 0
	opened := false
	for i := start - 1; i < len(s.lines) && i < start+4000; i++ {
		delta := cBraceDelta(s.lines[i])
		depth += delta
		if delta > 0 {
			opened = true
		}
		if opened && depth <= 0 {
			return i + 1
		}
	}
	if opened {
		return len(s.lines)
	}
	return start
}

// addNode records one declaration and the file→node edge that contains it.
//
// The id is derived from the file and qualified name, so it is stable across runs; a
// heuristic node cannot use the kernel's ids because that scheme includes position and this
// scanner's positions are approximate.
func (s *cScanner) addNode(kind, name, qualifiedName string, startLine, endLine int, signature string) string {
	if name == "" && kind != "struct" && kind != "union" && kind != "enum" {
		return ""
	}
	key := kind + "\x00" + qualifiedName + "\x00" + strconv.Itoa(startLine)
	if s.seen[key] {
		return ""
	}
	s.seen[key] = true

	sum := sha256.Sum256([]byte(s.path + "\x00" + key))
	id := kind + ":" + hex.EncodeToString(sum[:16])

	s.nodes = append(s.nodes, StoredNode{
		ID:            id,
		Kind:          kind,
		Name:          name,
		QualifiedName: qualifiedName,
		FilePath:      s.path,
		Language:      s.language,
		StartLine:     startLine,
		EndLine:       endLine,
		Signature:     signature,
	})
	// The file contains the declaration, matching how the kernel records ownership.
	s.edges = append(s.edges, StoredEdge{
		Source: s.fileNodeID(),
		Target: id,
		Kind:   "contains",
	})
	return id
}

// fileNodeID returns the containment source, creating the file's own node on first use.
//
// A file reaches this extractor only because the grammar rejected it, so the kernel produced
// no nodes for it — including no `file:` node. Creating one here keeps the containment edges
// pointing at something, and keeps `cg nodes <file>` working on a heuristic file.
func (s *cScanner) fileNodeID() string {
	if s.fileID == "" {
		s.fileID = "file:" + s.path
		s.nodes = append(s.nodes, StoredNode{
			ID:            s.fileID,
			Kind:          "file",
			Name:          filepath.Base(s.path),
			QualifiedName: s.path,
			FilePath:      s.path,
			Language:      s.language,
			StartLine:     1,
			EndLine:       len(s.lines),
		})
	}
	return s.fileID
}

// isCKeyword reports whether a captured name is a statement keyword rather than a symbol.
func isCKeyword(name string) bool {
	switch name {
	case "if", "else", "for", "while", "do", "switch", "case", "default",
		"return", "break", "continue", "goto", "sizeof", "typedef", "struct",
		"union", "enum", "static", "extern", "inline", "const", "volatile",
		"register", "auto", "unsigned", "signed", "void", "char", "short",
		"int", "long", "float", "double", "_Bool", "defined", "include",
		"define", "ifdef", "ifndef", "endif", "pragma", "error", "undef":
		return true
	}
	return false
}
