package state

import (
	"strings"
	"testing"
)

// userMessage and answerMessage are the two shapes the digest reads. They go
// through the store rather than the helpers alone in the integration tests,
// because the field is filled by a scan of a real file.
func userMessage(text string) map[string]any {
	return map[string]any{"role": "user", "content": text}
}

func answerMessage(text string) map[string]any {
	return map[string]any{"role": "assistant", "content": text}
}

// summaryOf saves one session file and reads its summary back.
func summaryOf(t *testing.T, budget int, messages ...map[string]any) *SessionSummary {
	t.Helper()
	store, err := NewSessionStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session := NewEmptySession("20260101-120000")
	for _, message := range messages {
		session.Append(message)
	}
	if err := store.Save(session); err != nil {
		t.Fatalf("save: %v", err)
	}
	summary, err := store.LoadSummary("20260101-120000", budget)
	if err != nil {
		t.Fatalf("LoadSummary: %v", err)
	}
	return summary
}

// TestDigestJoinsTheTopicAndTheLastAnswer is the shape the row is designed
// around: what was asked, then where it got to.
func TestDigestJoinsTheTopicAndTheLastAnswer(t *testing.T) {
	got := digestPreview("please add a rail", "added it", PreviewBudget)
	if want := "please add a rail → added it"; got != want {
		t.Errorf("digestPreview = %q, want %q", got, want)
	}
}

// TestDigestGivesAShortTopicMoreOfTheOutcome: the two halves share one budget,
// and the share is not fixed — a three-word question should not clip a useful
// answer to the same width as a question that used the whole line.
func TestDigestGivesAShortTopicMoreOfTheOutcome(t *testing.T) {
	longAnswer := strings.Repeat("a", 200)
	shortTopic := digestPreview("fix it", longAnswer, PreviewBudget)
	longTopic := digestPreview(strings.Repeat("q", 60), longAnswer, PreviewBudget)

	if !strings.Contains(shortTopic, previewSeparator) {
		t.Fatalf("a short topic lost its outcome: %q", shortTopic)
	}
	if runeLen(shortTopic) > PreviewBudget {
		t.Errorf("the digest is %d runes, over the budget %d", runeLen(shortTopic), PreviewBudget)
	}
	if !strings.Contains(shortTopic, strings.Repeat("a", 40)) {
		t.Errorf("a short topic did not hand its spare room to the outcome: %q", shortTopic)
	}
	if strings.Contains(longTopic, previewSeparator) {
		t.Errorf("a topic that fills the budget still grew an arrow: %q", longTopic)
	}
}

// TestDigestDropsTheOutcomeRatherThanDangleTheArrow: "topic →" with nothing
// behind it reads as a rendering fault, so the arrow goes with the outcome.
func TestDigestDropsTheOutcomeRatherThanDangleTheArrow(t *testing.T) {
	got := digestPreview("a question long enough to fill the budget", "done", 20)
	if strings.Contains(got, "→") {
		t.Errorf("digestPreview = %q, want no arrow", got)
	}
	if runeLen(got) > 20 {
		t.Errorf("digestPreview = %q (%d runes), over the budget 20", got, runeLen(got))
	}
}

// TestDigestWithoutATopicIsEmpty: a session nobody has spoken in has no row to
// describe, and an answer alone must not invent one — the list would then claim
// the model opened the conversation.
func TestDigestWithoutATopicIsEmpty(t *testing.T) {
	if got := digestPreview("", "an answer with no question", PreviewBudget); got != "" {
		t.Errorf("digestPreview = %q, want empty", got)
	}
}

