package agent

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/audit"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/context"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
)

// The agent's half of the context system: turning history into a payload, and
// turning older history into a summary.
//
// This file is the one door between history and request. Everything else in the
// context package deals with artifacts and states; what happens here is the
// substitution — a tool message's body is fetched from the store, and a folded
// stretch is replaced by a summary.

// renderer builds something that turns messages into a payload.
//
// A fresh one each time rather than a cached one: it holds a couple of fields and
// no state, and caching it would mean handling "the session was switched" — the
// same trap the Session object fell into before it was moved out of the agent.
//
// The vision gate is attached here, at the one place a renderer is built, and that
// is deliberate: it has to be consulted on **every** render rather than once when a
// picture is attached, because the model can be switched mid-session. A picture
// attached while a vision model was in use must not be sent to the model
// afterwards — and, just as important, it must not **fail** the turn either. Both
// of those are decided here: the renderer turns such a picture into a sentence
// naming it, which is a payload the endpoint accepts and a context the model can
// act on.
func (a *Agent) renderer() *context.Renderer {
	if a.Context == nil {
		return nil
	}
	renderer := context.NewRenderer(a.Context.Store, a.Context)
	renderer.AllowImages = a.imagePolicy()
	return renderer
}

// imagePolicy reports whether pictures may be sent, and why not when they may not.
//
// Nil `Vision` means "nobody declared", and it is read as **yes**: the runtime
// always supplies the predicate, so the nil case is a test or a one-shot agent with
// no catalogue behind it, and suppressing pictures there would silently change what
// those callers send. The refusal this exists for comes from the catalogue, where
// `vision` defaults to false and a model that has not declared it does not get
// pictures.
func (a *Agent) imagePolicy() func() (bool, string) {
	if a.Vision == nil {
		return nil
	}
	return func() (bool, string) {
		if a.Vision() {
			return true, ""
		}
		return false, i18n.T("agent.vision.render_reason", "model", a.Chat.ModelName())
	}
}

// noteText is the session-state line at the tail of the payload. It is per-round,
// so it never enters history.
//
// The empty-response nudge rides here for the same reason and by the same rule:
// it describes **this request**, not the conversation, and a copy of it in the
// history would be read as a person complaining about the model — a line the
// session would then carry forever. It also belongs at the very end: the retry's
// prefix is the failed request's prefix unchanged, so the prompt cache of a long
// session survives a nudge, which it would not if the line went in earlier.
func (a *Agent) noteText() string {
	var parts []string
	if a.Notes != nil {
		if note := strings.TrimSpace(a.Notes()); note != "" {
			parts = append(parts, note)
		}
	}
	if a.emptyNudged {
		parts = append(parts, emptyNudge)
	}
	return strings.Join(parts, "\n\n")
}

