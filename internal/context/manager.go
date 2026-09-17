package context

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Manager decides what the model sees this round.
//
// It stores no data (that is ArtifactStore) and renders nothing (that is
// Renderer). What it owns is state: which artifacts are in the context, at which
// level, which may not be touched, and who moves when tokens run short.
//
// It is the door between the two:
//
//	ArtifactStore   "what information do I have?"   (does not know context exists)
//	Manager         "what am I showing right now?"  (does not know what the body looks like)
//
// The latter holds only pointers, which is why an Artifact can exist without
// being in the context. That is the normal case: one `grep` produces a list of
// matching files and only one of them is in the context.
//
// Legacy note: sessions written before this layer existed have the tool body
// stored in history, with no artifact and no item. Hydrate gives those an
// artifact and a full-level item, so an old session keeps working without a
// second rendering path on the read side.

const (
	// DefaultRangeLines caps a range snippet. It is a ceiling, not a target —
	// the target is derived from the body's own size.
	DefaultRangeLines = 400
	// DefaultPreviewLines caps a preview the same way.
	DefaultPreviewLines = 40

	// DefaultRangeRatio keeps roughly a fifth of the tokens, DefaultPreviewRatio
	// a twentieth.
	//
	// A ratio rather than a fixed line count, because the point is to lower
	// tokens and the same line count means completely different things on a
	// 100-line file and a 20,000-line log. The first version used fixed counts
	// and measured a degradation step that made a 200-line file **larger**
	// (the header outweighed the bytes saved).
	DefaultRangeRatio   = 0.2
	DefaultPreviewRatio = 0.05

	// MinWindowLines is the floor for a degraded window. Below this the snippet
	// is noise, and the right move is the next level down (metadata, then out),
	// not a fragment nobody can read. It also keeps every window at one line or
	// more: an empty interval renders identically to "this file is empty".
	MinWindowLines = 20

	// MinWindowChars is the same floor on the character side.
	MinWindowChars = 400

	// DefaultRangeChars caps the character budget (only long-line bodies reach
	// it). It pairs with DefaultRangeLines: the two gates exist because each one
	// fails on a different body shape.
	DefaultRangeChars = 24_000
	// DefaultPreviewChars is the preview-side character cap.
	DefaultPreviewChars = 3_000

	// RenderHeaderReserve is what a rendered header costs
	// (`[artifact art_x：path，第 1-20 行（共 900 行）]`).
	//
	// It must come out of the character budget first, or "degrade to 16000
	// characters" sends 16057 — the budget says 4000 tokens, the real payload is
	// a little more, and **under-estimating is the dangerous side** (the request
	// goes over the window). The header's length varies with path and line
	// numbers, so this is a conservative upper bound: it only affects how hard
	// degradation bites, and 80 characters of over-reserve is nothing.
	RenderHeaderReserve = 80
)

// OnChange is called whenever the items change. One parameter: the whole state.
//
// The whole thing rather than "which item changed", because callers (the store,
// the interface) always want "what does it look like now" — an incremental form
// would make them keep a merge of their own, which is a second source for the
// same fact.
type OnChange func(state *ContextState)

// AddOptions collects what Add needs. The zero value is the common case: full
// level, dynamic band, not pinned.
type AddOptions struct {
	Representation Representation
	Zone           Zone
	Priority       int
	Pinned         bool
	Options        map[string]any
	// Quiet suppresses the change callback. The zero value notifies, which is
	// what most callers want; the ones that fire mid-round say Quiet.
	Quiet bool
}

// Manager is one session's context state.
type Manager struct {
	Store    *ArtifactStore
	State    *ContextState
	Budget   *Budget
	OnChange OnChange

	RangeLines   int
	PreviewLines int
	RangeRatio   float64
	PreviewRatio float64
	RangeChars   int
	PreviewChars int

	// LastEstimate is this step's estimated token count. An estimate, not a
	// measurement — only the provider measures. See Budget.Calibrate for how the
	// two relate.
	LastEstimate int
	// LastDegraded is what the last Fit moved, for the audit and the interface
	// ("why did this round not show the whole file").
	LastDegraded []Degraded
}

