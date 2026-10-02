// Package terminal runs the workspace's shells.
//
// A terminal is a **long-lived runtime resource**, not a front end's subprocess.
// The front end asks the runtime to create one, writes bytes to it, and reads an
// asynchronous stream of bytes back; it never owns the process, the working
// directory or the status. That split is what lets a desktop window and a
// terminal interface drive the same shell over the same protocol, and it is why
// nothing in this package knows a front end exists — it calls a sink function and
// somebody else decides where those bytes go.
//
// Four decisions are worth stating up front, because each of them is a place
// where the obvious implementation is wrong:
//
//  1. **A real PTY, never pipes.** `exec.Command` with stdin/stdout pipes cannot
//     carry a terminal: no line discipline, no rune-aware editing, no job
//     control, no window size, and no `isatty` — so `vim`, `top`, `htop` and a
//     `python` prompt all either refuse to start or draw garbage. The whole point
//     of the feature is those programs.
//
//  2. **The workspace is the boundary.** A terminal's cwd is resolved through the
//     same `tools.Workspace` the file tools use, so `../../other-project` is
//     refused here exactly as it is there. A second path check would be a second
//     door, and one of them would eventually be unguarded.
//
//  3. **Output is async and coalesced.** The PTY produces bytes at its own pace,
//     and a byte-per-event design would put an unbounded number of protocol lines
//     on the wire the moment something like `yes` ran. Reads are batched on a
//     short timer and a size threshold.
//
//  4. **Killing means the whole process group.** `shell → npm → node` is the
//     normal shape of a command. Killing only the shell leaves `node` holding the
//     port and the vendor directory while the screen says the terminal ended.
package terminal

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// Status is a terminal's lifecycle state.
//
// **`starting` is deliberately absent**, although the design lists it. Nothing
// can observe it: Create is synchronous, so by the time any answer travels the
// shell is either running or the attempt failed. A status that no message can
// ever carry is one a front end would draw and never see, and the honest list is
// the one whose every member can appear on the wire. The two failures the design
// wanted it for are both covered: a PTY that will not start is reported as an
// error from Create (there is no terminal at all, so there is no row to mark
// `failed`), and a shell that dies immediately is `exited` with its code.
type Status string

const (
	StatusRunning Status = "running"
	StatusExited  Status = "exited"
	StatusKilled  Status = "killed"
)

// Sizes a terminal is created with when the client does not say. 80x24 is the
// conventional terminal, and it is what a program that reads the size before the
// first resize will believe — so it should be the least surprising number rather
// than an arbitrary one.
const (
	DefaultCols = 80
	DefaultRows = 24
)

// ReadBuffer is how much one read from the PTY may take. It is the batch size,
// not a limit on the terminal: a read return closes a batch, and whatever did not
// arrive yet is the next one.
const ReadBuffer = 32 * 1024

// FlushInterval is how long a partial batch waits for company.
//
// It is the whole coalescing policy in one number. Too small and a chatty program
// produces one message per read; too large and an interactive prompt feels
// laggy. 16ms is about one frame — below the threshold where a person notices,
// above the rate at which a shell produces output.
const FlushInterval = 16 * time.Millisecond

// FlushThreshold forces a flush before the timer when a batch is already this
// big. Without it, a program producing megabytes (a `cat` of a large file, a
// build log) would put all of it in one message and one allocation.
const FlushThreshold = 64 * 1024

// MaxPending bounds the bytes held for a front end that is not keeping up.
//
// This is the one place the design's "do not block the runtime waiting for the
// UI" has teeth. The reads must not stop — a PTY whose buffer fills blocks the
// *shell*, which is the failure that makes a terminal look frozen — so the
// alternative to an unbounded buffer is dropping the oldest bytes and saying so.
// Four megabytes is roughly a thousand screens; anything past it is output nobody
// will read, and dropping the middle of it is far better than stalling the shell.
const MaxPending = 4 << 20

// DroppedNotice is inserted where bytes were dropped, so a front end shows a
// gap rather than a seamless lie. It is a terminal escape-free sentence: the
// place it lands may already be inside a full-screen program.
const DroppedNotice = "\r\n[output dropped: the client could not keep up]\r\n"

// EventKind is the three things a terminal ever reports. Everything a front end
// draws comes from one of them — there is no polling interface and no request
// that returns output, because a terminal that can only be read on request cannot
// show a program that is waiting for input.
type EventKind string

const (
	// EventOutput is a batch of bytes read from the PTY.
	EventOutput EventKind = "output"
	// EventState is a status transition that is not an exit.
	EventState EventKind = "state"
	// EventExit is the shell ending, by itself or because somebody killed it.
	// It is its own kind rather than a state transition because a front end has
	// to be able to tell "it stopped" from "it is running" without inferring it
	// from a status string — and because it carries the exit code.
	EventExit EventKind = "exit"
)

