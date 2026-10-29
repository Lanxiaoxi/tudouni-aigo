//go:build windows

package hooks

import "os/exec"

// shellArgvFor turns a configured command string into an argv.
//
// `cmd /c` rather than PowerShell, and the choice is worth stating: `cmd` is
// present on every Windows this program ships to, its quoting rules are the ones
// every hook written for another CLI already assumed, and PowerShell's execution
// policy is a variable nobody configuring a guardrail should have to think about.
//
// The argv form is still the recommendation — it is the only one that behaves
// identically on both platforms, and the only one with no quoting at all.
func shellArgvFor(command string) []string {
	return []string{"cmd", "/c", command}
}

func defaultLookPath(name string) (string, error) { return exec.LookPath(name) }
