package tui

import (
	"fmt"
	"hash/fnv"
	"strings"
	"time"

	"github.com/alecthomas/chroma/v2"
	chromastyles "github.com/alecthomas/chroma/v2/styles"
	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/glamour/ansi"
	"github.com/charmbracelet/glamour/styles"
	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-runewidth"
	"github.com/muesli/termenv"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// The transcript is **turn-structured**.
//
// A turn owns its header, its tool lines, its thinking block and its answer.
// That structure is what lets a finished turn's header be rewritten in place
// ("running · step 1" → "3 steps · 4.2s · Answered") and the thinking block be
// folded and unfolded independently — a flat append-only log has no "block" to
// act on, which is exactly why the original moved off one.

// seg is one styled stretch of text on a line.
type seg struct {
	text string
	role string
}

// renderLine is one drawable line. An anchor ties it to a protocol identity
// (call_id / run_id) so a later event can rewrite it in place — the quiet mode's
// tool line grows its result tail by finding the line with the same anchor.
type renderLine struct {
	segments []seg
	anchor   string
	role     string
}

func (l renderLine) plain() string {
	var out strings.Builder
	for _, part := range l.segments {
		out.WriteString(part.text)
	}
	return out.String()
}

// turnData is one conversational turn: everything between a run_started and its
// run_finished.
type turnData struct {
	index     int
	runID     string
	userInput string
	lines     []renderLine

	steps     int
	startedAt time.Time
	// duration is the runtime's own measurement, frozen when the turn ends.
	// Drawing `time.Since(startedAt)` instead would keep a finished turn's
	// duration climbing for as long as the screen is left open.
	duration time.Duration
	finished bool
	outcome  string // a stop_reason: answered / max_steps / cancelled / model_error / model_fatal
	// answer is the turn's final text, attached **by run_id** when the runtime
	// reports the turn finished.
	//
	// It belongs to the turn rather than the transcript for a reason the protocol
	// states outright: the `ui(run_finished)` message and the events of the turn
	// are separate messages whose **order is not guaranteed**. Appending the answer
	// where it arrives draws it after a turn that started later, and even in the
	// normal order it ends up a sibling of the block instead of inside it — so the
	// header saying "Answered" no longer owns the answer it is summarising.
	answer      string
	thinking    string // the model's reasoning, whole, once the step is done
	thinkingRun string
	expanded    bool // Ctrl+T state for this turn's thinking block
}

// entry is one thing in the transcript: a turn, or a standalone line (a notice,
// an error, a rendered panel answer) that belongs to no turn.
type entry struct {
	turn  *turnData
	line  renderLine
	lines []renderLine
	kind  string // for standalone lines: user / assistant / notice / error / answer
	text  string // raw text for markdown-rendered entries
}

// ── roles → colours ───────────────────────────────────────────────────────────
//
// Colour carries the hierarchy the terminal cannot get from font sizes: body
// text (ink), process lines (ink3), block titles and key hints (ink4). The risk
// suffix leans on the same three-colour code the rest of the interface uses.
//
// The mapping is the original's, role for role. Two of them are load-bearing
// rather than cosmetic:
//
//   - `rule` is ink4, the quietest ink. It draws the separator rules, the panel
//     footers and the key hints — all "structure" rather than content — and at
//     ink3 they competed with the process lines they are supposed to sit under.
//   - `waiting` is accent and bold, because accent is reserved for exactly one
//     thing: "this is where you act". Painting it in `warn` made "an approval is
//     waiting" the same colour as "something went wrong".

func (t theme) styleFor(role string) lipgloss.Style {
	base := lipgloss.NewStyle()
	switch role {
	case "user":
		return base.Foreground(lipgloss.Color(t.ink)).Bold(true)
	case "answer":
		return base.Foreground(lipgloss.Color(t.ink2))
	case "process":
		return base.Foreground(lipgloss.Color(t.ink3))
	case "rule":
		return base.Foreground(lipgloss.Color(t.ink4))
	case "tool", "tool_brief", "tool_brief_done":
		return base.Foreground(lipgloss.Color(t.accent))
	case "result":
		return base.Foreground(lipgloss.Color(t.ok))
	case "denied":
		return base.Foreground(lipgloss.Color(t.danger))
	case "warn":
		return base.Foreground(lipgloss.Color(t.warn))
	case "waiting":
		return base.Foreground(lipgloss.Color(t.accent)).Bold(true)
	case "notice":
		return base.Foreground(lipgloss.Color(t.ink3))
	case "error":
		return base.Foreground(lipgloss.Color(t.danger)).Bold(true)
	case "risk_medium":
		return base.Foreground(lipgloss.Color(t.warn))
	case "risk_high":
		return base.Foreground(lipgloss.Color(t.danger))
	case "think_head":
		return base.Foreground(lipgloss.Color(t.ink4))
	case "think_body":
		return base.Foreground(lipgloss.Color(t.ink3))
	case "quote":
		// The bar is the boundary, not the words: the theme's line colour keeps
		// it one step quieter than the text it frames.
		return base.Foreground(lipgloss.Color(t.line))
	case "turn_start":
		return base.Foreground(lipgloss.Color(t.ink3)).Bold(true)
	case "turn_end":
		return base.Foreground(lipgloss.Color(t.ink3)).Bold(true)
	case "skill":
		return base.Foreground(lipgloss.Color(t.skill))
	case "caret":
		// The caret is a reversed cell: reverse video carries its own contrast
		// under every theme, so no palette needs a hand-tuned caret colour.
		return base.Reverse(true)
	default:
		// An unknown role falls back to the process ink rather than to the
		// terminal's own foreground: a line with no colour at all reads as a
		// rendering bug, and it is the one fallback nobody would notice.
		return base.Foreground(lipgloss.Color(t.ink3))
	}
}

// renderOne styles a line with the active theme.
func renderOne(line renderLine) string {
	var out strings.Builder
	for _, part := range line.segments {
		out.WriteString(currentTheme.styleFor(part.role).Render(part.text))
	}
	return out.String()
}

// ── event → lines ─────────────────────────────────────────────────────────────

// toolCallLine is `  → [1] read_file(main.py)` with the risk suffix on colours
// alone — LOW is the majority and writing "low risk" on every line is noise.
func toolCallLine(tool string, arguments string, index any, risk string) renderLine {
	at := ""
	if n, ok := asInt(index); ok {
		at = fmt.Sprintf("[%d] ", n+1)
	}
	line := renderLine{segments: []seg{
		{text: "  → ", role: "process"},
		{text: at, role: "rule"},
		{text: tool, role: "tool"},
		{text: "(" + arguments + ")", role: "rule"},
	}}
	switch risk {
	case "medium":
		// The template already carries the three spaces that separate the risk
		// word from the call; adding one here made it four.
		line.segments = append(line.segments, seg{text: i18n.T("risk.medium"), role: "risk_medium"})
	case "high":
		line.segments = append(line.segments, seg{text: i18n.T("risk.high"), role: "risk_high"})
	}
	return line
}

// toolResultLine is `  ← [1] ✓ 8,412 chars   41ms`.
func toolResultLine(index any, message map[string]any) renderLine {
	status, _ := protocol.String(message, "status")
	mark, role := "! ", "warn"
	switch status {
	case "ok":
		mark, role = "✓ ", "result"
	case "denied", "invalid_args":
		mark, role = "✗ ", "denied"
	}
	at := ""
	if n, ok := asInt(message["tool_index"]); ok {
		at = fmt.Sprintf("[%d] ", n+1)
	}
	chars, _ := protocol.Int(message, "chars")
	span := msText(message["duration_ms"])
	return renderLine{segments: []seg{
		{text: "  ← ", role: "process"},
		{text: at, role: "rule"},
		{text: mark, role: role},
		{text: i18n.Tn("tool.result_chars", chars, "chars", countText(chars)), role: "process"},
		{text: "   " + span, role: "rule"},
	}}
}

// toolBriefLine is the quiet mode's one-line-per-call form, with the call_id as
// its anchor so the result tail can find it.
func toolBriefLine(tool string, arguments string, callID string, risk string) renderLine {
	role := "tool"
	switch risk {
	case "medium":
		role = "risk_medium"
	case "high":
		role = "risk_high"
	}
	line := renderLine{
		segments: []seg{
			{text: "  → ", role: "process"},
			{text: "[" + tool + "]", role: role},
		},
		anchor: callID,
		role:   "tool_brief",
	}
	if brief := toolBrief(tool, arguments); brief != "" {
		line.segments = append(line.segments, seg{text: " " + brief, role: "process"})
	}
	return line
}

// toolBriefDoneLine is the result **tail** that gets appended to the brief line.
// Deliberately prefix-free: the tool name is already on screen.
func toolBriefDoneLine(message map[string]any) renderLine {
	status, _ := protocol.String(message, "status")
	callID, _ := protocol.String(message, "call_id")
	chars, _ := protocol.Int(message, "chars")
	span := msText(message["duration_ms"])
	var parts []seg
	switch status {
	case "ok":
		parts = []seg{
			{text: "✓ ", role: "result"},
			{text: i18n.Tn("tool.ok_tail", chars, "chars", countText(chars), "span", span), role: "rule"},
		}
	case "denied":
		parts = []seg{{text: "✗ ", role: "denied"}, {text: i18n.T("tool.denied"), role: "rule"}}
	case "invalid_args":
		parts = []seg{{text: "✗ ", role: "denied"}, {text: i18n.T("tool.invalid_args"), role: "rule"}}
	default:
		parts = []seg{
			{text: "! ", role: "warn"},
			{text: i18n.Tn("tool.error", chars, "chars", countText(chars)), role: "rule"},
		}
	}
	return renderLine{segments: parts, anchor: callID, role: "tool_brief_done"}
}

// silentOutcome reports whether an approval event means "it ran without asking".
//
// Quiet mode drops these four entirely: the point of the mode is one line per
// item, and a release that required no decision is not an item. The other four
// outcomes stay — `approved` because a person pressed a key and that leaves a
// trace worth keeping, and the three refusals because the screen has to say why
// the turn stopped there.
func silentOutcome(message map[string]any) bool {
	switch outcome, _ := protocol.String(message, "outcome"); outcome {
	case "auto_allowed", "autopilot", "rule_allowed", "command_allowed":
		return true
	}
	return false
}

// permissionLine is `  · permission shell → approved (looked for 2.4s · remembered …)`.
func permissionLine(message map[string]any) renderLine {
	outcome, _ := protocol.String(message, "outcome")
	tool, _ := protocol.String(message, "tool")
	var extras []string
	// The rule travels as one formatted string ("git add *"), not as the list the
	// gate matched on — accept both shapes so neither producer can silently drop
	// the line that says *why* a command was released without asking.
	if rule := wordsOf(message["rule"]); len(rule) > 0 {
		extras = append(extras, i18n.T("permission.rule_hit", "rule", strings.Join(rule, " ")))
	}
	if remembered := wordsOf(message["remembered"]); len(remembered) > 0 {
		extras = append(extras, i18n.T("permission.remembered",
			"remembered", strings.Join(remembered, i18n.T("list.separator"))))
	}
	if waited, ok := protocol.Int(message, "waited_ms"); ok && waited > 0 {
		extras = append(extras, i18n.T("permission.waited", "duration", msText(waited)))
	}
	tail := ""
	if len(extras) > 0 {
		tail = i18n.T("permission.tail", "extras", strings.Join(extras, " · "))
	}
	role := "process"
	switch outcome {
	case "user_denied", "policy_denied", "no_asker":
		role = "warn"
	}
	return renderLine{segments: []seg{
		{text: i18n.T("permission.line_prefix"), role: "process"},
		{text: tool, role: "tool"},
		{text: " → ", role: "process"},
		{text: outcomeText(outcome), role: role},
		{text: tail, role: "rule"},
	}}
}

// wordsOf reads a field that may arrive as one string or as a list of them.
func wordsOf(value any) []string {
	switch typed := value.(type) {
	case nil:
		return nil
	case string:
		if typed == "" {
			return nil
		}
		return []string{typed}
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			out = append(out, fmt.Sprint(item))
		}
		return out
	case []string:
		return typed
	default:
		return []string{fmt.Sprint(typed)}
	}
}