// Exit reasons. They are distinct because a program that typed `exit` and one
// that was killed look the same without them, and the two want different things
// on screen.
const (
	ReasonExited = "exited"
	ReasonKilled = "killed"
)

// Event is one thing a terminal has to say.
type Event struct {
	Kind EventKind
	// Info is the terminal as of this event. It travels whole rather than as an
	// id: an output batch from a terminal the front end has not drawn yet is
	// still drawable, and a status change is exactly the payload the row needs.
	Info Info
	// Data is the batch, for EventOutput only. It is a string because the
	// protocol is UTF-8 JSON lines; the bytes are decoded on the way in and an
	// incomplete trailing rune is held back (see splitRunes), so a batch never
	// ends mid-character.
	Data string
	// Reason is ReasonExited or ReasonKilled, for EventExit only.
	Reason string
}

// Info is one terminal, as the runtime reports it.
//
// The fields are the design's model plus the three a front end needs to draw a
// usable window: the size to send back on the next resize, and when it was made.
type Info struct {
	ID string
	// Workspace is the root this terminal is bounded by, and the same absolute
	// path `init.workspace` reports. There is no separate workspace *id* in this
	// program — the workspace is the directory the runtime was started in — so
	// this is the identity that actually exists rather than a number invented
	// here.
	Workspace string
	// Cwd is **workspace-relative**, which is the vocabulary both Files and
	// Terminal speak. An absolute path in a row would invite a front end to send
	// one back.
	Cwd   string
	Shell string
	PID   int
	// Status and ExitCode are the runtime's alone. A front end displays them and
	// never derives either.
	Status Status
	// ExitCode is nil until the shell has ended, and **stays nil when the code
	// says nothing**: a terminal this program killed did not exit with a code the
	// shell chose, and a process killed by a signal has no code to report. 0 and
	// "not known" are different facts and are told apart here rather than being
	// flattened into one number.
	ExitCode  *int
	CreatedAt float64
	Cols      int
	Rows      int
}

// Row is the wire form. The row's shape is defined here, once, so the protocol
// layer carries it and no front end has to be told a second time what a terminal
// looks like.
func (i Info) Row() map[string]any {
	row := map[string]any{
		"id":         i.ID,
		"workspace":  i.Workspace,
		"cwd":        i.Cwd,
		"shell":      i.Shell,
		"pid":        i.PID,
		"status":     string(i.Status),
		"created_at": i.CreatedAt,
		"cols":       i.Cols,
		"rows":       i.Rows,
	}
	// Explicitly null rather than absent while the shell runs: a front end that
	// has to tell "no exit code yet" from "the runtime did not say" has two cases
	// to draw where one is correct.
	if i.ExitCode == nil {
		row["exit_code"] = nil
	} else {
		row["exit_code"] = *i.ExitCode
	}
	return row
}

// Manager owns every terminal in one workspace.
//
// It lives at *process* scope rather than on a session, and that is the design's
// central structural point: a session can be switched, deleted or closed, and a
// shell the person is running in the same workspace must not be affected. Session
// and terminal are siblings under the workspace, not parent and child.
type Manager struct {
	mu        sync.Mutex
	root      string
	workspace *tools.Workspace
	sessions  map[string]*session
	order     []string
	next      int
	sink      func(Event)
	clock     func() float64
	closed    bool
}

// NewManager builds a manager bounded by one workspace root.
//
// The root is resolved through `tools.Workspace`, so the boundary a terminal's
// cwd is checked against is *the same object* the file tools use. A failure here
// is not a reason to start without a boundary — an unguarded shell is a worse
// outcome than a missing feature — so the caller is expected to refuse to start.
func NewManager(root string) (*Manager, error) {
	workspace, err := tools.NewWorkspace(root)
	if err != nil {
		return nil, err
	}
	return &Manager{
		root:      workspace.Root(),
		workspace: workspace,
		sessions:  map[string]*session{},
		sink:      func(Event) {},
		clock:     nowSeconds,
	}, nil
}

// Root is the workspace this manager's terminals live in.
func (m *Manager) Root() string { return m.root }

// SetSink points the manager at wherever its events go.
//
// A function rather than an interface, and set rather than injected, for one
// reason: the sink changes when the *connection* changes but the terminals do
// not. A session switch builds a new runtime and a new server-side callback while
// the shells keep running, so the destination has to be movable without touching
// the things being reported about.
//
// The sink is called from the terminal's own goroutines. It must return promptly;
// it is not allowed to block on a person.
func (m *Manager) SetSink(sink func(Event)) {
	if sink == nil {
		sink = func(Event) {}
	}
	m.mu.Lock()
	m.sink = sink
	m.mu.Unlock()
}

