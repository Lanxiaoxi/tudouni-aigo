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
// Every record opens, writes and closes the file. That is one syscall sequence
// per event, and it is deliberate: a record is on disk the moment it is written,
// so the worst a killed process can lose is the half line it was in the middle
// of. Buffering would make "appended" mean "appended once 8KB have piled up",
// which is a different promise.
//
// Appending also means the audit log never grows in write cost with the length of
// the session, which is the whole reason a long session stays cheap.
type JsonlSink struct {
	mu   sync.Mutex
	dir  string
	path string
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

	s.mu.Lock()
	defer s.mu.Unlock()

	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(record); err != nil {
		return err
	}

	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(builder.String()); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

// Close releases whatever the sink is holding. Records are never buffered, so
// there is nothing to flush; the call exists so the runtime's shutdown path has
// a symmetrical shape.
func (s *JsonlSink) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file != nil {
		err := s.file.Close()
		s.file = nil
		return err
	}
	return nil
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

// AnyExists reports whether this sink holds at least one record.
func (s *JsonlSink) AnyExists() bool {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".jsonl") {
			return true
		}
	}
	return false
}
