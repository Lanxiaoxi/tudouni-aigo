package builtin

// The skeleton view of a file.
//
// Why this exists at all: a read is the tool the agent spends most of its budget
// on, and the most common bad read is "open the whole file to find out what is in
// it". An outline answers that question in a fraction of the bytes — the
// declaration lines and their numbers, no bodies — and the numbers are the point:
// the next call can be read_file(start_line=…) instead of another whole file.
//
// Why it is heuristic rather than per-language parsers: the runtime has to serve
// whatever language a user's repository happens to use, and a registry of twenty
// parsers would be a second product to maintain. Everything here works from the
// shape of a line — modifier keywords, a declaration word, brace depth, an opening
// body — which degrades gracefully on languages it has never seen instead of
// failing on them. It is deliberately *not* a parser: it never needs to be exactly
// right, because being one declaration wrong costs the model twenty lines of
// context, not a bad decision.
//
// The failure mode is important and therefore explicit: when nothing recognizable
// is found, this returns no entries and the caller says so in one sentence. It
// never invents structure, and it never pretends a skeleton is a whole file.

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// outlineLineWidth caps how much of a declaration's source line survives. A
// signature long enough to be worth 200 runes is long enough that the model should
// read the line itself; the outline's job is to name the thing and give its
// position, not to reproduce the file.
const outlineLineWidth = 120

// outlineMaxEntries caps one outline. A generated file can carry thousands of
// declarations, and an outline that is as big as the file it summarizes is worse
// than useless — it costs the same tokens and reads less well.
const outlineMaxEntries = 300

// OutlineEntry is one declaration: the 1-based line it starts on and that line's
// own text.
type OutlineEntry struct {
	Line int
	Text string
}

// The words that make a line a declaration in the languages this targets. `fun` is
// Kotlin, `def`/`defp`/`defn` Elixir and Lisp-likes, `sub` Perl and VB, `proc` Nim
// and Ruby, `record` is C#/Java 16, `protocol` Swift, `extension` Swift/Kotlin.
//
// `impl`/`trait` are Rust; `module` Ruby/Elixir; `namespace` C#/PHP; `object` is
// Kotlin/Scala. Anything not listed still gets a chance through the method rule
// below, which recognizes `name(...)` inside a type body without knowing the word
// in front of it.
var outlineKeywords = []string{
	"func", "fun", "def", "defp", "defn", "defmacro", "defmodule", "fn",
	"function", "class", "struct", "interface", "enum", "type", "trait",
	"impl", "module", "namespace", "object", "record", "protocol",
	"extension", "macro", "sub", "proc", "union", "const",
}

// Type-producing keywords: their body is where methods live, so the depth they
// open is what makes the method rule applicable.
var outlineTypeKeywords = map[string]bool{
	"class": true, "struct": true, "interface": true, "enum": true,
	"type": true, "trait": true, "impl": true, "object": true,
	"record": true, "protocol": true, "extension": true, "union": true,
	"namespace": true, "module": true,
}

// Pure modifiers that can precede the declaration word. Longest first, because
// `pub(crate)` must win over `pub`.
var outlineModifiers = []string{
	"pub(crate)", "pub(super)", "pub", "export", "default", "declare",
	"public", "private", "protected", "internal", "static", "final",
	"abstract", "sealed", "open", "override", "suspend", "inline",
	"virtual", "extern", "unsafe", "async", "partial", "readonly",
	"mutable", "synchronized", "native", "transient", "volatile",
}

// Variable binders. A `const`/`let`/`val` binding is only structure when it holds
// a function; `const MAX = 10` is noise in an outline.
var outlineBinders = []string{"const", "let", "var", "val"}

