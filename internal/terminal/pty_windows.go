//go:build windows

package terminal

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// procUpdateAttribute is `UpdateProcThreadAttribute` reached directly.
//
// It is not reached through `windows.ProcThreadAttributeListContainer.Update` for
// one reason, and it is the only reason this file has a lazy DLL proc at all: that
// helper's `lpValue` is an `unsafe.Pointer`, and the value this call needs is an
// opaque kernel handle rather than a pointer to anything. See launchProcess for
// what goes wrong when the address of a local is passed instead 鈥?the shell dies
// with STATUS_DLL_INIT_FAILED, which is a failure with no diagnostic of its own.
var procUpdateAttribute = windows.NewLazySystemDLL("kernel32.dll").
	NewProc("UpdateProcThreadAttribute")

// windowsProcess is one Windows terminal: a shell started on a pseudo console
// (ConPTY).
//
// **ConPTY, not pipes.** The obvious Windows implementation 鈥?`cmd.StdinPipe()`
// plus a `conhost` 鈥?cannot be a terminal: a pipe has no line discipline, no
// window size and no console, so `isatty` is false, PowerShell runs in
// non-interactive mode, and every full-screen program either refuses to start or
// draws into nothing. ConPTY is the operating system's own answer to "a terminal
// with no window", and it is the only thing on this platform that a shell will
// treat as one.
//
// The handle dance is the fiddly part and every step of it earns its place:
//
//	pipe A  ptyIn (read end, given to the console)  鈫? ourIn (we write input here)
//	pipe B  ourOut (we read output here)            鈫? ptyOut (given to the console)
//
// `ptyIn` and `ptyOut` are handed to `CreatePseudoConsole` and **closed in this
// process straight afterwards**. Closing them is not tidiness: the console host
// holds its own references, and leaving our copies of the *output write end* open
// would mean `ourOut` never sees end of stream 鈥?the read would block forever
// after the shell died, and the terminal would never report that it ended. That
// is the single most common way a hand-written ConPTY leaks a goroutine per
// shell.
//
// Neither `ourIn` nor `ourOut` is inheritable. A child that inherited our write
// end of the input pipe would keep it open past our own close, and the shell
// would never see end of input.
type windowsProcess struct {
	console windows.Handle
	process windows.Handle
	thread  windows.Handle
	job     windows.Handle
	pid     int

	in  *os.File
	out *os.File

	closeOnce sync.Once
	waitOnce  sync.Once
	code      int
	codeOK    bool
}

