package builtin

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// TestSchemaStillValidWithTheOutlineParameter pins the provider contract after the
// new parameter was added: `required` must stay exactly [path] and the new boolean
// must carry no default, or the handler can no longer tell false from absent.
func TestSchemaStillValidWithTheOutlineParameter(t *testing.T) {
	_, tool := newReadWorkspace(t, "a.txt", "one\n")

	raw := tools.MarshalSchema(tool.OpenAISchema())
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("the rendered schema is not valid JSON: %v\n%s", err, raw)
	}
	fn, _ := decoded["function"].(map[string]any)
	params, _ := fn["parameters"].(map[string]any)

	required, ok := params["required"].([]any)
	if !ok || len(required) != 1 || required[0] != "path" {
		t.Fatalf("required = %v, want exactly [path]: outline and the bounds are optional",
			params["required"])
	}
	props, _ := params["properties"].(map[string]any)
	outline, ok := props["outline"].(map[string]any)
	if !ok {
		t.Fatalf("outline is missing from the model-facing schema: %s", raw)
	}
	if _, hasDefault := outline["default"]; hasDefault {
		t.Errorf("outline carries a default (%v); the handler cannot then tell false from absent",
			outline["default"])
	}
	if outline["type"] != "boolean" {
		t.Errorf("outline type = %v, want boolean", outline["type"])
	}
	if description, _ := fn["description"].(string); !strings.Contains(description, "outline") {
		t.Errorf("the description does not mention outline: %s", description)
	}
}

// TestOutlineEndpointThroughTheRealWorkspace walks the whole path the agent takes:
// validate the arguments, resolve inside the workspace, read, render.
func TestOutlineEndpointThroughTheRealWorkspace(t *testing.T) {
	dir := t.TempDir()
	body := "package z\n\ntype T struct{}\n\nfunc (t T) Run() error { return nil }\n"
	if err := os.WriteFile(filepath.Join(dir, "z.go"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	workspace, err := tools.NewWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	var readTool tools.Tool
	for _, candidate := range NewFileTools(workspace) {
		if candidate.Name == "read_file" {
			readTool = candidate
		}
	}

	validated, err := tools.Validate(readTool.Parameters(), map[string]any{
		"path": "z.go", "outline": true,
	})
	if err != nil {
		t.Fatalf("arguments did not validate: %v", err)
	}
	result, err := readTool.Execute(context.Background(), validated)
	if err != nil {
		t.Fatalf("read_file errored: %v", err)
	}
	for _, want := range []string{"3| type T struct{}", "5| func (t T) Run() error"} {
		if !strings.Contains(result.Text, want) {
			t.Errorf("missing %q from:\n%s", want, result.Text)
		}
	}
	if result.Audit["outline"] != true {
		t.Errorf("the audit does not mark this as an outline: %v", result.Audit)
	}
	if result.Audit["total_lines"] != 5 {
		t.Errorf("total_lines = %v, want 5", result.Audit["total_lines"])
	}
}
