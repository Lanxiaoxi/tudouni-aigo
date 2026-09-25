package builtin

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// TestTheModelFacingSchemaIsValidJSON is a provider-contract check, not a formatting
// one.
//
// The schema is what leaves this process and lands in a request body. A malformed one
// is not a test failure at the model's end: it is a 400 that names one arbitrary
// function, or worse a silently dropped parameter the model never learns it has. The
// two range parameters make this worth pinning, because they are the first optional
// integers on a file tool and a wrong `required` or a stray `null` is exactly the
// shape that earns a 400.
func TestTheModelFacingSchemaIsValidJSON(t *testing.T) {
	_, tool := newReadWorkspace(t, "a.txt", "one\n")

	raw := tools.MarshalSchema(tool.OpenAISchema())
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("the rendered schema is not valid JSON: %v\n%s", err, raw)
	}

	fn, ok := decoded["function"].(map[string]any)
	if !ok {
		t.Fatalf("the rendered schema has no function object: %s", raw)
	}
	params, ok := fn["parameters"].(map[string]any)
	if !ok {
		t.Fatalf("the rendered schema has no parameters object: %s", raw)
	}

	// `required` must be a list, never null: a provider that validates the schema
	// answers `"required": null` with a 400 naming a function at random, and the
	// request never reaches the model.
	required, ok := params["required"].([]any)
	if !ok {
		t.Fatalf("required is not a list: %#v", params["required"])
	}
	if len(required) != 1 || required[0] != "path" {
		t.Fatalf("required = %v, want exactly [path]: the bounds are optional", required)
	}

	props, ok := params["properties"].(map[string]any)
	if !ok {
		t.Fatalf("properties is not an object: %s", raw)
	}
	for _, name := range []string{"path", "start_line", "end_line"} {
		if _, present := props[name]; !present {
			t.Errorf("%s is missing from the model-facing schema", name)
		}
	}

	// Neither bound may carry a default: the handler relies on the key being
	// **absent** to tell a whole-file read from a range.
	for _, name := range []string{"start_line", "end_line"} {
		property, _ := props[name].(map[string]any)
		if _, hasDefault := property["default"]; hasDefault {
			t.Errorf("%s carries a default (%v); the handler cannot then tell a whole-file read from a range",
				name, property["default"])
		}
		if property["minimum"] != float64(1) {
			t.Errorf("%s minimum = %v, want 1 (line numbers are 1-based)", name, property["minimum"])
		}
	}

	// The description has to name the parameters: it is the only place the model
	// learns they exist as a choice rather than as trivia.
	description, _ := fn["description"].(string)
	for _, want := range []string{"start_line", "end_line"} {
		if !strings.Contains(description, want) {
			t.Errorf("the description does not mention %s", want)
		}
	}
}
