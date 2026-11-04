package runtime

import (
	"reflect"
	"strings"
	"testing"
)

// TestParseSuggestedRepliesIsDefensive: models wrap JSON in fences and prose
// even when told not to, and the ceiling is the parser's to enforce.
func TestParseSuggestedRepliesIsDefensive(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    []string
	}{
		{"plain", `["push 吧"]`, []string{"push 吧"}},
		{"empty", `[]`, []string{}},
		{"fenced", "```json\n[\"push\", \"run the tests\"]\n```", []string{"push", "run the tests"}},
		{"capped", `["a","b","c","d"]`, []string{"a", "b", "c"}},
		{"deduped and trimmed", `["  push  ", "push", ""]`, []string{"push"}},
		{"one line", "[\"push\\nnow\"]", []string{"push now"}},
		{"too long dropped", `["` + strings.Repeat("x", suggestReplyRunes+1) + `", "ok"]`, []string{"ok"}},
	}
	for _, c := range cases {
		got, err := parseSuggestedReplies(c.content)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
	for _, bad := range []string{"no array here", `[1, 2]`, `{"replies": "x"}`} {
		if _, err := parseSuggestedReplies(bad); err == nil {
			t.Errorf("%q parsed without an error", bad)
		}
	}
}

// TestTheAnswerKeepsItsTail: the offer worth a button is where an answer ends.
func TestTheAnswerKeepsItsTail(t *testing.T) {
	answer := strings.Repeat("a", 10) + "Want me to push?"
	got := tailRunes(answer, 16)
	if got != "…Want me to push?" {
		t.Errorf("tailRunes = %q", got)
	}
	if headRunes("短的", 10) != "短的" {
		t.Error("a short prompt must pass through unchanged")
	}
}

// TestSuggestRepliesNeedsTheIsolatedPath: an adapter without CompleteOneShot
// gets no suggestions — never a fallback onto the turn's shared path.
func TestSuggestRepliesNeedsTheIsolatedPath(t *testing.T) {
	runtimeValue := &Runtime{Chat: &statusChat{}}
	if _, err := runtimeValue.SuggestReplies(t.Context(), "r1", "hi", "done"); err == nil {
		t.Fatal("want a refusal for an adapter with no isolated request path")
	}
}
