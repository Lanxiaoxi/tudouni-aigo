package protocol

import (
	"context"
	"strings"
	"testing"
	"time"
)

// archiveStub records what the archive hook was asked to do.
type archiveStub struct{ stubRuntime }

// TestArchivingOnlyTouchesTheMetadataAndRefreshesTheList: archiving is a metadata
// edit, not a delete — the mounted session is untouched (no new handshake), and the
// picker is re-sent because the list is the only thing that can report a list change.
func TestArchivingOnlyTouchesTheMetadataAndRefreshesTheList(t *testing.T) {
	var out strings.Builder
	type call struct {
		id       string
		archived bool
	}
	var calls []call
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		ArchiveSession: func(id string, archived bool) error {
			calls = append(calls, call{id, archived})
			return nil
		},
	})
	server.Attach(&archiveStub{})

	server.Dispatch(map[string]any{
		"v": VERSION, "t": InSessionArchive, "session_id": "20260101-120000", "archived": true,
	})

	if len(calls) != 1 || calls[0].id != "20260101-120000" || !calls[0].archived {
		t.Fatalf("the archive hook saw %v, want one call archiving the requested id", calls)
	}
	messages := sentMessages(t, &out)
	if got := countKind(messages, OutSessions); got != 1 {
		t.Errorf("sent %d sessions lists after an archive, want 1", got)
	}
	if got := countKind(messages, OutInit); got != 0 {
		t.Errorf("sent %d init messages, want 0: archiving does not restart the session", got)
	}
	if got := len(sessionNotices(messages)); got != 1 {
		t.Errorf("sent %d session notices, want 1 confirming the archive", got)
	}
}

// TestUnarchivingIsTheSameMessageWithFalse: `archived` is an absolute state, not a
// toggle, so the two directions differ only in the boolean.
func TestUnarchivingIsTheSameMessageWithFalse(t *testing.T) {
	var out strings.Builder
	var calls []bool
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		ArchiveSession: func(id string, archived bool) error {
			calls = append(calls, archived)
			return nil
		},
	})
	server.Attach(&archiveStub{})

	server.Dispatch(map[string]any{
		"v": VERSION, "t": InSessionArchive, "session_id": "s", "archived": false,
	})

	if len(calls) != 1 || calls[0] {
		t.Fatalf("calls = %v, want a single un-archive", calls)
	}
}

// TestAnArchiveWithoutAnIDIsRefused: an empty id would otherwise be an archive of
// nothing that still reports success.
func TestAnArchiveWithoutAnIDIsRefused(t *testing.T) {
	var out strings.Builder
	ran := 0
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		ArchiveSession: func(id string, archived bool) error { ran++; return nil },
	})
	server.Attach(&archiveStub{})

	server.Dispatch(map[string]any{"v": VERSION, "t": InSessionArchive, "archived": true})

	if ran != 0 {
		t.Fatalf("the archive hook ran %d times, want no call", ran)
	}
	if got := len(sessionNotices(sentMessages(t, &out))); got != 1 {
		t.Errorf("sent %d session notices, want 1 refusal", got)
	}
}

// TestAnArchiveNeedsABoolean decides the fail-closed direction: a missing `archived`
// must not be read as either value, because guessing would make archiving and
// un-archiving the same undecidable gesture.
func TestAnArchiveNeedsABoolean(t *testing.T) {
	var out strings.Builder
	ran := 0
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		ArchiveSession: func(id string, archived bool) error { ran++; return nil },
	})
	server.Attach(&archiveStub{})

	server.Dispatch(map[string]any{"v": VERSION, "t": InSessionArchive, "session_id": "s"})

	if ran != 0 {
		t.Fatalf("the archive hook ran %d times without a boolean, want no call", ran)
	}
	if got := len(sessionNotices(sentMessages(t, &out))); got != 1 {
		t.Errorf("sent %d session notices, want 1 refusal", got)
	}
}

// TestANilArchiverRefuses is fail-closed, like the nil deleter and the nil factory.
func TestANilArchiverRefuses(t *testing.T) {
	var out strings.Builder
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{})
	server.Attach(&archiveStub{})

	server.Dispatch(map[string]any{
		"v": VERSION, "t": InSessionArchive, "session_id": "s", "archived": true,
	})

	notices := sessionNotices(sentMessages(t, &out))
	if len(notices) != 1 {
		t.Fatalf("sent %d session notices, want 1 refusal", len(notices))
	}
	if level, _ := notices[0]["level"].(string); level != "warn" {
		t.Errorf("the refusal reported level %q, want warn", level)
	}
}