// turnHeader is the turn separator: `Turn 1   running · step 1`. Exactly two
// stretches — the horizontal rule between them is drawn by the layout at the
// real width, and the split point has to be a structural fact, not a guess at
// the first space.
func turnHeader(turn *turnData) renderLine {
	if turn.finished {
		outcome := stopReasonText(turn.outcome)
		body := i18n.T("turn.state.other", "n", turn.steps,
			"duration", durationText(turn.duration), "outcome", outcome)
		if turn.steps == 1 {
			body = i18n.T("turn.state.one", "n", turn.steps,
				"duration", durationText(turn.duration), "outcome", outcome)
		}
		return renderLine{segments: []seg{
			{text: i18n.T("turn.head", "index", turn.index), role: "turn_end"},
			{text: " " + body, role: "rule"},
		}}
	}
	return renderLine{segments: []seg{
		{text: i18n.T("turn.head", "index", turn.index), role: "turn_start"},
		{text: " " + i18n.T("turn.running"), role: "waiting"},
	}}
}

// stopReasonText is the wording for how a turn ended.
//
// An unrecognised reason prints itself: when an older interface meets a runtime
// that learned a new enum, `auto_something` on screen is searchable and
// "unknown" is not.
func stopReasonText(reason string) string {
	if text, ok := i18n.Lookup("stop." + reason); ok {
		return text
	}
	if reason == "" {
		return "?"
	}
	return reason
}

