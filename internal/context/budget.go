package context

import "sort"

// Token budget, and what to do when the context does not fit.
//
// The degradation ladder:
//
//	full → range → preview → metadata → removed
//
// **Degrade first, evict last.** Degrading keeps the information as "the model
// still knows it is there and can read it again"; deleting turns it into
// nothing.
//
// **It only ever goes down.** Once a level has dropped it does not come back
// because this round happens to have room. That rule follows directly from cache
// stability: `full → range → full` makes the prompt differ every round, and the
// provider's prefix cache is computed over the longest common prefix — every
// token after the first changed byte is billed as a miss, at roughly fifty times
// the price.
//
// The cost, stated plainly: late in a long turn, artifacts degraded early do not
// recover their detail. To get the full text back the model can read the file
// again, which produces a **new** artifact at full level.
//
// **The oldest item is degraded first, not the newest.** It looks backwards —
// surely the thing just read in is the thing to compress? — but the price of
// degrading is set by the prefix cache: dropping an early item breaks a shorter
// prefix, while dropping the last one invalidates nearly all of it. "Which is
// unimportant" is already expressed by priority and pinned; the system prompt
// and the user's task cannot be touched there.

const (
	// AsciiTokensPerChar approximates four ASCII characters per token, the usual
	// ratio for English and code.
	AsciiTokensPerChar = 0.25
	// WideTokensPerChar: a CJK character is usually one to two tokens, so
	// counting it as one is the conservative side. This project mixes both, and
	// weighting them separately beats one flat ratio.
	WideTokensPerChar = 1.0

	// MessageOverhead is the fixed cost of one message (role, separators,
	// special tokens). Measured at three to four on OpenAI-compatible endpoints;
	// four is the conservative end.
	MessageOverhead = 4
	// SnippetOverhead is the header an Artifact renders with (path, line numbers,
	// "the following is…").
	SnippetOverhead = 12

	// DefaultReserve is how much room the answer gets. It has to be reserved: a
	// budget that lands exactly on the window leaves nowhere for the reply, and
	// the provider's 400 reads like "context too long".
	DefaultReserve = 4096
	// DefaultHeadroom is the margin. Any estimator is biased, and "packed to the
	// brim" is the worst way to use one: the next request needs a few more tokens
	// (a header, say) and goes over. Ten percent is cheap insurance.
	DefaultHeadroom = 0.1

	// DefaultCompactRatio is the history-compaction trigger, as a fraction of
	// EffectiveLimit.
	//
	// The denominator is deliberate. EffectiveLimit is already "window minus
	// reply reserve minus headroom" — the part this layer may actually use. Using
	// the raw window would place the trigger outside it (a 200K window gives an
	// effective limit of 176K, while 90% of the raw window is 180K), which means
	// compaction always runs after degradation has already been through — and
	// "last resort" requires it to fire while degradation is running out of room.
	//
	// Why 0.9: degradation starts at EffectiveLimit, so compaction fires ten
	// percent earlier and has a whole buffer to work with. In the common shape
	// degradation then never fires at all, which is good — artifact levels hold
	// and the prefix cache jitters one less time. Not lower, because a summary is
	// a real round trip that invalidates the whole prefix once; compacting too
	// early pays every step for something that has not happened.
	DefaultCompactRatio = 0.9
)

// Estimator estimates tokens for a piece of text. Swapping in a real tokenizer
// means replacing this one function.
type Estimator func(string) int

// EstimateTokens estimates conservatively, for the reason in the package docs:
// over-estimating degrades a little early, under-estimating fails the request.
func EstimateTokens(text string) int {
	if text == "" {
		return 0
	}
	ascii, wide := 0, 0
	for _, r := range text {
		if r < 128 {
			ascii++
		} else {
			wide++
		}
	}
	return int(float64(ascii)*AsciiTokensPerChar + float64(wide)*WideTokensPerChar)
}

// Degraded records one step of degradation for the audit and the interface.
//
// It records the levels, not the body: a degraded artifact still has its text on
// disk, and the audit has no reason to copy it again.
type Degraded struct {
	ArtifactID string
	Before     Representation
	// After is empty when the item was evicted rather than degraded.
	After Representation
}

