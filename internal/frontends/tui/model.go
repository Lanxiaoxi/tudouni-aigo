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
	todos []any
	jobs  []any
	// subagents is the delegations in flight, as the runtime reports them. It is
	// the same shape as `jobs` and for the same reason: the interface draws what
	// it is told rather than counting start and finish events itself, so the badge
	// cannot outlive the thing it describes.
	subagents []any
	mcp       []any
	// riskScope is the runtime's permission judgement, one row per risk level. It
	// is read by the status bar's permission chip and by the folded rail's summary
	// — both of which answer "will the next risky call ask me". There is no longer
	// a Permissions **block** in the rail; the fact itself is still needed by the
	// two places that state it in one line.
	riskScope []any
	messages  int
	steps     int
	model     string
	window    any
	autopilot bool
	thinking  bool
	effort    string
	agentsMD  []any
	skills    []any
	// promptTokens / cachedTokens are the last completed model call's usage. The
	// status bar's cache-hit figure and the rail's context line both read them, and
	// both are "the last request actually sent" — not an estimate, and not the
	// whole session's total (that one is money, and it lives in `/status`).
	promptTokens *int
	cachedTokens *int
	// completionTokens / modelMs are the two halves of that same call's output
	// rate: how much it wrote, and how long the whole call took.
	//
	// They ride with the two above rather than being accumulated across the
	// session because a bar that takes one segment from the last call and another
	// from the whole session is a bar whose neighbours cannot be compared — and
	// the comparison is the only reason any of these four is on screen. The
	// cumulative average is a different figure, it answers a different question,
	// and it lives in `/status` and `--audit` with the other session totals.
	completionTokens *int
	modelMs          *int
	// toolInfo is `init.tools` keyed by name: risk, parallel_safe, interactive.
	// The approval dialog needs the last two to warn that a tool cannot run
	// alongside others or will take over the input.
	toolInfo map[string]map[string]any
	// context is the last ledger payload `/context` (or a compaction) reported.
	// Nil until somebody asks: a status bar that showed zero before the first
	// question would teach the reader the number is meaningless.
	context map[string]any
	// goal is the session's long-running objective, as the runtime reports it.
	// Always present once the first snapshot has arrived: the runtime sends the
	// empty shape rather than omitting the key, so "no goal" and "nothing said
	// yet" are told apart by whether the map is nil, not by its contents.
	goal map[string]any
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
	// inputCursor is the caret's position, as a rune index into input. Without
	// it the box could only append and delete-from-the-end, which makes fixing a
	// typo in the middle of a sentence impossible.
	inputCursor int
	// scroll is how many lines back from the bottom the transcript is drawn.
	scroll int

	panel panelstate

	// Streaming state for the current step.
	streamedText   string
	streamRunID    string
	streamStep     int
	thinkingChars  int
	thinkingText   string
	thinkingLive   bool
	resumed        bool
	recentSessions []map[string]any

	busy bool
	// activity is the runtime's own one-line description. It comes from the
	// state reducer, never from a guess here.
	activity string

	pendingPermission map[string]any
	pendingQuestion   map[string]any
	questionInput     string
	// questionCursor is the highlighted option in the question panel. It exists
	// because Enter takes the highlight: with no highlight, Enter would have to
	// either guess or mean "skip", and "Enter skips" is the one thing the original
	// forbids.
	questionCursor int

	notice      string
	lastRefresh time.Time
	auditPath   string
	sessionID   string
	// maxSteps is the runtime's own limit, taken from `init`. The session bar
	// shows it and the runtime enforces it, so reading it here is what keeps the
	// two from being different numbers.
	maxSteps int

	// booting is true until the first `init` arrives; bootSlow is the same state
	// after the runtime has been silent long enough that "still starting" is no
	// longer a plausible thing to say.
	booting  bool
	bootAt   time.Time
	bootSlow bool

	// Catalogues that arrive with init. The frontend does not hardcode effort
	// levels or model lists: a copy here would drift the moment the runtime
	// learned a new level.
	modelCatalog []any
	// modelAliases are the retired names the catalogue still recognises. They are
	// listed apart from the models because they are not choices: the endpoint
	// retired them and a newer model serves the requests.
	modelAliases  []any
	effortLevels  []string
	selectedModel string
	// skillRows is the catalogue `/skills` reported, which the skills panel reads.
	// It is kept apart from panel.skills: that one is **what this session has
	// loaded**, and "what is available" is a different list.
	skillRows []skillRow

	// Overlay panel state.
	overlay        overlay
	sessionOptions []option
	// pendingUserInput is the text submitted before run_started arrives, so the
	// turn block can open with the line the user actually typed.
	pendingUserInput string

	// Spin frame state for quiet mode. The frame number is read off the clock, so
	// two things drawn at the same moment cannot each spin on their own.
	spinning bool

	// autopilotWanted is the value `/autopilot` asked for, held until the runtime's
	// own snapshot agrees with it. Nil when nothing is pending, which is what keeps
	// the opening snapshot from being echoed back as if the user had asked.
	autopilotWanted *bool

	// Display preferences. They change what is drawn and nothing else, which is
	// why they are not part of the panel state the runtime owns.
	// The rail starts **hidden**: 32 columns is 28% of a 116-column terminal,
	// and the summary line answers the same questions for one row. It opens
	// itself once when a task list first appears — "what it plans to do" is the
	// one place to see whether it understood — and Ctrl+B rules after that.
	railHidden bool
	// railTodosSeen is the edge detector for the auto-open: "the task list went
	// from empty to non-empty". railPinned records that the user has taken the
	// decision into their own hands with Ctrl+B, after which the interface stops
	// opening the rail for them.
	railTodosSeen bool
	railPinned    bool
	quiet         bool
	theme         themeKey
}

