// Package release builds the shipped archives.
//
// It is the Go replacement for the old `scripts/build_release.py`, and it keeps
// that script's two commitments:
//
//  1. **A user gets one archive**: unpack it, run the installer, and the program
//     works. Nothing else to fetch.
//  2. **The archive is verified before it is called done.** The failure mode a
//     release package actually has is not "it will not start" — it is "it starts
//     and one feature is quietly missing", because a resource the packaging step
//     forgot to carry is invisible in the source tree where the tests run. So the
//     steps here open the artifact, look at what is in it, and run the binary.
//
// The one structural difference from the Python version: Go cross-compiles, so a
// single run produces **both** platforms, where PyInstaller had to be run once per
// platform. The verification of a foreign-platform binary stops at "it is in the
// archive and the right ripgrep is next to it" — it cannot be executed here.
package release

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Module is the import path the linker needs for `-X`.
const Module = "github.com/Lanxiaoxi/tudouni-aigo"

// VersionVar is where the build writes the version.
var VersionVar = Module + "/internal/version.Version"

// Target is one platform to build for.
//
// `Triple` is the ripgrep release triple, and it is also the archive's name. That
// is deliberate: the vendored ripgrep directory is keyed by exactly this string,
// so a mapping table between "the platform we ship" and "the rg we ship" would be
// a second source of truth that can drift.
type Target struct {
	GOOS   string
	GOARCH string
	Triple string
}

// Targets is what gets released.
//
// **amd64 only**, because that is what `tools/vendor/rg` has. Shipping an arm64
// build would produce a program whose `grep` tool is silently absent — the exact
// class of failure this package is written to prevent — so the missing platform is
// reported instead of half-built. Adding one means vendoring its ripgrep first
// (see tools/vendor/rg/README.md).
var Targets = []Target{
	{GOOS: "windows", GOARCH: "amd64", Triple: "x86_64-pc-windows-msvc"},
	{GOOS: "linux", GOARCH: "amd64", Triple: "x86_64-unknown-linux-musl"},
}

// BinaryName is the executable's name inside the archive.
func (t Target) BinaryName() string {
	if t.GOOS == "windows" {
		return "tudouni.exe"
	}
	return "tudouni"
}

// RgName is the vendored ripgrep's file name for this target.
func (t Target) RgName() string {
	if t.GOOS == "windows" {
		return "rg.exe"
	}
	return "rg"
}

// HostTarget returns the target matching the machine we are running on.
func HostTarget() (Target, bool) {
	for _, target := range Targets {
		if target.GOOS == runtime.GOOS && target.GOARCH == runtime.GOARCH {
			return target, true
		}
	}
	return Target{}, false
}

// ArchiveName is what the user downloads.
func ArchiveName(version string, target Target) string {
	return fmt.Sprintf("tudouni-%s-%s.zip", version, target.Triple)
}

// StageDirName is the directory the archive is built from. It is kept after the
// zip is written: it is what you inspect when a user reports that something is
// missing.
func StageDirName(version string, target Target) string {
	return fmt.Sprintf("tudouni-%s-%s", version, target.Triple)
}

// Layout is one staged release directory.
type Layout struct {
	Root       string
	Target     Target
	Binary     string
	PromptsDir string
	RgBinary   string
	// ExampleConfig is the configuration template. Its bytes are compiled in, so a
	// package without it still works — which is exactly why it belongs on the
	// required list: "it starts and one thing is missing" is this package's
	// characteristic failure, and a template is the first thing a new user is told
	// to open.
	ExampleConfig string
}

// RequiredFiles lists what must exist in a staged package, relative to its root.
//
// Missing any one of them produces a program that starts and is quietly missing a
// feature, so the list is checked against the staged tree rather than assumed from
// the build having succeeded.
func (l Layout) RequiredFiles() map[string]string {
	return map[string]string{
		"the executable":        l.Binary,
		"the prompts directory": l.PromptsDir,
		"the vendored ripgrep":  l.RgBinary,
		"config.example.json":   l.ExampleConfig,
		"install.ps1":           filepath.Join(l.Root, "install.ps1"),
		"install.sh":            filepath.Join(l.Root, "install.sh"),
		"README.txt":            filepath.Join(l.Root, "README.txt"),
	}
}

// CheckLayout reports what a staged directory is missing, sorted by label.
//
// The prompts directory is on the list even though its contents are compiled in:
// `paths.PackageDir` uses the directory's **presence** to decide it has found the
// package root, and the vendored ripgrep is then looked up relative to that root.
// Without it the root resolution falls through to the working directory, `grep` is
// not registered, and the only symptom is one line on stderr at startup.
func (l Layout) CheckLayout() []string {
	required := l.RequiredFiles()
	labels := make([]string, 0, len(required))
	for label := range required {
		labels = append(labels, label)
	}
	sortStrings(labels)

	var missing []string
	for _, label := range labels {
		path := required[label]
		info, err := os.Stat(path)
		if err != nil {
			missing = append(missing, fmt.Sprintf("%s (%s)", label, l.relative(path)))
			continue
		}
		if info.IsDir() {
			continue
		}
		if info.Size() == 0 {
			missing = append(missing, fmt.Sprintf("%s is empty (%s)", label, l.relative(path)))
		}
	}
	return missing
}

