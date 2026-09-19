//go:build windows

package builtin

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
)

// setProcessGroup is a no-op on Windows: the child shares no group we can target,
// so tree-killing is done via taskkill in killProcessTree.
func setProcessGroup(cmd *exec.Cmd) {}

// killProcessTree kills the direct child and everything it spawned, using
// taskkill's /T (tree) flag. This is the only reliable way to take down a command
// and its descendants on Windows.
//
// It **returns the failure instead of discarding it**, and that is the whole reason
// it has a return value at all. `taskkill` is denied in some environments — a
// restricted token, an ACL, a sandbox — and the caller used to say "terminated (the
// whole process tree with it)" regardless. A tool that reports a kill it did not
// perform is worse than one that reports nothing: the person stops looking for the
// process, and the next `go build` fails on a locked file with no explanation.
//
// Both attempts are made before giving up, because they fail for different reasons:
// taskkill reaches descendants but can be denied, while Process.Kill needs only the
// handle this process already holds.
func killProcessTree(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	taskkillErr := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
	killErr := cmd.Process.Kill()
	// A zero exit from taskkill means the tree is gone. `Process.Kill` answering
	// "already finished" is the same outcome by a different route, and counting it as
	// a failure would put a warning on every command that ended in the moment between
	// the timeout firing and the kill arriving.
	if taskkillErr == nil || killErr == nil || errors.Is(killErr, os.ErrProcessDone) {
		return nil
	}
	return fmt.Errorf("taskkill 没能结束它（%v），直接杀子进程也没成功（%v）", taskkillErr, killErr)
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