// Payload is what actually goes out for this request.
//
// Two paths, one shape:
//
//   - with a context, history is rendered at each item's level (tool message
//     content comes from the artifact store);
//   - without one, history goes as-is.
//
// The two are identical in order and shape, differing only in where a tool
// message's body comes from. That is deliberate: the context replaces the source
// of content, not the shape of the payload.
//
// The trailing note (task list, skills, background jobs) never enters
// session.Messages — it differs every round and should not be persisted. It does
// go into the context ledger, because it may well be the part that pushes an
// already-full request over.
//
// A compacted session takes one extra step: the folded messages stop appearing
// and a summary message stands in their place, so the payload reads
//
//	system │ summary(user) │ unfolded history │ trailing note
//
// The step count is deliberately absent. The model can do nothing with
// "steps remaining" — no action makes it larger, and it cannot tell where the
// steps went — so reporting it every round produces anxiety and no behavioural
// change. What changes behaviour is a policy, and the policy is static: the
// prompt says there is a finite budget and to finish the job. That sentence is
// byte-identical every round, so it lands in the cached prefix.
func (a *Agent) Payload() []map[string]any {
	renderer := a.renderer()
	note := a.noteText()

	// The summary (nil when never compacted). It sits **after** the system
	// prompt: that is the first section of the request and the only part that
	// reliably hits the prefix cache.
	summary := a.summaryMessage()
	view, folded, summaryKey := a.foldedViewWithKey(summary)

	// Every message goes through the renderer, and the ones this layer has nothing
	// to say about come back **unchanged** — not copied, not normalised. That is
	// what keeps a picture-free session byte-for-byte identical to what it sent
	// before pictures existed, and the prefix cache is priced on exactly that.
	//
	// A message is rewritten in two cases, and both are about a reference rather
	// than about text: a tool result (its body comes from the artifact store at the
	// level the budget decided), and a user message carrying a picture (the
	// picture's level is decided the same way, and it may have degraded to a
	// sentence since).
	//
	// **The rendered list is carried between steps** (see cache.go): rendering a
	// tool message reads its body out of the store and re-cuts it to the current
	// level, and doing that for the whole history on every step made one turn
	// quadratic in the length of the conversation. A step that only appended
	// messages renders the new tail.
	key := a.renderKeyFor(renderer, a.Session.MessageCount(), folded, summaryKey)
	rendered, costs := a.cachedRender(renderer, view, key)

	// `capacity == length` so that appending the note below copies instead of
	// writing into the slot the cache's next extension will reuse.
	messages := make([]map[string]any, len(rendered), len(rendered)+1)
	copy(messages, rendered)

	if renderer == nil {
		if note != "" {
			messages = append(messages, map[string]any{"role": "user", "content": note})
		}
		return messages
	}

	// The budget. Called every step, but only changes anything when it is
	// genuinely over — and when it does, the version moves and the
	// context_degraded event records it.
	var notes []string
	if note != "" {
		notes = append(notes, note)
	}
	a.Context.SetNotes(notes)

	fixed := a.fixedFrom(costs)
	degraded := a.Context.Fit(renderer.RenderItem, fixed)
	if len(degraded) > 0 {
		changes := make([]any, 0, len(degraded))
		for _, item := range degraded {
			after := "removed"
			if item.After != "" {
				after = string(item.After)
			}
			changes = append(changes, item.ArtifactID+":"+string(item.Before)+"->"+after)
		}
		if len(changes) > 20 {
			changes = changes[:20]
		}
		a.emit(audit.Event(audit.KindContextDegraded, a.Session.SessionID, a.runID, a.step,
			map[string]any{
				"items":     len(degraded),
				"estimated": a.Context.LastEstimate,
				"limit":     a.Context.Budget.EffectiveLimit(),
				// The fixed overhead gets its own number so that afterwards one
				// can tell whether this round was squeezed by **history** or by
				// artifacts. The two call for completely different responses —
				// one means "start a new session", the other means the budget is
				// working as designed.
				"fixed":   fixed,
				"changes": changes,
			}))
	}
	a.Session.SetContext(a.Context.State)

	if note != "" {
		messages = append(messages, map[string]any{"role": "user", "content": note})
	}
	return messages
}

// calibrate corrects the estimate ratio against a measurement.
//
// It only corrects the ratio, and does not treat the measurement as "how big the
// context is now": the measurement describes the **previous** request, and the
// context changed in between (this step's tool results just arrived). Using it
// as the current value would badly under-estimate whenever a tool returned
// something large — and under-estimating is the dangerous direction.
func (a *Agent) calibrate(usage *model.TokenUsage) {
	if a.Context == nil || usage == nil || usage.PromptTokens == 0 {
		return
	}
	a.Context.Calibrate(usage.PromptTokens)
}

