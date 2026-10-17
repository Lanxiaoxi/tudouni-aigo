package state

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// The session list shows one line per conversation, and this file decides what
// that line says. It is one string assembled from facts the summary scan already
// passes over: the first user message that says something, and the answer that
// closed that message's turn. Everything here is deterministic — no model, no
// network — because the list is read at every turn end and every window start,
// and a row that costs a model call is a row that will eventually be blank.

// previewSeparator joins the digest's two halves: what was asked, then where
// the conversation got to. An arrow rather than a dash because the second half
// is the first half's outcome, not a second topic.
const previewSeparator = " → "

// previewShortToken is the longest token whose trailing period is read as an
// abbreviation or a list marker rather than as a sentence end. Without it "1. "
// and "e.g. " would end a title after two characters, and a digest reading "1"
// or "e.g" names nothing. CJK terminators need no such guard: no Chinese word
// carries a "。" inside it.
const previewShortToken = 2

// previewMinOutcome is the smallest tail worth putting after the arrow. Below
// this the digest would end in "topic →", which reads as a rendering fault
// rather than as a fact, so the outcome is dropped whole.
const previewMinOutcome = 8

// SummaryScanChars bounds how much of one message the digest reads. Sentences
// are found in the opening, so a pasted log or a whole file can never make the
// summary scan walk it; the finished digest is at most PreviewBudget runes.
const SummaryScanChars = 512

// PreviewBudget is how many runes a session-list digest may occupy.
//
// 64 is measured, not rounded. The rail draws this string at 12px in a column
// about 210px wide and clamps it to two lines — roughly 35 CJK characters or 68
// Latin ones. A topic plus a short outcome fits that; a longer budget would be
// cut at the same two lines in the rail while every wider reader (the CLI, a
// notification, a hover card) had to slice a paragraph. A short topic leaves
// the rest of the budget to the outcome, which is where it is worth most.
const PreviewBudget = 64

// previewFiller are whole sentences that say nothing about the session: the
// greetings a conversation opens with and the acknowledgements it collects.
// Matching is exact — folded, lowercased, punctuation stripped — so "你好！" is
// filler while "hi, can you look at X" is not: the second one carries a topic
// after the greeting.
//
// The list is deliberately short. A real question that happens to look like an
// acknowledgement is far more expensive to hide than a greeting is to show: the
// digest exists to say what the session is about, and guessing wrong turns the
// one useful line into a wrong one.
var previewFiller = map[string]bool{
	"hi": true, "hello": true, "hey": true, "yo": true, "hiya": true,
	"hi there": true, "hello there": true,
	"good morning": true, "good afternoon": true, "good evening": true,
	"test": true, "testing": true, "测试": true, "测试一下": true,
	"ok": true, "okay": true, "thanks": true, "thank you": true, "thx": true,
	"done": true, "完成": true, "已完成": true, "搞定": true,
	"你好": true, "您好": true, "嗨": true, "哈喽": true,
	"在吗": true, "在么": true,
	"早上好": true, "早安": true, "早": true, "晚上好": true, "晚安": true,
	"谢谢": true, "好的": true, "收到": true, "好": true,
}

// previewPunctuation is what a filler sentence may wear and still be the same
// word.
const previewPunctuation = " .,!?;:，。！？；：、…~～"

// digestPreview renders the one line the session list shows: the topic first,
// then the opening of the answer that closed that turn, when the budget has room
// for both.
//
// The topic owns the whole budget when there is no outcome: a session nobody has
// answered yet has nothing else to say, and clipping the question to leave room
// for an empty half would be a worse row.
func digestPreview(topic, outcome string, budget int) string {
	if budget <= 0 {
		return ""
	}
	topic = firstSentence(cleanTopic(topic), budget)
	if topic == "" {
		return ""
	}
	remaining := budget - runeLen(topic) - runeLen(previewSeparator)
	if outcome == "" || remaining < previewMinOutcome {
		return topic
	}
	closing := firstSentence(cleanOutcome(outcome), remaining)
	if closing == "" {
		// An answer that was nothing but a code block leaves no prose to pair
		// with the topic. The topic stands alone rather than growing an arrow
		// with nothing behind it.
		return topic
	}
	return topic + previewSeparator + closing
}

