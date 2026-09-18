package release

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestTargetsHaveAVendoredRipgrep is the rule the target list exists to obey.
//
// Shipping a platform whose ripgrep is not vendored produces a program that starts
// normally with `grep` silently absent — the failure this package is written to
// prevent. So the list is checked against the directory rather than trusted.
func TestTargetsHaveAVendoredRipgrep(t *testing.T) {
	root := repoRoot(t)
	for _, target := range Targets {
		path := filepath.Join(root, "tools", "vendor", "rg", target.Triple, target.RgName())
		info, err := os.Stat(path)
		if err != nil {
			t.Errorf("%s/%s: no vendored ripgrep at %s — do not ship this target until it is vendored",
				target.GOOS, target.GOARCH, target.Triple)
			continue
		}
		if info.Size() < 1_000_000 {
			t.Errorf("%s: %s is only %d bytes, which is not a ripgrep build", target.Triple, path, info.Size())
		}
	}
}

// TestTargetsAreTheTwoWeShip — Windows and Linux, x86_64. Adding one is fine, but
// it has to come with a ripgrep (see the test above).
func TestTargetsAreTheTwoWeShip(t *testing.T) {
	got := make([]string, 0, len(Targets))
	for _, target := range Targets {
		got = append(got, target.GOOS+"/"+target.GOARCH)
	}
	want := "windows/amd64,linux/amd64"
	if strings.Join(got, ",") != want {
		t.Fatalf("targets = %v, want %s", got, want)
	}
}

// TestArchiveNamesCarryTheVersionAndTriple — the file name is what a user picks
// out of a download page, so it has to say which version and which platform.
func TestArchiveNamesCarryTheVersionAndTriple(t *testing.T) {
	windows, linux := Targets[0], Targets[1]
	if got := ArchiveName("1.2.3", windows); got != "tudouni-1.2.3-x86_64-pc-windows-msvc.zip" {
		t.Errorf("windows archive: %s", got)
	}
	if got := ArchiveName("1.2.3", linux); got != "tudouni-1.2.3-x86_64-unknown-linux-musl.zip" {
		t.Errorf("linux archive: %s", got)
	}
	if got := StageDirName("1.2.3", windows); got != "tudouni-1.2.3-x86_64-pc-windows-msvc" {
		t.Errorf("stage dir: %s", got)
	}
}

// TestVersionFromPrefersTheFile — the committed VERSION file is the release
// version; a dirty checkout must not rename the artifact.
func TestVersionFromPrefersTheFile(t *testing.T) {
	cases := []struct {
		file, env, git, want string
	}{
		{"0.1.0\n", "", "abc-dirty", "0.1.0"},
		{"", "9.9.9", "abc-dirty", "9.9.9"},
		{"", "", "abc-dirty", "abc-dirty"},
		{"", "", "", "dev"},
		{"  \n", "  ", "", "dev"},
	}
	for _, want := range cases {
		if got := VersionFrom(want.file, want.env, want.git); got != want.want {
			t.Errorf("VersionFrom(%q,%q,%q) = %q, want %q", want.file, want.env, want.git, got, want.want)
		}
	}
}

