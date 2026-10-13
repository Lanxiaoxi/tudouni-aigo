// Package bootstrap is the Remote Bootstrapper (§3.5, §8 of the design):
// detecting, installing, verifying and rolling back the Runtime on a remote
// host reached over SSH.
//
// It is deliberately a thin, SSH-agnostic layer of pure logic — parsing what
// a shell command printed, deciding which shipped Target that maps to,
// computing the paths an install writes to and the shell commands an atomic
// switch runs — so that every decision here can be tested without a live SSH
// connection. The transport (actually running `uname`, uploading bytes) is
// the Rust side's job (ssh_backend.rs's install module); this package exists
// so that the actual mapping and verification rules are specified once, in
// one language, with tests that run in milliseconds. The Rust side mirrors
// this package's rules rather than inventing its own, the same way
// `ssh_backend.rs`'s `QuoteShellArgument` already mirrors `ssh.QuoteShellArgument`
// instead of drifting from it.
package bootstrap

import (
	"fmt"
	"strings"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/release"
)

// DetectTarget maps the two platform-identifying facts a remote shell can be
// asked for — `uname -s` and `uname -m` — to one of the shipped release
// Targets.
//
// Per §8.1 of the design: "identify common architecture names such as
// x86_64, but must not assume full compatibility based solely on `uname -m`."
// This function honours that by refusing anything it cannot map to one of
// the **exact** Targets this project ships (release.Targets) rather than
// guessing a close match — an aarch64 Linux host, a 32-bit x86 host, and a
// Linux host whose libc is not the musl build was linked for are all
// "unsupported", stated as such, not approximated to the nearest shipped
// Target.
//
// `unameS` and `unameM` are the trimmed stdout of the two commands,
// case-sensitively as POSIX `uname` prints them ("Linux", "Darwin",
// "x86_64", "aarch64", ...). A Windows target is detected differently — see
// DetectWindowsTarget — because a non-PTY SSH exec against a Windows OpenSSH
// server runs through cmd.exe, which has no `uname` at all.
func DetectTarget(unameS, unameM string) (release.Target, error) {
	osName := strings.TrimSpace(unameS)
	archName := strings.TrimSpace(unameM)

	if osName == "" || archName == "" {
		return release.Target{}, fmt.Errorf(
			"could not read the remote platform: uname -s and uname -m must both answer something, got %q and %q",
			unameS, unameM)
	}

	goos, ok := unameOSToGOOS(osName)
	if !ok {
		return release.Target{}, fmt.Errorf(
			"the remote host reports an operating system this program does not recognise (uname -s said %q); "+
				"supported platforms are: %s", osName, SupportedPlatformsText())
	}

	goarch, ok := unameArchToGOARCH(archName)
	if !ok {
		return release.Target{}, fmt.Errorf(
			"the remote host reports a CPU architecture this program does not recognise (uname -m said %q); "+
				"supported platforms are: %s", archName, SupportedPlatformsText())
	}

	for _, target := range release.Targets {
		if target.GOOS == goos && target.GOARCH == goarch {
			return target, nil
		}
	}
	return release.Target{}, fmt.Errorf(
		"%s/%s (uname -s=%q, uname -m=%q) is not one of the platforms this program ships a Runtime build for; "+
			"supported platforms are: %s", goos, goarch, osName, archName, SupportedPlatformsText())
}

// DetectWindowsTarget is the Windows half of platform detection.
//
// A Windows OpenSSH server with no shell override runs an exec request
// through `cmd.exe`, which has no `uname`. The design's own answer for this
// (§8.1 implicitly, by shipping only two Targets) is simpler than parsing
// `cmd`'s `%PROCESSOR_ARCHITECTURE%`: Windows is only ever shipped as
// amd64, so detecting "this is Windows" is the whole question. `probeOutput`
// is whatever a caller's own Windows-detection probe produced (see the Rust
// side's install module for how it is obtained without assuming a shell);
// an empty or unrecognised result is "not Windows", which DetectTarget's own
// uname-based path then has a chance to identify instead.
func DetectWindowsTarget(isWindows bool) (release.Target, bool) {
	if !isWindows {
		return release.Target{}, false
	}
	for _, target := range release.Targets {
		if target.GOOS == "windows" {
			return target, true
		}
	}
	return release.Target{}, false
}

// unameOSToGOOS maps a `uname -s` answer to the Go OS name release.Target
// uses. Only the names this project's shipped Targets actually use are
// recognised — recognising more (say, "Darwin") would answer a question
// SupportedPlatformsText does not have an honest answer to, since there is
// no Target for it to resolve into.
func unameOSToGOOS(unameS string) (string, bool) {
	switch unameS {
	case "Linux":
		return "linux", true
	default:
		return "", false
	}
}

// unameArchToGOARCH maps a `uname -m` answer to the Go architecture name.
// Several spellings for the same architecture are accepted — `uname -m`'s
// output is not standardised across distributions — but each is mapped only
// to an architecture this project actually ships, per the function's own
// doc: a name it does not recognise is refused, never approximated.
func unameArchToGOARCH(unameM string) (string, bool) {
	switch unameM {
	case "x86_64", "amd64":
		return "amd64", true
	default:
		return "", false
	}
}

// SupportedPlatformsText renders the shipped Targets as the sentence an
// error message names them with, built from release.Targets itself so the
// two can never drift apart.
func SupportedPlatformsText() string {
	names := make([]string, 0, len(release.Targets))
	for _, target := range release.Targets {
		names = append(names, target.GOOS+"/"+target.GOARCH)
	}
	return strings.Join(names, ", ")
}
