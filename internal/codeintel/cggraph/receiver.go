package cggraph

// Receiver-type inference.
//
// Go's `x.Method()` needs `x`'s type. Without type checking there is no general
// answer — but the shapes that dominate a real tree are local and cheap:
//
//	func TestX(t *testing.T)  then  t.Errorf(...)   → T
//	e := &File{}              then  e.Close()       → File
//	var b bytes.Buffer        then  b.Write(...)    → Buffer
//	f, err := os.Open(...)    then  f.Close()       → unknowable here
//
// The first three are inferred; the fourth is not. That asymmetry is the design: a
// guessed receiver type narrows the candidate set to the WRONG methods and produces a
// confident wrong edge, while no receiver type merely leaves the candidates
// unnarrowed, where scoring can still prefer the plausible one.
//
// So the rule for adding an inference is that it must follow from the local syntax
// alone. Nothing here reads another file, and nothing treats an unresolved expression
// as a type.
//
// Why parameters matter most: `t *testing.T` in a test signature makes every
// `t.Errorf` in that function inferable, and on this repository `t.Errorf` alone was
// 1597 unresolved references — the largest single name in the table.

import (
	"os"
	"strings"
)

// localDecl is one type-bearing binding: a parameter, a `var`, or a `:=`.
type localDecl struct {
	// Name is the bound identifier.
	Name string
	// TypeName is the inferred type's final segment, or "" when not inferable.
	TypeName string
	// Line is where the binding appears. A later binding shadows an earlier one, so
	// the nearest preceding one is what applies at a use site.
	Line int
}

// parseLocalDecls extracts every type-bearing binding from a file's source.
//
// `startLine` is the 1-based line number of `text`'s first line, so recorded lines are
// file coordinates and a use site can pick the nearest preceding binding.
func parseLocalDecls(text string, startLine int) []localDecl {
	var out []localDecl
	for offset, raw := range strings.Split(text, "\n") {
		lineNo := startLine + offset
		for _, decl := range parseDeclLine(raw) {
			decl.Line = lineNo
			out = append(out, decl)
		}
	}
	return out
}

// parseDeclLine returns every binding a line introduces.
//
// A slice rather than one value because a parameter list introduces several.
func parseDeclLine(raw string) []localDecl {
	line := strings.TrimSpace(raw)
	// A comment declares nothing; `// var x T` is documentation.
	if line == "" || strings.HasPrefix(line, "//") || strings.HasPrefix(line, "/*") ||
		strings.HasPrefix(line, "*") {
		return nil
	}

	// A func declaration: its parameter list is the densest source of receiver types.
	if decls := parseParams(line); len(decls) > 0 {
		return decls
	}

	// `var name Type` / `var name = expr`.
	if rest, ok := cutWordPrefix(line, "var"); ok {
		rest = strings.TrimSpace(rest)
		name, tail := takeIdentifier(rest)
		if name == "" {
			return nil
		}
		// `var a, b int` binds one type to several names; only the first is recorded,
		// because the rest would need the same parse to recover and the first is what
		// call sites usually touch.
		if comma := strings.IndexByte(tail, ','); comma >= 0 {
			tail = tail[comma+1:]
		}
		tail = strings.TrimSpace(tail)
		if strings.HasPrefix(tail, "=") {
			return []localDecl{{Name: name, TypeName: inferFromExpression(tail[1:])}}
		}
		return []localDecl{{Name: name, TypeName: cleanTypeName(tail)}}
	}

	// `name := expr` / `name = expr`. The left side must be a single bare identifier:
	// an assignment to a field or an index is not a binding, and inventing a local
	// from one gives every later call through it the wrong receiver.
	for _, op := range []string{":=", "="} {
		index := strings.Index(line, op)
		if index <= 0 {
			continue
		}
		lhs := strings.TrimSpace(line[:index])
		if !isBareIdentifier(lhs) {
			continue
		}
		return []localDecl{{Name: lhs, TypeName: inferFromExpression(line[index+len(op):])}}
	}
	return nil
}

