package builtin

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// presentCall runs the tool the way the agent does — through the schema — and
// returns the whole result rather than its text, because the point of this tool is
// the **audit** half: a declaration the interface cannot read is a tool that
// silently does nothing.
func presentCall(t *testing.T, tool tools.Tool, arguments map[string]any) (tools.Result, error) {
	t.Helper()
	validated, err := tools.Validate(tool.Parameters(), arguments)
	if err != nil {
		t.Fatalf("the arguments do not validate: %v", err)
	}
	return tool.Execute(context.Background(), validated)
}

func newPresentWorkspace(t *testing.T) (*tools.Workspace, tools.Tool) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "report.md"), []byte("# hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	return workspace, NewPresent(workspace)
}

// deliverablesOf pulls the audit half out, failing loudly when it is missing.
//
// A separate reader rather than an inline assertion because the *shape* is the
// contract with the interface: `[]deliverable` with a `path` and an optional
// `description`. If this ever became a `[]map[string]any` or a `[]string`, every
// card on screen would go blank at once, and the failure would look like a
// rendering bug rather than a change of type.
func deliverablesOf(t *testing.T, result tools.Result) []deliverable {
	t.Helper()
	raw, ok := result.Audit["deliverables"]
	if !ok {
		t.Fatalf("the result carries no deliverables: %#v", result.Audit)
	}
	files, ok := raw.([]deliverable)
	if !ok {
		t.Fatalf("deliverables is %T, want []deliverable", raw)
	}
	return files
}

// TestPresentDeclaresAPathAndItsDescription is the ordinary case, and it pins the
// two facts the interface reads.
func TestPresentDeclaresAPathAndItsDescription(t *testing.T) {
	_, tool := newPresentWorkspace(t)

	result, err := presentCall(t, tool, map[string]any{
		"files": []any{map[string]any{"path": "report.md", "description": "性能分析报告"}},
	})
	if err != nil {
		t.Fatalf("present returned an error: %v", err)
	}

	files := deliverablesOf(t, result)
	if len(files) != 1 {
		t.Fatalf("declared %d files, want 1", len(files))
	}
	if files[0].Path != "report.md" {
		t.Fatalf("path is %q, want report.md", files[0].Path)
	}
	if files[0].Description != "性能分析报告" {
		t.Fatalf("description is %q", files[0].Description)
	}
	// The model's half says what was declared, and says that nothing was copied:
	// without that sentence "Presented" reads as "uploaded" and the model tells the
	// user a copy exists.
	if !strings.Contains(result.Text, "Presented report.md") {
		t.Fatalf("the result text does not name the file: %q", result.Text)
	}
	if !strings.Contains(result.Text, "no copy was made") {
		t.Fatalf("the result text does not say the file stayed put: %q", result.Text)
	}
}

// TestPresentWithoutADescriptionLeavesItAbsent.
//
// Absent, not empty. The card falls back to the file type when there is no
// description, and an empty string is not a description — it renders as a blank
// line under the file name, which reads as a bug in the card rather than as "the
// model did not write one".
func TestPresentWithoutADescriptionLeavesItAbsent(t *testing.T) {
	_, tool := newPresentWorkspace(t)

	result, err := presentCall(t, tool, map[string]any{
		"files": []any{map[string]any{"path": "report.md"}},
	})
	if err != nil {
		t.Fatalf("present returned an error: %v", err)
	}
	if got := deliverablesOf(t, result)[0].Description; got != "" {
		t.Fatalf("description is %q, want the empty string", got)
	}
}

// TestPresentRefusesAPathOutsideTheWorkspace is the boundary.
//
// **This is the one failure that must not become a text result.** A card is an
// invitation to open a file, so a declaration pointing outside the workspace is a
// way to get a person to open something the agent itself is not allowed to touch —
// and a model that reads a friendly refusal will try the next path.
func TestPresentRefusesAPathOutsideTheWorkspace(t *testing.T) {
	_, tool := newPresentWorkspace(t)
	outside := filepath.Join(t.TempDir(), "elsewhere.md")
	if err := os.WriteFile(outside, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{
		outside,
		filepath.Join("..", "elsewhere.md"),
	} {
		_, err := presentCall(t, tool, map[string]any{
			"files": []any{map[string]any{"path": path}},
		})
		if err == nil {
			t.Fatalf("presenting %q was allowed; it is outside the workspace", path)
		}
	}
}

// TestPresentRefusesAMissingFileAndADirectoryAsText.
//
// Both are ordinary: the model declared the file before writing it, or pointed at a
// directory. Both are answerable by trying again with a different argument, so both
// are text — an error would end the call and teach the model nothing.
func TestPresentRefusesAMissingFileAndADirectoryAsText(t *testing.T) {
	_, tool := newPresentWorkspace(t)

	for _, tc := range []struct{ name, path string }{
		{"missing", "nope.md"},
		{"directory", "dist"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := presentCall(t, tool, map[string]any{
				"files": []any{map[string]any{"path": tc.path}},
			})
			if err != nil {
				t.Fatalf("an ordinary refusal came back as an error: %v", err)
			}
			if _, declared := result.Audit["deliverables"]; declared {
				t.Fatalf("a refused file was still declared: %#v", result.Audit)
			}
			if !strings.Contains(result.Text, tc.path) {
				t.Fatalf("the refusal does not name the path: %q", result.Text)
			}
		})
	}
}

