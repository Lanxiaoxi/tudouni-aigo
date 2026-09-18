package subagent

import (
	"strings"
	"testing"
)

// fakeClock is a hand-cranked clock, so a duration in a test is a number the test
// chose rather than however long the machine took.
type fakeClock struct{ now float64 }

func (c *fakeClock) tick(seconds float64) { c.now += seconds }
func (c *fakeClock) read() float64        { return c.now }

// TestTheBoardForgetsADelegationWhenItEnds is the property the badge depends on.
//
// Every other panel in this program keeps finished work visible because somebody
// still has to collect it. A delegation has nobody to collect it 鈥?its answer went
// back to the parent as a tool result, which the transcript already shows 鈥?so a
// row that stayed would be a second, worse copy of something already on screen,
// and it would claim work was in flight when it was over.
func TestTheBoardForgetsADelegationWhenItEnds(t *testing.T) {
	clock := &fakeClock{}
	board := NewBoard(clock.read)

	board.Start(Delegation{ID: "sub-a-1", Label: "count the widgets", Model: "fake", Depth: 1})
	if board.Count() != 1 {
		t.Fatalf("count = %d after starting, want 1", board.Count())
	}
	rows := board.Panel()
	if len(rows) != 1 {
		t.Fatalf("panel has %d rows, want 1", len(rows))
	}
	if rows[0]["label"] != "count the widgets" {
		t.Errorf("row label = %v", rows[0]["label"])
	}
	if rows[0]["started"] != nil {
		t.Error("the start time leaked into the panel; a front end would have to know the clock's epoch")
	}

	board.Finish("sub-a-1")
	if board.Count() != 0 {
		t.Errorf("count = %d after finishing, want 0", board.Count())
	}
	if rows := board.Panel(); len(rows) != 0 {
		t.Errorf("panel still has %d rows after finishing", len(rows))
	}
	// Finishing twice must not panic or resurrect anything: the two paths that
	// finish a delegation (the normal one and a cancelled run) can both run.
	board.Finish("sub-a-1")
	if board.Count() != 0 {
		t.Error("finishing twice brought the row back")
	}
}

// TestTheBoardReportsHowLongADelegationHasRun covers the number that turns
// "running" into "running for a while": a badge that only ever said "1 subagent"
// cannot tell a working child from a stuck one.
func TestTheBoardReportsHowLongADelegationHasRun(t *testing.T) {
	clock := &fakeClock{}
	board := NewBoard(clock.read)
	board.Start(Delegation{ID: "sub-a-1"})

	clock.tick(42)
	rows := board.Panel()
	if got := rows[0]["seconds"]; got != 42 {
		t.Errorf("seconds = %v, want 42", got)
	}
}

// TestTheBoardFollowsAChildsOwnRecords is what makes the badge specific.
//
// The step count is taken only from **successful** model calls, because a failed
// attempt is retried inside the same step and counting it would make a child that
// is fighting a flaky endpoint look like one that is making progress.
func TestTheBoardFollowsAChildsOwnRecords(t *testing.T) {
	board := NewBoard((&fakeClock{}).read)
	board.Start(Delegation{ID: "sub-a-1"})

	board.Observe(map[string]any{"kind": "model_call", "status": "ok", "subagent_id": "sub-a-1"})
	board.Observe(map[string]any{"kind": "model_call", "status": "error", "subagent_id": "sub-a-1"})
	board.Observe(map[string]any{"kind": "tool_call", "tool": "read_file", "subagent_id": "sub-a-1"})

	rows := board.Panel()
	if got := rows[0]["steps"]; got != 1 {
		t.Errorf("steps = %v, want 1 (the failed attempt is a retry, not a step)", got)
	}
	if got := rows[0]["tool_calls"]; got != 1 {
		t.Errorf("tool_calls = %v, want 1", got)
	}
	if got := rows[0]["activity"]; got != "read_file" {
		t.Errorf("activity = %v, want read_file", got)
	}

	// The result clears the activity. A tool name left standing after the call
	// returned reads as "still doing that", which is the wrong answer while the
	// child is deciding what to do next.
	board.Observe(map[string]any{"kind": "tool_result", "tool": "read_file", "subagent_id": "sub-a-1"})
	if got := board.Panel()[0]["activity"]; got != "" {
		t.Errorf("activity = %v after the call returned, want it cleared", got)
	}
}

