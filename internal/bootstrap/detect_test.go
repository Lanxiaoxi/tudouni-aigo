package bootstrap

import (
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/release"
)

func TestDetectTargetMapsLinuxX86_64(t *testing.T) {
	target, err := DetectTarget("Linux", "x86_64")
	if err != nil {
		t.Fatalf("DetectTarget: %v", err)
	}
	if target.GOOS != "linux" || target.GOARCH != "amd64" {
		t.Errorf("target = %+v, want linux/amd64", target)
	}
}

// TestDetectTargetAcceptsTheAmd64Spelling covers the less common but real
// uname -m spelling some distributions use.
func TestDetectTargetAcceptsTheAmd64Spelling(t *testing.T) {
	target, err := DetectTarget("Linux", "amd64")
	if err != nil {
		t.Fatalf("DetectTarget: %v", err)
	}
	if target.GOOS != "linux" || target.GOARCH != "amd64" {
		t.Errorf("target = %+v, want linux/amd64", target)
	}
}

// TestDetectTargetRefusesAnUnshippedArchitecture is §8.1's own requirement:
// "must not assume full compatibility based solely on uname -m." aarch64 is
// a real, common uname -m answer, and it must be refused outright rather
// than approximated to the one Linux target this project ships.
func TestDetectTargetRefusesAnUnshippedArchitecture(t *testing.T) {
	_, err := DetectTarget("Linux", "aarch64")
	if err == nil {
		t.Fatal("DetectTarget accepted aarch64, which this project does not ship a build for")
	}
	if !strings.Contains(err.Error(), "aarch64") {
		t.Errorf("error = %q, want it to name the unrecognised architecture", err.Error())
	}
}

// TestDetectTargetRefusesAnUnshippedOperatingSystem covers the other half:
// a real uname -s answer (Darwin) that is not Linux and has no shipped
// Target either.
func TestDetectTargetRefusesAnUnshippedOperatingSystem(t *testing.T) {
	_, err := DetectTarget("Darwin", "x86_64")
	if err == nil {
		t.Fatal("DetectTarget accepted Darwin, which this project does not ship a build for")
	}
	if !strings.Contains(err.Error(), "Darwin") {
		t.Errorf("error = %q, want it to name the unrecognised OS", err.Error())
	}
}

// TestDetectTargetRefusesEmptyAnswers covers a connection or command failure
// that left one or both uname outputs empty — the design's own "identification
// failure must be clearly reported and must not enter the install flow."
func TestDetectTargetRefusesEmptyAnswers(t *testing.T) {
	cases := []struct{ s, m string }{
		{"", ""},
		{"Linux", ""},
		{"", "x86_64"},
		{"   ", "x86_64"},
	}
	for _, c := range cases {
		if _, err := DetectTarget(c.s, c.m); err == nil {
			t.Errorf("DetectTarget(%q, %q) succeeded; want a refusal", c.s, c.m)
		}
	}
}

// TestDetectTargetErrorNamesEverySupportedPlatform ensures a refusal gives
// the person something to act on — the exact platforms that *are* shipped —
// rather than just saying no.
func TestDetectTargetErrorNamesEverySupportedPlatform(t *testing.T) {
	_, err := DetectTarget("Darwin", "arm64")
	if err == nil {
		t.Fatal("expected a refusal")
	}
	for _, target := range release.Targets {
		want := target.GOOS + "/" + target.GOARCH
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention supported platform %q", err.Error(), want)
		}
	}
}

func TestDetectWindowsTargetFindsTheShippedWindowsBuild(t *testing.T) {
	target, ok := DetectWindowsTarget(true)
	if !ok {
		t.Fatal("DetectWindowsTarget(true) found no Windows target, but one is shipped")
	}
	if target.GOOS != "windows" || target.GOARCH != "amd64" {
		t.Errorf("target = %+v, want windows/amd64", target)
	}
}

func TestDetectWindowsTargetIsFalseForANonWindowsHost(t *testing.T) {
	if _, ok := DetectWindowsTarget(false); ok {
		t.Error("DetectWindowsTarget(false) claimed a Windows target")
	}
}

// TestSupportedPlatformsTextMatchesReleaseTargets pins the two lists
// together: this test (and DetectTarget's own error message) must never
// name a platform release.Targets does not actually build, and must never
// omit one it does.
func TestSupportedPlatformsTextMatchesReleaseTargets(t *testing.T) {
	text := SupportedPlatformsText()
	for _, target := range release.Targets {
		if !strings.Contains(text, target.GOOS+"/"+target.GOARCH) {
			t.Errorf("SupportedPlatformsText() = %q, missing %s/%s", text, target.GOOS, target.GOARCH)
		}
	}
}
