package memory

import (
	"fmt"
	"sort"
	"strings"
	"unicode"
)

// Retrieval, first version: deterministic keyword and path matching.
//
// No vectors, and that is a choice rather than a shortcut. A memory corpus in one
// workspace is tens of rows, the queries are error messages and task sentences, and
// an embedding index would add a service, a failure mode and an unexplainable
// answer ("why did it recall that?") to solve a problem that does not exist yet at
// this size. What it would not add is the property that matters most here: a
// person looking at "3 memories recalled" can check the reasoning, because the
// score is a sum of cues they can see.

// Query is one retrieval request.
type Query struct {
	// Text is what is being looked for: the user's message, or an error text.
	Text string
	// Paths are workspace-relative paths in play, when the caller knows them. They
	// are used two ways: as a relevance cue, and to filter memories scoped to a
	// different part of the tree.
	Paths []string
	// Tags narrows the search. Empty means "any".
	Tags []string
	// Limit caps the results. Zero means the caller does not care and the config's
	// `max_results` applies.
	Limit int
	// MinScore is the relevance floor; zero means the config's value applies.
	MinScore float64
}

// Result is one hit, with the entry loaded so the caller can render it.
type Result struct {
	Entry *Entry
	Score float64
	// Reasons names the cues that matched ("trigger: ...", "tag: gradle", "scope:
	// android/"). They are carried for two audiences: the model, which is told why a
	// memory was recalled so it can judge whether the same conditions hold, and a
	// person reading the panel.
	Reasons []string
}

// Weights. They are the whole ranking policy, in one place, because a scoring rule
// spread over a function is a rule nobody can tune or explain.
const (
	// weightTrigger is a hit on a trigger. Triggers are what somebody wrote down as
	// "recognise this next time" -- an error string, a command, a topic in the
	// person's own words -- so they outrank everything else by a wide margin.
	weightTrigger = 8.0
	// weightTitle is a word of the title, which is the memory's own summary.
	weightTitle = 3.0
	// weightTag is a declared tag. Coarse by nature, so worth less than the title.
	weightTag = 2.0
	// weightScope is a declared path that the query is about.
	weightScope = 2.0
	// weightDigest is a word found only in the body. It is the weakest signal on
	// purpose: every memory about Go contains "go", and a body hit alone must not be
	// enough to inject something (see Config.MinScore).
	weightDigest = 1.0
	// weightVerified and weightObserved are the confidence bonus. `inferred` adds
	// nothing: it is not a penalty, but it must not be able to push a weak match over
	// the floor, because an inferred note is the one most likely to be wrong.
	//
	// The bonus is added **after** the relevance floor is applied (see scoreEntry), so
	// being trustworthy can break a tie but can never make something relevant.
	weightVerified = 1.2
	weightObserved = 0.4

	// titleHitCap / tagHitCap / digestHitCap bound each kind of contribution, so one
	// long body cannot outscore a precise trigger by sheer repetition.
	titleHitCap  = 3
	tagHitCap    = 2
	digestHitCap = 6
)

// prepared is one query after tokenising, so a loop over many memories does not
// re-tokenise the same text.
type prepared struct {
	text   string
	tokens []string
	set    map[string]bool
	paths  []string
	tags   []string
}

func prepare(query Query) prepared {
	text := strings.ToLower(strings.TrimSpace(query.Text))
	tokens := tokenize(text)
	set := make(map[string]bool, len(tokens))
	for _, token := range tokens {
		set[token] = true
	}
	return prepared{text: text, tokens: tokens, set: set, paths: query.Paths, tags: query.Tags}
}