// NewManager builds a manager for a store.
func NewManager(store *ArtifactStore, state *ContextState, budget *Budget, onChange OnChange) *Manager {
	if state == nil {
		state = &ContextState{}
	}
	if budget == nil {
		budget = NewBudget(nil)
	}
	return &Manager{
		Store:        store,
		State:        state,
		Budget:       budget,
		OnChange:     onChange,
		RangeLines:   DefaultRangeLines,
		PreviewLines: DefaultPreviewLines,
		RangeRatio:   DefaultRangeRatio,
		PreviewRatio: DefaultPreviewRatio,
		RangeChars:   DefaultRangeChars,
		PreviewChars: DefaultPreviewChars,
	}
}

// --- writes -----------------------------------------------------------------

// Add puts an artifact into the context; if it is already there, its level,
// band and priority are updated.
//
// It is idempotent, and that is required rather than nice: the same artifact can
// arrive by two paths (the tool result, and hydrate after a read_file), and two
// duplicate items mean it renders twice — or worse, at two different levels, so
// "which one is it rendered at" has no answer.
func (m *Manager) Add(artifactID string, options AddOptions) *ContextItem {
	if options.Representation == "" {
		options.Representation = RepresentationFull
	}
	if options.Zone == "" {
		options.Zone = ZoneDynamic
	}

	if existing := m.State.Get(artifactID); existing != nil {
		existing.Representation = options.Representation
		existing.Zone = options.Zone
		existing.Priority = options.Priority
		existing.Pinned = options.Pinned
		existing.Options = copyOptions(options.Options)
		existing.Removed = false
		m.touch(!options.Quiet)
		return existing
	}

	item := &ContextItem{
		ArtifactID:     artifactID,
		Representation: options.Representation,
		Zone:           options.Zone,
		Priority:       options.Priority,
		Pinned:         options.Pinned,
		Sequence:       m.State.NextSequence(),
		Options:        copyOptions(options.Options),
	}
	m.State.Items = append(m.State.Items, item)
	m.touch(!options.Quiet)
	return item
}

// AddArtifact is sugar for callers that hold the artifact already.
func (m *Manager) AddArtifact(artifact Artifact, options AddOptions) *ContextItem {
	return m.Add(artifact.ID, options)
}

// Remove takes an artifact out of the context. **It does not delete data.**
//
// "Out of the context" and "deleted" are different things: this sets Removed and
// leaves the body on disk. An artifact can exist without being in the context —
// removing the data is ArtifactStore.Delete, which only the bottom of the
// degradation ladder reaches.
func (m *Manager) Remove(artifactID string) bool {
	item := m.State.Get(artifactID)
	if item == nil || item.Removed {
		return false
	}
	item.Removed = true
	m.touch(true)
	return true
}

// Restore puts an evicted item back, keeping the level it had.
func (m *Manager) Restore(artifactID string) bool {
	item := m.State.Get(artifactID)
	if item == nil || !item.Removed {
		return false
	}
	item.Removed = false
	m.touch(true)
	return true
}

// Clear empties the context without touching the store.
func (m *Manager) Clear() {
	if len(m.State.Items) == 0 {
		return
	}
	m.State.Items = nil
	m.touch(true)
}

// SetNotes replaces this round's transient content.
//
// It is not a ContextItem: no artifact, no disk, recomputed every round. But it
// has to be in the ledger, or the budget counts a request that is missing a
// message — and that message is exactly the one that pushes a full budget over.
//
// Called many times per round (once per step), so it deliberately does not bump
// the version or notify anybody: a version bump triggers a write to disk, and
// "the step reminder went from 3 to 2" is not worth writing down.
func (m *Manager) SetNotes(texts []string) []*ContextNote {
	notes := make([]*ContextNote, 0, len(texts))
	for index, text := range texts {
		if text == "" {
			continue
		}
		notes = append(notes, &ContextNote{Text: text, Sequence: index})
	}
	m.State.Notes = notes
	return notes
}

// Notes returns this round's transient content.
func (m *Manager) Notes() []*ContextNote { return m.State.Notes }

// --- reads ------------------------------------------------------------------

// Items returns every item, evicted ones included, in the order they entered.
func (m *Manager) Items() []*ContextItem { return m.State.Items }

// Item finds an item by artifact id.
func (m *Manager) Item(artifactID string) *ContextItem { return m.State.Get(artifactID) }

// RepresentationOf reports the level an artifact is at. Empty means it is not in
// the context.
func (m *Manager) RepresentationOf(artifactID string) Representation {
	item := m.State.Get(artifactID)
	if item == nil || item.Removed {
		return ""
	}
	return item.Representation
}

// ZoneItems returns the live items in one band.
func (m *Manager) ZoneItems(zone Zone) []*ContextItem {
	var items []*ContextItem
	for _, item := range m.State.Items {
		if item.Zone == zone && !item.Removed {
			items = append(items, item)
		}
	}
	return items
}

