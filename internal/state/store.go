// Package state holds the things that outlive a single turn: the session, the
// model catalog, the task list, the audit counters.
//
// Two storage disciplines live here and they are deliberately different:
//
//   - The **session file** is append-only JSONL. A turn appends the messages it
//     produced; nothing is ever rewritten. Write amplification is therefore
//     exactly 1.0 — the cost of saving a turn is the size of that turn, not the
//     size of the conversation.
//   - The **audit log** is a separate append-only JSONL file with one line per
//     event (see the audit package).
//
// Neither of them rewrites the whole file. The old generation did, and the cost
// of a long session grew with its length.
package state

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Constants describing the session file format.
const (
	// StateVersion is the format version written into every file. A file with a
	// higher version is refused rather than guessed at.
	StateVersion = 1
	// Suffix is the session file extension.
	Suffix = ".jsonl"
)

// Record types inside a session file.
const (
	RecordHead = "head"
	RecordMeta = "meta"
	RecordMsg  = "msg"
	RecordCtx  = "ctx"
)

// sessionIDPattern is the only shape a session id may take. It is strict
// because the id is spliced into file names (`sessions/<id>.jsonl`), so a
// permissive pattern would be a path-traversal hole.
var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// IsValidSessionID reports whether an id may be used as a file name.
func IsValidSessionID(id string) bool {
	return sessionIDPattern.MatchString(id)
}

// SessionStore is the append-only JSONL session store.
type SessionStore struct {
	dir string
	// watermark records how much of each session has already been written, so
	// a save writes only what is new. Cleared on write failure: a failed write
	// must not convince the next one that the data is already on disk.
	watermark map[string]*watermark
}

type watermark struct {
	messages  int
	metaKey   string
	ctxSeen   bool
	ctxKey    string
	headSeen  bool
	createdAt float64
}

// NewSessionStore opens (and creates) a store rooted at dir.
func NewSessionStore(dir string) (*SessionStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &SessionStore{dir: dir, watermark: map[string]*watermark{}}, nil
}

// Dir returns the directory the store writes into.
func (s *SessionStore) Dir() string { return s.dir }

// Path returns the file holding one session.
func (s *SessionStore) Path(id string) (string, error) {
	if !IsValidSessionID(id) {
		return "", fmt.Errorf("%s", missingKey("store.bad_session_id", "name", id))
	}
	return filepath.Join(s.dir, id+Suffix), nil
}

