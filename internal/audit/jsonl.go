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
	"bytes"
	"encoding/json"
	"io"
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
	// KindMemoryRecall records one automatic retrieval from workspace memory: which
	// trigger fired, what was asked, and which memories came back.
	//
	// It is an audit kind rather than nothing at all because "why did the model know
	// that" is a question about a run, and the answer has to live where the run is
	// read back. The bodies do **not** travel here — the ids do, and the files are
	// still on disk: copying a memory into the log would make the log a second copy of
	// the corpus, the same rule `context_compacted` follows for summaries.
	KindMemoryRecall = "memory_recall"
	// KindHookResult records one execution of one user-configured hook.
	//
	// One line per invocation, never one per event: a chain of four hooks is four
	// processes with four durations, and a single merged line would hide the one
	// that timed out behind the three that worked. `status` is the vocabulary that
	// makes a broken hook distinguishable from a refusing one.
	//
	// The hook's reason travels as a 200-character preview and its injected context
	// as a length only — the same rule `memory_recall` and `tool_result` follow, for
	// the same reason: an audit log that copies what a conversation contained is a
	// log nobody can hand to anybody.
	KindHookResult = "hook_result"
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

	// readMu guards the read-side cache. It is deliberately not `mu`: a read
	// never touches the write handle, and making a status panel wait behind an
	// in-flight append would put the log's writer in the reader's latency path.
	readMu sync.Mutex
	reads  map[string]*readCache
}

// readCache is how much of one session's log has already been parsed.
//
// The file is append-only, so a reader never needs to look at a byte it has
// already seen. Before this cache `Read` was called once per turn to draw the
// status line and once per status request, and each call re-read and re-parsed
// the whole session — cost that grows with the conversation while the answer
// changes only in its last record.
type readCache struct {
	size    int64
	records []map[string]any

	// The derived views below are kept because both are asked for on the turn's
	// own path, from the same records, and computing either one from scratch is
	// another walk over the session. They are maintained here rather than by the
	// callers for the reason this whole type exists: one walk, one answer.
	//
	// `counter` is the `/status` ledger, and `timing` is the last turn's wall-time
	// breakdown; `runID` and `runMs` are what `lastTurnMs` pairs up. Every one of
	// them is a fold over the records, so appending a record and folding it in is
	// exactly what recomputation would produce.
	counter state.Counter
	timing  timingCounts
	runID   string
	runMs   int64
	hasRun  bool
	// hasFinish distinguishes "the current turn finished, in runMs" from "the
	// current turn is still running or died" — see `add`.
	hasFinish bool
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
//
// Only the bytes appended since the previous call are read. The log is
// append-only, so the cache can never describe a record that is no longer in the
// file; a size that went backwards (a truncated or replaced file) is the one case
// that resets it.
func (s *JsonlSink) Read(sessionID string) ([]map[string]any, error) {
	path, err := s.Path(sessionID)
	if err != nil {
		return nil, err
	}

	s.readMu.Lock()
	defer s.readMu.Unlock()
	if s.reads == nil {
		s.reads = make(map[string]*readCache)
	}
	cache := s.reads[sessionID]
	if cache == nil {
		cache = &readCache{}
		s.reads[sessionID] = cache
	}

	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			*cache = readCache{}
			return nil, nil
		}
		return nil, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	// A size that went backwards is a truncated or replaced file, and everything
	// derived from the old bytes is now describing something that is not there.
	if info.Size() < cache.size {
		*cache = readCache{}
	}
	if info.Size() == cache.size {
		return snapshotRecords(cache.records), nil
	}
	if _, err := file.Seek(cache.size, io.SeekStart); err != nil {
		return nil, err
	}
	chunk := make([]byte, info.Size()-cache.size)
	if _, err := io.ReadFull(file, chunk); err != nil {
		return nil, err
	}
	// A partial last line is not an error and is not skipped for good: it is the
	// half line a killed process leaves, and it becomes readable the moment the
	// rest of it is written. Consuming only up to the last newline is what makes
	// the next call resume in the right place.
	end := bytes.LastIndexByte(chunk, '\n')
	if end < 0 {
		return snapshotRecords(cache.records), nil
	}
	for _, line := range strings.Split(string(chunk[:end+1]), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			continue
		}
		cache.add(record)
	}
	cache.size += int64(end + 1)
	return snapshotRecords(cache.records), nil
}

