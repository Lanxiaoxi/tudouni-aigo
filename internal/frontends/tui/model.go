package tui

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/mattn/go-runewidth"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/frontends"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
)

// Messages crossing from the protocol reader into the Bubble Tea loop.
type serverMessage struct{ payload map[string]any }

type permissionAsked struct{ request map[string]any }

type questionAsked struct{ request map[string]any }

type tickMsg time.Time

type spinnerMsg time.Time

// state is the panel snapshot, kept exactly as the runtime sent it.
//
// Nothing here is derived: "what does this combination mean" is the runtime's
// judgement, and recomputing it in the interface would be a second definition
// that drifts by *missing a warning* — the one failure nobody notices.
type panelstate struct {
	todos     []any
	jobs      []any
	mcp       []any
	riskScope []any
	messages  int
	steps     int
	model     string
	window    any
	autopilot bool
	thinking  bool
	effort    string
	granted   []any
	denied    []any
	prefixes  []any
	agentsMD  []any
	skills    []any
	// context is the last ledger payload `/context` (or a compaction) reported.
	// Nil until somebody asks: a status bar that showed zero before the first
	// question would teach the reader the number is meaningless.
	context map[string]any
}

type model struct {
	client  *protocol.Client
	bridge  *bridge
	options Options

	width  int
	height int

	// transcript holds the turns and standalone lines in arrival order. The
	// turn structure is what makes a finished header rewritable and a thinking
	// block foldable.
	transcript []entry
	// current is the turn being built, nil between turns.
	current *turnData
	turnSeq int

	input string
	// scroll is how many lines back from the bottom the transcript is drawn.
	scroll int

	panel panelstate

	// Streaming state for the current step.
	streamedText  string
	streamRunID   string
	streamStep    int
	thinkingChars int
	thinkingLive  bool

	busy bool
	// activity is the runtime's own one-line description. It comes from the
	// state reducer, never from a guess here.
	activity string

	pendingPermission map[string]any
	pendingQuestion   map[string]any
	questionInput     string

	notice      string
	lastRefresh time.Time
	auditPath   string
	sessionID   string

	// Catalogues that arrive with init. The frontend does not hardcode effort
	// levels or model lists: a copy here would drift the moment the runtime
	// learned a new level.
	modelCatalog  []any
	effortLevels  []string
	selectedModel string

	// Overlay panel state.
	overlay        overlay
	sessionOptions []option
	// pendingUserInput is the text submitted before run_started arrives, so the
	// turn block can open with the line the user actually typed.
	pendingUserInput string

	// Spin frame counter for quiet mode. Frame numbers come from a clock so two
	// things drawn at the same moment cannot each spin on their own.
	spins int

	// Display preferences. They change what is drawn and nothing else, which is
	// why they are not part of the panel state the runtime owns.
	railHidden bool
	railOpened bool // whether the rail has been auto-opened once by todos
	quiet      bool
	theme      themeKey
}

