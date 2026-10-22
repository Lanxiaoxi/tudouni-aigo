// Package imagegen turns a text description into a picture.
//
// It is the **output** half of the picture story, and the half that did not exist:
// `vision` takes pictures in and gives text and tool calls out; this takes text
// in and gives a picture out. The two are orthogonal, and they are joined the
// same way any other capability is joined — as a tool.
//
// ## The one decision everything else follows from
//
//	**A generated picture is a file, not a message content.**
//
// It is `out/poster.png` in the workspace. It can be shown with `![](…)`,
// declared with `present`, and opened again in a later session. It is not a
// binary pushed into an assistant message: that path changes the session schema,
// opens a hole in the "the model said nothing" check, and loses the picture the
// moment the session is reopened.
//
// ## Why this package exists at all
//
// Because "one capability, several wire shapes" has already been done once in
// this codebase — `internal/model` does it for chat completions, Messages and
// Responses — and the structure is worth copying rather than reinventing: the
// request body, the credential header, the response shape and the error
// classification all live in the dialect file, and `Client` only ever deals in
// `Request` and `Picture`.
//
// ## What is deliberately not here
//
// The runtime does not understand a provider's picture format. It understands
// `Picture`, and the dialect decides how to put it on the wire. That is the
// same rule `internal/content` states for the input side, and it is why the
// orientation the caller asks for is a **shape** (`square` / `landscape` /
// `portrait`) rather than a ratio: `gpt-image-1` offers three sizes and
// nothing else, so promising "16:9" would be promising something the endpoint
// cannot render.
package imagegen

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/proxy"
)

// Style is which wire protocol an image endpoint speaks.
//
// The names are the same strings a person writes in `"api_style"`, and the zero
// value is StyleOpenAIImages so that a route with no explicit style keeps
// behaving the way it did before this type existed.
type Style string

const (
	// StyleOpenAIImages is `POST /images/generations` with a
	// `{"data": [{"b64_json": …}]}` answer. It is the only dialect in this
	// build; the next one (`gemini`) is a separate file, not a branch in this
	// one.
	StyleOpenAIImages Style = "openai-images"
)

// MaxPictureBytes is the largest picture this package will hand over.
//
// It is a ceiling on **bytes**, and it is not the same number as the one that
// decides what may be sent to a model (`content.MaxImageBytes`, five megabytes).
// Those are two different questions: "may this file be written into the
// workspace" and "may this picture go into a request". A picture between the
// two sizes is perfectly legal — it is written to disk, it can be opened with
// the system viewer, and it simply cannot be shown inline or handed to the
// model.
const MaxPictureBytes = 20 * 1024 * 1024

// RequestTimeout is how long one generation may take.
//
// A constant rather than a configuration key: generation is an order of
// magnitude slower than chat, and "this one number" has no second place that
// needs it. The turn's context still cuts it short — a stop must abandon a
// sixty-second generation rather than wait it out.
const RequestTimeout = 120 * time.Second

// Route is everything needed to send a generation request to one endpoint.
type Route struct {
	// Name is the configured route name, for the audit and for telling two
	// routes that carry the same model name apart.
	Name string
	// BaseURL is where requests go, without the endpoint path.
	BaseURL string
	// APIKey is the credential. How it is presented is the dialect's business.
	APIKey string
	// Model is the image model name sent in the request body.
	Model string
	// Style is the wire protocol. The zero value is StyleOpenAIImages.
	Style Style
	// Headers are extra request headers, sent verbatim on every request.
	Headers map[string]string
	// Verify keeps the configuration's TLS choice. A transport that skips
	// certificate checks would be built from it; the default client verifies.
	Verify bool
}

// normalized trims the route and fills in the defaults.
func (r Route) normalized() Route {
	r.Name = strings.TrimSpace(r.Name)
	r.Model = strings.TrimSpace(r.Model)
	r.BaseURL = strings.TrimRight(strings.TrimSpace(r.BaseURL), "/")
	if r.Style == "" {
		r.Style = StyleOpenAIImages
	}
	return r
}

// Request is one picture to generate.
type Request struct {
	// Prompt is the picture itself: subject, style, composition, light, tone.
	// It is not an instruction to a drawing program — "please draw" is noise.
	Prompt string
	// Orientation is the shape asked for. Empty means square.
	Orientation Orientation
}