// modelLine is
// `  · model 1.2s  context 12.4k tokens (cache hit 10.1k · 88%)  38 tok/s`.
//
// It is the only place the cost of one step is visible while the turn runs, and
// the cache figure is the one number that explains why two identical-looking
// turns differ in cost. The output rate is the second such number, for the same
// reason: it is what turns "that step felt slow" into something with a figure
// attached, and it is per-step so two steps of a turn can be compared.
//
// The rate **omits itself** when there is nothing to divide. A step that only
// asked for tools reports no completion tokens, and a tool-only session would
// otherwise carry `avg — tok/s` on every line it draws — a permanent statement
// about a measurement nobody was waiting for. Same rule as the `cached_tokens`
// segment above it.
func modelLine(payload map[string]any) renderLine {
	parts := []seg{{text: i18n.T("event.model_prefix"), role: "process"}}
	if span, ok := protocol.Int(payload, "duration_ms"); ok {
		parts = append(parts, seg{text: msText(span), role: "process"})
	}
	if tokens, ok := protocol.Int(payload, "prompt_tokens"); ok {
		parts = append(parts, seg{text: i18n.T("event.context_tokens", "tokens", stateTokensText(tokens)), role: "process"})
	}
	if cached, ok := protocol.Int(payload, "cached_tokens"); ok {
		percent := "—"
		if prompt, okPrompt := protocol.Int(payload, "prompt_tokens"); okPrompt && prompt > 0 {
			percent = fmt.Sprintf("%.0f", float64(cached)/float64(prompt)*100)
		}
		parts = append(parts, seg{text: i18n.T("event.cache_hit",
			"cached", stateTokensText(cached), "percent", percent), role: "rule"})
	}
	if completion, hasTokens := protocol.Int(payload, "completion_tokens"); hasTokens {
		if span, hasSpan := protocol.Int(payload, "duration_ms"); hasSpan {
			if rate, ok := state.OutputRateText(completion, span); ok {
				parts = append(parts, seg{text: i18n.T("event.output_rate", "rate", rate), role: "rule"})
			}
		}
	}
	return renderLine{segments: parts}
}

// thinkingFolded is `  ▸ Thinking (1,284 chars · Ctrl+T to expand)`. In quiet
// mode, while the model is streaming, the spin frame and the live character count
// replace the static tail.
func thinkingFolded(turn *turnData, chars int, spin string) renderLine {
	if spin != "" {
		// Quiet mode: the frame and the live count are the only moving things on a
		// screen where nothing else does.
		return renderLine{segments: []seg{
			{text: i18n.T("think.prefix_folded"), role: "think_head"},
			{text: " " + spin, role: "waiting"},
			{text: i18n.Tn("think.live_chars", chars, "chars", countText(chars)), role: "rule"},
		}}
	}
	return renderLine{segments: []seg{
		{text: i18n.T("think.prefix_folded"), role: "think_head"},
		{text: i18n.Tn("think.folded_tail", chars, "chars", countText(chars)), role: "rule"},
	}}
}

// thinkingStreamHead is the block head of a reasoning chunk that is still
// growing: `  ▸ Thinking`. In normal (non-quiet) mode the body spreads out under
// it and is rewritten whole on every chunk; quiet mode keeps it folded instead.
func thinkingStreamHead() renderLine {
	return renderLine{segments: []seg{
		{text: i18n.T("think.prefix_folded"), role: "think_head"},
	}}
}

// thinkingExpandedHead is the block head once the block is open. The glyph
// changes direction and the tail says how to close it again — leaving the folded
// wording on an expanded block made Ctrl+T look like it had done nothing.
func thinkingExpandedHead(chars int) renderLine {
	return renderLine{segments: []seg{
		{text: i18n.T("think.prefix_expanded"), role: "think_head"},
		{text: i18n.T("think.expanded_tail"), role: "rule"},
	}}
}

