//go:build windows

package builtin

import (
	"os/exec"
	"strconv"
)

// setProcessGroup is a no-op on Windows: the child shares no group we can target,
// so tree-killing is done via taskkill in killProcessTree.
func setProcessGroup(cmd *exec.Cmd) {}

// killProcessTree kills the direct child and everything it spawned, using
// taskkill's /T (tree) flag. This is the only reliable way to take down a command
// and its descendants on Windows.
func killProcessTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
	_ = cmd.Process.Kill()
}

// shellName is the shell the commands are handed to, as the user knows it.
func shellName() string { return "PowerShell" }

// shellArgv builds the argument vector for one command.
//
// The whole command is a **single argv element** handed to the shell: Go performs
// no string joining, so there is nothing to quote wrongly and `; rm -rf` cannot
// become a separate element of its own.
//
// The profile is skipped so a machine's startup script cannot change what a
// command does — the command has to mean the same thing on every machine.
func shellArgv(command string) []string {
	return []string{"powershell", "-NoProfile", "-Command", command}
}
