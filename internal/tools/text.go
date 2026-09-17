package tools

import "strings"

// Truncate shortens text while keeping both ends.
//
// Both ends matter because output usually says something at the start (what ran)
// and something at the end (how it went). Keeping only the head loses the result;
// keeping only the tail loses what was being talked about.
//
// Two thirds go to the head and one third to the tail, and the middle is marked
// with how much was dropped — a silent cut would let the model believe it saw
// everything.
func Truncate(text string, limit int) string {
	runes := []rune(text)
	if limit <= 0 || len(runes) <= limit {
		return text
	}
	head := limit * 2 / 3
	tail := limit - head
	omitted := len(runes) - limit
	return string(runes[:head]) +
		"\n…[中间省略 " + itoa(omitted) + " 字符]…\n" +
		string(runes[len(runes)-tail:])
}

// CountsChars is what the audit records: how big the result was, without keeping
// the result itself.
func CountsChars(text string) int { return len([]rune(text)) }

// FirstLine returns the first line of a string, for one-line previews.
func FirstLine(text string) string {
	if index := strings.IndexByte(text, '\n'); index >= 0 {
		return text[:index]
	}
	return text
}

// JoinNonEmpty joins the parts that have something in them.
func JoinNonEmpty(separator string, parts ...string) string {
	var kept []string
	for _, part := range parts {
		if strings.TrimSpace(part) != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, separator)
}
