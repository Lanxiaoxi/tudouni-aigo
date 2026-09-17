package context

import (
	"fmt"
	"strconv"
	"strings"
)

// Context → LLM messages.
//
// It is the last stop on the chain, and the **only** place that knows what an
// Artifact should look like:
//
//	ContextItem(id, representation, options)
//	    ├── ArtifactStore.Get / Read / Content
//	    ▼
//	a piece of text
//	    ▼
//	a message
//
// Rendering does not live in Manager because state has to be written to disk,
// read by the interface and restored across processes — so it must be plain
// data. "How it is turned into text" is presentation, and changing it should not
// touch the state or the session file format.
//
// The payload shape is **byte-for-byte what it was before this layer existed**.
// The system prompt is still its own role="system" message; tool results are
// still role="tool" carrying the same tool_call_id. That is not conservatism:
// the provider requires tool_calls to be paired with results, and moving the
// system prompt into a user message breaks the prefix cache, which is the only
// part of a long request that reliably hits.
//
// What changed is **where the content comes from**, not the shape. A full-level
// render is exactly the original text, byte for byte — RenderArtifact adds
// nothing at that level.

// metadataLabels is the metadata level's rendering. It is **one line**, so the
// fields have to be chosen sparingly. The order here is the order they appear.
var metadataLabels = []struct{ key, label string }{
	{"tool", "工具"},
	{"path", "路径"},
	{"url", "网址"},
	{"command", "命令"},
	{"pattern", "模式"},
	{"query", "查询"},
	{"lines", "行数"},
	{"chars", "字符"},
	{"status", "状态"},
}

// Rendered is one Artifact opened at one level.
type Rendered struct {
	Text    string
	Snippet *Snippet
	// Missing means the body could not be fetched (somebody deleted it, or the
	// session was restored from an index-only backup). It **has to be said out
	// loud** — an empty tool result reads as "the tool produced no output".
	Missing bool
}

// Renderer turns a context into one request's messages.
type Renderer struct {
	Store   *ArtifactStore
	Manager *Manager
	Preview int
}

// NewRenderer builds a renderer. It is cheap and stateless, so callers build one
// per use rather than caching one and having to handle "the session was
// switched" — the same trap Session ran into.
func NewRenderer(store *ArtifactStore, manager *Manager) *Renderer {
	return &Renderer{Store: store, Manager: manager, Preview: DefaultPreviewLines}
}

// RenderItem renders an item at its current level. **Budget estimation goes
// through here.**
//
// Empty means this item should not appear in the payload (evicted, or the body
// is gone). It tolerates a missing body because estimating does not need text
// invented for it; the payload path does not, and that is RenderToolContent.
func (r *Renderer) RenderItem(item *ContextItem) string {
	if item == nil || item.Removed {
		return ""
	}
	artifact, ok := r.Store.Get(item.ArtifactID)
	if !ok {
		return ""
	}
	rendered := r.RenderArtifact(artifact, item.Representation, item.Options)
	if rendered.Missing {
		return ""
	}
	return rendered.Text
}

// RenderArtifact turns one artifact plus one level into text.
func (r *Renderer) RenderArtifact(artifact Artifact, representation Representation, options map[string]any) Rendered {
	switch representation {
	case RepresentationMetadata:
		return Rendered{Text: r.MetadataLine(artifact)}

	case RepresentationFull:
		text, ok := r.Store.Content(artifact.ID)
		if !ok {
			return Rendered{Text: r.MissingLine(artifact), Missing: true}
		}
		return Rendered{Text: text}

	case RepresentationRange:
		start := intOption(options, "start_line", 1)
		var end *int
		if value := intOption(options, "end_line", 0); value != 0 {
			end = &value
		}
		maxChars := optionalInt(options["max_chars"])
		snippet, ok := r.Store.Read(artifact.ID, &start, end, maxChars)
		if !ok {
			return Rendered{Text: r.MissingLine(artifact), Missing: true}
		}
		return Rendered{Text: rangeText(artifact, snippet), Snippet: &snippet}

	default: // PREVIEW
		lines := intOption(options, "preview_lines", r.Preview)
		if lines < 1 {
			lines = 1
		}
		maxChars := optionalInt(options["max_chars"])
		snippet, ok := r.Store.Preview(artifact.ID, lines, maxChars)
		if !ok {
			return Rendered{Text: r.MissingLine(artifact), Missing: true}
		}
		return Rendered{Text: previewText(artifact, snippet), Snippet: &snippet}
	}
}

// MetadataLine is the metadata level: one line of facts, not a character of
// body.
//
// It is the last level before eviction, so it still has to be useful — from it
// the model learns that something exists, what it is, how big it is, and whether
// reading it again is worth it.
func (r *Renderer) MetadataLine(artifact Artifact) string {
	parts := make([]string, 0, len(metadataLabels))
	for _, entry := range metadataLabels {
		value := metadataValue(artifact, entry.key)
		if value == nil || value == "" {
			continue
		}
		parts = append(parts, entry.label+"="+fmt.Sprint(value))
	}
	return "[artifact " + ShownID(artifact.ID) + "] " + strings.Join(parts, " ")
}

// MissingLine is what the model is told when the body cannot be fetched.
//
// It **cannot be empty**. An empty string reads as "this tool returned nothing",
// which is a wrong conclusion — it sends the model down a needless path to redo
// the work. Saying the content is no longer on disk is what tells it to read
// again.
func (r *Renderer) MissingLine(artifact Artifact) string {
	return fmt.Sprintf("[artifact %s 的内容已经取不到了（原始大小 %d 字符）——需要的话请重新执行一次那个工具]",
		ShownID(artifact.ID), artifact.Chars)
}

