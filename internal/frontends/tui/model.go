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

// line is one entry in the transcript.
type line struct {
	kind string // user / assistant / event / notice / error / answer
	text string
}

// state is the panel snapshot, kept exactly as the runtime sent it.
//
// Nothing here is derived: "what does this combination mean" is the runtime's
// judgement, and recomputing it in the interface would be a second definition that
// drifts. It drifts by *missing a warning*, which is the one failure nobody notices.
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
	// It is nil until somebody asks, because the runtime only measures it on
	// request — a status bar that showed zero before the first question would
	// teach the reader that the number is meaningless.
	context map[string]any
}

type model struct {
	client  *protocol.Client
	bridge  *bridge
	options Options

	width  int
	height int

	transcript []line
	input      string
	// scroll is how many lines back from the bottom the transcript is drawn.
	scroll int

	// panel is the latest snapshot the runtime sent. It is stored and rendered as
	// it arrived: "what does this combination mean" is the runtime's judgement, and
	// re-deriving it here would be a second definition that drifts.
	panel panelstate
	// streamedText accumulates the text already on screen for this step, so the
	// complete answer is not drawn a second time on top of it.
	streamedText string
	streamRunID  string
	streamStep   int

	busy bool
	// activity is the runtime's own one-line description of what it is doing. It
	// comes from the state reducer, never from a guess here.
	activity string

	pendingPermission map[string]any
	pendingQuestion   map[string]any
	questionInput     string

	notice       string
	lastRefresh  time.Time
	auditPath    string
	windowTokens any

	// Display preferences. They change what is drawn and nothing else, which is why
	// they are not part of the panel state the runtime owns.
	railHidden       bool
	thinkingExpanded bool
	quiet            bool
}