func newModel(client *protocol.Client, bridge *bridge, options Options) model {
	theme := defaultTheme
	if options.Theme != "" {
		// An unknown --theme value falls back to the default: a palette nobody
		// recognised must not keep the interface from starting.
		if key, ok := resolveTheme(options.Theme); ok {
			theme = key
		}
	}
	// **Apply it, don't just remember it.** Every renderer reads the package-level
	// `currentTheme`, so resolving the flag into the struct alone left `--theme`
	// inert: the field was written twice in the session and read nowhere.
	setTheme(theme)
	return model{
		client:  client,
		bridge:  bridge,
		options: options,
		width:   100,
		height:  30,
		theme:   theme,
		quiet:   options.Quiet,
		// Nothing has talked back yet. The status bar says so until `init` lands:
		// "the child process started" is not the same fact as "the runtime is
		// ready", and a bar claiming idle over a runtime that never answered is the
		// one lie that line must not tell.
		booting: true,
		bootAt:  time.Now(),
		// The rail starts hidden: 32 columns is 28% of a 116-column terminal,
		// and the summary line answers the same questions for one row. It opens
		// itself once when a task list first appears — "what it plans to do" is
		// the one place to see whether it understood — and Ctrl+B rules after.
		railHidden: true,
	}
}

func (m model) Init() tea.Cmd {
	// The frame chain starts here, not on the first server message: the boot window
	// is exactly the stretch that needs it (nothing has arrived yet), and waiting for
	// a message to begin means the one state that needs motion is the one state
	// without it.
	m.spinning = true
	return tea.Batch(waitForTick(), tea.WindowSize(), waitForSpinner())
}