// waitingLine is `  · waiting for your approval   [y] allow   [n] deny …`.
//
// It goes into the log **before** the modal covers the screen: the modal is the
// place the decision is made, and this line is the record that the turn stopped
// there — which is what someone scrolling back is looking for when they wonder
// why a turn took four minutes.
func waitingLine(request map[string]any) renderLine {
	parts := []seg{
		{text: i18n.T("waiting.prompt"), role: "waiting"},
		{text: i18n.T("waiting.allow"), role: "rule"},
		{text: i18n.T("waiting.deny"), role: "rule"},
	}
	if request["remember"] != nil {
		parts = append(parts, seg{text: i18n.T("waiting.always"), role: "rule"})
	}
	if allowAll, _ := request["allow_trust_all"].(bool); allowAll {
		parts = append(parts, seg{text: i18n.T("waiting.allow_all"), role: "rule"})
	}
	parts = append(parts, seg{text: i18n.T("waiting.escape"), role: "rule"})
	return renderLine{segments: parts}
}

// deniedLine is the extra row under a refusal. The result line already says
// "✗", and the mark alone does not say whether the tool ran and failed or never
// ran at all — which is the difference between "fix the tool" and "change the
// policy".
func deniedLine() renderLine {
	return renderLine{segments: []seg{
		{text: i18n.T("event.denied"), role: "denied"},
	}}
}

// batchLine is the one line a parallel batch leaves behind: how many calls went
// out together and how long the batch took.
func batchLine(payload map[string]any) renderLine {
	n, _ := protocol.Int(payload, "calls")
	// The wall clock goes in as a number: the template already ends in "ms", so
	// pre-formatting it produced "1.2sms" past a second.
	return renderLine{segments: []seg{
		{text: "  · ", role: "process"},
		{text: i18n.Tn("event.tool_batch", int(n), "n", n), role: "process"},
		{text: i18n.T("event.tool_batch_wall", "wall", intOf(payload["wall_ms"])), role: "rule"},
	}}
}

// thinkingBody renders the reasoning text as a quote block: the sunken
// background bounds it and the vertical bar marks the edge. Both paths — first
// paint and Ctrl+T expand — go through this one constructor, so folding a block
// twice cannot grow two different shapes.
//
// **The text is flattened to one paragraph before wrapping.** A reasoning channel
// that emits one word per line (they all do — the delimiter is not a sentence
// break) would otherwise draw a 400-character thought as 100 quoted rows, which
// pushes the answer off the screen. Wrapping comes after the flattening, so the
// block still respects the width; what it no longer respects is a newline that was
// never a paragraph break to begin with.
func thinkingBody(text string, width int) []string {
	flat := strings.Join(strings.Fields(strings.ReplaceAll(text, "\n", " ")), " ")
	if flat == "" {
		return nil
	}
	background := lipgloss.NewStyle().Background(lipgloss.Color(currentTheme.sunk))
	body := currentTheme.styleFor("think_body")
	bar := currentTheme.styleFor("quote")
	var out []string
	for _, physical := range wrapCells(flat, maxInt(width-6, 20)) {
		// Two halves make the block: the sunken background bounds it and the
		// vertical bar marks the edge. The bar carries its own role — the
		// line colour, one step quieter than the words it frames.
		out = append(out, background.Render(
			bar.Render("  │ ")+body.Render(physical)))
	}
	return out
}

// ── markdown ──────────────────────────────────────────────────────────────────

// markdownRendererCache holds the renderer itself — theme + width + colour depth,
// no content. What it does *not* hold is anything rendered with it; that is
// `markdownResults` below, and the distinction is the difference between a long
// session and a slow one.
var markdownRendererCache markdownRendererSlot

type markdownRendererSlot struct {
	identity markdownIdentity
	width    int
	value    *glamour.TermRenderer
}

// markdownIdentity is everything an answer's rendering depends on besides the
// text and the width: the palette, and the colour depth it was drawn at. Both
// caches below key on it, because a row rendered in 24-bit colour is not the row
// a 16-colour terminal should be given.
type markdownIdentity struct {
	theme   themeKey
	profile termenv.Profile
}

// markdownProfile is the colour depth the answer is drawn at.
//
// It is deliberately the **chrome's** profile: the frame, the panels and the
// transcript go through lipgloss, which follows the terminal's own detection
// (`NO_COLOR`, `COLORTERM`, `TERM`). glamour's default is TrueColor outright, so
// without this the answer alone emitted 24-bit escapes into a terminal that was
// detected as 16-colour — or into one whose user had asked for no colour at all,
// while every other line on the screen stayed plain.
func markdownProfile() termenv.Profile {
	return lipgloss.ColorProfile()
}

func markdownRenderer(width int) *glamour.TermRenderer {
	identity := markdownIdentity{theme: currentTheme.key, profile: markdownProfile()}
	if markdownRendererCache.value != nil && markdownRendererCache.identity == identity &&
		markdownRendererCache.width == width {
		return markdownRendererCache.value
	}
	// The syntax palette is registered **before** the renderer that will use it:
	// glamour resolves a code block's style by name while rendering. See
	// registerMarkdownChroma.
	codeTheme := ""
	if identity.profile != termenv.Ascii {
		codeTheme = markdownChromaStyle
		registerMarkdownChroma(currentTheme)
	}
	renderer, err := glamour.NewTermRenderer(
		glamour.WithStyles(markdownStyle(currentTheme, codeTheme)),
		glamour.WithWordWrap(maxInt(width-4, 40)),
		glamour.WithColorProfile(identity.profile),
		glamour.WithChromaFormatter(chromaFormatter(identity.profile)),
	)
	if err != nil {
		return nil
	}
	markdownRendererCache = markdownRendererSlot{identity, width, renderer}
	return renderer
}

// markdownChromaStyle is the name our syntax highlighting is registered under.
//
// **It is ours rather than glamour's, and that is the whole point.** glamour
// registers its own chroma palette under a fixed literal name and only when that
// name is not taken yet, so with three themes in one process the first theme to
// draw a code block owned the colours for the rest of the session: `/theme`
// repainted everything except the inside of a fenced code block. Registering
// under a name we own, and re-registering whenever the renderer is rebuilt,
// makes a palette switch reach the code block too.
const markdownChromaStyle = "tudouni"

