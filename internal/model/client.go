package model

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/proxy"
)

// streamUsageOption asks the gateway to report token usage on a streamed request.
// Without it a streamed call has no usage block at all.
const streamUsageOption = `"stream_options":{"include_usage":true}`

// unsupportedStreamOptions remembers which (base_url, model) pairs have proved
// they reject `stream_options`.
//
// Why process-wide: knowledge bought with one 400 has to be kept, otherwise
// **every** model call pays a wasted round trip to rediscover it. The key is
// (base_url, model) rather than an instance, because switching sessions rebuilds
// the client and "does this gateway accept this parameter" has nothing to do with
// a session.
//
// Why not a configuration option: this is a discovered fact, not a preference.
// Asking a person to write "does my gateway support include_usage" means the wrong
// answer fails once per turn.
var (
	unsupportedMu   sync.Mutex
	unsupportedOpts = map[string]bool{}
)

func streamOptionsKey(baseURL, model string) string { return baseURL + "\x00" + model }

func streamOptionsSupported(baseURL, model string) bool {
	unsupportedMu.Lock()
	defer unsupportedMu.Unlock()
	return !unsupportedOpts[streamOptionsKey(baseURL, model)]
}

func rememberStreamOptionsUnsupported(baseURL, model string) {
	unsupportedMu.Lock()
	defer unsupportedMu.Unlock()
	unsupportedOpts[streamOptionsKey(baseURL, model)] = true
}

// unsupportedThinking remembers which (base_url, model) pairs have proved they
// reject an explicit "do not think" instruction.
//
// It is the same bargain as the stream_options memory above, and it exists because
// of a measured incompatibility rather than a guess: a thinking-only model answers
// 400 to `reasoning_effort: "none"` **and** to `thinking: {"type": "disabled"}`,
// with a message saying so. Such a model cannot be told to stop thinking — the only
// request it accepts is one that says nothing about reasoning at all.
//
// So the request is sent with the instruction first, and on that specific refusal
// it is sent again without it. The alternative — never sending the instruction —
// would make `/thinking off` a silent no-op on every model that merely *defaults*
// to thinking on: the display would say off while the request still asked for high,
// and the bill would show it.
var (
	thinkingMu       sync.Mutex
	unsupportedThink = map[string]bool{}
)

func thinkingInstructionSupported(baseURL, model string) bool {
	thinkingMu.Lock()
	defer thinkingMu.Unlock()
	return !unsupportedThink[streamOptionsKey(baseURL, model)]
}

func rememberThinkingInstructionUnsupported(baseURL, model string) {
	thinkingMu.Lock()
	defer thinkingMu.Unlock()
	unsupportedThink[streamOptionsKey(baseURL, model)] = true
}

// OpenAICompatible talks to a chat endpoint. Which wire protocol that is comes
// from the route's Style; the name is kept because it is the honest description of
// the family this adapter belongs to and of the default it falls back to.
type OpenAICompatible struct {
	client *http.Client
	route  Route

	thinking bool
	effort   string
}

// Options configures a new adapter.
//
// It embeds the Route rather than repeating its fields. The caller chooses an
// endpoint and hands it over whole; which parts of it this package needs is not
// the caller's business, and was the reason two construction sites had to be
// edited every time a capability was added.
type Options struct {
	Route
	Thinking bool
	Effort   string
	Client   *http.Client
	// Timeout is how long one request may take. A streamed answer can legitimately
	// take minutes, so this is generous.
	Timeout time.Duration
}

// New creates an adapter.
//
// It returns an error only for a route that cannot be used at all — an unknown
// protocol, or a missing endpoint or model. Building an adapter for a route with
// no key is allowed: "no key" is a fact the catalogue reports about a route, not a
// reason the process cannot start.
func New(options Options) (*OpenAICompatible, error) {
	route := options.Route.normalized()
	if !route.usable() {
		return nil, AsFatal("a route needs both a base_url and a model name")
	}
	if _, err := dialectFor(route.Style); err != nil {
		return nil, err
	}

	client := options.Client
	if client == nil {
		timeout := options.Timeout
		if timeout == 0 {
			timeout = 10 * time.Minute
		}
		// The transport is built rather than defaulted so that the machine's own
		// proxy setting is followed. Go's zero-value transport reads only the
		// environment, which on Windows is not where the browser reads it from —
		// see internal/proxy for what that cost.
		transport, _ := proxy.Transport()
		client = &http.Client{Timeout: timeout, Transport: transport}
	}
	return &OpenAICompatible{
		client:   client,
		route:    route,
		thinking: options.Thinking,
		effort:   options.Effort,
	}, nil
}

