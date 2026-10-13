package bootstrap

import (
	"strings"
	"testing"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/release"
)

func testTarget() release.Target {
	return release.Target{GOOS: "linux", GOARCH: "amd64", Triple: "x86_64-unknown-linux-musl"}
}

func TestRemoteLayoutPathsAreRootedUnderHomeDotTudouni(t *testing.T) {
	l := NewRemoteLayout("/home/deploy", "1.2.3", testTarget())

	cases := map[string]string{
		"Root":        "/home/deploy/.tudouni",
		"RuntimeRoot": "/home/deploy/.tudouni/runtime",
		"VersionDir":  "/home/deploy/.tudouni/runtime/1.2.3",
		"StagingDir":  "/home/deploy/.tudouni/runtime/.staging-1.2.3",
		"CurrentLink": "/home/deploy/.tudouni/runtime/current",
	}
	got := map[string]string{
		"Root":        l.Root(),
		"RuntimeRoot": l.RuntimeRoot(),
		"VersionDir":  l.VersionDir(),
		"StagingDir":  l.StagingDir(),
		"CurrentLink": l.CurrentLink(),
	}
	for name, want := range cases {
		if got[name] != want {
			t.Errorf("%s() = %q, want %q", name, got[name], want)
		}
	}
}

// TestRemoteLayoutTrimsATrailingSlashFromHome covers a $HOME the far end
// reports with a trailing slash (some shells do under certain PS1/profile
// setups) — it must not produce a double slash anywhere downstream.
func TestRemoteLayoutTrimsATrailingSlashFromHome(t *testing.T) {
	l := NewRemoteLayout("/home/deploy/", "1.0.0", testTarget())
	if strings.Contains(l.Root(), "//") {
		t.Errorf("Root() = %q, contains a double slash", l.Root())
	}
}

func TestBinaryPathUsesTheWindowsExtensionOnlyForWindows(t *testing.T) {
	linux := NewRemoteLayout("/home/deploy", "1.0.0", release.Target{GOOS: "linux", GOARCH: "amd64", Triple: "x86_64-unknown-linux-musl"})
	if strings.HasSuffix(linux.BinaryPath(), ".exe") {
		t.Errorf("BinaryPath() = %q, a Linux target must not carry .exe", linux.BinaryPath())
	}

	windows := NewRemoteLayout("C:/Users/deploy", "1.0.0", release.Target{GOOS: "windows", GOARCH: "amd64", Triple: "x86_64-pc-windows-msvc"})
	if !strings.HasSuffix(windows.BinaryPath(), ".exe") {
		t.Errorf("BinaryPath() = %q, a Windows target must carry .exe", windows.BinaryPath())
	}
}

func TestCurrentBinaryPathGoesThroughTheCurrentLinkNotTheVersionDir(t *testing.T) {
	l := NewRemoteLayout("/home/deploy", "1.2.3", testTarget())
	if !strings.HasPrefix(l.CurrentBinaryPath(), l.CurrentLink()) {
		t.Errorf("CurrentBinaryPath() = %q, does not go through CurrentLink %q",
			l.CurrentBinaryPath(), l.CurrentLink())
	}
	if strings.Contains(l.CurrentBinaryPath(), l.version) {
		t.Errorf("CurrentBinaryPath() = %q, names the version directly rather than through the link — "+
			"an upgrade that repoints current would not take effect", l.CurrentBinaryPath())
	}
}

func TestVersionDirForNamesAnArbitraryVersionNotTheLayoutsOwn(t *testing.T) {
	l := NewRemoteLayout("/home/deploy", "2.0.0", testTarget())
	old := l.VersionDirFor("1.9.0")
	if old == l.VersionDir() {
		t.Error("VersionDirFor(oldVersion) collided with the layout's own VersionDir")
	}
	if !strings.HasSuffix(old, "1.9.0") {
		t.Errorf("VersionDirFor(%q) = %q, want it to end with the given version", "1.9.0", old)
	}
}

func TestRequiredRemoteFilesListsExactlyTheThreeRuntimeEssentials(t *testing.T) {
	l := NewRemoteLayout("/home/deploy", "1.0.0", testTarget())
	required := l.RequiredRemoteFiles()
	if len(required) != 3 {
		t.Fatalf("RequiredRemoteFiles() has %d entries, want 3: %v", len(required), required)
	}
	for label, path := range required {
		if path == "" {
			t.Errorf("%s has an empty path", label)
		}
		if !strings.HasPrefix(path, l.VersionDir()) {
			t.Errorf("%s = %q, not under VersionDir %q", label, path, l.VersionDir())
		}
	}
}