// TestPresentIsAllOrNothing.
//
// The dangerous shape is a partial declaration: three files land on screen while the
// model reads an error about the fourth and concludes that nothing was declared.
// Two answers to one question, and the one on screen is the wrong one.
func TestPresentIsAllOrNothing(t *testing.T) {
	_, tool := newPresentWorkspace(t)

	result, err := presentCall(t, tool, map[string]any{
		"files": []any{
			map[string]any{"path": "report.md"},
			map[string]any{"path": "nope.md"},
		},
	})
	if err != nil {
		t.Fatalf("an ordinary refusal came back as an error: %v", err)
	}
	if _, declared := result.Audit["deliverables"]; declared {
		t.Fatalf("one bad path still declared the good one: %#v", result.Audit)
	}
	if !strings.Contains(result.Text, "nope.md") {
		t.Fatalf("the refusal does not name the bad path: %q", result.Text)
	}
}

// TestPresentEnforcesItsCeiling.
//
// The schema describes one item and cannot bound the list, so the count is checked
// in the handler. A limit the description states and the code does not enforce is
// worse than no limit: the model reads it, sends one more, and learns the number is
// decoration.
func TestPresentEnforcesItsCeiling(t *testing.T) {
	_, tool := newPresentWorkspace(t)

	many := make([]any, 0, MaxDeclaredFiles+1)
	for i := 0; i <= MaxDeclaredFiles; i++ {
		many = append(many, map[string]any{"path": "report.md"})
	}
	result, err := presentCall(t, tool, map[string]any{"files": many})
	if err != nil {
		t.Fatalf("present returned an error: %v", err)
	}
	if _, declared := result.Audit["deliverables"]; declared {
		t.Fatalf("%d files were declared, the ceiling is %d", len(many), MaxDeclaredFiles)
	}

	empty, err := presentCall(t, tool, map[string]any{"files": []any{}})
	if err != nil {
		t.Fatalf("present returned an error: %v", err)
	}
	if _, declared := empty.Audit["deliverables"]; declared {
		t.Fatalf("an empty list declared something: %#v", empty.Audit)
	}
}

// TestPresentDeclaresNothingItRead.
//
// **The invariant the whole capability rests on.** What travels to the interface is
// a path; the bytes stay on disk. A declaration that had read the file would put
// them on the protocol line this tool exists to keep them off — and it would do it
// for a file nobody ever opens.
//
// Verified by declaring a file this test cannot read content from as text: it is
// deliberately not valid UTF-8, so the day somebody "helpfully" adds a size or a
// first-line preview to the audit record, this test is what notices.
func TestPresentDeclaresNothingItRead(t *testing.T) {
	root := t.TempDir()
	binary := filepath.Join(root, "blob.bin")
	if err := os.WriteFile(binary, []byte{0xff, 0xfe, 0x00, 0x01}, 0o644); err != nil {
		t.Fatal(err)
	}
	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	tool := NewPresent(workspace)

	result, err := presentCall(t, tool, map[string]any{
		"files": []any{map[string]any{"path": "blob.bin"}},
	})
	if err != nil {
		t.Fatalf("a non-UTF-8 file must be declarable — reading it is not this tool's job: %v", err)
	}
	if files := deliverablesOf(t, result); len(files) != 1 {
		t.Fatalf("declared %d files, want 1", len(files))
	}
	// Only the two fields may travel. `reflect`-free on purpose: the struct is the
	// contract, and a new field is a deliberate edit here rather than an accident.
	if result.Audit["deliverables"] != nil && len(result.Audit) != 1 {
		t.Fatalf("the audit carries more than the declaration: %#v", result.Audit)
	}
}

// TestPresentIsNotParallelSafe.
//
// A declaration is a statement about a whole turn — "this turn's output is these
// files" — so two of them must not run at once. The registry enforces the
// interactive/parallel pair, but nothing enforces this one, which is exactly why it
// is asserted here.
func TestPresentIsNotParallelSafe(t *testing.T) {
	_, tool := newPresentWorkspace(t)
	if tool.ParallelSafe {
		t.Fatal("present declares itself parallel-safe; it describes a whole turn")
	}
	if tool.Risk != "low" {
		t.Fatalf("present declares risk %q; it changes nothing on disk", tool.Risk)
	}
}

// TestPresentRefusesALinkOutOfTheWorkspace is the Windows junction case, and it is
// skipped where a link cannot be made without privileges.
func TestPresentRefusesALinkOutOfTheWorkspace(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating a link on Windows needs a privilege the test runner may not have")
	}
	root := t.TempDir()
	elsewhere := t.TempDir()
	if err := os.WriteFile(filepath.Join(elsewhere, "secret.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, filepath.Join(root, "link")); err != nil {
		t.Skipf("cannot create a symlink here: %v", err)
	}
	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}

	_, err = presentCall(t, NewPresent(workspace), map[string]any{
		"files": []any{map[string]any{"path": filepath.Join("link", "secret.md")}},
	})
	if err == nil {
		t.Fatal("a file reached through a link out of the workspace was declared")
	}
}