// Statement and control-flow starts. These never declare anything, and a line
// inside a type body that begins with one (a default value, a lambda expression)
// must not be mistaken for a method.
var outlineControl = regexp.MustCompile(
	`^(?:if|for|while|switch|case|catch|return|else|do|try|finally|throw|` +
		`new|delete|await|yield|with|using|lock|foreach|unless|until|match|` +
		`when|then|begin|rescue|ensure|elif|loop|defer|go|select|range|` +
		`break|continue|goto|raise|assert|pass|import|package|from)\b`)

// A Go struct field of function type: `Handler func(ctx context.Context) error`.
// It lives inside a type body and contains a call-like paren, so without this it
// would be reported as a method.
var outlineFuncField = regexp.MustCompile(`^[A-Za-z_][\w]*\s+func\s*\(`)

// A markdown heading.
var outlineHeading = regexp.MustCompile(`^#{1,6}\s+\S`)

// BuildOutline extracts the declaration lines of one file.
//
// `path` is used only for its extension (markdown gets headings, everything else
// gets the code rules); the content is otherwise treated uniformly.
func BuildOutline(path, text string) (entries []OutlineEntry, total int) {
	lines := splitLinesKeepingEnds(text)
	total = len(lines)
	if total == 0 {
		return nil, 0
	}

	// The terminator is stripped for matching and for display: an outline line
	// carrying a "\r" would render as a stray character in the model's view.
	plain := make([]string, total)
	for index, line := range lines {
		plain[index] = strings.TrimRight(line, "\r\n")
	}

	switch strings.ToLower(filepath.Ext(path)) {
	case ".md", ".markdown", ".mdx":
		return headingOutline(plain), total
	}
	return codeOutline(plain), total
}

// RenderOutline is what read_file returns for outline=true.
//
// The header is not decoration: it is the only place the model learns that what it
// holds is a skeleton and how to ask for the rest. A model that mistakes an
// outline for a file's contents is the silent failure this whole feature could
// introduce, so the sentence says it outright.
func RenderOutline(path, text string) (rendered string, total int, declarations int) {
	entries, total := BuildOutline(path, text)
	if total == 0 {
		return "文件是空的：" + path + "（0 行）", 0, 0
	}
	if len(entries) == 0 {
		return fmt.Sprintf("%s（共 %d 行）里没有识别到声明结构 —— 可能是非代码文件，或者语法不在识别范围内。"+
			"这次没有返回内容：用 start_line / end_line 直接读，或先 grep 定位。", path, total), total, 0
	}

	truncated := false
	if len(entries) > outlineMaxEntries {
		entries = entries[:outlineMaxEntries]
		truncated = true
	}

	width := len(strconv.Itoa(entries[len(entries)-1].Line))
	var body strings.Builder
	for _, entry := range entries {
		body.WriteString(fmt.Sprintf("%*d| %s\n", width, entry.Line, clipRunes(entry.Text, outlineLineWidth)))
	}

	head := fmt.Sprintf("[%s：骨架（outline），共 %d 行，%d 个声明 —— 这不是全文。"+
		"要读具体的某一段，用 start_line / end_line 按这里的行号读]", path, total, len(entries))
	if truncated {
		head = fmt.Sprintf("[%s：骨架（outline），共 %d 行，声明超过 %d 个，这里只列出前 %d 个 —— 这不是全文。"+
			"要读具体的某一段，用 start_line / end_line 按这里的行号读]",
			path, total, outlineMaxEntries, outlineMaxEntries)
	}
	return head + "\n" + body.String(), total, len(entries)
}

