//go:build windows

package terminal

import (
	"os"
	"os/exec"
	"path/filepath"
)

// platformShell picks the shell for a Windows terminal, newest first.
//
// PowerShell 7 is preferred over Windows PowerShell because it is the one a
// person installed on purpose; `cmd.exe` is the last resort rather than the
// default, because it is the one shell on this platform that cannot run the
// things a terminal is for. The absolute paths are checked as well as PATH:
// PowerShell 7 installs to `ProgramFiles` and a process started from a desktop
// icon does not always have that on its PATH.
func platformShell() Shell {
	candidates := []Shell{
		{Display: "pwsh", Argv: []string{"pwsh", "-NoLogo"}},
		{Display: "powershell", Argv: []string{"powershell", "-NoLogo"}},
		{Display: "cmd.exe", Argv: []string{"cmd.exe"}},
	}
	if programFiles := os.Getenv("ProgramFiles"); programFiles != "" {
		pwsh := filepath.Join(programFiles, "PowerShell", "7", "pwsh.exe")
		if info, err := os.Stat(pwsh); err == nil && !info.IsDir() {
			return Shell{Display: "pwsh", Argv: []string{pwsh, "-NoLogo"}}
		}
	}
	return lookupShell(candidates)
}

// lookPath is `exec.LookPath` under the name this package uses everywhere.
func lookPath(program string) (string, error) { return exec.LookPath(program) }
