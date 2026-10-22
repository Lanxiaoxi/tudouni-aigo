package imagegen

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// The `openai-images` dialect.
//
// Everything that is the wire shape of this one endpoint lives in this file:
// the size table, the request body, the answer shape, and the two ways a
// picture can come back. `Client` deals in `Request` and `Picture` and knows
// none of it — the same partition `internal/model` makes between its dialects
// and its client.
//
// ## Sizes
//
// `gpt-image-1` offers three sizes and nothing else, so the table is three
// rows. The runtime asks for a **shape** (`square` / `landscape` /
// `portrait`) rather than a ratio, and this file is what turns a shape into
// pixels. That is the point of the division: the runtime does not know that
// "landscape" happens to be 1536×1024 for this provider, and it must not —
// the next provider spells the same shape differently.

// sizeFor maps a shape onto this endpoint's pixel size.
//
// The default is the square: an empty orientation is not an error, because the
// common case is "one picture" and a picture of no particular shape is a
// square far more often than not.
func sizeFor(orientation Orientation) (string, error) {
	switch orientation {
	case "", OrientationSquare:
		return "1024x1024", nil
	case OrientationLandscape:
		return "1536x1024", nil
	case OrientationPortrait:
		return "1024x1536", nil
	default:
		return "", errorf("unknown orientation %q: the shapes are %s",
			string(orientation), strings.Join(orientationNames(), ", "))
	}
}

// orientationNames lists the accepted shapes for a message.
func orientationNames() []string {
	out := make([]string, 0, len(Orientations))
	for _, orientation := range Orientations {
		out = append(out, string(orientation))
	}
	return out
}

// marshalJSON encodes a request body.
func marshalJSON(payload map[string]any) ([]byte, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, &RequestError{Msg: fmt.Sprintf("cannot encode the request: %v", err)}
	}
	return raw, nil
}

// The answer shape.
//
// Two fields carry the picture, and which one is present is the endpoint's
// choice rather than ours: `b64_json` when the picture is inline, `url` when
// it is somewhere else. Both are read, and a request that sends neither is
// still a valid request — that is the price of not sending `response_format`,
// and it is paid for here instead of by refusing the model.
//
// `data` is an array because the endpoint is asked for `n: 1`, but the array is
// read the way an array is read: the first entry that carries a picture.

// imagesAnswer is the parsed answer.
type imagesAnswer struct {
	Data []imagesEntry `json:"data"`
	// Usage is the reported cost. It is a pointer so that "the endpoint
	// reported nothing" is distinguishable from "the endpoint reported zero".
	Usage *imagesUsage `json:"usage"`
	// ID is the provider's identifier for the call.
	ID string `json:"id"`
	// RequestID is the same idea under the header-style name some gateways use.
	RequestID string `json:"request_id"`
}

// imagesEntry is one picture in the answer.
type imagesEntry struct {
	B64JSON       string `json:"b64_json"`
	URL           string `json:"url"`
	RevisedPrompt string `json:"revised_prompt"`
}

// imagesUsage is the reported cost.
type imagesUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
	// The prompt tokens are reported under a second name by some gateways.
	PromptTokens int `json:"prompt_tokens"`
	// And the completion tokens under a third.
	CompletionTokens int `json:"completion_tokens"`
}

// parse reads the answer and produces the picture.
//
// It is a method on the client because a picture that arrives as a URL has to
// be downloaded, and the download uses the client's own HTTP client — the one
// that carries the machine's proxy setting.
func (c *Client) parse(ctx context.Context, raw []byte) (Picture, error) {
	var answer imagesAnswer
	if err := json.Unmarshal(raw, &answer); err != nil {
		return Picture{}, &NotAnImageError{
			Msg: fmt.Sprintf("the endpoint did not answer with JSON: %v", err),
		}
	}

	picture := Picture{RequestID: answer.RequestID}
	if picture.RequestID == "" {
		picture.RequestID = answer.ID
	}
	if answer.Usage != nil {
		usage := &Usage{
			InputTokens:  answer.Usage.InputTokens,
			OutputTokens: answer.Usage.OutputTokens,
		}
		if usage.InputTokens == 0 {
			usage.InputTokens = answer.Usage.PromptTokens
		}
		if usage.OutputTokens == 0 {
			usage.OutputTokens = answer.Usage.CompletionTokens
		}
		// A usage block that reports nothing at all is **not** a usage block. It
		// is the endpoint's way of saying "no numbers here", and passing zero
		// tokens on would be a claim that the call was free.
		if usage.InputTokens != 0 || usage.OutputTokens != 0 {
			picture.Usage = usage
		}
	}

	for _, entry := range answer.Data {
		if entry.RevisedPrompt != "" && picture.RevisedPrompt == "" {
			picture.RevisedPrompt = entry.RevisedPrompt
		}
		if strings.TrimSpace(entry.B64JSON) != "" {
			body, err := decodeBase64(entry.B64JSON)
			if err != nil {
				return Picture{}, err
			}
			picture.Body = body
			return picture, nil
		}
		if strings.TrimSpace(entry.URL) != "" {
			body, err := c.download(ctx, entry.URL)
			if err != nil {
				return Picture{}, err
			}
			picture.Body = body
			return picture, nil
		}
	}
	return Picture{}, &NotAnImageError{
		Msg: "the endpoint answered without a picture (neither b64_json nor url was present)",
	}
}