// parseParams extracts `name Type` bindings from a func declaration's parameter list.
//
// A method declaration has TWO parenthesised groups — the receiver and the parameters
// — and treating them as one concatenated blob is what made `func (s *Server) Run(ctx
// context.Context)` yield only a garbled `s`. They are parsed separately.
//
// Both count: `s` from `(s *Server)` and `ctx` from `(ctx context.Context)` are
// equally usable receiver types. A line that is a call rather than a declaration has
// no `func` before its first parenthesis and is rejected.
func parseParams(line string) []localDecl {
	firstOpen := strings.IndexByte(line, '(')
	if firstOpen < 0 {
		return nil
	}
	if !strings.Contains(line[:firstOpen], "func") {
		return nil
	}
	firstClose := matchParen(line, firstOpen)
	if firstClose < 0 {
		// A signature split across lines has no closing parenthesis here; skipping it
		// beats mis-parsing half of it.
		return nil
	}

	head := strings.TrimSpace(line[:firstOpen])
	isMethod := strings.HasPrefix(head, "func") && strings.TrimSpace(head[len("func"):]) == ""

	var groups []string
	groups = append(groups, line[firstOpen+1:firstClose])

	// A method: the receiver group is followed by the name and another group.
	if isMethod {
		if secondOpen := strings.IndexByte(line[firstClose+1:], '('); secondOpen >= 0 {
			secondOpen += firstClose + 1
			if secondClose := matchParen(line, secondOpen); secondClose > secondOpen {
				groups = append(groups, line[secondOpen+1:secondClose])
			}
		}
	}

	var out []localDecl
	for _, group := range groups {
		for _, part := range splitTopLevel(group, ',') {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			name, tail := takeIdentifier(part)
			if name == "" {
				continue
			}
			typeName := cleanTypeName(strings.TrimSpace(tail))
			if typeName == "" {
				// `name1, name2 Type` leaves the first part with no type; it is skipped
				// rather than given the neighbour's type.
				continue
			}
			out = append(out, localDecl{Name: name, TypeName: typeName})
		}
	}
	return out
}

