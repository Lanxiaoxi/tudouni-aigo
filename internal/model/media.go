package model

import (
	"encoding/base64"
	"strings"
)

// Pictures on the way to the wire.
//
// This file is the **only** place that knows the three protocols disagree about
// how a picture is spelled:
//
//	chat completions  {"type":"image_url","image_url":{"url":"data:…"}}
//	Messages          {"type":"image","source":{"type":"base64",…}}
//	Responses         {"type":"input_image","image_url":"data:…"}
//
// The rule it enforces is the design's central one:
//
//	**the runtime never understands a provider's image format. It understands
//	 ImagePart, and the adapter decides how to put it on the wire.**
//
// So a message travelling up here carries a part that names an **artifact id** —
// a thing no endpoint has ever heard of — and each dialect's encoder calls into
// this file to turn that into its own shape. Base64 is produced here, once, for
// the one request that needs it; it is never stored, and it never reaches the
// session file.
//
// ## Why the bytes are fetched through a function
//
// The adapter is not allowed to know what an artifact store is. It is handed a
// `ImageLoader` — "give me the bytes of this id" — and the layer that owns the
// store supplies it. That keeps `model` free of the context package, so the wire
// code cannot grow a dependency on how sessions are kept.
//
// ## A missing picture is said out loud
//
// When the bytes cannot be fetched, the part becomes a **sentence** and never an
// empty block. An empty image part is refused by two of the three endpoints with a
// message about the request shape, and the third accepts it and shows the model
// nothing — which is worse, because the model then answers a question about a
// picture it never saw.

// ImageLoader returns the bytes of a referenced picture.
//
// `false` means the body cannot be fetched (deleted, or a session restored without
// its artifact directory). It never means "empty picture": an image whose body is
// zero bytes is not a picture, and the only correct rendering of it is the same
// sentence a missing one gets.
type ImageLoader func(artifactID string) ([]byte, bool)

// Part kinds as they appear in a message body.
//
// They are the spellings `internal/content` writes into the session file, repeated
// here as constants rather than imported: this package is the wire layer, and the
// one thing it must not do is depend on how the store names its parts. The two
// lists are pinned against each other by a test.
const (
	partText  = "text"
	partImage = "image"
)

// partFields is the picture part's own field names, likewise repeated.
const (
	fieldArtifactID = "artifact_id"
	fieldMIME       = "mime"
	fieldName       = "name"
)

// imageBlock is one picture part read out of a body, and it is also where the
// bytes land. One type for both readings because there is exactly one caller.
type imageBlock struct {
	ArtifactID string
	MIME       string
	Name       string
}

// readImagePart reads a picture part, or reports that this object is not one.
func readImagePart(raw any) (imageBlock, bool) {
	object, ok := raw.(map[string]any)
	if !ok {
		return imageBlock{}, false
	}
	if text, _ := object["type"].(string); text != partImage {
		return imageBlock{}, false
	}
	artifactID, _ := object[fieldArtifactID].(string)
	if artifactID == "" {
		return imageBlock{}, false
	}
	mime, _ := object[fieldMIME].(string)
	name, _ := object[fieldName].(string)
	if mime == "" {
		// A media type the endpoint will accept: guessing wrong is a refusal that
		// names the media type rather than the file, and PNG is what the parts of
		// this program that build an image produce by default.
		mime = "image/png"
	}
	return imageBlock{ArtifactID: artifactID, MIME: mime, Name: name}, true
}

// dataURL renders a picture the way the two OpenAI-shaped protocols want it.
//
// Base64 of the file's own bytes, prefixed with its media type. Note what is *not*
// here: any caching. The same picture in two requests is encoded twice, and that is
// the honest cost of not storing base64 anywhere — a request is built once per
// step, while a stored encoding would be carried by the session file forever.
func dataURL(mime string, body []byte) string {
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(body)
}

// encodeBase64 is the Messages shape's spelling: the payload is its own field.
func encodeBase64(body []byte) string {
	return base64.StdEncoding.EncodeToString(body)
}

// pictureText is what a picture becomes when it cannot be sent.
//
// It is deliberately shaped like the part it stands in for — text, not an image —
// and it names the file so the model can refer to it. Returning an empty string
// instead would delete the picture from the request without a trace, and the model
// would answer as though the user had sent only the words.
func pictureText(image imageBlock, reason string) string {
	label := image.Name
	if label == "" {
		label = image.MIME
	}
	if label == "" {
		label = "image"
	}
	return "[Image: " + label + " — " + reason + "]"
}

// loadImage fetches a picture's bytes, or explains why it could not.
//
// Every failure path leads to a sentence rather than to a dropped part, and the two
// reasons are kept apart because they call for different actions from whoever reads
// the transcript afterwards: "this build has no store wired up" is a plumbing
// problem, and "the body is gone" is a session that lost its directory.
func loadImage(image imageBlock, loader ImageLoader) ([]byte, string, bool) {
	if loader == nil {
		return nil, pictureText(image, "its bytes could not be attached to this request"), false
	}
	body, ok := loader(image.ArtifactID)
	if !ok || len(body) == 0 {
		return nil, pictureText(image, "its bytes are no longer available"), false
	}
	return body, "", true
}

// hasImagePart reports whether a message body holds a picture this program can
// send.
//
// The test is on the part's shape, not on the message's role: a picture can arrive
// in a user message (what this feature is for) and a body assembled by hand could
// put one anywhere, and a dialect that only looked at `role == "user"` would send
// the raw part object to an endpoint as though it were text.
func hasImagePart(content any) bool {
	_, ok := firstImagePart(content)
	return ok
}

func firstImagePart(content any) (imageBlock, bool) {
	parts, ok := content.([]any)
	if !ok {
		return imageBlock{}, false
	}
	for _, entry := range parts {
		if image, isImage := readImagePart(entry); isImage {
			return image, true
		}
	}
	return imageBlock{}, false
}

// hasImages reports whether any message of a request carries a picture.
//
// It exists so the transport can answer "does this request need a vision-capable
// model" from the payload itself rather than from a flag a caller set — a flag and
// a payload drift, and the drift shows up as a 400 from the endpoint.
func hasImages(messages []map[string]any) bool {
	for _, message := range messages {
		if message == nil {
			continue
		}
		if hasImagePart(message["content"]) {
			return true
		}
	}
	return false
}

// textBlocksFrom renders the text of a body that may or may not hold pictures.
//
// It is the plain-text reading used by the two protocols whose *tool results* and
// *system prompt* are strings: those two positions cannot carry a picture in any of
// the three shapes, so a picture that somehow lands there is described rather than
// dropped.
func textBlocksFrom(content any) string {
	switch typed := content.(type) {
	case nil:
		return ""
	case string:
		return typed
	case []any:
		var pieces []string
		for _, entry := range typed {
			object, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			if text, _ := object["text"].(string); text != "" {
				pieces = append(pieces, text)
				continue
			}
			if image, isImage := readImagePart(entry); isImage {
				pieces = append(pieces, pictureText(image, "this position cannot carry a picture"))
			}
		}
		return strings.Join(pieces, "")
	default:
		return ""
	}
}
