package runtime

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// A start-up fallback (--model / --effort) is what a parent passes for "the
// person's last-used model in this workspace". These tests pin the three
// rules that make it a fallback rather than a second source of truth:
//
//   - it only applies when the session stored no selection of its own;
//   - a name that is gone from the catalogue is dropped, not an error;
//   - a remembered effort the chosen model does not take is dropped, and the
//     model's own declared default fills the gap.

const fallbackConfig = `{
	"providers": {
		"alpha": {
			"base_url": "https://a.example", "api_key": "ka",
			"models": [
				{"id": "first", "reasoning_effort": "low"},
				{"id": "second", "effort_levels": ["low", "high", "xhigh"]}
			]
		},
		"beta": {
			"base_url": "https://b.example", "api_key": "kb",
			"models": [{"id": "beta-one"}]
		}
	}
}`

func loadFallbackCatalog(t *testing.T) state.Registry {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(fallbackConfig), 0o600); err != nil {
		t.Fatalf("writing the configuration: %v", err)
	}
	catalog, err := state.Load(path)
	if err != nil {
		t.Fatalf("loading the configuration: %v", err)
	}
	return catalog
}

// The name goes through the catalogue: the fallback is a catalogue name, and a
// name nobody serves any more is the one case it must not make fail.
func TestResolveFallback(t *testing.T) {
	catalog := loadFallbackCatalog(t)

	if got := resolveFallback(catalog, "second"); got != "second" {
		t.Errorf("resolveFallback(second) = %q, want second", got)
	}
	// `beta-one` exists on another route: a bare name resolves there too.
	if got := resolveFallback(catalog, "beta-one"); got != "beta-one" {
		t.Errorf("resolveFallback(beta-one) = %q, want beta-one", got)
	}
	if got := resolveFallback(catalog, "alpha/second"); got != "second" {
		t.Errorf("a qualified name should resolve: got %q", got)
	}
	// The person edited the route out from under the memory: "" and the
	// catalogue's default takes over.
	if got := resolveFallback(catalog, "gone"); got != "" {
		t.Errorf("a name no longer configured resolves to %q, want empty", got)
	}
	if got := resolveFallback(catalog, "  "); got != "" {
		t.Errorf("a blank name resolves to %q, want empty", got)
	}
}

func TestResolveModelPrefersTheFallbackOverTheDefault(t *testing.T) {
	catalog := loadFallbackCatalog(t)
	// The default is alpha/first; the fallback names alpha/second. A session
	// with no stored selection must come up on the fallback.
	modelState := state.NewSessionModelFor(state.NewMeta(map[string]any{}), "first", "alpha")
	chosen, provider, err := resolveModel(modelState, catalog)
	if err != nil {
		t.Fatalf("resolveModel failed: %v", err)
	}
	if chosen != "first" || provider.Name != "alpha" {
		t.Fatalf("without a fallback the default is %s/%s, want alpha/first", provider.Name, chosen)
	}

	remembered := resolveFallback(catalog, "second")
	modelState = state.NewSessionModelFor(state.NewMeta(map[string]any{}), remembered, "alpha")
	chosen, provider, err = resolveModel(modelState, catalog)
	if err != nil {
		t.Fatalf("resolveModel failed: %v", err)
	}
	if chosen != "second" || provider.Name != "alpha" {
		t.Errorf("with the fallback the session is on %s/%s, want alpha/second", provider.Name, chosen)
	}
}

// The rule the whole feature stands on: a session that chose its own model
// keeps it, whatever the start-up fallback says.
func TestResolveModelKeepsAStoredSelection(t *testing.T) {
	catalog := loadFallbackCatalog(t)
	metadata := map[string]any{}
	state.StoreSelection(metadata, state.Selection{Provider: "beta", Model: "beta-one"}, 0)

	modelState := state.NewSessionModelFor(state.NewMeta(metadata), resolveFallback(catalog, "second"), "alpha")
	chosen, provider, err := resolveModel(modelState, catalog)
	if err != nil {
		t.Fatalf("resolveModel failed: %v", err)
	}
	if chosen != "beta-one" || provider.Name != "beta" {
		t.Errorf("a stored selection was overridden: session is on %s/%s, want beta/beta-one", provider.Name, chosen)
	}
}

// The remembered effort is a fallback, not a command: a level the model does
// not take is dropped (the model's own default branch fills the gap), and a
// session that chose its own level is not touched.
func TestApplyFallbackEffort(t *testing.T) {
	catalog := loadFallbackCatalog(t)

	// second declares [low high xhigh]; `max` is not on the list.
	if state.EffortAllowed("max", catalog.EffortLevelsFor("second", "alpha")) {
		t.Fatalf("the test premise moved: second takes %v, which should not include max",
			catalog.EffortLevelsFor("second", "alpha"))
	}

	metadata := map[string]any{}
	modelState := state.NewSessionModelFor(state.NewMeta(metadata), "second", "alpha")
	applyFallbackEffort(modelState, catalog, "max", "second", "alpha")
	if got := modelState.Effort(); got != state.DefaultEffort {
		t.Errorf("a refused level was applied: effort = %q, want the untouched default %q", got, state.DefaultEffort)
	}

	// A level the model takes is applied as-is.
	applyFallbackEffort(modelState, catalog, "xhigh", "second", "alpha")
	if got := modelState.Effort(); got != "xhigh" {
		t.Errorf("an accepted level was not applied: effort = %q, want xhigh", got)
	}
	if !modelState.EffortChosen() {
		t.Error("an applied fallback level should count as chosen, or the model's own default would replace it")
	}

	// A level chosen in the session is not overwritten.
	metadata2 := map[string]any{}
	state.StoreSelection(metadata2, state.Selection{Provider: "alpha", Model: "second", Effort: "low"}, 0)
	chosenState := state.NewSessionModelFor(state.NewMeta(metadata2), "second", "alpha")
	applyFallbackEffort(chosenState, catalog, "xhigh", "second", "alpha")
	if got := chosenState.Effort(); got != "low" {
		t.Errorf("a stored effort was replaced: effort = %q, want low", got)
	}

	// Empty means "nothing remembered" and is a no-op.
	emptyState := state.NewSessionModelFor(state.NewMeta(map[string]any{}), "second", "alpha")
	applyFallbackEffort(emptyState, catalog, "", "second", "alpha")
	if got := emptyState.Effort(); got != state.DefaultEffort {
		t.Errorf("an empty fallback moved the effort: %q", got)
	}
}
