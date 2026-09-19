//go:build !windows

package process

import (
	"errors"
	"os"
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
//
// It reports whether anything was stopped, for the reason the Windows side states:
// the callers have outcomes to declare, and one of them is a background job telling
// a person it is gone.
func TerminateTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	var groupErr error
	if pgid, err := syscall.Getpgid(cmd.Process.Pid); err == nil && pgid != 0 {
		own, ownErr := syscall.Getpgid(0)
		if ownErr != nil || pgid != own {
			if err := syscall.Kill(-pgid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
				groupErr = err
			}
		}
	}
	// A backstop for the case where the group signal did not reach the leader
	// (already gone, or the child never made it into its own group). An already
	// finished process is the outcome the caller wanted, not a failure.
	if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) && groupErr == nil {
		groupErr = err
	}
	return groupErr
}

// JobObjectProblem reports nothing off Windows.
func JobObjectProblem() (string, bool) { return "", false }