// Orientation is the shape of the wanted picture.
//
// Three values, because that is what the endpoints offer. An exact ratio would
// be a promise the endpoint cannot keep, and the mapping to concrete pixel
// sizes belongs to the dialect (see internal/imagegen/openai_images.go).
type Orientation string

const (
	// OrientationSquare is a square picture.
	OrientationSquare Orientation = "square"
	// OrientationLandscape is a picture wider than it is tall.
	OrientationLandscape Orientation = "landscape"
	// OrientationPortrait is a picture taller than it is wide.
	OrientationPortrait Orientation = "portrait"
)

// Orientations are the accepted values, in the order they are offered.
var Orientations = []Orientation{OrientationSquare, OrientationLandscape, OrientationPortrait}

// Usage is what the provider reported the call cost.
//
// It is a pointer in `Picture` because **a provider that reports nothing must
// produce nothing**: a made-up token count would be believed by every report
// that reads it, and a zero would be read as "free".
type Usage struct {
	InputTokens  int
	OutputTokens int
}

// Picture is what one generation produced.
//
// The bytes are the picture; everything else is what the provider said about
// it. The dimensions are **not** here: they are a fact about the bytes, and
// `content.InspectImage` is the one place that measures them.
type Picture struct {
	// Body is the picture's own bytes.
	Body []byte
	// RevisedPrompt is the provider's own rewrite of the prompt, when it
	// reports one. It is worth keeping: it is the closest thing to an
	// explanation of what was actually drawn.
	RevisedPrompt string
	// RequestID is the provider's identifier for the call, when it reports one.
	RequestID string
	// Usage is the reported cost, or nil when the provider reported none.
	Usage *Usage
}

// Client generates pictures.
//
// One instance per configured route. It is safe for concurrent use: the HTTP
// client is, and nothing else is held.
type Client struct {
	client *http.Client
	route  Route
}

// New builds a client for a route.
//
// It returns an error only for a route that cannot be used at all: no endpoint,
// no model, or a protocol this build does not speak. A route with no key is
// allowed — "no key" is a fact the catalogue reports, not a reason the process
// cannot start — and the request it makes is refused by the endpoint, which is
// the honest place for that to happen.
func New(route Route, client *http.Client) (*Client, error) {
	resolved := route.normalized()
	if resolved.BaseURL == "" || resolved.Model == "" {
		return nil, fmt.Errorf("an image route needs both a base_url and a model name")
	}
	if resolved.Style != StyleOpenAIImages {
		return nil, fmt.Errorf("unknown image api_style %q: the wire protocols are %s",
			string(resolved.Style), StyleOpenAIImages)
	}
	if client == nil {
		// The transport is built rather than defaulted so the machine's own proxy
		// setting is followed — the same reason the chat client builds one.
		transport, _ := proxy.Transport(resolved.Verify)
		client = &http.Client{Timeout: RequestTimeout, Transport: transport}
	}
	return &Client{client: client, route: resolved}, nil
}

// Route is the endpoint in use, as a value.
func (c *Client) Route() Route { return c.route }

// Endpoint is the URL requests go to.
//
// It is a method rather than a constant because the base URL is configuration
// and the path is the dialect's: the two are put together in one place so the
// error messages can name the URL that was actually used. A 404 on an inherited
// base URL is a mystery unless the message says which URL it was.
func (c *Client) Endpoint() string {
	return strings.TrimRight(c.route.BaseURL, "/") + imagesPath
}

// Generate produces one picture.
//
// The error it returns is one of this package's classes, and the class is the
// decision: a failure the model can act on (a policy refusal, a rate limit) and
// a failure only a person can fix (a refused credential, a wrong URL) are
// different kinds of thing, and the caller above needs to tell them apart.
func (c *Client) Generate(ctx context.Context, request Request) (Picture, error) {
	body, err := c.requestBody(request)
	if err != nil {
		return Picture{}, err
	}
	raw, err := c.post(ctx, body)
	if err != nil {
		return Picture{}, err
	}
	return c.parse(ctx, raw)
}