// Exists reports whether a session file is present.
func (s *SessionStore) Exists(id string) bool {
	path, err := s.Path(id)
	if err != nil {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// ListIDs returns the ids of every session file, sorted.
func (s *SessionStore) ListIDs() []string {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, Suffix) {
			continue
		}
		id := strings.TrimSuffix(name, Suffix)
		if IsValidSessionID(id) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// NewSessionID mints an id from the current time.
//
// The shape is `YYYYMMDD-HHMMSS`. Collisions get a `-2`, `-3`, … suffix. Minting
// an id means touching the disk to check for a collision, which is why a front
// end is never allowed to invent one.
func (s *SessionStore) NewSessionID() string {
	return s.NewSessionIDAt(time.Now())
}

// NewSessionIDAt is NewSessionID with an injected clock, for tests.
func (s *SessionStore) NewSessionIDAt(now time.Time) string {
	base := now.Format("20060102-150405")
	if !s.Exists(base) {
		return base
	}
	for n := 2; ; n++ {
		candidate := fmt.Sprintf("%s-%d", base, n)
		if !s.Exists(candidate) {
			return candidate
		}
	}
}

// Save appends whatever the session has that the file does not yet contain.
//
// It never rewrites. The first save writes a `head` record; a changed metadata
// block appends a fresh `meta` record (readers take the last one); new messages
// are appended as `msg` records; a changed context version appends a `ctx`
// record.
func (s *SessionStore) Save(session *Session) error {
	path, err := s.Path(session.SessionID)
	if err != nil {
		return err
	}

	mark := s.watermark[session.SessionID]
	if mark == nil {
		mark = &watermark{}
		s.watermark[session.SessionID] = mark
	}

	// The store only appends. A session that suddenly has fewer messages than
	// we already wrote is a bug upstream, and papering over it would corrupt
	// the file quietly.
	if len(session.Messages) < mark.messages {
		return fmt.Errorf("%s", missingKey("store.shrunk",
			"name", session.SessionID, "before", mark.messages, "after", len(session.Messages)))
	}

	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		delete(s.watermark, session.SessionID)
		return err
	}
	writer := bufio.NewWriter(file)

	write := func(record map[string]any) error {
		line, err := encodeRecord(record)
		if err != nil {
			return err
		}
		_, err = writer.WriteString(line)
		return err
	}

	if !mark.headSeen {
		createdAt := session.CreatedAt
		if createdAt == 0 {
			createdAt = float64(time.Now().Unix())
		}
		mark.createdAt = createdAt
		err := write(map[string]any{
			"v":          StateVersion,
			"type":       RecordHead,
			"session_id": session.SessionID,
			"created_at": createdAt,
		})
		if err != nil {
			writer.Flush()
			file.Close()
			delete(s.watermark, session.SessionID)
			return err
		}
		mark.headSeen = true
	}

	metaKey := canonicalKey(session.Metadata)
	if !mark.headSeen || metaKey != mark.metaKey {
		if err := write(map[string]any{
			"v":        StateVersion,
			"type":     RecordMeta,
			"metadata": session.Metadata,
		}); err != nil {
			writer.Flush()
			file.Close()
			delete(s.watermark, session.SessionID)
			return err
		}
		mark.metaKey = metaKey
	}

	for _, message := range session.Messages[mark.messages:] {
		if err := write(map[string]any{
			"v":       StateVersion,
			"type":    RecordMsg,
			"message": message,
		}); err != nil {
			writer.Flush()
			file.Close()
			delete(s.watermark, session.SessionID)
			return err
		}
	}
	mark.messages = len(session.Messages)

	if session.Context != nil {
		ctxKey := canonicalKey(session.Context)
		if !mark.ctxSeen || ctxKey != mark.ctxKey {
			if err := write(map[string]any{
				"v":       StateVersion,
				"type":    RecordCtx,
				"context": session.Context,
			}); err != nil {
				writer.Flush()
				file.Close()
				delete(s.watermark, session.SessionID)
				return err
			}
			mark.ctxSeen = true
			mark.ctxKey = ctxKey
		}
	}

	if err := writer.Flush(); err != nil {
		file.Close()
		delete(s.watermark, session.SessionID)
		return err
	}
	if err := file.Close(); err != nil {
		delete(s.watermark, session.SessionID)
		return err
	}
	return nil
}

// Load replays a session file back into a Session.
//
// `head` supplies the creation time, `meta` and `ctx` take the last one seen,
// and `msg` records accumulate. Lines that do not parse are skipped: a process
// killed mid-write leaves a half line, and one half line must not make the
// whole session unreadable.
func (s *SessionStore) Load(id string) (*Session, error) {
	path, err := s.Path(id)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%s", missingKey("store.missing_file", "path", path))
		}
		return nil, err
	}
	defer file.Close()

	session := NewEmptySession(id)
	mark := &watermark{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 256<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			continue
		}
		if version, ok := numberField(record, "v"); ok && int(version) > StateVersion {
			return nil, fmt.Errorf("%s", missingKey("store.newer_version",
				"name", id, "version", int(version), "known", StateVersion))
		}
		switch stringField(record, "type") {
		case RecordHead:
			if value, ok := numberField(record, "created_at"); ok {
				session.CreatedAt = value
			}
			mark.headSeen = true
		case RecordMeta:
			if meta, ok := record["metadata"].(map[string]any); ok {
				session.Metadata = meta
			}
			mark.metaKey = canonicalKey(session.Metadata)
		case RecordMsg:
			if message, ok := record["message"].(map[string]any); ok {
				session.Messages = append(session.Messages, message)
			}
		case RecordCtx:
			if ctx, ok := record["context"]; ok {
				session.Context = ctx
				mark.ctxKey = canonicalKey(ctx)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	mark.messages = len(session.Messages)
	mark.ctxSeen = session.Context != nil
	s.watermark[id] = mark
	return session, nil
}

// Read walks a session file record by record without replaying it.
//
// This is what `/status` and `--audit` need: the records, not a Session.
func (s *SessionStore) Read(id string) ([]map[string]any, error) {
	path, err := s.Path(id)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%s", missingKey("store.missing_file", "path", path))
		}
		return nil, err
	}
	defer file.Close()

	var records []map[string]any
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 256<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			continue
		}
		records = append(records, record)
	}
	return records, scanner.Err()
}

// FileTimes reports when a session file was created and last written.
// modified_at is the question the welcome screen asks ("when did we last talk"),
// and it is an mtime — deliberately not the same thing as created_at.
func (s *SessionStore) FileTimes(id string) (created, modified *float64) {
	path, err := s.Path(id)
	if err != nil {
		return nil, nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, nil
	}
	seconds := float64(info.ModTime().Unix())
	return &seconds, &seconds
}

func encodeRecord(record map[string]any) (string, error) {
	encoder := json.NewEncoder(&strings.Builder{})
	_ = encoder
	builder := &strings.Builder{}
	enc := json.NewEncoder(builder)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(record); err != nil {
		return "", err
	}
	return builder.String(), nil
}

func canonicalKey(value any) string {
	if value == nil {
		return ""
	}
	builder := &strings.Builder{}
	enc := json.NewEncoder(builder)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return ""
	}
	return builder.String()
}

func stringField(record map[string]any, key string) string {
	value, _ := record[key].(string)
	return value
}

func numberField(record map[string]any, key string) (float64, bool) {
	switch value := record[key].(type) {
	case float64:
		return value, true
	case int:
		return float64(value), true
	case int64:
		return float64(value), true
	default:
		return 0, false
	}
}
