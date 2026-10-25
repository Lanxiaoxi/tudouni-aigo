// Package usage is the cross-workspace usage ledger.
//
// The audit log answers "what happened in this session" for the one workspace
// its file lives in. This package answers the question the audit log cannot:
// how much has this user's work spent, across every workspace, over time. It is
// the data behind the desktop's usage panel — the cumulative tokens, the busiest
// day, the active-day streaks, and the per-day activity the heatmap draws.
//
// The ledger is one append-only JSONL file in the user's config directory
// (`~/.tudouni/usage.jsonl`, beside `config.json`). Home rather than workspace
// is the whole point: a workspace's `.tudouni` is deleted with the workspace,
// and "how much did I spend this month" has to survive that.
//
// One record per **finished turn that made at least one successful model call**,
// appended when the turn's `run_finished` audit record passes by. The token
// numbers are folded from the turn's own `model_call` records — the same
// records, gated the same way (`status == "ok"`), that `state.Counter` folds
// for `/status`, so the two can never disagree about what a token is. Subagents
// need no special rule: a child's calls are real calls that reach the same
// `onEvent` (see `subagent.Tool.childSink`), so every API call is counted
// exactly once, and the parent's `delegation_finished` summary — which exists
// so the audit log's readers need not open child logs — is never used here.
//
// Like the audit sink, a failed write is swallowed by the caller's contract:
// an observation failure must never damage the turn being observed. The worst
// a killed process can lose is the turn it died in, whose fold lived only in
// memory; the audit log still carries that turn's records.
package usage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
)

// FileVersion is the ledger record's own version, distinct from the protocol's:
// the file is read by future binaries that may never have spoken this protocol.
const FileVersion = 1

// KindRun is the one record kind the file holds today. A kind field on a
// single-kind file looks redundant until the first day a per-call or per-day
// record wants to share the file — then every old line already says what it is.
const KindRun = "run"

// timeLayout is the audit log's own timestamp layout: local time, no zone.
// The ledger keeps it so a record's day is the calendar day the user was on.
const timeLayout = "2006-01-02T15:04:05.000"

// maxPending bounds the folds of turns that started but never finished. A turn
// whose `run_finished` never arrives (killed process, dropped child) would
// otherwise hold its fold forever. Real concurrency is one foreground turn plus
// the background delegations, so 64 is far above anything reachable; the
// oldest fold is dropped, and with it that turn's tokens.
const maxPending = 64

// Ledger folds audit records into per-turn rows and appends them to the file.
//
// It is written to from `onEvent` — the one place every audit record of this
// process passes, whatever session or subagent produced it — and read from the
// protocol handler. Writer and reader share nothing: the reader opens the file
// itself (see `Aggregate`), because an append-only file needs no lock to be
// read safely while it grows.
type Ledger struct {
	mu   sync.Mutex
	path string
	// file is the resident handle. An unbuffered append per record keeps the
	// durability promise the audit sink makes — a killed process loses only the
	// half line in flight — so nothing here is ever buffered either.
	file *os.File

	// pending holds the folds of turns in flight, keyed by run id. `fifo`
	// preserves their arrival order so the eviction above can drop the oldest.
	pending map[string]*fold
	fifo    []string
}

// fold is one unfinished turn's running total. It carries no session or run id:
// the finished record arriving on `run_finished` has both, and the fold only
// needs to answer "what did this turn spend".
type fold struct {
	prompt, cached, miss, completion int
	modelMs                          int64
	calls                            int
	// model is the last successful call's model. A turn can be routed to more
	// than one model; the last one is the one that answered it, and a row
	// carrying no model at all is worth less than one carrying an approximate.
	model string
}

// LedgerPath is where the ledger lives: beside `config.json`, in the directory
// `TUDOUNI_HOME` can relocate for tests and portable installs.
func LedgerPath() string {
	return filepath.Join(paths.UserConfigDir(), "usage.jsonl")
}

// NewLedger opens the ledger for appending. The directory is created here
// rather than on first append so a misconfigured home is reported once, at
// boot, instead of silently dropping every turn's row.
func NewLedger(path string) (*Ledger, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	return &Ledger{path: path, pending: make(map[string]*fold)}, nil
}

// Path returns the file rows are appended to.
func (l *Ledger) Path() string { return l.path }

// Report folds the ledger as it stands now into the panel's numbers. It reads
// the file rather than any in-memory state — the fold on disk is the only one
// that also knows what this process's predecessors wrote.
func (l *Ledger) Report() (Report, error) {
	return Aggregate(l.path, time.Now())
}

