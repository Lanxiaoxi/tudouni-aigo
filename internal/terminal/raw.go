package terminal

// RawProcess is one shell on a PTY, with none of the Manager's policy around it.
//
// The Manager's session adds coalescing, a drop policy and its own event stream,
// all of which are right for the runtime's protocol and wrong for a caller that
// keeps its own ring buffer and sequence numbers (the workspace host). Rather than
// bend the Manager to serve both, this exposes only the platform layer: the part
// that is hard to write twice (ConPTY handle plumbing, process-group kills) and
// has no policy in it.
type RawProcess interface {
	// PID is the shell's process id.
	PID() int
	// Read and Write move bytes through the PTY.
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	// Resize sets the window size.
	Resize(cols, rows int) error
	// Kill ends the shell and its descendants.
	Kill() error
	// Wait blocks until the shell has ended. ok is false when the platform has
	// no exit code to give (a signal, or a console that had to be closed).
	Wait() (code int, ok bool, err error)
	// Close releases the PTY and unblocks a pending Read. Call it after Wait.
	Close() error
}

// SpawnRaw starts the platform's default shell in cwd on a fresh PTY.
//
// cwd is used as given: boundary checks belong to the caller, which knows what
// its workspace is. The returned name is how the shell is shown to a person
// (`PowerShell`, `/bin/zsh`), not a path.
//
// Non-positive sizes fall back to the Manager's defaults, because
// CreatePseudoConsole refuses a zero-sized console.
func SpawnRaw(cwd string, cols, rows int) (RawProcess, string, error) {
	if cols <= 0 {
		cols = DefaultCols
	}
	if rows <= 0 {
		rows = DefaultRows
	}
	shell := defaultShell()
	proc, err := spawnPTY(spawnSpec{
		Argv:  shell.Argv,
		Shell: shell.Display,
		Cwd:   cwd,
		Cols:  cols,
		Rows:  rows,
	})
	if err != nil {
		return nil, "", err
	}
	return proc, shell.Display, nil
}
