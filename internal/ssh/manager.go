package ssh

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"
)

// Connector opens one remote shell.
//
// **It is an interface so that everything above it can be tested without a
// server.** The manager's job — the session table, the "which one is still
// alive" list — is not about SSH at all, and a test that had to start an `sshd`
// to check that a fifth connect is refused would be a test that does not run on
// most machines. The real implementation is in `dial.go`; the tests supply one
// that returns an in-memory channel.
//
// `host` is already resolved: the connector never reads `~/.ssh/config`, because
// resolving an alias and opening a socket are the two halves of "connect" and only
// the second one needs a network.
type Connector func(host Host, cols, rows int, timeout time.Duration) (Channel, error)

// Manager owns every SSH session in one workspace.
//
// It lives at **process scope**, exactly like `terminal.Manager`, and the reason
// is the same: a session can be switched, deleted or closed while a remote shell
// the agent is in the middle of using keeps running. The two managers ending up as
// siblings under the workspace rather than as parent and child is the design's
// central structural point, not a coincidence of where they were constructed.
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*session
	order    []string
	next     int
	closed   bool

	// connector is how a session is opened. It is a field rather than a package
	// function so tests can replace it.
	connector Connector
	// configPath and home pin where the configuration is read from. Empty means
	// the user's own `~/.ssh`.
	configPath string
	home       string
	// clock is injectable so a test can advance time without waiting.
	clock func() float64
	// events receives one record per session lifecycle change, for the audit.
	// Nil means "nobody is listening", which is the ordinary case for an
	// in-process front end.
	events func(kind string, info Info, extra map[string]any)
}

// NewManager builds a manager that opens real connections.
//
// `configPath` empty means the user's own configuration; `home` empty means the
// current user's home directory. Both are parameters rather than globals for the
// same reason `LoadConfig` takes them: a test points them at a directory it made.
func NewManager(configPath, home string) *Manager {
	manager := &Manager{
		sessions:   map[string]*session{},
		configPath: configPath,
		home:       home,
		clock:      nowSeconds,
	}
	manager.connector = DialConnector(configPath, home)
	return manager
}

// NewManagerWithConnector builds a manager around an injected connector, for
// tests. It takes the same configuration parameters so that alias resolution
// behaves identically.
func NewManagerWithConnector(connector Connector, configPath, home string) *Manager {
	manager := &Manager{
		sessions:   map[string]*session{},
		connector:  connector,
		configPath: configPath,
		home:       home,
		clock:      nowSeconds,
	}
	return manager
}

// SetClock replaces the time source, for tests.
func (m *Manager) SetClock(clock func() float64) {
	if clock == nil {
		return
	}
	m.mu.Lock()
	m.clock = clock
	m.mu.Unlock()
}

// SetEventSink points the manager at wherever lifecycle records go.
//
// A function rather than an interface, and set rather than injected, for the same
// reason `terminal.Manager.SetSink` is: the destination changes when the session
// changes while the sessions themselves keep running.
func (m *Manager) SetEventSink(sink func(kind string, info Info, extra map[string]any)) {
	m.mu.Lock()
	m.events = sink
	m.mu.Unlock()
}

// Host resolves an alias through the user's configuration without connecting.
//
// It is exposed so the tool layer can report what a connect *would* do, and so a
// test can assert on resolution without a socket.
func (m *Manager) Host(alias string) (Host, error) {
	return m.HostWithPassword(alias, "")
}

// HostWithPassword resolves an alias with a call-time password in scope, so the
// resolve step can accept a password-only host that it would otherwise refuse.
func (m *Manager) HostWithPassword(alias, password string) (Host, error) {
	m.mu.Lock()
	configPath, home := m.configPath, m.home
	m.mu.Unlock()
	config, err := LoadConfig(configPath, home)
	if err != nil {
		return Host{}, err
	}
	return config.LookupWithPassword(alias, password)
}