// RenderToolContent is the body of one tool message.
//
// Five cases, each with a definite answer:
//
//  1. it references an artifact in the context → render at its level;
//  2. the referenced artifact was evicted by the budget → say so (**not** an
//     empty string, and **not** the original text — the latter means degradation
//     did not take effect);
//  3. the body is gone → MissingLine;
//  4. it references no artifact at all (legacy session, or a plain tool message)
//     → pass through;
//  5. the reference exists but this side has no item for it (should not happen)
//     → pass through the reference as-is. The only case where sending slightly
//     too much beats dropping information.
func (r *Renderer) RenderToolContent(message map[string]any) string {
	artifactID := ArtifactIDOf(message)
	if artifactID == "" {
		content, _ := message["content"].(string)
		return content
	}

	item := r.Manager.Item(artifactID)
	if item == nil {
		content, _ := message["content"].(string)
		return content
	}

	if item.Removed {
		size := 0
		if known, ok := r.Store.Get(artifactID); ok {
			size = known.Chars
		}
		return fmt.Sprintf("[artifact %s 因为上下文预算被移出了本次上下文（原始大小 %d 字符）——需要的话请重新执行一次那个工具]",
			ShownID(artifactID), size)
	}

	stored, ok := r.Store.Get(artifactID)
	if !ok {
		content, _ := message["content"].(string)
		return content
	}

	return r.RenderArtifact(stored, item.Representation, item.Options).Text
}

// Build merges history and context into one request payload.
//
// **The order does not move by one position**: identical to session.Messages,
// with tool messages' content swapped for the version rendered at their level.
// Nothing is reordered for the sake of optimisation — that would invalidate the
// whole prefix cache.
//
// `tail` is the transient message at the end of the payload (session state).
// It never enters history, so the caller assembles it and hands it in.
func (r *Renderer) Build(messages []map[string]any, tail map[string]any) []map[string]any {
	payload := make([]map[string]any, 0, len(messages)+1)
	for _, message := range messages {
		if message["role"] != "tool" {
			payload = append(payload, message)
			continue
		}
		rendered := map[string]any{}
		for key, value := range message {
			rendered[key] = value
		}
		rendered["content"] = r.RenderToolContent(message)
		payload = append(payload, rendered)
	}
	if tail != nil {
		payload = append(payload, tail)
	}
	return payload
}

// --- text shapes ------------------------------------------------------------

// rangeText is the range level's body: a header plus the lines.
func rangeText(artifact Artifact, snippet Snippet) string {
	total := snippet.TotalLines
	if total == 0 {
		total = asInt(artifact.Metadata["lines"])
	}
	head := fmt.Sprintf("[artifact %s：%s第 %d-%d 行",
		ShownID(artifact.ID), whereOf(artifact), snippet.StartLine, snippet.EndLine)
	if total > 0 {
		head += fmt.Sprintf("（共 %d 行）", total)
	}
	head += "]"
	if snippet.Text == "" {
		return head + "\n（这个区间没有内容）"
	}
	return head + "\n" + snippet.Text
}

// previewText is the preview level's body: the opening lines plus a note that
// there is more.
func previewText(artifact Artifact, snippet Snippet) string {
	total := snippet.TotalLines
	if total == 0 {
		total = asInt(artifact.Metadata["lines"])
	}
	head := fmt.Sprintf("[artifact %s：%s开头 %d 行",
		ShownID(artifact.ID), whereOf(artifact), snippet.EndLine)
	if total > 0 {
		head += fmt.Sprintf("（共 %d 行）", total)
	}
	head += "]"
	if snippet.Text == "" {
		return head + "\n（没有内容）"
	}
	return head + "\n" + snippet.Text
}

// whereOf is the header's "this is what" clause.
//
// Path comes first (it is the most recognisable field) and is written only when
// there really is one — a permanently blank `路径=` makes a reader conclude the
// artifact genuinely had no path.
func whereOf(artifact Artifact) string {
	for _, entry := range []struct{ key, label string }{
		{"path", ""}, {"url", ""}, {"command", "命令 "},
		{"pattern", "模式 "}, {"query", "查询 "},
	} {
		if value, present := artifact.Metadata[entry.key]; present && value != nil && value != "" {
			return entry.label + fmt.Sprint(value) + "，"
		}
	}
	if artifact.Source.Path != "" {
		return artifact.Source.Path + "，"
	}
	return ""
}

func metadataValue(artifact Artifact, key string) any {
	switch key {
	case "id":
		return artifact.ID
	case "chars":
		return artifact.Chars
	case "type":
		return artifact.Type
	}
	if value, present := artifact.Metadata[key]; present && value != nil && value != "" {
		return value
	}
	switch key {
	case "tool":
		return artifact.Source.Tool
	case "path":
		return artifact.Source.Path
	case "url":
		return artifact.Source.URL
	}
	return nil
}

// optionalInt converts a value that may be absent or wrong.
//
// A bad value means "no cap", not zero: `max_chars=0` would render an artifact
// as empty text, which in a payload is indistinguishable from "this tool
// returned nothing" — the exact failure this layer exists to avoid.
func optionalInt(value any) *int {
	if value == nil {
		return nil
	}
	var number int
	switch typed := value.(type) {
	case int:
		number = typed
	case int64:
		number = int(typed)
	case float64:
		number = int(typed)
	case string:
		parsed, err := strconv.Atoi(typed)
		if err != nil {
			return nil
		}
		number = parsed
	default:
		return nil
	}
	if number <= 0 {
		return nil
	}
	return &number
}
