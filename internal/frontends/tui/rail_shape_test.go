package tui

import (
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
)

// The rail's shape after the 2026-09 reshape: five blocks (the Session block and
// the AGENT.md rows are gone), a capped goal objective, a width that scales with
// the terminal, and a block that was cut saying so.

// sessionObjective is the real objective from this repository's own goal session —
// one long Chinese sentence with English identifiers in it. It is the text that
// made the case for a cap: at 30 cells of content it wanted nine rows of a
// twenty-three-row column.
const sessionObjective = "在 tudouni 中实现 DSH 式的分相计时（wait/think/write）与配对的 decode tok/s，" +
	"接入 model_call 事件与 /status、--audit、transcript 显示，跑通全量测试与真实二进制校验，" +
	"并按仓库约定更新 VERSION 与文档后提交（git commit）"

// TestTheGoalObjectiveIsCapped: the objective is the one unbounded string in the
// rail, and an uncapped one pushed every block below it off the screen.
//
// The cap is a **row** cap rather than a character cap, because rows are what the
// column actually spends, and the row that was cut has to say the rest is one
// `/goal` away — a silently truncated objective reads as the whole objective.
func TestTheGoalObjectiveIsCapped(t *testing.T) {
	withColour(t)

	m := testModel()
	m.panel.goal = map[string]any{
		"objective": sessionObjective, "phase": "active", "rounds_text": "0/60", "armed": false,
	}
	rows := goalRows(m.panel.goal, m.railWidthFor()-2)

	// The block is capped at goalMaxRows: six rows of objective text, with the last
	// one replaced by the row that says the rest is one `/goal` away — plus the
	// phase row and the continuing/paused row underneath.
	if len(rows) != goalMaxRows+2 {
		t.Fatalf("the goal block drew %d rows, want %d (the cap plus the phase and state rows)",
			len(rows), goalMaxRows+2)
	}
	if !strings.Contains(stripANSI(rows[railMaxRows]), "/goal") {
		t.Errorf("the row that was cut does not say where the rest is: %q",
			stripANSI(rows[railMaxRows]))
	}
	if !strings.Contains(stripANSI(rows[railMaxRows]), "more line") {
		t.Errorf("the cut row does not say how much is missing: %q",
			stripANSI(rows[railMaxRows]))
	}
	// Exactly one row says something was left out, and it is the cap row: a block
	// that carried two markers would read as two separate omissions.
	marked := 0
	for index, row := range rows {
		if strings.Contains(stripANSI(row), "more line") {
			marked++
			if index != railMaxRows {
				t.Errorf("the omission row is at %d, not at the cap: %q", index, stripANSI(row))
			}
		}
	}
	if marked != 1 {
		t.Errorf("%d rows report an omission, want exactly 1", marked)
	}
	// And a short objective is not touched at all.
	short := goalRows(map[string]any{"objective": "修好重连", "phase": "active",
		"rounds_text": "0/5", "armed": true}, m.railWidthFor()-2)
	for _, row := range short {
		if strings.Contains(stripANSI(row), "/goal`") {
			t.Errorf("a one-line objective was capped anyway: %q", stripANSI(row))
		}
	}
}

// TestALongListSaysHowManyRowsItLost: Tasks and Background jobs have no content
// cap — the person asked for every one of them — so the only thing that trims them
// is the block cap, and a truncated block has to say how much is missing. Drawing
// it as though it were complete is the one outcome that is not allowed.
func TestALongListSaysHowManyRowsItLost(t *testing.T) {
	withColour(t)

	long := make([]any, 0, 12)
	for index := 0; index < 12; index++ {
		long = append(long, map[string]any{"status": "pending", "content": "task"})
	}
	m := testModel()
	m.panel.todos = long

	rows := clipBlock(todoRows(long), m.railWidthFor()-2)
	if len(rows) != railMaxRows {
		t.Fatalf("the clipped task block drew %d rows, want %d", len(rows), railMaxRows)
	}
	if !strings.Contains(stripANSI(rows[len(rows)-1]), "more)") {
		t.Errorf("the clipped block does not say how many rows it lost: %q",
			stripANSI(rows[len(rows)-1]))
	}

	// And the goal block, whose own cap already says its number, does not get a
	// second marker stacked onto it: two markers read as two separate omissions.
	goal := goalRows(map[string]any{
		"objective": sessionObjective, "phase": "active", "rounds_text": "0/60", "armed": true,
	}, m.railWidthFor()-2)
	clipped := clipBlock(goal, m.railWidthFor()-2)
	markers := 0
	for _, row := range clipped {
		if strings.Contains(stripANSI(row), "more") {
			markers++
		}
	}
	if markers != 1 {
		t.Errorf("the capped goal carries %d omission markers, want exactly 1:\n%s",
			markers, stripANSI(strings.Join(clipped, "\n")))
	}
}

