// Command checkconfig loads a configuration through the real catalogue reader and
// prints what it found, so that a hand-edited file can be validated without
// starting a session.
//
// It exists because `state.Load` is the only thing that actually decides whether a
// configuration is usable — every rule (unknown keys, api_style values, header
// types, duplicate model ids) lives there — and a person editing JSON by hand has
// no way to ask it a question. It is a tool for working on this repository, not a
// user-facing command.
package main

import (
	"fmt"
	"os"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/model"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: checkconfig <config.json>")
		os.Exit(2)
	}
	registry, err := state.Load(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "REFUSED: %v\n", err)
		os.Exit(1)
	}

	for _, provider := range registry.Providers {
		style := provider.APIStyle
		if style == "" {
			style = string(model.StyleFromBaseURL(provider.BaseURL)) + " (inferred)"
		}
		fmt.Printf("route %-24s style=%-20s key=%v models=%d\n",
			provider.Name, style, provider.Usable(), len(provider.Models))
		adapter, err := model.New(model.Options{
			Route: model.Route{
				Name: provider.Name, APIKey: provider.APIKey, BaseURL: provider.BaseURL,
				Model: firstModel(provider), Verify: provider.Verify,
				Style: model.NormalizeStyle(provider.APIStyle), Headers: provider.Headers,
			},
		})
		if err != nil {
			fmt.Printf("    ! the model layer refused this route: %v\n", err)
			continue
		}
		fmt.Printf("    endpoint it will POST to: %s%s\n",
			adapter.BaseURL(), endpointPath(adapter.Route().Style))
		for _, problem := range registry.Problems {
			if len(provider.Models) == 0 {
				fmt.Printf("    ! %s\n", problem)
			}
		}
	}
	for _, problem := range registry.Problems {
		fmt.Printf("problem: %s\n", problem)
	}
	for _, note := range registry.Notes {
		fmt.Printf("note: %s\n", note)
	}
}

func firstModel(provider state.Provider) string {
	if len(provider.Models) == 0 {
		return ""
	}
	return provider.Models[0].ID
}

// endpointPath is what each protocol appends to the base URL. It is written out
// here rather than exported from the model package because nothing in the program
// needs to know it — this tool prints it precisely because a human does.
func endpointPath(style model.Style) string {
	switch style {
	case model.StyleAnthropic:
		return "/v1/messages"
	case model.StyleResponses:
		return "/v1/responses"
	default:
		return "/chat/completions"
	}
}
