package runtime

// The live switch, and the two facts it must not confuse.
//
// These tests drive the runtime surface rather than the tool: the question they answer is
// "does flipping the switch change what the model can see, in this process, now" — which is
// the promise the panel makes when it says "from the next turn".

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/protocol"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

// codeIntelRuntime builds the smallest runtime that owns an index handle.
func codeIntelRuntime(t *testing.T, root string, enabled bool) *Runtime {
	t.Helper()
	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	return &Runtime{
		SessionIDValue: "s",
		SessionValue:   state.NewEmptySession("s"),
		Workspace:      workspace,
		Tools:          tools.NewRegistry(),
		// No parser path on purpose: every test here is about presence and the switch,
		// and a build would need a real `cg-parse`.
		CodeIntel: newCodeIntelState(workspace, codeintel.New(root, ""), enabled),
	}
}

// putIndex creates the database file the tool's registration rule looks for. It is not a
// valid database: nothing in this file opens it, and `Snapshot` is the only caller that
// would — which is why the tests that ask for counts tolerate its `problem`.
func putIndex(t *testing.T, root string) {
	t.Helper()
	dir := filepath.Join(root, ".tudouni", "index")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "graph.db"), []byte("not a database"), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
}

func hasCodeExplore(runtimeValue *Runtime) bool {
	_, present := runtimeValue.Tools.Get(builtin.CodeExploreToolName)
	return present
}

// TestTheSwitchAddsAndRemovesTheTool is the whole promise of the panel: off means the model
// never hears about code_explore, on means it does, and both happen in this process.
func TestTheSwitchAddsAndRemovesTheTool(t *testing.T) {
	root := t.TempDir()
	putIndex(t, root)
	runtimeValue := codeIntelRuntime(t, root, false)

	if hasCodeExplore(runtimeValue) {
		t.Fatal("code_explore was in the registry before anybody turned it on")
	}

	if _, err := runtimeValue.CodeIntelAction(protocol.CodeIntelConfig, map[string]any{"enabled": true}); err != nil {
		t.Fatalf("enable: %v", err)
	}
	if !hasCodeExplore(runtimeValue) {
		t.Fatal("turning the switch on did not register code_explore")
	}
	// The switch is a **file**, not a field on this process: the next session in this
	// workspace has to open with the same answer.
	if !codeintel.Enabled(root) {
		t.Error("the switch was not written to the workspace's config.json")
	}

	if _, err := runtimeValue.CodeIntelAction(protocol.CodeIntelConfig, map[string]any{"enabled": false}); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if hasCodeExplore(runtimeValue) {
		t.Fatal("turning the switch off left code_explore in the registry")
	}
	if codeintel.Enabled(root) {
		t.Error("turning the switch off was not written to disk")
	}
	// The index is untouched: turning the capability off is a permission change, not a
	// deletion, and a person who turns it back on must not have to rebuild 50MB.
	if _, err := os.Stat(filepath.Join(root, ".tudouni", "index", "graph.db")); err != nil {
		t.Errorf("turning the switch off removed the index: %v", err)
	}
}

// TestEnabledWithNoIndexRegistersNothing: a tool that can only answer "there is no index"
// costs a schema in every request, so the switch alone does not put it in front of the
// model — and the same call registers it the moment an index exists, which is what makes
// "enable, initialize, ask" work without reopening the session.
func TestEnabledWithNoIndexRegistersNothing(t *testing.T) {
	root := t.TempDir()
	runtimeValue := codeIntelRuntime(t, root, false)

	if _, err := runtimeValue.CodeIntelAction(protocol.CodeIntelConfig, map[string]any{"enabled": true}); err != nil {
		t.Fatalf("enable: %v", err)
	}
	if hasCodeExplore(runtimeValue) {
		t.Fatal("code_explore was registered for a workspace with no index")
	}

	putIndex(t, root)
	if err := runtimeValue.applyCodeIntelTool(); err != nil {
		t.Fatalf("apply after the index appeared: %v", err)
	}
	if !hasCodeExplore(runtimeValue) {
		t.Fatal("an index appeared and the tool did not")
	}
}

