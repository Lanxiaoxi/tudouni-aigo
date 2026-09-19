package process

import (
	"os/exec"
	"runtime"
	"testing"
)

// TestAFailedJobObjectAssignmentIsReported pins the other half of the tree-kill
// guarantee — the half that used to be silent.
//
// A job object that exists but has no process in it protects exactly as little as one
// that was never created, and the program tells the user the opposite: that closing
// the window also collects the background jobs. The file's own rule for the object's
// creation is that a silent downgrade of a guarantee is a lie of omission, and
// `assignToJob` was the one place that broke it.
//
// What can be asserted portably is the **contract**: as long as some command has been
// through `assignToJob`, the two states cannot both be true — either every assignment
// worked, or there is a problem to report. Whether an assignment fails here is a
// property of the machine (a nested job object refuses them), so the test reads the
// state rather than prescribing it.
func TestAFailedJobObjectAssignmentIsReported(t *testing.T) {
	if runtime.GOOS != "windows" {
		// Off Windows there is no job object to be in, and `JobObjectProblem` says so
		// by returning nothing. What is being pinned here is the Windows behaviour.
		return
	}

	command := exec.Command("cmd", "/c", "exit 0")
	if err := command.Start(); err != nil {
		t.Skipf("no child process to place in the job object: %v", err)
	}
	defer func() { _ = command.Wait() }()

	assignToJob(command)

	// The first child this process ever starts has now been handed to `assignToJob`.
	// Either it went in, or the reason it did not is recorded.
	if problem, ok := JobObjectProblem(); ok && problem == "" {
		t.Error("the job object is unavailable and the reason is empty; the caller cannot report why")
	}
}