// Route is the endpoint in use, as a value.
func (m *OpenAICompatible) Route() Route { return m.route }

// SameEndpoint reports whether another route reaches the same endpoint.
func (m *OpenAICompatible) SameEndpoint(other Route) bool { return m.route.sameEndpoint(other) }

// ModelName is the model in use.
func (m *OpenAICompatible) ModelName() string { return m.route.Model }

// ProviderName is the route in use.
func (m *OpenAICompatible) ProviderName() string { return m.route.Name }

// BaseURL is where requests go.
func (m *OpenAICompatible) BaseURL() string { return m.route.BaseURL }

// SwitchModel changes the model for subsequent requests.
func (m *OpenAICompatible) SwitchModel(name string) bool {
	if strings.TrimSpace(name) == "" {
		return false
	}
	m.route.Model = strings.TrimSpace(name)
	return true
}

// apiKeyOf is the key this adapter currently sends.
//
// It exists so the runtime can tell "the same route, a different model" from
// "another route", which is the same test the previous generation made. The key is
// the identifier that matters: two routes can share a base_url and differ only in
// which tenant they bill.
func (m *OpenAICompatible) apiKeyOf() string { return m.route.APIKey }

// Install moves to another route: key, endpoint, model name and route name.
//
// The HTTP client is deliberately kept. It never carried the key — that goes in a
// per-request header — and its connection pool is worth reusing. An implementation
// whose credentials live inside the client would rebuild it here instead.
//
// The whole Route moves, including the protocol and the extra headers. That is
// the difference between this and SwitchModel, and it is why the two are separate:
// a rename changes one request field, while a route change changes what kind of
// request goes out. Applying only part of one — the endpoint without the
// protocol, the model without the headers — leaves the interface, the session and
// the audit describing a route that is not the one being talked to.
func (m *OpenAICompatible) Install(route Route) bool {
	next := route.normalized()
	if !next.usable() {
		return false
	}
	if next.Name == "" {
		next.Name = m.route.Name
	}
	// A refused install must leave the adapter exactly as it was, so everything
	// that can be refused is checked before anything is written.
	if _, err := dialectFor(next.Style); err != nil {
		return false
	}
	m.route = next
	return true
}

// SetReasoning updates the two thinking knobs.
func (m *OpenAICompatible) SetReasoning(thinking bool, effort string) {
	m.thinking = thinking
	m.effort = effort
}

// Complete runs one request, streaming when a sink is present.
//
// The stream is only requested when somebody is reading it. A streamed request
// nobody consumes costs the same and delivers less, and asking for `stream` in the
// body is itself observable in the audit.
//
// Two refusals are recoverable, and both are handled here rather than in the caller
// because both are properties of the endpoint that were only discoverable by
// asking it: `stream_options` on a gateway that does not know the parameter, and an
// explicit "do not think" instruction on a model that has no way to comply. Each is
// tried once, remembered, and dropped for the retry.
func (m *OpenAICompatible) Complete(messages []map[string]any, tools []map[string]any, options CompleteOptions) (ModelResponse, error) {
	promise := m.knobs()
	attempted := map[string]bool{}

	for {
		// The recorded state is consulted per attempt rather than per session: a
		// refusal just remembered in this loop has to affect the retry below.
		knobs := promise
		if !thinkingInstructionSupported(m.route.BaseURL, m.route.Model) {
			knobs = ReasoningKnobs{Thinking: false, Effort: promise.Effort, omit: true}
		}

		response, err := m.completeOnce(messages, tools, options.OnDelta, options.ShouldStop, knobs)
		if err == nil {
			return response, nil
		}
		// A cancelled turn is not a failure to retry. Retrying it would send the
		// request again after the user asked for it to stop.
		if IsCancelled(err) {
			return ModelResponse{}, err
		}

		if isThinkingInstructionRejection(err) && !attempted["thinking"] {
			attempted["thinking"] = true
			rememberThinkingInstructionUnsupported(m.route.BaseURL, m.route.Model)
			if options.OnAttemptStarted != nil {
				options.OnAttemptStarted()
			}
			continue
		}

		// A gateway that rejects `stream_options` cannot report usage while
		// streaming. Drop the parameter, remember it, and send the request again —
		// the text that already reached the screen is kept, and the caller is told
		// to discard its copy through OnAttemptStarted so the restatement does not
		// read as the model saying everything twice.
		if isStreamOptionsRejection(err) && !attempted["stream_options"] {
			attempted["stream_options"] = true
			rememberStreamOptionsUnsupported(m.route.BaseURL, m.route.Model)
			if options.OnAttemptStarted != nil {
				options.OnAttemptStarted()
			}
			continue
		}
		return ModelResponse{}, err
	}
}

