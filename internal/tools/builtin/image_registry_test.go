package builtin

import (
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// TestReadImageIsInTheAssembledRegistry.
//
// The unit tests build the tool directly, so none of them would notice if
// `CreateRegistry` forgot to register it — and a tool that is never registered is
// invisible to the model, which is the failure this whole change exists to fix. The
// assertion is on the registry the runtime actually assembles.
func TestReadImageIsInTheAssembledRegistry(t *testing.T) {
	workspace, err := tools.NewWorkspace(t.TempDir())
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	result, err := CreateRegistry(Assembly{Workspace: workspace})
	if err != nil {
		t.Fatalf("CreateRegistry: %v", err)
	}

	tool, ok := result.Tools.Get("read_image")
	if !ok {
		t.Fatalf("read_image is not in the assembled tool set: %v", result.Tools.Names())
	}

	// And the schema the model reads has to name the argument, or it cannot call it.
	schema := tool.OpenAISchema()
	function, _ := schema["function"].(map[string]any)
	parameters, _ := function["parameters"].(map[string]any)
	properties, _ := parameters["properties"].(map[string]any)
	if _, ok := properties["path"]; !ok {
		t.Errorf("the schema has no `path` argument: %#v", parameters)
	}
	// The description has to say what read_file cannot do, because the model reaches
	// for read_file first and needs to know why it will not work here.
	if !strings.Contains(tool.Description, "read_file") {
		t.Errorf("the description does not tell the model how this differs from read_file: %q", tool.Description)
	}

	// The two file tools that read are both present, and neither replaced the other.
	for _, name := range []string{"read_file", "read_image", "list_files"} {
		if _, ok := result.Tools.Get(name); !ok {
			t.Errorf("%s is missing from the assembled tool set", name)
		}
	}
}
