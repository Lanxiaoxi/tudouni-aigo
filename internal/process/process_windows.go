//go:build windows

package process

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The job object is created once, at first use, and deliberately leaked until the
// process exits: closing its handle is exactly what triggers KILL_ON_JOB_CLOSE,
// which is the only guarantee that survives "the console window was closed".
var (
	jobMu       sync.Mutex
	jobHandle   windows.Handle
	jobResolved bool
	jobProblem  string
)

func startSysProcAttr() *syscall.SysProcAttr { return nil }

// assignToJob places a freshly started process into the session job object so it
// dies with the runtime. Failing here only loses one layer of protection and must
// not break startup.
//
// **Losing that layer is recorded, not just tolerated.** The file's own rule for the
// object's *creation* is that a silent downgrade of a guarantee is a lie of omission,
// and it applies here too: a job object that exists but has no processes in it is
// exactly as unprotected as one that could not be created, while the person is told
// the opposite — that closing the window collects the background jobs. The caller
// reads this through `JobObjectProblem`.
func assignToJob(cmd *exec.Cmd) {
	handle, ok := ensureJobObject()
	if !ok || cmd.Process == nil {
		return
	}
	child, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		noteJobProblem("the handle to process %d could not be opened: %v", cmd.Process.Pid, err)
		return
	}
	defer windows.CloseHandle(child)
	if err := windows.AssignProcessToJobObject(handle, child); err != nil {
		noteJobProblem("process %d could not be placed in the session's job object: %v", cmd.Process.Pid, err)
	}
}

// noteJobProblem records the first reason the tree-kill guarantee is not in force.
//
// First rather than last: the reasons arrive per child process, and a machine that
// refuses one refusal is going to refuse the next, so the log would otherwise fill
// with the same sentence for every background command ever started.
func noteJobProblem(format string, args ...any) {
	jobMu.Lock()
	defer jobMu.Unlock()
	if jobProblem == "" {
		jobProblem = fmt.Sprintf(format, args...)
	}
}

// ensureJobObject builds the kill-on-close job object once. It returns the handle
// and whether a usable object exists; a nil handle means the caller should fall
// back to plain tree killing.
func ensureJobObject() (windows.Handle, bool) {
	jobMu.Lock()
	defer jobMu.Unlock()
	if jobResolved {
		return jobHandle, jobHandle != 0
	}
	jobResolved = true

	handle, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		jobProblem = err.Error()
		return 0, false
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		handle,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		jobProblem = err.Error()
		return 0, false
	}
	jobHandle = handle
	return handle, true
}

// TerminateTree kills the child and its descendants via taskkill /T. Restricted
// environments may deny taskkill (Access denied), so a direct kill is attempted
// as a backstop.
//
// It **reports whether anything was actually stopped**, because its callers have
// outcomes to state: a background job that claims to have been killed while still
// holding its port is the symptom this program spends several messages preventing.
// A nil command is a no-op rather than a panic: the caller walks a list of jobs
// collected under a lock, and "there is nothing to kill here" is a legal state of
// that list. Dereferencing it would turn shutdown into a crash, which is the worst
// possible moment for one.
func TerminateTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	taskkillErr := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
	killErr := cmd.Process.Kill()
	if taskkillErr == nil || killErr == nil || errors.Is(killErr, os.ErrProcessDone) {
		return nil
	}
	return fmt.Errorf("taskkill: %v; killing the process directly: %v", taskkillErr, killErr)
}

// JobObjectProblem returns the reason the tree-kill guarantee is not in force, and
// true when there is one.
//
// Two things put a process outside that guarantee and both are recorded: the job
// object could not be built, and a process could not be placed in the one that was.
// A missing job object silently downgrades the guarantee, so the caller must surface
// the reason.
func JobObjectProblem() (string, bool) {
	ensureJobObject()
	if jobProblem == "" {
		return "", false
	}
	return jobProblem, true
}