func spawnPTY(spec spawnSpec) (ptyProcess, error) {
	if len(spec.Argv) == 0 {
		return nil, errors.New("no shell to run")
	}

	// Inheritable, because these two ends have to reach the console host.
	sa := &windows.SecurityAttributes{
		Length:        uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		InheritHandle: 1,
	}

	var ptyIn, ourIn, ourOut, ptyOut windows.Handle
	if err := windows.CreatePipe(&ptyIn, &ourIn, sa, 0); err != nil {
		return nil, fmt.Errorf("could not create the terminal's input pipe: %w", err)
	}
	if err := windows.CreatePipe(&ourOut, &ptyOut, sa, 0); err != nil {
		windows.CloseHandle(ptyIn)
		windows.CloseHandle(ourIn)
		return nil, fmt.Errorf("could not create the terminal's output pipe: %w", err)
	}
	// Our own ends must not be inherited: a child holding our write end of the
	// input pipe would keep it alive past our close, and the shell would never
	// see end of input 鈥?a `exit` that does not work, with nothing on screen to
	// explain it.
	_ = windows.SetHandleInformation(ourIn, windows.HANDLE_FLAG_INHERIT, 0)
	_ = windows.SetHandleInformation(ourOut, windows.HANDLE_FLAG_INHERIT, 0)

	// **CreatePseudoConsole refuses a zero size.** It returns E_INVALIDARG for a
	// 0x0 console, which is why the manager clamps the size before it gets here;
	// this is the second line of defence for a caller that did not.
	cols, rows := spec.Cols, spec.Rows
	if cols <= 0 {
		cols = DefaultCols
	}
	if rows <= 0 {
		rows = DefaultRows
	}

	var console windows.Handle
	if err := windows.CreatePseudoConsole(
		windows.Coord{X: int16(cols), Y: int16(rows)}, ptyIn, ptyOut, 0, &console); err != nil {
		windows.CloseHandle(ptyIn)
		windows.CloseHandle(ourIn)
		windows.CloseHandle(ourOut)
		windows.CloseHandle(ptyOut)
		return nil, fmt.Errorf("this system did not provide a pseudo console "+
			"(Windows 10 1809 or newer is required): %w", err)
	}

	process, thread, pid, err := launchProcess(spec, console)
	// The console host keeps its own references to the two ends it was given, so
	// ours go now 鈥?see the type comment for why the output write end in
	// particular must not stay open.
	windows.CloseHandle(ptyIn)
	windows.CloseHandle(ptyOut)
	if err != nil {
		windows.ClosePseudoConsole(console)
		windows.CloseHandle(ourIn)
		windows.CloseHandle(ourOut)
		return nil, err
	}

	proc := &windowsProcess{
		console: console,
		process: process,
		thread:  thread,
		pid:     int(pid),
		in:      os.NewFile(uintptr(ourIn), "terminal-input"),
		out:     os.NewFile(uintptr(ourOut), "terminal-output"),
	}
	// A job object per terminal, so that ending it takes the whole tree with it.
	// `taskkill /T` is the fallback, but a job is atomic and needs no child
	// process of its own 鈥?see Kill.
	proc.job = createKillOnCloseJob(process)
	return proc, nil
}

