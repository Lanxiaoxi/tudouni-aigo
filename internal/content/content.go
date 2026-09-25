// Package content is what a message body is made of.
//
// It exists because a body stopped being a string the moment an image could be in
// it, and the shape of that change has to live in exactly one place:
//
//	Message
//	  └── Content[]
//	        ├── TextPart
//	        └── ImagePart  → an artifact id
//	              ▼
//	        Provider Adapter
//	              ▼
//	        image_url / type=image / input_image
//
// The rule this package exists to enforce:
//
//	**the runtime never understands a provider's image format. It understands
//	ImagePart, and the adapter decides how to put it on the wire.**
//
// An ImagePart carries a **pointer**, never bytes. The bytes are in the artifact
// store, and they are base64-encoded once, at the last step, by the dialect that
// needs base64. Writing base64 into the session file would make every later turn
// of that session carry the same picture again — the JSONL bloat and repeated
// upload this design was measured against — and it would also make token
// estimation count a megabyte of text that is not text.
//
// The JSON shape is deliberately the one the providers already use for *text*
// blocks (`{"type": "text", "text": …}`), because two other parts of the program
// read that shape without knowing this package exists (state.MessageText and the
// TUI's transcript replay). The image block is **not** a provider shape on
// purpose: it names an artifact id, which no endpoint has ever heard of, and
// each dialect translates it.
package content

import (
	"strconv"
	"strings"
)

// Kind names a part's type. It is a string rather than an enum so the session
// file stays readable and a future kind (audio, file) needs no migration.
type Kind string

const (
	// KindText is a run of text.
	KindText Kind = "text"
	// KindImage is a picture: a pointer into the artifact store, plus the facts
	// a provider needs to be told (mime, dimensions).
	KindImage Kind = "image"
)

// Variant is which body of an image is being pointed at.
//
// It is a field rather than two different part kinds because "the same picture,
// cheaper" is what degradation does to an image, and a second kind would make
// every switch statement handle two cases that mean the same thing.
type Variant string

const (
	// VariantOriginal is the file as it was read.
	VariantOriginal Variant = "original"
	// VariantThumbnail is a downscaled copy: the first rung of an image's
	// degradation ladder, and the reason a picture can be shrunk instead of
	// dropped.
	VariantThumbnail Variant = "thumbnail"
)

// ImageRef is one picture as the context knows it: where the bytes are, and the
// facts about it that are not the bytes.
//
// Width and Height are allowed to be zero, and zero means **unknown** rather
// than "no size". Not every format can be measured without a decoder (a webp on
// a build with no webp decoder is the case that actually happens), and a made-up
// dimension would be a made-up token estimate on top of it.
type ImageRef struct {
	// ArtifactID is the body to send. At thumbnail level this is the thumbnail's
	// own artifact id — content-addressed like any other body, so "which bytes
	// are these" needs no extra field to answer.
	ArtifactID string
	// Name is for a person: the file's base name, or nothing when the picture did
	// not come from a file.
	Name string
	MIME string
	// Bytes is the body's size, kept here so the metadata level and the token
	// estimate do not have to read it.
	Bytes   int
	Width   int
	Height  int
	Variant Variant
}

// What this program accepts as one picture.
//
// They live here, beside the part types, because **two layers need the same
// answer** and neither may own it alone: a tool that reads a picture has to refuse
// an oversized file *before* reading it into memory, and the artifact layer has to
// refuse it again on the way in. A ceiling declared in either one would leave the
// other free to disagree, and the symptom of two answers is a file that passes one
// door and is refused by the next — which reads as a bug in whichever door the
// person happened to look at.
const (
	// MaxImageBytes is how large a picture file may be before it is refused.
	//
	// Five megabytes is the smallest published request-side limit of the three
	// protocols this program speaks (the Messages shape's per-image cap, in its
	// base64 form, which is a third larger than the file). Refusing here rather
	// than letting the endpoint refuse is the difference between a sentence the
	// user can act on and a 400 from a gateway.
	MaxImageBytes = 5 * 1024 * 1024

	// MaxImagePixels caps the decoded area.
	//
	// It is a **decompression-bomb guard**, not a quality judgement: a 20000×20000
	// PNG is a few hundred kilobytes on disk and 1.6GB in memory once decoded, and
	// this program decodes every image it accepts in order to measure it. Refusing
	// the file costs a message; decoding it costs the process.
	MaxImagePixels = 40_000_000
)

// Part is one piece of a body: exactly one of Text or Image is set.
//
// Two fields rather than an interface, because a Part is written to the session
// file and read back as generic JSON — and an interface round-tripping through
// `map[string]any` is a type assertion per field with a silent zero value on the
// day somebody renames one.
type Part struct {
	Kind  Kind
	Text  string
	Image *ImageRef
}

// Content is a body: an ordered list of parts.
type Content []Part

