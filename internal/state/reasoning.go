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

// RequestFields builds the endpoint parameters for the two knobs.
//
// Note the asymmetry, which is the whole point of having two knobs: when
// thinking is off, only the disabled marker is sent and no `reasoning_effort`
// goes out at all. Sending both would be asking the endpoint to reconcile a
// contradiction, and whichever way it resolves it, the bill shows it.
//
// **`extra_body` is a channel, not a field name.** It is how a caller says
// "this key does not fit the typed request object, merge it into the body" — the
// OpenAI SDK does exactly that, which is why the previous generation could write
// `thinking` here even though the SDK has no type for it. A caller that builds
// the JSON itself must do the same merge; `model.applyRequestFields` is the one
// place that does. Writing the map across verbatim sends the literal string
// "extra_body" to the endpoint and no `thinking` at all.
func RequestFields(thinking bool, effort string) map[string]any {
	if thinking {
		return map[string]any{
			"reasoning_effort": effort,
			"extra_body":       map[string]any{"thinking": map[string]any{"type": "enabled"}},
		}
	}
	return map[string]any{
		"extra_body": map[string]any{"thinking": map[string]any{"type": "disabled"}},
	}
}

// Summary is the one-line description of the two knobs.
func Summary(thinking bool, effort string) string {
	return i18n.T("reasoning.summary", "state", ThinkingText(thinking), "effort", effort)
}