func newModel(client *protocol.Client, bridge *bridge, options Options) model {
	return model{
		client:  client,
		bridge:  bridge,
		options: options,
		width:   100,
		height:  30,
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(waitForTick(), tea.WindowSize())
}

func waitForTick() tea.Cmd {
	return tea.Tick(2*time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

// Update is the whole interface's state machine.
func (m model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch typed := message.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = typed.Width, typed.Height
		return m, nil

	case tickMsg:
		// The runtime has no timers by design, so a background job that finishes
		// during a quiet moment would leave the panel claiming it is still running.
		// The interface asks — but only while something is actually outstanding,
		// and at a throttle. Turning this into a heartbeat would dilute the one
		// reason it exists.
		if outstanding(m.panel.jobs) && time.Since(m.lastRefresh) > 2*time.Second {
			m.lastRefresh = time.Now()
			m.client.RefreshState()
		}
		return m, waitForTick()

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
		}
		m.panel.window, _ = payload["context_tokens"]
		m.panel.thinking, _ = protocol.Bool(payload, "thinking")
		m.panel.effort, _ = protocol.String(payload, "effort")
		m.auditPath, _ = protocol.String(payload, "audit_path")
		m.panel.autopilot, _ = protocol.Bool(payload, "autopilot")
		if session, ok := protocol.String(payload, "session_id"); ok {
			m.append("notice", i18n.T("init.session_id", "name", session,
				"state", stateSuffix(payload)))
		}
		m.append("notice", i18n.T("init.return_hint"))
		for _, item := range noticesOf(payload) {
			m.append("notice", item)
		}

	case protocol.OutSessionLoad:
		if messages, ok := payload["messages"].([]any); ok && len(messages) > 0 {
			m.append("notice", i18n.Tn("session_load.restored", len(messages), "n", len(messages)))
			for _, item := range messages {
				record, ok := item.(map[string]any)
				if !ok {
					continue
				}
				role, _ := record["role"].(string)
				text := textOf(record)
				switch role {
				case "user":
					if text != "" {
						m.append("user", text)
					}
				case "assistant":
					if text != "" {
						m.append("assistant", text)
					}
				}
			}
		}

	case protocol.OutEvent:
		m.handleEvent(payload)

	case protocol.OutDelta:
		m.handleDelta(payload)

	case protocol.OutDeltaReset:
		runID, _ := protocol.String(payload, "run_id")
		step, _ := protocol.Int(payload, "step")
		if runID == m.streamRunID && step == m.streamStep {
			// The text drawn for this step is thrown away entirely, not greyed out.
			// Half-written text never enters the history, so keeping it would leave
			// something on screen that a restored session cannot account for.
			m.streamedText = ""
			m.dropTrailingAssistant()
		}

	case protocol.OutUI:
		m.handleUI(payload)

	case protocol.OutNotice:
		level, _ := protocol.String(payload, "level")
		text, _ := protocol.String(payload, "text")
		kind := "notice"
		if level == "warn" {
			// A warning has to look different from a remark. They are the boundary
			// between "something went wrong" and "just so you know".
			kind = "error"
		}
		m.append(kind, text)

	case protocol.OutSessions:
		m.append("notice", i18n.T("list.available"))
		if items, ok := payload["items"].([]any); ok {
			for _, item := range items {
				row, ok := item.(map[string]any)
				if !ok {
					continue
				}
				m.append("notice", sessionRow(row))
			}
		}
	}
}

func stateSuffix(payload map[string]any) string {
	if resumed, _ := protocol.Bool(payload, "resumed"); resumed {
		return i18n.T("session.bar.resumed")
	}
	return i18n.T("init.session_new")
}

func (m *model) handleEvent(payload map[string]any) {
	kind, _ := protocol.String(payload, "kind")
	switch kind {
	case "run_started":
		m.busy = true
		m.activity = i18n.T("activity.preparing")

	case "model_call":
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
			m.append("event", i18n.T("event.model_retry", "attempt", attempt, "tail", tail))
			m.activity = i18n.T("activity.retrying")
		}
		// The thinking text arrives whole, after the model finished. The live copy
		// came through delta(reasoning); drawing both is drawing the same thing
		// twice, so this one is summarised.
		if reasoning, ok := protocol.String(payload, "reasoning"); ok && reasoning != "" {
			m.append("event", i18n.T("think.prefix_folded")+
				i18n.Tn("think.folded_tail", 1, "chars", runewidth.StringWidth(reasoning)))
		}

	case "tool_call":
		tool, _ := protocol.String(payload, "tool")
		index, _ := protocol.Int(payload, "tool_index")
		suffix := ""
		if index > 0 {
			suffix = i18n.T("activity.tool_call_index", "n", index+1)
		}
		m.append("event", "  · "+i18n.T("activity.tool_call", "tool", tool, "index", suffix))
		m.activity = i18n.T("activity.tool_call", "tool", tool, "index", suffix)

	case "tool_result":
		tool, _ := protocol.String(payload, "tool")
		status, _ := protocol.String(payload, "status")
		chars, _ := protocol.Int(payload, "chars")
		verb := i18n.T("activity.result." + status)
		if status == "ok" {
			m.append("event", fmt.Sprintf("  · %s %s  %s", tool, verb,
				i18n.Tn("tool.result_chars", chars, "chars", chars)))
		} else {
			m.append("event", fmt.Sprintf("  · %s %s", tool, verb))
		}
		m.activity = i18n.T("activity.tool_result", "tool", tool, "verb", verb)

	case "permission":
		outcome, _ := protocol.String(payload, "outcome")
		tool, _ := protocol.String(payload, "tool")
		m.append("event", i18n.T("permission.line_prefix")+tool+" "+
			i18n.T("activity.permission."+outcome))

	case "run_finished":
		reason, _ := protocol.String(payload, "stop_reason")
		if reason == "max_steps" {
			m.append("error", i18n.T("turn.max_steps_warning"))
		}
		if reason == "cancelled" {
			m.append("error", i18n.T("turn.cancelled_warning"))
		}
		m.activity = ""
	}
}