// launchProcess starts the shell attached to the console.
//
// The console is handed over through a **process/thread attribute list**, which is
// the only way to attach one at creation: a process either has a console from the
// moment it starts or never does, and there is no API to attach one afterwards.
// That is also why `CreateProcess` is called directly rather than through
// `os/exec` 鈥?`exec.Cmd` has no place to put an attribute list.
func launchProcess(spec spawnSpec, console windows.Handle) (process, thread windows.Handle, pid uint32, err error) {
	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("could not prepare the console attributes: %w", err)
	}
	defer attributes.Delete()

	// The attribute takes the console's **handle value**, and this is the one
	// detail in the whole handshake that fails silently rather than loudly.
	//
	// `UpdateProcThreadAttribute` is reached through the DLL procs directly rather
	// than through x/sys's `ProcThreadAttributeListContainer.Update`, because that
	// helper takes an `unsafe.Pointer` for `lpValue` 鈥?so the natural spelling at
	// the call site is `&console`, the address of a local. The kernel wants the
	// HPCON itself, and an address is a valid-looking pointer that makes
	// `CreateProcess` fail with STATUS_DLL_INIT_FAILED (0xC0000142): the shell is
	// created, exits instantly, and writes nothing. Measured against a real
	// cmd.exe, both ways, before this was written.
	//
	// The conversion through `uintptr` is what `go vet` flags as a possibly
	// misused pointer 鈥?correctly, in general. Here it is exactly right: the value
	// is an opaque kernel handle, not a Go pointer, and there is no memory for a
	// collector to move.
	ret, _, callErr := procUpdateAttribute.Call(
		uintptr(unsafe.Pointer(attributes.List())),
		0,
		uintptr(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE),
		uintptr(console),
		unsafe.Sizeof(console),
		0, 0)
	if ret == 0 {
		return 0, 0, 0, fmt.Errorf("could not attach the console to the shell: %w", callErr)
	}

	commandLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(spec.Argv))
	if err != nil {
		return 0, 0, 0, err
	}
	currentDir, err := windows.UTF16PtrFromString(spec.Cwd)
	if err != nil {
		return 0, 0, 0, err
	}

	env := envFor(spec)
	envBlock, err := environmentBlock(env)
	if err != nil {
		return 0, 0, 0, err
	}

	startup := windows.StartupInfoEx{}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	// `STARTF_USESTDHANDLES` with the three handle fields left null, and both
	// halves of that matter.
	//
	// Without the flag the child inherits **this process's** standard handles, so
	// a shell started from a terminal writes straight to that terminal and the
	// pseudoconsole relays nothing 鈥?measured: `cmd /c echo` printed to the test's
	// own console while the console pipe carried only conhost's 16-byte VT init.
	// The flag is what makes the console host supply the handles instead.
	//
	// Left null because that is what "let the console supply them" means here: the
	// pseudoconsole's own ends are the right values and this process never holds
	// them (its copies of `ptyIn` / `ptyOut` are closed as soon as the console
	// exists 鈥?see spawnPTY). Pointing the fields at handles we kept would be
	// pointing them at the wrong end of the right pipe.
	//
	// **`EXTENDED_STARTUPINFO_PRESENT` is deliberately not set here.** It is a
	// `CreateProcess` creation flag, not a `dwFlags` bit; the extended struct is
	// selected by passing it to `CreateProcess`, which this does.
	startup.Flags = windows.STARTF_USESTDHANDLES
	startup.ProcThreadAttributeList = attributes.List()

	var info windows.ProcessInformation
	// `CreateProcess` takes a `*StartupInfo`; an extended one is the same memory
	// with the attribute list appended, and the embedded `StartupInfo` is that
	// struct's first field 鈥?which is what makes this cast correct rather than
	// merely conventional.
	//
	// `bInheritHandles` is false, and that is not an oversight: the console host
	// receives the pseudoconsole's ends through the attribute list, not through
	// handle inheritance. Inheriting this process's whole handle table instead
	// would hand the shell our pipe ends, which is exactly the leak that stops an
	// output read seeing end of stream.
	if err := windows.CreateProcess(
		nil,
		commandLine,
		nil,
		nil,
		false,
		windows.EXTENDED_STARTUPINFO_PRESENT|windows.CREATE_UNICODE_ENVIRONMENT,
		envBlock,
		currentDir,
		&startup.StartupInfo,
		&info,
	); err != nil {
		return 0, 0, 0, fmt.Errorf("could not start the shell: %w", err)
	}
	// The thread handle is not used, but it has to be closed: leaving it open
	// keeps a kernel object alive for the shell's whole life, once per terminal.
	windows.CloseHandle(info.Thread)
	return info.Process, 0, info.ProcessId, nil
}

// environmentBlock renders the child's environment in the form `CreateProcess`
// wants: a run of null-terminated UTF-16 `name=value` strings, with a second null
// terminating the run.
//
// It is built by hand rather than taken from `CreateEnvironmentBlock` for one
// reason: that call builds the environment from the *token*, and this function's
// whole job is to send a slightly different one (see `envFor`). Handing
// `CreateProcess` a block built from the token would silently drop the `TERM` and
// `COLORTERM` the terminal needs.
func environmentBlock(entries []string) (*uint16, error) {
	var block []uint16
	for _, entry := range entries {
		encoded, err := windows.UTF16FromString(entry)
		if err != nil {
			// A name or value with a NUL in it is not representable in an
			// environment block at all. Skipping one variable is the right
			// degradation: the rest of the environment is still correct, and the
			// alternative is a shell that does not start.
			continue
		}
		block = append(block, encoded...)
	}
	block = append(block, 0)
	return &block[0], nil
}

// createKillOnCloseJob puts a process in a job object that ends it.
//
// **Why a job rather than just `taskkill /T`.** `shell 鈫?npm 鈫?node` is the
// ordinary shape of a command, and `TerminateJobObject` ends every process in the
// job in one call with no chance of a race, no second process to spawn, and no
// window in which a newly forked child escapes. The job is also
// kill-on-close, so a *runtime* that dies without running `Close` still takes its
// terminals down with it 鈥?the same guarantee the background-job board gives, for
// the same reason.
//
// A failure is not fatal: `Kill` falls back to `taskkill /T`, which is less
// atomic but works in environments that refuse job objects (a nested job on an
// old Windows, a restricted token). Returning 0 means "no job".
func createKillOnCloseJob(process windows.Handle) windows.Handle {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		windows.CloseHandle(job)
		return 0
	}
	if err := windows.AssignProcessToJobObject(job, process); err != nil {
		windows.CloseHandle(job)
		return 0
	}
	return job
}

