package model

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
)

// Pictures on the wire, per protocol.
//
// The three shapes are different in every part that matters, and getting one
// wrong is not a rendering bug — it is a request the endpoint refuses by naming a
// part type, which reads like a protocol problem rather than like a mistake in
// this file:
//
//	chat completions  {"type":"image_url","image_url":{"url":"data:…"}}
//	Messages          {"type":"image","source":{"type":"base64","media_type":…,"data":…}}
//	Responses         {"type":"input_image","image_url":"data:…"}
//
// So each protocol gets a test that reads the body the endpoint actually received.
// The tests share one helper that fabricates an id → bytes map, because what is
// being pinned is the translation, not the store.

// testPNG is a real PNG: two pixels, encoded by the standard library.
//
// It is real rather than a magic byte string because a media type has to agree with
// the payload, and a test that sent "PNG" bytes that are not a PNG would pass here
// and fail against every endpoint.
func testPNG(t *testing.T) []byte {
	t.Helper()
	source := image.NewRGBA(image.Rect(0, 0, 2, 1))
	source.Set(0, 0, color.RGBA{R: 255, A: 255})
	source.Set(1, 0, color.RGBA{B: 255, A: 255})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, source); err != nil {
		t.Fatalf("encoding the test picture: %v", err)
	}
	return buffer.Bytes()
}

// imageLoaderFor is the store side of the adapter: an id and a body.
func imageLoaderFor(body []byte) ImageLoader {
	return func(artifactID string) ([]byte, bool) {
		if artifactID != "art_picture" {
			return nil, false
		}
		return body, true
	}
}

// pictureMessage is the body the runtime composes for "an image and a question".
//
// It is written in the shape `internal/content` produces, including the label part
// this program puts in front of every picture — the part that lets the model say
// *which* picture it is describing.
func pictureMessage() map[string]any {
	return map[string]any{
		"role": "user",
		"content": []any{
			map[string]any{"type": "text", "text": "[Image: shot.png 2×1]"},
			map[string]any{
				"type":        "image",
				"artifact_id": "art_picture",
				"mime":        "image/png",
				"name":        "shot.png",
			},
		},
	}
}

// TestChatCompletionsSendsAPictureAsADataURL ...
func TestChatCompletionsSendsAPictureAsADataURL(t *testing.T) {
	body := testPNG(t)
	server, bodies, _ := dialectGateway(t, `{"choices":[{"message":{"content":"ok"}}]}`)
	adapter := newTestAdapter(t, Options{
		Route:  route(server.URL, "gpt-x", StyleOpenAI),
		Images: imageLoaderFor(body),
	})

	if _, err := adapter.Complete([]map[string]any{pictureMessage()}, nil, CompleteOptions{}); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	message := messagesOf(t, (*bodies)[0])[0]
	parts, ok := message["content"].([]any)
	if !ok {
		t.Fatalf("content = %#v, want an array: a picture cannot travel as a string", message["content"])
	}
	if len(parts) != 2 {
		t.Fatalf("content has %d parts, want the label and the picture: %#v", len(parts), parts)
	}
	block, _ := parts[1].(map[string]any)
	if block["type"] != "image_url" {
		t.Fatalf("the picture part = %#v, want type image_url", block)
	}
	// The private artifact id must **not** be on the wire. It is the same class of
	// field as `artifact_id` on a tool message, and that one was answered with a
	// fatal 400 that killed every later turn of the session.
	if _, leaked := block["artifact_id"]; leaked {
		t.Errorf("this program's own field reached the endpoint: %#v", block)
	}
	url, _ := block["image_url"].(map[string]any)
	text, _ := url["url"].(string)
	if !strings.HasPrefix(text, "data:image/png;base64,") {
		t.Fatalf("image_url = %q, want a data URL with the media type", text)
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(text, "data:image/png;base64,"))
	if err != nil {
		t.Fatalf("the payload is not base64: %v", err)
	}
	if !bytes.Equal(decoded, body) {
		t.Error("the bytes on the wire are not the bytes of the picture")
	}
}