// TestTheBoardIgnoresRecordsFromBeforeItKnew checks the one failure a fragment
// causes: a row invented from a record whose start time is a guess.
func TestTheBoardIgnoresRecordsFromBeforeItKnew(t *testing.T) {
	board := NewBoard((&fakeClock{}).read)

	// A resumed session replays its log, so the first thing the board sees can be
	// the middle of a delegation rather than its beginning.
	board.Observe(map[string]any{"kind": "tool_call", "tool": "read_file", "subagent_id": "sub-gone-1"})

	if board.Count() != 0 {
		t.Errorf("count = %d; a record for an unknown delegation invented a row", board.Count())
	}
	if rows := board.Panel(); len(rows) != 0 {
		t.Errorf("panel has %d rows invented from a fragment", len(rows))
	}
}

// TestTheNoteNamesEveryDelegationInFlight is the evidence the parent keeps.
//
// The parent's model is blocked inside the subagent call for the whole delegation,
// so it cannot act on this note. What it is for is a session that is restored
// while one was running: without it the parent's next request shows no trace of
// work that was already paid for.
func TestTheNoteNamesEveryDelegationInFlight(t *testing.T) {
	board := NewBoard((&fakeClock{}).read)
	if note := board.Note(); note != "" {
		t.Errorf("an idle board produced a note: %q", note)
	}

	board.Start(Delegation{ID: "sub-a-1", Label: "count the widgets"})
	board.Start(Delegation{ID: "sub-a-2"})

	note := board.Note()
	for _, want := range []string{"sub-a-1", "count the widgets", "sub-a-2"} {
		if !strings.Contains(note, want) {
			t.Errorf("the note does not mention %q: %s", want, note)
		}
	}

	board.Finish("sub-a-1")
	board.Finish("sub-a-2")
	if note := board.Note(); note != "" {
		t.Errorf("the note outlived the delegations: %q", note)
	}
}

// TestANilBoardIsSafe pins the contract the runtime relies on: a runtime with
// delegation switched off holds a nil board and must not have to guard every use.
func TestANilBoardIsSafe(t *testing.T) {
	var board *Board

	board.Start(Delegation{ID: "sub-a-1"})
	board.Finish("sub-a-1")
	board.Observe(map[string]any{"subagent_id": "sub-a-1"})
	board.Progress("sub-a-1", func(*Delegation) { t.Error("a nil board ran an update") })

	if board.Count() != 0 {
		t.Errorf("a nil board counted %d", board.Count())
	}
	if rows := board.Panel(); rows != nil {
		t.Errorf("a nil board produced rows: %v", rows)
	}
	if note := board.Note(); note != "" {
		t.Errorf("a nil board produced a note: %q", note)
	}
}

// TestThePanelOrderIsStable keeps two snapshots of one state describing the rows
// in the same order. A list that reordered itself between two draws makes the
// screen flicker for no reason a reader could name.
func TestThePanelOrderIsStable(t *testing.T) {
	clock := &fakeClock{}
	board := NewBoard(clock.read)

	board.Start(Delegation{ID: "sub-a-1"})
	clock.tick(1)
	board.Start(Delegation{ID: "sub-a-2"})
	clock.tick(1)
	board.Start(Delegation{ID: "sub-a-3"})

	want := []string{"sub-a-1", "sub-a-2", "sub-a-3"}
	for attempt := 0; attempt < 5; attempt++ {
		rows := board.Panel()
		if len(rows) != len(want) {
			t.Fatalf("panel has %d rows, want %d", len(rows), len(want))
		}
		for index, id := range want {
			if rows[index]["id"] != id {
				t.Fatalf("attempt %d: row %d is %v, want %s (the order moved between reads)",
					attempt, index, rows[index]["id"], id)
			}
		}
	}
}
