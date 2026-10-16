package audit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// newTestSink builds a sink over a temporary directory.
func newTestSink(t *testing.T) (*JsonlSink, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "logs")
	sink, err := NewJsonlSink(dir)
	if err != nil {
		t.Fatalf("NewJsonlSink: %v", err)
	}
	t.Cleanup(func() { _ = sink.Close() })
	return sink, dir
}

// readLines reads a file as it is on disk right now, outside the sink.
//
// Deliberately `os.ReadFile` and not `sink.Read`: the promise under test is
// about what a *different* process would see after this one was killed, so the
// assertion must not go through the writer's own path.
func readLines(t *testing.T, path string) []string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile %s: %v", path, err)
	}
	var out []string
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) != "" {
			out = append(out, line)
		}
	}
	return out
}

// TestARecordIsOnDiskBeforeWriteReturns is the promise a resident handle must
// not weaken.
//
// The sink used to open, write and close per record, which made "on disk when
// Write returns" true by construction. Holding the handle open is what makes the
// write path cheap, and the way that change could silently break the audit trail
// is by introducing a userspace buffer — a reader in another process would then
// see fewer lines than were written, and only learn otherwise when 8KB happened
// to pile up.
//
// So this reads the file from outside the sink after **every** write. A buffer of
// any size fails it, which is the point: there is no size that would be
// acceptable here, because the contract is per record.
func TestARecordIsOnDiskBeforeWriteReturns(t *testing.T) {
	sink, dir := newTestSink(t)
	sessionID := "20260101-120000"
	path := filepath.Join(dir, sessionID+".jsonl")

	const records = 50
	for i := 0; i < records; i++ {
		rec := Event(KindModelCall, sessionID, "run-1", i, map[string]any{"status": "ok"})
		if err := sink.Write(rec); err != nil {
			t.Fatalf("Write %d: %v", i, err)
		}
		// After every single write, with no flush and no close.
		lines := readLines(t, path)
		if len(lines) != i+1 {
			t.Fatalf("after write %d the file holds %d lines, want %d — the record was buffered",
				i, len(lines), i+1)
		}
	}

	// And the bytes are the record, not a prefix of one.
	lines := readLines(t, path)
	var parsed map[string]any
	if err := json.Unmarshal([]byte(lines[records-1]), &parsed); err != nil {
		t.Fatalf("the last line is not a complete record: %v", err)
	}
	if parsed["kind"] != KindModelCall {
		t.Errorf("last record kind = %v, want %v", parsed["kind"], KindModelCall)
	}
}

// TestTheHandleIsReusedAcrossRecords pins the change itself.
//
// Without this, the previous implementation would satisfy every behavioural test
// in this file — it wrote the right bytes to the right file — while paying two
// syscalls per record. The descriptor is stable for a file that stays open, so
// comparing it across writes is what says the handle is resident.
func TestTheHandleIsReusedAcrossRecords(t *testing.T) {
	if runtime.GOOS == "windows" {
		// Windows can report a different handle for the same file object, so the
		// pointer comparison below is not portable evidence there. The behaviour
		// that matters is still covered by the on-disk test above.
		t.Skip("descriptor identity is not portable to windows")
	}

	sink, _ := newTestSink(t)
	sessionID := "20260101-120000"

	if err := sink.Write(Event(KindRunStarted, sessionID, "run-1", 0, nil)); err != nil {
		t.Fatalf("first Write: %v", err)
	}
	sink.mu.Lock()
	first := sink.file
	sink.mu.Unlock()
	if first == nil {
		t.Fatal("Write returned without holding a handle — the file was closed again")
	}

	for i := 1; i < 10; i++ {
		if err := sink.Write(Event(KindModelCall, sessionID, "run-1", i, nil)); err != nil {
			t.Fatalf("Write %d: %v", i, err)
		}
	}

	sink.mu.Lock()
	last := sink.file
	sink.mu.Unlock()
	if last == nil {
		t.Fatal("the handle was dropped between records")
	}
	if first.Fd() != last.Fd() {
		t.Errorf("the descriptor changed across records (%d -> %d); the file is being reopened per record",
			first.Fd(), last.Fd())
	}
}