// codeOutline walks the file once, tracking brace depth so that a declaration is
// told apart from a statement that happens to contain a declaration word.
func codeOutline(lines []string) []OutlineEntry {
	var entries []OutlineEntry
	depth := 0
	// Depths at which a type body is open. Anything at or below the top of this
	// stack is "inside a type", which is where the method rule applies.
	var typeDepths []int

	for index, raw := range lines {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}

		enteredDepth := depth

		if !isCommentOnly(trimmed) {
			if keyword, ok := declarationKeyword(trimmed); ok {
				entries = append(entries, OutlineEntry{Line: index + 1, Text: raw})
				if outlineTypeKeywords[keyword] && endsWithOpenBrace(trimmed) {
					typeDepths = append(typeDepths, enteredDepth+1)
				}
			} else if len(typeDepths) > 0 && enteredDepth >= typeDepths[len(typeDepths)-1] &&
				looksLikeMethod(trimmed) {
				entries = append(entries, OutlineEntry{Line: index + 1, Text: raw})
			} else if looksLikeIndentedDeclaration(raw, trimmed) {
				// A real declaration nested inside a function body: a closure, a
				// nested component. Only unambiguous ones get here (see the
				// comment on looksLikeIndentedDeclaration), because at this depth
				// a false positive is a button in a JSX tree.
				entries = append(entries, OutlineEntry{Line: index + 1, Text: raw})
			}
		}

		depth += braceDelta(raw)
		if depth < 0 {
			depth = 0
		}
		for len(typeDepths) > 0 && depth < typeDepths[len(typeDepths)-1] {
			typeDepths = typeDepths[:len(typeDepths)-1]
		}
	}
	return entries
}

// headingOutline handles markdown, where the structure is the headings. Docs are
// read often enough in this runtime that treating them as "no structure" would
// waste the feature on a large share of real reads.
func headingOutline(lines []string) []OutlineEntry {
	var entries []OutlineEntry
	inFence := false
	for index, raw := range lines {
		trimmed := strings.TrimSpace(raw)
		// A heading inside a fenced code block is code, not structure.
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if outlineHeading.MatchString(trimmed) {
			entries = append(entries, OutlineEntry{Line: index + 1, Text: raw})
		}
	}
	return entries
}

// declarationKeyword strips modifiers and reports the declaration word, if the
// line starts with one.
func declarationKeyword(trimmed string) (string, bool) {
	rest := stripModifiers(trimmed)

	for _, binder := range outlineBinders {
		if !hasWordPrefix(rest, binder) {
			continue
		}
		// A binder declares structure only when it binds a function. Without an
		// assignment it is a C-style declaration, which is structure too.
		if !strings.Contains(rest, "=") {
			return binder, true
		}
		if looksLikeFunctionValue(rest) {
			return binder, true
		}
		return "", false
	}

	for _, keyword := range outlineKeywords {
		if hasWordPrefix(rest, keyword) {
			return keyword, true
		}
	}

	// Lisp-likes: `(defn name ...)`.
	if strings.HasPrefix(rest, "(") {
		for _, keyword := range outlineKeywords {
			if strings.HasPrefix(rest, "("+keyword+" ") {
				return keyword, true
			}
		}
	}
	return "", false
}

// stripModifiers removes any run of leading modifier words.
//
// The loop is repeated because modifiers stack (`export default async function`,
// `pub(crate) async unsafe fn`), and dropping only the first would leave the line
// starting with something no keyword matches.
func stripModifiers(trimmed string) string {
	rest := trimmed
	for {
		changed := false
		for _, modifier := range outlineModifiers {
			if !hasWordPrefix(rest, modifier) {
				continue
			}
			rest = strings.TrimSpace(rest[len(modifier):])
			changed = true
		}
		if !changed {
			return rest
		}
	}
}

// hasWordPrefix reports whether text begins with word and the word ends there, so
// that `def` does not match `define` and `class` does not match `classify`.
func hasWordPrefix(text, word string) bool {
	if !strings.HasPrefix(text, word) {
		return false
	}
	if len(text) == len(word) {
		return true
	}
	next := text[len(word)]
	if next >= 'a' && next <= 'z' || next >= 'A' && next <= 'Z' ||
		next >= '0' && next <= '9' || next == '_' || next == '$' {
		return false
	}
	return true
}

