package model

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

// ProbeOutcome is what one ask of an endpoint means about a level.
//
// Three rather than two: "the endpoint does not take this level" is a fact the
// endpoint volunteered, but "the endpoint did not answer" is not a refusal and
// must not be reported as one. A rate limit that lands on the fourth of six
// probes would otherwise read as "xhigh does not exist", which is the exact
// wrong sentence to write into the configuration file.
type ProbeOutcome string

const (
	ProbeOK        ProbeOutcome = "ok"
	ProbeRejected  ProbeOutcome = "rejected"
	ProbeUncertain ProbeOutcome = "uncertain"
)

// probeTimeout caps one ask. A probe at a high level may spend real thinking
// time before it answers, but "thinking" without an answer for a minute is a
// hung endpoint rather than a deep one — and six of them in a row must not hold
// the person's panel open for the client's ten-minute budget.
const probeTimeout = 60 * time.Second

// probeThinkingFloor and probeAnswerRoom are the probe's numbers, and they live
// here rather than beside the one dialect that needs the floor: **all three
// wires** send the answer room, and the floor is the Messages shape's constraint
// on it. Keeping both in one place is what stops the two from drifting into a
// request the Messages shape refuses (`max_tokens` must **exceed**
// `thinking.budget_tokens`), which would read as "this level does not exist".
//
// The floor is the protocol's smallest thinking budget: the probe still asks for
// thinking (a level an endpoint takes only while thinking is not a level), but
// at the smallest budget the shape allows. The answer room is small for the
// reason the probe exists — an ask whose only job is to be refused or not should
// not buy a full answer.
const (
	probeThinkingFloor = 1024
	probeAnswerRoom    = 128
)

// probeRefusalWords is what a level refusal looks like in the endpoint's own
// words.
//
// Matched as a pair — a parameter name and a word of complaint — rather than
// on the parameter alone, for the reason `isThinkingRefusal` gives about
// `reasoning_effort`: it is the vocabulary endpoints use for **other** problems
// too (a required thinking replay, a missing history field), and a broad match
// would read those as "the level does not exist". Every 400 that does not
// carry both halves stays uncertain, and the uncertain column is where a wrong
// guess about a level is less harmful than a wrong deletion of one.
var probeRefusalWords = [][2]string{
	{"reasoning_effort", "not supported"},
	{"reasoning_effort", "unsupported"},
	{"reasoning_effort", "invalid"},
	{"reasoning_effort", "does not accept"},
	{"reasoning_effort", "unrecognized"},
	{"effort", "not supported"},
	{"effort", "unsupported value"},
	{"effort", "invalid"},
	{"thinking", "invalid"},
}

// ProbeEffort asks the endpoint one small request at one reasoning level and
// reports whether that level is taken.
//
// It is a deliberate sibling of `Complete` rather than a call into it:
//
//   - `Complete` pads the output room to the thinking budget (`maxOutputTokens`
//     is budget-plus-eight-thousand), which is a real spend on every probe;
//   - its three retries are recoveries for a *turn* — a request that must get
//     through no matter what the endpoint objects to — and a probe whose job is
//     to hear the objection would learn nothing by refusing to listen to it;
//   - its refusal memories (`stream_options`, the thinking instruction, the
//     replay) are learned per turn, and a probe writing into them would turn one
//     400 about a level into a process-wide fact about the endpoint.
//
// What a probe spends is therefore **one real request per level** and not a
// "smallest legal shape" on every wire: the Messages and Responses shapes can
// cap the answer (see dialectRequest.probe), while chat completions cannot —
// its output room stays the endpoint's default. That is why the panel asks the
// person before it sends, rather than promising a small bill.
//
// The session's route and headers are sent unchanged, because they are part of
// what is being asked: an endpoint that only takes a level behind a custom
// header must probe the same way it will be called.
func (m *OpenAICompatible) ProbeEffort(level string) (ProbeOutcome, error) {
	route := m.Route()
	codec, err := dialectFor(route.Style)
	if err != nil {
		return ProbeUncertain, err
	}
	return m.probeOnce(codec, route, level)
}

// ProbeCarriesLevel reports whether this adapter's wire can be asked about a
// level **as a level**.
//
// The caller is the effort panel's probe, and the false answer is what keeps the
// panel honest on the Messages shape: there the level is translated here into a
// thinking budget, and a probe's budget is the protocol floor, so the wire never
// sees the word. Six asks would return the same answer six times and the panel
// would draw six findings. See the dialect interface's probeCarriesLevel.
func (m *OpenAICompatible) ProbeCarriesLevel() bool {
	codec, err := dialectFor(m.Route().Style)
	if err != nil {
		return true
	}
	return codec.probeCarriesLevel()
}

