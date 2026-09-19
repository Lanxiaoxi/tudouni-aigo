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
	// DefaultEffort matches the endpoint's default.
	DefaultEffort = "high"
)

// EffortLevels are the levels the interface offers.
//
// The endpoint also accepts minimal/medium/xhigh/ultra; those fold into these
// three (see EffortAliases) and are deliberately not listed — the same result at
// the same price under a second name is not a second choice.
var EffortLevels = []string{"low", "high", "max"}

// EffortAliases folds the endpoint's extra names onto the three we show.
var EffortAliases = map[string]string{
	"minimal": "low",
	"medium":  "high",
	"xhigh":   "high",
	"ultra":   "max",
}

// OffAliases are the words that mean "turn thinking off". `none` is one of
// them: it is not an effort level.
var OffAliases = map[string]bool{
	"none": true, "off": true, "disabled": true, "false": true, "no": true,
}

// thinkingOnWords are the words that mean "turn thinking on".
var thinkingOnWords = map[string]bool{
	"on": true, "开": true, "true": true, "yes": true, "1": true, "enabled": true,
}

// ResolveEffort maps text onto a level. An unrecognised value yields ok=false:
// guessing would let `/effort hgih` silently become something.
func ResolveEffort(text string) (string, bool) {
	normalized := strings.ToLower(strings.TrimSpace(text))
	if normalized == "" {
		return "", false
	}
	for _, level := range EffortLevels {
		if normalized == level {
			return level, true
		}
	}
	if folded, ok := EffortAliases[normalized]; ok {
		return folded, true
	}
	return "", false
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
