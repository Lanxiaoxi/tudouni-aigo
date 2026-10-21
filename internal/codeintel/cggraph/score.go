package cggraph

// Candidate scoring.
//
// This reproduces CodeGraph's `findBestMatch` (src/resolution/name-matcher.js)
// because its weights are the product of tuning against real repositories, not a
// guess: same file dominates, then directory proximity, then language, then
// whether the kind suits the reference kind, then exported.
//
// One deliberate divergence, and it is the only one: ties. The reference
// implementation resolves a tie by iteration order (`if (score > bestScore)` lets
// the first candidate visited keep the win), which is stable in JavaScript because
// Map preserves insertion order and unstable in Go because map iteration is
// randomized. Measured on this repository, 603 of 35,389 edges (1.7%) are decided
// that way. A Go implementation cannot reproduce that order, and should not try:
// instead a tie is broken deterministically AND recorded, so a caller can tell
// "one candidate clearly won" from "several were equally plausible".
//
// The recorded tie is the more valuable half. A wrong edge that says "these two
// symbols are unrelated" is a worse error than one that says "A probably calls B,
// but four same-named Bs exist" — the second is actionable, the first is a silent
// falsehood.

import (
	"math"
	"sort"
	"strings"
)

// Scoring weights, verbatim from findBestMatch.
const (
	// ScoreSameFile is the dominant signal: a reference almost always means the
	// symbol in its own file when one exists.
	ScoreSameFile = 100

	// ScorePerSharedDir is charged per leading directory segment the reference and
	// candidate share.
	ScorePerSharedDir = 15

	// ScoreProximityCap bounds the directory bonus. Without a cap, a deeply nested
	// candidate could out-score a same-file one purely on path shape.
	ScoreProximityCap = 80

	// ScoreSameLanguage is added for a language match and ScoreCrossLanguage
	// subtracted for a mismatch.
	//
	// The asymmetry is intentional and the reference implementation relies on it:
	// same-language beats cross-language *always*, because same-language scores at
	// least +50 while a cross-language candidate caps at +35 (-80 language, +80
	// proximity, +25 kind, +10 exported) and can never earn the same-file bonus.
	ScoreSameLanguage  = 50
	ScoreCrossLanguage = -80

	// ScoreKindForCall is added when a `calls` reference lands on a function or
	// method.
	ScoreKindForCall = 25

	// ScoreKindForInstantiate is added when an `instantiates` reference lands on a
	// class-like kind. Without it a function named `Foo` in another module could
	// out-score the actual class.
	ScoreKindForInstantiate = 25

	// ScoreKindForDecorator is added for a decorator landing on a function, and
	// ScoreClassForDecorator for one landing on a class or interface — class
	// decorators are legal in Python and Java, hence the smaller bonus.
	ScoreKindForDecorator  = 25
	ScoreClassForDecorator = 15

	// ScoreExported is the tiebreaker between two otherwise identical candidates.
	ScoreExported = 10

	// ScoreLineProximityMax caps the same-file line-distance bonus, and
	// LineProximityStep is the distance that costs one point.
	ScoreLineProximityMax = 20
	LineProximityStep     = 10
)

// Candidate is one node that could be the target of a reference.
type Candidate struct {
	ID            string
	Kind          string
	Name          string
	QualifiedName string
	FilePath      string
	Language      string
	StartLine     int
	IsExported    *bool
	// Visibility is the extractor's declaration-level modifier ("public", "private",
	// "protected", "internal"), or "" when the language has none.
	//
	// Distinct from IsExported, which encodes Go's case-based rule: Rust's `pub(crate)`
	// and Java's package-private are not expressible as "exported or not", and the Rust
	// tier needs the raw value to decide module scope.
	Visibility string
}

// Reference is one unresolved reference to resolve.
type Reference struct {
	FromNodeID   string
	FromFileName string
	FromLanguage string
	Name         string
	Kind         string
	Line         int
	Column       int
	// ReceiverType is the inferred type of the expression the reference is called
	// on, when it can be inferred (`err.Error()` where `err` is an `error`).
	//
	// Empty means "not inferred", which is the normal case: Go's receiver types come
	// from type checking, and this tool deliberately does not run one. When it IS
	// known it narrows the candidate set to that type's methods, which is the single
	// largest accuracy gain available on a Go tree.
	ReceiverType string
}