// streamOptionsRejection marks a 400 that is specifically about stream_options.
type streamOptionsRejection struct{ Msg string }

func (e *streamOptionsRejection) Error() string { return e.Msg }

func isStreamOptionsRejection(err error) bool {
	_, ok := err.(*streamOptionsRejection)
	return ok
}

// thinkingInstructionRejection marks a 400 that is specifically about being asked
// not to think.
type thinkingInstructionRejection struct{ Msg string }

func (e *thinkingInstructionRejection) Error() string { return e.Msg }

func isThinkingInstructionRejection(err error) bool {
	_, ok := err.(*thinkingInstructionRejection)
	return ok
}

// knobs is the reasoning request this adapter was configured with.
func (m *OpenAICompatible) knobs() ReasoningKnobs {
	return ReasoningKnobs{Thinking: m.thinking, Effort: m.effort}
}

// protocol is the dialect for the route as it stands right now.
//
// It is looked up per request rather than cached, because `Install` may have
// moved the adapter to another protocol since the last call and a cached dialect
// would keep speaking the old one — the exact divergence the Route type exists to
// make impossible.
func (m *OpenAICompatible) protocol() (dialect, error) {
	return dialectFor(m.route.Style)
}

func (m *OpenAICompatible) completeOnce(messages []map[string]any, tools []map[string]any, sink DeltaSink, shouldStop func() bool, knobs ReasoningKnobs) (ModelResponse, error) {
	codec, err := m.protocol()
	if err != nil {
		return ModelResponse{}, err
	}

	body, err := codec.encode(dialectRequest{
		model:    m.route.Model,
		messages: messages,
		tools:    tools,
		stream:   sink != nil,
		knobs:    knobs,
		// Asked for only when the protocol has the parameter at all, and only
		// while this gateway has not already refused it. Both halves are needed:
		// the first stops the Messages shape from being sent a chat completions
		// parameter, the second stops a known-refusing gateway from being asked
		// once per turn.
		includeStreamUsage: sink != nil &&
			codec.wantsStreamOptions() &&
			streamOptionsSupported(m.route.BaseURL, m.route.Model),
	})
	if err != nil {
		return ModelResponse{}, err
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return ModelResponse{}, AsFatal("cannot encode the request: %v", err)
	}

	endpoint := endpointURL(m.route.BaseURL, codec.path())
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return ModelResponse{}, AsFatal("cannot build the request: %v", err)
	}

	// The route's own headers go first, so that nothing configured can displace
	// the headers this package is responsible for. A route that overwrote the
	// credential header would produce an authentication failure whose cause is
	// three files away from the message.
	for name, value := range m.templateHeaders() {
		request.Header.Set(name, value)
	}
	request.Header.Set("Content-Type", "application/json")
	if m.route.APIKey != "" {
		// Which header carries the credential, and in what form, is the protocol's
		// business: the Messages shape wants `x-api-key`, and a bearer token sent to
		// it is answered with "Missing API key".
		request.Header.Set(codec.credentialHeader(), credentialValue(codec.credentialHeader(), m.route.APIKey))
	}
	if sink != nil {
		request.Header.Set("Accept", "text/event-stream")
	}

	response, err := m.client.Do(request)
	if err != nil {
		return ModelResponse{}, AsTransient("%v", err)
	}
	defer response.Body.Close()

	if response.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		return ModelResponse{}, classifyHTTPError(response.StatusCode, string(raw), endpoint, codec.wantsStreamOptions())
	}

	if sink == nil {
		raw, err := io.ReadAll(response.Body)
		if err != nil {
			return ModelResponse{}, AsTransient("cannot read the response: %v", err)
		}
		return codec.parseUnary(raw)
	}
	return codec.parseStream(response.Body, sink, shouldStop)
}

// credentialHeaderBearer is where a credential goes unless a protocol says
// otherwise.
const credentialHeaderBearer = "Authorization"

// templateHeaders renders the route's configured headers for this request.
//
// Two rules, and both of them are about a failure that is invisible from here:
//
//   - A value containing the session placeholder is replaced by the session id.
//     This is how a vendor's per-conversation header is written in the
//     configuration file without the model package having to know that vendor's
//     name: the configuration says **which** header, and the program supplies
//     **what goes in it**.
//   - A header whose value is empty is **not sent at all**. Sending
//     `x-opencode-session:` with nothing after it is worse than omitting it: a
//     gateway reads that as a client claiming a session and then failing to name
//     one, which is a different thing from a client that does not do sessions —
//     and one of those is treated as a defect in the caller.
func (m *OpenAICompatible) templateHeaders() map[string]string {
	if len(m.route.Headers) == 0 {
		return nil
	}
	out := make(map[string]string, len(m.route.Headers))
	for name, value := range m.route.Headers {
		rendered := value
		if strings.Contains(rendered, sessionPlaceholderValue) {
			if m.route.SessionID == "" {
				// Nothing to substitute. The header is dropped below rather than
				// sent with a literal placeholder in it, which would be a session id
				// of `${session}` — stable, meaningless, and shared by every user of
				// this program.
				rendered = ""
			} else {
				rendered = strings.ReplaceAll(rendered, sessionPlaceholderValue, m.route.SessionID)
			}
		}
		if rendered == "" {
			continue
		}
		out[name] = rendered
	}
	return out
}