// Connect resolves an alias, opens a session and registers it.
//
// **The order inside this function is the whole of its safety.** The alias is
// resolved, the session table is checked for room, and only then is anything
// opened — so a fifth connect is refused without a socket having been made, and a
// typo in the configuration never reaches the network. What is *not* done here is
// approval: the permission layer runs before this handler, which is why the tool
// declares a risk level rather than trying to ask.
func (m *Manager) Connect(alias string, cols, rows int, timeout time.Duration) (Info, error) {
	return m.ConnectWithPassword(alias, "", cols, rows, timeout)
}

// ConnectWithPassword is Connect with a password supplied at call time.
//
// The password is a **model-supplied override** of the configuration's own
// `Password`, not a third credential source: it replaces whatever the Host block
// said, and an empty one means "use the configuration". It exists for hosts that
// have no key set up and whose password nobody wants to write into `~/.ssh/config`
// just for one session — the same reason `user@host` overrides `User` without a
// config edit.
func (m *Manager) ConnectWithPassword(alias, password string, cols, rows int, timeout time.Duration) (Info, error) {
	// The override travels into resolution, not after it: a host with no key in
	// its configuration must be reachable when a password is in hand, and that
	// decision lives in the resolve step — see `Config.lookup`.
	host, err := m.HostWithPassword(alias, password)
	if err != nil {
		return Info{}, err
	}
	if cols <= 0 {
		cols = DefaultCols
	}
	if rows <= 0 {
		rows = DefaultRows
	}
	if timeout <= 0 {
		timeout = DefaultConnectTimeoutSeconds * time.Second
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Info{}, fmt.Errorf("this workspace's SSH sessions are shutting down")
	}
	live := 0
	for _, run := range m.sessions {
		if run.snapshot().Status == StatusRunning {
			live++
		}
	}
	if live >= MaxSessions {
		m.mu.Unlock()
		return Info{}, fmt.Errorf(
			"there are already %d live SSH sessions, which is the limit. "+
				"Close one with ssh_close, or check which are still alive with ssh_sessions, before opening another",
			MaxSessions)
	}
	m.next++
	id := sessionID(m.next)
	info := Info{
		ID:        id,
		User:      host.User,
		HostName:  host.HostName,
		Port:      host.Port,
		Alias:     host.Alias,
		Cols:      cols,
		Rows:      rows,
		Status:    StatusRunning,
		CreatedAt: m.clock(),
	}
	m.mu.Unlock()

	connector := m.connector
	opened, err := connector(host, cols, rows, timeout)
	if err != nil {
		// The id was reserved but nothing was registered, so it is simply not
		// reused: a hole in the numbering (`ssh-01`, `ssh-03`) is easier to read
		// than an id that names two different sessions across a session's life.
		return Info{}, err
	}

	run := &session{
		manager: m,
		channel: opened,
		host:    host,
		input:   newInputQueue(),
		info:    info,
		exited:  make(chan struct{}),
	}

	m.mu.Lock()
	// Registered only now, after the channel came up: a row in the list with no
	// connection behind it is a row the model will write to.
	m.sessions[id] = run
	m.order = append(m.order, id)
	sink := m.events
	m.mu.Unlock()

	run.start()
	if sink != nil {
		sink("ssh_connect", info, map[string]any{
			"alias":    host.Alias,
			"warnings": host.Warnings,
		})
	}
	return info, nil
}

// List returns every session in creation order.
//
// Ended ones **stay on the list**, and that is the design rather than an
// oversight. They are what answers "what was I running" — and a session that
// vanished the moment its shell exited would take its exit code and the last
// output with it, which is exactly the half the model needs when a deployment
// failed. Removing one is the model's own act, through `ssh_close`.
func (m *Manager) List() []Info {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Info, 0, len(m.order))
	for _, id := range sortedIDs(m.order) {
		if run, ok := m.sessions[id]; ok {
			out = append(out, run.snapshot())
		}
	}
	return out
}

// Write sends raw bytes to a session.
func (m *Manager) Write(id, data string) error {
	run, err := m.lookup(id)
	if err != nil {
		return err
	}
	return run.write(data)
}

// Read pulls output from a session, waiting up to `timeout`.
func (m *Manager) Read(ctx context.Context, id string, limit int, timeout time.Duration) (ReadResult, error) {
	run, err := m.lookup(id)
	if err != nil {
		return ReadResult{}, err
	}
	return run.read(ctx, limit, timeout)
}

