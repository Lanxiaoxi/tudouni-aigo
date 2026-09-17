// Command release builds, stages, verifies and archives the shipped packages.
//
//	go run ./tools/release              build and package every target
//	go run ./tools/release --list       show the targets and the version
//	go run ./tools/release --skip-build reuse the staged directories
//	go run ./tools/release --target windows/amd64
//
// It replaces the old `scripts/build_release.py`. What that script did, and what
// this one still does:
//
//	build → stage the files the archive carries → **verify the artifact** → zip
//
// The verification is the point. A release package's characteristic failure is
// "it starts and one feature is missing", it is invisible in the source tree, and
// it is silent. So this program opens the archive it just wrote, checks what is
// in it, runs the binary, and asks the runtime whether `grep` registered.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/release"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "release:", err)
		os.Exit(1)
	}
}

func run(argv []string) error {
	flags := flag.NewFlagSet("release", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	skipBuild := flags.Bool("skip-build", false, "reuse the staged directories instead of rebuilding")
	only := flags.String("target", "", "build one target, as `goos/goarch`")
	list := flags.Bool("list", false, "print the version and the targets, then exit")
	printVersion := flags.Bool("print-version", false, "print only the resolved version, for the build to consume")
	local := flags.Bool("local", false, "build only this machine's binary into dist/, with the version compiled in")
	clean := flags.Bool("clean", false, "remove dist/ and exit")
	versionFlag := flags.String("version", "", "override the version (default: VERSION file, then $TUDOUNI_VERSION, then git describe)")
	if err := flags.Parse(argv); err != nil {
		return err
	}

	root, err := repoRoot()
	if err != nil {
		return err
	}
	if *clean {
		// Through Go rather than `rm -rf` so that `make clean` works in a shell
		// that has no `rm`, which is every Windows shell.
		if err := os.RemoveAll(filepath.Join(root, "dist")); err != nil {
			return err
		}
		fmt.Println("removed dist/")
		return nil
	}
	version, err := resolveVersion(root, *versionFlag)
	if err != nil {
		return err
	}
	// One line, nothing else: the Makefile substitutes this into -ldflags, and any
	// extra output would end up inside the version string.
	if *printVersion {
		fmt.Println(version)
		return nil
	}
	if *local {
		host, ok := release.HostTarget()
		if !ok {
			return fmt.Errorf("this machine (%s/%s) is not one of the shipped platforms: %s",
				runtime.GOOS, runtime.GOARCH, targetNames())
		}
		if err := buildTarget(root, version, host, filepath.Join(root, "dist", host.BinaryName())); err != nil {
			return err
		}
		fmt.Printf("built %s (%s)\n", filepath.Join("dist", host.BinaryName()), version)
		return nil
	}
	targets, err := selectTargets(*only)
	if err != nil {
		return err
	}

	fmt.Printf("tudouni %s\n", version)
	for _, target := range targets {
		fmt.Printf("  %-18s -> %s\n", target.GOOS+"/"+target.GOARCH, release.ArchiveName(version, target))
	}
	if *list {
		return nil
	}

	// The installers' storage form is checked **before** anything is built: a
	// missing BOM on install.ps1 or a CRLF in install.sh only ever shows up on the
	// user's machine, at the moment they double-click and nothing happens.
	if err := checkInstallerFiles(root); err != nil {
		return err
	}

	host, haveHost := release.HostTarget()
	for _, target := range targets {
		layout := release.Layout{
			Root:       filepath.Join(root, "dist", release.StageDirName(version, target)),
			Target:     target,
			Binary:     filepath.Join(root, "dist", release.StageDirName(version, target), target.BinaryName()),
			PromptsDir: filepath.Join(root, "dist", release.StageDirName(version, target), "prompts"),
			RgBinary:   filepath.Join(root, "dist", release.StageDirName(version, target), "tools", "vendor", "rg", target.Triple, target.RgName()),
		}
		if !*skipBuild {
			if err := buildTarget(root, version, target, layout.Binary); err != nil {
				return err
			}
		}
		if err := stageTarget(root, target, layout); err != nil {
			return err
		}
		if missing := layout.CheckLayout(); len(missing) > 0 {
			return fmt.Errorf("the staged package for %s is incomplete — the program would start with a feature missing:\n  %s",
				target.Triple, strings.Join(missing, "\n  "))
		}
		// Only the host's binary can be executed; the other one is checked for
		// content and then trusted, which is the honest limit of a cross-build.
		if haveHost && target == host {
			if err := verifyRuns(layout); err != nil {
				return err
			}
		} else {
			fmt.Printf("      · %s: not the host platform, so it is checked but not run\n", target.Triple)
		}

		archive := filepath.Join(root, "dist", release.ArchiveName(version, target))
		size, err := layout.Zip(archive)
		if err != nil {
			return err
		}
		if err := layout.CheckArchive(archive); err != nil {
			return err
		}
		fmt.Printf("      · %s (%.1f MB)\n", filepath.Base(archive), float64(size)/1024/1024)
	}

	fmt.Println()
	fmt.Println("Each archive is the whole download: unpack it, run the installer, done.")
	fmt.Println("  Windows  right-click install.ps1 -> Run with PowerShell")
	fmt.Println("  Linux    chmod +x install.sh && ./install.sh")
	return nil
}

// resolveVersion reads the version from the committed file, the environment, or
// git — in that order.
func resolveVersion(root, override string) (string, error) {
	fileVersion := ""
	if raw, err := os.ReadFile(filepath.Join(root, "VERSION")); err == nil {
		fileVersion = string(raw)
	}
	gitVersion := ""
	if out, _, code, err := release.RunCaptured(root, nil, "git", "describe", "--tags", "--always", "--dirty"); err == nil && code == 0 {
		gitVersion = out
	}
	version := release.VersionFrom(fileVersion, override, gitVersion)
	// A version ends up in a file name and in `--version`; whitespace or a slash
	// there is a broken archive name, not a version.
	for _, bad := range []string{" ", "\t", "\n", "/", "\\", ":"} {
		if strings.Contains(version, bad) {
			return "", fmt.Errorf("the version %q contains %q, which cannot go in an archive name — set VERSION or pass --version", version, bad)
		}
	}
	return version, nil
}

func selectTargets(only string) ([]release.Target, error) {
	if only == "" {
		return release.Targets, nil
	}
	for _, target := range release.Targets {
		if target.GOOS+"/"+target.GOARCH == only {
			return []release.Target{target}, nil
		}
	}
	return nil, fmt.Errorf("unknown target %q; the ones with a vendored ripgrep are: %s", only, targetNames())
}

func targetNames() string {
	names := make([]string, 0, len(release.Targets))
	for _, target := range release.Targets {
		names = append(names, target.GOOS+"/"+target.GOARCH)
	}
	return strings.Join(names, ", ")
}

// buildTarget cross-compiles one binary with the version compiled in.
//
// `-s -w` strips the symbol table and the DWARF data: they are development aids,
// and this binary is downloaded. `-trimpath` keeps the builder's home directory
// out of the artifact.
func buildTarget(root, version string, target release.Target, output string) error {
	fmt.Printf("  building %s ...\n", target.Triple)
	stdout, stderr, code, err := release.RunCaptured(root, append(os.Environ(),
		"GOOS="+target.GOOS,
		"GOARCH="+target.GOARCH,
		"CGO_ENABLED=0",
	),
		"go", "build", "-trimpath",
		"-ldflags", fmt.Sprintf("-s -w -X %s=%s", release.VersionVar, version),
		"-o", output,
		"./cmd/tudouni",
	)
	if err != nil {
		return fmt.Errorf("cannot run the `go` tool (is it on PATH?): %w", err)
	}
	if code != 0 {
		return fmt.Errorf("go build failed for %s (exit %d)\n%s%s", target.Triple, code, stdout, stderr)
	}
	return nil
}

// stageTarget copies the files that must sit next to the binary.
//
// Two of them are load-bearing beyond their own contents:
//
//   - `prompts/` — its **presence** is how the program decides it has found its
//     own directory (`paths.PackageDir`). Without it the root resolution falls
//     through to the working directory and the vendored ripgrep is looked for in
//     the wrong place, so `grep` is not registered. The symptom is one line on
//     stderr at startup, which is why it is checked here.
//   - `tools/vendor/rg/<triple>/` — an executable that is deliberately not
//     embedded, because extracting it to a temporary file on every run would be
//     worse than carrying it.
func stageTarget(root string, target release.Target, layout release.Layout) error {
	if err := os.MkdirAll(layout.Root, 0o755); err != nil {
		return err
	}
	if err := copyDir(filepath.Join(root, "prompts"), layout.PromptsDir); err != nil {
		return err
	}
	sourceRg := filepath.Join(root, "tools", "vendor", "rg", target.Triple, target.RgName())
	if err := copyFile(sourceRg, layout.RgBinary, 0o755); err != nil {
		return fmt.Errorf("the vendored ripgrep for %s is missing (%s) — vendor it before shipping this platform: %w",
			target.Triple, sourceRg, err)
	}
	for _, name := range []string{"install.ps1", "install.sh", "README.txt"} {
		mode := os.FileMode(0o644)
		if name == "install.sh" {
			mode = 0o755
		}
		if err := copyFile(filepath.Join(root, "packaging", name), filepath.Join(layout.Root, name), mode); err != nil {
			return err
		}
	}
	return nil
}

// verifyRuns executes the staged binary from its own directory.
//
// Four things, each pinning something the others cannot:
//
//  1. `--help` — the binary starts at all, and it is the one call that touches
//     neither the workspace nor the config;
//  2. `--version` — the version really is **inside** the binary. Reading it from
//     a file next to it is what this changed away from, and the check has to be
//     that the injected string arrived;
//  3. `--runtime-stdio` with an isolated config — this is the subprocess the TUI
//     starts, so a packaging mistake there shows up as an interface that flashes
//     and exits;
//  4. the notices that call prints — `grep` must have registered. A missing
//     ripgrep does not fail anything: the tool is simply absent, and the only
//     evidence is a notice nobody reads.
//
// The config is deliberately a fake route pointing at a closed port, and it is
// written into the scratch workspace: verifying a package must not depend on the
// builder's own model setup, and it must not write to their home directory.
func verifyRuns(layout release.Layout) error {
	scratch := filepath.Join(filepath.Dir(layout.Root), "verify-workspace")
	if err := os.RemoveAll(scratch); err != nil {
		return err
	}
	if err := os.MkdirAll(scratch, 0o755); err != nil {
		return err
	}
	defer os.RemoveAll(scratch)

	config := filepath.Join(scratch, "verify-config.json")
	body := `{"providers":{"verify":{"base_url":"http://127.0.0.1:1/v1","api_key":"sk-build-verify","models":[{"id":"verify-model"}]}}}`
	if err := os.WriteFile(config, []byte(body), 0o600); err != nil {
		return err
	}
	env := append(os.Environ(), "AGENT_CONFIG_FILE="+config)

	for _, probe := range []struct {
		label string
		argv  []string
	}{
		{"--help", []string{layout.Binary, "--help"}},
		{"--version", []string{layout.Binary, "--version"}},
		{"--runtime-stdio", []string{layout.Binary, "--runtime-stdio"}},
	} {
		stdout, stderr, code, err := release.RunCaptured(scratch, env, probe.argv...)
		if err != nil {
			return fmt.Errorf("cannot run %s: %w", probe.label, err)
		}
		if code != 0 {
			hint := ""
			if probe.label == "--runtime-stdio" {
				hint = "  (this is the subprocess the TUI starts)"
			}
			return fmt.Errorf("`%s %s` exited %d%s\n  stdout: %s\n  stderr: %s",
				filepath.Base(layout.Binary), probe.label, code, hint,
				tail(stdout, 800), tail(stderr, 1200))
		}
		if probe.label == "--version" {
			want := versionOf(layout.Binary)
			if want != "" && !strings.Contains(stdout, want) {
				return fmt.Errorf("`%s --version` said %q, which does not contain %q — the version was not compiled into the binary",
					filepath.Base(layout.Binary), strings.TrimSpace(stdout), want)
			}
		}
		if probe.label == "--runtime-stdio" {
			if notice := missingGrepNotice(stdout + stderr); notice != "" {
				return fmt.Errorf("the packaged program cannot find its vendored ripgrep:\n  %s\n"+
					"  `grep` would be missing from the tool list with nothing but that line to say so.", notice)
			}
		}
	}
	fmt.Printf("      · %s: --help, --version and --runtime-stdio all ran; ripgrep registered\n", layout.Target.Triple)
	return nil
}

// missingGrepNotice finds the runtime's "no ripgrep for this platform" notice.
//
// It reads the notice stream (`t:"notice"`) rather than stderr because that is
// where startup warnings go once the runtime is speaking the protocol.
func missingGrepNotice(output string) string {
	for _, line := range strings.Split(output, "\n") {
		if strings.Contains(line, "grep.missing_binary") || strings.Contains(line, "no ripgrep") {
			return strings.TrimSpace(line)
		}
	}
	return ""
}

// checkInstallerFiles checks the two installers' **storage form**.
//
// Both rules are the same kind of failure: fine on the machine that wrote them,
// broken on the machine that runs them, with a symptom far from the cause.
//
//   - `install.ps1` **must** carry a UTF-8 BOM. Windows PowerShell 5.1 — the one a
//     double-click and `powershell -File` both use — decodes a `.ps1` without a BOM
//     using the system code page. The Chinese comments become mojibake, and one
//     quote-shaped byte in mojibake is enough to make the whole script fail to
//     parse. In any UTF-8 editor it looks perfect.
//   - `install.sh` **must not** carry a BOM: three bytes in front of `#!` and the
//     kernel cannot find the interpreter.
//   - `install.sh` **must** be LF. CRLF turns the first line into `#!/bin/sh\r`,
//     which is "bad interpreter" on Linux and indistinguishable on Windows.
func checkInstallerFiles(root string) error {
	for _, want := range []struct {
		name   string
		bom    bool
		unixLF bool
	}{
		{"install.ps1", true, false},
		{"install.sh", false, true},
	} {
		path := filepath.Join(root, "packaging", want.name)
		raw, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("the packaging directory must carry %s: %w", want.name, err)
		}
		hasBOM := strings.HasPrefix(string(raw), "\ufeff")
		if hasBOM != want.bom {
			if want.bom {
				return fmt.Errorf("%s has no UTF-8 BOM — Windows PowerShell 5.1 will read the comments as mojibake and fail to parse the script.\n  Save it as \"UTF-8 with BOM\".", want.name)
			}
			return fmt.Errorf("%s carries a UTF-8 BOM — the three bytes before `#!` stop the kernel from finding the interpreter.\n  Save it as \"UTF-8 without BOM\".", want.name)
		}
		if want.unixLF && strings.Contains(string(raw), "\r\n") {
			return fmt.Errorf("%s is CRLF — on Linux that becomes `#!/bin/sh\\r` and reports \"bad interpreter\".\n  Save it with LF endings (`.gitattributes` should be keeping it that way).", want.name)
		}
	}
	return nil
}