// FixedPayloadTokens is how much of one request cannot be degraded.
//
// ## Why it has to exist
//
// The budget can only degrade the artifacts in the context, while half the
// payload is not artifacts at all: the system prompt, every word the user and
// the assistant said, and the `[artifact art_x · 12480 字符 · read_file]`
// reference on each tool message. They occupy the same window and nobody counts
// them.
//
// The symptom appears in every long session: artifacts all sit at zero and the
// budget still says it does not fit, with nothing left to degrade — what is over
// the window is the pile of history. The provider returns a 400 that reads like
// "context too long", and no amount of reading the context ledger shows who
// overspent.
//
// For a compacted session it measures the post-fold payload (summary plus
// unfolded history) rather than the whole history — otherwise the tens of
// thousands of tokens a compaction saved get added straight back here, and
// "compacting did nothing" while degradation keeps cutting.
//
// ## Three details that matter
//
//   - **A tool message counts only its reference line, not its body.** The body
//     is fetched at render time and counted by the budget's item estimate;
//     counting it here would be the same thing twice. The exception is a tool
//     message with no artifact_id (a legacy session, or one hydrate missed):
//     those are passed through verbatim at render time, so they have to be
//     counted in full — missing them is under-estimating, and under-estimating
//     is the dangerous side.
//   - **tool_calls arguments count.** The JSON the assistant sent when it said
//     "I will call write_file" stays in history and is re-sent every round, and
//     it can be long (an entire file body). Counting only text content would
//     miss it entirely.
//   - **Over-estimating is safe.** It degrades slightly early; under-estimating
//     fails the request outright.
//
// ## What it costs
//
// One walk per **cached message**, not per message per step. The per-message cost
// is computed once when the message is first rendered and kept beside the render
// (see cache.go), and the calibration factor is applied at the end — so a step
// that appends two tool results costs two messages, and a re-analysis of the same
// history costs a sum over cached integers.
func (a *Agent) FixedPayloadTokens() int {
	if a.Context == nil {
		return 0
	}
	summary := a.summaryMessage()
	view, folded, summaryKey := a.foldedViewWithKey(summary)
	renderer := a.renderer()
	key := a.renderKeyFor(renderer, a.Session.MessageCount(), folded, summaryKey)
	_, costs := a.cachedRender(renderer, view, key)
	return a.fixedFrom(costs)
}

// fixedFrom applies the calibration factor to the cached per-message costs.
//
// The factor is applied here rather than stored with the costs because it is
// re-learned from every response: folding it in would invalidate the whole cache
// once per step, which is exactly the cost the cache exists to avoid.
func (a *Agent) fixedFrom(costs []messageCost) int {
	if a.Context == nil {
		return 0
	}
	factor := a.Context.Budget.Factor()
	total := 0
	for _, cost := range costs {
		total += cost.flat
		if cost.scaled != 0 {
			total += int(float64(cost.scaled) * factor)
		}
	}
	return total
}

// --- compaction -------------------------------------------------------------

// compactionState is how far this session was folded. Not compacted is `false`.
func (a *Agent) compactionState() (context.Compaction, bool) {
	var compaction context.Compaction
	var ok bool
	a.Session.Meta().Read(func(metadata map[string]any) {
		compaction, ok = context.LoadCompaction(metadata)
	})
	return compaction, ok
}

// foldedView is every history message this request will look at: system prompt,
// summary, unfolded history.
//
// It is one function because two call sites have to see the **same** sequence:
// building the payload and measuring the fixed overhead. Computing "where does
// it start, where is the summary" twice is a second source for one fact, and the
// symptom when they disagree is a budget computed against one payload while a
// different one is sent.
//
// The summary is passed in rather than computed here: building it reads the
// artifact store, and one of the two call sites already has the object in hand.
func (a *Agent) foldedView(summary map[string]any) []map[string]any {
	view, _, _ := a.foldedViewWithKey(summary)
	return view
}

// foldedViewWithKey is `foldedView` and the two facts the render cache is keyed
// on. They come from one place because they describe one decision: the boundary
// the view was cut at, and which summary stands in for the folded stretch.
func (a *Agent) foldedViewWithKey(summary map[string]any) ([]map[string]any, int, string) {
	compaction, compacted := a.compactionState()
	folded := 0
	if compacted {
		folded = compaction.FoldedMessages
	}
	messages := a.Session.MessagesSnapshot()
	return context.FoldedView(messages, folded, summary), folded, a.summaryKey(compaction, compacted)
}

