package state

import (
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
)

// The two thinking knobs.
//
// They are two questions, not one: `thinking` asks "should the model think
// first", `effort` asks "how hard should it think when it does". Merging them
// would mean "change only one" has to be expressed as "the field you did not
// send means leave it alone" — a convention every client has to remember, and
// forgetting it silently resets the other knob.
const (
	// DefaultThinking is on, because that is what the endpoint does.
	DefaultThinking = true
	// DefaultEffort is the level used when neither the session nor the model's
	// catalogue entry names one. A model entry's `reasoning_effort` wins over it;
	// this is the floor beneath that.
	DefaultEffort = "high"
)

// BroadEffortLevels is the vocabulary offered when nothing knows better.
//
// It is the endpoint's own enumeration, minus `none` (that word means "thinking
// off", which is the other knob) rather than a shortlist of our own. There used to
// be a shortlist of three, with a folding table that sent `xhigh` as `high` and
// `ultra` as `max`. That table is gone, and the reason is worth keeping: it
// changed what was sent while still showing what was typed, so the screen said one
// level and the bill described another. Guessing which of two names the endpoint
// means is not a service.
//
// Listing too much costs one visible 400 from an endpoint that does not take a
// level. Listing too little costs a level that works and that nobody can choose
// — a failure nobody reports, because it does not look like one. That asymmetry
// is why this default is broad and why a narrower list only ever comes from a
// route that declares one.
var BroadEffortLevels = []string{"minimal", "low", "medium", "high", "xhigh", "max"}

// effortScale orders every level we know, weakest first.
//
// Nothing clamps with it, and that is worth stating where the order is: the
// obvious helper to build on top of this is "the nearest level the new model
// takes", and that helper must not exist. Clamping a level a model refuses is the
// same failure as the folding table that used to live here — the request changes
// while the screen keeps saying what was typed. A refused level is reported, not
// adjusted, so the order is kept only as the definition of what "weaker" means.
var effortScale = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}

// OffAliases are the words that mean "turn thinking off". `none` is one of
// them: it is not an effort level.
var OffAliases = map[string]bool{
	"none": true, "off": true, "disabled": true, "false": true, "no": true,
}

// thinkingOnWords are the words that mean "turn thinking on".
var thinkingOnWords = map[string]bool{
	"on": true, "开": true, "true": true, "yes": true, "1": true, "enabled": true,
}

// ResolveEffort maps text onto a level that `allowed` contains.
//
// The list is an argument rather than a package variable because it is a fact
// about a route: the same word is a level on one endpoint and a 400 on the next.
// An unrecognised value yields ok=false — guessing would let `/effort hgih`
// silently become something.
func ResolveEffort(text string, allowed []string) (string, bool) {
	normalized := strings.ToLower(strings.TrimSpace(text))
	if normalized == "" {
		return "", false
	}
	for _, level := range allowed {
		if normalized == level {
			return level, true
		}
	}
	return "", false
}

// EffortAllowed reports whether a level is on the list.
func EffortAllowed(level string, allowed []string) bool {
	_, ok := ResolveEffort(level, allowed)
	return ok
}

// NormalizeEffortLevels cleans a declared list: trimmed, lower-cased, without
// blanks or duplicates, and with `none` refused. A list that ends up empty is
// reported as "nothing declared" so the caller can fall back to the broad
// default rather than to an empty menu.
func NormalizeEffortLevels(raw []string) ([]string, bool) {
	out := make([]string, 0, len(raw))
	seen := map[string]bool{}
	for _, item := range raw {
		level := strings.ToLower(strings.TrimSpace(item))
		if level == "" || OffAliases[level] || seen[level] {
			continue
		}
		seen[level] = true
		out = append(out, level)
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}

// NearestEffort is the closest level in `allowed` to `wanted`.
//
// **Nothing calls this, and that is the point of it being here.** The obvious way
// to handle "the session has a level the new model refuses" is to clamp it to the
// nearest one this function finds — and that is the exact behaviour this design
// rejects: the request would change while `/status` kept showing the level that
// was set. A refused level is reported at the next request, by the only party that
// actually knows what the model takes.
//
// It is kept, tested, and unreferenced rather than deleted so the next person who
// reaches for clamping finds the answer next to the tool instead of rewriting it.
func NearestEffort(wanted string, allowed []string) (string, bool) {
	if len(allowed) == 0 {
		return "", false
	}
	if EffortAllowed(wanted, allowed) {
		return strings.ToLower(strings.TrimSpace(wanted)), true
	}
	target := scaleIndex(wanted)
	best := ""
	bestDistance := 0
	for _, level := range allowed {
		distance := scaleIndex(level) - target
		if distance < 0 {
			distance = -distance
		}
		if best == "" || distance < bestDistance {
			best, bestDistance = level, distance
		}
	}
	return best, best != ""
}

// scaleIndex is where a level sits on the scale. An unknown level is treated as
// the default's position, because "nothing I recognise" is nearer to the middle
// than to either end.
func scaleIndex(level string) int {
	normalized := strings.ToLower(strings.TrimSpace(level))
	for index, known := range effortScale {
		if normalized == known {
			return index
		}
	}
	for index, known := range effortScale {
		if known == DefaultEffort {
			return index
		}
	}
	return 0
}

// IsOff reports whether the text means "thinking off".
func IsOff(text string) bool {
	return OffAliases[strings.ToLower(strings.TrimSpace(text))]
}

// ResolveThinking maps text onto a boolean. An unrecognised value yields
// ok=false, and the caller must not guess: the two directions of a wrong guess
// are not symmetric.
func ResolveThinking(text string) (bool, bool) {
	normalized := strings.ToLower(strings.TrimSpace(text))
	if normalized == "" {
		return false, false
	}
	if thinkingOnWords[normalized] {
		return true, true
	}
	if OffAliases[normalized] {
		return false, true
	}
	return false, false
}

// ThinkingText is the word for a boolean.
func ThinkingText(value bool) string {
	if value {
		return i18n.T("thinking.on")
	}
	return i18n.T("thinking.off")
}

// What happened to RequestFields
//
// It used to live here and returned a literal request-body fragment —
// `reasoning_effort` plus an `extra_body` object holding the `thinking` marker —
// which put wire knowledge in the configuration layer. That was defensible while
// there was one protocol. With three it is not: the Messages shape wants
// `thinking: {type, budget_tokens}` and has never heard of `reasoning_effort`,
// while the Responses shape wants `reasoning.effort`, so a function here that named
// any of those fields would have to branch on the protocol of a route it cannot
// see, and the configuration layer would slowly fill up with the union of every
// vendor's spelling.
//
// So this layer now answers only the question it owns — "is thinking on, and at
// what level" — and `internal/model`'s dialects turn that into a body. The two
// knobs themselves are unchanged, and so is the asymmetry below.
//
// **The asymmetry is the whole point of having two knobs**: when thinking is off,
// only the disabled marker is sent and no effort level goes out at all. Sending
// both would be asking the endpoint to reconcile a contradiction, and whichever way
// it resolves it, the bill shows it. Each dialect applies that rule in its own
// vocabulary.

// Summary is the one-line description of the two knobs.
func Summary(thinking bool, effort string) string {
	return i18n.T("reasoning.summary", "state", ThinkingText(thinking), "effort", effort)
}