// registerMarkdownChroma installs t's syntax palette under markdownChromaStyle.
//
// chroma keeps its styles in one process-wide map and glamour reaches them by
// name, so this is the only handle it gives us. Re-registering overwrites, which
// is what makes a theme switch work. Both the write here and the read during a
// render happen on the render path, which is single-goroutine.
func registerMarkdownChroma(t theme) {
	chromastyles.Register(chroma.MustNewStyle(markdownChromaStyle, chromaEntriesOf(t)))
}

// chromaEntriesOf maps the theme onto chroma's token types.
//
// The rule is the one the rest of the screen follows, so a code block reads as
// part of the interface rather than as a sample of somebody else's colours:
// structure (keywords) takes the accent — the same "this is where the machine
// acts" colour the tool lines draw with — names take the body inks, values take
// the two semantic colours (ok for text, warn for numbers), and comments step
// back to the quietest ink. Every value is a colour the palette already names;
// none is invented here.
func chromaEntriesOf(t theme) chroma.StyleEntries {
	entries := chroma.StyleEntries{
		chroma.Text:                t.ink,
		chroma.Error:               t.danger,
		chroma.Comment:             t.ink4,
		chroma.CommentPreproc:      t.warn,
		chroma.Keyword:             t.accent,
		chroma.KeywordReserved:     t.accent,
		chroma.KeywordNamespace:    t.accent,
		chroma.KeywordType:         t.ok,
		chroma.Operator:            t.ink3,
		chroma.Punctuation:         t.ink3,
		chroma.Name:                t.ink2,
		chroma.NameBuiltin:         t.ok,
		chroma.NameTag:             t.accent,
		chroma.NameAttribute:       t.ink2,
		chroma.NameClass:           t.ink,
		chroma.NameConstant:        t.ok,
		chroma.NameDecorator:       t.warn,
		chroma.NameFunction:        t.ok,
		chroma.NameOther:           t.ink2,
		chroma.Literal:             t.ink2,
		chroma.LiteralNumber:       t.warn,
		chroma.LiteralString:       t.ok,
		chroma.LiteralStringEscape: t.warn,
		chroma.GenericDeleted:      t.danger,
		chroma.GenericInserted:     t.ok,
		chroma.GenericSubheading:   t.ink3,
	}
	// **Every token carries the block's own surface.** A fenced code block is the
	// third thing on this screen that means "quoted material" (with the thinking
	// block and inline code) and it was the only one not on the sunken surface:
	// once highlighting is on, the text is written by chroma, `CodeBlock.Color`
	// and its background reach the block's padding and nothing else, and both of
	// chroma's terminal formatters clear the style's own background. Painting each
	// token is what makes that surface visible.
	out := make(chroma.StyleEntries, len(entries))
	for token, entry := range entries {
		out[token] = entry + " bg:" + t.sunk
	}
	return out
}

// chromaFormatter is the highlighter's output width, chosen the same way the
// colour profile above it is: true colour where the terminal can show it, 256
// colours where it cannot. glamour's default is the 256-colour formatter
// whatever the terminal is, which is why the code block was the one place on
// screen still emitting indexed colours next to 24-bit ones.
func chromaFormatter(profile termenv.Profile) string {
	switch profile {
	case termenv.TrueColor:
		return "terminal16m"
	case termenv.ANSI256:
		return "terminal256"
	case termenv.ANSI:
		return "terminal16"
	default:
		// Unreachable in practice: without colour there is no highlighting at all
		// (the code block theme is left empty) and this formatter is never asked
		// for a style.
		return "terminal"
	}
}

// markdownResults memoises what glamour produced, keyed on the answer, the width
// and the renderer identity (theme + colour depth).
//
// **This cache is what keeps a long session from getting slower as it grows.**
// Bubble Tea redraws the whole screen from model state on every message —
// including every streamed delta and every keystroke — and `renderTranscript`
// walks the entire history each time. Without this, every one of those frames
// re-ran glamour over every finished answer in the conversation. Measured on a
// 120×40 terminal with medium-length Chinese answers carrying a code block, one
// answer cost ~3.5ms to typeset, so an 80-turn session paid ~280ms of glamour
// inside a ~327ms frame: the frame was almost entirely re-typesetting text that
// had not changed since the frame before. With the cache, an 80-turn frame is
// ~7ms and no longer reaches glamour at all after the first draw — see
// TestLongSessionFrameDoesNotRerenderHistory, which asserts the count rather
// than the duration because the count is what holds on every machine.
//
// Two facts make memoising safe here, and both are properties of how the
// renderer is used rather than assumptions about glamour:
//
//   - **the same input gives the same bytes.** Verified, not assumed: see
//     TestRenderedMarkdownIsStable. The renderer carries no state between
//     Render calls that reaches the output.
//   - **a stale entry cannot be reached.** The width is in the key, and so is
//     the renderer identity — so `/theme`, a resize, a change of colour depth or
//     a different answer each address a different entry. `markdownStyle` reads
//     only `currentTheme` and `markdownProfile()`, which is why those two are
//     enough to describe the renderer, and why a theme switch needs no
//     invalidation hook (the mistake `--theme` already made once, see
//     `newModel`).
//
// The value holds the source text as well as the rows. That is deliberate: the
// key is a hash, so it can collide, and a cache that answers a collision with
// somebody else's answer would be a correctness bug rather than a slow frame.
// The text is re-checked byte for byte before a hit is trusted. It costs one
// more copy of each answer — small against the rendered rows it guards.
var markdownResults = struct {
	entries map[markdownKey]*markdownEntry
	order   []markdownKey
	// frame counts render passes and evictAt is when the next sweep is due, so
	// that eviction can happen between frames rather than inside one. See
	// beginMarkdownFrame.
	frame   uint64
	evictAt uint64
}{}