// Stats is the summary the interface reads.
//
// It counts, it does not quote: the call site is a state snapshot, taken often.
//
// `open` and `compact` are the two numbers that matter for this feature. `open`
// is how much information is on hand (everything that ever entered the
// context, evicted included); `compact` is how much can actually be sent right
// now. The wider the gap, the harder the budget is pressing — and those two used
// to be the same number, because tool output went straight into history.
func (m *Manager) Stats() map[string]any {
	live := m.State.Live()
	pinned, stable, dynamic := 0, 0, 0
	for _, item := range live {
		if item.Pinned {
			pinned++
		}
		switch item.Zone {
		case ZoneStable:
			stable++
		case ZoneDynamic:
			dynamic++
		}
	}
	return map[string]any{
		"artifacts":        m.Store.Len(),
		"items":            len(live),
		"compact":          len(live),
		"removed":          len(m.State.Items) - len(live),
		"open":             len(m.State.Items),
		"pinned":           pinned,
		"stable":           stable,
		"dynamic":          dynamic,
		"version":          m.State.Version,
		"estimated_tokens": m.LastEstimate,
		"limit_tokens":     m.Budget.EffectiveLimit(),
		"degraded":         len(m.LastDegraded),
		// The compaction line. Only the threshold: "has this session been
		// compacted" is a fact about the session, and this layer does not know
		// what the history looks like.
		"compact_threshold": m.Budget.CompactThreshold(),
	}
}

// ShouldCompact answers "is it time to think about compacting", not "can it be
// done". The latter needs the whole history and belongs to compaction.FoldPoint.
//
// It uses the last estimate, which has been calibrated against measurements. The
// difference between that and "the real size right now" is whatever tool results
// arrived this step — which is exactly why callers re-estimate at the start of
// each step. With the budget off it is always false: without a known window,
// "it is time" says nothing.
func (m *Manager) ShouldCompact() bool {
	if !m.Budget.Enabled() {
		return false
	}
	return m.LastEstimate >= m.Budget.CompactThreshold()
}

// --- budget -----------------------------------------------------------------

// Fit brings the context under budget and reports what moved.
//
// `render` supplies the current text for an item (from the renderer). The
// rewriting happens here, because "what the options become after degrading" is
// knowledge about context state.
//
// `extra` is the token count of the parts that cannot be degraded — the system
// prompt, every user and assistant message, the reference line on each tool
// message. They are not in State.Items (those are artifacts) yet they compete
// for the same window. Not subtracting them means balancing a ledger with half
// the entries missing: the longer the history, the more fictional "this still
// fits" becomes, and the loop degrades every artifact to zero and still reports
// over budget.
//
// It is called every step, and only changes anything when the budget is
// overshot. Levels already dropped do not come back.
func (m *Manager) Fit(render func(*ContextItem) string, extra int) []Degraded {
	if !m.Budget.Enabled() {
		// Unknown window: count, do not act.
		m.LastEstimate = m.Estimate(render, extra)
		m.LastDegraded = nil
		return nil
	}

	before := fingerprint(m.State)
	m.LastDegraded = m.Budget.Fit(
		m.State,
		render,
		m.degrade,
		m.evict,
		extra+m.notesTokens(),
		// One level per call: see Budget.Fit on singleStep. Stopping as soon as
		// it fits means the extra levels are not thrown away for nothing.
		true,
	)
	after := fingerprint(m.State)
	m.LastEstimate = m.Estimate(render, extra)

	if before != after {
		// Levels moved, so the rendered prompt moved, so this is a new version.
		// One consequence is that it gets written to disk again.
		m.State.Version++
		m.notify()
	}
	return m.LastDegraded
}

// Estimate is what this round costs, including transient content and fixed
// overhead.
//
// `extra` means exactly what it means in Fit, and both must be handed the same
// value: Fit decides with it, this reports with it, and a difference between the
// two makes "the estimate says there is room" and "the estimate degraded anyway"
// disagree — which shows up as degrading while there is headroom, or the
// reverse.
//
// It also feeds Calibrate. So a missing `extra` is not just a low reading: the
// provider's measured prompt_tokens **includes** the fixed overhead, so the
// ratio comes out too high and every later degradation bites too hard.
func (m *Manager) Estimate(render func(*ContextItem) string, extra int) int {
	total := extra + m.Budget.EstimateItems(m.State.Live(), render)
	for _, note := range m.State.Notes {
		total += MessageOverhead + m.Budget.Tokens(note.Text)
	}
	return total
}