// Create starts one shell in a PTY.
//
// The cwd is resolved against the workspace before anything is spawned, so a
// request that escapes is refused without leaving a process behind. A path that
// does not exist, or is a file, is refused for the same reason: the alternative
// is a shell that starts in some other directory, which reads as "the request was
// honoured" while the person's commands run somewhere else.
func (m *Manager) Create(cwd string, cols, rows int) (Info, error) {
	target, relative, err := m.resolveDir(cwd)
	if err != nil {
		return Info{}, err
	}
	if cols <= 0 {
		cols = DefaultCols
	}
	if rows <= 0 {
		rows = DefaultRows
	}
	shell := defaultShell()

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Info{}, fmt.Errorf("this workspace's terminals are shutting down")
	}
	m.next++
	id := fmt.Sprintf("term-%02d", m.next)
	info := Info{
		ID:        id,
		Workspace: m.root,
		Cwd:       relative,
		Shell:     shell.Display,
		Cols:      cols,
		Rows:      rows,
		Status:    StatusRunning,
		CreatedAt: m.clock(),
	}
	m.mu.Unlock()

	proc, err := spawnPTY(spawnSpec{
		Argv:  shell.Argv,
		Shell: shell.Display,
		Cwd:   target,
		Cols:  cols,
		Rows:  rows,
	})
	if err != nil {
		return Info{}, err
	}

	info.PID = proc.PID()
	run := &session{
		manager: m,
		info:    info,
		proc:    proc,
		input:   newInputQueue(),
		exited:  make(chan struct{}),
	}

	m.mu.Lock()
	// Registered only now, after the PTY came up: a row in the list with no
	// process behind it is a row a front end will send input to.
	m.sessions[id] = run
	m.order = append(m.order, id)
	m.mu.Unlock()

	// The reader starts before this returns, and that ordering is forced: the
	// shell is already running and writing to the PTY, and a PTY whose buffer
	// fills blocks the shell. A window between `spawnPTY` and the first read is a
	// window in which a chatty program stalls.
	run.start()

	// Nothing is emitted for the transition into `running`. The caller is about
	// to be handed this very row as the answer to its own request, and a status
	// event alongside it would make a front end insert the terminal twice.
	return info, nil
}

// List returns every terminal in creation order.
//
// Finished ones stay on the list. They are what answers "what was I running" —
// and a terminal disappearing the moment its shell exits would delete the exit
// code and the last screenful of output along with it.
func (m *Manager) List() []Info {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Info, 0, len(m.order))
	for _, id := range m.order {
		if run, ok := m.sessions[id]; ok {
			out = append(out, run.snapshot())
		}
	}
	return out
}

// Input writes raw bytes to a terminal's PTY.
//
// **Nothing here parses the input.** There is no line buffer, no history, no
// "add a newline for them": `Ctrl+C`, `Ctrl+D`, `Tab`, an arrow key and Escape
// are all just bytes, and what they mean is decided by the shell on the other
// side. A runtime that interpreted them would be a second terminal emulator, and
// it would be the wrong one.
func (m *Manager) Input(id, data string) error {
	run, err := m.lookup(id)
	if err != nil {
		return err
	}
	return run.write(data)
}

// Resize changes the PTY's window size.
//
// It is a required capability rather than a nicety: `vim`, `top`, `htop` and
// `less` read the size and lay themselves out from it, so a window that never
// reports a resize draws those programs at 80 columns inside a 200-column pane.
//
// A terminal that has already ended is a no-op rather than an error. The caller
// is a window that changed size, which is not a mistake it can stop making, and
// answering each one with a notice would bury the messages that matter.
func (m *Manager) Resize(id string, cols, rows int) error {
	run, err := m.lookup(id)
	if err != nil {
		return err
	}
	if cols <= 0 || rows <= 0 {
		// Ignored rather than clamped to something plausible. A size nobody asked
		// for makes a full-screen program redraw at the wrong width, and on screen
		// that is indistinguishable from a rendering bug in this program.
		return nil
	}
	return run.resize(cols, rows)
}

// Kill ends a terminal and everything it started.
//
// The answer is not sent from here. The exit travels the same path a shell that
// ended by itself takes — see session.wait — because the design's rule is that
// **the runtime is the only source of truth for "is it still running"**, and a
// second path that reported a kill directly would be a second truth.
//
// Killing a terminal that has already ended is not an error: the person pressed
// the button, and "it was already gone" is the outcome they wanted.
func (m *Manager) Kill(id string) error {
	run, err := m.lookup(id)
	if err != nil {
		return err
	}
	return run.terminate()
}

