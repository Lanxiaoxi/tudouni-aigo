package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-runewidth"

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

	steps       int
	startedAt   time.Time
	finished    bool
	outcome     string // answered / cancelled / max_steps / failed
	thinking    string // the model's reasoning, whole, once the step is done
	thinkingRun string
	expanded    bool // Ctrl+T state for this turn's thinking block
}

// entry is one thing in the transcript: a turn, or a standalone line (a notice,
// an error, a rendered panel answer) that belongs to no turn.
type entry struct {
	turn *turnData
	line renderLine
	kind string // for standalone lines: user / assistant / notice / error / answer
	text string // raw text for markdown-rendered entries
}

// ── roles → colours ───────────────────────────────────────────────────────────
//
// Colour carries the hierarchy the terminal cannot get from font sizes: body
// text (ink), process lines (ink3), block titles and key hints (ink4). The risk
// suffix leans on the same three-colour code the rest of the interface uses.

func (t theme) styleFor(role string) lipgloss.Style {
	base := lipgloss.NewStyle()
	switch role {
	case "user":
		return base.Foreground(lipgloss.Color(t.ink)).Bold(true)
	case "answer":
		return base.Foreground(lipgloss.Color(t.ink2))
	case "process", "rule":
		return base.Foreground(lipgloss.Color(t.ink3))
	case "tool":
		return base.Foreground(lipgloss.Color(t.accent))
	case "result":
		return base.Foreground(lipgloss.Color(t.ok))
	case "denied":
		return base.Foreground(lipgloss.Color(t.danger))
	case "warn", "waiting":
		return base.Foreground(lipgloss.Color(t.warn))
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
		return base.Foreground(lipgloss.Color(t.ink2))
	case "turn_start":
		return base.Foreground(lipgloss.Color(t.accent)).Bold(true)
	case "turn_end":
		return base.Foreground(lipgloss.Color(t.ink3))
	case "skill":
		return base.Foreground(lipgloss.Color(t.skill))
	default:
		return base
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
		line.segments = append(line.segments, seg{text: " " + i18n.T("risk.medium"), role: "risk_medium"})
	case "high":
		line.segments = append(line.segments, seg{text: " " + i18n.T("risk.high"), role: "risk_high"})
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

// permissionLine is `  · permission shell → approved (looked for 2.4s · remembered …)`.
func permissionLine(message map[string]any) renderLine {
	outcome, _ := protocol.String(message, "outcome")
	tool, _ := protocol.String(message, "tool")
	var extras []string
	if rule, ok := message["rule"].([]any); ok && len(rule) > 0 {
		words := make([]string, 0, len(rule))
		for _, item := range rule {
			words = append(words, fmt.Sprint(item))
		}
		extras = append(extras, i18n.T("permission.rule_hit", "rule", strings.Join(words, " ")))
	}
	if remembered, ok := message["remembered"].([]any); ok && len(remembered) > 0 {
		parts := make([]string, 0, len(remembered))
		for _, item := range remembered {
			parts = append(parts, fmt.Sprint(item))
		}
		extras = append(extras, i18n.T("permission.remembered",
			"remembered", strings.Join(parts, i18n.T("list.separator"))))
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

// turnHeader is the turn separator: `Turn 1   running · step 1`. Exactly two
// stretches — the horizontal rule between them is drawn by the layout at the
// real width, and the split point has to be a structural fact, not a guess at
// the first space.
func turnHeader(turn *turnData) renderLine {
	if turn.finished {
		outcome := i18n.T("status.settled." + turn.outcome)
		body := i18n.T("turn.state.other", "n", turn.steps,
			"duration", durationText(time.Since(turn.startedAt)), "outcome", outcome)
		if turn.steps == 1 {
			body = i18n.T("turn.state.one", "n", turn.steps,
				"duration", durationText(time.Since(turn.startedAt)), "outcome", outcome)
		}
		return renderLine{segments: []seg{
			{text: i18n.T("turn.head", "index", turn.index), role: "turn_start"},
			{text: "   " + body, role: "turn_end"},
		}}
	}
	return renderLine{segments: []seg{
		{text: i18n.T("turn.head", "index", turn.index), role: "turn_start"},
		{text: "   " + i18n.T("turn.running"), role: "waiting"},
	}}
}

// thinkingFolded is `  ▸ Thinking (1,284 chars · Ctrl+T to expand)`. In quiet
// mode, while the model is streaming, the spin frame and the live character count
// replace the static tail.
func thinkingFolded(turn *turnData, chars int, spin string) renderLine {
	tail := fmt.Sprintf(" (%s · Ctrl+T)", countText(chars))
	if spin != "" {
		tail = fmt.Sprintf(" %s %s", spin, countText(chars))
	}
	return renderLine{segments: []seg{
		{text: i18n.T("think.prefix_folded"), role: "think_head"},
		{text: tail, role: "rule"},
	}}
}

// thinkingBody renders the reasoning text as a quote block: the sunken
// background bounds it and the vertical bar marks the edge. Both paths — first
// paint and Ctrl+T expand — go through this one constructor, so folding a block
// twice cannot grow two different shapes.
func thinkingBody(text string, width int) []string {
	if strings.TrimSpace(text) == "" {
		return nil
	}
	style := lipgloss.NewStyle().
		Foreground(lipgloss.Color(currentTheme.ink2)).
		Background(lipgloss.Color(currentTheme.sunk))
	var out []string
	for _, raw := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		for _, physical := range wrapCells(raw, maxInt(width-6, 20)) {
			out = append(out, style.Render("  │ ")+style.Render(physical))
		}
	}
	return out
}

// ── markdown ──────────────────────────────────────────────────────────────────

// markdownRenderer renders the assistant's finished answer. Built once per
// theme; streaming draws plain text and the finished answer is rendered once,
// because re-flowing markdown on every delta would make the stream stutter on
// exactly the messages long enough to be worth formatting.
var markdownCache = struct {
	key   themeKey
	width int
	value *glamour.TermRenderer
}{}

func markdownRenderer(width int) *glamour.TermRenderer {
	style := glamour.WithStandardStyle("dark")
	if !currentTheme.dark {
		style = glamour.WithStandardStyle("light")
	}
	if markdownCache.value != nil && markdownCache.key == currentTheme.key && markdownCache.width == width {
		return markdownCache.value
	}
	renderer, err := glamour.NewTermRenderer(
		style,
		glamour.WithWordWrap(maxInt(width-4, 40)),
	)
	if err != nil {
		return nil
	}
	markdownCache = struct {
		key   themeKey
		width int
		value *glamour.TermRenderer
	}{currentTheme.key, width, renderer}
	return renderer
}

// renderMarkdown formats one finished answer. Failure falls back to the plain
// text: a malformed document is the model's problem to see, not a crash.
func renderMarkdown(text string, width int) []string {
	renderer := markdownRenderer(width)
	if renderer == nil {
		return wrapCells(text, width)
	}
	out, err := renderer.Render(text)
	if err != nil {
		return wrapCells(text, width)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	// Drop glamour's trailing blank padding; the layout supplies its own.
	for len(lines) > 0 && strings.TrimSpace(stripANSI(lines[len(lines)-1])) == "" {
		lines = lines[:len(lines)-1]
	}
	for len(lines) > 0 && strings.TrimSpace(stripANSI(lines[0])) == "" {
		lines = lines[1:]
	}
	return lines
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
func msText(value any) string {
	ms, ok := asInt(value)
	if !ok || ms <= 0 {
		return "0ms"
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
	key := "activity.permission." + outcome
	value := i18n.T(key)
	if value == key {
		return outcome
	}
	return value
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
	fallbackOrder := []string{"path", "command", "pattern", "query", "url", "name", "question"}

	parsed := map[string]any{}
	_ = jsonUnmarshalObject(arguments, &parsed)
	if len(parsed) == 0 {
		// The payload was truncated on the wire (a write_file content is routinely
		// thousands of characters). Grep the literal `"key": "value"` spelling.
		for _, key := range append([]string{briefKeys[tool]}, fallbackOrder...) {
			if key == "" {
				continue
			}
			if value, ok := grepJSONString(arguments, key); ok {
				return clipText(value, 60)
			}
		}
		return clipText(arguments, 60)
	}

	if key, known := briefKeys[tool]; known {
		if value, ok := parsed[key]; ok {
			return clipText(fmt.Sprint(value), 60)
		}
	}
	for _, key := range fallbackOrder {
		if value, ok := parsed[key]; ok {
			return clipText(fmt.Sprint(value), 60)
		}
	}
	for _, key := range sortedKeys(parsed) {
		if text, ok := parsed[key].(string); ok && text != "" {
			return clipText(text, 60)
		}
	}
	return clipText(arguments, 60)
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