func (m *OpenAICompatible) probeOnce(codec dialect, route Route, level string) (ProbeOutcome, error) {
	body, err := codec.encode(dialectRequest{
		model:    route.Model,
		messages: []map[string]any{{"role": "user", "content": "Reply with one word."}},
		knobs:    ReasoningKnobs{Thinking: true, Effort: level},
		images:   m.images,
		// Tell the dialect this is a probe rather than a turn: it caps the answer
		// where its wire allows it, instead of sending the turn's output rules
		// (a full thinking budget plus its allowance). See dialectRequest.probe
		// for why chat completions sends no cap.
		probe: true,
	})
	if err != nil {
		return ProbeUncertain, err
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return ProbeUncertain, AsFatal("cannot encode the probe request: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpointURL(route.BaseURL, codec.path()), strings.NewReader(string(payload)))
	if err != nil {
		return ProbeUncertain, AsFatal("cannot build the probe request: %v", err)
	}
	// The route's headers first, then the credential — the same order
	// `completeOnce` keeps, for the same reason: nothing configured may
	// displace the headers this package is responsible for.
	for name, value := range templateHeaders(route) {
		request.Header.Set(name, value)
	}
	request.Header.Set("Content-Type", "application/json")
	if route.APIKey != "" {
		request.Header.Set(codec.credentialHeader(), credentialValue(codec.credentialHeader(), route.APIKey))
	}

	response, err := m.client.Do(request)
	if err != nil {
		// No answer at all. Context deadline included: a probe that did not
		// arrive is not a refusal of the level, and classifying it one would
		// delete a level from the file on a network blip.
		return ProbeUncertain, AsTransient("%v", err)
	}
	defer response.Body.Close()

	// **2xx only.** A probe reads "the endpoint took this level" from the fact
	// that it ran the request and answered — a 3xx that was not followed (a
	// redirect to a login page, a gateway's HTML) proves nothing about the
	// level, and neither does a 200-shaped envelope that carries an error.
	// Everything else falls through to the two readings below.
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return ProbeOK, nil
	}
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	text := string(raw)
	if statusIsLevelRefusal(response.StatusCode, text) {
		return ProbeRejected, nil
	}
	// Uncertain, with the endpoint's own sentence: it is the one thing that
	// tells an upstream error from a timeout from a dead key.
	return ProbeUncertain, probeFailureSummary(response.StatusCode, text)
}

// statusIsLevelRefusal reads one failing response as an answer about a level.
//
// Only a 400 that names the parameter and complains about its **value** is a
// refusal of the level. Everything else — authentication, a rate limit, an
// upstream error, a 400 about the request shape — is not, because the only
// thing an uncertain is allowed to do is show up in a column the person can
// read, and that is less wrong than a deletion.
func statusIsLevelRefusal(status int, body string) bool {
	return status == 400 && namesLevelRefusal(body)
}

// probeFailureSummary is the sentence an uncertain carries: the endpoint's own
// words, cut to what a row can hold.
func probeFailureSummary(status int, body string) error {
	trimmed := strings.TrimSpace(body)
	if len(trimmed) > 300 {
		cut := 300
		for cut > 0 && !utf8.RuneStart(trimmed[cut]) {
			cut--
		}
		trimmed = trimmed[:cut] + "…"
	}
	// **5xx is transient, not fatal.** A server error is precisely the class a
	// second attempt may not meet again, and the comment here used to claim the
	// opposite. What is fatal is a 4xx the endpoint will answer the same way
	// next time — a dead key, a forbidden route, a bad request — minus the ones
	// that name their own retry: 408 (timeout), 409 (conflict), 429 (rate
	// limit). Nothing in the panel reads the class today; it is carried so that
	// the first caller that does is not handed the wrong answer.
	fatal := status >= 400 && status < 500 && status != 408 && status != 409 && status != 429
	summary := fmt.Sprintf("HTTP %d: %s", status, trimmed)
	if fatal {
		return AsFatal("%s", summary)
	}
	return AsTransient("%s", summary)
}

func namesLevelRefusal(body string) bool {
	lower := strings.ToLower(body)
	for _, pair := range probeRefusalWords {
		if strings.Contains(lower, pair[0]) && strings.Contains(lower, pair[1]) {
			return true
		}
	}
	return false
}