func (l Layout) relative(path string) string {
	if rel, err := filepath.Rel(l.Root, path); err == nil {
		return rel
	}
	return path
}

// Zip writes the archive and returns its size.
//
// Deflate level 9: the archive is downloaded by people, and the binary is the only
// large member. `zip` rather than `tar.gz` because one archive format on both
// platforms is one thing to explain — the price is that zip does not carry POSIX
// permission bits, so the Linux archive unpacks with `install.sh` at 644. The
// README says to `chmod +x` it, and the installer sets the exec bit on the binary
// and on the vendored ripgrep. Those three together are what closes that gap.
func (l Layout) Zip(path string) (int64, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return 0, err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return 0, err
	}
	file, err := os.Create(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	archive := zip.NewWriter(file)
	// `archive/zip` compresses with flate's default level and does not expose it.
	// Registering our own writer is how the level gets raised — the largest member
	// is a 24 MB executable, so the difference is worth the four lines.
	archive.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(out, flate.BestCompression)
	})
	walkErr := filepath.Walk(l.Root, func(item string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(l.Root, item)
		if err != nil {
			return err
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		// Always forward slashes, also on Windows: a zip made on Windows with
		// backslashes unpacks on Linux as a single file whose name contains them.
		header.Name = filepath.ToSlash(relative)
		header.Method = zip.Deflate
		writer, err := archive.CreateHeader(header)
		if err != nil {
			return err
		}
		source, err := os.Open(item)
		if err != nil {
			return err
		}
		defer source.Close()
		_, err = io.Copy(writer, source)
		return err
	})
	if walkErr != nil {
		archive.Close()
		return 0, walkErr
	}
	if err := archive.Close(); err != nil {
		return 0, err
	}
	info, err := file.Stat()
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// ArchiveNames lists the entries of a zip, for verification.
func ArchiveNames(path string) ([]string, error) {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	names := make([]string, 0, len(reader.File))
	for _, entry := range reader.File {
		names = append(names, entry.Name)
	}
	return names, nil
}

// CheckArchive re-opens what was written and checks what actually landed in it.
//
// The staged directory having a file says nothing about the archive: the walk that
// produces it can skip a subtree, and the result is a package that installs a
// program with one feature missing. So the check is against the archive.
func (l Layout) CheckArchive(path string) error {
	names, err := ArchiveNames(path)
	if err != nil {
		return fmt.Errorf("cannot read back %s: %w", path, err)
	}
	have := make(map[string]bool, len(names))
	for _, name := range names {
		have[name] = true
	}

	// The package carries no source. A `.go` file in a user's download is both
	// noise and a small leak, and it is exactly the kind of thing a walk over a
	// directory picks up without anybody deciding to include it.
	for _, name := range names {
		if strings.HasSuffix(name, ".go") {
			return fmt.Errorf("the archive carries source code (%s) — stage only what the program needs at run time", name)
		}
	}

	relative := func(target string) string {
		if rel, err := filepath.Rel(l.Root, target); err == nil {
			return filepath.ToSlash(rel)
		}
		return target
	}
	required := l.RequiredFiles()
	labels := make([]string, 0, len(required))
	for label := range required {
		labels = append(labels, label)
	}
	sortStrings(labels)

	for _, label := range labels {
		target := required[label]
		if info, err := os.Stat(target); err == nil && info.IsDir() {
			// A directory travels as its files; require at least one.
			prefix := relative(target) + "/"
			found := false
			for name := range have {
				if strings.HasPrefix(name, prefix) {
					found = true
					break
				}
			}
			if !found {
				return fmt.Errorf("%s is in the staged tree but nothing under it reached %s", label, filepath.Base(path))
			}
			continue
		}
		if !have[relative(target)] {
			return fmt.Errorf("%s is missing from %s", label, filepath.Base(path))
		}
	}
	return nil
}

// RunCaptured runs a command and returns its stdout, stderr and exit code.
//
// Output is captured to memory rather than streamed because every caller here is
// checking what the command said, and a verification step that cannot see the
// output is not a verification step.
func RunCaptured(dir string, env []string, argv ...string) (string, string, int, error) {
	command := exec.Command(argv[0], argv[1:]...)
	command.Dir = dir
	if env != nil {
		command.Env = env
	}
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	code := 0
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		} else {
			return stdout.String(), stderr.String(), -1, err
		}
	}
	return stdout.String(), stderr.String(), code, nil
}

// sortStrings is a small insertion sort: the lists here are six entries long, and
// pulling in `sort` for that would be the only use of the package in this file.
func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

// VersionFrom builds the version string from the candidates, in order.
//
// A committed VERSION file wins, then the environment, then `git describe`. The
// file first because that is what the previous generation did (its version lived
// in pyproject.toml) and because a release version should not change because
// somebody built from a dirty tree. `dev` is the honest answer when there is
// nothing to go on.
func VersionFrom(fileVersion, envVersion, gitVersion string) string {
	for _, candidate := range []string{fileVersion, envVersion, gitVersion} {
		if trimmed := strings.TrimSpace(candidate); trimmed != "" {
			return trimmed
		}
	}
	return "dev"
}