// summaryMessage is the message replacing the folded stretch. Not compacted, or
// the summary is unavailable, gives nil.
//
// The summary is an **artifact**, so it is fetched from the store. When it
// cannot be fetched (somebody deleted the directory) the honest thing is said —
// returning nil would make the model believe nothing happened in that stretch,
// which is the worst failure this layer has, because it cheerfully redoes work.
func (a *Agent) summaryMessage() map[string]any {
	state, ok := a.compactionState()
	if !ok || state.FoldedMessages == 0 {
		return nil
	}
	if a.Context == nil {
		return nil
	}
	text, found := context.SummaryText(a.Context.Store, state)
	if !found {
		return map[string]any{"role": "user", "content": context.MissingSummary(state)}
	}
	return context.SummaryMessage(text)
}

// Measure is the full cost of one request, item for item, matching Payload.
//
// It is the number used to compare before and after a compaction (the manual
// command's before/after, the context_compacted event, the `/context` screen).
// Three things need it, and all three have to be the same measurement or "how
// much was saved" gets three different answers.
//
// ## Why the last estimate cannot stand in for it
//
// That number was left by the **previous** Payload, and a compaction sits
// between two payloads: using it as "before" measures the previous request
// (shorter history), so the saving comes out negative or zero.
//
// ## Why the fixed overhead cannot stand in for it
//
// That function deliberately excludes the system prompt (the item estimate
// covers it), and the system prompt is over a thousand tokens. Comparing a
// number without it against "after" makes every compaction look like a loss.
//
// So this walks the payload's order: the item estimate, the fixed overhead, the
// system prompt, and the trailing note.
//
// Without a context it falls back to a bare estimate over the messages: such a
// session never compacts (the command answers "no context"), but the manual path
// still measures before doing nothing, and a "did nothing" answer should carry
// its two numbers rather than zeroes.
func (a *Agent) Measure() int {
	renderer := a.renderer()
	messages := a.Session.MessagesSnapshot()
	if a.Context == nil || renderer == nil {
		// A bare estimate over the messages, and it goes through the same body
		// parser as everything else: this path is what a session **without** a
		// context layer measures itself with, and such a session is exactly the
		// one where a picture sits inline in history rather than behind a
		// reference. A `.(string)` assertion here would report it as zero.
		total := 0
		for _, message := range messages {
			body := content.Parse(message["content"])
			total += context.EstimateTokens(body.TextOf())
			for _, image := range body.Images() {
				total += context.ImageRefCost(image)
			}
		}
		return total
	}

	budget := a.Context.Budget

	// 1) The artifact half.
	total := budget.EstimateItems(a.Context.State.Live(), renderer.RenderItem)
	// 2) The history half (reference lines, the user's and assistant's words, the
	//    summary, and the pictures a user message carries).
	total += a.FixedPayloadTokens()
	// 3) The system prompt: neither an artifact nor part of the fixed overhead.
	if len(messages) > 0 && messages[0]["role"] == "system" {
		system := content.Parse(messages[0]["content"]).TextOf()
		total += context.MessageOverhead + budget.Tokens(system)
	}
	// 4) The trailing note (no overlap with the fixed overhead — it never enters
	//    session.Messages).
	if note := a.noteText(); note != "" {
		total += context.MessageOverhead + budget.Tokens(note)
	}
	// The summary is already counted inside the fixed overhead, which is the only
	// place that counts it.
	return total
}

// ContextPart is one named share of a request's estimated tokens.
//
// The `Key` values are a closed set — the parts `Measure` is made of. They are
// the wire form rather than a display string: the interface owns the wording, so
// a language change never moves a protocol field.
type ContextPart struct {
	Key    string
	Tokens int
}

// The parts. Each name is one thing the runtime really sends, not a category
// invented to make a chart look full: `system` is the system prompt, `messages`
// the user's and assistant's own words, `toolResults` the reference line each
// tool message carries, `summary` the folded stretch's stand-in, `note` the
// per-round line (tasks, skills, jobs), and the four artifact buckets are the
// bodies the context layer holds, typed the way `ToolResultProcessor` types them.
const (
	PartSystem      = "system"
	PartMessages    = "messages"
	PartToolResults = "toolResults"
	PartSummary     = "summary"
	PartNote        = "note"
	PartFiles       = "files"
	PartCommands    = "commands"
	PartSearch      = "search"
	PartImages      = "images"
)