func newModel(client *protocol.Client, bridge *bridge, options Options) model {
	return model{
		client:  client,
		bridge:  bridge,
		options: options,
		width:   100,
		height:  30,
		theme:   defaultTheme,
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(waitForTick(), tea.WindowSize())
}

func waitForTick() tea.Cmd {
	return tea.Tick(2*time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func waitForSpinner() tea.Cmd {
	return tea.Tick(120*time.Millisecond, func(t time.Time) tea.Msg { return spinnerMsg(t) })
}

// Update is the whole interface's state machine.
func (m model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch typed := message.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = typed.Width, typed.Height
		return m, nil

	case tickMsg:
		// The runtime has no timers by design, so a background job that finishes
		// during a quiet moment would leave the panel claiming it is still
		// running. The interface asks — but only while something is outstanding,
		// and at a throttle.
		if outstanding(m.panel.jobs) && time.Since(m.lastRefresh) > 2*time.Second {
			m.lastRefresh = time.Now()
			m.client.RefreshState()
		}
		return m, waitForTick()

	case spinnerMsg:
		if m.busy && m.quiet {
			m.spins++
			return m, waitForSpinner()
		}
		return m, nil

	case serverMessage:
		m.handleServerMessage(typed.payload)
		return m, nil

	case permissionAsked:
		m.pendingPermission = typed.request
		return m, nil

	case questionAsked:
		m.pendingQuestion = typed.request
		m.questionInput = ""
		return m, nil

	case tea.KeyMsg:
		return m.handleKey(typed)
	}
	return m, nil
}

func (m *model) handleServerMessage(payload map[string]any) {
	switch protocol.TypeOf(payload) {
	case protocol.OutInit:
		if model, ok := protocol.String(payload, "model"); ok {
			m.panel.model = model
			m.selectedModel = model
		}
		m.panel.window, _ = payload["context_tokens"]
		m.panel.thinking, _ = protocol.Bool(payload, "thinking")
		m.panel.effort, _ = protocol.String(payload, "effort")
		m.auditPath, _ = protocol.String(payload, "audit_path")
		m.panel.autopilot, _ = protocol.Bool(payload, "autopilot")
		m.modelCatalog, _ = payload["model_catalog"].([]any)
		if levels, ok := payload["effort_levels"].([]any); ok {
			for _, level := range levels {
				if text, ok := level.(string); ok {
					m.effortLevels = append(m.effortLevels, text)
				}
			}
		}
		if session, ok := protocol.String(payload, "session_id"); ok {
			m.sessionID = session
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("init.session_id", "name", session, "state", stateSuffix(payload)), role: "notice"},
			}}, "notice", "")
		}
		for _, item := range noticesOf(payload) {
			m.appendLine(renderLine{segments: []seg{{text: item, role: "notice"}}}, "notice", "")
		}

	case protocol.OutSessionLoad:
		m.restoreMessages(payload)

	case protocol.OutEvent:
		m.handleEvent(payload)

	case protocol.OutDelta:
		m.handleDelta(payload)

	case protocol.OutDeltaReset:
		runID, _ := protocol.String(payload, "run_id")
		step, _ := protocol.Int(payload, "step")
		if runID == m.streamRunID && step == m.streamStep {
			// Half-written text never enters the history, so keeping it on
			// screen would leave something a restored session cannot account for.
			m.streamedText = ""
			m.dropStreamingAnswer()
		}

	case protocol.OutUI:
		m.handleUI(payload)

	case protocol.OutNotice:
		level, _ := protocol.String(payload, "level")
		text, _ := protocol.String(payload, "text")
		role := "notice"
		if level == "warn" {
			role = "warn"
		}
		m.appendLine(renderLine{segments: []seg{{text: text, role: role}}}, "notice", "")

	case protocol.OutSessions:
		m.openSessionPicker(payload)
	}
}

func stateSuffix(payload map[string]any) string {
	if resumed, _ := protocol.Bool(payload, "resumed"); resumed {
		return i18n.T("session.bar.resumed")
	}
	return i18n.T("init.session_new")
}

// restoreMessages replays a loaded session into the transcript. Every message
// becomes its own standalone entry: history has no turn boundaries worth
// inventing, and the replay is for reading, not for interaction.
func (m *model) restoreMessages(payload map[string]any) {
	messages, _ := payload["messages"].([]any)
	if len(messages) == 0 {
		return
	}
	m.appendLine(renderLine{segments: []seg{
		{text: i18n.Tn("session_load.restored", len(messages), "n", len(messages)), role: "rule"},
	}}, "notice", "")
	for _, item := range messages {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		role, _ := record["role"].(string)
		text := textOf(record)
		if text == "" || strings.HasPrefix(text, "[artifact ") {
			continue
		}
		switch role {
		case "user":
			m.appendUser(text)
		case "assistant":
			m.appendAnswer(text)
		}
	}
}