// TestSwitchingSessionSwitchesTheFile: one sink serves whichever session the
// runtime is on, and a record must land in its own session's file. This is the
// case that still pays close+open, so it is worth pinning that it does the right
// thing rather than merely the fast thing.
func TestSwitchingSessionSwitchesTheFile(t *testing.T) {
	sink, dir := newTestSink(t)
	first := "20260101-120000"
	second := "20260102-130000"

	for i := 0; i < 3; i++ {
		if err := sink.Write(Event(KindModelCall, first, "run-a", i, nil)); err != nil {
			t.Fatalf("write to first: %v", err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := sink.Write(Event(KindModelCall, second, "run-b", i, nil)); err != nil {
			t.Fatalf("write to second: %v", err)
		}
	}
	// Back to the first session: the handle must be reopened, not reused.
	if err := sink.Write(Event(KindModelCall, first, "run-a", 3, nil)); err != nil {
		t.Fatalf("write back to first: %v", err)
	}

	if got := len(readLines(t, filepath.Join(dir, first+".jsonl"))); got != 4 {
		t.Errorf("first session has %d lines, want 4", got)
	}
	if got := len(readLines(t, filepath.Join(dir, second+".jsonl"))); got != 2 {
		t.Errorf("second session has %d lines, want 2", got)
	}

	// Every line names its own session, which is the field the log is read by.
	for _, line := range readLines(t, filepath.Join(dir, first+".jsonl")) {
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("unparseable line: %v", err)
		}
		if rec["session_id"] != first {
			t.Errorf("a line in %s names session %v", first, rec["session_id"])
		}
	}
}

// TestCloseReleasesTheHandleAndIsSafeTwice: the shutdown path calls this, and a
// double close must not panic or write to a recycled descriptor.
func TestCloseReleasesTheHandleAndIsSafeTwice(t *testing.T) {
	sink, _ := newTestSink(t)
	if err := sink.Write(Event(KindRunStarted, "20260101-120000", "run-1", 0, nil)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := sink.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	sink.mu.Lock()
	held := sink.file
	path := sink.path
	sink.mu.Unlock()
	if held != nil || path != "" {
		t.Errorf("Close left the sink holding a handle (file=%v path=%q)", held, path)
	}
	if err := sink.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

// TestASinkThatNeverWroteClosesCleanly: a runtime that starts and stops without
// recording anything still runs the shutdown path.
func TestASinkThatNeverWroteClosesCleanly(t *testing.T) {
	sink, _ := newTestSink(t)
	if err := sink.Close(); err != nil {
		t.Fatalf("Close on an unused sink: %v", err)
	}
}

// TestAWriteAfterCloseReopens: Close is the shutdown path's, not a tombstone.
// A record written afterwards must still land, because the alternative — a sink
// that silently stops recording once something closed it — loses audit events
// without saying so.
func TestAWriteAfterCloseReopens(t *testing.T) {
	sink, dir := newTestSink(t)
	sessionID := "20260101-120000"
	if err := sink.Write(Event(KindRunStarted, sessionID, "run-1", 0, nil)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := sink.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := sink.Write(Event(KindRunFinished, sessionID, "run-1", 1, nil)); err != nil {
		t.Fatalf("Write after Close: %v", err)
	}
	if got := len(readLines(t, filepath.Join(dir, sessionID+".jsonl"))); got != 2 {
		t.Errorf("after a write past Close the file has %d lines, want 2", got)
	}
}

// TestAnInvalidSessionIsRefusedWithoutTouchingTheHandle: the id is validated
// before the path is used, and a refused record must not disturb a good handle.
func TestAnInvalidSessionIsRefusedWithoutTouchingTheHandle(t *testing.T) {
	sink, dir := newTestSink(t)
	good := "20260101-120000"
	if err := sink.Write(Event(KindRunStarted, good, "run-1", 0, nil)); err != nil {
		t.Fatalf("Write: %v", err)
	}

	if err := sink.Write(Event(KindRunStarted, "../escape", "run-1", 1, nil)); err == nil {
		t.Fatal("a session id with a path separator was accepted")
	}

	// The good handle is still good.
	if err := sink.Write(Event(KindModelCall, good, "run-1", 2, nil)); err != nil {
		t.Fatalf("Write after a refused record: %v", err)
	}
	if got := len(readLines(t, filepath.Join(dir, good+".jsonl"))); got != 2 {
		t.Errorf("the good session has %d lines, want 2", got)
	}
}
