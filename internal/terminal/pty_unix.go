//go:build !windows

package terminal

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

// unixProcess is one POSIX terminal: a shell started on a pty master.
//
// `Setsid` and `Setctty` are what make it a *terminal* rather than a pipe with a
// fancy name: the shell becomes a session leader with the pty as its controlling
// terminal, which is what gives it job control, `isatty(3)`, and the ability to
// put a foreground process group in charge of the keyboard. Without them `vim`
// and `top` refuse to run, or run and draw into nothing.
//
// The side effect that matters for killing: a session leader is also its own
// process group leader, so the shell's pid *is* its pgid and `kill(-pid, …)`
// reaches the whole tree. That is the difference between ending `npm test` and
// ending just the shell that started it.
type unixProcess struct {
	cmd  *exec.Cmd
	file *os.File
	once sync.Once
}

func spawnPTY(spec spawnSpec) (ptyProcess, error) {
	if len(spec.Argv) == 0 {
		return nil, errors.New("no shell to run")
	}
	cmd := exec.Command(spec.Argv[0], spec.Argv[1:]...)
	cmd.Dir = spec.Cwd
	cmd.Env = envFor(spec)

	file, err := pty.StartWithSize(cmd, &pty.Winsize{
		Cols: uint16(spec.Cols),
		Rows: uint16(spec.Rows),
	})
	if err != nil {
		return nil, err
	}
	return &unixProcess{cmd: cmd, file: file}, nil
}

func (p *unixProcess) PID() int { return p.cmd.Process.Pid }

func (p *unixProcess) Read(buffer []byte) (int, error) { return p.file.Read(buffer) }

func (p *unixProcess) Write(data []byte) (int, error) { return p.file.Write(data) }

// Resize sets the pty's window size. The kernel raises SIGWINCH on the
// foreground process group as part of the ioctl, which is what actually makes a
// full-screen program re-lay itself out — nothing has to be signalled here.
func (p *unixProcess) Resize(cols, rows int) error {
	return pty.Setsize(p.file, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

// Kill ends the shell and every process in its group.
//
// **The whole group, not the leader.** `shell → npm → node` is the ordinary shape
// of a command in a terminal, and signalling only the shell leaves `node` holding
// the port and the lock files while the screen reports that the terminal ended.
//
// SIGHUP first, then SIGKILL, in that order and for the same reason a real
// terminal does it: HUP is what closing a terminal window sends, and a shell that
// is between commands takes it as "clean up and go". It is not a courtesy,
// though — a process can ignore HUP, and the SIGKILL after a short grace period is
// what makes this a guarantee rather than a request. The wait is bounded because
// this runs on the caller's goroutine, and a kill that hangs is worse than one
// that is abrupt.
func (p *unixProcess) Kill() error {
	if p.cmd.Process == nil {
		return nil
	}
	pid := p.cmd.Process.Pid

	// Only the group this shell leads. Signalling a group we do not own — in
	// particular our own — would take the runtime down with the thing it was
	// trying to stop, which is a far worse outcome than a leftover process.
	hupErr := signalGroup(pid, syscall.SIGHUP)
	if hupErr == nil {
		deadline := time.Now().Add(300 * time.Millisecond)
		for time.Now().Before(deadline) {
			if !processAlive(pid) {
				return nil
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	killErr := signalGroup(pid, syscall.SIGKILL)
	if killErr == nil {
		return nil
	}
	// A backstop for the case where the group signal did not reach the leader:
	// already gone (ESRCH — which is the outcome the caller wanted, not a
	// failure), or the child never made it into its own group.
	if hupErr == nil {
		// The group signal was delivered; the leader may simply have been reaped
		// by the wait loop in between, which is also success.
		return nil
	}
	if err := p.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}

// signalGroup sends one signal to a process group, treating "no such process" as
// success. The caller asked for the group to be gone, and an empty group is that
// outcome by another route.
func signalGroup(pid int, signal syscall.Signal) error {
	err := syscall.Kill(-pid, signal)
	if err == syscall.ESRCH {
		return nil
	}
	return err
}

// processAlive reports whether a pid still exists. Signal 0 performs the
// permission and existence checks without delivering anything.
func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// Wait blocks until the shell ends and reports its exit code.
//
// A negative code means "there is no code to report", and `ExitCode` is asked
// rather than `WaitStatus` for a reason worth writing down: the two spellings of
// "was this killed by a signal" have both existed across Go releases
// (`Signalled` and `Signaled`), so the type assertion is a portability trap. The
// `os.ProcessState` API has been stable, means exactly the same thing — it returns
// -1 when the process was terminated by a signal — and is what this uses.
//
// Saying "no code" rather than 0 is not pedantry: a shell that was killed did not
// choose an exit status, and printing 0 next to it would make "we killed it" and
// "it finished cleanly" the same row on screen.
func (p *unixProcess) Wait() (int, bool, error) {
	err := p.cmd.Wait()
	if p.cmd.ProcessState == nil {
		return 0, false, err
	}
	code := p.cmd.ProcessState.ExitCode()
	if code < 0 {
		return 0, false, err
	}
	return code, true, err
}

// Close releases the pty master, which unblocks a pending Read.
func (p *unixProcess) Close() error {
	var err error
	p.once.Do(func() { err = p.file.Close() })
	return err
}