func (m *model) handleEvent(payload map[string]any) {
	kind, _ := protocol.String(payload, "kind")
	switch kind {
	case "run_started":
		m.busy = true
		m.activity = i18n.T("activity.preparing")
		m.beginTurn(payload)

	case "model_call":
		if m.current == nil {
			break
		}
		m.current.steps++
		status, _ := protocol.String(payload, "status")
		if status == "ok" {
			m.activity = i18n.T("activity.thinking")
		} else {
			attempt, _ := protocol.Int(payload, "attempt")
			backoff, hasBackoff := protocol.Int(payload, "backoff_ms")
			tail := ""
			if hasBackoff {
				tail = i18n.T("event.model_retry_wait", "backoff", backoff)
			}
			m.currentAppend(renderLine{segments: []seg{
				{text: i18n.T("event.model_retry", "attempt", attempt, "tail", tail), role: "warn"},
			}})
			m.activity = i18n.T("activity.retrying")
		}
		// The thinking text arrives whole after the model finished. The live copy
		// came through delta(reasoning); drawing both is drawing it twice.
		if reasoning, ok := protocol.String(payload, "reasoning"); ok && reasoning != "" {
			m.current.thinking = reasoning
			m.current.thinkingRun, _ = protocol.String(payload, "run_id")
		}

	case "tool_call":
		tool, _ := protocol.String(payload, "tool")
		risk, _ := protocol.String(payload, "risk")
		arguments, _ := protocol.String(payload, "arguments")
		callID, _ := protocol.String(payload, "call_id")
		if m.current == nil {
			break
		}
		if m.quiet {
			line := toolBriefLine(tool, arguments, callID, risk)
			m.current.lines = append(m.current.lines, line)
		} else {
			m.currentAppend(toolCallLine(tool, clipText(arguments, 120), payload["tool_index"], risk))
		}
		m.activity = i18n.T("activity.tool_call", "tool", tool, "index", "")

	case "tool_result":
		if m.current == nil {
			break
		}
		if m.quiet {
			tail := toolBriefDoneLine(payload)
			m.backfill(m.current, tail)
		} else {
			m.currentAppend(toolResultLine(payload["tool_index"], payload))
		}

	case "permission":
		if m.current != nil {
			m.currentAppend(permissionLine(payload))
		}

	case "tool_batch":
		n, _ := protocol.Int(payload, "n")
		if m.current != nil {
			m.currentAppend(renderLine{segments: []seg{
				{text: i18n.Tn("event.tool_batch", int(n), "n", n) +
					i18n.T("event.tool_batch_wall", "wall", msText(payload["wall_ms"])), role: "rule"},
			}})
		}

	case "run_finished":
		reason, _ := protocol.String(payload, "stop_reason")
		m.finishTurn(reason)
		m.activity = ""
	}
}

// beginTurn opens a new transcript block for this run.
func (m *model) beginTurn(payload map[string]any) {
	m.turnSeq++
	turn := &turnData{
		index:     m.turnSeq,
		runID:     stringOf(payload, "run_id"),
		userInput: m.pendingUserInput,
		startedAt: time.Now(),
		outcome:   "answered",
	}
	m.pendingUserInput = ""
	m.current = turn
	m.transcript = append(m.transcript, entry{turn: turn})

	// The rail auto-opens once when a task list first appears: "what it plans to
	// do" is the one place a person can see whether it understood, and that is
	// worth more than the 32 columns. After that, Ctrl+B rules.
	if !m.railOpened && len(m.panel.todos) > 0 {
		m.railOpened = true
		m.railHidden = false
	}
}

// finishTurn closes the current turn and rewrites its header in place.
func (m *model) finishTurn(reason string) {
	turn := m.current
	m.current = nil
	if turn == nil {
		return
	}
	turn.finished = true
	turn.outcome = "answered"
	switch reason {
	case "cancelled":
		turn.outcome = "cancelled"
	case "max_steps":
		turn.outcome = "limited"
		m.appendLine(renderLine{segments: []seg{
			{text: i18n.T("turn.max_steps_warning"), role: "warn"},
		}}, "notice", "")
	case "failed":
		turn.outcome = "failed"
	}
}

func (m *model) currentAppend(line renderLine) {
	if m.current == nil {
		m.appendLine(line, "notice", "")
		return
	}
	m.current.lines = append(m.current.lines, line)
}

// backfill finds the line with the same anchor and appends the tail. When the
// anchor cannot be found the tail is drawn as its own line — worse than
// attaching is an answer that never shows.
func (m *model) backfill(turn *turnData, tail renderLine) {
	if tail.anchor != "" {
		for index := len(turn.lines) - 1; index >= 0; index-- {
			if turn.lines[index].anchor == tail.anchor {
				head := turn.lines[index]
				head.segments = append(head.segments, seg{text: "   ", role: "rule"})
				head.segments = append(head.segments, tail.segments...)
				turn.lines[index] = head
				return
			}
		}
	}
	turn.lines = append(turn.lines, tail)
}

