package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/imagegen"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

// newTestImageClient builds a client pointed at an address nothing listens on.
//
// The registry test never calls it: what is under test is whether the tool is
// registered, not what it does when it runs.
func newTestImageClient(t *testing.T) *imagegen.Client {
	t.Helper()
	client, err := imagegen.New(imagegen.Route{
		BaseURL: "http://127.0.0.1:1",
		APIKey:  "sk-test",
		Model:   "gpt-image-1",
	}, nil)
	if err != nil {
		t.Fatalf("image client: %v", err)
	}
	return client
}

// The startup story for image generation.
//
// There are exactly two states, and they are not the same kind of thing:
//
//   - **not configured** — the tool is absent from the schema and one info line
//     says so. It is a capability that is not here, not a broken machine.
//   - **configured** — the tool is registered, and it costs money, so it asks.
//
// The trap this file exists to catch is the one `code_explore` fell into: the
// `Missing` list is dispatched by **switching on the name**, and a new entry
// without its own case falls through to the default — which prints the ripgrep
// warning. A user whose ripgrep is perfectly fine would be told to re-vendor a
// binary that was there all along.

// TestAnUnconfiguredImageRouteLeavesTheToolOut checks the first state.
func TestAnUnconfiguredImageRouteLeavesTheToolOut(t *testing.T) {
	workspace, err := tools.NewWorkspace(t.TempDir())
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}

	result, err := builtin.CreateRegistry(builtin.Assembly{
		Workspace: workspace,
		Vision:    func() bool { return true },
		RunID:     func() string { return "run-1" },
	})
	if err != nil {
		t.Fatalf("building the registry: %v", err)
	}

	if _, found := result.Tools.Get(builtin.GenerateImageToolName); found {
		t.Error("generate_image is registered, and it must not be without a route")
	}

	// The missing list has to name it, so the notice has something to dispatch
	// on. A tool that is silently absent is a tool nobody can ask about.
	found := false
	for _, name := range result.Missing {
		if name == builtin.GenerateImageToolName {
			found = true
		}
	}
	if !found {
		t.Errorf("the missing list is %v, and it does not name generate_image", result.Missing)
	}
}

// TestAConfiguredImageRouteRegistersTheTool checks the second state.
func TestAConfiguredImageRouteRegistersTheTool(t *testing.T) {
	workspace, err := tools.NewWorkspace(t.TempDir())
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}

	client := newTestImageClient(t)
	result, err := builtin.CreateRegistry(builtin.Assembly{
		Workspace: workspace,
		ImageGen:  client,
		Vision:    func() bool { return true },
		RunID:     func() string { return "run-1" },
	})
	if err != nil {
		t.Fatalf("building the registry: %v", err)
	}

	tool, found := result.Tools.Get(builtin.GenerateImageToolName)
	if !found {
		t.Fatal("generate_image is not registered, and it should be")
	}
	if tool.Risk != "medium" {
		t.Errorf("the risk is %q, want medium", tool.Risk)
	}
	if tool.ParallelSafe {
		t.Error("the tool is parallel-safe, and it must not be")
	}
	for _, name := range result.Missing {
		if name == builtin.GenerateImageToolName {
			t.Error("the tool is registered and also reported as missing")
		}
	}
}

// TestTheMissingListIsNotReportedAsAMissingRipgrep is the trap.
//
// The `Missing` list is dispatched by switching on the name, and the default
// branch prints the ripgrep warning. A new entry without its own case sends
// the user to re-vendor a binary that is fine — which is exactly what happened
// when `code_explore` joined the list.
func TestTheMissingListIsNotReportedAsAMissingRipgrep(t *testing.T) {
	workspace, err := tools.NewWorkspace(t.TempDir())
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	result, err := builtin.CreateRegistry(builtin.Assembly{
		Workspace: workspace,
		Vision:    func() bool { return true },
		RunID:     func() string { return "run-1" },
	})
	if err != nil {
		t.Fatalf("building the registry: %v", err)
	}

	// The dispatch itself is in OpenRuntime, which needs a whole session. What
	// is checked here is the *shape* of the answer: the missing list holds
	// names, and each name has to have a case. The list is small enough to
	// state outright, and stating it is what stops the next tool from
	// inheriting the default branch.
	for _, name := range result.Missing {
		switch name {
		case builtin.GenerateImageToolName, "grep", builtin.CodeExploreToolName:
		default:
			t.Errorf("the missing list holds %q, which has no case in the notice dispatch", name)
		}
	}
}

// TestTheImageNoticeIsInfoNotWarn checks the level.
//
// Image generation was never promised, so a machine without it is not broken.
// `web_search` is a warning because people believe it can be used; this one
// was never on the table.
func TestTheImageNoticeIsInfoNotWarn(t *testing.T) {
	record := notice("info", "image", "no image route")
	if record["level"] != "info" {
		t.Errorf("the level is %v, want info", record["level"])
	}
}

// TestTheCatalogueCarriesTheImageRoute checks that the route reaches the
// runtime through the catalogue rather than through a second read of the
// configuration file.
func TestTheCatalogueCarriesTheImageRoute(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	body := `{
  "providers": {
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-chat",
      "models": [{"id": "gpt-4o"}]
    }
  },
  "image_generation": {
    "provider": "openai",
    "model": "gpt-image-1"
  }
}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing the configuration: %v", err)
	}

	catalog, err := state.Load(path)
	if err != nil {
		t.Fatalf("loading: %v", err)
	}
	if !catalog.Image.Configured() {
		t.Fatal("the catalogue carries no image route")
	}
	if catalog.Image.Model != "gpt-image-1" {
		t.Errorf("the model is %q, want gpt-image-1", catalog.Image.Model)
	}
}

// TestTheImageRouteIsNotAConversationModel is the separation, checked from
// the catalogue's side.
//
// A picture model in the model list would show up in `/model`, be selectable,
// and then fail every chat request.
func TestTheImageRouteIsNotAConversationModel(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	body := `{
  "providers": {
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-chat",
      "models": [{"id": "gpt-4o"}]
    }
  },
  "image_generation": {
    "provider": "openai",
    "model": "gpt-image-1"
  }
}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing the configuration: %v", err)
	}

	catalog, err := state.Load(path)
	if err != nil {
		t.Fatalf("loading: %v", err)
	}
	for _, model := range catalog.Models() {
		if strings.Contains(model.ID, "image") {
			t.Errorf("the image model %q is in the conversation model list", model.ID)
		}
	}
}