// matchParen returns the index of the parenthesis closing the one at `open`.
func matchParen(text string, open int) int {
	depth := 0
	for i := open; i < len(text); i++ {
		switch text[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

// splitTopLevel splits on `sep`, ignoring separators inside brackets so a parameter of
// type `map[string]int` survives.
func splitTopLevel(text string, sep byte) []string {
	var out []string
	depth := 0
	start := 0
	for i := 0; i < len(text); i++ {
		switch text[i] {
		case '(', '[', '{':
			depth++
		case ')', ']', '}':
			depth--
		case sep:
			if depth == 0 {
				out = append(out, text[start:i])
				start = i + 1
			}
		}
	}
	return append(out, text[start:])
}

// inferFromExpression infers a type from the right-hand side of a binding.
//
// Three shapes carry a type locally:
//
//	&Type{...}  → Type
//	Type{...}   → Type
//	new(Type)   → Type
//
// Everything else — a call's result, a field access, a literal — needs information this
// file does not have, and "" is the honest answer.
func inferFromExpression(expr string) string {
	expr = strings.TrimSpace(expr)
	expr = strings.TrimPrefix(expr, "&")
	expr = strings.TrimSpace(expr)

	if rest, ok := cutWordPrefix(expr, "new"); ok {
		rest = strings.TrimSpace(rest)
		if strings.HasPrefix(rest, "(") {
			if end := strings.IndexByte(rest, ')'); end > 0 {
				return cleanTypeName(rest[1:end])
			}
		}
		return ""
	}

	// `Type{...}`. The brace must follow the type directly; a brace after a call's
	// parenthesis is not a composite literal.
	brace := strings.IndexByte(expr, '{')
	if brace <= 0 {
		return ""
	}
	head := strings.TrimSpace(expr[:brace])
	if !isTypeExpression(head) {
		return ""
	}
	return cleanTypeName(head)
}

// isTypeExpression reports whether `head` names a type rather than a call.
func isTypeExpression(head string) bool {
	if head == "" || strings.ContainsAny(head, "()[]{}+-*/=,;:\"'`") {
		return false
	}
	return isBareIdentifier(head) || isQualifiedIdentifier(head)
}

func isBareIdentifier(text string) bool {
	if text == "" {
		return false
	}
	for i, r := range text {
		if r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			continue
		}
		if i > 0 && r >= '0' && r <= '9' {
			continue
		}
		return false
	}
	return true
}

// isQualifiedIdentifier accepts `pkg.Type` and `pkg.sub.Type`.
func isQualifiedIdentifier(text string) bool {
	parts := strings.Split(text, ".")
	if len(parts) < 2 {
		return false
	}
	for _, part := range parts {
		if !isBareIdentifier(part) {
			return false
		}
	}
	return true
}

// cleanTypeName reduces a type expression to its final name segment.
//
// `*os.File` → `File`, `map[string]*Config` → `Config`, `Pair[K, V]` → `Pair`. The
// receiver rule compares only the last segment of a qualified name, so keeping a
// package prefix would never match.
func cleanTypeName(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	// A map's value type is what `m[k].Method()` dispatches on; the map's own type has
	// no methods worth narrowing to.
	if rest, ok := cutWordPrefix(text, "map"); ok {
		if open := strings.IndexByte(rest, ']'); open >= 0 {
			text = rest[open+1:]
		}
	}
	text = strings.TrimLeft(text, "*&[]")
	if index := strings.IndexByte(text, '['); index >= 0 {
		text = text[:index]
	}
	text = strings.TrimSpace(text)
	if dot := strings.LastIndexByte(text, '.'); dot >= 0 {
		text = text[dot+1:]
	}
	text = strings.TrimLeft(text, "*&")
	if !isBareIdentifier(text) {
		return ""
	}
	return text
}

// cutWordPrefix removes a keyword, requiring a word boundary so `variable` does not
// match `var`.
func cutWordPrefix(text, word string) (string, bool) {
	if !strings.HasPrefix(text, word) {
		return text, false
	}
	if len(text) == len(word) {
		return "", true
	}
	next := text[len(word)]
	if next == '_' || (next >= 'a' && next <= 'z') || (next >= 'A' && next <= 'Z') ||
		(next >= '0' && next <= '9') {
		return text, false
	}
	return text[len(word):], true
}

// takeIdentifier consumes a leading identifier.
func takeIdentifier(text string) (name, rest string) {
	for i := 0; i < len(text); i++ {
		c := text[i]
		if c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(i > 0 && c >= '0' && c <= '9') {
			continue
		}
		return text[:i], text[i:]
	}
	return text, ""
}

// receiverTypeAt finds the type bound to `name` at a use site on `line`.
//
// The nearest preceding binding wins, which is how shadowing works: a later `err :=`
// rebinds the name for the lines after it, and an earlier binding's type would be
// wrong for exactly the call sites a shadow affects.
func receiverTypeAt(decls []localDecl, name string, line int) string {
	best := ""
	bestLine := -1
	for _, decl := range decls {
		if decl.Name != name || decl.TypeName == "" || decl.Line > line {
			continue
		}
		if decl.Line >= bestLine {
			bestLine = decl.Line
			best = decl.TypeName
		}
	}
	return best
}

// splitReceiverCall splits `receiver.Method` into its two parts.
//
// A deeper chain (`a.b.Method`) is not a simple receiver: its type is a field's, which
// this scanner cannot know, so it is rejected rather than narrowed to the wrong type.
func splitReceiverCall(name string) (receiver, method string, isCall bool) {
	dot := strings.IndexByte(name, '.')
	if dot <= 0 || dot == len(name)-1 {
		return "", "", false
	}
	head := name[:dot]
	tail := name[dot+1:]
	if strings.ContainsRune(tail, '.') {
		return "", "", false
	}
	if !isBareIdentifier(head) {
		return "", "", false
	}
	return head, tail, true
}

// declarationsForFile reads a file and extracts its bindings.
//
// The source is read rather than stored: declarations are derived data that change
// whenever the file changes, and a stale row would narrow a reference to a type that no
// longer exists. A failed read costs only the narrowing.
func declarationsForFile(path string) []localDecl {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return parseLocalDecls(string(raw), 1)
}