// Text builds a single-text-part body.
func Text(text string) Content {
	return Content{{Kind: KindText, Text: text}}
}

// Paragraph builds a text body from two pieces, separated when both are there.
//
// The separator is a blank line rather than a newline: the two callers are "a
// heading and its body" and "what the user typed, plus a note about the pictures
// in it", and in both a paragraph break is what a reader expects.
func Paragraph(first, second string) Content {
	switch {
	case first == "":
		return Text(second)
	case second == "":
		return Text(first)
	default:
		return Text(first + "\n\n" + second)
	}
}

// FromText builds a body from a maybe-empty string. Empty gives no parts at all,
// which is different from a text part holding "" — an empty part is a message
// that says nothing, and a provider reads it as a real (empty) utterance.
func FromText(text string) Content {
	if text == "" {
		return nil
	}
	return Text(text)
}

// IsEmpty reports whether there is nothing to send.
func (c Content) IsEmpty() bool {
	for _, part := range c {
		if part.Kind == KindImage && part.Image != nil {
			return false
		}
		if part.Kind == KindText && part.Text != "" {
			return false
		}
	}
	return true
}

// HasImage reports whether any part is a picture. It is the single test behind
// "does this request need a vision-capable model", and having one function for
// it is what keeps three call sites from disagreeing.
func (c Content) HasImage() bool {
	for _, part := range c {
		if part.Kind == KindImage && part.Image != nil && part.Image.ArtifactID != "" {
			return true
		}
	}
	return false
}

// TextOf joins the text parts. Parts of other kinds contribute nothing.
//
// No separator between parts beyond what the parts themselves carry: the callers
// that join a body out of several parts are asking for "the text of this
// message", and inventing a newline between two halves of one sentence would be
// visible to the model as a paragraph break nobody wrote.
func (c Content) TextOf() string {
	if len(c) == 1 && c[0].Kind == KindText {
		return c[0].Text
	}
	var builder strings.Builder
	for _, part := range c {
		if part.Kind == KindText {
			builder.WriteString(part.Text)
		}
	}
	return builder.String()
}

// Images lists the picture parts.
func (c Content) Images() []ImageRef {
	var out []ImageRef
	for _, part := range c {
		if part.Kind == KindImage && part.Image != nil {
			out = append(out, *part.Image)
		}
	}
	return out
}

// WithText appends a text part when there is anything to append.
func (c Content) WithText(text string) Content {
	if text == "" {
		return c
	}
	return append(c, Part{Kind: KindText, Text: text})
}

// WithImage appends a picture part.
func (c Content) WithImage(image ImageRef) Content {
	reference := image
	return append(c, Part{Kind: KindImage, Image: &reference})
}

// OnlyText reports whether this body could have been a string, which is what
// "leave the message exactly as it was" is decided on (see ToWire).
func (c Content) OnlyText() bool {
	for _, part := range c {
		if part.Kind != KindText {
			return false
		}
	}
	return true
}

// ToWire renders the body in the shape a message carries.
//
// A body that is only text comes back as a **plain string**, and that is not a
// convenience: the payload of a session that never saw a picture has to stay
// byte-for-byte what it was before this package existed, or every request in it
// changes shape and the provider's prefix cache goes cold — measured at roughly
// fifty times the price per token for everything after the first changed byte.
func (c Content) ToWire() any {
	if c.OnlyText() {
		return c.TextOf()
	}
	return c.ToParts()
}

// ToParts renders the body as the array of part objects the session file keeps.
func (c Content) ToParts() []any {
	parts := make([]any, 0, len(c))
	for _, part := range c {
		switch part.Kind {
		case KindImage:
			if part.Image == nil || part.Image.ArtifactID == "" {
				continue
			}
			parts = append(parts, part.Image.toJSON())
		case KindText:
			if part.Text == "" {
				continue
			}
			parts = append(parts, map[string]any{"type": string(KindText), "text": part.Text})
		}
	}
	return parts
}

func (image ImageRef) toJSON() map[string]any {
	block := map[string]any{
		"type":        string(KindImage),
		"artifact_id": image.ArtifactID,
	}
	// Only the facts that are known are written. A `"width": 0` in the session
	// file would read as a measured zero, and the estimate would believe it.
	for key, value := range map[string]string{
		"name": image.Name, "mime": image.MIME, "variant": string(image.Variant),
	} {
		if value != "" {
			block[key] = value
		}
	}
	for key, value := range map[string]int{
		"bytes": image.Bytes, "width": image.Width, "height": image.Height,
	} {
		if value != 0 {
			block[key] = value
		}
	}
	return block
}

