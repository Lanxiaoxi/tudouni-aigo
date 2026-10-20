package builtin

// The registration gate for code intelligence: two facts, one tool.
//
// `CodeIntelEnabled` is the person's permission and "an index exists" is the filesystem's
// answer. The tool appears only when both are true, and every combination of the two is a
// state a person actually reaches — which is why this is four cases and not two.

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

func codeIntelRegistry(t *testing.T, enabled bool, withIndex bool) (*tools.Registry, []string) {
	t.Helper()
	root := t.TempDir()
	if withIndex {
		dir := filepath.Join(root, ".tudouni", "index")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir index: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dir, "graph.db"), []byte("x"), 0o644); err != nil {
			t.Fatalf("write index: %v", err)
		}
	}
	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	assembled, err := CreateRegistry(Assembly{
		Workspace:        workspace,
		CodeIntel:        codeintel.New(root, ""),
		CodeIntelEnabled: enabled,
	})
	if err != nil {
		t.Fatalf("registry: %v", err)
	}
	return assembled.Tools, assembled.Missing
}

func registered(registry *tools.Registry) bool {
	_, present := registry.Get(CodeExploreToolName)
	return present
}

func missing(missingList []string) bool {
	for _, name := range missingList {
		if name == CodeExploreToolName {
			return true
		}
	}
	return false
}

// TestTheToolNeedsBothTheSwitchAndAnIndex is the whole table.
func TestTheToolNeedsBothTheSwitchAndAnIndex(t *testing.T) {
	cases := []struct {
		enabled   bool
		withIndex bool
		wantTool  bool
		// wantNotice: only "enabled but nothing to search" deserves one. "You have not
		// turned this on" is a setting, not a missing piece.
		wantNotice bool
	}{
		{enabled: true, withIndex: true, wantTool: true, wantNotice: false},
		{enabled: true, withIndex: false, wantTool: false, wantNotice: true},
		{enabled: false, withIndex: true, wantTool: false, wantNotice: false},
		{enabled: false, withIndex: false, wantTool: false, wantNotice: false},
	}
	for _, testCase := range cases {
		registry, missingList := codeIntelRegistry(t, testCase.enabled, testCase.withIndex)
		if got := registered(registry); got != testCase.wantTool {
			t.Errorf("enabled=%v indexed=%v: registered=%v, want %v",
				testCase.enabled, testCase.withIndex, got, testCase.wantTool)
		}
		if got := missing(missingList); got != testCase.wantNotice {
			t.Errorf("enabled=%v indexed=%v: notice=%v, want %v",
				testCase.enabled, testCase.withIndex, got, testCase.wantNotice)
		}
	}
}

// TestATurnedOffWorkspaceRegistersNothingAtAll: not even a `Missing` entry, because a
// notice about a capability nobody asked for is noise in every session's start-up.
func TestATurnedOffWorkspaceRegistersNothingAtAll(t *testing.T) {
	registry, missingList := codeIntelRegistry(t, false, true)
	if registered(registry) {
		t.Error("code_explore was registered for a workspace that turned it off")
	}
	if missing(missingList) {
		t.Error("a workspace that never asked for code intelligence got a missing-tool notice")
	}
}