// Score computes one candidate's score against a reference.
//
// The same-file line-proximity term is added only when both live in the same file,
// matching the reference implementation: line numbers across different files are
// unrelated numbering, so comparing them is meaningless.
func Score(ref *Reference, cand *Candidate) float64 {
	var score float64

	if cand.FilePath == ref.FromFileName {
		score += ScoreSameFile
	}

	score += float64(Proximity(ref.FromFileName, cand.FilePath))

	if cand.Language == ref.FromLanguage {
		score += ScoreSameLanguage
	} else {
		score += ScoreCrossLanguage
	}

	switch ref.Kind {
	case "calls":
		if cand.Kind == "function" || cand.Kind == "method" {
			score += ScoreKindForCall
		}
	case "instantiates":
		switch cand.Kind {
		case "class", "struct", "union", "interface":
			score += ScoreKindForInstantiate
		}
	case "decorates":
		switch cand.Kind {
		case "function", "method":
			score += ScoreKindForDecorator
		case "class", "interface":
			score += ScoreClassForDecorator
		}
	}

	// A nil pointer means the extractor did not report the flag, which is not the
	// same as reporting false: only a reported true earns the bonus.
	if cand.IsExported != nil && *cand.IsExported {
		score += ScoreExported
	}

	if cand.FilePath == ref.FromFileName && cand.StartLine > 0 {
		distance := math.Abs(float64(cand.StartLine - ref.Line))
		bonus := ScoreLineProximityMax - distance/LineProximityStep
		if bonus > 0 {
			score += bonus
		}
	}

	return score
}

// Proximity is the directory-overlap bonus: ScorePerSharedDir per leading segment
// in common, capped at ScoreProximityCap.
func Proximity(fromFile, candFile string) int {
	a := splitDirs(fromFile)
	b := splitDirs(candFile)
	shared := 0
	limit := len(a)
	if len(b) < limit {
		limit = len(b)
	}
	for i := 0; i < limit; i++ {
		if a[i] != b[i] {
			break
		}
		shared++
	}
	if shared*ScorePerSharedDir > ScoreProximityCap {
		return ScoreProximityCap
	}
	return shared * ScorePerSharedDir
}

// splitDirs returns the directory segments of a path, dropping the file name.
//
// Both separators are handled because the index is built from paths as the
// platform reports them, and a Windows tree mixes `\` with the `/` the extractor
// sometimes produces.
func splitDirs(path string) []string {
	var parts []string
	start := 0
	for i := 0; i < len(path); i++ {
		if path[i] == '/' || path[i] == '\\' {
			if i > start {
				parts = append(parts, path[start:i])
			}
			start = i + 1
		}
	}
	return parts
}

// Selection is the outcome of picking among candidates.
type Selection struct {
	// Winner is the chosen candidate, nil when there were none.
	Winner *Candidate
	// Score is the winner's score.
	Score float64
	// Tied lists every candidate that scored the same as the winner, sorted by ID.
	// A single-element list means the choice was unambiguous — including this field
	// in the edge's metadata is what lets a consumer distinguish a certain edge from
	// a plausible one.
	Tied []Candidate
	// Ambiguous reports len(Tied) > 1.
	Ambiguous bool
	// Suppressed is how many candidates were removed by receiver narrowing.
	Suppressed int
}

