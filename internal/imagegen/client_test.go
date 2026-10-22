package imagegen

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A tiny valid PNG, used wherever a test needs a real picture.
//
// It is one pixel, so it is smaller than any assertion about it.
var tinyPNG = []byte{
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
	0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
	0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
}

// newTestClient builds a client pointed at a test server.
func newTestClient(t *testing.T, handler http.Handler) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := New(Route{
		BaseURL: server.URL,
		APIKey:  "sk-test",
		Model:   "gpt-image-1",
	}, server.Client())
	if err != nil {
		t.Fatalf("building the client: %v", err)
	}
	return client
}

// TestTheRequestCarriesNoResponseFormat is the DALL·E-era trap.
//
// `gpt-image-1` refuses a request carrying a field it does not know, and
// `response_format` is exactly such a field. The parameter is not sent, and the
// price of that �?the answer may hold base64 or a URL �?is paid for by
// handling both, which the other tests do.
func TestTheRequestCarriesNoResponseFormat(t *testing.T) {
	var body map[string]any
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decoding the request: %v", err)
		}
		writePicture(t, w, tinyPNG)
	}))

	if _, err := client.Generate(context.Background(), Request{Prompt: "a cat"}); err != nil {
		t.Fatalf("generating: %v", err)
	}
	if _, present := body["response_format"]; present {
		t.Error("the request carries response_format, which gpt-image-1 refuses")
	}
	if body["model"] != "gpt-image-1" {
		t.Errorf("model = %v, want gpt-image-1", body["model"])
	}
	if body["n"] != float64(1) {
		t.Errorf("n = %v, want 1 (one picture per call)", body["n"])
	}
	if body["prompt"] != "a cat" {
		t.Errorf("prompt = %v, want the prompt as given", body["prompt"])
	}
}

// TestTheSizeFollowsTheOrientation checks the three-way mapping.
//
// The runtime asks for a shape, never a ratio: `gpt-image-1` offers three sizes
// and nothing else, so promising "16:9" would be promising something it cannot
// render.
func TestTheSizeFollowsTheOrientation(t *testing.T) {
	cases := []struct {
		orientation Orientation
		want        string
	}{
		{OrientationSquare, "1024x1024"},
		{"", "1024x1024"},
		{OrientationLandscape, "1536x1024"},
		{OrientationPortrait, "1024x1536"},
	}
	for _, test := range cases {
		var body map[string]any
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewDecoder(r.Body).Decode(&body)
			writePicture(t, w, tinyPNG)
		}))
		if _, err := client.Generate(context.Background(), Request{
			Prompt:      "a cat",
			Orientation: test.orientation,
		}); err != nil {
			t.Fatalf("%s: generating: %v", test.orientation, err)
		}
		if body["size"] != test.want {
			t.Errorf("%s: size = %v, want %s", test.orientation, body["size"], test.want)
		}
	}
}

// TestTheAnswerMayCarryBase64 is the first of the two shapes.
func TestTheAnswerMayCarryBase64(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writePicture(t, w, tinyPNG)
	}))

	picture, err := client.Generate(context.Background(), Request{Prompt: "a cat"})
	if err != nil {
		t.Fatalf("generating: %v", err)
	}
	if len(picture.Body) != len(tinyPNG) {
		t.Errorf("the picture has %d bytes, want %d", len(picture.Body), len(tinyPNG))
	}
}

// TestTheAnswerMayCarryAURL is the second shape, and it is the price of not
// sending `response_format`.
func TestTheAnswerMayCarryAURL(t *testing.T) {
	var served string
	images := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(tinyPNG)
	}))
	defer images.Close()
	served = images.URL + "/picture.png"

	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":[{"url":%q}]}`, served)
	}))

	picture, err := client.Generate(context.Background(), Request{Prompt: "a cat"})
	if err != nil {
		t.Fatalf("generating: %v", err)
	}
	if len(picture.Body) != len(tinyPNG) {
		t.Errorf("the downloaded picture has %d bytes, want %d", len(picture.Body), len(tinyPNG))
	}
}