// markdownResultLimit is how many rendered answers are kept between sweeps, and
// markdownResultPeak is the memory ceiling the insertion path enforces.
//
// The gap between the two is what stops a frame from evicting the answer it is
// about to draw. Rendering a frame walks the transcript oldest-first, so with a
// cache at its limit every miss evicts the very next answer in that walk: a
// session only slightly over the limit then misses on *every* answer, every
// frame, with a full cache and a zero hit rate. The slack lets one render pass
// finish with everything it touched still held; the sweep at the next frame
// boundary then drops the oldest answers — the ones the window has scrolled past
// — and keeps the fresh tail.
//
// The limit is per sweep interval, not per frame, so a frame that renders more
// than this many answers still completes without evicting itself. The peak only
// bites on a session an order of magnitude over the limit, where it is the
// memory ceiling rather than the working set: 4096 entries at the ~19KB an
// answer of the measured size costs is ~78MB in the pathological case, and a
// few MB in ordinary use.
const (
	markdownResultLimit = 512
	markdownResultPeak  = 4096
)

type markdownKey struct {
	hash     uint64
	width    int
	identity markdownIdentity
	// length is compared together with the hash, so a shorter colliding text
	// cannot be mistaken for a longer one before the byte comparison happens.
	length int
}

type markdownEntry struct {
	text  string
	lines []string
}

func markdownHash(text string) uint64 {
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(text))
	return hash.Sum64()
}

// cachedMarkdown returns the rendered rows for this answer, rendering them if
// they are not held. It never assumes the caller's text matches the entry it
// found by hash: see markdownResults.
//
// The returned slice is **shared, not copied**, and every caller treats it as
// read-only — a frame appends from it into its own row list but never writes
// into it. Writing into it would corrupt the entry for every later frame.
func cachedMarkdown(text string, width int) []string {
	key := markdownKey{
		hash:     markdownHash(text),
		width:    width,
		identity: markdownIdentity{theme: currentTheme.key, profile: markdownProfile()},
		length:   len(text),
	}
	if entry, ok := markdownResults.entries[key]; ok && entry.text == text {
		return entry.lines
	}
	lines, identity := renderMarkdownUncached(text, width)
	// The identity is taken from the render that just happened, so a renderer
	// built for one palette (or for another colour depth) can never be filed
	// under it — which is the whole reason it is part of the key.
	key.identity = identity
	if markdownResults.entries == nil {
		markdownResults.entries = make(map[markdownKey]*markdownEntry)
	}
	markdownResults.entries[key] = &markdownEntry{text: text, lines: lines}
	// A re-inserted key is appended again rather than moved in place: the order
	// slice is a bag of candidate keys and the map is what says which of them are
	// live. A stale duplicate is reclaimed for free when the sweep reaches it,
	// and because the map was written first, the live copy is never the one that
	// goes — see dropOldestMarkdownResults.
	markdownResults.order = append(markdownResults.order, key)
	evictMarkdownResults()
	return lines
}

// beginMarkdownFrame marks the start of one render pass.
//
// Everything in the pass belongs to the same frame, so the cache must not evict
// against it — an answer dropped halfway through a pass is an answer the pass
// re-renders immediately. Called from `renderTranscript`, which is the one place
// that renders the whole history.
//
// This is also the only place the cache is swept, and that is deliberate. An
// earlier version swept from the insertion path instead, which meant a frame
// that was entirely cache hits — the steady state, and the case worth optimising
// — never swept at all. A frame boundary is the one moment that knows a pass has
// finished and therefore what "too old to be needed again" means.
func beginMarkdownFrame() {
	markdownResults.frame++
	if markdownResults.frame < markdownResults.evictAt {
		return
	}
	markdownResults.evictAt = markdownResults.frame + uint64(markdownResultLimit)
	dropOldestMarkdownResults(len(markdownResults.order) - markdownResultLimit)
}

// evictMarkdownResults is the memory ceiling, applied on the insertion path
// because that path is the only one that can grow the cache without a frame
// boundary in sight. See the note on beginMarkdownFrame for why the ordinary
// sweep does not live here.
func evictMarkdownResults() {
	if len(markdownResults.order) > markdownResultPeak {
		dropOldestMarkdownResults(len(markdownResults.order) - markdownResultLimit)
	}
}

// dropOldestMarkdownResults removes up to count of the longest-held entries.
func dropOldestMarkdownResults(count int) {
	for index := 0; index < count && len(markdownResults.order) > 0; index++ {
		key := markdownResults.order[0]
		markdownResults.order = markdownResults.order[1:]
		delete(markdownResults.entries, key)
	}
}

