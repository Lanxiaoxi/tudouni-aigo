package cggraph

// Function-as-value resolution.
//
// Ported from CodeGraph's `matchFunctionRef` / `matchMemberFunctionRef`
// (src/resolution/name-matcher.ts).
//
// A `function_ref` is a function NAME used as a value rather than called:
// `register(handler)`, `signal(SIGINT, handler)`, `o->cb = handler`. Resolution of
// these cannot use scoring, and the reference implementation's rule is explicit about
// why:
//
//	A wrong callback edge is worse than none.
//
// So the discipline is **unique-or-drop**, not "pick the best score". On this repository
// that was the whole difference behind `references` at +124%: every scored pick became
// an edge, when most of them should have stayed unresolved.
//
// This file implements the rules that apply to Go and the language-neutral core:
//
//   - a bare identifier matches FUNCTIONS only — a method is reachable only through a
//     receiver, so a bare name that happens to equal a method name is a collision, not
//     a callback;
//   - `receiver.member` keeps the receiver and resolves ON THAT SCOPE;
//   - an import qualifier is authoritative, even when it points outside the project;
//   - an unknown receiver falls back to unique-or-drop ACROSS ALL FILES, with the
//     receiver-names-its-owner veto;
//   - the from-node itself is never a candidate (a function registering itself is not
//     a dependency edge);
//   - Python property getters are never callback targets (read-only by construction).
//
// Not ported: the Python-specific override paths (`pythonRefClass`, `pythonGlobalMembers`,
// `isPythonProperty`), which need an import-mapping layer this tool does not have for
// Python. A Python `self.m` function-ref therefore falls to the unique-or-drop tail,
// which is stricter than the reference — it will miss some edges rather than invent
// them, and that is the direction this rule wants to err in.

import (
	"strings"
)

// isFunctionRef reports whether an unresolved reference is a function-as-value.
func isFunctionRef(referenceKind string) bool {
	return referenceKind == "function_ref"
}

// selectFunctionRef picks the single target for a function reference.
//
// Returns nil when the answer is not unique. Unlike Select, there is no scoring and no
// tie-break: a tie is a refusal.
func selectFunctionRef(ref *pendingRef, candidates []Candidate) *Candidate {
	filtered := filterFunctionRefCandidates(ref, candidates)
	if len(filtered) != 1 {
		return nil
	}
	return &filtered[0]
}

// filterFunctionRefCandidates applies the per-language rules.
func filterFunctionRefCandidates(ref *pendingRef, candidates []Candidate) []Candidate {
	// `this.<member>` refs are resolved only by a class-scoped resolver. Go has no
	// `this`, so nothing to strip; the guard keeps the rule explicit.
	if strings.HasPrefix(ref.Name, "this.") {
		return nil
	}

	bareFnOnly := bareFunctionOnlyLanguage(ref.FromLanguage)
	receiver, member, hasReceiver := splitMemberRef(ref.Name)

	// A receiver-qualified reference (Go/Python use `.`, so this is the
	// `receiver.member` shape).
	if hasReceiver {
		return filterMemberFunctionRef(ref, receiver, member, candidates, bareFnOnly)
	}

	// A bare identifier.
	var out []Candidate
	for _, cand := range candidates {
		if cand.ID == ref.FromNodeID {
			// A function registering itself is not a dependency edge.
			continue
		}
		switch {
		case cand.Kind == "function":
			// Always acceptable.
		case cand.Kind == "method" && !bareFnOnly:
			// C# method groups, Swift/Dart implicit self, Java/Kotlin references.
		default:
			continue
		}
		if !sameLanguageFamily(cand.Language, ref.FromLanguage) {
			continue
		}
		// A function declared inside another is in scope only there.
		if !lexicallyReachable(&cand, ref) {
			continue
		}
		out = append(out, cand)
	}
	return out
}

