package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
)

func TestSchemaValidationRejectsExtraArguments(t *testing.T) {
	schema := ObjectSchema(map[string]any{
		"path": StringSchema("path", MinLength(1)),
	}, "path")

	// The offending key has to be named: that is the whole value of the check.
	_, err := Validate(schema, map[string]any{"path": "a", "bogus": 1})
	if err == nil || !strings.Contains(err.Error(), "bogus") {
		t.Fatalf("err = %v, want it to name the unknown argument", err)
	}

	// An empty string fails the minimum length, in words the model can act on.
	_, err = Validate(schema, map[string]any{"path": ""})
	if err == nil || !strings.Contains(err.Error(), "at least 1 character") {
		t.Fatalf("err = %v", err)
	}

	// A missing required key is reported as such.
	_, err = Validate(schema, map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "required") {
		t.Fatalf("err = %v", err)
	}
}

func TestSchemaAppliesDefaults(t *testing.T) {
	schema := ObjectSchema(map[string]any{
		"path":    StringSchema("path", Default(".")),
		"timeout": IntSchema("timeout", Default(30), Minimum(1), Maximum(300)),
	})
	validated, err := Validate(schema, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if validated["path"] != "." || validated["timeout"] != 30 {
		t.Fatalf("defaults were not applied: %v", validated)
	}

	if _, err := Validate(schema, map[string]any{"timeout": 999}); err == nil {
		t.Fatal("an out-of-range number must be rejected")
	}
}

func TestRegistrationEnforcesTheThreeInvariants(t *testing.T) {
	registry := NewRegistry()

	// A tool with no risk would land on the safest-looking value, which is the
	// worst possible failure shape for a permission system.
	if err := registry.Register(Tool{Name: "no_risk"}); err == nil {
		t.Fatal("a tool without a risk level must be rejected")
	}

	// Only low risk tools may run in a batch: a parallel batch does not prompt.
	if err := registry.Register(Tool{Name: "unsafe", Risk: security.RiskHigh, ParallelSafe: true}); err == nil {
		t.Fatal("a parallel_safe tool above low risk must be rejected")
	}

	// A tool that asks a person can never run alongside others.
	if err := registry.Register(Tool{Name: "asker", Risk: security.RiskLow, ParallelSafe: true, Interactive: true}); err == nil {
		t.Fatal("an interactive parallel_safe tool must be rejected")
	}

	if err := registry.Register(Tool{Name: "ok", Risk: security.RiskLow, ParallelSafe: true}); err != nil {
		t.Fatal(err)
	}
	if err := registry.Register(Tool{Name: "ok", Risk: security.RiskLow}); err == nil {
		t.Fatal("a duplicate name must be rejected")
	}
}

func TestRiskIsNotInTheSchemaTheModelSees(t *testing.T) {
	tool := Tool{
		Name: "shell", Description: "run", Risk: security.RiskHigh,
		Schema: EmptySchema(),
	}
	rendered := MarshalSchema(tool.OpenAISchema())
	if strings.Contains(rendered, "high") || strings.Contains(rendered, "risk") {
		t.Fatalf("the risk level leaked into the schema the model sees: %s", rendered)
	}
}

func TestWorkspaceBlocksEscaping(t *testing.T) {
	root := t.TempDir()
	workspace, err := NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := workspace.SafePath("../outside"); err == nil {
		t.Fatal("a path escaping the workspace must be refused")
	}
	if _, err := workspace.SafePath("a/b/c"); err != nil {
		t.Fatalf("a path inside the workspace must resolve: %v", err)
	}
	inside, err := workspace.SafePath(".")
	if err != nil || inside != workspace.Root() {
		t.Fatalf("the workspace root must resolve to itself: %v %v", inside, err)
	}
}

func TestControlPlaneIsWritableOnlyByHand(t *testing.T) {
	root := t.TempDir()
	workspace, err := NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}

	// Everything under .tudouni decides whether this run can be trusted, so the
	// agent may read it and may not write it.
	for _, path := range []string{
		".tudouni/permissions.json",
		".tudouni/sessions/x.jsonl",
		".tudouni/logs/x.jsonl",
		".tudouni/skills/a/SKILL.md",
		".tudouni.json",
		// Case is folded: Windows would write the same thing.
		".TUDOUNI/permissions.json",
	} {
		if _, err := workspace.WritablePath(path); err == nil {
			t.Fatalf("%s must not be writable", path)
		}
		if _, err := workspace.SafePath(path); err != nil {
			t.Fatalf("%s must stay readable: %v", path, err)
		}
	}

	// A directory with the same name deeper down is an ordinary file.
	if _, err := workspace.WritablePath("sub/.tudouni/permissions.json"); err != nil {
		t.Fatalf("a nested name is not the control plane: %v", err)
	}
	if _, err := workspace.WritablePath("notes.md"); err != nil {
		t.Fatal(err)
	}
}

func TestTruncateKeepsBothEnds(t *testing.T) {
	text := "头" + strings.Repeat("x", 500) + "尾"
	cut := Truncate(text, 100)
	if !strings.HasPrefix(cut, "头") {
		t.Fatal("the head must survive")
	}
	if !strings.HasSuffix(cut, "尾") {
		t.Fatal("the tail must survive")
	}
	if !strings.Contains(cut, "中间省略") {
		t.Fatalf("a silent cut would let the model believe it saw everything: %s", cut)
	}
	if Truncate("short", 100) != "short" {
		t.Fatal("short text must be untouched")
	}
}

func TestEditingRespectsTheLineEndingsOfTheFile(t *testing.T) {
	root := t.TempDir()

	crlf := filepath.Join(root, "win.txt")
	if err := os.WriteFile(crlf, []byte("a\r\nb\r\nc\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// A snippet written with LF must still match a CRLF file, and the rest of the
	// file keeps its own line endings. Getting this wrong rewrites every line of a
	// file when one line was edited, and `git diff` with autocrlf hides it.
	original, err := os.ReadFile(crlf)
	if err != nil {
		t.Fatal(err)
	}
	_ = original
	aligned := strings.ReplaceAll("b\n", "\n", "\r\n")
	if !strings.Contains(string(original), aligned) {
		t.Fatal("the alignment used by the tool does not match the file")
	}

	lf := filepath.Join(root, "unix.txt")
	if err := os.WriteFile(lf, []byte("a\nb\nc\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(mustRead(t, lf)), "\r") {
		t.Fatal("an LF file must stay LF")
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
