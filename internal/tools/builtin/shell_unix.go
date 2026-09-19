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
//
// The error is returned rather than discarded, for the reason the Windows side
// states: the caller reports to the model whether the command actually stopped, and
// a SIGKILL that was refused (EPERM on a process that changed user, ESRCH when the
// group is already gone — the one benign case) must not be reported as a
// termination that happened.
func killProcessTree(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if err == syscall.ESRCH {
		// Nothing left in the group: the command and its children are already gone,
		// which is exactly what the caller was asking for.
		return nil
	}
	return err
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