// Summary is `Read` plus the two derived views, computed incrementally.
//
// It exists so a caller that only wants the numbers does not pay for the record
// list as well. The `/status` panel and the line REPL's end-of-turn report both
// ask for exactly these, on the turn's own goroutine, once per turn — and both
// used to walk the whole session's records to get them.
//
// The answers are the same ones the slice-based functions give over the same
// records: `state.Summarize`, `SummarizeTime` over the last turn, and that turn's
// total. That is not a coincidence to be preserved by hand — the folds live in
// `readCache.add`, which is the only place a record enters.
func (s *JsonlSink) Summary(sessionID string) (map[string]any, Timing, bool) {
	view, _ := s.summaryOf(sessionID)
	if view == nil {
		return state.Summarize(nil), Timing{}, false
	}
	return view.counter.Result(), view.timing.timing(), view.hasRun
}

// LastTurnMs is the wall time of the most recent turn, paired by run id.
//
// Paired rather than "the last `run_finished` line": when a turn dies before it
// finishes (Ctrl+C, a killed process) the last such line belongs to the
// *previous* turn, and reporting it as "this turn" gives a number that is
// completely unrelated and completely plausible.
//
// It reports nothing for a turn that has not finished, for the same reason.
func (s *JsonlSink) LastTurnMs(sessionID string) (int64, bool) {
	view, _ := s.summaryOf(sessionID)
	if view == nil || !view.hasFinish {
		return 0, false
	}
	return view.runMs, true
}

// summaryView is the cache's folded state, copied out for a caller.
//
// It is a copy rather than a pointer because the caller reads it after the lock is
// dropped, and the next `Read` on another goroutine may be extending the cache at
// that moment. Every field above is a value type, so a copy is the fold itself.
type summaryView struct {
	counter   state.Counter
	timing    timingCounts
	runMs     int64
	hasRun    bool
	hasFinish bool
}

// summaryOf brings the cache up to date and copies its folded state out.
func (s *JsonlSink) summaryOf(sessionID string) (*summaryView, error) {
	// `Read` does the file work and holds the lock for all of it, including the
	// folds; this then takes the lock once more only to copy the values out.
	if _, err := s.Read(sessionID); err != nil {
		return nil, err
	}
	s.readMu.Lock()
	defer s.readMu.Unlock()
	cache := s.reads[sessionID]
	if cache == nil {
		return nil, nil
	}
	return &summaryView{
		counter:   cache.counter,
		timing:    cache.timing,
		runMs:     cache.runMs,
		hasRun:    cache.hasRun,
		hasFinish: cache.hasFinish,
	}, nil
}

// add folds one parsed record into the cache: the record list and the views
// derived from it.
//
// This is the single place a record enters, which is what keeps the views honest:
// there is no path that appends to `records` and forgets to update a counter.
func (c *readCache) add(record map[string]any) {
	c.records = append(c.records, record)
	c.counter.Add(record)

	// The turn-scoped views restart at every `run_started`, because what they
	// describe is one turn rather than the session. That is the difference between
	// this and `counter` above: the ledger is cumulative, the timing is the last
	// turn's own.
	if stringOf(record["kind"]) == KindRunStarted {
		if id := stringOf(record["run_id"]); id != "" {
			c.runID, c.hasRun, c.hasFinish, c.runMs = id, true, false, 0
			c.timing = timingCounts{}
		}
		return
	}
	// Records outside the current turn contribute nothing to it. A log copied from
	// elsewhere can hold records whose `run_id` nobody started, and folding those
	// in would make the turn's buckets describe more than the turn.
	if !c.hasRun || stringOf(record["run_id"]) != c.runID {
		return
	}
	c.timing.add(record)

	if stringOf(record["kind"]) == KindRunFinished {
		// `hasFinish` rather than a zero total: "the turn finished in 0ms" and "the
		// turn never finished" are different claims, and only the first one may be
		// reported as a duration. A turn killed before its last record is the
		// common case for the second, and attributing the *previous* turn's total
		// to it is the failure this pairing exists to prevent.
		if value, present := record["duration_ms"]; present && value != nil {
			c.runMs, c.hasFinish = int64(numberOf(value)), true
		}
	}
}

// snapshotRecords copies the slice header but not the records.
//
// The records themselves are written once and only read afterwards, so sharing
// them is safe; the copy is what stops a caller from appending into the cache.
func snapshotRecords(records []map[string]any) []map[string]any {
	if len(records) == 0 {
		return nil
	}
	out := make([]map[string]any, len(records))
	copy(out, records)
	return out
}
