package subagent

import (
	"context"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

func testPresets(defaultName string) state.SubagentPresets {
	return state.SubagentPresets{
		Presets: []state.SubagentPreset{
			{Name: "fast", Provider: "cheap", Model: "mini", Effort: "low", Purpose: "search and locate"},
			{Name: "deep", Provider: "strong", Model: "big", Purpose: "review"},
		},
		Default: defaultName,
	}
}

// Without presets the tool must look exactly as it did before the feature:
// a parameter whose every value is refused teaches the model to make failing calls.
func TestNoPresetsMeansNoPresetArgument(t *testing.T) {
	h := newHarness(t, &fakeModel{})
	properties := h.tool.Schema["properties"].(map[string]any)
	if _, present := properties["preset"]; present {
		t.Fatal("the preset argument is offered with no presets configured")
	}
	if strings.Contains(h.tool.Description, "preset 参数") {
		t.Fatal("the description talks about presets that do not exist")
	}
}

func TestPresetsAreOfferedAsAnEnumByPurpose(t *testing.T) {
	_, built, ok := BuildWithHandle(Config{Resolver: &fakeResolver{}, MaxDepth: 1, Presets: testPresets("fast")})
	if !ok {
		t.Fatal("no tool")
	}
	schema := built.Schema["properties"].(map[string]any)["preset"].(map[string]any)
	enum := schema["enum"].([]any)
	if len(enum) != 2 || enum[0] != "fast" || enum[1] != "deep" {
		t.Fatalf("enum = %v, want the configured names in order", enum)
	}
	if !strings.Contains(built.Description, "fast：search and locate") {
		t.Errorf("the description does not list the preset by its purpose:\n%s", built.Description)
	}
	// Choosing by purpose is the point; a model name in the description invites
	// choosing by which model looks stronger.
	if strings.Contains(built.Description, "mini") || strings.Contains(built.Description, "big") {
		t.Errorf("the description names the presets' models:\n%s", built.Description)
	}
	if !strings.Contains(built.Description, "默认预设 fast") {
		t.Errorf("the description does not name the default preset")
	}
}

func TestANamedPresetIsTheRouteRequested(t *testing.T) {
	h := newHarnessWithPresets(t, &fakeModel{}, testPresets(""))
	h.call(t, map[string]any{"prompt": "anything", "preset": "fast"})
	if len(h.resolver.requested) != 1 {
		t.Fatalf("resolver asked %d times", len(h.resolver.requested))
	}
	got := h.resolver.requested[0]
	if got.Provider != "cheap" || got.Model != "mini" || got.Effort != "low" {
		t.Errorf("requested route = %+v, want the fast preset", got)
	}
}

func TestNoPresetUsesTheDefault(t *testing.T) {
	h := newHarnessWithPresets(t, &fakeModel{}, testPresets("deep"))
	h.call(t, map[string]any{"prompt": "anything"})
	if got := h.resolver.requested[0]; got.Provider != "strong" || got.Model != "big" {
		t.Errorf("requested route = %+v, want the default preset", got)
	}
}

// An empty default is "follow the parent": the request carries no route and
// the resolver falls back to the parent's.
func TestNoPresetAndNoDefaultFollowsTheParent(t *testing.T) {
	h := newHarnessWithPresets(t, &fakeModel{}, testPresets(""))
	h.call(t, map[string]any{"prompt": "anything"})
	if got := h.resolver.requested[0]; got != (Route{}) {
		t.Errorf("requested route = %+v, want the empty route (parent's)", got)
	}
}

// An unknown preset is refused before anything is resolved — never replaced
// by the default or the parent's route.
func TestAnUnknownPresetIsRefusedNotSubstituted(t *testing.T) {
	h := newHarnessWithPresets(t, &fakeModel{}, testPresets("fast"))
	// The schema's enum is the first gate: the call is refused before the
	// handler runs, and the message names the configured presets.
	_, err := h.tool.Execute(context.Background(), map[string]any{"prompt": "anything", "preset": "nope"})
	if err == nil || !strings.Contains(err.Error(), "fast, deep") {
		t.Errorf("err = %v, want a refusal listing the presets", err)
	}
	if len(h.resolver.requested) != 0 {
		t.Fatalf("an unknown preset reached the resolver: %+v", h.resolver.requested)
	}
	// The handler's own check is the second gate, for a caller that skips
	// schema validation.
	result, err := h.handle.execute(context.Background(), map[string]any{"prompt": "anything", "preset": "nope"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Text, "fast, deep") || len(h.resolver.requested) != 0 {
		t.Errorf("handler refusal = %q, requested = %+v", result.Text, h.resolver.requested)
	}
}
