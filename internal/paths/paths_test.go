package paths

import (
	"os"
	"path/filepath"
	"testing"
)

// TestTheFourResourceCategoriesTravelWithTheCode pins the packaging requirement
// that used to live in the Python project's own test suite.
//
// Four kinds of file have to ship with the program, and a missing one does not
// produce an error — it produces a program that starts and is quietly missing a
// feature. That is the failure shape this test exists to catch:
//
//   - prompts/            the system prompt, sent to the model on every turn;
//   - config.example.json the template a new user is handed;
//   - protocol/schema/    the shape of the protocol, for other front ends;
//   - tools/vendor/rg/    the search engine, without which grep is absent.
func TestTheFourResourceCategoriesTravelWithTheCode(t *testing.T) {
	root := repoRoot(t)

	for _, relative := range []string{
		filepath.Join(PromptsDirName, "system.zh.md"),
		filepath.Join(PromptsDirName, "compact.zh.md"),
		"config.example.json",
		filepath.Join("protocol", "schema", "inbound.schema.json"),
		filepath.Join("protocol", "schema", "outbound.schema.json"),
		filepath.Join("tools", "vendor", "rg", "README.md"),
	} {
		if _, err := os.Stat(filepath.Join(root, relative)); err != nil {
			t.Fatalf("%s must ship with the code: %v", relative, err)
		}
	}
}

// TestTheVendoredEngineHasBothPlatforms is the grep-specific half: the binaries are
// committed, so a platform that is supported in code but missing its build would
// only be discovered by a user on that platform.
func TestTheVendoredEngineHasBothPlatforms(t *testing.T) {
	root := repoRoot(t)
	for _, relative := range []string{
		filepath.Join("tools", "vendor", "rg", "x86_64-pc-windows-msvc", "rg.exe"),
		filepath.Join("tools", "vendor", "rg", "x86_64-unknown-linux-musl", "rg"),
	} {
		info, err := os.Stat(filepath.Join(root, relative))
		if err != nil {
			t.Fatalf("%s is missing: %v", relative, err)
		}
		if info.Size() == 0 {
			t.Fatalf("%s is empty", relative)
		}
	}
}

func TestUnsafeWorkspaceRefusesTheThreeWideCases(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home directory to test against")
	}

	// read_file needs no approval, so starting in the home directory would hand
	// over .ssh and everything else below it without anybody being asked twice.
	if kind := UnsafeWorkspace(home); kind != WorkspaceIsHome {
		t.Fatalf("UnsafeWorkspace(home) = %q, want home", kind)
	}
	if kind := UnsafeWorkspace(filepath.Dir(home)); kind != WorkspaceAboveHome {
		t.Fatalf("UnsafeWorkspace(parent of home) = %q, want above-home", kind)
	}
	root := filepath.VolumeName(home) + string(filepath.Separator)
	if kind := UnsafeWorkspace(root); kind != WorkspaceIsRoot {
		t.Fatalf("UnsafeWorkspace(root) = %q, want root", kind)
	}
	if kind := UnsafeWorkspace(t.TempDir()); kind != WorkspaceOK {
		t.Fatalf("a concrete project directory must be usable, got %q", kind)
	}
}

// repoRoot walks up from the test's working directory to the module root.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not find the module root")
		}
		dir = parent
	}
}