// requestBody builds the JSON body for one generation.
//
// **No `response_format`.** It is a DALL·E-era parameter, and `gpt-image-1`
// refuses a request carrying a field it does not know. The cost of leaving it
// out is that the answer may hold base64 or a URL — and both are handled.
func (c *Client) requestBody(request Request) ([]byte, error) {
	size, err := sizeFor(request.Orientation)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{
		"model":  c.route.Model,
		"prompt": request.Prompt,
		"size":   size,
		// One picture per call. Asking for several costs several times as much
		// for the same sentence, and the model cannot choose between them
		// because it cannot see them until after the call.
		"n": 1,
	}
	return marshalJSON(payload)
}

// post sends the request and returns the raw answer.
func (c *Client) post(ctx context.Context, body []byte) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	endpoint := c.Endpoint()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, &RequestError{Msg: fmt.Sprintf("cannot build the request for %s: %v", endpoint, err)}
	}
	// The route's own headers go first, so that nothing configured can displace
	// the headers this package is responsible for.
	for name, value := range c.route.Headers {
		request.Header.Set(name, value)
	}
	request.Header.Set("Content-Type", "application/json")
	if c.route.APIKey != "" {
		request.Header.Set(credentialHeader, "Bearer "+c.route.APIKey)
	}

	response, err := c.client.Do(request)
	if err != nil {
		return nil, c.transportError(ctx, endpoint, err)
	}
	defer response.Body.Close()

	// The answer is read with a ceiling, and the ceiling has to account for
	// **base64**: a picture of N bytes arrives as roughly 4N/3 characters
	// inside a JSON envelope. Reading it under the picture ceiling would
	// truncate the answer of a perfectly ordinary picture and produce a
	// decode error that reads like a broken provider.
	//
	// The envelope is one base64 body plus a little JSON around it, and the
	// extra quarter is generous enough for a picture at the ceiling.
	envelopeCeiling := int64(MaxPictureBytes)*4/3 + 1<<20
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, envelopeCeiling))
	if response.StatusCode >= 400 {
		return nil, c.statusError(response.StatusCode, string(raw), endpoint, response.Header.Get("Retry-After"))
	}
	if readErr != nil {
		return nil, &NetworkError{Msg: fmt.Sprintf("cannot read the answer from %s: %v", endpoint, readErr)}
	}
	if int64(len(raw)) >= envelopeCeiling {
		return nil, &TooLargeError{
			Msg: fmt.Sprintf("the answer from %s is over the %s ceiling",
				endpoint, humanSize(MaxPictureBytes)),
		}
	}
	return raw, nil
}

// transportError classifies a failure that happened before a status code came
// back.
//
// The distinction that matters here is **cancelled** versus **broken**: a turn
// that was stopped is not a fault of the endpoint, and telling the model "the
// endpoint is unreachable" would send it looking in the wrong place.
func (c *Client) transportError(ctx context.Context, endpoint string, err error) error {
	if ctx != nil && ctx.Err() != nil {
		return &CancelledError{Msg: fmt.Sprintf("the generation was abandoned before %s answered", endpoint)}
	}
	if isTimeout(err) {
		return &TimeoutError{Msg: fmt.Sprintf("the generation at %s took longer than %s", endpoint, RequestTimeout)}
	}
	return &NetworkError{Msg: fmt.Sprintf("cannot reach the generation endpoint %s: %v", endpoint, err)}
}

// statusError maps a failing status onto this package's error classes.
//
// The split follows **what the reader has to do**, not which band the status
// code falls in:
//
//   - 400 and 422 are the endpoint's refusal of the *content* — it says what it
//     objected to, and the answer is a different prompt, not a different key;
//   - 429 and 5xx come good if you wait;
//   - 401, 403 and 404 need somebody to change the configuration, and the
//     message names the URL that was used so the 404 is not a mystery.
func (c *Client) statusError(status int, body, endpoint string, retryAfter string) error {
	detail := summarize(body)
	switch {
	case status == 400 || status == 422:
		return &PolicyError{Msg: fmt.Sprintf("HTTP %d from %s: %s", status, endpoint, detail)}
	case status == 429:
		message := fmt.Sprintf("HTTP 429 from %s: %s", endpoint, detail)
		// The endpoint's own answer to "how long should I wait", when it gave
		// one. It is worth carrying: the model is the one who decides to try
		// again, and "wait N seconds" is a sentence it can act on where "try
		// again later" is not.
		if retryAfter != "" {
			message += " (Retry-After: " + retryAfter + ")"
		}
		return &RateLimitError{Msg: message}
	case status == 401 || status == 403:
		return &CredentialError{Msg: fmt.Sprintf("HTTP %d from %s: %s", status, endpoint, detail)}
	case status >= 500:
		return &ServerError{Msg: fmt.Sprintf("HTTP %d from %s: %s", status, endpoint, detail)}
	default:
		return &RequestError{Msg: fmt.Sprintf("HTTP %d from %s: %s", status, endpoint, detail)}
	}
}