// filterMemberFunctionRef handles `receiver.member`.
//
// The receiver is authoritative: only members of the receiver's own scope are eligible.
// When the receiver cannot be identified the result is nil — falling back to a global
// name match on the member alone is exactly the guess this rule forbids.
func filterMemberFunctionRef(
	ref *pendingRef,
	receiver, member string,
	candidates []Candidate,
	bareFnOnly bool,
) []Candidate {
	// Candidates are already looked up by the member's name, so the receiver's job is
	// to decide which of them is in scope. Three receiver shapes, in this order:
	//
	//	1. an import qualifier  — authoritative, resolves to that package
	//	2. a local variable with a known type — resolves to that type's methods
	//	3. an unknown receiver — unique-or-drop, with the owner-word veto
	//
	// The import and local-type cases are handled by the caller's import narrowing and
	// receiver inference, which have already shrunk the candidate set by the time this
	// runs. What remains here is the mechanism and rule 3.

	var out []Candidate
	for _, cand := range candidates {
		if cand.ID == ref.FromNodeID {
			continue
		}
		if cand.Kind != "function" && cand.Kind != "method" {
			// A callback target is code you can call.
			continue
		}
		if !sameLanguageFamily(cand.Language, ref.FromLanguage) {
			continue
		}
		out = append(out, cand)
	}

	// Rule 3: an unknown receiver must name the method's owner, or its last segment
	// must share a word with the owner type. Without that veto a lone method anywhere in
	// the tree becomes the target, which is how a model field bound to another project's
	// same-named method.
	target := receiverLink(receiver)
	filtered := out[:0:0]
	for _, cand := range out {
		if cand.Kind != "method" {
			continue
		}
		if !sharesReceiverWord(target, &cand) {
			continue
		}
		filtered = append(filtered, cand)
	}
	return filtered
}

// bareFunctionOnlyLanguage reports whether a bare identifier in this language can only
// name a free function.
//
// The reasoning, per language:
//
//   - JS/TS/ArkTS: a method is reachable only through a receiver (`this.m`, `Cls.m`),
//     so a bare identifier that equals a method name is a collision. This also sidesteps
//     class fields extracting as method-kind nodes, which would otherwise soak up local
//     names passed as arguments.
//   - C++: a bare identifier can only be a free function; member values need
//     `&Cls::method`.
//   - Python: methods need `self.m`; the bare form is a function or a class.
//   - PHP: string callables name global functions; methods need the `[$obj, 'm']` form.
//
// Every other language KEEPS method targets: C# method groups, Swift/Dart implicit
// self, Java/Kotlin method references, and Go — where `handler := obj.Method` is a real
// method value.
func bareFunctionOnlyLanguage(language string) bool {
	switch language {
	case "typescript", "tsx", "javascript", "jsx", "arkts", "cpp", "python", "php":
		return true
	}
	return false
}

// uniqueMethodCandidate returns the single method in `candidates`, or nil.
//
// The unique-or-drop discipline for a method call whose receiver type is unknown. Only
// method-kind candidates count: a same-named function is a different thing, and accepting
// one because it was the only candidate left is how a method call binds to a free
// function that happens to share its name.
func uniqueMethodCandidate(candidates []Candidate) *Candidate {
	var methods []Candidate
	for _, cand := range candidates {
		if cand.Kind == "method" {
			methods = append(methods, cand)
		}
	}
	if len(methods) != 1 {
		return nil
	}
	return &methods[0]
}

// The last, not the first: `a.b.Method` has the receiver `a.b`, and splitting at the
// first would call the member `b.Method` and look it up by a name no node carries.
func splitMemberRef(name string) (receiver, member string, ok bool) {
	dot := strings.LastIndexByte(name, '.')
	if dot <= 0 || dot == len(name)-1 {
		return "", "", false
	}
	return name[:dot], name[dot+1:], true
}

// sameLanguageFamily reports whether two languages are close enough to bind.
//
// TS/JS/TSX/JSX/ArkTS are one family; everything else is its own. A cross-family binding
// is never right: a TypeScript `handler` cannot be a Go function.
func sameLanguageFamily(a, b string) bool {
	if a == b {
		return true
	}
	return jsFamily(a) && jsFamily(b)
}

func jsFamily(language string) bool {
	switch language {
	case "typescript", "tsx", "javascript", "jsx", "arkts":
		return true
	}
	return false
}

// lexicallyReachable rejects a candidate nested inside a function the reference is not
// in.
//
// A function declared inside another is in scope only in there. Python, JS/TS and every
// closure language scope it lexically, so binding a bare name from elsewhere to a nested
// local fabricates an edge the scope already rules out: `join(...)` in one function must
// never bind to a `join` defined inside a DIFFERENT function.
func lexicallyReachable(cand *Candidate, ref *pendingRef) bool {
	owner := ownerTypeOf(cand.QualifiedName)
	if owner == "" {
		// A top-level symbol has no enclosing function.
		return true
	}
	// Whether the owner is a TYPE or a FUNCTION decides: class members are unaffected by
	// lexical scoping (their parent resolves to a class-like node), only nested
	// functions are.
	if isTypeLikeKind(cand.Kind) {
		return true
	}
	// Without a node-kind for the owner, the conservative answer is "reachable only from
	// the same file", because a same-file nested function is the ordinary case.
	return cand.FilePath == ref.FromFileName
}

