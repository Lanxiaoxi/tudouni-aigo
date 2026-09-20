package tui

import (
	"strings"
	"testing"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
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
// down" is information they have not seen. Keying this on a "the user pinned it" flag
// removes the feature for anybody who has ever pressed Ctrl+B — silently, because the
// rail just stays folded.
func TestTheRailAutoOpensOnTheFirstTaskList(t *testing.T) {
	m := testModel()
	m.railHidden = true
	m.panel.todos = []any{map[string]any{"status": "pending", "content": "x"}}

	m.beginTurn(map[string]any{"run_id": "r1"})

	if m.railHidden {
		t.Error("the rail stayed folded when the first task list appeared")
	}
}

// TestTheRailAutoOpensOnAGoal: the same edge as the task list, for the one thing the
// rail holds that is a person's own words restated by the model.
//
// "Did it understand what I asked for" is the question the goal block answers, and it
// is worth more than the columns — a goal is what the session is **for**, it outlives
// the turn that created it, and it survives a `/resume` and a compaction. Reading it
// only after pressing Ctrl+B is reading it too late.
func TestTheRailAutoOpensOnAGoal(t *testing.T) {
	m := testModel()
	m.railHidden = true

	m.handleUI(map[string]any{
		"kind": protocol.UIState,
		"goal": map[string]any{
			"objective": "把重连修好，并证明它修好了", "phase": "active",
			"rounds_text": "0/60", "armed": true,
		},
	})
	if m.railHidden {
		t.Error("the rail stayed folded when the goal was created")
	}
}

// TestTheRailAutoOpensOnAJob: the third edge — a command the person sent to the
// background. The block is the only place its state is drawn, and the whole point of
// backgrounding is to be able to look at it later.
//
// It keys on **any** job rather than on "something is still running": the block lists
// collected and killed rows too, and a job that finished inside the same snapshot
// window would otherwise never be announced at all.
func TestTheRailAutoOpensOnAJob(t *testing.T) {
	m := testModel()
	m.railHidden = true

	m.handleUI(map[string]any{
		"kind": protocol.UIState,
		"jobs": []any{map[string]any{"state": "running", "command": "go test ./...", "seconds": 3}},
	})
	if m.railHidden {
		t.Error("the rail stayed folded when a background job appeared")
	}
}

// TestAnEmptyGoalOrJobBoardReArmsTheEdge: the edge, not the level. Once the thing is
// gone, the next one is a new event — a goal cleared with `/goal clear` and created
// again must announce itself, and so must a board that empties out.
func TestAnEmptyGoalOrJobBoardReArmsTheEdge(t *testing.T) {
	m := testModel()
	m.railHidden = true
	m.handleUI(map[string]any{
		"kind": protocol.UIState,
		"goal": map[string]any{"objective": "第一个目标", "phase": "active", "rounds_text": "0/5",
			"armed": true},
		"jobs": []any{map[string]any{"state": "running", "command": "go test ./..."}},
	})
	if m.railHidden {
		t.Fatal("neither a goal nor a job opened the rail")
	}

	// Both go away, the user folds the rail, and both come back as new ones.
	m.handleUI(map[string]any{
		"kind": protocol.UIState,
		"goal": map[string]any{"objective": "", "phase": ""},
		"jobs": []any{},
	})
	m.railHidden = true
	m.handleUI(map[string]any{
		"kind": protocol.UIState,
		"goal": map[string]any{"objective": "第二个目标", "phase": "active", "rounds_text": "0/5",
			"armed": true},
		"jobs": []any{map[string]any{"state": "done", "command": "go build ./..."}},
	})
	if m.railHidden {
		t.Error("the re-armed edge did not open the rail")
	}
}

// TestTheRailDoesNotReopenOnAContentUpdate: `todo_write` is called many times in one
// long task, and re-opening on every call would be a panel that keeps popping itself
// open. A job changing state is the same kind of update.
func TestTheRailDoesNotReopenOnAContentUpdate(t *testing.T) {
	m := testModel()
	m.panel.todos = []any{map[string]any{"status": "pending", "content": "x"}}
	m.panel.jobs = []any{map[string]any{"state": "running", "command": "go test ./..."}}
	m.beginTurn(map[string]any{"run_id": "r1"})

	// The user folds it again, then a task changes state and the job finishes.
	m.railHidden = true
	m.panel.todos = []any{map[string]any{"status": "completed", "content": "x"}}
	m.panel.jobs = []any{map[string]any{"state": "uncollected", "command": "go test ./..."}}
	m.beginTurn(map[string]any{"run_id": "r2"})

	if !m.railHidden {
		t.Error("a content update re-opened the rail the user had folded")
	}
}

// TestTheRailOpensOnATaskListThatArrivesMidTurn is the regression for a check
// that always ran too early.
//
// The task list does not exist when a turn starts. `run_started` arrives first
// and `todo_write` is called one or more steps later, so `beginTurn` — where the
// edge was tested — only ever saw an empty list, and the rail never opened itself
// for the one thing it opens itself for. The list reaches the panel through the
// state snapshot that follows the tool result, which is where it is now noticed.
func TestTheRailOpensOnATaskListThatArrivesMidTurn(t *testing.T) {
	m := testModel()
	m.railHidden = true

	m.handleEvent(map[string]any{"kind": "run_started", "run_id": "r1"})
	if !m.railHidden {
		t.Fatal("the rail opened before there was anything to show")
	}

	m.handleUI(map[string]any{
		"kind":  protocol.UIState,
		"todos": []any{map[string]any{"status": "in_progress", "content": "read the code"}},
	})
	if m.railHidden {
		t.Error("the rail stayed folded when the task list arrived mid-turn")
	}
}

// TestAMidTurnTaskListStillRespectsACollapse: the edge, not the level. Once the
// list has been seen, a later `todo_write` in the same turn is a content update —
// `todo_write` is called many times in a long task, and re-opening on every one
// would be a panel that keeps popping itself open.
func TestAMidTurnTaskListStillRespectsACollapse(t *testing.T) {
	m := testModel()
	m.railHidden = true

	state := func(status, content string) map[string]any {
		return map[string]any{
			"kind":  protocol.UIState,
			"todos": []any{map[string]any{"status": status, "content": content}},
		}
	}
	m.handleUI(state("pending", "first"))
	if m.railHidden {
		t.Fatal("the first task list did not open the rail")
	}

	m.railHidden = true
	m.handleUI(state("completed", "first"))
	if !m.railHidden {
		t.Error("a mid-turn content update re-opened the rail the user had folded")
	}
}

// TestEachStepsThinkingCountsFromZero is the regression for a live counter that
// never restarted.
//
// The step a `delta` carries identifies its **streaming block**, and the block is
// what `thinkingChars` measures: "how much has this step thought so far". When
// two consecutive steps shipped the same number, the difference was never noticed,
// the counter accumulated across the whole turn, and the moment `model_call`
// finalized a step's reasoning the number on screen stopped moving — it was
// showing a previous step's static total while the live chunks added to a count
// nothing drew.
func TestEachStepsThinkingCountsFromZero(t *testing.T) {
	m := testModel()
	m.quiet = true
	m.handleEvent(map[string]any{"kind": "run_started", "run_id": "r1"})

	// Step 1 thinks 11 cells.
	m.handleDelta(map[string]any{"channel": "reasoning", "text": "aaaa bbbb c", "run_id": "r1", "step": 1})
	if m.thinkingChars != 11 {
		t.Fatalf("step 1 counted %d cells, want 11", m.thinkingChars)
	}
	if !m.thinkingLive {
		t.Fatal("a reasoning chunk did not start a live block")
	}

	// Step 2 is a different block: it starts from zero, and keeps only its own text
	// — not step 1's 11 cells plus its own.
	m.handleDelta(map[string]any{"channel": "reasoning", "text": "ddd", "run_id": "r1", "step": 2})
	if m.thinkingChars != 3 {
		t.Errorf("step 2 counted %d cells, want 3 (its own, not the turn's running total)", m.thinkingChars)
	}
	if m.thinkingText != "ddd" {
		t.Errorf("step 2's live text = %q, want only its own chunks", m.thinkingText)
	}

	// What the screen actually shows. The counter is only worth resetting if the
	// line drawn reads it — step 1's finalized reasoning must not outrank the block
	// that is still being written.
	screen := stripANSI(m.View())
	if !strings.Contains(screen, "3 chars") {
		t.Errorf("the live line does not show step 2's own 3 cells:\n%s", screen)
	}
	if strings.Contains(screen, "11 chars") {
		t.Errorf("the live line still shows step 1's total:\n%s", screen)
	}

	// A second chunk of the same step still accumulates: the reset is per step,
	// not per chunk.
	m.handleDelta(map[string]any{"channel": "reasoning", "text": "ee", "run_id": "r1", "step": 2})
	if m.thinkingChars != 5 {
		t.Errorf("a second chunk of step 2 counted %d cells, want 5", m.thinkingChars)
	}
	if screen := stripANSI(m.View()); !strings.Contains(screen, "5 chars") {
		t.Errorf("the drawn line did not follow the second chunk:\n%s", screen)
	}
}

// TestTheLiveThinkingOutranksThePreviousStepsReasoning: the ordering between the
// two thinking branches, pinned on its own because it is the half a counter test
// cannot see.
//
// A turn that has made one tool call already has a finalized `turn.thinking` —
// step 1's reasoning — and while step 2 streams, the live copy is the only thing
// describing the present. Rendering the finalized one first left the panel
// showing stale thoughts with a frozen count, which is exactly the "it is stuck"
// reading this interface is built to avoid.
func TestTheLiveThinkingOutranksThePreviousStepsReasoning(t *testing.T) {
	m := filledModel(120, 40)
	m.current = nil
	m.transcript = nil
	m.turnSeq = 0
	m.quiet = true
	m.handleEvent(map[string]any{"kind": "run_started", "run_id": "r1"})

	// Step 1 finishes and its reasoning is finalized. Quiet mode folds the block, so
	// what the line carries is the finalized character count — 24 cells — with no
	// spinner, because nothing is being written any more.
	m.handleDelta(map[string]any{"channel": "reasoning", "text": "step one thoughts", "run_id": "r1", "step": 1})
	m.handleEvent(map[string]any{
		"kind": "model_call", "run_id": "r1", "step": 1, "status": "ok",
		"duration_ms": 900, "reasoning": "step one whole reasoning", "tool_calls": 1,
	})
	screen := stripANSI(m.View())
	if !strings.Contains(screen, "24 chars") {
		t.Fatalf("the finalized reasoning is not on screen after its step ended:\n%s", screen)
	}
	if strings.Contains(screen, "Ctrl+T") == false {
		t.Errorf("the finalized line lost its expand hint:\n%s", screen)
	}

	// Step 2 starts thinking: the live block takes the line, not the old text.
	m.handleDelta(map[string]any{"channel": "reasoning", "text": "now step two", "run_id": "r1", "step": 2})
	screen = stripANSI(m.View())
	if strings.Contains(screen, "24 chars") {
		t.Errorf("the previous step's finalized reasoning outranked the live block:\n%s", screen)
	}
	if !strings.Contains(screen, "12 chars") {
		t.Errorf("the live block is not drawn with its own count:\n%s", screen)
	}
	// The spinner is the part that says "and it is still going". Its frame is read
	// off the clock once per frame (`View` pins `frameAt`), so this asks that same
	// reading rather than the clock again: asking `time.Now()` here was a race with
	// a 90ms tick.
	if frame := m.spinnerFrame(); frame == "" {
		t.Error("a live thinking line is drawn with no spinner frame available")
	} else if !strings.Contains(screen, frame) {
		t.Errorf("the live line carries no spinner (%q):\n%s", frame, screen)
	}
}

// TestTheFinalizedThinkingReplacesTheLiveCopy is the second half of the same bug.
//
// `model_call` carries the step's reasoning whole, and `view.go` draws that
// version — it wins the branch. Leaving the live copy standing therefore meant
// two things at once: the screen showed the previous step's reasoning while the
// model was thinking about the next one, and the live counter went on counting a
// block that was no longer drawn. Dropping the live copy when the whole one
// arrives is what the nearby comment always claimed happened.
func TestTheFinalizedThinkingReplacesTheLiveCopy(t *testing.T) {
	m := testModel()
	m.quiet = true
	m.handleEvent(map[string]any{"kind": "run_started", "run_id": "r1"})

	m.handleDelta(map[string]any{"channel": "reasoning", "text": "thinking about it", "run_id": "r1", "step": 1})
	if !m.thinkingLive {
		t.Fatal("a reasoning chunk did not start a live block")
	}

	m.handleEvent(map[string]any{
		"kind": "model_call", "run_id": "r1", "step": 1, "status": "ok",
		"duration_ms": 900, "prompt_tokens": 10, "cached_tokens": 5,
		"reasoning": "the whole reasoning", "tool_calls": 1,
	})
	if m.thinkingLive {
		t.Error("the live block outlived the whole reasoning that replaced it")
	}
	if m.thinkingChars != 0 {
		t.Errorf("the live counter kept %d cells after being replaced", m.thinkingChars)
	}
	if m.current.thinking != "the whole reasoning" {
		t.Errorf("turn.thinking = %q, want the reasoning the call carried", m.current.thinking)
	}

	// A gateway that reports no `reasoning` on a step leaves nothing to replace
	// the live text with, so it must stay on screen: it is the only copy.
	m2 := testModel()
	m2.handleEvent(map[string]any{"kind": "run_started", "run_id": "r1"})
	m2.handleDelta(map[string]any{"channel": "reasoning", "text": "thought, unreported", "run_id": "r1", "step": 1})
	m2.handleEvent(map[string]any{
		"kind": "model_call", "run_id": "r1", "step": 1, "status": "ok",
		"duration_ms": 900, "tool_calls": 1,
	})
	if !m2.thinkingLive || m2.thinkingText == "" {
		t.Error("a step with no reported reasoning dropped the only copy of its thinking")
	}
}

// TestARetryDropsTheHalfWrittenStep: `delta_reset` names the block it clears, and
// a retry restates the whole step — so the counters start from zero rather than
// being added to the attempt that was thrown away.
func TestARetryDropsTheHalfWrittenStep(t *testing.T) {
	m := testModel()
	m.handleEvent(map[string]any{"kind": "run_started", "run_id": "r1"})

	m.handleDelta(map[string]any{"channel": "reasoning", "text": "aaaa", "run_id": "r1", "step": 1})
	m.handleDelta(map[string]any{"channel": "text", "text": "partial answer", "run_id": "r1", "step": 1})
	if m.thinkingChars != 4 || m.streamedText == "" {
		t.Fatalf("the first attempt did not stream: chars=%d text=%q", m.thinkingChars, m.streamedText)
	}

	m.handleServerMessage(map[string]any{"t": protocol.OutDeltaReset, "run_id": "r1", "step": 1})
	if m.thinkingChars != 0 || m.thinkingText != "" || m.streamedText != "" {
		t.Errorf("the reset left the thrown-away attempt on screen: chars=%d thinking=%q text=%q",
			m.thinkingChars, m.thinkingText, m.streamedText)
	}

	// And the retry's own chunks count from zero, not from the abandoned copy.
	m.handleDelta(map[string]any{"channel": "reasoning", "text": "bb", "run_id": "r1", "step": 1})
	if m.thinkingChars != 2 {
		t.Errorf("the retry counted %d cells, want its own 2", m.thinkingChars)
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
	if m.railSeen.todos {
		t.Fatal("an empty list did not re-arm the edge")
	}

	m.railHidden = true
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

// TestBothSpinnersShowTheSameFrameInOneRepaint: the status bar's mark and the live
// thinking line's are drawn by two different passes of the same frame, and they must
// agree — a spinner that disagrees with the one beside it reads as two clocks.
//
// That is what `frameAt` is for: View takes one reading of the clock before it draws
// anything, so a 90ms tick landing between the two passes cannot split them. Before
// it, each read the clock itself and the pair differed at random.
func TestBothSpinnersShowTheSameFrameInOneRepaint(t *testing.T) {
	m := testModel()
	m.width, m.height = 120, 40
	m.busy = true
	m.quiet = true
	m.spinning = true
	m.maxSteps = 40
	m.streamRunID = "r1"
	m.thinkingLive = true
	m.thinkingText = "还在想"
	m.thinkingChars = 3
	turn := &turnData{index: 1, runID: "r1", startedAt: time.Now()}
	m.transcript = []entry{{turn: turn}}
	m.current = turn

	frame := m.spinnerFrame()
	if frame == "" {
		t.Fatal("no spinner frame while a turn is running")
	}
	screen := stripANSI(m.View())
	if got := strings.Count(screen, frame); got < 2 {
		t.Errorf("the frame %q appears %d times; the status bar and the thinking line must both carry it:\n%s",
			frame, got, screen)
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
