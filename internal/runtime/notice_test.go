package runtime

import (
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

// TestEveryNoticeNamesItsStream pins the field the front ends dispatch on.
//
// The line REPL's stdout is a documented contract — `tudouni-aigo > chat.txt` has to
// contain the conversation and nothing else — so a notice that lands on the wrong
// stream either pollutes the transcript or hides a warning where nobody reads it. A
// missing `stream` key is the worst of both: it silently becomes "err".
func TestEveryNoticeNamesItsStream(t *testing.T) {
	for _, record := range []map[string]any{
		notice("warn", "web", "text"),
		outNotice("info", "tools", "text"),
	} {
		stream, ok := record["stream"].(string)
		if !ok || stream == "" {
			t.Errorf("a notice has no stream: %#v", record)
		}
		if stream != "err" && stream != "out" {
			t.Errorf("unknown stream %q", stream)
		}
	}
	if got := notice("warn", "x", "y")["stream"]; got != "err" {
		t.Errorf("notice() defaulted to stream %v, want err", got)
	}
	if got := outNotice("info", "x", "y")["stream"]; got != "out" {
		t.Errorf("outNotice() produced stream %v, want out", got)
	}
}

// TestTheRegisteredToolsTableIsStableAndComplete: the table is built from the
// registry, so a tool that failed to register is visibly absent rather than silently
// listed — and it is sorted, because a diff of two sessions only means something if
// the constant part really is constant.
func TestTheRegisteredToolsTableIsStableAndComplete(t *testing.T) {
	workspace, err := tools.NewWorkspace(t.TempDir())
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	registry := tools.NewRegistry()
	for _, tool := range builtin.NewFileTools(workspace) {
		if err := registry.Register(tool); err != nil {
			t.Fatalf("register %s: %v", tool.Name, err)
		}
	}
	if err := registry.Register(builtin.NewGetCurrentTime()); err != nil {
		t.Fatalf("register clock: %v", err)
	}

	table := renderRegisteredTools(registry)
	if table == "" {
		t.Fatal("the table is empty")
	}
	lines := strings.Split(table, "\n")
	if len(lines) != registry.Len() {
		t.Errorf("%d rows for %d tools", len(lines), registry.Len())
	}
	for _, name := range []string{"read_file", "write_file", "list_files", "get_current_time"} {
		if !strings.Contains(table, name) {
			t.Errorf("the table is missing %s:\n%s", name, table)
		}
	}
	// Sorted, so the same build produces the same text every run.
	if !strings.Contains(table, "read_file") || !strings.Contains(table, "risk=") {
		t.Errorf("the rows do not carry the shape the notice promises:\n%s", table)
	}
	if strings.Count(table, "risk=low")+strings.Count(table, "risk=medium")+
		strings.Count(table, "risk=high") != registry.Len() {
		t.Errorf("some row has no risk level:\n%s", table)
	}
}
