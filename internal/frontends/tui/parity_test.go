package tui

import (
	"strings"
	"testing"
	"time"
)

func testModel() model {
	m := model{width: 120, height: 40, theme: defaultTheme}
	m.panel.model = "deepseek-chat"
	return m
}

func turnWithRun(runID string) *turnData {
	return &turnData{index: 1, runID: runID, startedAt: time.Now()}
}

// TestTheAnswerIsAttachedByRunID is the protocol's own warning, made into a test.
//
// `ui(run_finished)` and the turn's events are separate messages and their **order
// is not guaranteed**. Appending the answer where it arrives draws it after a turn
// that started later — and even in the normal order it becomes a sibling of the
// block, so the header saying "Answered" no longer owns the text it summarises.
func TestTheAnswerIsAttachedByRunID(t *testing.T) {
	m := testModel()
	first := turnWithRun("run-1")
	second := turnWithRun("run-2")
	m.transcript = []entry{{turn: first}, {turn: second}}
	m.current = second

	// The first turn's answer arrives **after** the second turn has opened.
	m.attachAnswer("run-1", "the first answer")

	if first.answer != "the first answer" {
		t.Errorf("the first turn's answer is %q, want it attached by run_id", first.answer)
	}
	if second.answer != "" {
		t.Errorf("the answer landed on the second turn: %q", second.answer)
	}
	// Nothing extra was appended to the transcript: the answer belongs to a turn.
	if len(m.transcript) != 2 {
		t.Errorf("the transcript grew to %d entries, want 2", len(m.transcript))
	}
}

// TestAnAnswerWithNoKnownRunFallsBackToTheOpenTurn: a message for a turn this front
// end never saw start still has to land somewhere. Losing the text would be worse
// than losing its position.
func TestAnAnswerWithNoKnownRunFallsBackToTheOpenTurn(t *testing.T) {
	m := testModel()
	open := turnWithRun("run-open")
	m.transcript = []entry{{turn: open}}
	m.current = open

	m.attachAnswer("run-unknown", "orphan answer")
	if open.answer != "orphan answer" {
		t.Errorf("the answer did not fall back to the open turn: %q", open.answer)
	}
}

// TestAnAnswerWithNothingOpenBecomesAStandaloneEntry is the last resort: a restored
// session's answer, or a message that arrives after the turn closed.
func TestAnAnswerWithNothingOpenBecomesAStandaloneEntry(t *testing.T) {
	m := testModel()
	m.attachAnswer("", "standalone")
	if len(m.transcript) != 1 {
		t.Fatalf("the transcript did not grow: %d entries", len(m.transcript))
	}
	if m.transcript[0].kind != "assistant" {
		t.Errorf("entry kind = %q, want assistant", m.transcript[0].kind)
	}
}

// TestTheAnswerIsDrawnInsideItsTurn is the visible half: the block has to render
// under the turn's header, not after every turn.
func TestTheAnswerIsDrawnInsideItsTurn(t *testing.T) {
	m := filledModel(120, 40)
	turn := m.transcript[0].turn
	turn.answer = "改好了"

	rendered := visible(strings.Join(m.renderTurn(turn, 100), "\n"))
	if !strings.Contains(rendered, "改好了") {
		t.Fatalf("the answer is not in the turn's own block:\n%s", rendered)
	}
}

// TestTheRailAutoOpensOnTheFirstTaskList is decision 26, including the half that was
// missing: **a manual collapse does not suppress it**.
//
// When the user folded the rail there was no task list, so "the model just wrote one
// down" is information they have not seen. Keying this on `railPinned` removes the
// feature for anybody who has ever pressed Ctrl+B — silently, because the rail just
// stays folded.
func TestTheRailAutoOpensOnTheFirstTaskList(t *testing.T) {
	m := testModel()
	m.railHidden = true
	m.railPinned = true
	m.panel.todos = []any{map[string]any{"status": "pending", "content": "x"}}

	m.beginTurn(map[string]any{"run_id": "r1"})

	if m.railHidden {
		t.Error("the rail stayed folded when the first task list appeared")
	}
}