// scoreEntry ranks one memory against one query.
//
// Two numbers come back, and the split matters: **cue** is what actually matched, and
// **total** adds the confidence bonus. The relevance floor is applied to the cue
// alone, so a `verified` memory that shares one body word with the query cannot reach
// the floor on the strength of being trustworthy. Trustworthiness says "believe this
// if it applies", not "this applies".
//
// The `entry` parameter is unused today and kept in the signature because the natural
// next cue -- the body's own structure, a section that matches -- needs the whole
// entry, and changing a scoring signature later would touch every caller.
func scoreEntry(row *IndexEntry, entry *Entry, q prepared) (total, cue float64, reasons []string) {
	_ = entry

	// Triggers first: an exact phrase hit is the strongest thing that can happen, and
	// a trigger that is only partly present still counts, in proportion. The partial
	// case is not politeness -- it is the difference between recognising the same
	// Gradle failure after somebody changed one word of it, and not.
	triggerHits := 0
	for _, trigger := range row.Triggers {
		needle := strings.ToLower(strings.TrimSpace(trigger))
		if needle == "" {
			continue
		}
		if triggerHits >= 3 {
			break
		}
		if q.text != "" && strings.Contains(q.text, needle) {
			cue += weightTrigger
			triggerHits++
			reasons = append(reasons, "trigger: "+oneLine(trigger, 80))
			continue
		}
		if coverage := tokenCoverage(needle, q.set); coverage >= 0.5 {
			cue += weightTrigger * coverage
			triggerHits++
			reasons = append(reasons, fmt.Sprintf("trigger: %s (%.0f%% match)", oneLine(trigger, 80), coverage*100))
		}
	}

	// Title, tag and body words. `strings.Contains` rather than a token-set lookup so
	// a compound or a path segment still matches its prefix; the caps keep it from
	// turning into a substring free-for-all.
	title := strings.ToLower(row.Title)
	titleHits := 0
	for _, token := range q.tokens {
		if titleHits >= titleHitCap {
			break
		}
		if strings.Contains(title, token) {
			cue += weightTitle
			titleHits++
			if len(reasons) < 6 {
				reasons = append(reasons, "title: "+token)
			}
		}
	}

	tagHits := 0
	for _, tag := range row.Tags {
		if tagHits >= tagHitCap {
			break
		}
		normalised := strings.ToLower(strings.TrimSpace(tag))
		if normalised == "" {
			continue
		}
		matched := false
		for _, token := range q.tokens {
			if token == normalised || strings.Contains(normalised, token) {
				matched = true
				break
			}
		}
		if matched {
			cue += weightTag
			tagHits++
			reasons = append(reasons, "tag: "+tag)
		}
	}

	digestHits := 0
	for _, token := range q.tokens {
		if digestHits >= digestHitCap {
			break
		}
		if rowTitleOrTriggerContains(row, token) {
			continue
		}
		if strings.Contains(row.Digest, token) {
			cue += weightDigest
			digestHits++
		}
	}
	if digestHits > 0 && len(reasons) < 8 {
		reasons = append(reasons, fmt.Sprintf("body: %d word(s)", digestHits))
	}

	// Scope: a declared path that the query is about is a real cue -- "this is the
	// android part of the build" -- and it is worth less than a trigger because the
	// path alone does not say the memory applies.
	if len(row.ScopePaths) > 0 && len(q.paths) > 0 {
		for _, scoped := range row.ScopePaths {
			for _, path := range q.paths {
				if pathMatches(scoped, path) {
					cue += weightScope
					reasons = append(reasons, "scope: "+scoped)
					break
				}
			}
		}
	}

	// An entry that matched nothing at all is not relevant, whatever it claims about
	// its own reliability. Injecting a memory because it exists is the exact failure
	// mode the design spends a paragraph on.
	if len(reasons) == 0 {
		return 0, 0, nil
	}

	bonus := 0.0
	switch row.Confidence {
	case ConfidenceVerified:
		bonus = weightVerified
	case ConfidenceObserved:
		bonus = weightObserved
	}
	return cue + bonus, cue, reasons
}

// rowTitleOrTriggerContains reports whether a token already counted as a title or
// trigger hit, so the body pass does not count the same word again.
func rowTitleOrTriggerContains(row *IndexEntry, token string) bool {
	if strings.Contains(strings.ToLower(row.Title), token) {
		return true
	}
	for _, trigger := range row.Triggers {
		if strings.Contains(strings.ToLower(trigger), token) {
			return true
		}
	}
	return false
}

// scopeFiltered reports whether a memory is scoped away from this query.
//
// A memory that declares `scope.paths` is saying "this applies to android/". When the
// caller has told us which paths are in play and none of them is inside (or above)
// that scope, the memory is about a different part of the tree and recalling it wastes
// the one slot it would occupy. With no paths in the query nothing is filtered:
// "unknown" must not be read as "does not apply".
func scopeFiltered(row *IndexEntry, q prepared) bool {
	if len(row.ScopePaths) == 0 || len(q.paths) == 0 {
		return false
	}
	for _, scoped := range row.ScopePaths {
		for _, path := range q.paths {
			if pathMatches(scoped, path) {
				return false
			}
		}
	}
	return true
}