// Evicted reports whether this step removed the item from the context.
func (d Degraded) Evicted() bool { return d.After == "" }

// Budget fits a context into a token ceiling.
//
// It is pure: given items and a way to fetch their text it decides who degrades
// and returns what it did. It does not read disk, does not know about sessions
// and emits nothing — Manager wires those up.
type Budget struct {
	// MaxTokens is the model's window. Nil means the window is unknown (the
	// config did not say), and then the budget switches off entirely: a made-up
	// ceiling is worse than none, because it degrades a context that would have
	// fit and "why can the model not see the whole file" becomes unanswerable.
	MaxTokens *int

	Reserve  int
	Headroom float64
	Estimate Estimator

	// factor is the measured/estimated ratio. 1.0 means "trust the estimator".
	factor    float64
	sample    [2]int
	hasSample bool
}

// NewBudget builds a budget for a window. A nil window means "unknown".
func NewBudget(maxTokens *int) *Budget {
	return &Budget{
		MaxTokens: maxTokens,
		Reserve:   DefaultReserve,
		Headroom:  DefaultHeadroom,
		Estimate:  EstimateTokens,
		factor:    1.0,
	}
}

// Enabled reports whether a ceiling exists at all. When it does not, Fit does
// nothing but count.
func (b *Budget) Enabled() bool {
	return b.MaxTokens != nil && *b.MaxTokens > 0
}

// EffectiveLimit is what is actually available for context: window minus reply
// reserve minus headroom.
func (b *Budget) EffectiveLimit() int {
	if !b.Enabled() {
		return 0
	}
	usable := float64(*b.MaxTokens - b.Reserve)
	limit := int(usable * (1.0 - b.Headroom))
	if limit < 0 {
		return 0
	}
	return limit
}

// CompactThreshold is when history compaction should be considered. It is a
// lead time, not a second ceiling: degradation still starts at EffectiveLimit.
func (b *Budget) CompactThreshold() int {
	return int(float64(b.EffectiveLimit()) * DefaultCompactRatio)
}

// Tokens estimates after the calibration factor.
func (b *Budget) Tokens(text string) int {
	return int(float64(b.Estimate(text)) * b.factor)
}

// EstimateItems adds up what a batch of items costs at their current levels.
//
// `render` is the injection point for "turn this item into text at its current
// level". The budget must not know how rendering works — that is the renderer's
// knowledge — it only needs a way to get the current text.
func (b *Budget) EstimateItems(items []*ContextItem, render func(*ContextItem) string) int {
	total := 0
	for _, item := range items {
		if item.Removed {
			continue
		}
		total += MessageOverhead + SnippetOverhead
		if text := render(item); text != "" {
			total += b.Tokens(text)
		}
	}
	return total
}

// Calibrate corrects the estimate against the provider's measured prompt tokens.
//
// It only corrects when both numbers are substantial. In a 200-token request the
// absolute error is tiny while the ratio can be absurd (180 estimated against
// 220 measured gives 1.22), and letting that noise loose would skew every
// request for the next few hundred thousand tokens. So a small sample does
// nothing.
//
// The ratio is clamped: estimation exists to make a decision, and a factor of
// five turns the budget into a switch that is always on or always off.
func (b *Budget) Calibrate(estimated, measured int) float64 {
	if estimated < 1000 || measured < 1000 {
		return b.factor
	}
	b.sample = [2]int{estimated, measured}
	b.hasSample = true
	ratio := float64(measured) / float64(estimated)
	if ratio < 0.33 {
		ratio = 0.33
	}
	if ratio > 3.0 {
		ratio = 3.0
	}
	b.factor = ratio
	return b.factor
}

// Factor is the current calibration ratio.
func (b *Budget) Factor() float64 { return b.factor }

// Sample is the last calibration input, for `/status` and troubleshooting.
func (b *Budget) Sample() (int, int, bool) {
	return b.sample[0], b.sample[1], b.hasSample
}