// TestThePanelSeparatesTheTwoFacts: `enabled` and `indexed` are both on the snapshot and
// neither is derived from the other — the two mismatched states are the reason the panel
// exists.
func TestThePanelSeparatesTheTwoFacts(t *testing.T) {
	root := t.TempDir()
	runtimeValue := codeIntelRuntime(t, root, true)

	panel, err := runtimeValue.CodeIntelPanel()
	if err != nil {
		t.Fatalf("panel: %v", err)
	}
	if enabled, _ := panel["enabled"].(bool); !enabled {
		t.Error("enabled = false on a runtime built with the capability on")
	}
	if indexed, _ := panel["indexed"].(bool); indexed {
		t.Error("indexed = true for a workspace with no index")
	}
	// No index is a **state**, not a failure: `problem` stays empty so the panel can draw
	// "No index yet" instead of an error banner.
	if problem, _ := panel["problem"].(string); problem != "" {
		t.Errorf("problem = %q for a workspace that was simply never indexed", problem)
	}
	if path, _ := panel["path"].(string); path != ".tudouni/index/graph.db" {
		t.Errorf("path = %q, want the workspace-relative database path", path)
	}

	putIndex(t, root)
	panel, err = runtimeValue.CodeIntelPanel()
	if err != nil {
		t.Fatalf("panel after the index: %v", err)
	}
	if indexed, _ := panel["indexed"].(bool); !indexed {
		t.Error("indexed = false after the database appeared")
	}
}

// TestThePanelNoticesAnotherSessionsPermissionChange: the switch is a file, so a second
// window can flip it while this process is running. The panel is where a person checks
// what the model can see, so it must not answer from a value read at startup.
func TestThePanelNoticesAnotherSessionsPermissionChange(t *testing.T) {
	root := t.TempDir()
	putIndex(t, root)
	runtimeValue := codeIntelRuntime(t, root, false)

	// Another session turns it on.
	if _, err := codeintel.SetEnabled(root, true); err != nil {
		t.Fatalf("enable: %v", err)
	}
	panel, err := runtimeValue.CodeIntelPanel()
	if err != nil {
		t.Fatalf("panel after another session enabled it: %v", err)
	}
	if enabled, _ := panel["enabled"].(bool); !enabled {
		t.Fatal("enabled = false after another session wrote true")
	}
	if !hasCodeExplore(runtimeValue) {
		t.Fatal("the switch is on and an index exists, but the tool was not registered")
	}

	// And off again.
	if _, err := codeintel.SetEnabled(root, false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	panel, err = runtimeValue.CodeIntelPanel()
	if err != nil {
		t.Fatalf("panel after another session disabled it: %v", err)
	}
	if enabled, _ := panel["enabled"].(bool); enabled {
		t.Fatal("enabled = true after another session wrote false")
	}
	if hasCodeExplore(runtimeValue) {
		t.Fatal("the switch is off, but the tool is still registered")
	}
}

// TestTheStateSnapshotCarriesThreeBooleans: `ui(state)` is what a badge can afford, so it
// carries the flags and none of the counts.
func TestTheStateSnapshotCarriesThreeBooleans(t *testing.T) {
	root := t.TempDir()
	runtimeValue := codeIntelRuntime(t, root, true)

	flags := runtimeValue.codeIntelFlags()
	for _, key := range []string{"enabled", "indexed", "building"} {
		if _, ok := flags[key].(bool); !ok {
			t.Errorf("codeintel.%s is %T on the state snapshot, want a bool", key, flags[key])
		}
	}
	if len(flags) != 3 {
		t.Errorf("the state snapshot carries %d code-index keys, want 3: %v", len(flags), flags)
	}
}

// TestAnUnknownVerbIsRefused: the panel's vocabulary is closed, and a mistyped verb must
// not be treated as `status` — a load that answers with a snapshot reads as success.
func TestAnUnknownVerbIsRefused(t *testing.T) {
	runtimeValue := codeIntelRuntime(t, t.TempDir(), true)
	if _, err := runtimeValue.CodeIntelAction("delete-everything", nil); err == nil {
		t.Fatal("an unknown verb was accepted")
	}
}
