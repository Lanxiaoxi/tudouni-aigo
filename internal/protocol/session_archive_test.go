package protocol

import (
	"strings"
	"testing"
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
