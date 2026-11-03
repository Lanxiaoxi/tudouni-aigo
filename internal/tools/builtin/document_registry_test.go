package builtin

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/release"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

func registryForTest(t *testing.T) *Result {
	t.Helper()
	workspace, err := tools.NewWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	result, err := CreateRegistry(Assembly{Workspace: workspace})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// TestReadDocumentIsRegisteredExactlyWhereTheExtractorShips is the Linux / remote-workspace
// rule stated as a test: the tool is in the schema on a platform that ships the binary, and
// is absent — and not reported missing — everywhere else.
func TestReadDocumentIsRegisteredExactlyWhereTheExtractorShips(t *testing.T) {
	t.Setenv(paths.EnvHome, repoRootForTest(t))
	result := registryForTest(t)
	_, registered := result.Tools.Get(DocumentToolName)

	if AnymdPlatformSupported() {
		if !registered {
			t.Fatalf("the platform ships the extractor but the tool is not registered: %v", result.Tools.Names())
		}
		tool, _ := result.Tools.Get(DocumentToolName)
		if tool.Risk != "low" || !tool.ParallelSafe {
			t.Errorf("risk=%s parallel=%v, want low and parallel-safe like read_file", tool.Risk, tool.ParallelSafe)
		}
		return
	}
	if registered {
		t.Fatalf("%s/%s does not ship the extractor, yet the tool is registered", runtime.GOOS, runtime.GOARCH)
	}
	for _, name := range result.Missing {
		if name == DocumentToolName {
			t.Errorf("an unsupported platform must not warn about a tool it was never meant to have")
		}
	}
}

func TestTheLinuxTargetDoesNotShipTheExtractor(t *testing.T) {
	for _, target := range release.Targets {
		wantShip := target.GOOS == "windows"
		if target.HasAnymd() != wantShip {
			t.Errorf("%s: HasAnymd = %v, want %v", target.Triple, target.HasAnymd(), wantShip)
		}
	}
}

// TestAMissingBinaryOnASupportedPlatformIsReportedNotHidden: the install is damaged, and the
// notice dispatch has a case for exactly this name.
func TestAMissingBinaryOnASupportedPlatformIsReportedNotHidden(t *testing.T) {
	if !AnymdPlatformSupported() {
		t.Skip("platform does not ship the extractor")
	}
	// A package root that has prompts/ (so PackageDir accepts it) and no vendored tools.
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "prompts"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(paths.EnvHome, home)

	result := registryForTest(t)
	if _, ok := result.Tools.Get(DocumentToolName); ok {
		t.Fatal("the tool is registered without a binary")
	}
	found := false
	for _, name := range result.Missing {
		found = found || name == DocumentToolName
	}
	if !found {
		t.Errorf("a damaged install must be reported: missing = %v", result.Missing)
	}
}

// TestReadFilePointsAtReadDocumentOnlyWhenItIsRegistered: naming a tool the model cannot call
// is the failure the registry's own comment warns about.
func TestReadFilePointsAtReadDocumentOnlyWhenItIsRegistered(t *testing.T) {
	t.Setenv(paths.EnvHome, repoRootForTest(t))
	workspace, err := tools.NewWorkspace(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	binary := append([]byte("PK\x03\x04"), 0xff, 0xfe, 0x80)
	if err := os.WriteFile(filepath.Join(workspace.Root(), "a.docx"), binary, 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := readFile(workspace, map[string]any{"path": "a.docx"})
	if err != nil {
		t.Fatal(err)
	}
	mentions := strings.Contains(result.Text, DocumentToolName)
	if AnymdPlatformSupported() != mentions {
		t.Errorf("platform supported = %v but read_file's answer mentions the tool = %v:\n%s",
			AnymdPlatformSupported(), mentions, result.Text)
	}
	if !strings.Contains(result.Text, "不是 UTF-8 文本") {
		t.Errorf("the original refusal must stay: %s", result.Text)
	}

	// Old Office formats get the "save as" advice, still only when the tool exists.
	if err := os.WriteFile(filepath.Join(workspace.Root(), "b.doc"), []byte{0xD0, 0xCF, 0x11, 0xE0, 0x80}, 0o644); err != nil {
		t.Fatal(err)
	}
	old, _ := readFile(workspace, map[string]any{"path": "b.doc"})
	if AnymdPlatformSupported() != strings.Contains(old.Text, "另存为") {
		t.Errorf("old-format advice does not follow registration: %s", old.Text)
	}
}