// TestCheckLayoutReportsEveryMissingPiece — the check has to name what is absent,
// because "the package is bad" is not something a person can act on.
func TestCheckLayoutReportsEveryMissingPiece(t *testing.T) {
	root := t.TempDir()
	target := Targets[0]
	layout := Layout{
		Root:          root,
		Target:        target,
		Binary:        filepath.Join(root, target.BinaryName()),
		PromptsDir:    filepath.Join(root, "prompts"),
		RgBinary:      filepath.Join(root, "tools", "vendor", "rg", target.Triple, target.RgName()),
		ExampleConfig: filepath.Join(root, "config.example.json"),
	}

	missing := layout.CheckLayout()
	// Everything is absent: the binary, the prompts directory, ripgrep, the
	// configuration template and the three files that travel with the package.
	if len(missing) != 7 {
		t.Fatalf("expected 7 missing entries, got %d: %v", len(missing), missing)
	}
	for _, label := range []string{"executable", "prompts", "ripgrep", "config.example.json", "install.ps1", "install.sh", "README.txt"} {
		found := false
		for _, entry := range missing {
			if strings.Contains(entry, label) {
				found = true
			}
		}
		if !found {
			t.Errorf("the report does not mention %s: %v", label, missing)
		}
	}

	// An empty file counts as missing: a zero-byte ripgrep is in the tree and
	// still unusable, and a size check is the only thing that catches it.
	for _, path := range []string{layout.Binary, layout.RgBinary} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, nil, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(layout.PromptsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"install.ps1", "install.sh", "README.txt", "config.example.json"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	missing = layout.CheckLayout()
	if len(missing) != 2 {
		t.Fatalf("empty files must still be reported, got %v", missing)
	}
	for _, entry := range missing {
		if !strings.Contains(entry, "empty") {
			t.Errorf("an empty file should say so: %q", entry)
		}
	}
}

// TestZipRoundTripsAndRefusesSource — the archive is re-opened, because a staged
// directory having a file says nothing about what the walk put in the zip.
func TestZipRoundTripsAndRefusesSource(t *testing.T) {
	root := t.TempDir()
	target := Targets[1]
	layout := Layout{
		Root:          root,
		Target:        target,
		Binary:        filepath.Join(root, target.BinaryName()),
		PromptsDir:    filepath.Join(root, "prompts"),
		RgBinary:      filepath.Join(root, "tools", "vendor", "rg", target.Triple, target.RgName()),
		ExampleConfig: filepath.Join(root, "config.example.json"),
	}
	if err := os.MkdirAll(layout.PromptsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(layout.PromptsDir, "system.zh.md"), []byte("# prompt"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(layout.PromptsDir, "prompts.go"), []byte("package prompts"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{layout.Binary, layout.RgBinary} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("binary"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"install.ps1", "install.sh", "README.txt", "config.example.json"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	archive := filepath.Join(t.TempDir(), "out.zip")
	size, err := layout.Zip(archive)
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	if size == 0 {
		t.Fatal("the archive is empty")
	}
	names, err := ArchiveNames(archive)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	have := map[string]bool{}
	for _, name := range names {
		have[name] = true
		if strings.Contains(name, "\\") {
			t.Errorf("a zip entry uses a backslash: %q — it unpacks on Linux as one file", name)
		}
	}
	for _, want := range []string{"tudouni", "prompts/system.zh.md", "config.example.json",
		"install.ps1", "install.sh", "README.txt",
		"tools/vendor/rg/" + target.Triple + "/rg"} {
		if !have[want] {
			t.Errorf("%s is missing from the archive: %v", want, names)
		}
	}
	// Staging drops Go sources, but the **archive** is checked independently: a
	// tree that somehow contains one must be refused, not quietly shipped.
	if err := layout.CheckArchive(archive); err == nil {
		t.Fatal("CheckArchive accepted an archive containing a .go file")
	} else if !strings.Contains(err.Error(), "source code") {
		t.Fatalf("the complaint should name the problem: %v", err)
	}
	if err := os.Remove(filepath.Join(layout.PromptsDir, "prompts.go")); err != nil {
		t.Fatal(err)
	}
	// The archive has to be rewritten: the check reads the file, not the tree.
	if _, err := layout.Zip(archive); err != nil {
		t.Fatal(err)
	}
	if err := layout.CheckArchive(archive); err != nil {
		t.Fatalf("a clean archive must pass: %v", err)
	}

	// And a missing member is reported by name.
	if err := os.Remove(layout.RgBinary); err != nil {
		t.Fatal(err)
	}
	if _, err := layout.Zip(archive); err != nil {
		t.Fatal(err)
	}
	if err := layout.CheckArchive(archive); err == nil {
		t.Fatal("CheckArchive accepted an archive with no ripgrep")
	} else if !strings.Contains(err.Error(), "ripgrep") {
		t.Fatalf("the complaint should name the missing piece: %v", err)
	}
}

// TestHostTargetMatchesThisMachine — the verification step runs the binary only
// when the target is the host, so this lookup deciding wrongly would either skip
// the check or try to execute a foreign binary.
func TestHostTargetMatchesThisMachine(t *testing.T) {
	host, ok := HostTarget()
	if !ok {
		t.Skipf("this machine (%s/%s) is not a release target", runtime.GOOS, runtime.GOARCH)
	}
	if host.GOOS != runtime.GOOS || host.GOARCH != runtime.GOARCH {
		t.Fatalf("host target = %s/%s, running on %s/%s", host.GOOS, host.GOARCH, runtime.GOOS, runtime.GOARCH)
	}
}

// repoRoot walks up to the module root so the test can look at the vendored
// ripgrep wherever it is run from.
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
			t.Fatal("no go.mod above the test's directory")
		}
		dir = parent
	}
}