// Parse reads a body out of what a message carries: a string (everything written
// before pictures existed), an array of parts, or nothing at all.
//
// It never fails. A body it does not recognise yields what could be read of it,
// because this runs on the path of every request: a session file with one odd
// block in it must not become a session that cannot be opened.
func Parse(raw any) Content {
	switch typed := raw.(type) {
	case nil:
		return nil
	case string:
		return FromText(typed)
	case Content:
		return typed
	case []any:
		parts := make(Content, 0, len(typed))
		for _, entry := range typed {
			if part, ok := parsePart(entry); ok {
				parts = append(parts, part)
			}
		}
		return parts
	default:
		return nil
	}
}

func parsePart(raw any) (Part, bool) {
	object, ok := raw.(map[string]any)
	if !ok {
		return Part{}, false
	}
	switch Kind(textOf(object["type"])) {
	case KindImage:
		reference := imageFromJSON(object)
		if reference.ArtifactID == "" {
			return Part{}, false
		}
		return Part{Kind: KindImage, Image: &reference}, true
	default:
		// An unknown type is read as text when it has any, and dropped when it
		// does not. The alternative — refusing the whole body — would make one
		// unrecognised block hide every other part of the same message.
		text := textOf(object["text"])
		if text == "" {
			return Part{}, false
		}
		return Part{Kind: KindText, Text: text}, true
	}
}

func imageFromJSON(object map[string]any) ImageRef {
	return ImageRef{
		ArtifactID: textOf(object["artifact_id"]),
		Name:       textOf(object["name"]),
		MIME:       textOf(object["mime"]),
		Bytes:      intOf(object["bytes"]),
		Width:      intOf(object["width"]),
		Height:     intOf(object["height"]),
		Variant:    Variant(textOf(object["variant"])),
	}
}

// TextOf extracts the text of whatever a message's content field holds.
//
// It is the replacement for `message["content"].(string)`, and every one of those
// assertions is a bug once a body can be an array: the assertion yields "" for an
// array, so an image (or a paragraph next to one) silently counts as zero tokens
// and the budget believes a request fits when it does not.
func TextOf(raw any) string { return Parse(raw).TextOf() }

// ImagesOf extracts the picture parts of a body.
func ImagesOf(raw any) []ImageRef { return Parse(raw).Images() }

// HasImage reports whether a body holds a picture.
func HasImage(raw any) bool { return Parse(raw).HasImage() }

// MessageHasImage reports whether one message's body holds a picture.
func MessageHasImage(message map[string]any) bool {
	if message == nil {
		return false
	}
	return HasImage(message["content"])
}

// MessagesHaveImage reports whether any message in a list holds a picture.
func MessagesHaveImage(messages []map[string]any) bool {
	for _, message := range messages {
		if MessageHasImage(message) {
			return true
		}
	}
	return false
}

// Describe renders a body as one line of text, for the places that have to show a
// body to somebody who cannot see the pictures in it (the session preview, the
// compaction skeleton, a transcript replayed in a terminal).
//
// The picture is named rather than omitted, and that is the whole point: a body
// that quietly loses its image reads as a message that never had one.
func Describe(raw any) string {
	parts := Parse(raw)
	if !parts.HasImage() {
		return parts.TextOf()
	}
	var pieces []string
	if text := strings.TrimSpace(parts.TextOf()); text != "" {
		pieces = append(pieces, text)
	}
	for _, image := range parts.Images() {
		pieces = append(pieces, ImageLabel(image))
	}
	return strings.Join(pieces, "\n")
}

// ImageLabel is how one picture is named in text.
//
// `[Image: screenshot.png 1280×720]` — the name first because that is what a
// person recognises, then the facts that are not recoverable from the name. It is
// also what a non-vision model is shown in place of the picture, which is why it
// states the mime type and the size: "there was a picture here, this big" is more
// useful than nothing.
func ImageLabel(image ImageRef) string {
	name := image.Name
	if name == "" {
		name = image.MIME
	}
	if name == "" {
		name = "image"
	}
	size := dimensionsOf(image)
	if size == "" {
		size = sizeOf(image.Bytes)
	}
	if size == "" {
		return "[Image: " + name + "]"
	}
	return "[Image: " + name + " " + size + "]"
}

func dimensionsOf(image ImageRef) string {
	if image.Width <= 0 || image.Height <= 0 {
		return ""
	}
	return strconv.Itoa(image.Width) + "×" + strconv.Itoa(image.Height)
}

func sizeOf(bytes int) string {
	if bytes <= 0 {
		return ""
	}
	if bytes >= 1024*1024 {
		return strconv.FormatFloat(float64(bytes)/(1024*1024), 'f', 1, 64) + "MB"
	}
	if bytes >= 1024 {
		return strconv.Itoa(bytes/1024) + "KB"
	}
	return strconv.Itoa(bytes) + "B"
}

func textOf(value any) string {
	text, _ := value.(string)
	return text
}

func intOf(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	case int64:
		return int(number)
	default:
		return 0
	}
}