// Select picks the best candidate.
//
// Ties are broken deterministically: same file first, then nearest start line, then
// smallest id. That order is a judgement, not a reproduction — the reference
// implementation has no rule here at all, which the measurement showed by failing
// to match any of four plausible deterministic rules (best agreement 37%).
//
// The important property is not which rule is used but that the same input always
// produces the same output, so an index built twice is identical and a test can
// assert on it.
func Select(ref *Reference, candidates []Candidate) Selection {
	if len(candidates) == 0 {
		return Selection{}
	}

	// A same-language candidate always outscores a cross-language one, so when any
	// exists the cross-language ones cannot win. Filtering them out first is what
	// the reference implementation does as an optimization, but here it also keeps
	// the tie set meaningful: a cross-language namesake is not a real alternative
	// and listing it would make ambiguous edges look more common than they are.
	pool := candidates
	if hasSameLanguage(ref.FromLanguage, candidates) {
		pool = make([]Candidate, 0, len(candidates))
		for _, cand := range candidates {
			if cand.Language == ref.FromLanguage {
				pool = append(pool, cand)
			}
		}
	}

	// Receiver narrowing, when the reference tells us its receiver's type.
	//
	// This is the check that makes Go method calls tractable. Without it every
	// `err.Error()` is a contest between every `Error` method in the tree — 398 of
	// them on this repository, all scoring the same because nothing in the scoring
	// formula distinguishes them. Narrowing to the methods of the receiver's type
	// turns that from a tie into an answer, or into no candidates — both better than
	// a guess.
	suppressed := 0
	if ref.ReceiverType != "" {
		narrowed := make([]Candidate, 0, len(pool))
		for _, cand := range pool {
			if isMethodOfType(&cand, ref.ReceiverType) {
				narrowed = append(narrowed, cand)
			}
		}
		// Only narrow when it leaves something: a receiver type that matches no
		// method (because the extractor inferred it from an interface, say) must not
		// turn a resolvable reference into a miss.
		if len(narrowed) > 0 {
			suppressed = len(pool) - len(narrowed)
			pool = narrowed
		}
	}

	best := math.Inf(-1)
	var winners []Candidate
	for i := range pool {
		score := Score(ref, &pool[i])
		switch {
		case score > best:
			best = score
			winners = winners[:0]
			winners = append(winners, pool[i])
		case score == best:
			winners = append(winners, pool[i])
		}
	}
	if len(winners) == 0 {
		return Selection{}
	}

	sort.Slice(winners, func(i, j int) bool {
		return lessTie(ref, &winners[i], &winners[j])
	})

	winner := winners[0]
	return Selection{
		Winner:     &winner,
		Score:      best,
		Tied:       winners,
		Ambiguous:  len(winners) > 1,
		Suppressed: suppressed,
	}
}

// isMethodOfType reports whether a candidate is a method whose owner type is
// `typeName`.
//
// Go's qualified names are `pkg.Type.Method` (or `pkg.Func` at package scope), so the
// owner is the segment before the method name. Matching that segment is what keeps
// `(*File).Close` from being confused with `(*Conn).Close`: both are `Close`, and on
// this repository that was the difference between a tie and an answer.
//
// Pointer and value receivers qualify identically (`(*File).Close` and `(File).Close`
// both reduce to `File`), so no dereference handling is needed here.
func isMethodOfType(cand *Candidate, typeName string) bool {
	if cand.Kind != "method" {
		// A non-method cannot be the receiver's method; it is excluded rather than
		// kept because the receiver type was asserted, not guessed.
		return false
	}
	owner := ownerTypeOf(cand.QualifiedName)
	if owner == "" {
		return false
	}
	// Strip what an extractor may have left on the type name.
	if index := strings.LastIndexByte(owner, ']'); index >= 0 {
		owner = owner[index+1:]
	}
	owner = strings.TrimLeft(owner, "*(")
	owner = strings.TrimRight(owner, ")")
	if dot := strings.LastIndexByte(owner, '.'); dot >= 0 {
		owner = owner[dot+1:]
	}
	return owner == typeName
}

// ownerTypeOf returns the segment before the final one in a qualified name.
//
// Separators differ by language: Go and TypeScript use `.`, C++ and Ruby use `::`,
// PHP a backslash. Handling all three costs a few lines and keeps the receiver rule
// usable if another language tier is added later.
func ownerTypeOf(qualifiedName string) string {
	if qualifiedName == "" {
		return ""
	}
	cut := -1
	for _, sep := range []string{"::", ".", "\\"} {
		if index := strings.LastIndex(qualifiedName, sep); index > cut {
			cut = index
		}
	}
	if cut < 0 {
		return ""
	}
	head := qualifiedName[:cut]
	for _, sep := range []string{"::", ".", "\\"} {
		if index := strings.LastIndex(head, sep); index >= 0 {
			return head[index+len(sep):]
		}
	}
	return head
}

// lessTie is the deterministic tie-break: same file, then nearest line, then id.
func lessTie(ref *Reference, a, b *Candidate) bool {
	aSame := a.FilePath == ref.FromFileName
	bSame := b.FilePath == ref.FromFileName
	if aSame != bSame {
		return aSame
	}
	aDist := absInt(a.StartLine - ref.Line)
	bDist := absInt(b.StartLine - ref.Line)
	if aDist != bDist {
		return aDist < bDist
	}
	return a.ID < b.ID
}

func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func hasSameLanguage(language string, candidates []Candidate) bool {
	for i := range candidates {
		if candidates[i].Language == language {
			return true
		}
	}
	return false
}
