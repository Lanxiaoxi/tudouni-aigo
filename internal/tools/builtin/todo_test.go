package builtin

import (
	"strings"
	"testing"
)

// TestTheTaskListReachesThePayloadTail mirrors the previous generation's
// `todo_note`: the list the model maintains has to be re-stated at the end of every
// request.
//
// Leaving it in the history is not the same thing. N updates leave N stale copies
// behind, so "the most recent one that looks right" is guesswork — and even a
// perfect guess arrives at the wrong moment, because the list exists to be in front
// of the model **when it decides what to do next**.
func TestTheTaskListReachesThePayloadTail(t *testing.T) {
	metadata := map[string]any{}
	board := NewTodoBoard(metadata)
	board.Write(map[string]any{
		"todos": []any{
			map[string]any{"content": "读一下现有实现", "status": Completed},
			map[string]any{"content": "改 config 的加载顺序", "status": InProgress},
			map[string]any{"content": "补测试", "status": Pending},
		},
	})

	note := board.Note()
	if note == "" {
		t.Fatal("a list with three items produced no payload-tail block")
	}
	if !strings.Contains(note, "## 当前任务") {
		t.Errorf("the block has no heading:\n%s", note)
	}
	for _, want := range []string{
		"- [已完成] 读一下现有实现",
		"- [进行中] 改 config 的加载顺序",
		"- [待办] 补测试",
	} {
		if !strings.Contains(note, want) {
			t.Errorf("the block is missing %q:\n%s", want, note)
		}
	}
}

// TestAnEmptyListProducesNoBlock keeps the tail from carrying an empty heading:
// "here is your task list, it is empty" costs tokens every round and says nothing.
func TestAnEmptyListProducesNoBlock(t *testing.T) {
	if note := NewTodoBoard(map[string]any{}).Note(); note != "" {
		t.Errorf("an empty list produced a block:\n%s", note)
	}
	// The same after the model clears the list by marking everything completed: the
	// stored list is emptied on purpose, so the block has to go away.
	metadata := map[string]any{}
	board := NewTodoBoard(metadata)
	board.Write(map[string]any{
		"todos": []any{map[string]any{"content": "only item", "status": Completed}},
	})
	if note := board.Note(); note != "" {
		t.Errorf("an all-completed list still produces a block:\n%s", note)
	}
}

// TestTheNoteNeverTouchesTheSessionMessages: the tail is rebuilt every round, so it
// must not be persisted and must not dilute the derived rule "one assistant message
// = one step".
func TestTheNoteNeverTouchesTheSessionMessages(t *testing.T) {
	metadata := map[string]any{}
	board := NewTodoBoard(metadata)
	if _, present := metadata["messages"]; present {
		t.Error("NewTodoBoard wrote a messages key")
	}
	board.Write(map[string]any{
		"todos": []any{map[string]any{"content": "x", "status": Pending}},
	})
	_ = board.Note()
	if _, present := metadata["messages"]; present {
		t.Error("writing or reading the task list touched session messages")
	}
}
