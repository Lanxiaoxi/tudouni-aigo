package host

import (
	"sort"
	"sync"
	"time"
)

// Change is one path that changed, in workspace-relative `/` form.
type Change struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

// Change types of a workspace_event.
const (
	ChangeCreated  = "created"
	ChangeModified = "modified"
	ChangeDeleted  = "deleted"
	ChangeRenamed  = "renamed"
)

// Cache names a workspace_event can invalidate.
const (
	InvalidateFiles = "files"
	InvalidateGit   = "git"
)

// WorkspaceEvent is what the hub hands to its sink once per window.
type WorkspaceEvent struct {
	Revision      int64
	Changes       []Change
	Invalidates   []string
	ResetRequired bool
}

// Scheduler runs f once after d and returns a function that cancels it.
//
// It is a seam, not a feature: the coalescing rules are the part worth testing,
// and a test that has to sleep for 300ms of real time per case either gets slow
// or gets flaky. Production uses time.AfterFunc; tests hand in a fake that fires
// when they say so.
type Scheduler func(d time.Duration, f func()) (stop func() bool)

func realScheduler(d time.Duration, f func()) func() bool {
	return time.AfterFunc(d, f).Stop
}

// Defaults from the spec: a 300ms window, and more than 500 distinct paths in one
// window is treated as "too much to list, resync instead".
const (
	DefaultWindow     = 300 * time.Millisecond
	DefaultMaxChanges = 500
)

// HubConfig tunes an EventHub. The zero value is the production configuration.
type HubConfig struct {
	Window     time.Duration
	MaxChanges int
	Schedule   Scheduler
}

// EventHub merges raw file-system notifications into workspace events.
//
// One window opens at the first notification after quiet and closes a fixed
// Window later (not a debounce that keeps extending): a tool that writes
// continuously would otherwise starve the front end of any update at all, and a
// bounded latency is the property a UI can rely on.
//
// Inside a window the same path is merged to one net change. The merge answers
// "what happened to this path between the front end's last view and now", which is
// why create+delete cancels out and delete+create is a modification.
type EventHub struct {
	cfg  HubConfig
	emit func(WorkspaceEvent)

	// emitMu spans "swap the pending set" and "call emit". Without it two flushes
	// can interleave and deliver revision N+1 before N, and the revision is the
	// one thing the front end uses to detect a gap.
	emitMu sync.Mutex

	mu       sync.Mutex
	pending  map[string]string
	gitDirty bool
	reset    bool
	armed    bool
	stop     func() bool
	revision int64
	closed   bool
}

// NewEventHub builds a hub that delivers events to emit.
func NewEventHub(cfg HubConfig, emit func(WorkspaceEvent)) *EventHub {
	if cfg.Window <= 0 {
		cfg.Window = DefaultWindow
	}
	if cfg.MaxChanges <= 0 {
		cfg.MaxChanges = DefaultMaxChanges
	}
	if cfg.Schedule == nil {
		cfg.Schedule = realScheduler
	}
	return &EventHub{cfg: cfg, emit: emit, pending: map[string]string{}}
}

// Add records one path change.
func (e *EventHub) Add(path, typ string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	if e.reset {
		// Already going to ask for a full resync; the details would be thrown away.
		return
	}
	if prev, seen := e.pending[path]; seen {
		if merged := mergeChange(prev, typ); merged != "" {
			e.pending[path] = merged
		} else {
			delete(e.pending, path)
		}
	} else {
		e.pending[path] = typ
	}
	if len(e.pending) > e.cfg.MaxChanges {
		// Too many to be useful as a list. Dropping the map is also what bounds
		// the memory a `git checkout` of a huge tree can cost.
		e.reset = true
		e.pending = map[string]string{}
	}
	e.arm()
}

// AddGit records that something git cares about changed (HEAD, index, refs...).
func (e *EventHub) AddGit() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	e.gitDirty = true
	e.arm()
}

// Reset asks the front end to throw its caches away and resync. It is the answer
// to every "we may have missed something" condition: watcher overflow, watcher
// errors, a directory that could not be watched.
func (e *EventHub) Reset() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	e.reset = true
	e.pending = map[string]string{}
	e.arm()
}

// arm opens a window if none is open. The caller holds e.mu.
func (e *EventHub) arm() {
	if e.armed {
		return
	}
	e.armed = true
	e.stop = e.cfg.Schedule(e.cfg.Window, e.Flush)
}

// Flush closes the current window and emits its event, if there is one. The timer
// calls it; tests call it directly.
func (e *EventHub) Flush() {
	e.emitMu.Lock()
	defer e.emitMu.Unlock()

	e.mu.Lock()
	e.armed = false
	e.stop = nil
	if e.closed {
		e.mu.Unlock()
		return
	}
	changes := make([]Change, 0, len(e.pending))
	for path, typ := range e.pending {
		changes = append(changes, Change{Path: path, Type: typ})
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].Path < changes[j].Path })
	reset, gitDirty := e.reset, e.gitDirty
	e.pending = map[string]string{}
	e.reset, e.gitDirty = false, false

	if len(changes) == 0 && !reset && !gitDirty {
		// Everything in the window cancelled out.
		e.mu.Unlock()
		return
	}
	event := WorkspaceEvent{Changes: changes, ResetRequired: reset}
	switch {
	case reset:
		event.Invalidates = []string{InvalidateFiles, InvalidateGit}
	case len(changes) > 0:
		// A changed file can change `git status` too, so files never invalidate
		// alone: the front end would otherwise show a stale git panel until the
		// next poll.
		event.Invalidates = []string{InvalidateFiles, InvalidateGit}
	default:
		event.Invalidates = []string{InvalidateGit}
	}
	e.revision++
	event.Revision = e.revision
	e.mu.Unlock()

	e.emit(event)
}

// Revision is the revision of the last emitted event (0 before any).
func (e *EventHub) Revision() int64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.revision
}

// Close stops delivery. Pending changes are dropped: the process is going away.
func (e *EventHub) Close() {
	e.mu.Lock()
	e.closed = true
	stop := e.stop
	e.mu.Unlock()
	if stop != nil {
		stop()
	}
}

// mergeChange folds a later change of the same path into an earlier one inside a
// window. "" means the two cancel out and the path should not be reported.
func mergeChange(prev, next string) string {
	switch prev {
	case ChangeCreated:
		switch next {
		case ChangeDeleted, ChangeRenamed:
			// Appeared and went away again inside one window: nothing to show.
			return ""
		}
		return ChangeCreated
	case ChangeModified:
		switch next {
		case ChangeDeleted:
			return ChangeDeleted
		case ChangeRenamed:
			return ChangeRenamed
		}
		return ChangeModified
	case ChangeDeleted, ChangeRenamed:
		switch next {
		case ChangeCreated, ChangeModified:
			// Gone and back: an atomic save (write temp, rename over) looks exactly
			// like this, and to a viewer it is an edit.
			return ChangeModified
		}
		return prev
	}
	return next
}