// ContextParts decomposes Measure into named parts, largest first.
//
// It is the same walk that produces the total, in the same order, so the parts
// add up to `Measure` exactly — and `Measure` is what the ledger reports as
// `estimated_tokens`, which is the number these parts are printed under. A
// breakdown whose rows do not add up to the figure above them is a chart that
// teaches the reader to distrust every number on the screen.
//
// Zeros are dropped rather than printed: a row saying "0 tok" is a statement
// about nothing, and the usual session has no images, no compaction and no
// commands at all.
func (a *Agent) ContextParts() []ContextPart {
	if a.Context == nil {
		return nil
	}
	budget := a.Context.Budget
	totals := map[string]int{}
	order := []string{
		PartSystem, PartMessages, PartToolResults, PartSummary, PartNote,
		PartFiles, PartCommands, PartSearch, PartImages,
	}
	add := func(key string, tokens int) {
		if tokens > 0 {
			totals[key] += tokens
		}
	}

	renderer := a.renderer()
	messages := a.Session.MessagesSnapshot()
	if renderer == nil {
		// No renderer but a ledger: `Measure` prices the raw history, and so
		// does this. There is nothing to bucket — every token here is history.
		add(PartMessages, a.Measure())
	} else {
		// 1) The artifact half, bucketed by the artifact's own type. The type is
		//    the processor's (`file` / `text` / `command` / `search` / `web` /
		//    `image`); unknown types are text bodies and land with the files.
		for _, item := range a.Context.State.Live() {
			if item.Removed {
				continue
			}
			key := PartFiles
			if artifact, known := a.Context.Store.Get(item.ArtifactID); known {
				key = artifactPart(artifact.Type)
			}
			add(key, budget.ItemCost(item, renderer.RenderItem))
		}

		// 2) The history half, bucketed by role. The summary is a `user`
		//    message but is not something the person said, so it is taken out by
		//    position — the same position `FoldedView` puts it in.
		summary := a.summaryMessage()
		view, folded, summaryKey := a.foldedViewWithKey(summary)
		key := a.renderKeyFor(renderer, a.Session.MessageCount(), folded, summaryKey)
		_, costs := a.cachedRender(renderer, view, key)
		factor := budget.Factor()
		summaryIndex := -1
		if summary != nil {
			summaryIndex = 0
			if len(view) > 0 && view[0]["role"] == "system" {
				summaryIndex = 1
			}
		}
		for index, cost := range costs {
			tokens := cost.flat
			if cost.scaled != 0 {
				tokens += int(float64(cost.scaled) * factor)
			}
			switch {
			case index == summaryIndex:
				add(PartSummary, tokens)
			case roleOf(view[index]) == "tool":
				add(PartToolResults, tokens)
			default:
				// The system message prices as zero here; it is counted below.
				add(PartMessages, tokens)
			}
		}

		// 3) The system prompt and the trailing note, exactly as `Measure`
		//    prices them.
		if len(messages) > 0 && messages[0]["role"] == "system" {
			system := content.Parse(messages[0]["content"]).TextOf()
			add(PartSystem, context.MessageOverhead+budget.Tokens(system))
		}
		if note := a.noteText(); note != "" {
			add(PartNote, context.MessageOverhead+budget.Tokens(note))
		}
	}

	parts := make([]ContextPart, 0, len(order))
	for _, key := range order {
		if tokens := totals[key]; tokens > 0 {
			parts = append(parts, ContextPart{Key: key, Tokens: tokens})
		}
	}
	sort.SliceStable(parts, func(i, j int) bool { return parts[i].Tokens > parts[j].Tokens })
	return parts
}

// artifactPart maps an artifact type onto the bucket the breakdown prints.
//
// `file` and `text` are one bucket on purpose: both are bodies a person asked
// to see, and the difference between a file read and a written sentence is not
// a difference in what the window paid for. `search` and `web` are one bucket
// for the same reason — they are the two shapes of "looked it up".
func artifactPart(kind string) string {
	switch kind {
	case "command":
		return PartCommands
	case "search", "web":
		return PartSearch
	case context.TypeImage:
		return PartImages
	}
	return PartFiles
}

