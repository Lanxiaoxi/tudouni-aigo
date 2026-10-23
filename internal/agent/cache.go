package agent

import (
	"fmt"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/context"
)

// The two caches below exist for one reason: both of them used to be O(history)
// **per step**, which for a turn means O(steps × history) — quadratic in the
// length of the conversation, on the path that runs before every request.
//
// Neither of them changes much between two steps of one turn. A tool result is
// appended; the ledger's levels move only when the budget degrades something; the
// fold boundary moves only when compaction runs. Everything before those points
// renders to the same bytes it rendered to on the previous step, and re-deriving
// it (reading each artifact body out of the store and re-cutting it, parsing each
// body to price it) was the most expensive thing this layer did.
//
// The one rule the caches depend on is that **history is append-only**. A message
// is written once, before it is appended, and never edited afterwards; a session
// that rewrote one in place would serve a stale render. `dropCache` is how a
// caller that really does rewrite says so.

// messageCost is one history message's contribution to the fixed overhead.
//
// It is split in two because the two halves scale differently: `flat` is the
// per-message overhead and the price of any picture nothing else is pricing, and
// `scaled` is a **raw** estimate that only becomes a token count once the
// budget's calibration factor is applied. Keeping them apart is what lets the
// factor change every step (it is re-learned from each response) without
// invalidating the cache.
type messageCost struct {
	flat   int
	scaled int
}

// renderKey is every fact the cached render and costs depend on.
//
// It is compared by value, which is the whole point: a key that matched wrongly
// would send a payload whose message bodies disagree with the levels the budget
// believes it set, and nothing downstream would notice — the request would simply
// cost more, or contain less, than the ledger says.
type renderKey struct {
	// messages is how many history messages exist. Append-only means a larger
	// number is an extension, not a different history.
	messages int
	// folded is how many of them compaction has folded away.
	folded int
	// summary identifies the stand-in message for that stretch: a new summary (or
	// a missing one, said differently) is a different payload.
	summary string
	// version is the ledger's rendering fingerprint: it changes exactly when an
	// item's level, band, priority or presence changes — that is, exactly when a
	// tool message renders to different text. The version **counter** would be the
	// obvious key and is the wrong one: it also moves for changes that reach no
	// payload, and each of those would throw away the whole render for nothing.
	version string
	// images is what the vision gate answered. A `/model` switch can turn pictures
	// into sentences mid-session, and the render depends on it.
	images bool
	// rendered records whether there was a renderer at all. Without a context layer
	// messages pass through untouched, which is a different result from any render.
	rendered bool
}

// payloadCache is one turn's rendered history and its per-message costs.
//
// Both live in one cache because both are built by walking the same messages, and
// two caches would mean two chances for one of them to be extended while the other
// is rebuilt — which is how a payload and the overhead it was budgeted against
// come apart.
type payloadCache struct {
	key      renderKey
	built    bool
	messages []map[string]any
	costs    []messageCost
}

// dropCache forgets everything. It is for a caller that rewrote history in place,
// which production never does — a message is written once, before it is appended.
func (a *Agent) dropCache() { a.cache = payloadCache{} }

// cachedRender returns the rendered form of `view` and the cost of each message.
//
// The returned slice must not be appended to: it is the cache's own array, handed
// out with a capped length so that an append by the caller copies instead of
// writing into a slot the next extension will reuse.
func (a *Agent) cachedRender(
	renderer *context.Renderer,
	view []map[string]any,
	key renderKey,
) ([]map[string]any, []messageCost) {
	if a.cache.built && a.cache.key == key {
		return a.cache.messages[:len(a.cache.messages):len(a.cache.messages)], a.cache.costs
	}

	extend := a.cache.built && a.cache.extendable(key)
	if !extend {
		a.cache.messages = a.cache.messages[:0]
		a.cache.costs = a.cache.costs[:0]
	}

	for index := len(a.cache.messages); index < len(view); index++ {
		message := view[index]
		if renderer == nil {
			a.cache.messages = append(a.cache.messages, message)
		} else {
			a.cache.messages = append(a.cache.messages, renderer.RenderMessage(message))
		}
		a.cache.costs = append(a.cache.costs, a.messageCost(message))
	}
	a.cache.key = key
	a.cache.built = true
	return a.cache.messages[:len(a.cache.messages):len(a.cache.messages)], a.cache.costs
}