func (m *model) handleDelta(payload map[string]any) {
	channel, _ := protocol.String(payload, "channel")
	text, _ := protocol.String(payload, "text")
	runID, _ := protocol.String(payload, "run_id")
	step, _ := protocol.Int(payload, "step")

	if runID != m.streamRunID || step != m.streamStep {
		m.streamRunID, m.streamStep = runID, step
		m.streamedText = ""
		m.thinkingChars = 0
	}
	switch channel {
	case protocol.DeltaText:
		m.streamedText += text
		m.updateStreamingAnswer()

	case protocol.DeltaReasoning:
		m.thinkingChars += runewidth.StringWidth(text)
		m.thinkingLive = true
	}
}

func (m *model) handleUI(payload map[string]any) {
	kind, _ := protocol.String(payload, "kind")
	switch kind {
	case protocol.UIState:
		m.applyState(payload)
		// A panel left open is **live**: it has to follow the facts it shows, or
		// the highlight sits on a value that is no longer the current one.
		m.reloadOverlayOptions()

	case protocol.UIRunFinished:
		m.busy = false
		m.activity = ""
		answer, _ := protocol.String(payload, "answer")
		// The test is "did text reach the screen this turn", not "did I see a
		// delta": a turn that called tools and produced no text sends no delta,
		// and the answer is exactly the thing to draw.
		if answer != "" {
			m.appendAnswer(answer)
		}
		m.streamedText = ""
		m.streamRunID = ""
		m.thinkingChars = 0
		m.thinkingLive = false

	case protocol.UIStatus:
		m.renderStatus(payload)

	case protocol.UITools:
		m.appendLine(renderLine{segments: []seg{
			{text: frontends.RenderTools(payload), role: "rule"},
		}}, "answer", "")

	case protocol.UIContext:
		m.appendLine(renderLine{segments: []seg{
			{text: frontends.RenderContext(payload), role: "rule"},
		}}, "answer", "")
		if contextPayload, ok := payload["context"].(map[string]any); ok {
			m.panel.context = contextPayload
		}

	case protocol.UISkills:
		m.appendLine(renderLine{segments: []seg{
			{text: frontends.RenderSkills(payload), role: "rule"},
		}}, "answer", "")

	case protocol.UICompacted:
		compaction, _ := payload["compaction"].(map[string]any)
		m.appendLine(renderLine{segments: []seg{
			{text: frontends.RenderCompaction(compaction), role: "rule"},
		}}, "answer", "")
		if contextPayload, ok := payload["context"].(map[string]any); ok {
			m.panel.context = contextPayload
		}
	}
}

func (m *model) applyState(payload map[string]any) {
	if value, ok := payload["todos"].([]any); ok {
		m.panel.todos = value
	}
	if value, ok := payload["jobs"].([]any); ok {
		m.panel.jobs = value
	}
	if value, ok := payload["mcp"].([]any); ok {
		m.panel.mcp = value
	}
	if value, ok := payload["risk_scope"].([]any); ok {
		m.panel.riskScope = value
	}
	if value, ok := payload["messages"]; ok {
		m.panel.messages = intOf(value)
	}
	if value, ok := payload["steps"]; ok {
		m.panel.steps = intOf(value)
	}
	if value, ok := protocol.String(payload, "model"); ok {
		m.panel.model = value
	}
	if value, ok := payload["model_window"]; ok {
		m.panel.window = value
	}
	if value, ok := payload["autopilot"].(bool); ok {
		m.panel.autopilot = value
	}
	if value, ok := payload["thinking"].(bool); ok {
		m.panel.thinking = value
	}
	if value, ok := protocol.String(payload, "effort"); ok {
		m.panel.effort = value
	}
	if value, ok := payload["granted_tools"].([]any); ok {
		m.panel.granted = value
	}
	if value, ok := payload["denied_tools"].([]any); ok {
		m.panel.denied = value
	}
	if value, ok := payload["agents_md"].([]any); ok {
		m.panel.agentsMD = value
	}
	if value, ok := payload["skills"].([]any); ok {
		m.panel.skills = value
	}
}