// TestMessagesSendsAPictureAsABase64Source ...
//
// This is the protocol where a pass-through would not merely be wrong: the body is
// rebuilt block by block, so a picture that is not handled here disappears. The
// test therefore checks the block **exists** as well as its shape.
func TestMessagesSendsAPictureAsABase64Source(t *testing.T) {
	body := testPNG(t)
	server, bodies, _ := dialectGateway(t, `{"content":[{"type":"text","text":"ok"}]}`)
	adapter := newTestAdapter(t, Options{
		Route:  route(server.URL, "claude-x", StyleAnthropic),
		Images: imageLoaderFor(body),
	})

	if _, err := adapter.Complete([]map[string]any{pictureMessage()}, nil, CompleteOptions{}); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	messages := messagesOf(t, (*bodies)[0])
	if len(messages) != 1 {
		t.Fatalf("messages has %d entries, want 1: %#v", len(messages), messages)
	}
	block := blockOf(t, messages[0], "image")
	source, _ := block["source"].(map[string]any)
	if source["type"] != "base64" {
		t.Fatalf("source = %#v, want type base64", source)
	}
	if source["media_type"] != "image/png" {
		t.Errorf("media_type = %v, want the picture's own type", source["media_type"])
	}
	data, _ := source["data"].(string)
	if data == "" || strings.HasPrefix(data, "data:") {
		t.Fatalf("data = %q, want raw base64 and no data-URL prefix", data)
	}
	decoded, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		t.Fatalf("the payload is not base64: %v", err)
	}
	if !bytes.Equal(decoded, body) {
		t.Error("the bytes on the wire are not the bytes of the picture")
	}
	// The label must survive: an image block with no text leaves the model unable
	// to say which picture it is talking about.
	if text := blockText(t, messages[0]); !strings.Contains(text, "shot.png") {
		t.Errorf("the label did not reach the request: %q", text)
	}
}

// TestResponsesSendsAPictureAsAnInputImage ...
func TestResponsesSendsAPictureAsAnInputImage(t *testing.T) {
	body := testPNG(t)
	server, bodies, _ := dialectGateway(t, `{"output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}`)
	adapter := newTestAdapter(t, Options{
		Route:  route(server.URL, "gpt-x", StyleResponses),
		Images: imageLoaderFor(body),
	})

	if _, err := adapter.Complete([]map[string]any{pictureMessage()}, nil, CompleteOptions{}); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	items, _ := (*bodies)[0]["input"].([]any)
	if len(items) != 1 {
		t.Fatalf("input has %d items, want 1: %#v", len(items), items)
	}
	item, _ := items[0].(map[string]any)
	parts, _ := item["content"].([]any)
	if len(parts) != 2 {
		t.Fatalf("the item has %d parts, want the label and the picture: %#v", len(parts), parts)
	}
	block, _ := parts[1].(map[string]any)
	if block["type"] != "input_image" {
		t.Fatalf("the picture part = %#v, want type input_image", block)
	}
	// Flat, unlike the Messages shape: a nested `source` here is a refusal that
	// names the part.
	if _, nested := block["source"]; nested {
		t.Errorf("a source object was sent to the Responses protocol: %#v", block)
	}
	text, _ := block["image_url"].(string)
	if !strings.HasPrefix(text, "data:image/png;base64,") {
		t.Fatalf("image_url = %q, want a data URL", text)
	}
	if _, leaked := block["artifact_id"]; leaked {
		t.Errorf("this program's own field reached the endpoint: %#v", block)
	}
}

// TestAMissingBodyBecomesASentenceNotAnEmptyBlock.
//
// An empty image block is the worst available answer: the Messages shape refuses
// it outright, and the two OpenAI shapes accept it and show the model nothing — so
// the model answers a question about a picture it never saw, and nothing anywhere
// says so. The three protocols are checked together because the failure mode is the
// same and the temptation to "just skip it" is strongest in the protocol that
// builds its blocks itself.
func TestAMissingBodyBecomesASentenceNotAnEmptyBlock(t *testing.T) {
	answers := map[Style]string{
		StyleOpenAI:    `{"choices":[{"message":{"content":"ok"}}]}`,
		StyleAnthropic: `{"content":[{"type":"text","text":"ok"}]}`,
		StyleResponses: `{"output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}`,
	}
	for style, answer := range answers {
		t.Run(string(style), func(t *testing.T) {
			server, bodies, _ := dialectGateway(t, answer)
			// A loader that finds nothing: the session's artifact directory was
			// deleted, or the body was evicted from disk.
			adapter := newTestAdapter(t, Options{
				Route:  route(server.URL, "m", style),
				Images: func(string) ([]byte, bool) { return nil, false },
			})

			if _, err := adapter.Complete([]map[string]any{pictureMessage()}, nil, CompleteOptions{}); err != nil {
				t.Fatalf("Complete: %v", err)
			}

			// The picture's own bytes must not be sent, and a sentence must be
			// there in their place. Both halves are checked, because "the request
			// went out" is not the same statement as "the model was told".
			sent := bodyOf(t, (*bodies)[0], style)
			if !strings.Contains(sent, "no longer available") {
				t.Errorf("the missing picture was not reported: %s", sent)
			}
			if strings.Contains(sent, "base64") {
				t.Errorf("an empty picture block was sent: %s", sent)
			}
		})
	}
}