func (m *Manager) notesTokens() int {
	total := 0
	for _, note := range m.State.Notes {
		total += MessageOverhead + m.Budget.Tokens(note.Text)
	}
	return total
}

// Calibrate corrects the estimate against the provider's measured input tokens.
//
// The measurement belongs to the **previous** request (only the provider knows
// after sending), so it corrects the next estimate. It is far more accurate than
// the estimate — but using it directly as "how big is the context now" is wrong,
// because the context changed in between. It only adjusts the ratio.
func (m *Manager) Calibrate(measuredPromptTokens int) float64 {
	estimated := m.LastEstimate
	if estimated < 1 {
		estimated = 1
	}
	return m.Budget.Calibrate(estimated, measuredPromptTokens)
}

// degrade drops one level and fixes the options along with it.
//
// The options are not a detail: a range-level item still carrying the full
// file's line bounds renders the whole file, so degradation performed an empty
// action — and "changed but did not shrink" is invisible in the token bill (it
// simply did not go down) and invisible in the log (the level really did
// change).
func (m *Manager) degrade(item *ContextItem) {
	target := item.Representation.Degraded()
	if target == item.Representation {
		return
	}
	item.Representation = target

	switch target {
	case RepresentationPreview:
		item.Options = windowToOptions(m.windowOptions(item.ArtifactID, m.PreviewRatio, m.PreviewLines, m.PreviewChars))
		return
	case RepresentationMetadata:
		// Metadata renders the artifact's own facts; it takes no parameters.
		item.Options = map[string]any{}
		return
	}

	// RANGE: keep the place the model or the user was looking at and only narrow
	// the window. Degrading should not move the reader somewhere else entirely.
	start := intOption(item.Options, "start_line", 1)
	total := m.totalLines(item.ArtifactID)
	window := m.windowOptions(item.ArtifactID, m.RangeRatio, m.RangeLines, m.RangeChars)
	lines := 1
	if value, ok := window["preview_lines"]; ok && value > 0 {
		lines = value
	}
	end := start + lines - 1
	if total > 0 {
		// If the start is already near the end (the user asked for the last
		// page, say), move backwards rather than returning an empty interval —
		// empty renders identically to "this file has no content".
		if start+lines-1 > total {
			start = total - lines + 1
			if start < 1 {
				start = 1
			}
			end = start + lines - 1
		}
		if end > total {
			end = total
		}
	}
	options := map[string]any{"start_line": start, "end_line": end}
	for key, value := range window {
		options[key] = value
	}
	item.Options = options
}

// evict takes an item out of the context once it has bottomed out. It does not
// delete the artifact.
func (m *Manager) evict(item *ContextItem) {
	item.Removed = true
}

// windowOptions derives how many lines and characters a level should give, from
// the body's own size.
//
// Both caps together, because **either alone fails**:
//
//   - a line count does nothing for a body whose lines are enormous (minified
//     JSON, a joined log, anything without newlines) — that splits into one
//     line, so "give it 20 lines" is the whole body;
//   - a character count is too tight for many short lines (a 5,000-row CSV at
//     eight characters a row) and would cut the row count to a handful, when
//     what the model needs is contiguous rows.
//
// The ratio is "down to how much of the original", and these are two measures of
// the same intent, so both are computed and both bite. The cost: that CSV gets
// cut again by the character gate. That is the conservative side, and a model
// that truly needs precision can read the file again.
//
// When the body size is unknown (no lines, no chars) the caps are used as-is:
// better to give too much than to turn "degrade" into "empty".
func (m *Manager) windowOptions(artifactID string, ratio float64, lineCap, charCap int) map[string]int {
	artifact, ok := m.Store.Get(artifactID)
	chars, total := 0, 0
	if ok {
		chars = artifact.Chars
		total = asInt(artifact.Metadata["lines"])
	}

	lines := lineCap
	if total > 0 {
		computed := int(float64(total) * ratio)
		if computed > lineCap {
			computed = lineCap
		}
		if computed < MinWindowLines {
			computed = MinWindowLines
		}
		lines = computed
	}

	maxChars := charCap
	if chars > 0 {
		computed := int(float64(chars) * ratio)
		if computed > charCap {
			computed = charCap
		}
		if computed < MinWindowChars {
			computed = MinWindowChars
		}
		maxChars = computed
	}

	reserved := maxChars - RenderHeaderReserve
	if reserved < 1 {
		reserved = 1
	}
	return map[string]int{"preview_lines": lines, "max_chars": reserved}
}

