//go:build !windows

package hooks

import "os/exec"

// shellArgvFor turns a configured command string into an argv.
//
// A string command is run through `/bin/sh -c`, which is what makes a one-liner
// work on a machine that has one. The argv form is the documented recommendation
// anyway: it is the only form that behaves the same on both platforms.
func shellArgvFor(command string) []string {
	shell := "/bin/sh"
	if _, err := exec.LookPath(shell); err != nil {
		shell = "sh"
	}
	return []string{shell, "-c", command}
}

func defaultLookPath(name string) (string, error) { return exec.LookPath(name) }
