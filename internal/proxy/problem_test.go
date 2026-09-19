package proxy

import (
	"strings"
	"testing"
)

// TestARefusedSystemSettingIsReported is the regression for a network path that was
// chosen silently.
//
// `Resolve` reads the machine's proxy setting and discards the error, because there is
// nothing better it can do than fall back to a direct connection. What it must not do
// is let the rest of the program announce that fallback as if it were the
// configuration: the startup notice says "requests go direct", and on a machine whose
// PAC script was skipped, that sentence is false and sends the reader looking at the
// network instead of at the setting.
//
// The assertion is conditional on the platform's answer rather than on a canned one,
// because whether a machine has a PAC is a property of the machine — what is pinned
// here is that the two functions agree.
func TestARefusedSystemSettingIsReported(t *testing.T) {
	// A bad environment value must not mask or borrow the system reason.
	t.Setenv("HTTPS_PROXY", "not a url at all")
	if problem := Problem(); !strings.Contains(problem, "HTTPS_PROXY") {
		t.Errorf("a broken HTTPS_PROXY was not reported: %q", problem)
	}

	t.Setenv("HTTPS_PROXY", "")
	if _, _, err := System(); err != nil {
		problem := Problem()
		if problem == "" {
			t.Fatalf("the system setting was refused (%v) and Problem() reported nothing", err)
		}
		if !strings.Contains(problem, err.Error()) {
			t.Errorf("Problem() does not carry the system reason:\n got %q\nwant it to contain %q", problem, err)
		}
		return
	}
	// No refused setting: there is nothing to report, and inventing a sentence here
	// would put a warning on every ordinary start-up.
	if problem := Problem(); problem != "" {
		t.Errorf("an accepted (or absent) system setting was reported as a problem: %q", problem)
	}
}

// TestResolveStillFallsBackToDirect: reporting the refusal must not turn into
// refusing to run. A machine with a PAC this program cannot evaluate still connects
// directly, and the report is what makes that visible.
func TestResolveStillFallsBackToDirect(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "")
	if _, description := Resolve(); description == "" {
		t.Error("Resolve returned no description of its decision")
	}
}
