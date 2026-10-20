package builtin

// code_explore's formatting rules.
//
// These are the parts that decide whether one call substitutes for a Read loop: line numbers
// the model can cite, paths it can pass back, and a budget that reports its own truncation.

import (
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/codeintel/cggraph"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// TestRelativePathStripsRoot pins the bug that made every path ambiguous: matching on markers
// like "/tools/" collapsed `internal/tools/tool.go` into `tools/tool.go`.
func TestRelativePathStripsRoot(t *testing.T) {
	root := `C:\work\repo`
	cases := map[string]string{
		`C:\work\repo\internal\tools\tool.go`:   "internal/tools/tool.go",
		`C:\work\repo\internal\memory\entry.go`: "internal/memory/entry.go",
		`C:\work\repo\cmd\cg\main.go`:           "cmd/cg/main.go",
		`C:\work\repo\desktop\app\src\store.ts`: "desktop/app/src/store.ts",
		`C:\work\repo\main.go`:                  "main.go",
		// A path outside the root keeps its absolute form rather than being mangled.
		`C:\other\place\x.go`: "C:/other/place/x.go",
	}
	for path, want := range cases {
		if got := relativePath(root, path); got != want {
			t.Errorf("relativePath(%q) = %q, want %q", path, got, want)
		}
	}
}

// TestFormatNumbered pins the width and separator: the model cites these line numbers and
// edits against them, so a drifting format becomes a wrong edit.
func TestFormatNumbered(t *testing.T) {
	lines := []string{"package a", "", "func F() {"}
	got := formatNumbered(lines, 1, 3)
	want := "1| package a\n2| \n3| func F() {\n"
	if got != want {
		t.Errorf("formatNumbered =\n%q\nwant\n%q", got, want)
	}

	// The number column widens with the highest line number, so digits stay aligned.
	wide := make([]string, 12)
	for i := range wide {
		wide[i] = "x"
	}
	formatted := formatNumbered(wide, 9, 12)
	if !strings.HasPrefix(formatted, " 9| x\n") {
		t.Errorf("two-digit range not aligned: %q", formatted)
	}
}

// TestFormatNumberedClampsToFile keeps a stale end line from panicking.
func TestFormatNumberedClampsToFile(t *testing.T) {
	got := formatNumbered([]string{"only", "two"}, 1, 99)
	if !strings.Contains(got, "1| only") || !strings.Contains(got, "2| two") {
		t.Errorf("clamped format = %q", got)
	}
	if strings.Contains(got, "3|") {
		t.Errorf("formatted a line past the end of the file: %q", got)
	}
}

// TestTruncateLine covers the generated-file case: one minified line must not become the whole
// answer.
func TestTruncateLine(t *testing.T) {
	short := "func F() {}"
	if got := truncateLine(short, 400); got != short {
		t.Errorf("short line was altered: %q", got)
	}
	long := strings.Repeat("a", 500)
	got := truncateLine(long, 400)
	if len(got) <= 400 {
		t.Errorf("long line not marked as truncated: %d chars", len(got))
	}
	if !strings.HasSuffix(got, "…") {
		t.Errorf("truncation is not visible in the output: %q", got[len(got)-8:])
	}
}

// TestOutputBudgetReportsOvershoot pins that going over budget is recorded rather than
// silently swallowed: a truncated answer that looks complete is worse than one that says so.
func TestOutputBudgetReportsOvershoot(t *testing.T) {
	budget := &outputBudget{remaining: 10}
	var builder strings.Builder
	budget.write(&builder, "0123456789ABCDEF")
	if budget.remaining != -6 {
		t.Errorf("remaining = %d, want -6", budget.remaining)
	}
	if builder.String() != "0123456789ABCDEF" {
		t.Error("write dropped text instead of recording the overshoot")
	}
}

// TestNewCodeExploreAbsentWithoutIndex is the registration rule: a tool that can only answer
// "there is no index" costs a schema in every request and a round trip to learn nothing.
func TestNewCodeExploreAbsentWithoutIndex(t *testing.T) {
	root := t.TempDir()
	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	if _, ok := NewCodeExplore(workspace, codeintel.New(root, "")); ok {
		t.Error("code_explore registered for a workspace with no index")
	}
}

// TestNewCodeExploreAbsentWithoutARefresher pins the other half of the registration rule:
// the runtime owns the refresher, so a caller that forgot to hand one over gets no tool
// rather than a second one built quietly behind its back.
func TestNewCodeExploreAbsentWithoutARefresher(t *testing.T) {
	root := t.TempDir()
	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	if _, ok := NewCodeExplore(workspace, nil); ok {
		t.Error("code_explore registered with no refresher")
	}
}

// TestNewCodeExploreRejectsNilWorkspace covers the assembly path where there is no workspace.
func TestNewCodeExploreRejectsNilWorkspace(t *testing.T) {
	if _, ok := NewCodeExplore(nil, codeintel.New(t.TempDir(), "")); ok {
		t.Error("code_explore registered with a nil workspace")
	}
}

// TestRunCodeExploreRequiresQuery keeps an empty call from becoming a full-tree dump.
func TestRunCodeExploreRequiresQuery(t *testing.T) {
	refresher := codeintel.New(t.TempDir(), "")
	if _, err := runCodeExplore(t.Context(), refresher, map[string]any{}); err == nil {
		t.Error("an empty query was accepted")
	}
	if _, err := runCodeExplore(t.Context(), refresher, map[string]any{"query": "   "}); err == nil {
		t.Error("a whitespace-only query was accepted")
	}
}

// TestCountCallSitesSkipsContainment pins the filter that keeps a file from being listed as a
// caller of the symbols it declares.
func TestCountCallSitesSkipsContainment(t *testing.T) {
	sites := []cggraph.CallSite{
		{Kind: "contains"},
		{Kind: "calls"},
		{Kind: "instantiates"},
	}
	if got := countCallSites(sites); got != 2 {
		t.Errorf("countCallSites = %d, want 2", got)
	}
}
