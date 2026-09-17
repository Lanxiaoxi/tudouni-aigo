//go:build windows

package process

import (
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
func assignToJob(cmd *exec.Cmd) {
	handle, ok := ensureJobObject()
	if !ok || cmd.Process == nil {
		return
	}
	child, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(child)
	_ = windows.AssignProcessToJobObject(handle, child)
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
func TerminateTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
	_ = cmd.Process.Kill()
}

// TerminateAll kills everything in the job object at once. It returns whether the
// sweep actually happened; off a working job object it returns false.
func TerminateAll() bool {
	handle, ok := ensureJobObject()
	if !ok {
		return false
	}
	if err := windows.TerminateJobObject(handle, 1); err != nil {
		return false
	}
	return true
}

// JobObjectProblem returns the reason the job object could not be created, and
// true when there is one. A missing job object silently downgrades the tree-kill
// guarantee, so the caller must surface the reason.
func JobObjectProblem() (string, bool) {
	ensureJobObject()
	if jobProblem == "" {
		return "", false
	}
	return jobProblem, true
}