// firstSentence returns the first sentence of text that is not filler, folded to
// one line and capped at limit runes (the cap includes the ellipsis it may add).
//
// Skipping filler sentences is what turns "好的。帮我查一下磁盘占用。" into the
// question rather than the acknowledgement, and "Done. Here's what changed." into
// the change rather than the "Done". When every sentence is filler the opening is
// still returned: a session that only ever said "hi" was still spoken in, and a
// blank row would say it was not.
func firstSentence(text string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(foldSpace(scanPrefix(text)))
	if len(runes) == 0 {
		return ""
	}
	var opening string
	start := 0
	for i := 0; i <= len(runes); i++ {
		end := i == len(runes)
		if !end && !sentenceEnd(runes, i) {
			continue
		}
		stop := i
		if !end {
			stop = i + 1
		}
		sentence := strings.TrimSpace(string(runes[start:stop]))
		start = stop
		if sentence == "" {
			continue
		}
		if opening == "" {
			opening = sentence
		}
		if !isFillerSentence(sentence) {
			return clipRunes(sentence, limit)
		}
	}
	return clipRunes(opening, limit)
}

// cleanTopic keeps the person's own words and drops only the fence markers
// around them. A pasted error or log is often the most informative thing in a
// first message, so its content stays; the ``` lines that wrap it do not.
func cleanTopic(text string) string {
	return foldSpace(stripFenceMarkers(scanPrefix(text)))
}

// cleanOutcome keeps prose only. An answer's opening is often a heading plus a
// code fence ("## 结论 …\n```\n…"), and a digest reading "## 结… ```" is noise
// wearing the summary's clothes. Code is what the answer *produced*; the first
// sentence has to say what it *concluded*.
func cleanOutcome(text string) string {
	return foldSpace(stripLineLeaders(dropFencedBlocks(scanPrefix(text))))
}

// isFenceLine reports whether a line opens or closes a Markdown code fence.
func isFenceLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	return strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~")
}

// stripFenceMarkers removes the fence lines and keeps what they wrap.
func stripFenceMarkers(text string) string {
	lines := strings.Split(text, "\n")
	kept := lines[:0]
	for _, line := range lines {
		if !isFenceLine(line) {
			kept = append(kept, line)
		}
	}
	return strings.Join(kept, "\n")
}