// Remove forgets a terminal that has already ended.
//
// **Only an ended one, and that restriction is the whole safety property.** A
// running shell has a process behind it, and dropping the record would leave that
// process unseen, unlisted and unreachable by a later kill — the leftover `node`
// holding the port while the screen says nothing is running, which is precisely
// the failure the kill path exists to prevent. A caller that wants a running
// terminal gone ends it first; the ending arrives as the usual `terminal_exit`,
// and only then is there nothing left to leak.
//
// It is a **separate operation from Kill rather than a flag on it**, because the
// two do different things to different things: one ends a process, the other
// deletes a record. Folding them would make "stop this shell" and "stop showing
// me this shell" the same message, and the first front end to want one without
// the other would have to guess.
//
// The cost is deliberate and worth stating: an ended terminal is what answers
// "what was I running", so removing one takes its exit code and its last
// screenful with it. That is why this is the person's own act, not something a
// front end does on its own initiative.
func (m *Manager) Remove(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.sessions[id]
	if !ok {
		return fmt.Errorf("no terminal %s in this workspace", id)
	}
	if run.snapshot().Status == StatusRunning {
		return fmt.Errorf("terminal %s is still running; end it first", id)
	}
	// The PTY is released as well, not merely forgotten. The wait path closes it
	// itself only when the reader was still blocked at exit (see `session.waitLoop`),
	// so a shell whose reader finished on its own — the ordinary POSIX case, where
	// closing the child gives the master EOF — would otherwise leave a file
	// descriptor behind for every terminal the person tidied away. Both platform
	// implementations are idempotent, so the case where the wait path already
	// closed it costs nothing.
	_ = run.proc.Close()
	delete(m.sessions, id)
	for index, candidate := range m.order {
		if candidate == id {
			m.order = append(m.order[:index], m.order[index+1:]...)
			break
		}
	}
	return nil
}

// Close ends every terminal this manager owns.
//
// It is the process-exit path. Without it a POSIX shell, which `Setsid` put in
// its own session, outlives the runtime that started it — and the symptom is a
// machine slowly filling with orphaned shells holding ports and files, each one
// invisible because the window that could show it is gone.
func (m *Manager) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	runs := make([]*session, 0, len(m.order))
	for _, id := range m.order {
		if run, ok := m.sessions[id]; ok {
			runs = append(runs, run)
		}
	}
	m.mu.Unlock()

	for _, run := range runs {
		run.shutdown()
	}
	return nil
}

// resolveDir turns a workspace-relative path into an absolute one that is inside
// the workspace and is a directory.
//
// The returned relative form is normalised too, because it is what goes on the
// wire: answering `./src/../src` when the request said `src` would make two
// requests for one directory look like two directories.
func (m *Manager) resolveDir(path string) (target, relative string, err error) {
	target, err = m.workspace.SafePath(path)
	if err != nil {
		return "", "", err
	}
	info, statErr := os.Stat(target)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			return "", "", fmt.Errorf("no such directory in this workspace: %s", displayPath(path))
		}
		return "", "", statErr
	}
	if !info.IsDir() {
		return "", "", fmt.Errorf("not a directory: %s", displayPath(path))
	}
	relative, err = m.relative(target)
	if err != nil {
		return "", "", err
	}
	return target, relative, nil
}

// relative is the workspace-relative spelling of an absolute path inside it.
func (m *Manager) relative(target string) (string, error) {
	if target == m.root {
		// The root is reported as the empty string, which is the same value the
		// protocol uses to mean "the workspace itself". A "." here would be a
		// second spelling of one fact, and the two would eventually disagree.
		return "", nil
	}
	relative, err := filepath.Rel(m.root, target)
	if err != nil {
		return "", err
	}
	// `filepath.Rel` uses the platform separator, and the wire vocabulary is the
	// one a person types. On Windows that turns a perfectly good `src/main.go`
	// into `src\main.go`, which a front end would then have to normalise — and a
	// front end doing path arithmetic is exactly what this boundary exists to
	// prevent.
	return filepath.ToSlash(relative), nil
}

func (m *Manager) lookup(id string) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.sessions[id]
	if !ok {
		return nil, fmt.Errorf("no terminal %s in this workspace", id)
	}
	return run, nil
}

// deliver is how a session reaches the sink without holding the manager's lock.
//
// Read under the lock and called outside it: the sink writes to a transport, and
// holding the manager's lock across that would let one slow client block every
// other terminal's status change.
func (m *Manager) deliver(event Event) {
	m.mu.Lock()
	sink := m.sink
	m.mu.Unlock()
	sink(event)
}

// displayPath renders a path for an error message. The empty string is the
// workspace itself, and saying "no such directory in this workspace: " with
// nothing after the colon tells the reader nothing.
func displayPath(path string) string {
	if path == "" || path == "." {
		return "."
	}
	return path
}

func nowSeconds() float64 {
	return float64(time.Now().UnixNano()) / 1e9
}