// TestTheListFilterDefaultsToIncludingArchived is the compatibility rule: a front
// end with no archive concept (CLI, TUI) sends a bare `session_list`, and it has no
// way to un-archive — so the default must not hide sessions from it.
func TestTheListFilterDefaultsToIncludingArchived(t *testing.T) {
	var out strings.Builder
	var sawInclude []bool
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		SessionSummaries: func(includeArchived bool) []map[string]any {
			sawInclude = append(sawInclude, includeArchived)
			return nil
		},
	})
	server.Attach(&archiveStub{})

	server.Dispatch(map[string]any{"v": VERSION, "t": InSessionList})
	server.Dispatch(map[string]any{"v": VERSION, "t": InSessionList, "filter": "all"})
	server.Dispatch(map[string]any{"v": VERSION, "t": InSessionList, "filter": "active"})

	want := []bool{true, true, false}
	if len(sawInclude) != len(want) {
		t.Fatalf("the summaries hook ran %d times, want %d", len(sawInclude), len(want))
	}
	for i := range want {
		if sawInclude[i] != want[i] {
			t.Errorf("call %d passed includeArchived=%v, want %v", i, sawInclude[i], want[i])
		}
	}
}

// TestAnUnknownFilterDoesNotChangeTheView: a typo must not silently hide sessions —
// the failure that cannot be recovered from the wire.
func TestAnUnknownFilterDoesNotChangeTheView(t *testing.T) {
	var out strings.Builder
	var sawInclude []bool
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		SessionSummaries: func(includeArchived bool) []map[string]any {
			sawInclude = append(sawInclude, includeArchived)
			return nil
		},
	})
	server.Attach(&archiveStub{})

	server.Dispatch(map[string]any{"v": VERSION, "t": InSessionList})
	server.Dispatch(map[string]any{"v": VERSION, "t": InSessionList, "filter": "archvied"})

	for i, got := range sawInclude {
		if !got {
			t.Errorf("call %d passed includeArchived=false after an unknown filter; the view must not change", i)
		}
	}
}

// TestTheListFilterIsRememberedForLaterResends is why the filter is stored rather
// than passed through: the list is re-sent after a delete and after an archive, and
// those answers must carry the same view — otherwise a just-hidden row reappears.
func TestTheListFilterIsRememberedForLaterResends(t *testing.T) {
	var out strings.Builder
	var sawInclude []bool
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		SessionSummaries: func(includeArchived bool) []map[string]any {
			sawInclude = append(sawInclude, includeArchived)
			return nil
		},
		ArchiveSession: func(id string, archived bool) error { return nil },
	})
	server.Attach(&archiveStub{})

	// The front end establishes the "active only" view.
	server.Dispatch(map[string]any{"v": VERSION, "t": InSessionList, "filter": "active"})
	// Then archives a session; the re-sent list must still be filtered.
	server.Dispatch(map[string]any{
		"v": VERSION, "t": InSessionArchive, "session_id": "s", "archived": true,
	})

	if len(sawInclude) != 2 {
		t.Fatalf("the summaries hook ran %d times, want 2", len(sawInclude))
	}
	if sawInclude[0] || sawInclude[1] {
		t.Errorf("resend passed includeArchived=%v, want false — the view must persist", sawInclude[1])
	}
}

// archiveTurnStub is a runtime whose turn the test holds in flight: RunTurn
// blocks on a channel the test closes, so a Dispatch that joins the turn can be
// observed to wait for it.
type archiveTurnStub struct {
	stubRuntime
	started chan struct{}
	release chan struct{}
}

func (r *archiveTurnStub) RunTurn(context.Context, string) (string, error) {
	select {
	case r.started <- struct{}{}:
	default:
	}
	<-r.release
	return "turn done", nil
}

// TestArchivingTheMountedSessionWaitsForTheTurn is the contract the delete path
// has always had (`Server.deleteSession` joins the turn), now on the archive
// side: the board's card menu sends `session_archive` through the *holder's own*
// connection, so the runtime is the one that has to keep the metadata rewrite
// off the appender — a turn in flight means the agent is appending to this same
// session file between steps. The hook runs only once that turn has settled.
func TestArchivingTheMountedSessionWaitsForTheTurn(t *testing.T) {
	var out strings.Builder
	archivedAt := make(chan struct{}, 1)
	server := NewServer(OpenStreams(strings.NewReader(""), &out), Bootstrap{
		ArchiveSession: func(id string, archived bool) error {
			archivedAt <- struct{}{}
			return nil
		},
	})
	stub := &archiveTurnStub{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	server.Attach(stub)

	server.startTurn("把重连修好")
	select {
	case <-stub.started:
	case <-time.After(5 * time.Second):
		t.Fatal("the turn never started")
	}

	// The archive request arrives while the turn is running. Dispatch cannot
	// return until the turn has (it joins the turn), so it runs on its own
	// goroutine and the ordering is asserted through the channels.
	done := make(chan struct{})
	go func() {
		server.Dispatch(map[string]any{
			"v": VERSION, "t": InSessionArchive, "session_id": "s", "archived": true,
		})
		close(done)
	}()

	select {
	case <-archivedAt:
		t.Fatal("the archive hook ran while the turn was still in flight")
	case <-time.After(100 * time.Millisecond):
	}

	// The turn settles, and only then is the metadata touched.
	close(stub.release)
	select {
	case <-archivedAt:
	case <-time.After(5 * time.Second):
		t.Fatal("the archive hook never ran after the turn settled")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the archive Dispatch never returned")
	}
	if got := len(sessionNotices(sentMessages(t, &out))); got < 1 {
		t.Errorf("sent %d session notices, want at least the archive confirmation", got)
	}
}