func (m *model) handleDelta(payload map[string]any) {
	channel, _ := protocol.String(payload, "channel")
	text, _ := protocol.String(payload, "text")
	runID, _ := protocol.String(payload, "run_id")
	step, _ := protocol.Int(payload, "step")

	if runID != m.streamRunID || step != m.streamStep {
		m.streamRunID, m.streamStep = runID, step
		m.streamedText = ""
	}
	if channel != protocol.DeltaText {
		// Reasoning goes through its own channel and is folded; it never mixes
		// into the answer.
		return
	}
	m.streamedText += text
	m.replaceTrailingAssistant(m.streamedText)
}

func (m *model) handleUI(payload map[string]any) {
	kind, _ := protocol.String(payload, "kind")
	switch kind {
	case protocol.UIState:
		m.applyState(payload)

	case protocol.UIRunFinished:
		m.busy = false
		m.activity = ""
		answer, _ := protocol.String(payload, "answer")
		runID, _ := protocol.String(payload, "run_id")
		// The complete answer is always sent, and the interface has to decide
		// whether to draw it. The test is "did text actually reach the screen this
		// turn", not "did I see a delta" — a turn that called tools and produced no
		// text at all sends no delta, and the answer is exactly the thing to draw.
		if runID != m.streamRunID || m.streamedText == "" {
			if answer != "" {
				m.append("assistant", answer)
			}
		}
		m.streamedText = ""
		m.streamRunID = ""

	case protocol.UIStatus:
		m.renderStatus(payload)

	case protocol.UITools:
		m.append("answer", frontends.RenderTools(payload))

	case protocol.UIContext:
		m.append("answer", frontends.RenderContext(payload))

	case protocol.UICompacted:
		// The same sentence the line interface prints, from the same function:
		// every figure in it comes from one compaction, and two renderings would
		// let "how much was saved" drift between the two interfaces.
		compaction, _ := payload["compaction"].(map[string]any)
		m.append("answer", frontends.RenderCompaction(compaction))
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
	m.append("notice", i18n.T("status.title"))
	if session, ok := status["session"].(map[string]any); ok {
		m.append("notice", fmt.Sprintf("  %s: %v · %s: %v",
			i18n.T("status.kv.session"), session["id"], i18n.T("status.kv.size"),
			i18n.T("status.session.span",
				"messages", i18n.Tn("status.session.messages", intOf(session["messages"])),
				"steps", i18n.Tn("status.session.steps", intOf(session["steps"])))))
	}
	if counters, ok := status["counters"].(map[string]any); ok {
		m.append("notice", fmt.Sprintf("  %s: %v runs · %v model calls · %v tool calls",
			i18n.T("status.kv.turns"), counters["runs"], counters["model_calls"], counters["tool_calls"]))
	}
	if usage, ok := status["usage"].(map[string]any); ok {
		m.append("notice", fmt.Sprintf("  %s: %v",
			i18n.T("status.kv.usage_total"), usage["prompt"]))
	}
}

// append adds one transcript entry and keeps the view pinned to the bottom.
func (m *model) append(kind, text string) {
	if strings.TrimSpace(text) == "" {
		return
	}
	m.transcript = append(m.transcript, line{kind: kind, text: text})
	if m.scroll == 0 {
		// Already at the bottom: stay there.
		return
	}
	m.scroll++
}

// replaceTrailingAssistant rewrites the last assistant entry as text streams in.
func (m *model) replaceTrailingAssistant(text string) {
	if len(m.transcript) > 0 && m.transcript[len(m.transcript)-1].kind == "assistant" {
		m.transcript[len(m.transcript)-1].text = text
		return
	}
	m.transcript = append(m.transcript, line{kind: "assistant", text: text})
}

func (m *model) dropTrailingAssistant() {
	if len(m.transcript) > 0 && m.transcript[len(m.transcript)-1].kind == "assistant" {
		m.transcript = m.transcript[:len(m.transcript)-1]
	}
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

func sessionRow(row map[string]any) string {
	return fmt.Sprintf("  %v  %v messages · %v steps   %v",
		row["session_id"], row["messages"], row["steps"], row["preview"])
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
	switch number := value.(type) {
	case int:
		return number
	case float64:
		return int(number)
	case int64:
		return int(number)
	default:
		return 0
	}
}
