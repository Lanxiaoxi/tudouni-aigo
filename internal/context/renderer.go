package context

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/content"
)

// Context → LLM messages.
//
// It is the last stop on the chain, and the **only** place that knows what an
// Artifact should look like:
//
//	ContextItem(id, representation, options)
//	    ├── ArtifactStore.Get / Read / Bytes
//	    ▼
//	a piece of content: text, and/or a picture
//	    ▼
//	a message
//
// Rendering does not live in Manager because state has to be written to disk,
// read by the interface and restored across processes — so it must be plain
// data. "How it is turned into content" is presentation, and changing it should
// not touch the state or the session file format.
//
// **Text payloads are byte-for-byte what they were before pictures existed.** The
// system prompt is still its own role="system" message; tool results are still
// role="tool" carrying the same tool_call_id; a full-level text render adds
// nothing. That is not conservatism: the provider requires tool_calls to be paired
// with results, and the prefix cache is only warm while the bytes are unchanged.
//
// A message gains a content array **only when it actually carries a picture**, and
// that decision is made on the stored message rather than on the rendered one, so
// a message's shape cannot flap back and forth as the picture degrades. See
// RenderMessage.

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
//
// It is text **or** parts, and for a text artifact the two are the same thing:
// `Parts` is empty and `Text` is the body, exactly as before. A picture has no
// text body at all, so it renders as `Parts` and `Text` stays empty — which is why
// every caller that sums tokens has to look at both fields rather than at Text
// alone.
type Rendered struct {
	Text    string
	Snippet *Snippet
	// Parts is the content form, set when this artifact is (or has degraded to) a
	// picture. Empty for a text artifact.
	Parts content.Content
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
	// AllowImages reports whether pictures may be sent, and why not when they may
	// not. Nil means yes.
	//
	// It is consulted on **every** render, not once when a picture is attached,
	// because the model can be switched mid-session: a picture attached while a
	// vision model was in use must not be sent to the model afterwards. And the
	// answer has to be "describe it" rather than "fail the turn", because the
	// picture is in the session file — a render-time refusal would make every later
	// turn of that session fail the same way, which is the permanent-bricking
	// failure shape this codebase refuses everywhere else.
	AllowImages func() (bool, string)
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
// Empty means this item should not appear in the payload (evicted, or the body is
// gone). It tolerates a missing body because estimating does not need content
// invented for it; the payload path does not, and that is RenderToolContent.
func (r *Renderer) RenderItem(item *ContextItem) Rendered {
	if item == nil || item.Removed {
		return Rendered{}
	}
	artifact, ok := r.Store.Get(item.ArtifactID)
	if !ok {
		return Rendered{}
	}
	rendered := r.RenderArtifact(artifact, item.Representation, item.Options)
	if rendered.Missing {
		return Rendered{}
	}
	return rendered
}

// RenderArtifact turns one artifact plus one level into content.
func (r *Renderer) RenderArtifact(artifact Artifact, representation Representation, options map[string]any) Rendered {
	// Pictures have their own ladder, and it is a different ladder: nothing is
	// truncated, and there is no line count to narrow. See Representation.NextLevel.
	if artifact.IsImage() {
		return r.renderImage(artifact, representation)
	}

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

	default: // PREVIEW, and any rung a picture could not have left behind
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

// renderImage renders a picture at one level.
//
// The two levels that send a picture and the one that describes it:
//
//	full       the file as it was read
//	thumbnail  a smaller copy, when one exists
//	metadata   a sentence: what it is, how big
//
// A picture **never renders as text by accident**: when there is nothing to send
// (the body is gone) the answer is a sentence saying so, never an empty render,
// because an empty render is indistinguishable from "the tool produced nothing".
func (r *Renderer) renderImage(artifact Artifact, representation Representation) Rendered {
	switch representation {
	case RepresentationFull:
		if !r.Store.Exists(artifact.ID) {
			return Rendered{Text: r.MissingImageLine(artifact), Missing: true}
		}
		return r.sendableImage(artifact, imageReference(artifact, content.VariantOriginal))

	case RepresentationThumbnail:
		thumbnailID := artifact.MetadataString(MetaThumbnailID)
		if thumbnailID == "" {
			// No smaller copy exists, so there is nowhere to degrade to except
			// metadata. Saying the facts is better than sending the original at a
			// level that claims it is smaller.
			return Rendered{Text: r.MetadataLine(artifact)}
		}
		// The **thumbnail's own artifact** is looked up, and this is the point of the
		// level: the bytes have to come from the smaller body, or the rung would move
		// while the request stayed the same size. Building the reference from the
		// original — which is what this did first, and what its own test caught — sends
		// the whole picture at a level that says "smaller", and the ladder then has a
		// step that neither shrinks anything nor is visible as broken.
		smaller, known := r.Store.Get(thumbnailID)
		if !known || !r.Store.Exists(thumbnailID) {
			return Rendered{Text: r.MetadataLine(artifact)}
		}
		reference := imageReference(smaller, content.VariantThumbnail)
		// The **name is the picture's**, not the smaller copy's: the two bodies are
		// one picture at two sizes, and the label is what a person recognises it by.
		// The thumbnail's own metadata holds no name for the same reason.
		reference.Name = artifact.MetadataString(MetaName)
		return r.sendableImage(artifact, reference)

	default: // METADATA
		return Rendered{Text: r.MetadataLine(artifact)}
	}
}

// sendableImage is the gate between "there is a picture to send" and "a picture
// goes out".
//
// When the model in use cannot be shown pictures, the answer is a **sentence
// naming the picture**, never an empty body and never a failed render. The
// difference matters more here than anywhere else in this file:
//
//   - dropping it silently is the one failure that cannot be detected afterwards —
//     the model reads "look at this screenshot" with nothing attached and answers
//     from the surrounding prose, confidently, and nobody can tell that answer from
//     a real one;
//   - failing the render would brick the session. The picture is in the session
//     file, so every later turn would fail the same way, which is the shape of
//     failure this codebase refuses everywhere (see onTheWireMessage's note on
//     `artifact_id`). Switching the session back to a vision model has to fix it,
//     and only a render that still succeeds can be fixed by a later switch.
//
// So the sentence goes out, it names the file, and it says what to do about it —
// the model can then tell the user rather than guess.
func (r *Renderer) sendableImage(artifact Artifact, reference content.ImageRef) Rendered {
	if allowed, reason := r.imagesAllowed(); !allowed {
		return Rendered{Text: imageNotSendableLine(reference, reason)}
	}
	return Rendered{Parts: imageBody(reference)}
}

// imagesAllowed asks the injected policy. A nil policy means yes: a renderer built
// without one is a test or a tool that has no catalogue behind it, and suppressing
// pictures there would silently change what those callers send.
func (r *Renderer) imagesAllowed() (bool, string) {
	if r.AllowImages == nil {
		return true, ""
	}
	return r.AllowImages()
}

// imageNotSendableLine is what the model is told instead of a picture it cannot be
// shown.
//
// It is the same `[Image: …]` label the picture would have carried, extended with
// the reason — so a model that reads it knows a picture was here, what it was
// called, and that the way to see it is a different model rather than a different
// question. The label's shape is reused rather than invented so that the metadata
// level, the attach notice and this line all read the same way.
func imageNotSendableLine(reference content.ImageRef, reason string) string {
	if reason == "" {
		reason = "the model in use cannot be shown pictures"
	}
	return content.ImageLabel(reference) + " — " + reason
}

// imageBody is what one picture looks like inside a request.
//
// It opens with a one-line label, and that is not decoration: with two pictures in
// one message, the model has to be able to say **which** one it is talking about,
// and a bare image block carries no name. The label is about ten tokens; a wrong
// answer about "the first screenshot" is not.
func imageBody(reference content.ImageRef) content.Content {
	return content.Content{}.WithText(content.ImageLabel(reference)).WithImage(reference)
}

// MetadataLine is the metadata level: one line of facts, not a character of body.
//
// It is the last level before eviction, so it still has to be useful — from it the
// model learns that something exists, what it is, how big it is, and whether
// reading it again is worth it.
func (r *Renderer) MetadataLine(artifact Artifact) string {
	if artifact.IsImage() {
		return r.imageMetadataLine(artifact)
	}
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

// imageMetadataLine is the metadata level for a picture.
//
// Its shape is the same `[artifact …]` line every other level produces, so a
// reader (and the model) meets one convention: an id, then facts. What differs is
// which facts — a picture has no line count, and its size is bytes rather than
// characters.
func (r *Renderer) imageMetadataLine(artifact Artifact) string {
	var parts []string
	if name := artifact.MetadataString(MetaName); name != "" {
		parts = append(parts, name)
	}
	if width, height := artifactDimensions(artifact); width > 0 && height > 0 {
		parts = append(parts, fmt.Sprintf("%d×%d", width, height))
	}
	if size := sizeText(artifact.Size()); size != "" {
		parts = append(parts, size)
	}
	if mime := artifact.MetadataString(MetaMIME); mime != "" {
		parts = append(parts, mime)
	}
	if artifact.Source.Path != "" {
		parts = append(parts, "路径="+artifact.Source.Path)
	}
	return "[artifact " + ShownID(artifact.ID) + "] 图片 " + strings.Join(parts, " ")
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

// MissingImageLine is the same statement for a picture, whose size is not counted
// in characters.
func (r *Renderer) MissingImageLine(artifact Artifact) string {
	return fmt.Sprintf("[artifact %s 的图片已经取不到了（原始大小 %s）——需要的话请让用户重新发一次]",
		ShownID(artifact.ID), orUnknownSize(artifact.Size()))
}

func orUnknownSize(bytes int) string {
	if size := sizeText(bytes); size != "" {
		return size
	}
	return "未知"
}

// RemovedImageLine is what a picture renders as once the budget has evicted it.
//
// It has to name the picture and say why, for the same reason the missing case
// does: "there was a screenshot here and it is no longer in this request" is a
// fact the model can act on (it can ask for it again), while an empty render makes
// it believe there never was one.
func (r *Renderer) RemovedImageLine(artifact Artifact) string {
	name := artifact.MetadataString(MetaName)
	if name == "" {
		name = "图片"
	}
	return fmt.Sprintf("[artifact %s 的图片「%s」因为上下文预算被移出了本次上下文（原始大小 %s）——需要的话请让用户重新发一次]",
		ShownID(artifact.ID), name, orUnknownSize(artifact.Size()))
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
//  5. the reference exists but this side has no item for it (the ledger did not
//     restore) → the body straight from the store, at the preview level. There is
//     no decided level to look up, and the alternative is not "slightly too much"
//     but "nothing at all": `message["content"]` in this shape *is* the reference
//     line, so passing it through sends a pointer the model cannot follow.
func (r *Renderer) RenderToolContent(message map[string]any) any {
	artifactID := ArtifactIDOf(message)
	if artifactID == "" {
		// A tool message that carries no reference is a plain body. It is returned
		// **as it stands** — a string, or an array if something upstream put parts
		// in it — because re-encoding a body that this layer never interpreted is
		// how a payload changes shape for no reason.
		return message["content"]
	}

	item := r.Manager.Item(artifactID)
	if item == nil {
		// The context ledger has no entry for this reference, so no level was ever
		// decided for it: the state block did not decode, or was written by a
		// version that lost it. Sending `message["content"]` here — which in this
		// shape **is** the reference line, `[artifact art_… · 12480 字符 · read_file]`
		// — would hand the model a pointer it cannot follow, and that body would
		// then be invisible for the rest of the session.
		//
		// So the body comes from the store instead, at the preview level: the
		// content is real, and the line count bounds it, because there is no budget
		// decision left here to bound it any other way. When the store has nothing
		// either, the reference line itself is all that is left — it still names the
		// size and the tool, which is more than an empty string.
		stored, ok := r.Store.Get(artifactID)
		if !ok {
			return message["content"]
		}
		return renderToWire(r.RenderArtifact(stored, RepresentationPreview, nil))
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
		return message["content"]
	}

	return renderToWire(r.RenderArtifact(stored, item.Representation, item.Options))
}

// RenderMessage is one history message as this request will send it.
//
// Two rules, and both matter for the prefix cache:
//
//   - **a message that carries no picture is returned untouched.** Not copied, not
//     normalised, not re-encoded. A session that never saw an image therefore
//     sends byte-for-byte what it sent before this feature existed, which is what
//     keeps the cache warm for every conversation that does not use it;
//   - **a message that carries one always sends an array**, even after the picture
//     has degraded to a sentence, because the decision is made on the **stored**
//     content rather than on the rendered one. Deciding on the rendered form would
//     flip the message between a string and an array as the picture walked its
//     ladder, and each flip invalidates the cache for every token after it.
func (r *Renderer) RenderMessage(message map[string]any) map[string]any {
	if message == nil {
		return nil
	}
	if message["role"] == "tool" {
		rendered := copyMessage(message)
		rendered["content"] = r.RenderToolContent(message)
		return rendered
	}
	if !content.MessageHasImage(message) {
		return message
	}
	rendered := copyMessage(message)
	rendered["content"] = r.RenderMessageContent(message).ToParts()
	return rendered
}

// RenderMessageContent expands the picture parts of one body.
//
// Text passes through as it stands; a picture is looked up in the ledger and
// re-pointed at the level it is currently sitting at — the original, the
// thumbnail, or (once it has bottomed out) a sentence saying it was here. This is
// the whole of "the image is in the context": the message holds a pointer, and the
// level decides what the pointer is worth this round.
func (r *Renderer) RenderMessageContent(message map[string]any) content.Content {
	parts := content.Parse(message["content"])
	out := make(content.Content, 0, len(parts))
	for _, part := range parts {
		if part.Kind != content.KindImage || part.Image == nil {
			out = append(out, part)
			continue
		}
		out = append(out, r.renderImagePart(part.Image.ArtifactID)...)
	}
	return out
}

// renderImagePart turns one referenced picture into the parts to send.
//
// The ledger decides, and when it says nothing the body is still real: a message
// whose item was lost (a state block that did not decode) sends the picture rather
// than a sentence about a picture nobody can see.
func (r *Renderer) renderImagePart(artifactID string) content.Content {
	artifact, known := r.Store.Get(artifactID)
	if !known {
		// The body is gone as well. This is the one case where the reference is all
		// there is, and saying so is the only useful answer.
		return content.Text(fmt.Sprintf("[图片 %s 已经取不到了]", ShownID(artifactID)))
	}
	item := r.Manager.Item(artifactID)
	if item == nil {
		return renderToContent(r.RenderArtifact(artifact, RepresentationFull, nil), artifact)
	}
	if item.Removed {
		return content.Text(r.RemovedImageLine(artifact))
	}
	return renderToContent(r.RenderArtifact(artifact, item.Representation, item.Options), artifact)
}

// renderToContent renders to a content body, with the artifact available for the
// "the body is gone" sentence.
func renderToContent(rendered Rendered, artifact Artifact) content.Content {
	if len(rendered.Parts) > 0 {
		return rendered.Parts
	}
	if rendered.Text == "" {
		return nil
	}
	return content.Text(rendered.Text)
}

// renderToWire renders to what a message's `content` field should hold: a string
// when there is only text, parts when there is a picture.
func renderToWire(rendered Rendered) any {
	if len(rendered.Parts) > 0 {
		return rendered.Parts.ToParts()
	}
	return rendered.Text
}

// Build merges history and context into one request payload.
//
// **The order does not move by one position**: identical to session.Messages,
// with each message's content swapped for the version rendered at its level.
// Nothing is reordered for the sake of optimisation — that would invalidate the
// whole prefix cache.
//
// `tail` is the transient message at the end of the payload (session state).
// It never enters history, so the caller assembles it and hands it in.
func (r *Renderer) Build(messages []map[string]any, tail map[string]any) []map[string]any {
	payload := make([]map[string]any, 0, len(messages)+1)
	for _, message := range messages {
		payload = append(payload, r.RenderMessage(message))
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

// copyMessage makes a shallow copy, which is all a rendered message needs: every
// value in a message is either a string (immutable) or a slice the caller owns,
// and swapping `content` is the only write.
func copyMessage(message map[string]any) map[string]any {
	copied := make(map[string]any, len(message)+1)
	for key, value := range message {
		copied[key] = value
	}
	return copied
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