// roleOf reads a message's role. Absent and non-string are both "" — a message
// with no role is not a tool message, which is all this is asked.
func roleOf(message map[string]any) string {
	role, _ := message["role"].(string)
	return role
}

// RefreshEstimate recomputes the cost now and writes it back. It reports whether
// it managed to.
//
// It only runs when the compaction test needs it — see the loop — and when a front
// end asks for the ledger. Payload leaves a fresh number every step, so on the
// normal path this never runs. What it serves is the first step of a turn, when
// the last estimate still belongs to the previous Run — and a saved session that
// was reopened, where the number would otherwise be zero until the first request
// goes out.
//
// The algorithm is Measure (the same implementation, not a second one), so "the
// decision made from an estimate" and "the number reported from an estimate" are
// always the same measurement.
func (a *Agent) RefreshEstimate() bool {
	if a.Context == nil || a.renderer() == nil {
		return false
	}
	a.Context.LastEstimate = a.Measure()
	return true
}

// generateSummary asks the current model to write a summary.
//
// ## Why the retry helper is reused
//
// A compaction is a **real** model call, so it faces the same failures as any
// other (rate limits, timeouts, a flaky gateway). The retry policy lives in one
// place; copying it here would mean two implementations of one policy, and the
// symptom of their drifting is "compaction occasionally does not retry", which
// nobody would find.
//
// Two deliberate differences from a normal request:
//
//   - **no streaming**: a summary is not an answer for the user. Letting it
//     appear word by word in the conversation would mix it with real answers,
//     and by then "who said this" has no answer;
//   - **no attempt recorder**: this call already produces a context_compacted
//     event carrying its duration. A model_call event as well would turn "how
//     many times did the model run this turn" into "the steps the user saw plus
//     the hidden housekeeping", and that number gets read as the model answering
//     an extra time.
//
// ## Why failure is not raised
//
// Compaction is a usability optimisation, not the purpose of the turn. When it
// fails, the right action is to act as if it had not been attempted and let
// degradation keep covering — still a working path. Propagating would let one
// rate limit break the whole turn, at a cost out of all proportion to the gain.
func (a *Agent) generateSummary(digestPrompt string) string {
	response, err := CallWithRetry(
		a.Chat,
		[]map[string]any{
			{"role": "system", "content": context.CompactionPrompt()},
			{"role": "user", "content": digestPrompt},
		},
		// A summary must not call tools: it is tidying up, not doing work.
		nil,
		model.CompleteOptions{},
		RetryHooks{},
	)
	if err != nil {
		// A deterministic failure and a transient one are the same thing here:
		// neither compacts. Telling them apart only matters for "should we try
		// again", and the call above already tried.
		a.reportToStderr(fmt.Sprintf("history compaction failed (this turn carries on): %v", err))
		return ""
	}
	if response.Content == nil {
		return ""
	}
	return strings.TrimSpace(*response.Content)
}

// CompactNow compacts once on demand. It returns the facts the interface needs,
// not the text.
//
// It goes through the same function as the automatic path, so the test, the
// boundary, the prompt and the write are one implementation. The only difference
// is who decided "now": a threshold or a person.
//
//	status        compacted / nothing / busy
//	folded        how many messages this pass folded
//	total_folded  how many are folded in total afterwards
//	summary_id    the artifact id of the summary this pass produced
//	summary_chars its size
//	before/after  the estimated cost either side
//	duration_ms   how long it took, summary round trip included
//
// "busy" means a compaction is already running and this request did nothing.
// "nothing" means there was no foldable stretch (history too short, or folding
// would gain nothing).
//
// **It does not raise on failure**: when the summary cannot be generated it
// answers as if nothing had happened, and the reason is already on stderr. The
// judgement is asymmetric — a failed compaction changed no state and lost no
// data, so turning it into an exception would only add a path for the front end
// to handle.
func (a *Agent) CompactNow() map[string]any {
	before := a.Measure()
	result := a.compact(0, true)
	if result == nil {
		// Failure and "nothing to fold" collapse into one answer deliberately:
		// the user's response to either is identical (do nothing), and splitting
		// them would add two paths in the interface that go nowhere.
		status := "nothing"
		if a.compacting {
			status = "busy"
		}
		return map[string]any{
			"status":        status,
			"folded":        0,
			"total_folded":  a.foldedCount(),
			"summary_id":    "",
			"summary_chars": 0,
			"generation":    0,
			"before":        before,
			"after":         a.Measure(),
			"duration_ms":   0,
		}
	}
	result["status"] = "compacted"
	result["before"] = before
	return result
}