// Fit brings the state under the limit, returning what this step did.
//
// The arguments divide up like this:
//
//   - `render` fetches the current text, which the estimate needs;
//   - `degrade` drops an item one level — the caller rewrites the item, because
//     "what happens to the line numbers in options" is rendering knowledge;
//   - `remove` takes an item out of the context, likewise the caller's job;
//   - `extra` is the token count of the part that **cannot** be degraded (the
//     tail note). It does not participate in degradation but must be subtracted
//     first — without it, "this fits" is a false statement;
//   - `singleStep` drops exactly one level and returns, which is what Manager
//     asks for.
//
// On singleStep: this function is "finish the job" — find a configuration that
// fits, or say honestly that it cannot. Manager passes singleStep because of
// payload stability: dropping three levels at once and dropping them over three
// steps end at the same place, but the two intermediate payloads were entirely
// different — and those tokens were already paid for. One level at a time lets
// the next step re-decide with a fresh measurement, which is what makes "just
// barely fits" reachable rather than "it degraded to the bottom and full text
// never comes back".
func (b *Budget) Fit(
	state *ContextState,
	render func(*ContextItem) string,
	degrade func(*ContextItem),
	remove func(*ContextItem),
	extra int,
	singleStep bool,
) []Degraded {
	if !b.Enabled() {
		return nil
	}

	limit := b.EffectiveLimit()
	var done []Degraded

	// The loop is bounded: every pass either drops a level or evicts an item,
	// there are four levels and finitely many items. A generous bound turns
	// "somebody's arithmetic is wrong" into an honest return rather than a hang.
	for pass := 0; pass < 4*len(state.Items)+8; pass++ {
		if extra+b.EstimateItems(state.Items, render) <= limit {
			return done
		}

		item := b.next(state.Items)
		if item == nil {
			// Everything is untouchable (pinned, or already at the bottom).
			return done
		}

		before := item.Representation
		if before != RepresentationMetadata && degrade != nil {
			degrade(item)
			done = append(done, Degraded{ArtifactID: item.ArtifactID, Before: before, After: item.Representation})
			if singleStep {
				return done
			}
			continue
		}

		if remove != nil {
			remove(item)
			done = append(done, Degraded{ArtifactID: item.ArtifactID, Before: before})
			return done
		}

		// Nothing more can be done, or the caller did not allow removal. Stop.
		// Continuing would keep picking the same item, and a loop in the budget
		// layer is the worst possible shape: it sits on every request's path.
		return done
	}

	return done
}

// next picks who gets touched. The sort key **is** the priority.
//
// Pinned items are skipped — that is the entire meaning of the field. The rest
// go by:
//
//  1. lower priority first (higher number means more important);
//  2. within a priority, dynamic before stable (the dynamic band is the one
//     that agreed to change often);
//  3. then lower sequence first — the oldest.
//
// The artifact id is the last tie-break only so the order is **completely
// determined**: the same input has to move the same item twice, or two restores
// of one session produce different contexts.
func (b *Budget) next(items []*ContextItem) *ContextItem {
	candidates := make([]*ContextItem, 0, len(items))
	for _, item := range items {
		if !item.Pinned && !item.Removed {
			candidates = append(candidates, item)
		}
	}
	if len(candidates) == 0 {
		return nil
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return lessDegradeKey(degradeKey(candidates[i]), degradeKey(candidates[j]))
	})
	return candidates[0]
}

// degradeKey is the ordering tuple. Keeping the fields in their own type makes
// the comparison readable as the rule it implements, rather than as a chain of
// `if`s spread over a comparator body.
type degradeKeyTuple struct {
	priority int
	zoneRank int
	sequence int
	id       string
}

func degradeKey(item *ContextItem) degradeKeyTuple {
	zoneRank := 1
	if item.Zone == ZoneDynamic {
		zoneRank = 0
	}
	return degradeKeyTuple{item.Priority, zoneRank, item.Sequence, item.ArtifactID}
}

// lessDegradeKey compares field by field. Go does not order structs with `<`, so
// the rule has to be spelled out — which is just as well, because it is the sort
// contract and it should be visible.
func lessDegradeKey(a, b degradeKeyTuple) bool {
	if a.priority != b.priority {
		return a.priority < b.priority
	}
	if a.zoneRank != b.zoneRank {
		return a.zoneRank < b.zoneRank
	}
	if a.sequence != b.sequence {
		return a.sequence < b.sequence
	}
	return a.id < b.id
}
