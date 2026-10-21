package cggraph

// The language tier: the per-language rules a resolver needs.
//
// Everything language-neutral lives in resolve.go — batch loading, candidate lookup,
// scoring, edge writing, the function_ref discipline. What differs between languages is
// a small, fixed set of questions, and they are the whole of this interface:
//
//	what does this name mean in scope here?      (reject / narrow)
//	can this candidate be named from that file?  (visibility)
//	what type is this receiver?                  (receiver inference)
//	is this name built into the language?        (reject)
//
// Keeping them behind an interface is what makes the second language possible at all:
// each rule is a place where a Go assumption could otherwise hide, and this repository's
// own resolver had three of them hard-coded as `== "go"` before this file existed.
//
// A tier is allowed to be incomplete. The resolver's contract for an unimplemented rule
// is the PERMISSIVE answer — `Visible` returns true, `ReceiverType` returns "" — because
// a resolver that refuses everything resolves nothing, while a permissive one still has
// scoring and the ambiguous marking to fall back on. What a tier must never do is return
// a confident wrong answer.

import "os"

// LanguageTier is one language's rules.
type LanguageTier interface {
	// Name is the tier's language, matching the extractor's name (`go`, `python`).
	Name() string

	// Visible reports whether a candidate defined in one file can be named from
	// another at all.
	//
	// This is the coarsest rule and the most damaging to get wrong: binding an
	// unexported helper from another package manufactures an edge the compiler would
	// never produce.
	Visible(candidate *Candidate, ref *pendingRef) bool

	// Narrow restricts candidates using what the referencing file imports.
	//
	// Returns the narrowed set and whether narrowing applied. `applied` is separate
	// from "the set got smaller" because a rule can legitimately narrow to nothing — a
	// qualified reference to a package outside the tree has no answer, and that must be
	// reported as unresolved rather than patched with a global name match.
	Narrow(ref *pendingRef, imports map[string]Import, candidates []Candidate) (narrowed []Candidate, applied bool)

	// ReceiverType is the type of the expression a reference is called on, or "" when
	// it cannot be inferred.
	//
	// An empty string is the normal answer and is not a failure: it means the strict
	// per-type path is unavailable, so the caller falls back to unique-or-drop.
	ReceiverType(ref *pendingRef, file *sourceFile) string

	// IsBuiltin reports whether a name is predeclared by the language — `len`, `nil`,
	// `print` — and therefore cannot name a project definition.
	IsBuiltin(name string) bool
}

// tierFor returns the tier for a language, or nil when there is none.
//
// A nil tier is not an error. It means "no language-specific rules", and the resolver
// then runs with the neutral defaults: everything visible, no import narrowing, no
// receiver inference. That is exactly the behaviour the tool had before any tier
// existed, so adding a language never regresses the others.
func (r *Resolver) tierFor(language string) LanguageTier {
	if r.tiers == nil {
		return nil
	}
	return r.tiers[language]
}

// sourceFile is a lazily-read source file, shared by every reference in it.
//
// Reading is deferred and cached per file rather than per reference: a file has hundreds
// of references and one body of text, and the tier's receiver inference is the only
// consumer.
type sourceFile struct {
	path string
	text string
	// read reports whether the read was attempted, so a failed read is not retried for
	// every reference in the file.
	read bool
}

// Text returns the file's contents, or "" when it cannot be read.
func (f *sourceFile) Text() string {
	if !f.read {
		f.read = true
		raw, err := os.ReadFile(f.path)
		if err != nil {
			return ""
		}
		f.text = string(raw)
	}
	return f.text
}

// declareTier registers a tier. Called from the resolver's constructor.
func (r *Resolver) declareTier(tier LanguageTier) {
	if r.tiers == nil {
		r.tiers = map[string]LanguageTier{}
	}
	r.tiers[tier.Name()] = tier
}

// defaultVisible is the permissive answer a tier-less language gets.
func defaultVisible() bool { return true }