// versionOf reads the version out of a build by asking it.
func versionOf(binary string) string {
	stdout, _, code, err := release.RunCaptured(filepath.Dir(binary), nil, binary, "--version")
	if err != nil || code != 0 {
		return ""
	}
	fields := strings.Fields(stdout)
	if len(fields) < 2 {
		return ""
	}
	return fields[len(fields)-1]
}

func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("cannot find the repository root (no go.mod above %s) — run this from inside the repository", dir)
		}
		dir = parent
	}
}

func copyFile(source, target string, mode os.FileMode) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	// The mode is set explicitly: a copy of an executable that lands at 0644 is a
	// program the user cannot run, and on Linux that is exactly what a zip gives.
	return os.Chmod(target, mode)
}

func copyDir(source, target string) error {
	info, err := os.Stat(source)
	if err != nil {
		return fmt.Errorf("the packaging step needs %s: %w", source, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", source)
	}
	return filepath.Walk(source, func(item string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		// **No source in the package.** The prompts' contents are compiled in; the
		// directory travels because its presence is how the program recognises its
		// own root. Its `.go` file is the embed declaration and has no business in
		// something a user downloads — the previous generation had a whole check
		// for "the archive leaked source", and this is the same rule.
		if !info.IsDir() && strings.HasSuffix(item, ".go") {
			return nil
		}
		relative, err := filepath.Rel(source, item)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if info.IsDir() {
			return os.MkdirAll(destination, 0o755)
		}
		return copyFile(item, destination, 0o644)
	})
}

// tail keeps the end of a long message: the interesting part of a compiler or
// runtime error is always the last thing it said.
func tail(text string, limit int) string {
	trimmed := strings.TrimSpace(text)
	if len(trimmed) <= limit {
		return trimmed
	}
	return "…" + trimmed[len(trimmed)-limit:]
}
