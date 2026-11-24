package host

import (
	"encoding/base64"
	"fmt"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/terminal"
)

// Terminal limits.
const (
	// ringBytes is how much output each terminal keeps for a reconnecting front
	// end (spec: 1MB).
	ringBytes = 1 << 20
	// pumpChunk is the most one `term_output` carries. Smaller than the ring so a
	// front end that reads slowly sees steady progress rather than one 1MB line.
	pumpChunk = 64 * 1024
	// inputQueueLen bounds keystrokes waiting for the PTY writer.
	inputQueueLen = 1024
	// maxTerminals is a sanity cap, not a product limit: every terminal is a
	// shell process plus a megabyte of ring.
	maxTerminals = 32
	killWait     = 3 * time.Second
)

// terminalManager owns the workspace's terminals.
//
// **Output delivery policy (bounded, lossy toward the past, never toward the
// future).** Each terminal's output goes into its own 1MB ring and is *pulled* out
// of it by a per-terminal pump at whatever rate the single output queue accepts.
// There is no per-terminal send queue to grow: if the front end is slow, the pump
// blocks on the shared queue, the ring keeps accepting (the shell is never
// stalled — a full PTY blocks the program inside it), and the oldest bytes are
// overwritten. When the pump finds its position has been overwritten it jumps
// forward to the oldest byte still held and tells the front end with `term_gap`,
// so a loss is always reported, and memory is bounded by ring size × terminals.
// The front end is never disconnected for being slow.
type terminalManager struct {
	h *Host

	mu     sync.Mutex
	items  map[string]*term
	nextID int
	closed bool
}

func newTerminalManager(h *Host) *terminalManager {
	return &terminalManager{h: h, items: map[string]*term{}}
}

// termInfo is the wire shape of one terminal.
type termInfo struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	Cwd         string `json:"cwd"`
	Shell       string `json:"shell"`
	Title       string `json:"title"`
	CreatedAt   int64  `json:"created_at"`
	State       string `json:"state"`
	ExitCode    *int   `json:"exit_code"`
	Cols        int    `json:"cols"`
	Rows        int    `json:"rows"`
	OutputSeq   int64  `json:"output_seq"`
}

type term struct {
	m     *terminalManager
	id    string
	cwd   string
	shell string
	title string
	born  time.Time
	proc  terminal.RawProcess

	mu       sync.Mutex
	ring     *ring
	cols     int
	rows     int
	exited   bool
	exitCode *int
	// attached is what the front end asked for; live is set only once the attach
	// result is in the output queue, so no live output can overtake the replay.
	attached bool
	live     bool
	// sent is the next seq the pump will push.
	sent     int64
	exitSent bool

	wake     chan struct{}
	input    chan []byte
	readDone chan struct{}
	exitedCh chan struct{}
	stop     chan struct{}
	stopOnce sync.Once
}

func (t *term) info() termInfo {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.infoLocked()
}

func (t *term) infoLocked() termInfo {
	state := "running"
	if t.exited {
		state = "exited"
	}
	return termInfo{
		ID: t.id, WorkspaceID: t.m.h.ctx.ID, Cwd: t.cwd, Shell: t.shell, Title: t.title,
		CreatedAt: t.born.UnixMilli(), State: state, ExitCode: t.exitCode,
		Cols: t.cols, Rows: t.rows, OutputSeq: t.ring.head,
	}
}

func (t *term) poke() {
	select {
	case t.wake <- struct{}{}:
	default:
	}
}

func (m *terminalManager) handle(t string, msg map[string]any) (any, *wireError) {
	switch t {
	case MsgTermList:
		return m.list(), nil
	case MsgTermCreate:
		return m.create(msg)
	}
	id := argString(msg, "id")
	if id == "" {
		return nil, errf(CodeBadRequest, "id is required")
	}
	item := m.get(id)
	if item == nil {
		return nil, errf(CodeNotFound, "no terminal %q", id)
	}
	switch t {
	case MsgTermAttach:
		return m.attach(item, msg)
	case MsgTermDetach:
		item.mu.Lock()
		item.attached, item.live = false, false
		item.mu.Unlock()
		item.poke() // a detached, exited terminal can report its exit now
		return map[string]any{}, nil
	case MsgTermInput:
		return item.write(argString(msg, "data"))
	case MsgTermResize:
		return item.resize(msg)
	case MsgTermKill:
		item.kill()
		return map[string]any{}, nil
	case MsgTermClose:
		m.remove(item)
		return map[string]any{}, nil
	}
	return nil, errf(CodeUnsupported, "unknown message %q", t)
}

func (m *terminalManager) get(id string) *term {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.items[id]
}

func (m *terminalManager) list() any {
	m.mu.Lock()
	all := make([]*term, 0, len(m.items))
	for _, item := range m.items {
		all = append(all, item)
	}
	m.mu.Unlock()
	sort.Slice(all, func(i, j int) bool { return all[i].born.Before(all[j].born) || (all[i].born.Equal(all[j].born) && all[i].id < all[j].id) })
	infos := make([]termInfo, 0, len(all))
	for _, item := range all {
		infos = append(infos, item.info())
	}
	return map[string]any{"terminals": infos}
}