// markdownStyle is the answer's typography, taken from the theme rather than from
// the renderer's own defaults.
//
// **Everything the answer draws has to come from here.** glamour's base styles are
// a starting point, not a stylesheet: a field left alone keeps glamour's colour
// rather than the theme's, and the ones that did are the reason this function is
// longer than the list of things it has something to say about (see the note on
// images and the table rules below, and `TestNoForeignColourReachesTheAnswer`).
//
// Three of these are not cosmetic:
//
//   - **the document margin is zero.** The renderer's default indents every line
//     by two cells, which lands on top of this screen's `│ ` bar and pushes the
//     body out of line with the tool lines above it. The original's stylesheet
//     sets that alignment explicitly, and the code block below follows it for the
//     same reason.
//   - **h2-h6 lose their `## ` prefixes.** The renderer's default writes the
//     literal hashes, so a document written with headings reads as markup instead
//     of as headings.
//   - **h1 loses its background.** Both of glamour's base styles paint a level-1
//     heading on a blue slab, and clearing the prefix does not clear the slab: a
//     document with a `#` title drew one amber-on-blue line, the only colour on
//     the screen the theme had never heard of.
//
// codeTheme is the name of the syntax palette registered by
// registerMarkdownChroma, or "" to leave fenced code unhighlighted.
func markdownStyle(t theme, codeTheme string) ansi.StyleConfig {
	style := styles.DarkStyleConfig
	if !t.dark {
		style = styles.LightStyleConfig
	}
	zero := uint(0)
	style.Document.Margin = &zero
	style.Document.Color = &t.ink2
	style.Document.BlockPrefix = ""
	style.Document.BlockSuffix = ""

	// Headings: the theme's brightest ink, bold, no markup characters.
	bold := true
	for _, heading := range []*ansi.StyleBlock{
		&style.Heading, &style.H1, &style.H2, &style.H3,
		&style.H4, &style.H5, &style.H6,
	} {
		heading.Prefix = ""
		heading.Suffix = ""
		heading.Color = &t.ink
		heading.Bold = &bold
		heading.BlockSuffix = ""
		heading.BackgroundColor = nil
	}

	// Code: the same sunken background the thinking block uses, so "this is
	// quoted material" is one idea on this screen rather than three. The block
	// loses glamour's two-cell indent so it starts where the prose does — the same
	// alignment the document margin above is about.
	style.Code.Color = &t.ink
	style.Code.BackgroundColor = &t.sunk
	style.CodeBlock.Color = &t.ink
	style.CodeBlock.BackgroundColor = &t.sunk
	style.CodeBlock.Margin = &zero
	// Syntax highlighting is **ours**: the palette is registered under a name we
	// own and re-registered on every theme change (see registerMarkdownChroma).
	// glamour's own Chroma block is therefore cleared rather than filled in —
	// leaving it set makes glamour register its palette under a fixed name that
	// only the first theme in the process can claim.
	style.CodeBlock.Chroma = nil
	style.CodeBlock.Theme = codeTheme

	// The rest of the palette, so nothing in the answer is a colour the theme has
	// never heard of.
	style.Link.Color = &t.accent
	style.LinkText.Color = &t.accent
	// Images carry their own two colours in glamour's styles — a pink link and a
	// grey label — which is the same leak as the h1 slab.
	style.Image.Color = &t.accent
	style.ImageText.Color = &t.ink4
	style.Item.Color = &t.ink4
	style.Enumeration.Color = &t.ink2
	style.BlockQuote.Color = &t.ink3
	style.BlockQuote.BackgroundColor = &t.sunk
	// Bold follows the accent: the same colour as the input box rules, so a
	// bold phrase in the answer reads as one of the screen's structural marks.
	style.Strong.Color = &t.accent
	style.Emph.Color = &t.ink2
	style.Strikethrough.Color = &t.ink3
	style.HorizontalRule.Color = &t.hairline
	style.Table.Color = &t.ink2
	// The table's rules are pinned to the glyphs the rest of the screen draws
	// with. Left unset, glamour falls back to lipgloss's own default border —
	// a character choice made outside the theme, which is how the table ended up
	// as the one framed thing on screen with rules of its own.
	style.Table.CenterSeparator = &tableCross
	style.Table.ColumnSeparator = &tableBar
	style.Table.RowSeparator = &tableRule
	style.DefinitionTerm.Color = &t.ink
	style.DefinitionDescription.Color = &t.ink3
	return style
}

// The table's glyphs, the same ones the frame and the rail draw with.
var (
	tableCross = "┼"
	tableBar   = "│"
	tableRule  = "─"
)

// renderMarkdown formats one finished answer **through the result cache**. The
// uncached form is renderMarkdownUncached below: this wrapper exists so no
// caller can bypass the cache by accident and put the per-frame glamour cost
// back.
func renderMarkdown(text string, width int) []string {
	return cachedMarkdown(text, width)
}

// markdownUncachedRenders counts how many times an answer actually reached
// glamour. It is incremented only on a cache miss, so it is the cache's own hit
// counter — and it is the thing the long-session regression test asserts on,
// because a count is machine-independent where a duration is not.
var markdownUncachedRenders int