// outlineArrowFunction matches a top-level arrow function or function expression:
// `const load = (id) => {`, `export const render = async function () {`.
//
// The arrow has to be followed by a block or by an argument-less/one-argument
// form, because `const t = load((x) => x + 1)` and `const rt = useStore((s) => s.x)`
// are values computed by passing a callback — reporting every one of those would
// bury the real declarations.
var outlineArrowFunction = regexp.MustCompile(
	`^[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\((?:[^()]|\([^()]*\))*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)`)

// looksLikeFunctionValue reports whether an assignment binds something callable.
//
// The binder word is stripped first: the pattern describes the shape *after* the
// declaration keyword (`load = (id) => {`), and `const load = …` would otherwise
// have `const` occupying the position the pattern expects a name in.
func looksLikeFunctionValue(text string) bool {
	rest := stripModifiers(text)
	for _, binder := range outlineBinders {
		if hasWordPrefix(rest, binder) {
			rest = strings.TrimSpace(rest[len(binder):])
			break
		}
	}
	return outlineArrowFunction.MatchString(rest)
}

// looksLikeIndentedDeclaration recognizes the declarations that live inside a
// function body: a closure, a nested component, a helper defined where it is used.
//
// Two conditions have to hold together, and both exist to keep a JSX tree out of
// the outline:
//
//   - the line is **indented**, which excludes `type="button"` and other attribute
//     lines, since those always start at the beginning of their own line;
//   - the assignment binds a **function**, not a value, which excludes
//     `const rt = useStore((s) => s.x)`.
//
// A value declaration inside a body is deliberately not reported: `const x = 1` is
// implementation, not structure, and listing it would drown the declarations that
// let the model navigate.
func looksLikeIndentedDeclaration(raw, trimmed string) bool {
	if raw == trimmed {
		return false
	}
	return looksLikeFunctionValue(stripModifiers(trimmed))
}

// looksLikeMethod reports whether a line inside a type body is a method
// declaration.
//
// The shape it relies on is "the first paren is attached to an identifier", which
// is what separates `load(id: string) {` from a field holding a callback type
// (`onClick: () => void`). It is also what lets it work across Java, C#, Kotlin,
// Swift and TypeScript without knowing any of their return-type syntax.
func looksLikeMethod(trimmed string) bool {
	if outlineControl.MatchString(trimmed) || outlineFuncField.MatchString(trimmed) {
		return false
	}
	if strings.HasPrefix(trimmed, "@") || strings.HasPrefix(trimmed, "#[") {
		// An annotation line describes the next one; it declares nothing itself.
		return false
	}

	bodyless := endsWithOpenBrace(trimmed) || strings.HasSuffix(trimmed, ";")
	continues := strings.HasSuffix(trimmed, "(") || strings.HasSuffix(trimmed, ",")
	if !bodyless && !continues {
		return false
	}

	open := strings.Index(trimmed, "(")
	if open <= 0 {
		return false
	}
	previous := trimmed[open-1]
	identifier := previous >= 'a' && previous <= 'z' ||
		previous >= 'A' && previous <= 'Z' ||
		previous >= '0' && previous <= '9' ||
		previous == '_' || previous == '$' || previous == '>'
	return identifier
}

// isCommentOnly reports whether a line carries no code.
func isCommentOnly(trimmed string) bool {
	return strings.HasPrefix(trimmed, "//") ||
		strings.HasPrefix(trimmed, "/*") ||
		strings.HasPrefix(trimmed, "*") ||
		strings.HasPrefix(trimmed, "#") && !strings.HasPrefix(trimmed, "#[")
}

// endsWithOpenBrace reports whether a line opens a block, ignoring a trailing line
// comment so that `func f() { // note` still counts.
func endsWithOpenBrace(trimmed string) bool {
	if comment := strings.Index(trimmed, "//"); comment >= 0 {
		trimmed = strings.TrimSpace(trimmed[:comment])
	}
	return strings.HasSuffix(trimmed, "{")
}