// TestFirstSentenceStopsAtTheEndOfASentence — and only where a sentence really
// ends. The two guards here are the difference between a title and a fragment:
// a terminator in the first few runes ("1. ", "e.g. ") is not the end, and a
// period inside a number or a version is not punctuation.
func TestFirstSentenceStopsAtTheEndOfASentence(t *testing.T) {
	cases := []struct {
		name string
		text string
		want string
	}{
		{"chinese terminator", "修复登录。顺便跑一下测试。", "修复登录。"},
		{"english terminator", "please add a test. then run it", "please add a test."},
		{"greeting first sentence", "好的。帮我查一下磁盘占用。", "帮我查一下磁盘占用。"},
		{"acknowledgement first sentence", "Done. Here's what changed.", "Here's what changed."},
		{"decimal point", "version 1.2 broke the rail", "version 1.2 broke the rail"},
		{"abbreviation inside the first runes", "e.g. this is wrong", "e.g. this is wrong"},
		{"no terminator", "done", "done"},
		{"newlines fold into one line", "line one\nline two", "line one line two"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := firstSentence(test.text, PreviewBudget); got != test.want {
				t.Errorf("firstSentence(%q) = %q, want %q", test.text, got, test.want)
			}
		})
	}
}

// TestFirstSentenceCountsTheEllipsisInsideTheLimit: the cap is the number the
// caller promises its layout, not the number before the ellipsis.
func TestFirstSentenceCountsTheEllipsisInsideTheLimit(t *testing.T) {
	got := firstSentence("a very long sentence that has no end", 10)
	if runeLen(got) != 10 {
		t.Errorf("firstSentence = %q (%d runes), want 10 including the ellipsis", got, runeLen(got))
	}
	if !strings.HasSuffix(got, "…") {
		t.Errorf("firstSentence = %q, want a clipped sentence", got)
	}
}

// TestClipRunesKeepsTheBudget: the one arithmetic rule the digest depends on.
func TestClipRunesKeepsTheBudget(t *testing.T) {
	got := clipRunes(strings.Repeat("x", 100), 10)
	if runeLen(got) != 10 || !strings.HasSuffix(got, "…") {
		t.Errorf("clipRunes = %q (%d runes), want 10 ending in an ellipsis", got, runeLen(got))
	}
	if short := clipRunes("short", 10); short != "short" {
		t.Errorf("clipRunes padded a short string: %q", short)
	}
}

// TestPreviewNoiseIsNarrowOnPurpose: the filter may hide a greeting, never a
// question. Each "false" here is a message that opens with something a naive
// prefix test would have swallowed.
func TestPreviewNoiseIsNarrowOnPurpose(t *testing.T) {
	cases := []struct {
		name    string
		message map[string]any
		text    string
		want    bool
	}{
		{"greeting", nil, "hi", true},
		{"greeting with punctuation", nil, "Hi!", true},
		{"chinese greeting", nil, "你好！", true},
		{"bare slash command", nil, "/compact", true},
		{"runtime note", map[string]any{"role": "user", "content": "note", RuntimeNoteKey: true}, "note", true},
		{"greeting with a question behind it", nil, "hi, can you look at the rail", false},
		{"a path that starts with a slash", nil, "/usr/bin is broken", false},
		{"an ordinary topic", nil, "hello world", false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := previewNoise(test.message, test.text); got != test.want {
				t.Errorf("previewNoise(%q) = %v, want %v", test.text, got, test.want)
			}
		})
	}
}

// TestCleanHidesFormattingButKeepsMeaning: the topic keeps a pasted error's
// content and loses only the fence markers; the outcome loses the code block
// entirely, because code is what the answer produced, not what it concluded.
func TestCleanHidesFormattingButKeepsMeaning(t *testing.T) {
	if got, want := cleanTopic("这是报错：\n```\nTypeError: x\n```"), "这是报错： TypeError: x"; got != want {
		t.Errorf("cleanTopic = %q, want %q", got, want)
	}
	outcome := "## 结论：96% 是构建缓存\n\n```\ntotal 4500 MB\n```\n"
	if got, want := cleanOutcome(outcome), "结论：96% 是构建缓存"; got != want {
		t.Errorf("cleanOutcome = %q, want %q", got, want)
	}
	if got, want := cleanOutcome("> 1. **已修复**。"), "已修复。"; got != want {
		t.Errorf("cleanOutcome = %q, want %q", got, want)
	}
}

