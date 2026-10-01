//go:build !windows

package terminal

import (
	"os"
	"os/exec"
)

// platformShell picks the shell for a Unix terminal: `$SHELL` when it names
// something that exists, `/bin/sh` otherwise.
//
// The existence check is not paranoia. `$SHELL` is set by the login process and
// is not updated when the program it names is uninstalled or moved, so a machine
// whose owner switched from `zsh` to `fish` months ago can still be advertising a
// path that is not there. Trusting it means a terminal that fails to start with a
// message about a program the person did not choose.
func platformShell() Shell {
	if named := os.Getenv("SHELL"); named != "" {
		if info, err := os.Stat(named); err == nil && !info.IsDir() {
			return Shell{Display: named, Argv: []string{named}}
		}
	}
	return Shell{Display: "/bin/sh", Argv: []string{"/bin/sh"}}
}

// lookPath is `exec.LookPath` under the name this package uses everywhere.
func lookPath(program string) (string, error) { return exec.LookPath(program) }