// renderMarkdownUncached formats one finished answer and reports the renderer
// identity it was rendered under. Failure falls back to the plain text: a
// malformed document is the model's problem to see, not a crash.
//
// The identity comes back from the renderer that did the work rather than from
// `currentTheme` at the end, because the two differ if a `/theme` lands
// mid-render — and filing a render under the palette that did not produce it
// would hand the next frame a screen in the wrong colours.
func renderMarkdownUncached(text string, width int) ([]string, markdownIdentity) {
	markdownUncachedRenders++
	identity := markdownIdentity{theme: currentTheme.key, profile: markdownProfile()}
	renderer := markdownRenderer(width)
	if renderer == nil {
		return wrapCells(text, width), identity
	}
	identity = markdownRendererCache.identity
	out, err := renderer.Render(text)
	if err != nil {
		return wrapCells(text, width), identity
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	// Drop glamour's trailing blank padding; the layout supplies its own.
	for len(lines) > 0 && strings.TrimSpace(stripANSI(lines[len(lines)-1])) == "" {
		lines = lines[:len(lines)-1]
	}
	for len(lines) > 0 && strings.TrimSpace(stripANSI(lines[0])) == "" {
		lines = lines[1:]
	}
	return lines, identity
}

// stripANSI removes SGR sequences for measurement only.
func stripANSI(text string) string {
	var out strings.Builder
	inEscape := false
	for _, char := range text {
		if inEscape {
			if char == 'm' {
				inEscape = false
			}
			continue
		}
		if char == '\x1b' {
			inEscape = true
			continue
		}
		out.WriteRune(char)
	}
	return out.String()
}

// ── helpers ───────────────────────────────────────────────────────────────────

func asInt(value any) (int, bool) {
	switch number := value.(type) {
	case int:
		return number, true
	case int64:
		return int(number), true
	case float64:
		return int(number), true
	default:
		return 0, false
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// msText renders milliseconds, seconds over a second.
//
// A result event with no `duration_ms` prints an em dash, not `0ms`: a measurement
// that was never taken is not a measurement of zero, and `0ms` on a tool line reads
// as "this was instant" — a claim the interface cannot make.
func msText(value any) string {
	ms, ok := asInt(value)
	if !ok || ms <= 0 {
		return "—"
	}
	if ms < 1000 {
		return fmt.Sprintf("%dms", ms)
	}
	return fmt.Sprintf("%.1fs", float64(ms)/1000)
}

func durationText(d time.Duration) string {
	if d < time.Second {
		return fmt.Sprintf("%dms", d.Milliseconds())
	}
	return fmt.Sprintf("%.1fs", d.Seconds())
}

// countText is the thousands-separated character count.
func countText(n int) string {
	text := fmt.Sprintf("%d", n)
	if len(text) <= 3 {
		return text
	}
	var out []string
	for len(text) > 3 {
		out = append([]string{text[len(text)-3:]}, out...)
		text = text[:len(text)-3]
	}
	return text + "," + strings.Join(out, ",")
}

func outcomeText(outcome string) string {
	// The wording lives under `outcome.*`, one key per value the gate can report.
	// Building the key from the value is right; looking it up in the wrong
	// namespace was not — it produced `⟪activity.permission.auto_allowed⟫` for
	// every outcome except the four that happened to exist there.
	if text, ok := i18n.Lookup("outcome." + outcome); ok {
		return text
	}
	if outcome == "" {
		return "?"
	}
	return outcome
}

// toolBrief picks the argument that names what this call is about. The table is
// per tool because only the tool knows which argument carries the point; the
// fallbacks exist because the table will age — an MCP tool is the expected case.
func toolBrief(tool string, arguments string) string {
	briefKeys := map[string]string{
		"read_file": "path", "write_file": "path", "edit_file": "path",
		"list_files": "path", "grep": "pattern", "shell": "command",
		"shell_background": "command", "job_output": "job_id", "job_kill": "job_id",
		"load_skill": "name", "fetch_web": "url", "web_search": "query",
		"ask_user": "question", "todo_write": "todos", "get_current_time": "",
	}
	// `file` and `prompt` are here because the table ages: a tool the interface
	// has never heard of still names its subject with one of these.
	fallbackOrder := []string{"path", "file", "command", "pattern", "query", "url", "name", "question", "prompt"}

	parsed := map[string]any{}
	_ = jsonUnmarshalObject(arguments, &parsed)
	if len(parsed) == 0 {
		// The payload was truncated on the wire (a write_file content is routinely
		// thousands of characters). Grep the literal `"key": "value"` spelling.
		return briefFromPreview(tool, arguments, briefKeys, fallbackOrder)
	}

	if key, known := briefKeys[tool]; known && key != "" {
		if value, ok := parsed[key]; ok {
			return briefValue(tool, value)
		}
	}
	for _, key := range fallbackOrder {
		if value, ok := parsed[key]; ok {
			return briefValue(tool, value)
		}
	}
	// No preferred key matched: the first string in document order is still the
	// most likely subject. Taking the alphabetically first one instead picked
	// `content` over `path` on a tool this table had never seen.
	for _, key := range orderedKeys(arguments) {
		if text, ok := parsed[key].(string); ok && text != "" {
			return briefValue(tool, text)
		}
	}
	return clipText(arguments, 60)
}

// briefValue turns one argument into the few words that fit on the line.
//
// The types matter: a list printed with Go's own formatting is a bracketed dump,
// and a bare true/false is not what a person writes. `todo_write` in particular
// carries a list of tasks, and "3 tasks" is the whole information content of that
// call.
func briefValue(tool string, value any) string {
	switch typed := value.(type) {
	case string:
		return clipBrief(typed)
	case []any:
		if tool == "todo_write" {
			return i18n.Tn("brief.todo_items", len(typed), "n", len(typed))
		}
		return i18n.Tn("brief.items", len(typed), "n", len(typed))
	case bool:
		if typed {
			return i18n.T("brief.yes")
		}
		return i18n.T("brief.no")
	case nil:
		return ""
	default:
		return clipBrief(fmt.Sprint(typed))
	}
}

// clipBrief flattens to one line and cuts to the brief limit.
//
// Flattening collapses every whitespace run, not just newlines: the value is a
// path or a command, and a run of spaces in the middle of it is noise that pushes
// the end of the line off the screen.
func clipBrief(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if runewidth.StringWidth(text) <= 60 {
		return text
	}
	return runewidth.Truncate(text, 59, "…")
}

// briefFromPreview recovers a value from a payload that was truncated on the wire
// and therefore will not parse.
func briefFromPreview(tool, arguments string, briefKeys map[string]string, fallbackOrder []string) string {
	preferred := briefKeys[tool]
	wanted := map[string]bool{}
	for _, key := range fallbackOrder {
		wanted[key] = true
	}
	if preferred != "" {
		wanted[preferred] = true
	}
	// Scan left to right and take the first key the table asks for. Probing each
	// key in turn instead would find `content` before `path` whenever the payload
	// happens to contain both, and it would miss any key the table does not list.
	first := ""
	for _, match := range jsonStringPairs(arguments) {
		if wanted[match[0]] {
			return briefValue(tool, match[1])
		}
		if first == "" {
			first = briefValue(tool, match[1])
		}
	}
	if first != "" {
		return first
	}
	return clipBrief(arguments)
}

// orderedKeys lists the parsed object's keys in the order they appear in the
// payload, which is the order the tool wrote them.
func orderedKeys(arguments string) []string {
	var keys []string
	seen := map[string]bool{}
	for _, match := range jsonStringPairs(arguments) {
		if !seen[match[0]] {
			seen[match[0]] = true
			keys = append(keys, match[0])
		}
	}
	return keys
}

func clipText(text string, width int) string {
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\n", " "), "\r", "")
	if runewidth.StringWidth(text) <= width {
		return text
	}
	return runewidth.Truncate(text, width-1, "…")
}

func sortedKeys(parsed map[string]any) []string {
	keys := make([]string, 0, len(parsed))
	for key := range parsed {
		keys = append(keys, key)
	}
	sortStrings(keys)
	return keys
}

// state token text lives in the state package; re-exported for convenience.
var tokensText = state.TokensText
