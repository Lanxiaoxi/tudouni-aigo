//go:build !windows

package builtin

import (
	"os/exec"
	"syscall"
)

// setProcessGroup puts the child in a fresh process group so a timeout can kill the
// whole tree via the negative-pid signal, without taking down the agent itself.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessTree kills the child's entire process group. The negative pid targets
// every process in the group created above.
func killProcessTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}

// shellName is the shell the commands are handed to, as the user knows it.
func shellName() string { return "sh" }

// shellArgv builds the argument vector for one command.
//
// The whole command is a **single argv element** handed to the shell: Go performs
// no string joining, so there is nothing to quote wrongly and `; rm -rf` cannot
// become a separate element of its own.
func shellArgv(command string) []string {
	return []string{"/bin/sh", "-c", command}
}