// pathMatches is prefix matching on normalised paths.
func pathMatches(scoped, path string) bool {
	a := strings.Trim(strings.ReplaceAll(scoped, "\\", "/"), "/")
	b := strings.Trim(strings.ReplaceAll(path, "\\", "/"), "/")
	if a == "" || b == "" {
		return true
	}
	return a == b || strings.HasPrefix(b, a+"/") || strings.HasPrefix(a, b+"/")
}

// tokenCoverage is how much of a phrase is present in a token set.
func tokenCoverage(phrase string, set map[string]bool) float64 {
	tokens := tokenize(strings.ToLower(phrase))
	if len(tokens) == 0 {
		return 0
	}
	matched := 0
	for _, token := range tokens {
		if set[token] {
			matched++
		}
	}
	return float64(matched) / float64(len(tokens))
}

// tokenize splits text into the units this build matches on.
//
// Latin words are split on non-letters, and a one-letter word is dropped because it is
// noise ("a", "I"). CJK text is the opposite problem: there are no spaces, so a word is
// not recoverable without a dictionary. The compromise is bigrams -- "方案" and "设计"
// out of "方案设计" -- which is the standard cheap answer and is good enough for
// recognition: it lets a task sentence of "帮我看看这个构建问题的方案" hit a memory
// triggered on "方案设计" through the shared bigram.
func tokenize(text string) []string {
	var out []string
	seen := map[string]bool{}
	emit := func(token string) {
		if token == "" || seen[token] {
			return
		}
		seen[token] = true
		out = append(out, token)
	}

	var latin strings.Builder
	var cjk []rune
	flushLatin := func() {
		if latin.Len() >= 2 {
			emit(latin.String())
		}
		latin.Reset()
	}
	flushCJK := func() {
		switch len(cjk) {
		case 0:
		case 1:
			emit(string(cjk))
		default:
			for index := 0; index+1 < len(cjk); index++ {
				emit(string(cjk[index : index+2]))
			}
			// The whole segment as well when it is short: an exact trigger of two to
			// four characters then matches through one token rather than two.
			if len(cjk) <= 4 {
				emit(string(cjk))
			}
		}
		cjk = cjk[:0]
	}

	for _, r := range strings.ToLower(text) {
		switch {
		case isCJK(r):
			flushLatin()
			cjk = append(cjk, r)
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			flushCJK()
			latin.WriteRune(r)
		default:
			flushLatin()
			flushCJK()
		}
	}
	flushLatin()
	flushCJK()
	return out
}

// isCJK reports whether a rune is part of a script written without spaces.
func isCJK(r rune) bool {
	switch {
	case unicode.Is(unicode.Han, r):
		return true
	case unicode.Is(unicode.Hiragana, r), unicode.Is(unicode.Katakana, r):
		return true
	case unicode.Is(unicode.Hangul, r):
		return true
	default:
		return false
	}
}

// sortResults orders hits: score first, then newest, then id.
//
// The last two are not scoring and they exist so the order is total. Without them two
// memories with equal scores come back in whatever order the index happened to hold,
// and the same question answered twice recalls a different pair -- which makes "the
// memory system is flaky" impossible to distinguish from a real disagreement.
func sortResults(results []Result) {
	sort.SliceStable(results, func(i, j int) bool {
		if results[i].Score != results[j].Score {
			return results[i].Score > results[j].Score
		}
		if results[i].Entry.UpdatedAt != results[j].Entry.UpdatedAt {
			return results[i].Entry.UpdatedAt > results[j].Entry.UpdatedAt
		}
		return results[i].Entry.ID < results[j].Entry.ID
	})
}

// oneLine flattens text for a reason string or a row.
func oneLine(text string, limit int) string {
	flat := strings.Join(strings.Fields(strings.ReplaceAll(text, "\n", " ")), " ")
	runes := []rune(flat)
	if len(runes) <= limit {
		return flat
	}
	return string(runes[:limit]) + "…"
}