// TestADownloadOverTheCeilingIsRefused checks that the size limit is enforced
// while reading rather than by trusting `Content-Length`.
//
// The header is the sender's claim about its own body; the body is what gets
// written to disk.
func TestADownloadOverTheCeilingIsRefused(t *testing.T) {
	images := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		// A body one byte over the ceiling, streamed in pieces.
		chunk := make([]byte, 1<<20)
		for written := 0; written <= MaxPictureBytes; written += len(chunk) {
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	}))
	defer images.Close()

	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":[{"url":%q}]}`, images.URL+"/big.png")
	}))

	_, err := client.Generate(context.Background(), Request{Prompt: "a cat"})
	if err == nil {
		t.Fatal("an oversized download was accepted")
	}
	if !IsTooLarge(err) {
		t.Errorf("the error is %T (%v), want a too-large error", err, err)
	}
}

// TestAPolicyRefusalIsItsOwnClass checks the classification.
//
// The distinction is the whole point of the error classes: a refusal of the
// *content* is something the model can act on by changing the prompt, and a
// refused credential is not.
func TestAPolicyRefusalIsItsOwnClass(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":{"code":"content_policy_violation","message":"the prompt was refused"}}`)
	}))

	_, err := client.Generate(context.Background(), Request{Prompt: "something the provider refuses"})
	if err == nil {
		t.Fatal("the refusal was accepted")
	}
	if !IsPolicy(err) {
		t.Errorf("the error is %T (%v), want a policy error", err, err)
	}
	if !strings.Contains(err.Error(), "content_policy_violation") {
		t.Errorf("the message does not carry the provider's own words: %v", err)
	}
}

// TestARateLimitCarriesItsRetryAfter checks that the endpoint's own answer to
// "how long should I wait" survives into the message.
//
// The model is the one who decides to try again, and "wait N seconds" is a
// sentence it can act on where "try again later" is not.
func TestARateLimitCarriesItsRetryAfter(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
		fmt.Fprint(w, `{"error":"slow down"}`)
	}))

	_, err := client.Generate(context.Background(), Request{Prompt: "a cat"})
	if err == nil {
		t.Fatal("the rate limit was accepted")
	}
	if !IsRateLimit(err) {
		t.Errorf("the error is %T (%v), want a rate-limit error", err, err)
	}
	if !strings.Contains(err.Error(), "30") {
		t.Errorf("the message does not carry Retry-After: %v", err)
	}
}

// TestARefusedCredentialIsItsOwnClass checks the classification.
func TestARefusedCredentialIsItsOwnClass(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":"invalid api key"}`)
	}))

	_, err := client.Generate(context.Background(), Request{Prompt: "a cat"})
	if err == nil {
		t.Fatal("the refusal was accepted")
	}
	if !IsCredential(err) {
		t.Errorf("the error is %T (%v), want a credential error", err, err)
	}
}

// TestAServerFailureIsItsOwnClass checks the classification.
func TestAServerFailureIsItsOwnClass(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprint(w, `upstream is unhappy`)
	}))

	_, err := client.Generate(context.Background(), Request{Prompt: "a cat"})
	if err == nil {
		t.Fatal("the failure was accepted")
	}
	if !IsServer(err) {
		t.Errorf("the error is %T (%v), want a server error", err, err)
	}
}