func (m *model) renderStatus(payload map[string]any) {
	status, _ := payload["status"].(map[string]any)
	if status == nil {
		return
	}
	var rows []string
	if session, ok := status["session"].(map[string]any); ok {
		rows = append(rows, fmt.Sprintf("  %s: %v · %s",
			i18n.T("status.kv.session"), session["id"],
			i18n.T("status.session.span",
				"messages", i18n.Tn("status.session.messages", intOf(session["messages"])),
				"steps", i18n.Tn("status.session.steps", intOf(session["steps"])))))
	}
	if counters, ok := status["counters"].(map[string]any); ok {
		rows = append(rows, fmt.Sprintf("  %s: %v runs · %v model calls · %v tool calls",
			i18n.T("status.kv.turns"), counters["runs"], counters["model_calls"], counters["tool_calls"]))
	}
	if usage, ok := status["usage"].(map[string]any); ok {
		rows = append(rows, fmt.Sprintf("  %s: %v", i18n.T("status.kv.usage_total"), usage["prompt"]))
	}
	for _, row := range rows {
		m.appendLine(renderLine{segments: []seg{{text: row, role: "notice"}}}, "notice", "")
	}
}

// ── transcript helpers ────────────────────────────────────────────────────────

// appendLine adds a standalone entry.
func (m *model) appendLine(line renderLine, kind, text string) {
	m.transcript = append(m.transcript, entry{line: line, kind: kind, text: text})
	m.stick()
}

func (m *model) appendUser(text string) {
	m.appendLine(renderLine{segments: []seg{{text: "> ", role: "user"}, {text: text, role: "user"}}}, "user", text)
}

// appendAnswer adds a finished assistant message; markdown is applied at draw
// time so a window resize reflows it.
func (m *model) appendAnswer(text string) {
	m.appendLine(renderLine{}, "assistant", text)
}

// updateStreamingAnswer writes the live text into the trailing streaming entry.
func (m *model) updateStreamingAnswer() {
	if index := m.trailingStreaming(); index >= 0 {
		m.transcript[index].text = m.streamedText
		return
	}
	m.transcript = append(m.transcript, entry{kind: "streaming", text: m.streamedText})
	m.stick()
}

func (m *model) dropStreamingAnswer() {
	if index := m.trailingStreaming(); index >= 0 {
		m.transcript = append(m.transcript[:index], m.transcript[index+1:]...)
	}
}

func (m *model) trailingStreaming() int {
	if len(m.transcript) == 0 {
		return -1
	}
	last := m.transcript[len(m.transcript)-1]
	if last.kind == "streaming" {
		return len(m.transcript) - 1
	}
	return -1
}

// stick keeps the view pinned to the bottom while it already is there.
func (m *model) stick() {
	if m.scroll == 0 {
		return
	}
	m.scroll++
}

// spinnerFrame is the current quiet-mode spin glyph.
func (m model) spinnerFrame() string {
	if !m.busy || !m.quiet {
		return ""
	}
	frames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	return frames[m.spins%len(frames)]
}

func noticesOf(payload map[string]any) []string {
	items, _ := payload["notices"].([]any)
	out := make([]string, 0, len(items))
	for _, item := range items {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		text, _ := row["text"].(string)
		if text != "" {
			out = append(out, text)
		}
	}
	return out
}

func textOf(record map[string]any) string {
	switch content := record["content"].(type) {
	case string:
		return content
	case []any:
		var parts []string
		for _, item := range content {
			if part, ok := item.(map[string]any); ok {
				if text, ok := part["text"].(string); ok {
					parts = append(parts, text)
				}
			}
		}
		return strings.Join(parts, "")
	default:
		return ""
	}
}

func outstanding(jobs []any) bool {
	for _, item := range jobs {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		state, _ := row["state"].(string)
		if state == "running" || state == "uncollected" {
			return true
		}
	}
	return false
}

func intOf(value any) int {
	number, _ := asInt(value)
	return number
}

func stringOf(payload map[string]any, key string) string {
	text, _ := protocol.String(payload, key)
	return text
}