// credentialValue renders a credential for the header that will carry it.
//
// The two are decided together, because they are not independent: the
// `Authorization` header takes a scheme-qualified `Bearer <key>`, while a vendor
// header that names the credential itself (`x-api-key`) takes the bare value.
// Measured against a real Messages endpoint, `x-api-key: Bearer sk-…` does **not**
// authenticate; only the bare form does.
func credentialValue(header, apiKey string) string {
	if header == credentialHeaderBearer {
		return "Bearer " + apiKey
	}
	return apiKey
}

// endpointURL joins a base URL and an endpoint path.
//
// A trailing slash on the base is dropped, and exactly one slash is put back, so
// that `https://host/v1/` and `https://host/v1` both reach `https://host/v1/...`.
// Nothing else is normalised: whether a base ending in `/v1` should be plus
// `/v1/messages` or plus `/messages` cannot be answered from here — the
// configuration is the one source of truth about what the endpoint is, and the
// model package's job is to append a path to it.
func endpointURL(baseURL, path string) string {
	return strings.TrimRight(baseURL, "/") + path
}

// classifyHTTPError maps a failing response onto the two domain classes.
//
// The split matters because the handling is completely different: a transient
// failure is worth backing off and retrying, a permanent one only repeats the same
// failure three times.
func classifyHTTPError(status int, body string, endpoint string, streamOptionsPossible bool) error {
	trimmed := strings.TrimSpace(body)
	if len(trimmed) > 600 {
		// Cut back to a character boundary before slicing. These endpoints answer
		// a bad request in Chinese, so byte 600 lands inside a rune roughly half
		// the time, and an error string with an invalid tail travels into the
		// audit and onto the screen as mojibake.
		cut := 600
		for cut > 0 && !utf8.RuneStart(trimmed[cut]) {
			cut--
		}
		trimmed = trimmed[:cut] + "…"
	}
	summary := fmt.Sprintf("HTTP %d from %s: %s", status, endpoint, trimmed)

	if status == 400 {
		lower := strings.ToLower(body)
		// The retry only exists for a protocol that has such a parameter in the
		// first place. Without this guard, an endpoint that merely mentions the words
		// while refusing something else would be sent the request a second time to
		// earn the same error.
		if streamOptionsPossible &&
			(strings.Contains(lower, "stream_options") || strings.Contains(lower, "include_usage")) {
			return &streamOptionsRejection{Msg: summary}
		}
		if isThinkingRefusal(lower) {
			return &thinkingInstructionRejection{Msg: summary}
		}
	}

	switch {
	case status == 408 || status == 409 || status == 429 || status >= 500:
		return AsTransient("%s", summary)
	default:
		return AsFatal("%s", summary)
	}
}

// isThinkingRefusal recognises the refusal a model gives when it cannot be told not
// to think.
//
// The wording is the endpoint's and is matched narrowly, because a broad match on the
// word "thinking" would also catch a genuine rejection of the *enabled* form — a
// different problem, and one that retrying cannot fix. Three phrasings have been
// observed on real endpoints, and they are listed with what produced them:
//
//	"GLM-5.3 is a thinking-only model; disabling thinking
//	 (reasoning_effort='none') is not supported"        — measured on glm-5.3, glm-5.2
//	"invalid thinking: only type=enabled is allowed
//	 for this model"                                    — measured on kimi-k2.7-code
//
// The parameter name is matched too, because that is how the same refusal is worded
// when it does not use either phrase, and because `reasoning_effort` exists for this
// switch and nothing else.
func isThinkingRefusal(lowerBody string) bool {
	switch {
	case strings.Contains(lowerBody, "thinking-only"),
		strings.Contains(lowerBody, "thinking only"),
		strings.Contains(lowerBody, "disabling thinking"),
		strings.Contains(lowerBody, "cannot disable thinking"),
		strings.Contains(lowerBody, "only type=enabled"),
		strings.Contains(lowerBody, "reasoning_effort"):
		return true
	default:
		return false
	}
}