// TestAnEmptyAnswerIsNotAPicture checks that a well-formed answer with no
// picture in it is refused.
func TestAnEmptyAnswerIsNotAPicture(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[]}`)
	}))

	_, err := client.Generate(context.Background(), Request{Prompt: "a cat"})
	if err == nil {
		t.Fatal("an empty answer was accepted")
	}
	if !IsNotAnImage(err) {
		t.Errorf("the error is %T (%v), want a not-an-image error", err, err)
	}
}

// TestAnHTMLAnswerIsNotAPicture checks that a body that is not JSON is refused
// rather than reported as a broken picture.
func TestAnHTMLAnswerIsNotAPicture(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><body>gateway error</body></html>`)
	}))

	_, err := client.Generate(context.Background(), Request{Prompt: "a cat"})
	if err == nil {
		t.Fatal("an HTML answer was accepted")
	}
	if !IsNotAnImage(err) {
		t.Errorf("the error is %T (%v), want a not-an-image error", err, err)
	}
}

// TestZeroBytesIsNotAPicture checks the empty answer.
func TestZeroBytesIsNotAPicture(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[{"b64_json":""}]}`)
	}))

	_, err := client.Generate(context.Background(), Request{Prompt: "a cat"})
	if err == nil {
		t.Fatal("an empty picture was accepted")
	}
	if !IsNotAnImage(err) {
		t.Errorf("the error is %T (%v), want a not-an-image error", err, err)
	}
}

// TestTheUsageIsReportedOnlyWhenTheProviderReportsIt checks that a missing
// usage block stays missing.
//
// A made-up token count would be believed by every report that reads it, and a
// zero would be read as "this call was free".
func TestTheUsageIsReportedOnlyWhenTheProviderReportsIt(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":[{"b64_json":%q}]}`,
			base64.StdEncoding.EncodeToString(tinyPNG))
	}))

	picture, err := client.Generate(context.Background(), Request{Prompt: "a cat"})
	if err != nil {
		t.Fatalf("generating: %v", err)
	}
	if picture.Usage != nil {
		t.Errorf("the usage is %+v, want none �?the provider reported none", picture.Usage)
	}
}

// TestTheUsageIsReportedWhenTheProviderReportsIt checks the other direction.
func TestTheUsageIsReportedWhenTheProviderReportsIt(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":[{"b64_json":%q}],"usage":{"input_tokens":42,"output_tokens":4160}}`,
			base64.StdEncoding.EncodeToString(tinyPNG))
	}))

	picture, err := client.Generate(context.Background(), Request{Prompt: "a cat"})
	if err != nil {
		t.Fatalf("generating: %v", err)
	}
	if picture.Usage == nil {
		t.Fatal("the usage is missing, but the provider reported one")
	}
	if picture.Usage.InputTokens != 42 || picture.Usage.OutputTokens != 4160 {
		t.Errorf("the usage is %+v, want 42 in / 4160 out", picture.Usage)
	}
}

// TestTheRevisedPromptIsKept checks that the provider's own rewrite survives.
//
// It is the closest thing to an explanation of what was actually drawn.
func TestTheRevisedPromptIsKept(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":[{"b64_json":%q,"revised_prompt":"a cat, in the style of a watercolour"}]}`,
			base64.StdEncoding.EncodeToString(tinyPNG))
	}))

	picture, err := client.Generate(context.Background(), Request{Prompt: "a cat"})
	if err != nil {
		t.Fatalf("generating: %v", err)
	}
	if picture.RevisedPrompt == "" {
		t.Error("the revised prompt was dropped")
	}
}

// TestACancelledTurnIsNotAFaultOfTheEndpoint checks the classification.
//
// A turn that was stopped is not a broken endpoint, and telling the model
// "the endpoint is unreachable" would send it looking in the wrong place.
func TestACancelledTurnIsNotAFaultOfTheEndpoint(t *testing.T) {
	release := make(chan struct{})
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer close(release)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	_, err := client.Generate(ctx, Request{Prompt: "a cat"})
	if err == nil {
		t.Fatal("the cancelled request succeeded")
	}
	if !IsCancelled(err) {
		t.Errorf("the error is %T (%v), want a cancelled error", err, err)
	}
}