func waitForTick() tea.Cmd {
	return tea.Tick(2*time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func waitForSpinner() tea.Cmd {
	return tea.Tick(spinnerInterval, func(t time.Time) tea.Msg { return spinnerMsg(t) })
}

// spinnerInterval is how often the quiet-mode frame is redrawn. The frame itself
// comes from the clock (see spinnerFrame), so this only has to be fast enough
// that the next frame is not visibly late.
const spinnerInterval = 120 * time.Millisecond

// bootSlowAfter is when "starting" stops being credible.
const bootSlowAfter = 10 * time.Second

// ensureSpinner starts the frame chain if it is not already running.
//
// Two states need it, for the same reason: something is happening and the screen
// would otherwise look frozen.
//
//   - **quiet mode during a turn.** The chain used to be started from inside its own
//     tick handler, which meant it never started at all: `Init` did not begin it and
//     nothing else did either, so the "one thing moving on screen" was frozen on
//     frame 0.
//   - **the boot window**, before `init` arrives. That is about two seconds with
//     nothing else on screen, and `test_tui_boot.py` says it plainly: a canvas where
//     nothing moves looks like a hang.
func (m *model) ensureSpinner() tea.Cmd {
	if m.spinning || !m.spinnerNeeded() {
		return nil
	}
	m.spinning = true
	return waitForSpinner()
}

// Update is the whole interface's state machine.
func (m model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch typed := message.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = typed.Width, typed.Height
		return m, nil

	case tickMsg:
		// Silence needs a clock: "still starting" is a claim with an expiry, and
		// the screen has to stop making it once the runtime has been quiet long
		// enough that the reader should go look at stderr.
		if m.booting && !m.bootSlow && time.Since(m.bootAt) >= bootSlowAfter {
			m.bootSlow = true
		}
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
		if m.spinnerNeeded() {
			return m, waitForSpinner()
		}
		m.spinning = false
		return m, nil

	case serverMessage:
		m.handleServerMessage(typed.payload)
		return m, m.ensureSpinner()

	case permissionAsked:
		// The log gets the line **before** the modal is drawn: the modal is where
		// the decision happens, and this line is the record that the turn stopped
		// there — which is what someone scrolling back is looking for when they
		// wonder why a turn took four minutes.
		m.currentAppend(waitingLine(typed.request))
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
		// The runtime's own limit, not the flag: they can differ (the child is
		// assembled from its own arguments) and the number on screen has to be the
		// one being enforced.
		if steps, ok := protocol.Int(payload, "max_steps"); ok && steps > 0 {
			m.maxSteps = steps
		}
		if rows, ok := payload["tools"].([]any); ok {
			m.panel.toolInfo = toolInfoOf(rows)
		}
		m.modelCatalog, _ = payload["model_catalog"].([]any)
		// The catalogue arrives as `{models, aliases}` from the state snapshot but as
		// a bare list from init. Both shapes are read, because a front end that only
		// understood one of them would silently lose either the model list or the
		// retired names depending on which message it was looking at.
		if object, ok := payload["model_catalog"].(map[string]any); ok {
			m.modelCatalog, _ = object["models"].([]any)
			m.modelAliases, _ = object["aliases"].([]any)
		}
		if levels, ok := payload["effort_levels"].([]any); ok {
			m.effortLevels = m.effortLevels[:0]
			for _, level := range levels {
				if text, ok := level.(string); ok {
					m.effortLevels = append(m.effortLevels, text)
				}
			}
		}
		if resumed, ok := protocol.Bool(payload, "resumed"); ok {
			m.resumed = resumed
		}
		session, _ := protocol.String(payload, "session_id")
		// **A switch is a new screen.** Deciding it here rather than at the moment
		// the user typed `/new` is deliberate: a switch can fail (a broken
		// permissions file, an MCP server that will not start) and when it fails the
		// runtime keeps the old session. Clearing the screen first would leave the
		// user staring at an empty interface next to a "could not switch" notice,
		// while the conversation they had is still there.
		if m.sessionID != "" && session != "" && session != m.sessionID {
			m.resetForSession()
		}
		m.sessionID = session
		m.booting = false
		m.bootSlow = false
		m.appendLine(renderLine{segments: []seg{
			{text: i18n.T("init.session_id", "name", session, "state", stateSuffix(payload)), role: "rule"},
		}}, "notice", "")
		for _, item := range noticesOf(payload) {
			// The rail already shows permissions / loaded skills / tasks / the model
			// as standing facts. Copying them into the log as well makes the empty
			// state read like a log file — and the model line in particular would
			// scroll away, while the rail's Session block is where "is the model I
			// picked still in effect" is answered at any time.
			if redundantNotice(item.code) {
				continue
			}
			role := "rule"
			if item.level == "warn" {
				role = "warn"
			}
			m.appendLine(renderLine{segments: []seg{{text: item.text, role: role}}}, "notice", "")
		}
		if !m.resumed {
			m.appendLine(renderLine{segments: []seg{
				{text: i18n.T("init.return_hint"), role: "rule"},
			}}, "notice", "")
		}
		// The welcome screen's recent box needs the session list, and that list
		// is async: ask for it **only in the empty state** — a resumed session
		// never draws the welcome screen, so listing hundreds of files is a
		// wasted read.
		if !m.resumed && m.client != nil {
			m.client.ListSessions()
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
			m.dropStepStream()
		}

	case protocol.OutUI:
		m.handleUI(payload)

	case protocol.OutNotice:
		level, _ := protocol.String(payload, "level")
		text, _ := protocol.String(payload, "text")
		code, _ := protocol.String(payload, "code")
		role := "notice"
		if level == "warn" {
			role = "warn"
		}
		// The level prefix is not decoration: `notice` is a channel that carries
		// both "here is a fact" and "something is wrong", and without the word the
		// two read identically on screen.
		m.appendLine(renderLine{segments: []seg{
			{text: "[" + level + "] " + text, role: role},
		}}, "notice", "")
		// A panel that asked the runtime a question has to close the loop: the
		// answer only the runtime knows (whether the server came up, or why it did
		// not) arrives as this notice, and the MCP panel stays up showing
		// "waiting…" until it is written down.
		m.settleOverlay(code)

	case protocol.OutSessions:
		if items, ok := payload["items"].([]any); ok {
			rows := make([]map[string]any, 0, len(items))
			for _, item := range items {
				if row, ok := item.(map[string]any); ok {
					rows = append(rows, row)
				}
			}
			m.recentSessions = rows
		}
		if m.overlay.kind == overlaySessions {
			m.openSessionPicker(payload)
		}
	}
}

func stateSuffix(payload map[string]any) string {
	if resumed, _ := protocol.Bool(payload, "resumed"); resumed {
		return i18n.T("session.bar.resumed")
	}
	return i18n.T("init.session_new")
}

// noticeRecord is one line of `init.notices`.
type noticeRecord struct {
	code  string
	level string
	text  string
}

// redundantNotice reports whether a notice says something the context rail
// already shows as a standing fact.
//
// The code is the machine-readable category the protocol carries for exactly this
// question; guessing from the text would break the moment the wording changed.
// Everything else still prints: the `mcp` "workspace mcp.json ignored" line, the
// `web` missing-key line and the `autopilot` warning have no other outlet, and
// dropping them would turn "says it loudly" into "nobody hears it".
func redundantNotice(code string) bool {
	switch code {
	case "permissions", "skills", "todos", "model":
		return true
	}
	return false
}

// toolInfoOf indexes `init.tools` by name. The approval dialog reads
// parallel_safe / interactive off this, and this is the only place they arrive.
func toolInfoOf(rows []any) map[string]map[string]any {
	out := make(map[string]map[string]any, len(rows))
	for _, item := range rows {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _ := row["name"].(string)
		if name != "" {
			out[name] = row
		}
	}
	return out
}

// resetForSession empties the screen for a session switch: the log, the turn
// counter, the scroll position and every piece of live streaming state belong to
// the conversation that is going away.
func (m *model) resetForSession() {
	m.transcript = nil
	m.current = nil
	m.turnSeq = 0
	m.scroll = 0
	m.streamedText = ""
	m.streamRunID = ""
	m.streamStep = 0
	m.thinkingText = ""
	m.thinkingChars = 0
	m.thinkingLive = false
	m.busy = false
	m.activity = ""
	m.pendingUserInput = ""
	m.pendingPermission = nil
	m.pendingQuestion = nil
	m.questionInput = ""
	m.overlay = overlay{}
	m.recentSessions = nil
	m.railTodosSeen = false
	m.railPinned = false
	// A new session starts on the empty state, so the rail goes back to its
	// default instead of staying however the previous session left it.
	m.railHidden = true
	// Panel facts are per-session. Leaving them up would attribute the previous
	// session's task list and risk scope to the new one until its first snapshot.
	m.panel = panelstate{toolInfo: m.panel.toolInfo}
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

	// A delegated agent's record never reaches the cases below. It carries its own
	// step numbers and its own tool calls, and drawing them into the parent's
	// transcript would interleave two conversations: the parent's turn would appear
	// to have made steps it never made, and a child's `read_file` would show up in
	// the parent's turn as though the parent had asked for it. The `child` marker
	// is set by the runtime, which is the only end that can tell the two apart.
	//
	// The one thing it *is* used for is keeping the running tally current between
	// the runtime's snapshots. The snapshot is what the badge is drawn from, so
	// this is an optimisation of the display's freshness, never its source of
	// truth — if it were dropped entirely the badge would still be correct, just
	// coarser.
	if child, _ := payload["child"].(bool); child {
		m.observeChild(payload, kind)
		return
	}

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
			// The one line that answers "what did that step cost": how long it
			// took, how much context went out, and how much of it was served from
			// the cache. It is drawn only for a successful call — a failed one
			// already has its own line below.
			m.currentAppend(modelLine(payload))
			if prompt, ok := protocol.Int(payload, "prompt_tokens"); ok {
				m.panel.promptTokens = &prompt
			} else {
				m.panel.promptTokens = nil
			}
			if cached, ok := protocol.Int(payload, "cached_tokens"); ok {
				m.panel.cachedTokens = &cached
			} else {
				m.panel.cachedTokens = nil
			}
			// The output rate's two halves, read off the same event as the other
			// four figures so the bar cannot mix calls. Both are cleared when
			// absent rather than left standing: a duration from the previous step
			// beside this step's token count would be a rate nothing measured.
			if completion, ok := protocol.Int(payload, "completion_tokens"); ok {
				m.panel.completionTokens = &completion
			} else {
				m.panel.completionTokens = nil
			}
			if span, ok := protocol.Int(payload, "duration_ms"); ok {
				m.panel.modelMs = &span
			} else {
				m.panel.modelMs = nil
			}
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
		//
		// The live copy is dropped **only when the whole one replaces it**. The
		// comment above used to state the rule and the code did not follow it: the
		// live block was left standing, so `view.go` drew the finalized text (it
		// wins the branch) while `thinkingChars` went on counting a block nobody
		// could see. A turn whose gateway reports no `reasoning` on some steps has
		// the opposite need — there is nothing to replace the live text with, and
		// dropping it would blank the only copy of what the model thought.
		if reasoning, ok := protocol.String(payload, "reasoning"); ok && reasoning != "" {
			m.current.thinking = reasoning
			m.current.thinkingRun, _ = protocol.String(payload, "run_id")
			m.thinkingText = ""
			m.thinkingChars = 0
			m.thinkingLive = false
		}

	case "tool_call":
		tool, _ := protocol.String(payload, "tool")
		arguments, _ := protocol.String(payload, "arguments")
		callID, _ := protocol.String(payload, "call_id")
		if m.current == nil {
			break
		}
		// The risk is looked up per tool rather than read off the event: the audit
		// record for a call does not carry it (only the permission record does),
		// and the risk suffix is the whole reason a MEDIUM or HIGH call is allowed
		// to look different from the other twenty on screen.
		risk := m.toolRisk(tool)
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
		// A refusal needs its own row: "✗" says the call produced no output, but
		// not whether the tool ran and failed or never ran at all — which is the
		// difference between "fix the tool" and "change the policy".
		if status, _ := protocol.String(payload, "status"); status == "denied" {
			m.currentAppend(deniedLine())
		}

	case "permission":
		if m.current == nil {
			break
		}
		// Quiet mode drops the four outcomes that mean "it ran without asking".
		// The judgement reads `outcome` only — never the presence of `rule`, which
		// exists for one of the four and would let the other three through.
		if m.quiet && silentOutcome(payload) {
			break
		}
		m.currentAppend(permissionLine(payload))

	case "tool_batch":
		if m.current != nil {
			m.currentAppend(batchLine(payload))
		}
	case "run_finished":
		reason, _ := protocol.String(payload, "stop_reason")
		duration, _ := protocol.Int(payload, "duration_ms")
		m.finishTurn(reason, duration)
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

	// The rail auto-opens when a task list first appears: "what it plans to do" is
	// the one place a person can see whether it understood, and that is worth more
	// than the 32 columns.
	//
	// It is an **edge, not a level**, and that distinction is load-bearing: keyed on
	// "there are todos" the answer would still be yes on the next snapshot 50ms
	// later, so a user who had just pressed Ctrl+B to fold the rail would have it
	// shoved back — making that key look broken. Seeing the list once per
	// appearance, then listening to the user; going back to empty re-arms it. A
	// **content** update (one task turning completed) does not re-open it either:
	// `todo_write` is called many times in a long task, and re-opening every time
	// would be a panel that keeps popping itself open.
	//
	// A manual collapse is respected for everything **except** this one event.
	// Deliberate: when the user folded the rail there was no task list, so "the
	// model just wrote one down" is new information they have not seen. That is why
	// there is no `railPinned` test here — adding one silently removes the feature
	// for anybody who has ever pressed Ctrl+B.
	m.noteTaskList()
}

// noteTaskList updates the "a task list just appeared" edge and opens the rail on
// it.
//
// It is called from **two** places, and that is the whole point. A turn's task
// list is not there when the turn starts: `run_started` arrives first, and the
// list only reaches the panel when the state snapshot that follows `todo_write`
// comes back — which is one or more steps later, mid-turn. Checking this only in
// `beginTurn` meant the check always ran against an empty list, so the rail never
// opened itself for the one thing it opens itself for.
//
// The edge, not the level: `todo_write` is called many times in a long task, and
// re-opening on every call would be a panel that keeps popping itself open. An
// **empty** list re-arms it, so a later appearance counts as new.
func (m *model) noteTaskList() {
	if len(m.panel.todos) > 0 {
		if !m.railTodosSeen {
			m.railTodosSeen = true
			m.railHidden = false
		}
		return
	}
	m.railTodosSeen = false
}

// finishTurn closes the current turn and rewrites its header in place.
//
// The `stop_reason` is mapped through the same table the original used, and the
// mapping is the whole point of the field: "answered", "hit the step limit",
// "you stopped it" and "the model failed" are four different things to do next,
// and the one that must never be confused with the first is the last — a turn
// that died on a model error and reads "Answered" is the failure the separate
// StepLimitExceeded type existed to prevent.
func (m *model) finishTurn(reason string, durationMS int) {
	turn := m.current
	m.current = nil
	if turn == nil {
		return
	}
	turn.finished = true
	turn.outcome = reason
	if turn.outcome == "" {
		turn.outcome = "answered"
	}
	// Frozen here, from the runtime's own number: reading the clock at draw time
	// would keep a finished turn's duration climbing for as long as the screen is
	// left open.
	turn.duration = time.Duration(durationMS) * time.Millisecond
	switch reason {
	case "max_steps":
		m.appendLine(renderLine{segments: []seg{
			{text: i18n.T("turn.max_steps_warning"), role: "warn"},
		}}, "notice", "")
	case "cancelled":
		m.appendLine(renderLine{segments: []seg{
			{text: i18n.T("turn.cancelled_warning"), role: "warn"},
		}}, "notice", "")
	}
}

// toolRisk is what the approval policy thinks of this tool, from `init.tools`.
//
// The registry is the only thing that knows, and it sends the answer once at
// startup; a call event does not repeat it. Preferring the event when present
// keeps this working if the runtime ever starts sending it.
func (m model) toolRisk(tool string) string {
	if row, ok := m.panel.toolInfo[tool]; ok {
		if risk, ok := row["risk"].(string); ok {
			return risk
		}
	}
	return ""
}

func (m *model) currentAppend(line renderLine) {
	if m.current == nil {
		m.appendLine(line, "notice", "")
		return
	}
	m.current.lines = append(m.current.lines, line)
}

// appendLines adds a block of pre-rendered rows as one entry.
func (m *model) appendLines(lines []renderLine) {
	if len(lines) == 0 {
		return
	}
	m.transcript = append(m.transcript, entry{lines: lines, kind: "answer"})
	m.stick()
}

// backfill finds the line with the same anchor and appends the tail. When the
// anchor cannot be found the tail is drawn as its own line — worse than
// attaching is an answer that never shows.
//
// The **direction of the roles** is part of the contract: a result tail may only
// rewrite a call line that is still waiting for one. Without that guard a
// replayed `tool_result` (a resumed session, a retried step) appends a second
// "✓ 8 chars" to a line that already has one, and two identical tails read as
// "the tool ran twice".
func (m *model) backfill(turn *turnData, tail renderLine) {
	if tail.anchor != "" {
		for index := len(turn.lines) - 1; index >= 0; index-- {
			if turn.lines[index].anchor != tail.anchor {
				continue
			}
			if turn.lines[index].role != anchoredTarget(tail.role) {
				// Already carries its tail: draw nothing rather than a duplicate.
				return
			}
			head := turn.lines[index]
			head.segments = append(head.segments, seg{text: "   ", role: "rule"})
			head.segments = append(head.segments, tail.segments...)
			head.role = tail.role
			turn.lines[index] = head
			return
		}
	}
	turn.lines = append(turn.lines, tail)
}

// anchoredTarget is the line role a tail is allowed to rewrite.
func anchoredTarget(tailRole string) string {
	switch tailRole {
	case "tool_brief_done":
		return "tool_brief"
	}
	return tailRole
}

func (m *model) handleDelta(payload map[string]any) {
	channel, _ := protocol.String(payload, "channel")
	text, _ := protocol.String(payload, "text")
	runID, _ := protocol.String(payload, "run_id")
	step, _ := protocol.Int(payload, "step")

	// The step is the streaming block's identity, so either half changing means
	// these chunks belong somewhere else. The runtime supplies the step itself and
	// it advances once per model call: a derived number used to repeat for a turn's
	// first two steps, which is why this branch never fired there.
	if runID != m.streamRunID || step != m.streamStep {
		m.streamRunID, m.streamStep = runID, step
		m.dropStepStream()
	}
	switch channel {
	case protocol.DeltaText:
		m.streamedText += text
		m.updateStreamingAnswer()

	case protocol.DeltaReasoning:
		m.thinkingChars += runewidth.StringWidth(text)
		m.thinkingText += text
		m.thinkingLive = true
	}
}

// dropStepStream throws away the half-written text of one step.
//
// All four fields go together, and that is the whole point: they are one fact —
// "what this step has streamed so far" — and clearing a subset leaves the screen
// describing a step that has already been replaced. Clearing only the counter
// (which is what this did) left `thinkingText` holding the previous step's
// reasoning, so the next step's chunks were appended to it and the live block
// showed two steps concatenated.
//
// The step number a delta carries is the identity of the block, so "the step
// changed" and "a retry restated this step" both land here.
func (m *model) dropStepStream() {
	m.streamedText = ""
	m.thinkingText = ""
	m.thinkingChars = 0
	m.thinkingLive = false
	m.dropStreamingAnswer()
}

func (m *model) handleUI(payload map[string]any) {
	kind, _ := protocol.String(payload, "kind")
	switch kind {
	case protocol.UIState:
		m.applyState(payload)
		m.reportAutopilot()

	case protocol.UIRunFinished:
		m.busy = false
		m.activity = ""
		answer, _ := protocol.String(payload, "answer")
		// **First take the live copy down, then draw the answer.** The two are the
		// same text: leaving the streaming block up and appending the finished
		// answer after it draws the same paragraph twice, once as raw text and once
		// as markdown.
		m.dropStreamingAnswer()
		// The test is "did text reach the screen this turn", not "did I see a
		// delta": a turn that called tools and produced no text sends no delta,
		// and the answer is exactly the thing to draw.
		if answer != "" {
			m.attachAnswer(m.runIDOf(payload), answer)
		}
		m.streamedText = ""
		m.streamRunID = ""
		m.streamStep = 0
		m.thinkingChars = 0
		m.thinkingText = ""
		m.thinkingLive = false

	case protocol.UIMCP:
		// `/mcp`'s reply. Two things at once, deliberately:
		//   1. leave a trace in the log — the summary plus the runtime's own
		//      sentences, because "what did I just press and what happened" is what
		//      the log is for, and the panel is gone once Esc is pressed;
		//   2. settle the panel — any snapshot coming back means "the thing you
		//      were waiting for is over", without guessing which snapshot it was.
		for _, line := range mcpTraceLines(payload) {
			m.appendLine(line, "notice", "")
		}
		if servers, ok := payload["mcp_servers"].([]any); ok {
			m.panel.mcp = servers
		}
		m.settleOverlay("mcp")

	case protocol.UIStatus:
		m.appendLines(m.statusScreen(payload))

	case protocol.UITools:
		m.appendLines(m.toolsScreen(payload))

	case protocol.UIContext:
		m.appendLine(renderLine{segments: []seg{
			{text: frontends.RenderContext(payload), role: "rule"},
		}}, "answer", "")

	case protocol.UISkills:
		m.appendSkills(payload)

	case protocol.UICompacted:
		compaction, _ := payload["compaction"].(map[string]any)
		m.appendLine(renderLine{segments: []seg{
			{text: frontends.RenderCompaction(compaction), role: "rule"},
		}}, "answer", "")
		// The ledger follows the sentence: after a compaction the first question
		// is "how much is left now", and making the user ask again with /context
		// is handing back something the screen already knows.
		m.appendLine(renderLine{segments: []seg{
			{text: frontends.RenderContext(payload), role: "rule"},
		}}, "answer", "")
	}
}

// reportAutopilot echoes `/autopilot` once the runtime has confirmed the value.
//
// Two rules, both consequences of "never update optimistically":
//
//   - it speaks only while this interface is waiting for the value. The opening
//     snapshot carries `autopilot` too (true when started with `--autopilot`), and
//     repeating that is noise — the runtime already said it in a notice;
//   - it reports what the runtime says, not what was asked for. A request an older
//     runtime ignored must not produce "switched on", because this is the cell
//     that answers "will it ask me next".
func (m *model) reportAutopilot() {
	if m.autopilotWanted == nil || m.panel.autopilot != *m.autopilotWanted {
		return
	}
	m.autopilotWanted = nil
	key, role := "autopilot.report_off", "rule"
	if m.panel.autopilot {
		key, role = "autopilot.report_on", "warn"
	}
	m.appendLine(renderLine{segments: []seg{{text: i18n.T(key), role: role}}}, "notice", "")
}

// observeChild updates the running-delegation row from a child's own record.
//
// Only the `activity` field is touched, and only for the row already in the list:
// the runtime's snapshot owns everything else on it (label, model, depth, start
// time, the counts). Updating the counters here as well would be a second
// implementation of arithmetic the runtime already does, and the two would drift
// by exactly the events that arrive out of order.
func (m *model) observeChild(payload map[string]any, kind string) {
	id, _ := protocol.String(payload, "subagent_id")
	if id == "" {
		return
	}
	activity := ""
	switch kind {
	case "tool_call":
		// The tool's name is what makes the row worth reading: "subagent" alone
		// does not say whether it is searching, reading or writing.
		activity, _ = protocol.String(payload, "tool")
	case "tool_result":
		// Cleared, not left standing. A tool name that stays after the call
		// returned reads as "still doing that", which is the wrong answer while
		// the child is deciding what to do next.
		activity = ""
	default:
		return
	}

	for _, item := range m.panel.subagents {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if rowID, _ := row["id"].(string); rowID == id {
			row["activity"] = activity
			return
		}
	}
}

func (m *model) applyState(payload map[string]any) {
	if value, ok := payload["todos"].([]any); ok {
		m.panel.todos = value
		// This is where a task list actually appears: the snapshot follows the
		// `todo_write` result, so it is the first moment the panel can know. The
		// call in `beginTurn` only ever sees an empty list — see noteTaskList.
		m.noteTaskList()
	}
	if value, ok := payload["jobs"].([]any); ok {
		m.panel.jobs = value
	}
	if value, ok := payload["subagents"].([]any); ok {
		m.panel.subagents = value
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
	if value, ok := payload["agents_md"].([]any); ok {
		m.panel.agentsMD = value
	}
	if value, ok := payload["skills"].([]any); ok {
		m.panel.skills = value
	}
	if value, ok := payload["goal"].(map[string]any); ok {
		m.panel.goal = value
	}
}

// ── transcript helpers ────────────────────────────────────────────────────────

// appendLine adds a standalone entry.
func (m *model) appendLine(line renderLine, kind, text string) {
	m.transcript = append(m.transcript, entry{line: line, kind: kind, text: text})
	m.stick()
}

// appendUser adds one **restored** user message. Replay only: a live turn draws
// the line the user typed inside its own block (`view.go:418`), so echoing it here
// as well is that sentence twice on screen.
//
// It carries no `> ` marker either, because the original's replay draws the
// content alone (`app.py:1195-1198`). A marker that appears in restored history
// and nowhere else reads as a turn that never closed.
func (m *model) appendUser(text string) {
	m.appendLine(renderLine{segments: []seg{{text: text, role: "user"}}}, "user", text)
}

// runIDOf reads the run a `ui` message refers to.
func (m *model) runIDOf(payload map[string]any) string {
	runID, _ := protocol.String(payload, "run_id")
	return runID
}

// attachAnswer hangs the finished answer on the turn it belongs to.
// **By run_id, never by arrival order.** The protocol is explicit that
// `ui(run_finished)` and the turn's events are separate messages that may arrive in
// either order; an answer appended where it lands is drawn after a turn that started
// later, and the header that says "Answered" no longer owns the text it summarises.
//
// A run id nobody knows about (a message for a turn this front end never saw start)
// falls back to the open turn, and then to a standalone entry — losing the answer
// altogether would be worse than losing its position.
func (m *model) attachAnswer(runID, answer string) {
	if turn := m.turnFor(runID); turn != nil {
		turn.answer = answer
		return
	}
	if m.current != nil {
		m.current.answer = answer
		return
	}
	m.appendAnswer(answer)
}

// turnFor finds the turn with this run id, newest first.
func (m *model) turnFor(runID string) *turnData {
	if runID == "" {
		return nil
	}
	for index := len(m.transcript) - 1; index >= 0; index-- {
		turn := m.transcript[index].turn
		if turn != nil && turn.runID == runID {
			return turn
		}
	}
	return nil
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

// welcomeVisible reports whether the empty state's screen is still up.
//
// It is **not** "the transcript is empty": the init notices are conversation
// content and arrive seconds after start, and keying the screen off emptiness
// would make it flash away before anyone reads it. The screen answers one
// question — "has the conversation started" — and it comes down when the first
// turn does, exactly like the original. A resumed session never shows it at
// all: there is a conversation already.
func (m model) welcomeVisible() bool {
	if m.resumed || m.turnSeq > 0 {
		return false
	}
	for index := range m.transcript {
		item := m.transcript[index]
		if item.turn != nil {
			return false
		}
		switch item.kind {
		case "user", "assistant", "streaming":
			return false
		}
	}
	return true
}

// spinnerNeeded is whether a frame chain should be running at all.
//
// **Not while a person is being asked something.** An approval or a question stops
// the agent dead: the only thing that moves is the modal, and a spinner next to it
// says "still working" about a turn that is waiting for *you*. That is the one
// moment where an animated mark is actively misleading, and the original turned it
// off for exactly that reason.
func (m model) spinnerNeeded() bool {
	if m.pendingPermission != nil || m.pendingQuestion != nil {
		return false
	}
	if m.booting {
		return true
	}
	return m.busy && m.quiet
}

// spinnerFrame is the current spin glyph.
//
// The frame is read off the clock rather than counted per repaint: two things
// drawn at the same instant (the status mark and a folded thinking line) must
// show the same frame, and a counter that advances per message would drift with
// however many messages happened to arrive. The original derived it the same way.
func (m model) spinnerFrame() string {
	if !m.spinnerNeeded() {
		return ""
	}
	frames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	step := time.Now().UnixNano() / int64(spinnerSeconds*float64(time.Second))
	return frames[int(step%int64(len(frames)))]
}

// spinnerSeconds is one frame's dwell time. Fast enough to read as motion, slow
// enough not to flicker.
const spinnerSeconds = 0.09

// mcpTraceLines is what `/mcp` leaves in the conversation log.
//
// The full list is deliberately **not** repeated here: it is already on the panel
// and as a standing block in the rail, and a third copy would scroll away — which
// is exactly the thing "which servers do I have mounted" should never do. What
// the log keeps is the one-line tally plus the runtime's own sentences, because
// those carry the reason a server did not come up and only the runtime knows it.
func mcpTraceLines(payload map[string]any) []renderLine {
	rows, _ := payload["mcp_servers"].([]any)
	notes := stringList(payload["mcp_notes"])
	if len(rows) == 0 && len(notes) == 0 {
		return nil
	}
	loaded := 0
	for _, item := range rows {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if state, _ := row["state"].(string); state == "loaded" {
			loaded++
		}
	}
	out := []renderLine{{segments: []seg{
		{text: i18n.T("mcp.summary", "running", loaded, "total", len(rows)), role: "rule"},
	}}}
	for _, note := range notes {
		// The runtime writes the sentence; it also decides whether it is bad news.
		// It sends no flag for that, so this is the one place that reads the text.
		role := "process"
		if strings.Contains(note, "not connected") || strings.Contains(note, "did not connect") {
			role = "warn"
		}
		out = append(out, renderLine{segments: []seg{{text: note, role: role}}})
	}
	return out
}

func stringList(value any) []string {
	items, ok := value.([]any)
	if !ok {
		if direct, ok := value.([]string); ok {
			return direct
		}
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, fmt.Sprint(item))
	}
	return out
}

func noticesOf(payload map[string]any) []noticeRecord {
	items, _ := payload["notices"].([]any)
	out := make([]noticeRecord, 0, len(items))
	for _, item := range items {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		text, _ := row["text"].(string)
		if text == "" {
			continue
		}
		record := noticeRecord{text: text}
		record.code, _ = row["code"].(string)
		record.level, _ = row["level"].(string)
		out = append(out, record)
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

// outstandingJobs counts the jobs that still need attention: running, or
// finished with their result uncollected.
func outstandingJobs(jobs []any) int {
	n := 0
	for _, item := range jobs {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		switch state, _ := row["state"].(string); state {
		case "running", "uncollected":
			n++
		}
	}
	return n
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

// uncollectedJobs counts the jobs that finished without their result being read.
// It is the one background state that needs a person to do something.
func uncollectedJobs(jobs []any) int {
	n := 0
	for _, item := range jobs {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if state, _ := row["state"].(string); state == "uncollected" {
			n++
		}
	}
	return n
}

func intOf(value any) int {
	number, _ := asInt(value)
	return number
}

func stringOf(payload map[string]any, key string) string {
	text, _ := protocol.String(payload, key)
	return text
}