// TestAPictureWithNoLoaderIsDescribedNotDropped covers the plumbing failure.
//
// An adapter built without a store (a test, or a runtime with the context layer
// off) must still send a legal request, and the model still has to be able to see
// that a picture was there.
func TestAPictureWithNoLoaderIsDescribedNotDropped(t *testing.T) {
	server, bodies, _ := dialectGateway(t, `{"choices":[{"message":{"content":"ok"}}]}`)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleOpenAI)})

	if _, err := adapter.Complete([]map[string]any{pictureMessage()}, nil, CompleteOptions{}); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	message := messagesOf(t, (*bodies)[0])[0]
	parts, _ := message["content"].([]any)
	block, _ := parts[1].(map[string]any)
	if block["type"] != "text" {
		t.Fatalf("the part = %#v, want a text block describing the picture", block)
	}
	if text, _ := block["text"].(string); !strings.Contains(text, "could not be attached") {
		t.Errorf("the sentence does not say what happened: %q", text)
	}
}

// TestATextOnlyRequestIsUnchanged is the prefix-cache guard.
//
// A session that never saw a picture has to send **byte-for-byte** what it sent
// before this feature existed. Every request in it is priced on the longest common
// prefix with the previous one, so a body that gained an array wrapper — or a
// re-encoded part list — invalidates the cache for every token after the first
// changed byte, at roughly fifty times the cost of a hit.
func TestATextOnlyRequestIsUnchanged(t *testing.T) {
	server, bodies, _ := dialectGateway(t, `{"choices":[{"message":{"content":"ok"}}]}`)
	adapter := newTestAdapter(t, Options{Route: route(server.URL, "m", StyleOpenAI)})

	messages := []map[string]any{
		{"role": "system", "content": "be terse"},
		{"role": "user", "content": "hello"},
		{"role": "assistant", "content": "hi"},
	}
	if _, err := adapter.Complete(messages, nil, CompleteOptions{}); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	sent := messagesOf(t, (*bodies)[0])
	for index, message := range sent {
		if _, isArray := message["content"].([]any); isArray {
			t.Errorf("messages[%d] carries an array: %#v", index, message["content"])
		}
	}
	if sent[1]["content"] != "hello" {
		t.Errorf("the user body changed: %#v", sent[1]["content"])
	}
}

// TestPartKindsMatchTheContentPackage pins the two spellings against each other.
//
// The runtime writes `internal/content`'s part shape and this package reads it, and
// the two name the same things with their own constants — deliberately, because the
// wire layer must not depend on how the store names its parts. What that buys costs
// one test: a rename on one side would otherwise be a picture that silently stops
// being sent.
func TestPartKindsMatchTheContentPackage(t *testing.T) {
	if partText != "text" || partImage != "image" {
		t.Fatalf("part kinds are %q/%q", partText, partImage)
	}
	if fieldArtifactID != "artifact_id" || fieldMIME != "mime" || fieldName != "name" {
		t.Fatalf("part fields are %q/%q/%q", fieldArtifactID, fieldMIME, fieldName)
	}
}

// bodyOf renders a request body as JSON, for assertions about what is in it.
func bodyOf(t *testing.T, body map[string]any, style Style) string {
	t.Helper()
	var builder strings.Builder
	// Written out rather than marshalled: the assertion is about text appearing
	// once, and a JSON dump of a base64 body would make "base64" appear for reasons
	// that have nothing to do with an empty block.
	switch style {
	case StyleOpenAI:
		for _, message := range messagesOf(t, body) {
			builder.WriteString(textOfBody(message["content"]))
		}
	case StyleAnthropic:
		for _, message := range messagesOf(t, body) {
			builder.WriteString(textOfBody(message["content"]))
		}
	case StyleResponses:
		items, _ := body["input"].([]any)
		for _, item := range items {
			entry, _ := item.(map[string]any)
			builder.WriteString(textOfBody(entry["content"]))
		}
	}
	return builder.String()
}

// textOfBody flattens a body's text blocks, skipping anything that is not text.
func textOfBody(content any) string {
	parts, ok := content.([]any)
	if !ok {
		text, _ := content.(string)
		return text
	}
	var builder strings.Builder
	for _, entry := range parts {
		object, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		for _, key := range []string{"text", "data", "image_url", "output"} {
			if value, isString := object[key].(string); isString {
				builder.WriteString(value)
			}
		}
		if source, isObject := object["source"].(map[string]any); isObject {
			if value, isString := source["data"].(string); isString {
				builder.WriteString(value)
			}
		}
	}
	return builder.String()
}

// blockText joins the text of every text block in a message.
func blockText(t *testing.T, message map[string]any) string {
	t.Helper()
	blocks, _ := message["content"].([]any)
	var builder strings.Builder
	for _, item := range blocks {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if text, isString := block["text"].(string); isString {
			builder.WriteString(text)
		}
	}
	return builder.String()
}