// TestTheRailNoLongerDrawsTheSessionBlock: every fact that block carried has a
// better home, and it cost more rows than the rest of the rail together.
func TestTheRailNoLongerDrawsTheSessionBlock(t *testing.T) {
	withColour(t)

	m := filledModel(120, 40)
	rendered := stripANSI(m.renderRail(m.railWidthFor(), 40))

	for _, gone := range []string{"Session", "AGENT.md", m.sessionID, "messages ·"} {
		if strings.Contains(rendered, gone) {
			t.Errorf("the rail still draws the removed Session block: %q found in\n%s", gone, rendered)
		}
	}
	for _, kept := range []string{"Goal", "Tasks", "Loaded skills", "Background jobs", "Background MCP"} {
		if !strings.Contains(rendered, kept) {
			t.Errorf("the %s block is missing:\n%s", kept, rendered)
		}
	}
}

// TestTheRailDrawsJobsAboveMCP: the two "alive on this machine" blocks keep a fixed
// order between themselves, and jobs — a command the person started and is
// watching — comes first.
func TestTheRailDrawsJobsAboveMCP(t *testing.T) {
	withColour(t)

	rendered := stripANSI(filledModel(120, 40).renderRail(120/3-4, 40))
	jobs := strings.Index(rendered, "Background jobs")
	mcp := strings.Index(rendered, "Background MCP")
	if jobs < 0 || mcp < 0 {
		t.Fatalf("both blocks must be drawn:\n%s", rendered)
	}
	if jobs > mcp {
		t.Error("Background jobs is drawn below Background MCP")
	}
}

// TestEffortRidesWithTheModel: the effort level used to live in the rail's Session
// block and only while thinking was off. It is a qualifier on the model — "which
// model, thinking how hard" is one answer — so it belongs on the session bar in
// parentheses, and it belongs there whether or not thinking is on.
func TestEffortRidesWithTheModel(t *testing.T) {
	withColour(t)

	for _, thinking := range []bool{true, false} {
		m := testModel()
		m.width = 120
		m.sessionID = "20260920-115700"
		m.panel.model = "glm-5.3"
		m.panel.effort = "high"
		m.panel.thinking = thinking
		m.maxSteps = 120

		bar := stripANSI(m.renderSessionBar())
		if !strings.Contains(bar, "glm-5.3 (high)") {
			t.Errorf("thinking=%v: the effort is not beside the model: %q", thinking, bar)
		}
		if !strings.Contains(bar, "up to 120 steps") {
			t.Errorf("thinking=%v: the step limit is missing: %q", thinking, bar)
		}
	}

	// Nothing to say, nothing drawn: a runtime that reported no effort must not
	// produce a pair of empty brackets.
	m := testModel()
	m.width = 120
	m.panel.model = "glm-5.3"
	bar := stripANSI(m.renderSessionBar())
	if strings.Contains(bar, "()") {
		t.Errorf("an absent effort drew empty brackets: %q", bar)
	}
}

// TestAResumedSessionOpensTheRailForItsGoal: `resetForSession` clears the edges, so
// the first snapshot of a resumed session — which already carries the goal and the
// task list — opens the rail once. "This session is for something, and here is what"
// is exactly the fact the auto-open exists to deliver, and it is the moment a person
// most needs it: they have just come back to a session they cannot remember.
func TestAResumedSessionOpensTheRailForItsGoal(t *testing.T) {
	m := testModel()
	m.sessionID = "20260920-110341"
	m.resetForSession()
	if !m.railHidden {
		t.Fatal("a fresh session must start with the rail folded")
	}

	m.handleUI(map[string]any{
		"kind": protocol.UIState,
		"goal": map[string]any{"objective": "把重连修好", "phase": "active", "rounds_text": "3/60",
			"armed": false},
		"todos": []any{map[string]any{"status": "in_progress", "content": "读代码"}},
	})
	if m.railHidden {
		t.Error("the rail stayed folded on the snapshot that carried a restored goal")
	}
}