// TestTheRailDoesNotReopenOnAContentUpdate: `todo_write` is called many times in one
// long task, and re-opening on every call would be a panel that keeps popping itself
// open.
func TestTheRailDoesNotReopenOnAContentUpdate(t *testing.T) {
	m := testModel()
	m.panel.todos = []any{map[string]any{"status": "pending", "content": "x"}}
	m.beginTurn(map[string]any{"run_id": "r1"})

	// The user folds it again, then a task changes state.
	m.railHidden = true
	m.railPinned = true
	m.panel.todos = []any{map[string]any{"status": "completed", "content": "x"}}
	m.beginTurn(map[string]any{"run_id": "r2"})

	if !m.railHidden {
		t.Error("a content update re-opened the rail the user had folded")
	}
}

// TestAnEmptyListReArmsTheEdge: going back to empty means the next appearance is a
// new event, not "the same batch is still there".
func TestAnEmptyListReArmsTheEdge(t *testing.T) {
	m := testModel()
	m.panel.todos = []any{map[string]any{"status": "pending", "content": "x"}}
	m.beginTurn(map[string]any{"run_id": "r1"})

	m.panel.todos = nil
	m.beginTurn(map[string]any{"run_id": "r2"})
	if m.railTodosSeen {
		t.Fatal("an empty list did not re-arm the edge")
	}

	m.railHidden = true
	m.railPinned = true
	m.panel.todos = []any{map[string]any{"status": "pending", "content": "y"}}
	m.beginTurn(map[string]any{"run_id": "r3"})
	if m.railHidden {
		t.Error("the re-armed edge did not open the rail")
	}
}

// TestTheSpinnerRunsWhileBooting is the two-second window before `init`, which is
// exactly the stretch with nothing else on screen: a canvas where nothing moves
// reads as a hang.
func TestTheSpinnerRunsWhileBooting(t *testing.T) {
	m := testModel()
	m.booting = true
	if !m.spinnerNeeded() {
		t.Fatal("no spinner while booting")
	}
	if m.spinnerFrame() == "" {
		t.Fatal("the spinner frame is empty while booting")
	}
}

// TestTheSpinnerStopsWhileAPersonIsBeingAsked is the one moment an animated mark is
// actively misleading: the agent is stopped, and the only thing that should move is
// the modal.
func TestTheSpinnerStopsWhileAPersonIsBeingAsked(t *testing.T) {
	m := testModel()
	m.busy = true
	m.quiet = true
	if !m.spinnerNeeded() {
		t.Fatal("the quiet-mode spinner is not running during a turn")
	}

	m.pendingPermission = map[string]any{"id": "p1"}
	if m.spinnerNeeded() {
		t.Error("the spinner kept running while an approval was waiting")
	}
	m.pendingPermission = nil
	m.pendingQuestion = map[string]any{"id": "q1"}
	if m.spinnerNeeded() {
		t.Error("the spinner kept running while a question was waiting")
	}
}

// TestTheFoldedRailSummarySaysWhetherItWillAsk: the summary is defined as "say what
// collapsing hid", and one of the things it hid is whether the next risky call asks.
func TestTheFoldedRailSummarySaysWhetherItWillAsk(t *testing.T) {
	m := testModel()
	m.width = 200
	without := visible(m.renderRailSummary())

	m.panel.autopilot = true
	with := visible(m.renderRailSummary())

	if strings.Contains(without, i18nTitle("rail.summary.autopilot")) {
		t.Fatalf("the summary claims autopilot before it is on:\n%s", without)
	}
	if !strings.Contains(with, i18nTitle("rail.summary.autopilot")) {
		t.Fatalf("the summary does not say autopilot is on:\n%s", with)
	}
}