// totalLines is how many lines the body has; zero means unknown, and then the
// window falls back to the configured cap.
func (m *Manager) totalLines(artifactID string) int {
	artifact, ok := m.Store.Get(artifactID)
	if !ok {
		return 0
	}
	return asInt(artifact.Metadata["lines"])
}

// --- loading and legacy -----------------------------------------------------

// Hydrate gives artifacts and context items to history that does not have them.
//
// That is the path from a session file written before this layer existed: tool
// bodies were stored in full and the context was implicit ("send everything").
// It does two things — collect the body into the store (so it can be rendered at
// a level and degraded later), and create a full-level item, which is exactly
// what happened then.
//
// Messages that already carry an artifact_id are skipped. It returns the ids it
// created so the caller can decide whether to write.
//
// **Every tool message must end up with an artifact**: the reference in history
// is the only entry point for rendering, and a missing one means the model can
// never see that tool result again. So even an empty message is collected — an
// empty artifact is honest, the tool really did produce nothing.
func (m *Manager) Hydrate(messages []map[string]any, defaultZone Zone, defaultPriority int) ([]string, error) {
	if defaultZone == "" {
		defaultZone = ZoneDynamic
	}
	var created []string
	for index, message := range messages {
		if message == nil || message["role"] != "tool" {
			continue
		}
		if ArtifactIDOf(message) != "" {
			continue // already the new shape
		}
		// In an old session a tool message's content **is** the body. Text that
		// parses as a reference (a hand-edited session, say) goes down the same
		// path: that text is the only fact on hand.
		text, _ := message["content"].(string)
		artifact, err := m.Store.Create(text, "text", ArtifactSource{Tool: "legacy"}, map[string]any{
			"status":        "ok",
			"hydrated":      true,
			"message_index": index,
		})
		if err != nil {
			return created, err
		}
		m.Add(artifact.ID, AddOptions{Zone: defaultZone, Priority: defaultPriority, Quiet: true})
		created = append(created, artifact.ID)
	}
	if len(created) > 0 {
		m.touch(true)
	}
	return created, nil
}

// --- bookkeeping ------------------------------------------------------------

func (m *Manager) touch(notify bool) {
	m.State.Version++
	if notify {
		m.notify()
	}
}

func (m *Manager) notify() {
	if m.OnChange != nil {
		m.OnChange(m.State)
	}
}

// fingerprint is the part of the state that affects rendering. It exists only to
// answer "did anything change".
//
// It excludes version itself (that is what is being decided) and excludes
// anything that does not reach the payload.
func fingerprint(state *ContextState) string {
	var builder strings.Builder
	for _, item := range state.Items {
		builder.WriteString(item.ArtifactID)
		builder.WriteByte('|')
		builder.WriteString(string(item.Representation))
		builder.WriteByte('|')
		builder.WriteString(string(item.Zone))
		builder.WriteByte('|')
		if item.Removed {
			builder.WriteByte('1')
		} else {
			builder.WriteByte('0')
		}
		builder.WriteByte('|')
		keys := make([]string, 0, len(item.Options))
		for key := range item.Options {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			builder.WriteString(key)
			builder.WriteByte('=')
			builder.WriteString(fmt.Sprint(item.Options[key]))
			builder.WriteByte(',')
		}
		builder.WriteByte('\n')
	}
	return builder.String()
}

func copyOptions(options map[string]any) map[string]any {
	copied := map[string]any{}
	for key, value := range options {
		copied[key] = value
	}
	return copied
}

// windowToOptions widens a computed window so it can live in an item's options,
// which are untyped because they travel through JSON.
func windowToOptions(window map[string]int) map[string]any {
	options := make(map[string]any, len(window))
	for key, value := range window {
		options[key] = value
	}
	return options
}

func intOption(options map[string]any, key string, fallback int) int {
	if options == nil {
		return fallback
	}
	switch number := options[key].(type) {
	case int:
		return number
	case int64:
		return int(number)
	case float64:
		return int(number)
	case string:
		if parsed, err := strconv.Atoi(number); err == nil {
			return parsed
		}
	}
	return fallback
}

func asInt(value any) int {
	number := intOption(map[string]any{"value": value}, "value", 0)
	if number < 0 {
		return 0
	}
	return number
}