func (m *terminalManager) create(msg map[string]any) (any, *wireError) {
	cols, werr := argInt(msg, "cols", terminal.DefaultCols)
	if werr != nil {
		return nil, werr
	}
	rows, werr := argInt(msg, "rows", terminal.DefaultRows)
	if werr != nil {
		return nil, werr
	}
	if cols <= 0 || cols > 1000 || rows <= 0 || rows > 1000 {
		return nil, errf(CodeBadRequest, "cols and rows must be between 1 and 1000")
	}

	// The same boundary every file path goes through. A terminal's cwd is where
	// the person's commands start, so it is held to the same rule as a path.
	target, werr := m.h.files.resolve(argString(msg, "cwd"))
	if werr != nil {
		return nil, werr
	}
	info, err := os.Stat(target.abs)
	if err != nil {
		return nil, ioError(err, "term_create cwd")
	}
	if !info.IsDir() {
		return nil, errf(CodeBadRequest, "cwd is not a directory")
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, errf(CodeInternal, "the host is shutting down")
	}
	if len(m.items) >= maxTerminals {
		m.mu.Unlock()
		return nil, errf(CodeBadRequest, "too many terminals (limit %d)", maxTerminals)
	}
	m.nextID++
	id := fmt.Sprintf("t%d", m.nextID)
	m.mu.Unlock()

	proc, shell, err := terminal.SpawnRaw(target.abs, cols, rows)
	if err != nil {
		return nil, errf(CodeInternal, "could not start a shell: %v", err)
	}
	title := argString(msg, "title")
	if title == "" {
		title = shell
	}
	item := &term{
		m: m, id: id, cwd: target.rel, shell: shell, title: title, born: time.Now(), proc: proc,
		ring: newRing(ringBytes), cols: cols, rows: rows,
		wake: make(chan struct{}, 1), input: make(chan []byte, inputQueueLen),
		readDone: make(chan struct{}), exitedCh: make(chan struct{}), stop: make(chan struct{}),
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		_ = proc.Kill()
		_ = proc.Close()
		return nil, errf(CodeInternal, "the host is shutting down")
	}
	m.items[id] = item
	m.mu.Unlock()

	// The reader starts before this returns: the shell is already writing, and a
	// PTY nobody reads blocks the shell.
	go item.readLoop()
	go item.writeLoop()
	go item.waitLoop()
	go item.pump()
	return map[string]any{"terminal": item.info()}, nil
}

func (m *terminalManager) attach(item *term, msg map[string]any) (any, *wireError) {
	from, werr := argInt64(msg, "from_seq", 0)
	if werr != nil {
		return nil, werr
	}
	item.mu.Lock()
	data, actual, gap := item.ring.window(from)
	// Everything up to the head is in `data`; the pump continues from there. Both
	// happen under one lock, which is what makes the join exact: no byte is in
	// both and none falls between.
	item.sent = item.ring.head
	item.attached = true
	item.live = false
	info := item.infoLocked()
	item.mu.Unlock()

	return &afterSend{
		data: map[string]any{
			"terminal": info, "from_seq": actual,
			"data": base64.StdEncoding.EncodeToString(data), "gap": gap,
		},
		then: func() {
			item.mu.Lock()
			// A detach (or another attach) may have happened while the result was
			// queued; only the attach that is still current goes live.
			if item.attached {
				item.live = true
			}
			item.mu.Unlock()
			item.poke()
		},
	}, nil
}

func (t *term) write(data string) (any, *wireError) {
	t.mu.Lock()
	exited := t.exited
	t.mu.Unlock()
	if exited {
		return nil, errf(CodeBadRequest, "terminal %s has exited", t.id)
	}
	if data == "" {
		return map[string]any{}, nil
	}
	select {
	case t.input <- []byte(data):
		return map[string]any{}, nil
	default:
		// Refusing is better than blocking: the read loop is the one goroutine that
		// can still process a kill, and it must not wait on a stuck program.
		return nil, errf(CodeInternal, "terminal %s is not accepting input (queue full)", t.id)
	}
}

func (t *term) resize(msg map[string]any) (any, *wireError) {
	cols, werr := argInt(msg, "cols", 0)
	if werr != nil {
		return nil, werr
	}
	rows, werr := argInt(msg, "rows", 0)
	if werr != nil {
		return nil, werr
	}
	if cols <= 0 || cols > 1000 || rows <= 0 || rows > 1000 {
		return nil, errf(CodeBadRequest, "cols and rows must be between 1 and 1000")
	}
	t.mu.Lock()
	exited := t.exited
	t.mu.Unlock()
	if exited {
		return map[string]any{}, nil
	}
	if err := t.proc.Resize(cols, rows); err != nil {
		return nil, errf(CodeInternal, "resize failed: %v", err)
	}
	t.mu.Lock()
	t.cols, t.rows = cols, rows
	t.mu.Unlock()
	return map[string]any{}, nil
}