// TestTheEndpointIsNamed checks that the URL is knowable.
//
// An inherited base URL that does not offer `/images/generations` produces a
// 404, and without the URL that is a mystery rather than a report.
func TestTheEndpointIsNamed(t *testing.T) {
	client, err := New(Route{BaseURL: "https://api.example/v1/", Model: "gpt-image-1"}, nil)
	if err != nil {
		t.Fatalf("building the client: %v", err)
	}
	if got := client.Endpoint(); got != "https://api.example/v1/images/generations" {
		t.Errorf("the endpoint is %q, want the images path appended to the base", got)
	}
}

// TestTheCredentialTravelsInAHeader checks that the key is not in the URL.
//
// URLs end up in proxy logs, browser history and every middleware in between;
// headers do not.
func TestTheCredentialTravelsInAHeader(t *testing.T) {
	var seen string
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("Authorization")
		writePicture(t, w, tinyPNG)
	}))

	if _, err := client.Generate(context.Background(), Request{Prompt: "a cat"}); err != nil {
		t.Fatalf("generating: %v", err)
	}
	if seen != "Bearer sk-test" {
		t.Errorf("the Authorization header is %q, want a bearer token", seen)
	}
}

// TestARouteWithoutAModelIsRefused checks that a half-written route cannot be
// used by accident.
func TestARouteWithoutAModelIsRefused(t *testing.T) {
	if _, err := New(Route{BaseURL: "https://api.example"}, nil); err == nil {
		t.Error("a route with no model was accepted")
	}
}

// TestAnUnknownStyleIsRefused checks that a typo is not treated as the
// default.
//
// Silently treating a typo as the default is exactly the failure the
// configuration reader refuses everywhere else.
func TestAnUnknownStyleIsRefused(t *testing.T) {
	_, err := New(Route{
		BaseURL: "https://api.example",
		Model:   "gpt-image-1",
		Style:   Style("gemini"),
	}, nil)
	if err == nil {
		t.Fatal("an unknown style was accepted")
	}
	if !strings.Contains(err.Error(), "gemini") {
		t.Errorf("the message does not name the bad style: %v", err)
	}
}

// TestALargeAnswerIsNotTruncated is the base64 trap.
//
// A picture of N bytes arrives as roughly 4N/3 characters inside a JSON
// envelope. Reading the answer under the picture ceiling would truncate the
// answer of a perfectly ordinary picture and produce a decode error that
// reads like a broken provider.
func TestALargeAnswerIsNotTruncated(t *testing.T) {
	// A body over the old eight-megabyte read limit, but under the picture
	// ceiling — a picture that is simply large.
	body := make([]byte, 12*1024*1024)
	copy(body, tinyPNG)

	served := len(body)
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":[{"b64_json":%q}]}`, base64.StdEncoding.EncodeToString(body))
	}))

	picture, err := client.Generate(context.Background(), Request{Prompt: "a big cat"})
	if err != nil {
		t.Fatalf("generating: %v", err)
	}
	if len(picture.Body) != served {
		t.Errorf("the picture has %d bytes, want %d — the answer was truncated",
			len(picture.Body), served)
	}
}

// TestAnAnswerOverTheCeilingIsRefused checks the other side.
//
// A body over the ceiling is refused rather than read into memory and
// refused afterwards.
func TestAnAnswerOverTheCeilingIsRefused(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// A body past the envelope ceiling.
		chunk := make([]byte, 1<<20)
		limit := int64(MaxPictureBytes)*4/3 + (2 << 20)
		for written := int64(0); written < limit; written += int64(len(chunk)) {
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	}))

	_, err := client.Generate(context.Background(), Request{Prompt: "a huge cat"})
	if err == nil {
		t.Fatal("an oversized answer was accepted")
	}
	if !IsTooLarge(err) {
		t.Errorf("the error is %T (%v), want a too-large error", err, err)
	}
}

// writePicture answers with one picture, inline.
func writePicture(t *testing.T, w http.ResponseWriter, body []byte) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"data":[{"b64_json":%q}]}`, base64.StdEncoding.EncodeToString(body))
}
