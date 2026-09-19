package model

import (
	"reflect"
	"strings"
)

// Style is which wire protocol an endpoint speaks.
//
// The three names are the same strings a person writes in `"api_style"` in the
// configuration file, and the zero value is StyleOpenAI so that an unconfigured
// route keeps behaving exactly as it did before this type existed.
type Style string

const (
	// StyleOpenAI is the chat completions shape: POST /chat/completions, a
	// `choices` array, `role: "tool"` results. DeepSeek, GLM and most gateways
	// speak it.
	StyleOpenAI Style = "openai"
	// StyleAnthropic is the Messages shape: POST /v1/messages, content blocks,
	// `system` at the top level. Claude and the Anthropic-compatible endpoints
	// of MiniMax, Qwen and others speak it.
	StyleAnthropic Style = "anthropic"
	// StyleResponses is the Responses shape: POST /v1/responses, an `input` item
	// array, `function_call` / `function_call_output` items.
	StyleResponses Style = "responses"
)

// StyleFromBaseURL infers the protocol from the endpoint path, and returns
// StyleOpenAI when nothing distinguishes it.
//
// **Why infer instead of demanding a required key.** The convention is reliable
// (`/v1/messages`, `/v1/responses`, `/chat/completions`) and the cost of being
// wrong is a mid-conversation HTTP error. Asking every user who wants an
// Anthropic endpoint to also declare what they just typed in the URL is asking
// them for a second chance to get it wrong — in a file where a misspelled value
// is refused, and where the two spellings of the endpoint (`.../apps/anthropic`
// versus `.../apps/anthropic/v1`) are one keystroke apart and produce a 404 the
// user cannot see the cause of.
//
// The `/anthropic` and `/apps/anthropic` forms are recognised as well as
// `/messages`, because the endpoint a person is given by the vendor's own
// documentation is a **base** URL: Qwen's is
// `https://{Workspace}/apps/anthropic`, and the vendor's FAQ warns that appending
// `/v1` to it produces a doubled path. A rule that only matched the fully spelled
// out endpoint would push those users back to writing `api_style` by hand, which
// is the thing this function exists to avoid.
//
// Note what this does *not* do: it does not strip a trailing `/v1` from the base
// URL. Whether that is a doubled path or the user's own prefix is not knowable
// here — the URL is what it is, and joining it to a path is the whole of this
// package's job.
func StyleFromBaseURL(baseURL string) Style {
	lower := strings.ToLower(strings.TrimRight(strings.TrimSpace(baseURL), "/"))
	switch {
	case strings.HasSuffix(lower, "/v1/messages"), strings.HasSuffix(lower, "/messages"),
		strings.HasSuffix(lower, "/anthropic"):
		return StyleAnthropic
	case strings.HasSuffix(lower, "/v1/responses"), strings.HasSuffix(lower, "/responses"):
		return StyleResponses
	default:
		return StyleOpenAI
	}
}

// NormalizeStyle maps the configured text onto a Style.
//
// An empty string means "not configured" and becomes StyleOpenAI; the caller is
// expected to have already substituted StyleFromBaseURL in that case. Anything
// else unrecognised is returned as-is so that the constructor can refuse it by
// name rather than silently treating a typo as the default.
func NormalizeStyle(text string) Style {
	return Style(strings.ToLower(strings.TrimSpace(text)))
}

// Route is everything needed to send a request to one endpoint.
//
// It exists so that the layer above does not have to know which fields this
// package needs. Before it, `Options` and `Install` took the credential, the
// endpoint, the model name and the route name as four separate strings, and the
// caller passed them field by field at two construction sites. Every new
// capability — a custom header, a second protocol, a transport flag — widened
// both signatures and both call sites, which meant the layer that is supposed to
// be shielded from the wire was the layer being edited. Handing over a Route
// instead keeps the decision ("which endpoint") above and the mechanism ("how to
// talk to it") below, and the two signatures stop moving.
type Route struct {
	// Name is the configured route name, for `/status` and for telling two
	// routes that carry the same model name apart.
	Name string
	// APIKey is the credential. How it is presented is the dialect's business:
	// a bearer token, an `x-api-key`, or nothing at all.
	APIKey string
	// BaseURL is where requests go, without the endpoint path.
	BaseURL string
	// Model is the model name sent in the request body.
	Model string
	// SessionID is the conversation this route is serving. It is substituted into
	// any configured header that contains SessionPlaceholder.
	//
	// It is a field of the route rather than a parameter of the request because it
	// changes exactly when the route changes — never — and because keeping it here
	// is what stops a vendor's per-conversation header from becoming a parameter
	// that every layer above has to thread through.
	SessionID string
	// Verify is kept from the configuration file. A transport that skips
	// certificate checks would be built from it; the default client verifies.
	Verify bool
	// Style is the wire protocol. The zero value is StyleOpenAI.
	Style Style
	// Headers are extra request headers, sent verbatim on every request. This is
	// the escape hatch for a vendor that asks for a custom User-Agent or a
	// session identifier.
	//
	// They are applied **before** the headers this package sets, so that a
	// configured header cannot silently displace `Authorization` or
	// `Content-Type` and produce an authentication failure that looks like a
	// credential problem.
	Headers map[string]string
}

// SessionPlaceholder is what a configured header writes where the session id
// should go.
//
// It exists so that a vendor's per-conversation header can be declared in the
// configuration file without this package knowing that vendor's name — and,
// conversely, without the configuration file having to name a session it cannot
// see. The configuration says which header, the program supplies the value:
//
//	"headers": {"x-opencode-session": "${session}"}
//
// A header whose rendered value is empty is never sent, so a route configured this
// way on a build with no session id sends nothing rather than sending the literal
// placeholder — which would be a session id of `${session}`, stable, meaningless,
// and shared by every user of this program.
const SessionPlaceholder = "${session}"

// sessionPlaceholderValue is the spelling used inside this package.
const sessionPlaceholderValue = SessionPlaceholder

// normalized returns the route with defaults filled in and whitespace trimmed.
func (r Route) normalized() Route {
	r.Name = strings.TrimSpace(r.Name)
	r.Model = strings.TrimSpace(r.Model)
	r.BaseURL = strings.TrimRight(strings.TrimSpace(r.BaseURL), "/")
	if r.Style == "" {
		r.Style = StyleFromBaseURL(r.BaseURL)
	}
	return r
}

// usable reports whether the route can carry a request at all. Style is
// deliberately not checked here; New refuses an unknown one by name.
func (r Route) usable() bool {
	return r.BaseURL != "" && r.Model != ""
}

// sameEndpoint reports whether two routes are the same endpoint, ignoring which
// model is being asked for.
//
// The model is deliberately excluded, and this is the distinction the two
// capabilities rest on: renaming a model on an unchanged endpoint is the cheap
// path (`SwitchModel`), and it stays cheap only if the question "is this another
// endpoint" is asked without the model in it. Everything else is compared,
// including the protocol and the extra headers — those change what kind of request
// goes out, so a route that gained a required header, or moved from chat
// completions to Messages, is another endpoint in every sense that matters.
func (r Route) sameEndpoint(other Route) bool {
	mine, theirs := r.normalized(), other.normalized()
	mine.Model, theirs.Model = "", ""
	// The session is excluded for the same reason the model is: it identifies the
	// conversation rather than the endpoint, and a route change made within one
	// session must not look like a move to a different endpoint. Two routes that
	// differ only in their session are the same place to send a request.
	mine.SessionID, theirs.SessionID = "", ""
	return reflect.DeepEqual(mine, theirs)
}
