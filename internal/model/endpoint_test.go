package model

import (
	"strings"
	"testing"
)

// TestEndpointURLNeverDoublesTheVersionSegment is the guard on the mistake this
// project has already made once, in a real configuration file.
//
// The rule is that base_url and the dialect's path are added together and nothing
// else is normalised, so `/v1` must appear exactly once across the two. A base URL
// that already ends in `/v1` — which is what a vendor's own documentation often
// gives, because that is what you pass to an SDK — produces `/v1/v1/messages`, and
// the endpoint answers 404 in a way that says nothing about which of the two
// segments to remove.
//
// This is deliberately **not** "fixed" by stripping a duplicate `/v1`: a gateway
// whose real path is `/v1/v1/...` would then be unreachable, and the configuration
// is the one source of truth about what the endpoint is. What is pinned here is
// only that the program appends what it says it appends.
func TestEndpointURLNeverDoublesTheVersionSegment(t *testing.T) {
	cases := []struct {
		name    string
		baseURL string
		style   Style
		want    string
	}{
		{
			name:    "chat completions keeps the base as given",
			baseURL: "https://opencode.ai/zen/go/v1",
			style:   StyleOpenAI,
			want:    "https://opencode.ai/zen/go/v1/chat/completions",
		},
		{
			name:    "messages appends its own /v1",
			baseURL: "https://opencode.ai/zen/go",
			style:   StyleAnthropic,
			want:    "https://opencode.ai/zen/go/v1/messages",
		},
		{
			name:    "responses appends its own /v1",
			baseURL: "https://opencode.ai/zen/go",
			style:   StyleResponses,
			want:    "https://opencode.ai/zen/go/v1/responses",
		},
		{
			name:    "a trailing slash on the base does not double the separator",
			baseURL: "https://api.deepseek.com/",
			style:   StyleOpenAI,
			want:    "https://api.deepseek.com/chat/completions",
		},
		{
			name:    "a vendor base that is a prefix path is left alone",
			baseURL: "https://host/apps/anthropic",
			style:   StyleAnthropic,
			want:    "https://host/apps/anthropic/v1/messages",
		},
	}

	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			codec, err := dialectFor(item.style)
			if err != nil {
				t.Fatalf("dialectFor: %v", err)
			}
			got := endpointURL(item.baseURL, codec.path())
			if got != item.want {
				t.Errorf("endpointURL = %s, want %s", got, item.want)
			}
			if strings.Contains(got, "/v1/v1") {
				t.Errorf("the version segment was doubled: %s", got)
			}
		})
	}
}

// TestASharedBaseURLNeedsAnExplicitStyle covers the one situation inference cannot
// resolve: one gateway serving several protocols under one host, where the base URL
// looks identical from every route.
//
// It is why `api_style` is a configuration key rather than something always
// derived — and why an explicit value must win over the inference rather than being
// treated as a hint.
func TestASharedBaseURLNeedsAnExplicitStyle(t *testing.T) {
	const gateway = "https://opencode.ai/zen/go"
	if got := StyleFromBaseURL(gateway); got != StyleOpenAI {
		t.Fatalf("StyleFromBaseURL(%q) = %q, want the default", gateway, got)
	}

	// Every protocol has to be reachable from that same URL when it is declared.
	for _, style := range []Style{StyleOpenAI, StyleAnthropic, StyleResponses} {
		adapter, err := New(Options{Route: Route{
			Name: "go", APIKey: "k", BaseURL: "https://opencode.ai/zen/go/v1", Model: "m",
		}})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		if !adapter.Install(Route{
			Name: "go", APIKey: "k", BaseURL: gateway, Model: "m", Style: style,
		}) {
			t.Fatalf("Install refused an explicit %q style", style)
		}
		if adapter.Route().Style != style {
			t.Errorf("the declared style %q was overridden by inference: got %q", style, adapter.Route().Style)
		}
		codec, _ := dialectFor(style)
		if got := endpointURL(adapter.BaseURL(), codec.path()); strings.Contains(got, "/v1/v1") {
			t.Errorf("%s produced a doubled path: %s", style, got)
		}
	}
}
