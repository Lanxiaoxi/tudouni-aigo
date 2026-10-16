// Package audit is the execution trail.
//
// The interesting question about an agent run is never the final answer — it is
// the whole path that produced it. So every model call, tool call, permission
// verdict and turn boundary is written down as one JSON object per line, and the
// protocol forwards those same lines to the front end unchanged. "The audit log
// is the protocol" is true at the byte level: whatever `--audit` can show, the
// interface can show, and the two can never disagree.
package audit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
)

// Event kinds.
const (
	KindRunStarted       = "run_started"
	KindRunFinished      = "run_finished"
	KindModelCall        = "model_call"
	KindToolCall         = "tool_call"
	KindToolResult       = "tool_result"
	KindToolBatch        = "tool_batch"
	KindPermission       = "permission"
	KindDeltaReset       = "delta_reset"
	KindContextDegraded  = "context_degraded"
	KindContextCompacted = "context_compacted"
	// KindGoalRound records the driver's decision about one automatic round:
	// queued, or skipped with the reason and the disarm that followed.
	//
	// It is a separate kind from a goal *change* on purpose. "The model redefined
	// the objective" and "the loop decided to keep going" are answers to different
	// questions, and merging them would make "--audit" unable to say whether an
	// autonomous loop ever actually ran.
	KindGoalRound = "goal_round"
	// KindImageAttached records one picture entering a session's context, or one
	// that was named and not attached.
	//
	// It is a kind of its own rather than a `tool_call`, because the picture was
	// not produced by a tool the model chose — the user named a file and the
	// runtime picked it up. Reading it back, "which pictures did this session
	// carry, and what happened to the ones that did not make it" is a question
	// about the context, and it has to be answerable without inferring it from
	// artifact types.
	//
	// The same kind carries the refusals and the skips, discriminated by `status`:
	// "attached", "skipped", "over_limit", "refused". One kind with a status field
	// is deliberate — the four are one event ("a picture was named") with four
	// outcomes, and splitting them would make a reader merge three of them back
	// together to count how many were named at all.
	KindImageAttached = "image_attached"
)

// Event builds one audit record with the fields every record carries.
//
// `session_id` is on every line rather than inferred from the file name: logs get
// copied and spliced together, and a line that cannot say which session it came
// from is a line that cannot be used.
//
// Everything passed in `data` must be plain JSON — strings, numbers, booleans,
// slices, maps. No timestamps, no paths, no errors: those would blow up at
// serialisation time, on the write path, where the least can be done about it.
func Event(kind, sessionID, runID string, step int, data map[string]any) map[string]any {
	record := map[string]any{
		"ts":         time.Now().Format("2006-01-02T15:04:05.000"),
		"kind":       kind,
		"session_id": sessionID,
		"run_id":     runID,
		"step":       step,
	}
	for key, value := range data {
		record[key] = value
	}
	return record
}

// JsonlSink appends audit records to `<dir>/<session_id>.jsonl`.
//
// **A record is on disk the moment it is written.** That is the promise this type
// exists to keep: the worst a killed process can lose is the half line it was in
// the middle of. Nothing here is ever buffered, and that is a property to
// preserve rather than a coincidence — `os.File` has no userspace buffer, so a
// `Write` is the syscall.
//
// What is *not* kept is the handle. This used to open, write and close **per
// record**, which paid an `open`/`close` pair for every event and left the
// record's own bytes as the smallest part of the cost. Benchmarked on Windows
// (BenchmarkWriteResident against BenchmarkWriteOpenClosePerRecord), one
// record went from ~600us to ~26us — the open is nearly all of it, because the
// file-open path runs through the filter drivers. The handle is now held open and
// reused, so a record costs one `write` and nothing else, and the durability
// promise is untouched because a resident handle does not buffer anything either.
//
// The handle is keyed to the path it was opened for, so a session switch closes
// the old file and opens the new one. That is the one case that still pays the
// pair, and it is once per switch rather than once per event.
//
// Appending also means the audit log never grows in write cost with the length of
// the session, which is the whole reason a long session stays cheap.
type JsonlSink struct {
	mu   sync.Mutex
	dir  string
	path string
	// file is the open handle for `path`. An empty `path` means no handle is
	// held; the two are only ever set and cleared together, under `mu`.
	file *os.File
}

