//go:build !windows

package process

import (
	"os/exec"
	"syscall"
)

// startSysProcAttr puts the child in a fresh session so a later kill can target
// the whole process group without taking down the agent itself.
func startSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

// assignToJob is a no-op off Windows: tree killing is done via the process group
// created by Setsid.
func assignToJob(cmd *exec.Cmd) {}

// TerminateTree kills the child and every process in its group.
//
// Only the group this child leads is targeted. Signalling a group we do not own —
// in particular our own — would take down the agent along with the thing it was
// trying to stop, which is a much worse outcome than a leftover process.
func TerminateTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if pgid, err := syscall.Getpgid(cmd.Process.Pid); err == nil && pgid != 0 {
		own, ownErr := syscall.Getpgid(0)
		if ownErr != nil || pgid != own {
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}
	}
	// A backstop for the case where the group signal did not reach the leader
	// (already gone, or the child never made it into its own group).
	_ = cmd.Process.Kill()
}

// TerminateAll returns false off Windows: there is no job object to sweep.
func TerminateAll() bool { return false }

// JobObjectProblem reports nothing off Windows.
func JobObjectProblem() (string, bool) { return "", false }
