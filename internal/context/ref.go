package context

import (
	"regexp"
	"strconv"
	"strings"
)

// The reference line that stands in for a tool result in history.
//
// The body of a tool result is no longer in `session.messages` — what is there
// is one line pointing at an Artifact. This file is **the only definition of
// that format**: whoever builds one and whoever recognises one both come here.
//
// Why the body is not in history: `session.messages` is history ("what
// happened"), not context ("what the model should see now"). The two used to be
// the same thing, and the bill for that was paid in tokens — one `read_file` of
// 120k characters was re-sent every round afterwards, long after the model had
// finished reading it.
//
//	History   one read_file is one reference       never grows with the body
//	Context   the part the model sees this round   decided by representation
//
// What it looks like:
//
//	[artifact art_9f2c1a4b7e30 · 12480 字符 · read_file]
//
// It is self-explanatory on purpose: a person reading `--history` understands it,
// and a model that happens to see only this line (because the item degraded to
// metadata) still knows something was here and how big it was. The half-sentence
// explaining how to fetch it back is **not** written for the model: the model
// always sees rendered content, and an explanation of internal machinery is
// pure token cost.

// Mark is the only marker recognised. Loose matching — "the text mentions art_
// somewhere" — would make a file that discusses artifacts look like a reference,
// and that file cannot be fetched.
const Mark = "[artifact"

// MaxShownID is how much of an id appears in human-facing text. Content-addressed
// ids are `art_` plus 12 hex characters, but hydrated legacy sessions can carry
// anything. A 200-character id in a header is not just ugly — it is re-sent
// every round.
const MaxShownID = 24

// referencePattern matches the whole reference. All three parts after the id may
// be missing: hand-written history, older versions, and future additions all
// have to parse as long as the id is recognisable.
var referencePattern = regexp.MustCompile(
	`\[artifact\s+(art_[A-Za-z0-9_-]+)(?:\s*·\s*([^\]]*))?\]`)

// ShownID is the display form of an id. Display only; identity is unchanged.
func ShownID(artifactID string) string {
	if len(artifactID) <= MaxShownID {
		return artifactID
	}
	// Truncation is by runes so a multi-byte id is not cut mid-character.
	runes := []rune(artifactID)
	if len(runes) <= MaxShownID {
		return artifactID
	}
	return string(runes[:MaxShownID]) + "…"
}

// BuildReference produces the reference line.
func BuildReference(artifactID string, chars int, tool string) string {
	parts := []string{strconv.Itoa(chars) + " 字符"}
	if tool != "" {
		parts = append(parts, tool)
	}
	return Mark + " " + ShownID(artifactID) + " · " + strings.Join(parts, " · ") + "]"
}

// ParseReference pulls an artifact id out of a piece of text.
//
// It never guesses: no marker, or a marker with no valid id, is the empty
// answer. A caller that gets one should treat the text as content — that is a
// legacy session, or a message that never went through the artifact store —
// rather than raise.
func ParseReference(text string) string {
	if !strings.Contains(text, Mark) {
		return ""
	}
	match := referencePattern.FindStringSubmatch(text)
	if match == nil {
		return ""
	}
	return match[1]
}

// ArtifactIDOf reports which Artifact a message points at.
//
// The explicit field is checked first and the body parsed second. Both paths are
// needed: newly written messages carry the field, and messages in older session
// files only have the text. An empty answer means "this message references no
// Artifact".
func ArtifactIDOf(message map[string]any) string {
	if message == nil {
		return ""
	}
	if explicit, ok := message["artifact_id"].(string); ok && explicit != "" {
		return explicit
	}
	content, _ := message["content"].(string)
	return ParseReference(content)
}

// IsReference reports whether a tool message is a reference rather than a body.
func IsReference(message map[string]any) bool {
	return ArtifactIDOf(message) != ""
}