// Observe folds one audit record in. It never fails and never returns: a
// ledger that cannot be written must not be able to break the turn that is
// feeding it.
func (l *Ledger) Observe(record map[string]any) {
	switch stringOf(record["kind"]) {
	case "model_call":
		// The same gate `state.Counter` applies: a failed attempt in a retry
		// chain carries no usage fields, and counting it would drag every rate
		// and total toward nothing.
		if stringOf(record["status"]) != "ok" {
			return
		}
		runID := stringOf(record["run_id"])
		if runID == "" {
			return
		}
		l.mu.Lock()
		f := l.foldFor(runID)
		f.prompt += intOf(record["prompt_tokens"])
		f.cached += intOf(record["cached_tokens"])
		f.miss += intOf(record["miss_tokens"])
		f.completion += intOf(record["completion_tokens"])
		f.modelMs += int64Of(record["duration_ms"])
		f.calls++
		if model := stringOf(record["model"]); model != "" {
			f.model = model
		}
		l.mu.Unlock()

	case "run_finished":
		runID := stringOf(record["run_id"])
		if runID == "" {
			return
		}
		durationMs := int64Of(record["duration_ms"])
		ts := stringOf(record["ts"])
		// The fold is taken out and the lock dropped before the file work: the
		// append is the slow part, and holding the fold map through it would
		// serialise every concurrent turn's records behind one write.
		l.mu.Lock()
		f := l.pending[runID]
		delete(l.pending, runID)
		l.forget(runID)
		l.mu.Unlock()
		// A turn with no successful call contributes nothing — not even a row
		// with zeros. "This turn ran" is the audit log's fact to carry; the
		// ledger's is "this turn spent".
		if f == nil || f.calls == 0 {
			return
		}
		l.append(runRow(record, f, durationMs, ts))
	}
}

// Close releases the resident handle. Records are never buffered, so there is
// nothing to flush; like `audit.JsonlSink.Close`, a later Observe simply
// reopens the file.
func (l *Ledger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return nil
	}
	file := l.file
	l.file = nil
	return file.Close()
}

// foldFor returns the fold for runID, creating it — and starting its eviction
// clock — on first sight. The caller holds `l.mu`.
func (l *Ledger) foldFor(runID string) *fold {
	f := l.pending[runID]
	if f != nil {
		return f
	}
	f = &fold{}
	l.pending[runID] = f
	l.fifo = append(l.fifo, runID)
	for len(l.pending) > maxPending {
		oldest := l.fifo[0]
		l.fifo = l.fifo[1:]
		delete(l.pending, oldest)
	}
	return f
}

// forget drops runID's eviction-clock entry once its fold has been taken. The
// caller holds `l.mu`.
func (l *Ledger) forget(runID string) {
	for i, id := range l.fifo {
		if id == runID {
			l.fifo = append(l.fifo[:i], l.fifo[i+1:]...)
			return
		}
	}
}

// runRow builds the file record for one finished turn.
//
// `ts` is the `run_finished` record's own timestamp, kept verbatim: the day a
// turn lands on is the day the user was on when it finished, not the day a
// reader happened to parse it.
func runRow(finished map[string]any, f *fold, durationMs int64, ts string) map[string]any {
	if ts == "" {
		ts = time.Now().Format(timeLayout)
	}
	row := map[string]any{
		"v":           FileVersion,
		"kind":        KindRun,
		"ts":          ts,
		"session_id":  stringOf(finished["session_id"]),
		"run_id":      stringOf(finished["run_id"]),
		"prompt":      f.prompt,
		"cached":      f.cached,
		"miss":        f.miss,
		"completion":  f.completion,
		"model_ms":    f.modelMs,
		"duration_ms": durationMs,
		"calls":       f.calls,
	}
	if f.model != "" {
		row["model"] = f.model
	}
	return row
}

// append marshals and writes one row. Both the marshal (outside the lock) and
// the write (inside it) swallow their errors: the ledger's only promise to its
// caller is that it cannot fail.
func (l *Ledger) append(row map[string]any) {
	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(row); err != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		file, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return
		}
		l.file = file
	}
	// One write, and the row is in the kernel's hands. A failed write drops the
	// handle for the same reason the audit sink drops its: the file may be why
	// the write failed, and a handle that cannot be written would turn one
	// transient failure into every later row failing the same way.
	if _, err := l.file.WriteString(builder.String()); err != nil {
		_ = l.file.Close()
		l.file = nil
	}
}

// stringOf extracts a string field, tolerating any JSON type.
func stringOf(value any) string {
	text, _ := value.(string)
	return text
}

// intOf extracts an int field. A missing or malformed field counts as zero,
// the same rule `state.Counter` applies to a log that may be copied or spliced.
func intOf(value any) int {
	switch n := value.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	default:
		return 0
	}
}

// int64Of is intOf for the duration fields.
func int64Of(value any) int64 {
	switch n := value.(type) {
	case float64:
		return int64(n)
	case int:
		return int64(n)
	case int64:
		return n
	default:
		return 0
	}
}