// Close ends a session and everything running under it.
//
// The ending itself is not reported from here. It travels the path a shell that
// exited by itself takes — see `session.waitLoop` — because the design's rule is
// that **the session is the only source of truth for whether it is running**, and
// a second path that reported a close directly would be a second truth.
//
// It **waits** for that ending to be recorded, within the same grace period a
// shutdown allows, and the wait is the point rather than tidiness: without it,
// Close returns while the exit is still in flight, and every answer that reads the
// session afterwards — `ssh_sessions`, a second `ssh_close` saying whether there
// was anything left to close — depends on how the race happened to land. A shell
// receiving EOF ends promptly; the grace period only matters for a far end that has
// stopped responding, and there waiting is exactly what a caller wants.
//
// Closing a session that has already ended is not an error: the model asked for it
// to be gone, and "it was already gone" is the outcome it wanted.
func (m *Manager) Close(id string) error {
	run, err := m.lookup(id)
	if err != nil {
		return err
	}
	run.shutdown()
	return nil
}

// Forget drops a session that has already ended from the list.
//
// **Only an ended one, and that restriction is the whole safety property.** A
// running session has a connection behind it, and dropping the record would leave
// that connection open, unlisted and unreachable by a later close — a shell still
// logged in on a production host while the list the model reads says nothing is
// running. A caller that wants a running session gone ends it first; the ending
// arrives as the usual exit, and only then is there nothing left to leak.
func (m *Manager) Forget(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.sessions[id]
	if !ok {
		return fmt.Errorf("no SSH session %s in this workspace", id)
	}
	if run.snapshot().Status == StatusRunning {
		return fmt.Errorf("session %s is still running; close it first", id)
	}
	run.markClosed()
	delete(m.sessions, id)
	for index, candidate := range m.order {
		if candidate == id {
			m.order = append(m.order[:index], m.order[index+1:]...)
			break
		}
	}
	return nil
}

// CloseAll ends every session this manager owns, for the process-exit path.
//
// Without it a login session outlives the runtime that opened it: the TCP
// connection is dropped when the process dies, but the far end may sit at a login
// prompt until its own keepalive notices, and on a host reachable only through a
// jump box that can be a long time. The local terminals get the same treatment
// through their own `Close`, and this is the same guarantee by a different route.
func (m *Manager) CloseAll() error {
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

// lookup finds one session or explains why not.
//
// The message names the id and says how to see what does exist, because the model
// that typed the wrong one has no other way to find that out — and a bare "not
// found" would send it guessing at ids.
func (m *Manager) lookup(id string) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.sessions[id]
	if !ok {
		return nil, fmt.Errorf("no SSH session %s in this workspace; ssh_sessions lists the ones that exist", id)
	}
	return run, nil
}

// sessionID mints the id for the n-th session: `ssh-01`, `ssh-02`, …
//
// Zero-padded so the ids sort the way a person reads them, and prefixed `ssh-` so
// that a session id is recognisable in a transcript where terminal ids (`term-01`)
// also appear.
func sessionID(sequence int) string {
	return fmt.Sprintf("ssh-%02d", sequence)
}

func nowSeconds() float64 {
	return float64(time.Now().UnixNano()) / 1e9
}

// ConfigWarnings reports what the user's configuration said that this program
// could not apply.
//
// It is surfaced at connect time rather than at startup, because until the model
// names an alias there is no way to know which `Host` block is even relevant — a
// warning about `Host old-bastion` on a session that never mentions it is noise,
// and noise is what makes real warnings invisible.
func (m *Manager) ConfigWarnings(alias string) []string {
	host, err := m.Host(alias)
	if err != nil {
		return nil
	}
	return host.Warnings
}

// isNoSuchFile is the sentinel a missing key file produces, kept beside the
// manager so the connector and its tests agree on what "not there" means.
func isNoSuchFile(err error) bool { return err != nil && (os.IsNotExist(err) || errors.Is(err, os.ErrNotExist)) }