// extendable reports whether the cache's prefix is still the view's prefix.
//
// Everything that decides what a message renders to must be unchanged, and the
// message count may only have grown: appending cannot move a message that was
// already there.
func (c *payloadCache) extendable(key renderKey) bool {
	if key.messages < c.key.messages {
		return false
	}
	if key.folded != c.key.folded {
		return false
	}
	if key.summary != c.key.summary {
		return false
	}
	if key.version != c.key.version {
		return false
	}
	if key.images != c.key.images {
		return false
	}
	return key.rendered == c.key.rendered
}

// renderKeyFor assembles the key for one view.
//
// `messages` is the history length, not the view length: the view's head is the
// system prompt and the summary, and folding shifts it, which `folded` covers.
func (a *Agent) renderKeyFor(renderer *context.Renderer, messages, folded int, summaryKey string) renderKey {
	return renderKey{
		messages: messages,
		folded:   folded,
		summary:  summaryKey,
		version:  a.ledgerFingerprint(),
		images:   a.imagesAllowed(),
		rendered: renderer != nil,
	}
}

// ledgerFingerprint is what the ledger currently renders to, or "" when there is
// no ledger.
func (a *Agent) ledgerFingerprint() string {
	if a.Context == nil {
		return ""
	}
	return context.Fingerprint(a.Context.State)
}

// imagesAllowed asks the vision gate, and treats "nobody declared" as yes — the
// same reading `imagePolicy` documents, and the same one the renderer applies.
func (a *Agent) imagesAllowed() bool {
	if a.Vision == nil {
		return true
	}
	return a.Vision()
}

// summaryKey names the folded stretch's stand-in message.
//
// It carries the summary's artifact id rather than its text: the id is what
// `summaryMessage` looks the text up by, so "the same id" means "the same body"
// unless somebody edited an artifact in place, which nothing does.
func (a *Agent) summaryKey(compaction context.Compaction, ok bool) string {
	if !ok {
		return ""
	}
	return fmt.Sprintf("%d|%d|%s", compaction.FoldedMessages, compaction.Generation, compaction.SummaryID)
}

// messageCost prices one history message the way the fixed overhead counts it.
//
// The rules are `FixedPayloadTokens`' rules — a tool message counts only its
// reference line, a labelled picture is charged only when the ledger is not
// already charging it, the system prompt is counted elsewhere — and they live
// here now because this is the one walk over the messages.
func (a *Agent) messageCost(message map[string]any) messageCost {
	if message == nil || a.Context == nil {
		return messageCost{}
	}
	budget := a.Context.Budget

	// **A body is read through `content.Parse`, never through a type assertion.**
	// `message["content"].(string)` yields "" for an array, and an array is exactly
	// what a message carrying a picture has — so the assertion counts an image (and
	// the paragraph next to it) as **zero** tokens. The budget then believes a
	// request fits when it does not, which is the dangerous direction, and the
	// failure it produces is a 400 from the endpoint that reads like "context too
	// long" with nothing visibly over.
	body := content.Parse(message["content"])
	text := body.TextOf()

	images := 0
	for _, image := range body.Images() {
		if a.Context.Item(image.ArtifactID) != nil {
			continue
		}
		images += context.ImageRefCost(image)
	}

	// **The system prompt is skipped.** FoldedView brings it in (correctly — the
	// payload must have it) and `Measure` counts it on its own, as the one part of
	// the request that is neither an artifact nor a message. Counting it here as
	// well makes `after` **larger** than `before` after a compaction, so "how much
	// did that save" comes out negative every time.
	if message["role"] == "system" {
		return messageCost{}
	}
	if message["role"] == "tool" {
		// The message's own fixed overhead was counted by the item estimate; only
		// the reference line is added here. A tool message with no artifact id is
		// passed through verbatim at render time, so it has to be counted in full:
		// missing it is under-estimating, and under-estimating fails the request.
		cost := messageCost{scaled: budget.Estimate(text)}
		if context.ArtifactIDOf(message) == "" {
			cost.flat = context.MessageOverhead
		}
		return cost
	}

	cost := messageCost{flat: context.MessageOverhead + images, scaled: budget.Estimate(text)}
	// The JSON the assistant sent when it said "I will call write_file" stays in
	// history and is re-sent every round, and it can be long (an entire file body).
	// Counting only text content would miss it entirely.
	if calls, ok := message["tool_calls"].([]any); ok {
		for _, entry := range calls {
			call, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			function, ok := call["function"].(map[string]any)
			if !ok {
				continue
			}
			name, _ := function["name"].(string)
			arguments, _ := function["arguments"].(string)
			cost.scaled += budget.Estimate(name) + budget.Estimate(arguments)
		}
	}
	return cost
}