// braceDelta is the net change in brace depth across one line.
//
// String literals are skipped so that `{` inside a message cannot open a block,
// and a line comment ends the scan. Block comments spanning lines are not tracked:
// the heuristic only has to be approximately right, and a miscount shows up as one
// declaration listed at the wrong indent rather than as a failure.
func braceDelta(line string) int {
	delta := 0
	var quote rune
	escaped := false

	for _, char := range line {
		if quote != 0 {
			if escaped {
				escaped = false
				continue
			}
			if char == '\\' && quote != '`' {
				escaped = true
				continue
			}
			if char == quote {
				quote = 0
			}
			continue
		}
		switch char {
		case '"', '\'', '`':
			quote = char
		case '{':
			delta++
		case '}':
			delta--
		case '/':
			// Handled by the caller for "//" only when it is not inside a string;
			// returning here would also drop a `{` that follows a division, so the
			// line comment is left to endsWithOpenBrace.
		}
	}
	return delta
}

// clipRunes shortens a line to at most limit runes, marking the cut.
func clipRunes(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	runes := []rune(text)
	return string(runes[:limit]) + "…"
}

// readOutline is the read_file branch for outline=true.
//
// It reports the same facts a range read does — the file's real length, which part
// the model is looking at — because those are what keep a partial view from being
// mistaken for the whole file.
func readOutline(path, text string) tools.Result {
	rendered, total, declarations := RenderOutline(path, text)
	return tools.Result{
		Text: rendered,
		Audit: map[string]any{
			"outline":      true,
			"total_lines":  total,
			"declarations": declarations,
		},
	}
}

// wantsOutline reports whether the model asked for the skeleton.
//
// The parameter carries no schema default, for the same reason the bounds do not:
// the handler has to be able to tell "asked for an outline" from "did not", and a
// default would erase the difference before it ever gets here.
func wantsOutline(args map[string]any) bool {
	value, ok := args["outline"].(bool)
	return ok && value
}

// outlineGuidance is the sentence the model reads in read_file's description.
//
// The wording was measured, not guessed. An earlier version said "when you are
// unsure what a large file contains, get the skeleton first" and was acted on **zero
// times in twelve runs and ~140 reads**: it gives the model no condition it can
// evaluate, because "unsure" and "large" are not observable. This version states a
// line count and an imperative, which raised the use rate to ~13%.
//
// It is still not reliable, and the number is worth knowing: the same prompt taken
// six times used the skeleton in four and ignored it in two. Anything that depends on
// this firing every time needs to be enforced in code rather than asked for in prose.
//
// The 200 is a cost-model choice, not a measurement: a skeleton costs 5%-20% of the
// file plus one extra round trip, a located read runs ~50 lines, and the break-even
// is around 350 lines read afterwards. 200 sits inside that band.
func outlineGuidance() string {
	return "**文件超过 200 行、而你还不知道里面有什么时，必须先 outline=true 拿骨架，不要直接整读。**" +
		"骨架只返回声明行和它们的真实行号（通常只有全文的 5%-20%），你看完再从里面挑区间用 start_line / end_line 读正文。" +
		"整读一个 200 行以上的文件来「先看看有什么」是最浪费的一种调用：骨架能省掉 80% 以上的字节，" +
		"而且它给的行号可以直接用来做下一次精确读取。低于 200 行的小文件直接整读即可，不要多此一举。"
}

// outlineParameterDescription is the per-parameter text.
func outlineParameterDescription() string {
	return "设成 true，就只返回文件骨架（声明行 + 它们真实的行号），而不是正文。" +
		"**超过 200 行的文件、且你还没读过它时，先用它。**" +
		"它比整读省 80% 以上的字节，返回的行号可以直接拿去做下一次 start_line / end_line 读取。" +
		"与 start_line / end_line 互斥（要骨架就只传 outline，要区间就只传区间）。" +
		"小于 200 行的文件不需要它，直接读。"
}

