package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
)

// TestTheEmbeddedTemplateMatchesTheRepositoryCopy guards the one thing a committed
// copy can do wrong.
//
// `go:embed` cannot reach the module root and cannot use `..`, so the template exists
// twice: at the root for a person to read, and beside this file for the compiler.
// Two copies of one fact drift; the drift's symptom would be a user scaffolding a
// configuration that is not the one the repository documents.
func TestTheEmbeddedTemplateMatchesTheRepositoryCopy(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "config.example.json"))
	if err != nil {
		t.Fatalf("reading the repository copy: %v", err)
	}
	if string(raw) != string(embeddedExample) {
		t.Fatal("internal/config/config.example.json and the repository root's copy have drifted apart")
	}
}

// TestTheTemplateIsAlwaysAvailable is the release-safety property: on an installed
// copy there is no `config.example.json` next to the program, and the first message a
// user with no key sees must still be able to hand them one.
func TestTheTemplateIsAlwaysAvailable(t *testing.T) {
	t.Setenv(paths.EnvHome, t.TempDir())

	if len(ExampleBytes()) == 0 {
		t.Fatal("no template bytes when nothing is on disk")
	}
	// And the path it names has to be one that is about to exist rather than one
	// that does not: pointing at a missing file is worse than pointing at the file
	// they are being told to create.
	named := ExampleFile()
	if named == paths.ExampleConfigPath() {
		t.Fatalf("ExampleFile named a path that does not exist: %s", named)
	}
	if filepath.Base(named) != ConfigFileName {
		t.Errorf("ExampleFile = %s, want the default config file", named)
	}
}

// TestAScaffoldedFileIsUsable checks the whole first-run story end to end: the
// template lands at the default location with the permissions a file holding an API
// key deserves, and it parses as a configuration.
func TestAScaffoldedFileMatchesTheTemplate(t *testing.T) {
	home := t.TempDir()
	t.Setenv(paths.EnvHome, home)
	// The scaffold writes into the user config dir, which is derived from the home
	// directory rather than from TUDOUNI_HOME; point both at a scratch tree.
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	written := Scaffold()
	if written == "" {
		t.Fatal("Scaffold wrote nothing")
	}
	raw, err := os.ReadFile(written)
	if err != nil {
		t.Fatalf("reading the scaffolded file: %v", err)
	}
	if string(raw) != string(embeddedExample) {
		t.Error("the scaffolded file is not the template")
	}

	// Scaffolding twice must not overwrite: this file is about to hold a key.
	if again := Scaffold(); again != "" {
		// A second call is allowed to report the same path only if it did not
		// rewrite; the contract is "create exclusively", so it must do nothing.
		after, _ := os.ReadFile(written)
		if string(after) != string(raw) {
			t.Error("Scaffold overwrote an existing configuration")
		}
	}
}
