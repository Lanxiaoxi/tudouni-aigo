package state

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestTheShippedExampleStillLoads is the guard for the template that is supposed
// to teach these two keys.
//
// The catalogue refuses an unknown key outright, so a documented example that has
// drifted from the reader is not a cosmetic problem: a user who copies the
// template to get started would be unable to start. The file is read from the
// repository root rather than from a fixture, because the thing at risk is that
// exact file.
func TestTheShippedExampleStillLoads(t *testing.T) {
	path, err := filepath.Abs(filepath.Join("..", "..", "config.example.json"))
	if err != nil {
		t.Fatalf("locating the shipped example: %v", err)
	}
	registry, err := Load(path)
	if err != nil {
		t.Fatalf("the shipped config.example.json no longer loads: %v", err)
	}
	if len(registry.Providers) == 0 {
		t.Fatal("the shipped example declares no routes")
	}
	// The example is documentation for the new keys, so it has to actually use
	// them — a template that only mentions them in a comment teaches nothing about
	// where they go.
	foundStyle, foundHeaders := false, false
	for _, provider := range registry.Providers {
		if provider.APIStyle != "" {
			foundStyle = true
		}
		if len(provider.Headers) > 0 {
			foundHeaders = true
		}
	}
	if !foundStyle || !foundHeaders {
		t.Errorf("the example no longer demonstrates api_style (%v) or headers (%v)", foundStyle, foundHeaders)
	}
}

// TestAPIStyleAndHeadersAreRead pins the two route keys that make a vendor
// reachable without a code change.
//
// Both are load-bearing in a way a missing key is not: an absent `api_style` means
// "work it out from base_url" and an absent `headers` means "send what you always
// sent", so neither can be defaulted wrongly without the user having written
// anything. What must not happen is a **typo** being treated as absent.
func TestAPIStyleAndHeadersAreRead(t *testing.T) {
	path := writeConfig(t, `{
		"providers": {
			"qwen": {
				"base_url": "https://workspace.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
				"api_key": "k",
				"api_style": "Anthropic",
				"headers": {"User-Agent": "tudouni/0.2", "x-opencode-session": "ses_1"},
				"models": [{"id": "qwen3-max"}]
			},
			"plain": {
				"base_url": "https://api.deepseek.com",
				"api_key": "k",
				"models": [{"id": "deepseek-flash"}]
			}
		}
	}`)
	registry, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	qwen, ok := registry.ProviderByName("qwen")
	if !ok {
		t.Fatal("the route is missing from the catalogue")
	}
	// The value is normalized, so `Anthropic` and `anthropic` are the same route
	// rather than one of them being an unknown protocol.
	if qwen.APIStyle != StyleAnthropic {
		t.Errorf("APIStyle = %q, want %q", qwen.APIStyle, StyleAnthropic)
	}
	if got := qwen.Headers["User-Agent"]; got != "tudouni/0.2" {
		t.Errorf("User-Agent header = %q", got)
	}
	if got := qwen.Headers["x-opencode-session"]; got != "ses_1" {
		t.Errorf("x-opencode-session header = %q", got)
	}

	plain, _ := registry.ProviderByName("plain")
	if plain.APIStyle != "" {
		t.Errorf("APIStyle = %q for a route that did not declare one, want empty", plain.APIStyle)
	}
	if len(plain.Headers) != 0 {
		t.Errorf("Headers = %#v for a route that declared none", plain.Headers)
	}
}

// TestACommentInsideARouteIsNotAnUnknownKey keeps the comment convention working
// at every level.
//
// The point of `$comment` is that the explanation sits next to the thing it
// explains, so it has to be usable inside a route — and a route is where the
// optional keys are. Reporting the note as a misspelled key would make the
// convention useless exactly where it is needed.
func TestACommentInsideARouteIsNotAnUnknownKey(t *testing.T) {
	path := writeConfig(t, `{
		"providers": {
			"p": {
				"$comment": "this route needs its own client identification",
				"base_url": "https://example.invalid",
				"api_key": "k",
				"headers": {"User-Agent": "tudouni/0.2"},
				"models": [{"$comment": "the big one", "id": "m"}]
			}
		}
	}`)
	registry, err := Load(path)
	if err != nil {
		t.Fatalf("a $comment beside a key was treated as an unknown key: %v", err)
	}
	if _, ok := registry.ProviderByName("p"); !ok {
		t.Fatal("the route is missing from the catalogue")
	}
}

// TestAnUnknownAPIStyleIsRefusedAtReadTime keeps the failure where the line is.
//
// Treating the typo as the default would send the request in the wrong shape, and
// the endpoint's complaint would name a field rather than the configuration key
// that is actually wrong.
func TestAnUnknownAPIStyleIsRefusedAtReadTime(t *testing.T) {
	path := writeConfig(t, `{
		"providers": {
			"p": {"base_url": "https://example.invalid", "api_key": "k", "api_style": "antropic",
			      "models": [{"id": "m"}]}
		}
	}`)
	_, err := Load(path)
	if err == nil {
		t.Fatal("an unknown api_style was accepted")
	}
	message := err.Error()
	if !strings.Contains(message, "antropic") {
		t.Errorf("the error does not name the bad value: %s", message)
	}
	if !strings.Contains(message, StyleOpenAI) || !strings.Contains(message, StyleAnthropic) {
		t.Errorf("the error does not list the protocols: %s", message)
	}
}

// TestAMalformedHeaderSectionIsRefused covers the two ways a header entry can be
// wrong, both of which would otherwise become a header sent with a surprising
// value or a header that silently vanished.
func TestAMalformedHeaderSectionIsRefused(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			name: "not an object",
			body: `{"base_url": "https://example.invalid", "api_key": "k",
			        "headers": ["User-Agent: x"], "models": [{"id": "m"}]}`,
			want: "headers",
		},
		{
			name: "a number where a string belongs",
			body: `{"base_url": "https://example.invalid", "api_key": "k",
			        "headers": {"x-api-version": 2}, "models": [{"id": "m"}]}`,
			want: "x-api-version",
		},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			path := writeConfig(t, `{"providers": {"p": `+item.body+`}}`)
			_, err := Load(path)
			if err == nil {
				t.Fatal("a malformed headers section was accepted")
			}
			if !strings.Contains(err.Error(), item.want) {
				t.Errorf("the error does not mention %q: %s", item.want, err.Error())
			}
		})
	}
}