// NewJsonlSink opens (and creates) the directory.
func NewJsonlSink(dir string) (*JsonlSink, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &JsonlSink{dir: dir}, nil
}

// Dir returns the directory records are written into.
func (s *JsonlSink) Dir() string { return s.dir }

// Path returns where one session's audit log lives.
func (s *JsonlSink) Path(sessionID string) (string, error) {
	if !state.IsValidSessionID(sessionID) {
		return "", errInvalidSessionID(sessionID)
	}
	return filepath.Join(s.dir, sessionID+".jsonl"), nil
}

// Write appends one record. A failure is reported to the caller, which swallows
// it: observation must never be able to affect what is being observed.
func (s *JsonlSink) Write(record map[string]any) error {
	sessionID, _ := record["session_id"].(string)
	path, err := s.Path(sessionID)
	if err != nil {
		return err
	}

	// Encoded before the lock: the encoding does not touch the handle, and
	// keeping it outside means a slow marshal does not serialise other writers.
	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(record); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	file, err := s.handleLocked(path)
	if err != nil {
		return err
	}
	// One `write` syscall, and the record is in the kernel's hands. No `Sync`:
	// the per-record close this replaced did not fsync either, so "killed with
	// `kill -9` loses only the half line in flight" means the same thing before
	// and after this change.
	//
	// A failed write drops the handle rather than keeping it. The file it points
	// at may be the reason the write failed (a deleted directory, a full disk),
	// and holding a handle that cannot be written to would turn one transient
	// failure into every later record failing the same way — where reopening at
	// least gives the next record its own chance.
	if _, err := file.WriteString(builder.String()); err != nil {
		s.dropHandleLocked()
		return err
	}
	return nil
}

// handleLocked returns the open file for `path`, opening it if the held one
// belongs to another session.
//
// The caller holds `s.mu`.
func (s *JsonlSink) handleLocked(path string) (*os.File, error) {
	if s.file != nil && s.path == path {
		return s.file, nil
	}
	// A different session, so the previous handle is finished with. Its close
	// error is not reported: it says nothing about whether this record landed,
	// and the caller treats any error here as "the record was not written" —
	// which a failed close of the *previous* file would misreport.
	s.dropHandleLocked()

	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	s.file = file
	s.path = path
	return file, nil
}

// dropHandleLocked releases the held handle, if any. The caller holds `s.mu`.
//
// The error is deliberately discarded — see `handleLocked`. `os.File.Close`
// closes the descriptor even when it reports an error, so clearing the fields
// unconditionally is right: the handle is gone either way, and a field left
// pointing at it would be a handle that cannot be written to and cannot be
// dropped.
func (s *JsonlSink) dropHandleLocked() {
	if s.file != nil {
		_ = s.file.Close()
	}
	s.file = nil
	s.path = ""
}

// Close releases the held file handle.
//
// Records are never buffered, so there is nothing to flush; the call exists so
// the runtime's shutdown path can let go of the descriptor rather than leaving it
// to process exit. It is safe to call more than once, and safe to call on a sink
// that never wrote anything.
func (s *JsonlSink) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file == nil {
		return nil
	}
	file := s.file
	s.file = nil
	s.path = ""
	return file.Close()
}

// Read returns a session's audit records.
//
// Lines that do not parse are skipped. A process killed mid-write leaves half a
// line behind, and that is a designed-for condition: one half line must not make
// the whole log unreadable.
func (s *JsonlSink) Read(sessionID string) ([]map[string]any, error) {
	path, err := s.Path(sessionID)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var records []map[string]any
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			continue
		}
		records = append(records, record)
	}
	return records, nil
}
