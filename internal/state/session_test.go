package state

import (
	"strings"
	"testing"
)

// MessageText is what three readers see a body through — the session list's preview,
// the compaction skeleton and the interface's replay — so what it does with a picture
// decides whether the feature is visible anywhere a person looks.
//
// The rule worth a test: **a picture is named, not dropped.** A body that quietly
// loses its image reads as a message that never had one, which is the difference
// between "the user sent a screenshot" and "the user sent a sentence".

// TestMessageTextNamesAPicture.
func TestMessageTextNamesAPicture(t *testing.T) {
	message := map[string]any{
		"role": "user",
		"content": []any{
			map[string]any{"type": "text", "text": "这个页面怎么了？"},
			map[string]any{
				"type": "image", "artifact_id": "art_shot", "mime": "image/png",
				"name": "shot.png", "width": 1280, "height": 720, "bytes": 40960,
			},
		},
	}

	text, ok := MessageText(message)
	if !ok {
		t.Fatal("a body with a picture reported no text at all")
	}
	if !strings.Contains(text, "这个页面怎么了") {
		t.Errorf("the words were lost: %q", text)
	}
	if !strings.Contains(text, "shot.png") {
		t.Errorf("the picture was dropped, which reads as a message that never had one: %q", text)
	}
	if !strings.Contains(text, "1280×720") {
		t.Errorf("the dimensions are missing: %q", text)
	}
}

// TestMessageTextFallsBackWhenFactsAreMissing.
//
// The label has to be total: a part whose name or size was never recorded still needs
// something a person can read, or the preview of that message is a bare sentence and
// the reader concludes no picture was sent.
func TestMessageTextFallsBackWhenFactsAreMissing(t *testing.T) {
	// No name and no dimensions: the media type is what is left.
	text, ok := MessageText(map[string]any{
		"role": "user",
		"content": []any{
			map[string]any{"type": "image", "artifact_id": "art_1", "mime": "image/jpeg"},
		},
	})
	if !ok || !strings.Contains(text, "image/jpeg") {
		t.Fatalf("text = %q, ok = %v", text, ok)
	}
	if strings.Contains(text, "0×0") {
		t.Errorf("a made-up size reads as a measured one: %q", text)
	}

	// Nothing but an id: the generic word, never an empty string.
	text, ok = MessageText(map[string]any{
		"role":    "user",
		"content": []any{map[string]any{"type": "image", "artifact_id": "art_2"}},
	})
	if !ok || !strings.Contains(text, "image") {
		t.Fatalf("text = %q, ok = %v", text, ok)
	}
}

// TestMessageTextIsUnchangedForPlainBodies.
//
// The other half, and it is the one that must not regress: every message ever written
// before pictures existed is a string, and its reading is byte-for-byte the same.
func TestMessageTextIsUnchangedForPlainBodies(t *testing.T) {
	text, ok := MessageText(map[string]any{"role": "user", "content": "hello"})
	if !ok || text != "hello" {
		t.Fatalf("text = %q, ok = %v", text, ok)
	}

	// A text-only parts body joins with no separator, exactly as before.
	text, ok = MessageText(map[string]any{
		"role": "user",
		"content": []any{
			map[string]any{"type": "text", "text": "one "},
			map[string]any{"type": "text", "text": "two"},
		},
	})
	if !ok || text != "one two" {
		t.Fatalf("text = %q, ok = %v", text, ok)
	}

	// An empty body is still "no text", not an empty string that reads as a message
	// which said nothing.
	if _, ok := MessageText(map[string]any{"role": "user", "content": []any{}}); ok {
		t.Error("an empty parts body reported text")
	}
	if _, ok := MessageText(map[string]any{"role": "user"}); ok {
		t.Error("a message with no body reported text")
	}
}

// TestUserInputsCountsATurnWithAPicture.
//
// `UserInputs` is what answers "what did the person actually ask", and it goes through
// MessageText. A turn that was a screenshot plus one line must still appear — a turn
// that vanished from this list would be a question the goal tools and the session
// preview cannot see.
func TestUserInputsCountsATurnWithAPicture(t *testing.T) {
	session := NewEmptySession("s")
	session.Append(map[string]any{
		"role": "user",
		"content": []any{
			map[string]any{"type": "text", "text": "看看这个"},
			map[string]any{"type": "image", "artifact_id": "art_1", "name": "a.png"},
		},
	})

	inputs := session.UserInputs()
	if len(inputs) != 1 {
		t.Fatalf("UserInputs() = %#v, want the one turn", inputs)
	}
	if !strings.Contains(inputs[0], "看看这个") || !strings.Contains(inputs[0], "a.png") {
		t.Errorf("the turn came back as %q", inputs[0])
	}
}