func (a *Agent) foldedCount() int {
	if state, ok := a.compactionState(); ok {
		return state.FoldedMessages
	}
	return 0
}

// compact folds once. It returns what this pass did, or nil when nothing was
// folded.
//
// ## The order is the whole point of this method
//
//  1. **Generate the summary first, then write the boundary.** The other order
//     lets a failed summary leave a stretch that is folded with no summary —
//     worse than not folding at all.
//  2. **Write the summary's file before touching session metadata.** The store
//     writes the body then the manifest, so at no instant does disk hold a
//     summary pointing at nothing; metadata is the last step, and once it is
//     written the summary is guaranteed to be fetchable.
//  3. **Checkpoint last**, after metadata changed, so a crash recovers to either
//     "compacted" or "not compacted" — there is no middle state.
func (a *Agent) compact(step int, emit bool) map[string]any {
	if a.Context == nil || a.compacting {
		return nil
	}

	foldedBefore := a.foldedCount()
	point := context.FoldPoint(a.Session.MessagesSnapshot(), foldedBefore)
	if point <= foldedBefore {
		return nil
	}

	state, hadState := a.compactionState()
	// Measured before the summary arrives: the difference against `after` is the
	// saving, and a real model round trip sits between the two while the context
	// does not change — so the difference measures the history the summary
	// replaced.
	before := a.Measure()

	a.compacting = true
	started := a.Clock()
	var artifact context.Artifact
	var updated context.Compaction
	ok := false
	func() {
		defer func() { a.compacting = false }()

		digest := a.digestPrompt(state, hadState, foldedBefore, point)
		summary := a.generateSummary(digest)
		if summary == "" {
			return
		}

		generation := 1
		if hadState {
			generation = state.Generation + 1
		}
		created, err := a.Context.Store.Create(summary, "summary",
			context.ArtifactSource{Tool: "compact"},
			map[string]any{
				"generation": generation,
				"messages":   point,
				"folded":     point - foldedBefore,
				"status":     "ok",
			})
		if err != nil {
			a.reportToStderr(fmt.Sprintf("could not store the summary: %v", err))
			return
		}
		artifact = created

		// A wall-clock timestamp, not the agent's monotonic clock: updated_at is
		// for a person ("when was this summary written"), and a monotonic reading
		// would date it to 1970. Elapsed time still uses the monotonic clock.
		updated = context.Compaction{
			FoldedMessages: point,
			SummaryID:      artifact.ID,
			Generation:     generation,
			UpdatedAt:      float64(time.Now().UnixNano()) / 1e9,
		}
		a.Session.Meta().Write(func(metadata map[string]any) { context.StoreCompaction(metadata, updated) })
		ok = true
	}()
	if !ok {
		return nil
	}

	if a.OnCheckpoint != nil {
		a.OnCheckpoint()
	}

	durationMs := int((a.Clock() - started) * 1000)
	after := a.Measure()
	messages := a.Session.MessageCount()

	if emit {
		a.emit(audit.Event(audit.KindContextCompacted, a.Session.SessionID, "", step,
			map[string]any{
				"folded":        point - foldedBefore,
				"folded_total":  point,
				"messages":      messages,
				"summary_id":    artifact.ID,
				"summary_chars": artifact.Chars,
				"generation":    updated.Generation,
				"before":        before,
				"after":         after,
				"duration_ms":   durationMs,
				"model":         a.Chat.ModelName(),
			}))
	}

	return map[string]any{
		"folded":        point - foldedBefore,
		"total_folded":  point,
		"summary_id":    artifact.ID,
		"summary_chars": artifact.Chars,
		"generation":    updated.Generation,
		// The history's total length travels with the result because the interface
		// prints "folded 13 (13/26)". Without it the reader gets "13/0", which
		// looks like "13 to fold, none folded" — the opposite of what happened.
		"messages":    messages,
		"after":       after,
		"duration_ms": durationMs,
	}
}