// TestDigestDropsAnOutcomeThatWasOnlyCode: a closing answer can be nothing but
// a code block. There is no prose to put after the arrow, and "topic →" alone
// reads as a fault.
func TestDigestDropsAnOutcomeThatWasOnlyCode(t *testing.T) {
	got := digestPreview("fix the rail", "```go\nfmt.Println()\n```", PreviewBudget)
	if got != "fix the rail" {
		t.Errorf("digestPreview = %q, want the topic alone", got)
	}
}

// TestLoadSummaryStillShowsAMessageThatWasOnlyAFence: the empty preview has one
// meaning — the session never spoke — so a message that cleans away to nothing
// still has to leave something behind.
func TestLoadSummaryStillShowsAMessageThatWasOnlyAFence(t *testing.T) {
	summary := summaryOf(t, PreviewBudget, userMessage("```"))
	if summary.Preview == "" {
		t.Fatal("a session with a user message reported that it never spoke")
	}
}

// TestLoadSummaryPrefersTheFirstRealQuestionOverTheGreeting: the whole point of
// the change. A session that opens with "hi" and then asks something must not be
// listed as "hi" for the rest of its life.
func TestLoadSummaryPrefersTheFirstRealQuestionOverTheGreeting(t *testing.T) {
	summary := summaryOf(t, PreviewBudget,
		userMessage("hi"),
		answerMessage("Hi! What can I help with?"),
		userMessage("当前目录占用多大？"),
		answerMessage("大约 1.2 GB。"),
	)
	if want := "当前目录占用多大？ → 大约 1.2 GB。"; summary.Preview != want {
		t.Errorf("Preview = %q, want %q", summary.Preview, want)
	}
}

// TestLoadSummaryFallsBackToTheGreetingWhenThatIsAllThereIs: when every message
// was a greeting, showing the greeting is still truer than showing nothing —
// "never spoke" is a claim about the session, and it did speak. There is no
// topic to answer, so no arrow is invented either.
func TestLoadSummaryFallsBackToTheGreetingWhenThatIsAllThereIs(t *testing.T) {
	summary := summaryOf(t, PreviewBudget,
		userMessage("hi"),
		answerMessage("hello"),
	)
	if want := "hi"; summary.Preview != want {
		t.Errorf("Preview = %q, want %q", summary.Preview, want)
	}
}

// TestLoadSummarySkipsTheRuntimesOwnNotes: a model-change notice is a user-role
// message the runtime wrote, not something a person asked. The session list must
// not name the conversation after it — the same rule UserInputs already applies.
func TestLoadSummarySkipsTheRuntimesOwnNotes(t *testing.T) {
	summary := summaryOf(t, PreviewBudget,
		map[string]any{"role": "user", "content": "the model changed from A to B", RuntimeNoteKey: true},
		userMessage("real question"),
	)
	if summary.Preview != "real question" {
		t.Errorf("Preview = %q, want the person's own question", summary.Preview)
	}
}

// TestLoadSummaryEndsOnTheLastAnswerOfTheTopicsTurn: the digest says where the
// topic got to, so the answer is the one that closes that turn — not the last
// answer in a file that went on to discuss something else.
func TestLoadSummaryEndsOnTheLastAnswerOfTheTopicsTurn(t *testing.T) {
	summary := summaryOf(t, PreviewBudget,
		userMessage("do the thing"),
		answerMessage("first attempt"),
		answerMessage("finished it"),
		userMessage("a different question"),
		answerMessage("another answer entirely"),
	)
	if want := "do the thing → finished it"; summary.Preview != want {
		t.Errorf("Preview = %q, want %q", summary.Preview, want)
	}
}

// TestLoadSummaryNeverExceedsTheBudget: the row is drawn by three front ends
// with different clamps, and the runtime is the one place that promises the
// length. A digest that overruns here would be re-cut somewhere else.
func TestLoadSummaryNeverExceedsTheBudget(t *testing.T) {
	summary := summaryOf(t, 40,
		userMessage(strings.Repeat("q", 200)),
		answerMessage(strings.Repeat("a", 200)),
	)
	if got := runeLen(summary.Preview); got > 40 {
		t.Errorf("Preview = %q (%d runes), over the budget 40", summary.Preview, got)
	}
}
