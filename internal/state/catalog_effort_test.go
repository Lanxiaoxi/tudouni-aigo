package state

import (
	"strings"
	"testing"
)

// TestEffortLevelsAreReadPerRouteAndPerModel pins the shape the menu comes from.
//
// A route-wide list covers its models; a model entry that declares its own keeps it.
// Both levels exist because a route is not uniform — the endpoint that takes
// `high|max` for one model takes the full vocabulary for another.
func TestEffortLevelsAreReadPerRouteAndPerModel(t *testing.T) {
	path := writeConfig(t, `{
		"providers": {
			"glm": {
				"base_url": "https://api.example",
				"api_key": "k",
				"effort_levels": ["high", "max"],
				"models": [
					{"id": "glm-flash"},
					{"id": "glm-wide", "effort_levels": ["low", "medium", "high", "xhigh", "max"]}
				]
			},
			"bare": {
				"base_url": "https://api.other.example",
				"api_key": "k",
				"models": [{"id": "plain"}]
			}
		}
	}`)
	registry, err := Load(path)
	if err != nil {
		t.Fatalf("a route declaring effort_levels no longer loads: %v", err)
	}

	if got := registry.EffortLevelsFor("glm-flash", "glm"); strings.Join(got, ",") != "high,max" {
		t.Errorf("glm-flash offers %v, want the route's own list [high max]", got)
	}
	if got := registry.EffortLevelsFor("glm-wide", "glm"); strings.Join(got, ",") != "low,medium,high,xhigh,max" {
		t.Errorf("glm-wide offers %v, want its own list rather than the route's", got)
	}
	// Nothing declared anywhere: the broad vocabulary, not an empty menu. An empty
	// menu would say "this model takes no level" and that is a claim nobody made.
	if got := registry.EffortLevelsFor("plain", "bare"); len(got) != len(BroadEffortLevels) {
		t.Errorf("a route declaring nothing offers %v, want the broad vocabulary", got)
	}
	// A model that is not in the catalogue at all — a session whose route was edited
	// away — gets the same generous answer rather than an empty picker.
	if got := registry.EffortLevelsFor("gone", "gone"); len(got) != len(BroadEffortLevels) {
		t.Errorf("an unknown model offers %v, want the broad vocabulary", got)
	}
}

// TestABrokenEffortLevelsListIsRefusedNotIgnored is the typo rule this catalogue
// applies everywhere: a key that silently does nothing is the worst kind of failure.
func TestABrokenEffortLevelsListIsRefusedNotIgnored(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"not an array", `"effort_levels": "high"`, "must be an array"},
		{"not strings", `"effort_levels": [1, 2]`, "must be a string"},
		{"empty", `"effort_levels": []`, "is empty"},
		{"only none", `"effort_levels": ["none"]`, "is empty"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			path := writeConfig(t, `{"providers": {"p": {
				"base_url": "https://api.example", "api_key": "k",
				`+item.body+`,
				"models": [{"id": "m"}]
			}}}`)
			_, err := Load(path)
			if err == nil {
				t.Fatal("a malformed effort_levels section was accepted")
			}
			if !strings.Contains(err.Error(), item.want) {
				t.Errorf("the error does not mention %q: %s", item.want, err.Error())
			}
		})
	}
}

// TestAModelsDefaultEffortSurvivesTheCatalogue is the half-wired field this fixes.
//
// `reasoning_effort` was read and validated and then dropped: it never reached the
// interface and never reached the session, so a route declaring `low` still came up
// at the global default and nothing said so.
func TestAModelsDefaultEffortSurvivesTheCatalogue(t *testing.T) {
	path := writeConfig(t, `{
		"providers": {
			"p": {
				"base_url": "https://api.example",
				"api_key": "k",
				"models": [
					{"id": "quiet", "reasoning_effort": "low"},
					{"id": "loud"},
					{"id": "alias", "reasoning_effort": "XHIGH"}
				]
			}
		}
	}`)
	registry, err := Load(path)
	if err != nil {
		t.Fatalf("a route declaring reasoning_effort no longer loads: %v", err)
	}

	quiet, _ := registry.Find("quiet", "p")
	if quiet.DefaultEffort != "low" {
		t.Errorf("quiet's default effort = %q, want low", quiet.DefaultEffort)
	}
	loud, _ := registry.Find("loud", "p")
	if loud.DefaultEffort != DefaultEffort {
		t.Errorf("loud's default effort = %q, want the global default", loud.DefaultEffort)
	}
	// A default that names a level the vocabulary has is kept as written, whatever
	// case it was spelled in — the row reports it back, and it must match the level.
	alias, _ := registry.Find("alias", "p")
	if alias.DefaultEffort != "xhigh" {
		t.Errorf("alias's default effort = %q, want xhigh", alias.DefaultEffort)
	}

	// And it reaches the row the interface renders. Without this the value is
	// catalogued and invisible, which is exactly what it was before.
	row := quiet.AsRow(false, "")
	if row["effort"] != "low" {
		t.Errorf("the catalogue row carries effort = %v, want the model's own default low", row["effort"])
	}
	// A caller that knows better — the session's own choice — wins over it.
	if row := quiet.AsRow(true, "max"); row["effort"] != "max" {
		t.Errorf("the row carries effort = %v, want the level the session actually set", row["effort"])
	}
}

// TestAnEffortLevelTheBuildDoesNotKnowIsPassedThrough is deliberate asymmetry: the
// vocabulary is the endpoint's and it grows, so refusing a name this build predates
// would be worse than letting the one party that knows reject it.
func TestAnEffortLevelTheBuildDoesNotKnowIsPassedThrough(t *testing.T) {
	path := writeConfig(t, `{
		"providers": {
			"p": {
				"base_url": "https://api.example",
				"api_key": "k",
				"effort_levels": ["low", "turbo"],
				"models": [{"id": "m"}]
			}
		}
	}`)
	registry, err := Load(path)
	if err != nil {
		t.Fatalf("a route declaring a level this build does not know was refused: %v", err)
	}
	if got := registry.EffortLevelsFor("m", "p"); strings.Join(got, ",") != "low,turbo" {
		t.Errorf("levels = %v, want [low turbo] with the unknown name kept", got)
	}
}