// kill ends the process and waits (bounded) for the exit to be recorded, so the
// result the front end gets already reflects `state:"exited"`.
func (t *term) kill() {
	t.mu.Lock()
	exited := t.exited
	t.mu.Unlock()
	if !exited {
		_ = t.proc.Kill()
	}
	select {
	case <-t.exitedCh:
	case <-time.After(killWait):
	}
}

// remove kills (if needed) and forgets a terminal.
func (m *terminalManager) remove(item *term) {
	item.kill()
	m.mu.Lock()
	delete(m.items, item.id)
	m.mu.Unlock()
	item.shutdown()
}

func (t *term) shutdown() {
	t.stopOnce.Do(func() { close(t.stop) })
	// Releasing the PTY unblocks a reader that never saw end of stream (ConPTY).
	_ = t.proc.Close()
}

// closeAll ends every terminal; used on shutdown. The deadline is shared so that
// many stubborn shells cannot multiply the wait.
func (m *terminalManager) closeAll(timeout time.Duration) {
	m.mu.Lock()
	m.closed = true
	all := make([]*term, 0, len(m.items))
	for _, item := range m.items {
		all = append(all, item)
	}
	m.items = map[string]*term{}
	m.mu.Unlock()

	for _, item := range all {
		item.mu.Lock()
		exited := item.exited
		item.mu.Unlock()
		if !exited {
			_ = item.proc.Kill()
		}
	}
	deadline := time.After(timeout)
	for _, item := range all {
		select {
		case <-item.exitedCh:
		case <-deadline:
		}
		item.shutdown()
	}
}

// --- per-terminal goroutines -------------------------------------------------------

func (t *term) readLoop() {
	defer close(t.readDone)
	buf := make([]byte, terminal.ReadBuffer)
	for {
		n, err := t.proc.Read(buf)
		if n > 0 {
			t.mu.Lock()
			t.ring.write(buf[:n])
			t.mu.Unlock()
			t.poke()
		}
		if err != nil {
			return
		}
	}
}

func (t *term) writeLoop() {
	for {
		select {
		case chunk := <-t.input:
			if _, err := t.proc.Write(chunk); err != nil {
				return
			}
		case <-t.stop:
			return
		case <-t.exitedCh:
			return
		}
	}
}

func (t *term) waitLoop() {
	code, ok, _ := t.proc.Wait()

	// Let the reader drain what the shell wrote before it died; the last line is
	// usually the interesting one. On Windows the output pipe only ends when the
	// pseudo console is closed, which is safe now that the process is gone.
	select {
	case <-t.readDone:
	case <-time.After(150 * time.Millisecond):
		_ = t.proc.Close()
		select {
		case <-t.readDone:
		case <-time.After(500 * time.Millisecond):
		}
	}

	t.mu.Lock()
	t.exited = true
	if ok {
		value := code
		t.exitCode = &value
	}
	t.mu.Unlock()
	close(t.exitedCh)
	t.poke()
}

// pump pushes ring contents to the front end while the terminal is attached, and
// reports the exit exactly once.
func (t *term) pump() {
	h := t.m.h
	for {
		select {
		case <-t.wake:
		case <-t.stop:
			return
		case <-h.done:
			return
		}
		for {
			t.mu.Lock()
			if t.live && t.sent < t.ring.start() {
				// Overwritten before it could be sent: say so, then continue from
				// the oldest byte that still exists.
				lost := t.ring.start() - t.sent
				from := t.sent
				t.sent = t.ring.start()
				t.mu.Unlock()
				h.send(map[string]any{
					"t": MsgTermGap, "id": t.id, "from_seq": from, "to_seq": from + lost,
				})
				continue
			}
			if t.live && t.sent < t.ring.head {
				to := t.ring.head
				if to-t.sent > pumpChunk {
					to = t.sent + pumpChunk
				}
				seq := t.sent
				data := t.ring.read(seq, to)
				t.sent = to
				t.mu.Unlock()
				h.send(map[string]any{
					"t": MsgTermOutput, "id": t.id, "seq": seq,
					"data": base64.StdEncoding.EncodeToString(data),
				})
				continue
			}
			// Nothing left to push. The exit goes out only after the output that
			// preceded it (for an attached terminal), and goes out whether or not
			// anybody is attached.
			if t.exited && !t.exitSent && (!t.live || t.sent >= t.ring.head) {
				t.exitSent = true
				var code any
				if t.exitCode != nil {
					code = *t.exitCode
				}
				t.mu.Unlock()
				h.send(map[string]any{"t": MsgTermExit, "id": t.id, "exit_code": code})
				continue
			}
			t.mu.Unlock()
			break
		}
	}
}
