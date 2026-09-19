// Command probereachable asks every model in a configuration whether it answers.
//
// It exists because a catalogue entry is a claim, not a fact. A model can be listed
// by the vendor and still be refused for this account — a region restriction, an
// opt-in that was never given, a deprecated id, or a plan that does not include it
// — and the only place that becomes visible is the request. What is printed for each
// one is the status and what the call cost, so that a check across a whole file can
// be judged on its price as well as its result.
//
// Give it model names to check a subset; with none it walks the whole file.
//
// It is a tool for working on this repository, and it spends real quota.
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
		fmt.Fprintln(os.Stderr, "usage: probereachable <config.json> <session-id> [model]...")
		os.Exit(2)
	}
	path, session := os.Args[1], os.Args[2]
	only := map[string]bool{}
	for _, name := range os.Args[3:] {
		only[name] = true
	}

	registry, err := state.Load(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "the configuration was refused: %v\n", err)
		os.Exit(1)
	}

	total := model.TokenUsage{}
	var answered, refused, unreached int

	for _, provider := range registry.Providers {
		wanted := selected(provider, only)
		if len(wanted) == 0 {
			continue
		}
		fmt.Printf("\n=== %s  (%s)\n", provider.Name, styleName(provider))
		if !provider.Usable() {
			fmt.Println("    skipped: no API key")
			continue
		}

		for _, entry := range wanted {
			adapter, err := model.New(model.Options{
				Route: model.Route{
					Name: provider.Name, APIKey: provider.APIKey, BaseURL: provider.BaseURL,
					Model: entry.ID, SessionID: session, Verify: provider.Verify,
					Style:   model.NormalizeStyle(provider.APIStyle),
					Headers: provider.Headers,
				},
				// The program's default, so what is measured is what a session sends.
				Thinking: true, Effort: "low",
			})
			if err != nil {
				fmt.Printf("    %-28s REFUSED BY THE MODEL LAYER: %v\n", entry.ID, err)
				refused++
				continue
			}

			usage, verdict := ask(adapter)
			if usage != nil {
				total.PromptTokens += usage.PromptTokens
				total.CompletionTokens += usage.CompletionTokens
				total.CachedTokens += usage.CachedTokens
			}
			switch verdict {
			case verdictAnswered:
				answered++
			case verdictRefused:
				refused++
			default:
				unreached++
			}
			fmt.Printf("    %-28s %s\n", entry.ID, verdictText(verdict, usage))
		}
	}

	fmt.Printf("\n--- %d answered, %d refused, %d not reached\n", answered, refused, unreached)
	fmt.Printf("--- spent: prompt=%d (cached=%d) completion=%d\n",
		total.PromptTokens, total.CachedTokens, total.CompletionTokens)
}

// selected is the models of one route that were asked for, or all of them when
// nothing specific was named.
func selected(provider state.Provider, only map[string]bool) []state.ModelRef {
	if len(only) == 0 {
		return provider.Models
	}
	var out []state.ModelRef
	for _, entry := range provider.Models {
		if only[entry.ID] {
			out = append(out, entry)
		}
	}
	return out
}

type verdict int

const (
	verdictAnswered verdict = iota
	verdictRefused
	verdictUnreachable
)

// ask sends one minimal request and reports what happened.
//
// The prompt asks for a one-word answer, which is the smallest thing that still
// produces text: a model that is reachable but silent is a different problem from
// one that is not reachable, and the two must not be reported the same way.
func ask(adapter *model.OpenAICompatible) (*model.TokenUsage, verdict) {
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 3 * time.Second)
		}
		response, err := adapter.Complete([]map[string]any{
			{"role": "user", "content": "Reply with the single word: ok"},
		}, nil, model.CompleteOptions{})
		if err == nil {
			if response.Content == nil && len(response.ToolCalls) == 0 {
				// Reachable, and it said nothing. Not a refusal, and not a pass.
				return response.Usage, verdictUnreachable
			}
			return response.Usage, verdictAnswered
		}
		if !isTransport(err) {
			return nil, verdictRefused
		}
	}
	return nil, verdictUnreachable
}

// isTransport separates "the request never got an answer" from "the endpoint
// answered with a refusal". Only the first is worth retrying.
func isTransport(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "TLS handshake") ||
		strings.Contains(message, "connection reset") ||
		strings.Contains(message, "EOF") ||
		strings.Contains(message, "timeout awaiting response") ||
		strings.Contains(message, "no such host")
}

func verdictText(v verdict, usage *model.TokenUsage) string {
	cost := "-"
	if usage != nil {
		cost = fmt.Sprintf("%d+%d tok", usage.PromptTokens, usage.CompletionTokens)
	}
	switch v {
	case verdictAnswered:
		return "ok            (" + cost + ")"
	case verdictRefused:
		return "REFUSED       (the endpoint answered with an error)"
	default:
		return "NOT REACHED   (no answer; the network, not the model)"
	}
}

func styleName(provider state.Provider) string {
	if provider.APIStyle != "" {
		return provider.APIStyle
	}
	return string(model.StyleFromBaseURL(provider.BaseURL)) + ", inferred"
}
