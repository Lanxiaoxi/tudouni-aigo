package builtin

import (
	"encoding/json"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// buildRegistry assembles the widest tool set this program can produce, so the
// test covers the branches that only exist when the optional tools are present.
func buildRegistry(t *testing.T) *tools.Registry {
	t.Helper()

	workspace, err := tools.NewWorkspace(t.TempDir())
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}

	assembled, err := CreateRegistry(Assembly{
		Workspace:    workspace,
		TodoMetadata: map[string]any{},
		HasJobs:      true,
		HasWebFetch:  true,
		HasWebSearch: true,
	})
	if err != nil {
		t.Fatalf("registry: %v", err)
	}
	if assembled.Tools.Len() == 0 {
		t.Fatal("the registry came back empty")
	}
	return assembled.Tools
}

// TestEverySchemaSurvivesTheRoundTrip ...
//
// The schema the model sees is the **marshalled** one, not the map in memory.
// The two differ in exactly one place that has already caused a real failure: a
// nil Go slice becomes `null`, and a provider that validates the request answers
// 400 without ever reaching the model. Nothing in this package can catch that by
// looking at the map, so the test does what the provider does — it serialises
// first, then inspects.
func TestEverySchemaSurvivesTheRoundTrip(t *testing.T) {
	registry := buildRegistry(t)

	for _, tool := range registry.All() {
		if tool.Name == "" {
			t.Errorf("a tool has no name")
			continue
		}
		if tool.Description == "" {
			t.Errorf("%s: description is empty; the model cannot choose it", tool.Name)
		}
		switch tool.Risk {
		case security.RiskLow, security.RiskMedium, security.RiskHigh:
		default:
			t.Errorf("%s: risk %q is not one of the three levels", tool.Name, tool.Risk)
		}

		raw, err := json.Marshal(tool.Schema)
		if err != nil {
			t.Errorf("%s: schema does not marshal: %v", tool.Name, err)
			continue
		}

		var decoded any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Errorf("%s: schema is not valid JSON: %v", tool.Name, err)
			continue
		}
		object, ok := decoded.(map[string]any)
		if !ok {
			t.Errorf("%s: schema is %T, not an object", tool.Name, decoded)
			continue
		}
		checkWireSchema(t, tool.Name, "", object)
	}
}

// checkWireSchema walks the decoded schema looking for the shapes a provider
// rejects. It runs on the decoded form on purpose: a nil slice and an empty
// slice are indistinguishable before marshalling and very distinguishable after.
func checkWireSchema(t *testing.T, tool, path string, schema map[string]any) {
	t.Helper()

	kind, hasKind := schema["type"].(string)
	if !hasKind || kind == "" {
		t.Errorf("%s: %s has no type", tool, orRoot(path))
	}

	if raw, present := schema["required"]; present {
		names, ok := raw.([]any)
		if !ok {
			// `null` lands here, and it is the whole reason this test exists.
			t.Errorf("%s: %s.required is %v (%T), but every provider expects an array",
				tool, orRoot(path), raw, raw)
		} else {
			for _, name := range names {
				if text, ok := name.(string); !ok || text == "" {
					t.Errorf("%s: %s.required has a non-string entry %v", tool, orRoot(path), name)
				}
			}
		}
	}

	if raw, present := schema["properties"]; present {
		properties, ok := raw.(map[string]any)
		if !ok {
			t.Errorf("%s: %s.properties is %T, not an object", tool, orRoot(path), raw)
		}
		for name, value := range properties {
			child, ok := value.(map[string]any)
			if !ok {
				t.Errorf("%s: %s.%s is %T, not a schema", tool, orRoot(path), name, value)
				continue
			}
			if child["type"] == nil {
				t.Errorf("%s: %s.%s declares no type", tool, orRoot(path), name)
			}
			checkWireSchema(t, tool, path+"."+name, child)
		}
	}

	if raw, present := schema["items"]; present {
		child, ok := raw.(map[string]any)
		if !ok {
			t.Errorf("%s: %s.items is %v, not a schema", tool, orRoot(path), raw)
			return
		}
		checkWireSchema(t, tool, path+"[]", child)
	}
}

func orRoot(path string) string {
	if path == "" {
		return "the schema"
	}
	return path
}

// TestToolsThatTakeNoArgumentsStillSendAnEmptyList pins the other half of the
// same rule. Omitting `required` and sending `[]` are both legal, but they are
// not the same file diff — and the two empty schemas here are the ones a person
// edits when adding an argument, so they should read the same way.
func TestToolsThatTakeNoArgumentsStillSendAnEmptyList(t *testing.T) {
	schema := tools.EmptySchema()

	raw, err := json.Marshal(schema)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}

	required, present := decoded["required"]
	if !present {
		t.Fatal("required is missing; an argument-less tool should still say so")
	}
	if _, ok := required.([]any); !ok {
		t.Fatalf("required decoded as %T (%v), not an array", required, required)
	}
	if properties, ok := decoded["properties"].(map[string]any); !ok || len(properties) != 0 {
		t.Fatalf("properties decoded as %v, expected an empty object", decoded["properties"])
	}
}
