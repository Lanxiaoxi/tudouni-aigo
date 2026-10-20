package builtin

// code_explore's end-to-end check against a real index.
//
// Gated because it needs a built index and cg-parse; the unit-testable parts (source
// formatting, path shortening, budget) are covered in code_explore_test.go.

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// TestCodeExploreAgainstIndex runs a real query when INDEX_PROBE_ROOT points at an indexed
// workspace.
func TestCodeExploreAgainstIndex(t *testing.T) {
	root := os.Getenv("INDEX_PROBE_ROOT")
	if root == "" {
		t.Skip("set INDEX_PROBE_ROOT to an indexed workspace to run this")
	}
	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	// The refresher is the runtime's, not the tool's — built the same way the
	// composition does when it hands one to both the panel and the tool.
	parserPath, _ := CgParserBinary()
	tool, ok := NewCodeExplore(workspace, codeintel.New(root, parserPath))
	if !ok {
		t.Fatalf("no index found under %s", root)
	}
	result, err := tool.Handler(context.Background(), map[string]any{
		"query":     os.Getenv("INDEX_PROBE_QUERY"),
		"max_files": float64(3),
	})
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if strings.TrimSpace(result.Text) == "" {
		t.Fatal("empty result")
	}
	fmt.Println(result.Text)
}