// digestPrompt is the message handed to the summarising model: the previous
// summary plus the skeleton of the stretch being folded now.
//
// The previous summary has to come along, or the second compaction drops
// everything the first one condensed — the easiest silent error here: the
// summary looks fine, it is just incremental, and the model believes it is
// reading the whole history.
func (a *Agent) digestPrompt(state context.Compaction, hadState bool, foldedBefore, stop int) string {
	var parts []string
	if hadState && a.Context != nil {
		if previous, ok := context.SummaryText(a.Context.Store, state); ok && previous != "" {
			parts = append(parts,
				"## 上一版的摘要（它概括的是更早的那一段历史，请在它的基础上接着往下写，不要丢掉里面的事实）\n\n"+previous)
		}
	}
	skeleton := context.DigestMessages(a.Session.MessagesSnapshot(), foldedBefore, &stop, context.DigestMaxChars)
	parts = append(parts, fmt.Sprintf("## 这一次要折进摘要的历史骨架（第 %d 到第 %d 条）\n\n%s",
		foldedBefore+1, stop, skeleton))
	return strings.Join(parts, "\n\n")
}

// MarkContextMessages marks which messages belong to the stable band. Called once
// at the start of each turn.
//
// Why not at Add time: the moment a message enters history, nothing yet knows
// whether it will be "this turn's task" (the first user message only appears in
// the first Run, by which point system is already in the list). The judgement is
// positional, and position can only be computed with the whole history in hand,
// so it is computed once at the start of the turn.
//
// **It only affects messages that have an artifact** (tool messages), because
// the two positional rules (system prompt, first user message) are not artifacts
// at all:
//
//   - the system prompt is the role="system" message, passed through untouched,
//     with no level to speak of;
//   - the first user message is just a message — can it be pushed out? **No**:
//     the budget only looks at context items, and ordinary history messages do
//     not participate in degradation.
//
// So "this turn's task may not be evicted" holds here by construction and needs
// no item to express it. What does need pinning is a **tool result that came from
// the task itself** (the project notes read in at the start) — those are the
// things that degrade, and this marks them stable plus pinned.
//
// **It does not touch items already in the context**: Add is idempotent but
// resets the level to full, which is exactly the jitter "degrade only" exists to
// prevent.
func (a *Agent) MarkContextMessages() {
	if a.Context == nil {
		return
	}
	messages := a.Session.MessagesSnapshot()
	for index, mark := range messageMarks(messages) {
		if index >= len(messages) {
			continue
		}
		artifactID := context.ArtifactIDOf(messages[index])
		if artifactID == "" {
			// Not an artifact (the system prompt, or the first user message) —
			// already un-evictable, so nothing to do.
			continue
		}
		if a.Context.Item(artifactID) == nil {
			a.Context.Add(artifactID, context.AddOptions{
				Zone:     mark.zone,
				Priority: mark.priority,
				Pinned:   mark.pinned,
				Quiet:    true,
			})
		}
	}
}

// messageMark is the band and priority one message position deserves.
type messageMark struct {
	zone     context.Zone
	pinned   bool
	priority int
}

// messageMarks judges a batch of messages by **position, not content**.
//
// The first user message is "this session's task", and only position knows which
// one that is (the one already in history before this turn appended another).
// Judging by content — "the longest one", say — necessarily points at the wrong
// message after ten exchanges.
func messageMarks(messages []map[string]any) map[int]messageMark {
	marks := map[int]messageMark{}
	if index := indexOfRole(messages, "system"); index >= 0 {
		marks[index] = messageMark{zone: context.ZoneSystem, pinned: true, priority: 100}
	}
	if index := indexOfRole(messages, "user"); index >= 0 {
		marks[index] = messageMark{zone: context.ZoneStable, pinned: true, priority: 50}
	}
	return marks
}

func indexOfRole(messages []map[string]any, role string) int {
	for index, message := range messages {
		if message["role"] == role {
			return index
		}
	}
	return -1
}
