// Command probeconfig exercises the real path end to end: it reads a configuration
// file through the same catalogue reader the program uses, builds an adapter for one
// route exactly the way the runtime does, and sends one small request.
//
// It exists because every other probe builds its route by hand, which means every
// other probe tests the model package and not the wiring. The wiring is where the
// mistakes that reach a user live: a route whose protocol was inferred wrong, a
// header the configuration declared but nothing substituted, a key that never
// arrived. Only a run that starts from the file can catch those.
//
// It is a tool for working on this repository, and it spends quota.
package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: probeconfig <config.json> <session-id> [route]")
		os.Exit(2)
	}
	path, session := os.Args[1], os.Args[2]
	only := ""
	if len(os.Args) > 3 {
		only = os.Args[3]
	}

	registry, err := state.Load(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "the configuration was refused: %v\n", err)
		os.Exit(1)
	}

	for _, provider := range registry.Providers {
		if only != "" && provider.Name != only {
			continue
		}
		if !provider.Usable() || len(provider.Models) == 0 {
			fmt.Printf("route %-22s skipped (no key or no models)\n", provider.Name)
			continue
		}

		// The route is built the way `routeOf` builds it, including the session id
		// and the raw configured headers 鈥?the placeholder is left in place so that
		// the substitution under test is the program's, not this tool's.
		chosen := provider.Models[0].ID
		adapter, err := model.New(model.Options{
			Route: model.Route{
				Name: provider.Name, APIKey: provider.APIKey, BaseURL: provider.BaseURL,
				Model: chosen, SessionID: session, Verify: provider.Verify,
				Style:   model.NormalizeStyle(provider.APIStyle),
				Headers: provider.Headers,
			},
			Thinking: true, Effort: "low",
		})
		if err != nil {
			fmt.Printf("route %-22s REFUSED by the model layer: %v\n", provider.Name, err)
			continue
		}

		fmt.Printf("\n=== route %s  style=%s  model=%s\n", provider.Name, adapter.Route().Style, chosen)
		fmt.Printf("    headers configured: %v\n", sortedPairs(provider.Headers))

		// Transient transport failures are retried, and the outcome is stated
		// either way. A probe that reports "FAILED" for a TLS handshake timeout is
		// reporting the network, not the code, and leaving that ambiguous is how a
		// working integration gets "fixed" until it breaks.
		response, err := withRetries(func() (model.ModelResponse, error) {
			return adapter.Complete(prompt(), nil, model.CompleteOptions{})
		})
		if err != nil {
			fmt.Printf("    unary NOT VERIFIED (%s): %v\n", transientLabel(err), err)
			continue
		}
		fmt.Printf("    unary ok: content=%s\n", quote(response.Content))
		fmt.Printf("    usage: %s\n", usageText(response.Usage))

		var text strings.Builder
		streamed, err := withRetries(func() (model.ModelResponse, error) {
			text.Reset()
			return adapter.Complete(prompt(), nil, model.CompleteOptions{
				OnDelta: func(chunk, reasoning string) { text.WriteString(chunk) },
			})
		})
		if err != nil {
			fmt.Printf("    stream NOT VERIFIED (%s): %v\n", transientLabel(err), err)
			continue
		}
		fmt.Printf("    stream ok: chunks=%d text=%s\n", streamed.StreamChunks, quoteText(text.String()))
		fmt.Printf("    stream usage: %s\n", usageText(streamed.Usage))
	}
}

func prompt() []map[string]any {
	return []map[string]any{
		{"role": "system", "content": "Answer in one short sentence."},
		{"role": "user", "content": "Say the word: pong"},
	}
}

// withRetries retries a call whose failure is a transport problem rather than an
// answer. It is deliberately narrow: an HTTP error is a result and is returned at
// once, because retrying a 401 or a 400 only spends more quota to be told the same
// thing.
func withRetries(call func() (model.ModelResponse, error)) (model.ModelResponse, error) {
	var last error
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 3 * time.Second)
		}
		response, err := call()
		if err == nil {
			return response, nil
		}
		if !isTransport(err) {
			return model.ModelResponse{}, err
		}
		last = err
	}
	return model.ModelResponse{}, last
}

// isTransport separates "the request never got an answer" from "the endpoint
// answered with a refusal".
func isTransport(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "TLS handshake") ||
		strings.Contains(message, "connection reset") ||
		strings.Contains(message, "EOF") ||
		strings.Contains(message, "timeout awaiting response")
}

func transientLabel(err error) string {
	if isTransport(err) {
		return "transport, not a refusal"
	}
	return "the endpoint refused"
}

func sortedPairs(headers map[string]string) string {
	if len(headers) == 0 {
		return "(none)"
	}
	parts := make([]string, 0, len(headers))
	for name, value := range headers {
		parts = append(parts, name+"="+value)
	}
	// Sorted so two runs are comparable by eye.
	for i := 1; i < len(parts); i++ {
		for j := i; j > 0 && parts[j] < parts[j-1]; j-- {
			parts[j], parts[j-1] = parts[j-1], parts[j]
		}
	}
	return strings.Join(parts, " ")
}

func quote(text *string) string {
	if text == nil {
		return "<nil>"
	}
	return quoteText(*text)
}

func quoteText(text string) string {
	trimmed := strings.TrimSpace(text)
	if len(trimmed) > 100 {
		trimmed = trimmed[:100] + "..."
	}
	return fmt.Sprintf("%q", trimmed)
}

func usageText(usage *model.TokenUsage) string {
	if usage == nil {
		return "<none>"
	}
	return fmt.Sprintf("prompt=%d cached=%d completion=%d", usage.PromptTokens, usage.CachedTokens, usage.CompletionTokens)
}