func isTypeLikeKind(kind string) bool {
	switch kind {
	case "class", "struct", "interface", "trait", "enum", "union", "protocol", "type_alias":
		return true
	}
	return false
}

// receiverLink is the receiver's identifying word.
//
// A trailing ALL-CAPS segment is a type name, so the segment before it is the identity:
// `cbsecurity.CBSecurity` links on `cbsecurity`, not `CBSecurity`. This is the
// reference implementation's `receiverLink`.
func receiverLink(receiver string) string {
	links := strings.Split(receiver, ".")
	last := links[len(links)-1]
	if len(links) > 1 && isAllCapsType(last) {
		return links[len(links)-2]
	}
	return last
}

// isAllCapsType matches `CBSecurity`, `SD`, `NSHTTP` — a type written in caps.
func isAllCapsType(text string) bool {
	if text == "" || !(text[0] >= 'A' && text[0] <= 'Z') {
		return false
	}
	for i := 1; i < len(text); i++ {
		c := text[i]
		if (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' {
			continue
		}
		return false
	}
	// A single capital is a one-letter identifier, not a type.
	return len(text) > 1
}

// sharesReceiverWord reports whether the receiver names the method's owner, directly or
// through a shared word.
//
// Two-letter words are class prefixes (`SD`, `NS`, `UI`) rather than names, so they are
// excluded from the shared-word comparison. This is the reference implementation's veto:
// `device=self.parent.device` must not bind to the project's one `device` method, which
// belongs to an unrelated `GraphQLFilter`.
func sharesReceiverWord(receiver string, method *Candidate) bool {
	if namesOwnerType(receiver, method) {
		return true
	}
	cut := strings.LastIndex(method.QualifiedName, "::")
	if cut < 0 {
		return false
	}
	ownerWords := map[string]bool{}
	for _, word := range splitCamelCase(method.QualifiedName[:cut]) {
		flat := flatWord(word)
		if len(flat) > 2 {
			ownerWords[flat] = true
		}
	}
	for _, word := range splitCamelCase(receiver) {
		if ownerWords[flatWord(word)] {
			return true
		}
	}
	return false
}

// namesOwnerType reports whether the receiver's last segment is the owner type's name,
// case and a trailing number aside (`cbsecurity` is a `CBSecurity`).
func namesOwnerType(receiver string, method *Candidate) bool {
	cut := strings.LastIndex(method.QualifiedName, "::")
	if cut < 0 {
		return false
	}
	owner := method.QualifiedName[:cut]
	if index := strings.LastIndex(owner, "::"); index >= 0 {
		owner = owner[index+2:]
	}
	if index := strings.LastIndexByte(owner, '.'); index >= 0 {
		owner = owner[index+1:]
	}
	receiverLast := receiver
	if index := strings.LastIndexByte(receiverLast, '.'); index >= 0 {
		receiverLast = receiverLast[index+1:]
	}
	return flatWord(receiverLast) == flatWord(owner)
}

// flatWord is a name's letters and digits, lowercased, a trailing number dropped.
func flatWord(word string) string {
	var b strings.Builder
	for _, r := range word {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			if r >= 'A' && r <= 'Z' {
				r = r - 'A' + 'a'
			}
			b.WriteRune(r)
		}
	}
	out := b.String()
	for len(out) > 0 && out[len(out)-1] >= '0' && out[len(out)-1] <= '9' {
		out = out[:len(out)-1]
	}
	return out
}

// splitCamelCase splits on camel boundaries and separators, dropping one-letter words.
func splitCamelCase(text string) []string {
	var out []string
	var current strings.Builder
	flush := func() {
		if current.Len() > 1 {
			out = append(out, current.String())
		}
		current.Reset()
	}
	runes := []rune(text)
	for i, r := range runes {
		switch {
		case r == '.' || r == '_' || r == ':' || r == '/' || r == '\\':
			flush()
		case r >= 'A' && r <= 'Z' && i > 0 && runes[i-1] >= 'a' && runes[i-1] <= 'z':
			// lower→Upper boundary.
			flush()
			current.WriteRune(r)
		default:
			current.WriteRune(r)
		}
	}
	flush()
	return out
}