// dropFencedBlocks removes the fence lines **and everything between them**.
// An unclosed fence takes the rest of the text with it: half a code block is
// worse than none, and the closing line is the only thing that could say where
// it really ended.
func dropFencedBlocks(text string) string {
	lines := strings.Split(text, "\n")
	kept := make([]string, 0, len(lines))
	inside := false
	for _, line := range lines {
		if isFenceLine(line) {
			inside = !inside
			continue
		}
		if inside {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

// stripLineLeaders removes the Markdown that decorates a line rather than
// saying anything: headings, quotes, bullets, ordered markers and bold marks.
func stripLineLeaders(text string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = stripLineLeader(line)
	}
	return strings.Join(lines, "\n")
}

// stripLineLeader removes the decoration at the start of one line, repeatedly:
// "> ## 结论" is quoted and headed, and one pass would leave "## 结论".
func stripLineLeader(line string) string {
	line = strings.TrimSpace(line)
	for {
		switch {
		case strings.HasPrefix(line, "#"):
			line = strings.TrimPrefix(strings.TrimLeft(line, "#"), " ")
		case strings.HasPrefix(line, "> "):
			line = strings.TrimPrefix(line, "> ")
		case strings.HasPrefix(line, "- "), strings.HasPrefix(line, "* "), strings.HasPrefix(line, "+ "):
			line = line[2:]
		default:
			rest, marked := trimOrderedMarker(line)
			if !marked {
				return strings.ReplaceAll(line, "**", "")
			}
			line = rest
		}
	}
}

// trimOrderedMarker removes a leading "1. " from one line.
func trimOrderedMarker(line string) (string, bool) {
	i := 0
	for i < len(line) && line[i] >= '0' && line[i] <= '9' {
		i++
	}
	if i == 0 || i+1 >= len(line) || line[i] != '.' || line[i+1] != ' ' {
		return line, false
	}
	return line[i+2:], true
}

// sentenceEnd reports whether the rune at i ends a sentence.
func sentenceEnd(runes []rune, i int) bool {
	switch runes[i] {
	case '。', '！', '？', '；', '!', '?', ';':
		return true
	case '.':
		// A period belongs to a sentence only when it is followed by a space or
		// the end of the text ("1.2 GB" and "v1.5" keep theirs) and closes a word
		// rather than an abbreviation or a list marker.
		if i+1 < len(runes) && runes[i+1] != ' ' {
			return false
		}
		return !abbreviation(runes, i)
	}
	return false
}

// abbreviation reports whether the period at i closes a short token — a list
// marker ("1. ") or an abbreviation ("e.g. ", "i.e. "). Cutting there would
// leave a title that names nothing, so the sentence carries on.
func abbreviation(runes []rune, i int) bool {
	start := i - 1
	for start >= 0 && (unicode.IsLetter(runes[start]) || unicode.IsDigit(runes[start])) {
		start--
	}
	token := runes[start+1 : i]
	return len(token) > 0 && len(token) <= previewShortToken
}

// isFillerSentence reports whether one sentence is a greeting or an
// acknowledgement.
func isFillerSentence(sentence string) bool {
	return previewFiller[sentenceKey(sentence)]
}

// sentenceKey is the comparison form of filler matching: folded, lowercased, and
// stripped of the punctuation a sentence may end with.
func sentenceKey(sentence string) string {
	return strings.Trim(strings.ToLower(foldSpace(sentence)), previewPunctuation)
}

// clipRunes caps text at limit runes, counting the ellipsis it adds inside the
// budget so a clamped preview never exceeds the number its caller promised.
func clipRunes(text string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	if limit == 1 {
		return "…"
	}
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}

// runeLen counts characters for budget arithmetic. The preview is capped in
// runes, not bytes, because a Chinese character must not cost three Latin ones
// out of the row's budget.
func runeLen(text string) int {
	return utf8.RuneCountInString(text)
}

// foldSpace collapses every run of whitespace — newlines included — to one
// space, because the digest is drawn on one line: a newline would break a
// text-mode row and silently become a space in CSS.
func foldSpace(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

// scanPrefix keeps at most SummaryScanChars runes of text.
//
// It walks runes only when it has to: the byte length is an upper bound on the
// rune count, so a short message is returned without a second pass, and a huge
// one is cut at a rune boundary rather than mid-UTF-8.
func scanPrefix(text string) string {
	if len(text) <= SummaryScanChars {
		return text
	}
	count := 0
	for i := range text {
		count++
		if count > SummaryScanChars {
			return text[:i]
		}
	}
	return text
}

// previewNoise reports whether one user message says nothing about the session:
// the runtime's own note, a bare slash command, or a filler sentence.
func previewNoise(message map[string]any, text string) bool {
	if isRuntimeNote(message) {
		return true
	}
	head := foldSpace(scanPrefix(text))
	if head == "" {
		return true
	}
	// A bare command is a verb with no object — "/compact" says what the person
	// did, not what the session is. A slash that starts a sentence ("/usr/bin is
	// broken") has a space in it and stays.
	if strings.HasPrefix(head, "/") && !strings.Contains(head, " ") {
		return true
	}
	return previewFiller[sentenceKey(head)]
}