// download fetches a picture the endpoint pointed at.
//
// The URL comes from the provider's answer rather than from the model, so it
// introduces no new surface for the model to aim at — but it is still only
// allowed to be `http` or `https`, and it is fetched with **this** client, so
// the machine's proxy setting applies to it exactly as it does to the
// generation call itself.
//
// The size is bounded while reading rather than by trusting `Content-Length`:
// the header is the sender's claim about its own body, and the body is what
// gets written to disk.
func (c *Client) download(ctx context.Context, raw string) ([]byte, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, &NotAnImageError{Msg: fmt.Sprintf("the endpoint pointed at a URL that cannot be read: %v", err)}
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
	default:
		return nil, &NotAnImageError{Msg: fmt.Sprintf("the endpoint pointed at %q, which is not an http or https URL", raw)}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, &NotAnImageError{Msg: fmt.Sprintf("cannot build the download request: %v", err)}
	}
	response, err := c.client.Do(request)
	if err != nil {
		return nil, &NetworkError{Msg: fmt.Sprintf("cannot download the picture: %v", err)}
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return nil, &NotAnImageError{Msg: fmt.Sprintf("the picture download answered HTTP %d", response.StatusCode)}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, MaxPictureBytes+1))
	if err != nil {
		return nil, &NetworkError{Msg: fmt.Sprintf("cannot read the downloaded picture: %v", err)}
	}
	if len(body) > MaxPictureBytes {
		return nil, &TooLargeError{Msg: fmt.Sprintf("the picture is over the %s ceiling", humanSize(MaxPictureBytes))}
	}
	return body, nil
}

// credentialHeader is where the credential goes.
//
// The OpenAI images shape takes a bearer token, and the dialect owns that
// fact — a later dialect may want a different header, and the client must not
// have to learn about it.
const credentialHeader = "Authorization"

// imagesPath is the endpoint path appended to the base URL.
const imagesPath = "/images/generations"

// decodeBase64 reads the base64 body an endpoint may answer with.
//
// A `data:` prefix is accepted because some gateways wrap the payload that
// way, and refusing it would be refusing a picture that arrived perfectly well.
func decodeBase64(encoded string) ([]byte, error) {
	text := strings.TrimSpace(encoded)
	if index := strings.Index(text, ","); strings.HasPrefix(text, "data:") && index > 0 {
		text = text[index+1:]
	}
	body, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		// Some gateways send the URL-safe alphabet, and some send the payload
		// without padding. One retry with the forgiving decoder is worth it: the
		// alternative is telling the model the provider "returned something that
		// is not a picture" when it returned a picture in a slightly different
		// alphabet.
		body, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(text, "="))
		if err != nil {
			return nil, &NotAnImageError{Msg: "the endpoint returned a body that is not a readable picture"}
		}
	}
	return body, nil
}

// summarize shortens an error body to a readable sentence.
//
// The real reason is in there ("content_policy_violation", "model not found"),
// and it is worth keeping — but a provider that answers with a page of HTML
// would otherwise push a page of HTML into the model's context.
func summarize(body string) string {
	flat := strings.Join(strings.Fields(body), " ")
	if len(flat) > 400 {
		return flat[:400] + "…"
	}
	if flat == "" {
		return "(the endpoint said nothing)"
	}
	return flat
}

// isTimeout reports whether an error is a timeout rather than a refusal.
func isTimeout(err error) bool {
	if err == nil {
		return false
	}
	var timeout interface{ Timeout() bool }
	if errorsAs(err, &timeout) {
		return timeout.Timeout()
	}
	return false
}

// humanSize renders a byte count the way a person reads it.
func humanSize(size int) string {
	switch {
	case size >= 1024*1024:
		return fmt.Sprintf("%.1fMB", float64(size)/(1024*1024))
	case size >= 1024:
		return fmt.Sprintf("%dKB", size/1024)
	default:
		return fmt.Sprintf("%dB", size)
	}
}