func (p *windowsProcess) PID() int { return p.pid }

func (p *windowsProcess) Read(buffer []byte) (int, error) { return p.out.Read(buffer) }

func (p *windowsProcess) Write(data []byte) (int, error) { return p.in.Write(data) }

// Resize sets the console's window size. The console host raises the equivalent
// of SIGWINCH for whatever is attached, which is what makes a full-screen program
// re-lay itself out.
func (p *windowsProcess) Resize(cols, rows int) error {
	return windows.ResizePseudoConsole(p.console, windows.Coord{
		X: int16(cols),
		Y: int16(rows),
	})
}

// Kill ends the shell and every process it started.
//
// The job object is tried first 鈥?it is one call and it cannot miss a
// grandchild 鈥?and `taskkill /T` is the fallback for a machine where a job could
// not be created. `TerminateProcess` on the handle is the last resort, and it is
// explicitly worse: it reaches the shell only, which is exactly the leftover
// `node` holding the port that this function exists to prevent.
func (p *windowsProcess) Kill() error {
	if p.process == 0 {
		return nil
	}
	if p.job != 0 {
		if err := windows.TerminateJobObject(p.job, 1); err == nil {
			return nil
		}
	}
	taskkill := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(p.pid)).Run()
	// A zero exit from taskkill means the tree is gone. Killing the process
	// directly answering "already finished" is the same outcome by a different
	// route, and counting it as a failure would put a warning on every kill that
	// raced a shell exiting by itself.
	if taskkill == nil {
		return nil
	}
	if err := windows.TerminateProcess(p.process, 1); err != nil &&
		!errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return err
	}
	return nil
}

// Wait blocks until the shell has ended and reports its exit code.
func (p *windowsProcess) Wait() (int, bool, error) {
	if _, err := windows.WaitForSingleObject(p.process, windows.INFINITE); err != nil {
		return 0, false, err
	}
	var code uint32
	if err := windows.GetExitCodeProcess(p.process, &code); err != nil {
		return 0, false, err
	}
	p.waitOnce.Do(func() { p.code, p.codeOK = int(code), true })
	if !p.codeOK {
		// The wait returned for a reason other than the process ending (a
		// timeout, an abandoned object). Saying "no code" is the honest answer;
		// inventing one would put a number on screen that no shell produced.
		return 0, false, nil
	}
	return p.code, true, nil
}

// Close releases the console and the pipes.
//
// It runs **after** the shell has ended, and the order matters: closing a pseudo
// console while its process is still attached can block until that process
// exits, and a `Close` that hangs would freeze the very goroutine that is trying
// to report the terminal as finished.
//
// Closing the console first is also what makes the pending output read return:
// the console host holds the write end of the output pipe until it goes, so
// closing our read end alone would leave the reader blocked on a handle nobody
// will write to again.
func (p *windowsProcess) Close() error {
	p.closeOnce.Do(func() {
		if p.console != 0 {
			windows.ClosePseudoConsole(p.console)
		}
		if p.out != nil {
			_ = p.out.Close()
		}
		if p.in != nil {
			_ = p.in.Close()
		}
		if p.process != 0 {
			windows.CloseHandle(p.process)
		}
		// The job handle goes last and **is** closed here, unlike the session-wide
		// one in `internal/process`: that one is deliberately leaked so that
		// KILL_ON_JOB_CLOSE fires when the runtime dies, while this one belongs to
		// a single terminal that has already ended. Leaking it would keep a kernel
		// object per terminal for the life of the process.
		if p.job != 0 {
			windows.CloseHandle(p.job)
		}
	})
	return nil
}
