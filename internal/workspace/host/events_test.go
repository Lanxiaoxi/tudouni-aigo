package host

import (
	"sync"
	"testing"
	"time"
)

// fakeClock is a Scheduler the test fires by hand.
type fakeClock struct {
	mu      sync.Mutex
	pending []func()
	windows []time.Duration
}

func (c *fakeClock) schedule(d time.Duration, f func()) func() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.windows = append(c.windows, d)
	idx := len(c.pending)
	c.pending = append(c.pending, f)
	return func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.pending[idx] = nil
		return true
	}
}

func (c *fakeClock) fire() {
	c.mu.Lock()
	var run []func()
	for _, f := range c.pending {
		if f != nil {
			run = append(run, f)
		}
	}
	c.pending = nil
	c.mu.Unlock()
	for _, f := range run {
		f()
	}
}

func newTestHub(maxChanges int) (*EventHub, *fakeClock, *[]WorkspaceEvent) {
	clock := &fakeClock{}
	var events []WorkspaceEvent
	hub := NewEventHub(HubConfig{MaxChanges: maxChanges, Schedule: clock.schedule},
		func(e WorkspaceEvent) { events = append(events, e) })
	return hub, clock, &events
}

func TestHubCoalescesIntoOneWindow(t *testing.T) {
	hub, clock, events := newTestHub(0)
	hub.Add("b.go", ChangeModified)
	hub.Add("a.go", ChangeCreated)
	hub.Add("b.go", ChangeModified)
	hub.Add("b.go", ChangeModified)
	if len(*events) != 0 {
		t.Fatal("nothing may be emitted before the window closes")
	}
	if len(clock.windows) != 1 || clock.windows[0] != DefaultWindow {
		t.Fatalf("one 300ms window expected, got %v", clock.windows)
	}
	clock.fire()
	if len(*events) != 1 {
		t.Fatalf("want 1 event, got %d", len(*events))
	}
	e := (*events)[0]
	if e.Revision != 1 || e.ResetRequired || len(e.Changes) != 2 {
		t.Fatalf("event: %+v", e)
	}
	if e.Changes[0] != (Change{"a.go", ChangeCreated}) || e.Changes[1] != (Change{"b.go", ChangeModified}) {
		t.Fatalf("changes are deduplicated and sorted: %+v", e.Changes)
	}
	if len(e.Invalidates) != 2 {
		t.Fatalf("invalidates: %v", e.Invalidates)
	}
}

func TestHubRevisionIsMonotonic(t *testing.T) {
	hub, clock, events := newTestHub(0)
	for i := 0; i < 3; i++ {
		hub.Add("f", ChangeModified)
		clock.fire()
	}
	if len(*events) != 3 {
		t.Fatalf("got %d events", len(*events))
	}
	for i, e := range *events {
		if e.Revision != int64(i+1) {
			t.Fatalf("event %d has revision %d", i, e.Revision)
		}
	}
	if hub.Revision() != 3 {
		t.Fatalf("Revision() = %d", hub.Revision())
	}
}

func TestHubMergeRules(t *testing.T) {
	cases := []struct {
		name  string
		steps []string
		want  string // "" = no change reported
	}{
		{"create then modify stays created", []string{ChangeCreated, ChangeModified}, ChangeCreated},
		{"create then delete cancels out", []string{ChangeCreated, ChangeDeleted}, ""},
		{"modify then delete is deleted", []string{ChangeModified, ChangeDeleted}, ChangeDeleted},
		{"delete then create is a modification", []string{ChangeDeleted, ChangeCreated}, ChangeModified},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			hub, clock, events := newTestHub(0)
			for _, s := range c.steps {
				hub.Add("x", s)
			}
			clock.fire()
			if c.want == "" {
				if len(*events) != 0 {
					t.Fatalf("expected no event, got %+v", *events)
				}
				return
			}
			if len(*events) != 1 || len((*events)[0].Changes) != 1 || (*events)[0].Changes[0].Type != c.want {
				t.Fatalf("got %+v, want %s", *events, c.want)
			}
		})
	}
}

func TestHubTooManyChangesResets(t *testing.T) {
	hub, clock, events := newTestHub(5)
	for i := 0; i < 6; i++ {
		hub.Add(string(rune('a'+i)), ChangeCreated)
	}
	hub.Add("late", ChangeCreated) // swallowed by the reset
	clock.fire()
	e := (*events)[0]
	if !e.ResetRequired || len(e.Changes) != 0 || len(e.Invalidates) != 2 {
		t.Fatalf("overflow must produce a reset event: %+v", e)
	}
	// And the hub is usable afterwards.
	hub.Add("again", ChangeModified)
	clock.fire()
	if e := (*events)[1]; e.ResetRequired || e.Revision != 2 {
		t.Fatalf("second event: %+v", e)
	}
}

func TestHubGitOnlyAndReset(t *testing.T) {
	hub, clock, events := newTestHub(0)
	hub.AddGit()
	clock.fire()
	e := (*events)[0]
	if len(e.Changes) != 0 || len(e.Invalidates) != 1 || e.Invalidates[0] != InvalidateGit || e.ResetRequired {
		t.Fatalf("git-only event: %+v", e)
	}
	hub.Reset()
	clock.fire()
	if e := (*events)[1]; !e.ResetRequired || len(e.Changes) != 0 {
		t.Fatalf("reset event: %+v", e)
	}
}

func TestHubCloseDropsPending(t *testing.T) {
	hub, clock, events := newTestHub(0)
	hub.Add("x", ChangeModified)
	hub.Close()
	clock.fire()
	hub.Add("y", ChangeModified)
	clock.fire()
	if len(*events) != 0 {
		t.Fatalf("a closed hub emitted %+v", *events)
	}
}

func TestSkipRules(t *testing.T) {
	for _, rel := range []string{"node_modules", "a/node_modules", "dist", "pkg/target", ".tudouni/index", ".tudouni/index/x"} {
		if watchableDir(rel) {
			t.Errorf("%s must not be watched", rel)
		}
	}
	for _, rel := range []string{"src", ".tudouni", ".tudouni/sessions", ".git", ".git/refs", ".git/refs/heads"} {
		if !watchableDir(rel) {
			t.Errorf("%s must be watched", rel)
		}
	}
	for _, rel := range []string{".git/objects", ".git/objects/ab", ".git/logs"} {
		if watchableDir(rel) {
			t.Errorf("%s must not be watched", rel)
		}
	}
	for _, inside := range []string{"HEAD", "index", "refs/heads/main", "MERGE_HEAD", "REBASE_HEAD", "rebase-merge"} {
		if !gitFileRelevant(inside) {
			t.Errorf(".git/%s should raise a git event", inside)
		}
	}
	for _, inside := range []string{"index.lock", "objects/ab/cdef", "COMMIT_EDITMSG", "FETCH_HEAD"} {
		if gitFileRelevant(inside) {
			t.Errorf(".git/%s should not raise a git event", inside)
		}
	}
}
