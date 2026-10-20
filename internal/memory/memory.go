package memory

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/paths"
)

// Workspace is the memory subsystem for one workspace: the single entrance every
// caller goes through.
//
// It holds the config, the derived index and the reported problems, and it owns the
// lock that serialises writes — that is, it is the object the design calls
// `WorkspaceMemory`, and the smaller files beside it are its parts rather than
// alternatives to it.
type Workspace struct {
	root string
	repo *repository

	mu     sync.Mutex
	cfg    Config
	index  *Index
	status IndexStatus
	// problems accumulate everything the open found wrong. They are reported once,
	// through `Problem`, and they never stop a memory operation from being tried:
	// a broken index file is repaired, a broken config falls back to defaults.
	problems []string

	// checkedAt throttles the staleness probe. Comparing modification times is how an
	// edit made outside this program is noticed, and doing it on every retrieval
	// would stat the whole directory several times per step.
	checkedAt time.Time
}

// StaleCheckInterval is how often the entry directory is compared against the index.
//
// Two seconds is short enough that anything a person does to a file is visible by
// the time they look at the panel, and long enough that a turn's handful of
// retrievals costs one directory scan rather than one per query.
const StaleCheckInterval = 2 * time.Second

// Open prepares a workspace's memory.
//
// An error means "there is nowhere to put memory" — a directory that cannot be
// created. Everything else is a problem reported by `Problem()`: the design is
// explicit that memory being unusable must not stop a session, so the caller gets a
// usable object in every other case.
func Open(workspaceDir string) (*Workspace, error) {
	root := filepath.Join(workspaceDir, paths.RuntimeDirName, DirName)
	repo := newRepository(root)
	if err := repo.ensureDirs(); err != nil {
		return nil, err
	}

	workspace := &Workspace{root: root, repo: repo}
	config, configProblem := loadConfig(repo)
	workspace.cfg = config
	if configProblem != "" {
		workspace.problems = append(workspace.problems, configProblem)
	}

	index, status, indexProblem := loadIndex(repo)
	workspace.index = index
	workspace.status = status
	if indexProblem != "" {
		workspace.problems = append(workspace.problems, indexProblem)
	}
	workspace.checkedAt = time.Now()
	return workspace, nil
}

// Root is the memory directory, for the panel's "where is this" line.
func (w *Workspace) Root() string { return w.root }

// Enabled reports the master switch.
func (w *Workspace) Enabled() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.cfg.Enabled
}

// Config returns the config in force.
func (w *Workspace) Config() Config {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.cfg
}

// Problem returns everything the open found wrong, as one sentence, or "".
func (w *Workspace) Problem() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return strings.Join(w.problems, "; ")
}

// noteProblem records something that went wrong without making it fatal.
func (w *Workspace) noteProblem(format string, args ...any) {
	w.problems = append(w.problems, fmt.Sprintf(format, args...))
}

// SaveConfig replaces the config.
//
// The caller supplies a whole struct rather than a patch, because the panel edits a
// form and "these are the settings now" is one statement; a patch protocol would
// need a field-presence rule for every knob and would eventually be wrong about
// `false`.
func (w *Workspace) SaveConfig(config Config) (Config, []string, error) {
	normalised, notes := config.Normalise()
	normalised.Version = ConfigVersion

	w.mu.Lock()
	defer w.mu.Unlock()
	if err := saveConfig(w.repo, normalised); err != nil {
		return w.cfg, notes, err
	}
	previous := w.cfg
	w.cfg = normalised
	// Turning memory back on must not be met by a stale index built while it was
	// off; and turning it off leaves everything on disk alone, as the design says.
	if !previous.Enabled && normalised.Enabled {
		w.rebuildLocked()
	}
	return w.cfg, notes, nil
}

// Search answers "what do we already know about this".
//
// The results carry the loaded entry, so one retrieval is one pass: the caller does
// not have to ask a second time for the body it is about to render.
func (w *Workspace) Search(query Query) ([]Result, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.cfg.Enabled {
		// An error rather than an empty list. The two would be indistinguishable to the
		// model — and "there is nothing recorded about this" is a very different statement
		// from "this workspace has memory switched off", which is the one it needs in
		// order to stop searching and say so.
		return nil, fmt.Errorf("workspace memory is turned off for this workspace")
	}
	if err := w.ensureIndexLocked(false); err != nil {
		return nil, err
	}

	limit := query.Limit
	if limit <= 0 {
		limit = w.cfg.MaxResults
	}
	minScore := query.MinScore
	if minScore <= 0 {
		minScore = w.cfg.MinScore
	}

	preparedQuery := prepare(query)
	var wantedTags []string
	for _, tag := range query.Tags {
		if trimmed := strings.ToLower(strings.TrimSpace(tag)); trimmed != "" {
			wantedTags = append(wantedTags, trimmed)
		}
	}

	var results []Result
	for index := range w.index.Entries {
		row := w.index.Entries[index]
		if len(wantedTags) > 0 && !hasAnyTag(row, wantedTags) {
			continue
		}
		if scopeFiltered(&row, preparedQuery) {
			continue
		}
		// The floor is applied to the **cue**, not to the total: see scoreEntry. A
		// memory that shares one body word with the query is not relevant, and being
		// marked `verified` does not make it so.
		total, cue, reasons := scoreEntry(&row, nil, preparedQuery)
		if cue < minScore {
			continue
		}
		entry, err := w.repo.load(w.repo.entriesDir(), row.ID)
		if err != nil {
			// The index said this memory exists and the file does not read. Rather than
			// silently dropping it — which would look like a memory that was never
			// written — the problem is recorded and the index is marked stale so the
			// next check rebuilds it.
			w.noteProblem("%v", err)
			w.checkedAt = time.Time{}
			continue
		}
		results = append(results, Result{Entry: entry, Score: total, Reasons: reasons})
	}

	sortResults(results)
	if len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

func hasAnyTag(row IndexEntry, wanted []string) bool {
	for _, tag := range row.Tags {
		normalised := strings.ToLower(strings.TrimSpace(tag))
		for _, candidate := range wanted {
			if normalised == candidate || strings.Contains(normalised, candidate) {
				return true
			}
		}
	}
	return false
}

// Get reads one memory in full.
func (w *Workspace) Get(id string) (*Entry, error) {
	id = strings.TrimSpace(id)
	if err := validateID(id); err != nil {
		return nil, err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	entry, err := w.repo.load(w.repo.entriesDir(), id)
	if err != nil {
		return nil, fmt.Errorf("no memory called %s in this workspace (%w)", id, err)
	}
	return entry, nil
}

// validateID refuses anything that is not a plain file stem.
//
// The id arrives from a model or a front end and is joined onto a directory path, so
// this is the boundary where `../../.ssh/id_rsa` has to die. It is a whitelist rather
// than a blacklist because the set of valid ids is small and closed.
func validateID(id string) error {
	if id == "" {
		return fmt.Errorf("an id is required")
	}
	if len(id) > 64 {
		return fmt.Errorf("id %q is too long", id)
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
		default:
			return fmt.Errorf("id %q contains %q; ids are letters, digits, _ and -", id, string(r))
		}
	}
	return nil
}

// ensureIndexLocked refreshes the index when the directory has moved on.
func (w *Workspace) ensureIndexLocked(force bool) error {
	if !force && w.index != nil && time.Since(w.checkedAt) < StaleCheckInterval {
		return nil
	}
	w.checkedAt = time.Now()
	if w.index == nil || indexMismatch(w.repo, w.index) {
		w.rebuildLocked()
	}
	return nil
}

// rebuildLocked rebuilds the index from the Markdown and persists it.
//
// A failed write is reported but not fatal: the in-memory index is the one retrieval
// uses, and the next open rebuilds again. Losing the derived data must never lose
// the facts it was derived from.
func (w *Workspace) rebuildLocked() {
	index, problems := buildIndex(w.repo)
	for _, problem := range problems {
		w.noteProblem("%s", problem)
	}
	w.index = index
	w.status.Entries = len(index.Entries)
	w.status.BuiltAt = index.BuiltAt
	w.status.Rebuilt = true
	if err := saveIndex(w.repo, index); err != nil {
		w.noteProblem("the index could not be written: %v", err)
	}
}

// RebuildIndex is the explicit repair, for the panel's button and for the design's
// "the index can be rebuilt" requirement.
func (w *Workspace) RebuildIndex() IndexStatus {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.rebuildLocked()
	w.status.Problem = ""
	return w.status
}

// PendingCandidates is how many proposals are waiting for review.
//
// It counts files rather than reading them, because this is what the state
// snapshot reports on **every** tool result: parsing every proposal on every
// snapshot would make the review queue the workspace's hottest file. The count
// and `Snapshot` can differ by one unreadable file at the moment its parse fails,
// which resolves itself on the next snapshot — and the panel always reads the
// snapshot, never this number.
func (w *Workspace) PendingCandidates() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	ids, err := w.repo.listIDs(w.repo.candidatesDir())
	if err != nil {
		return 0
	}
	return len(ids)
}

// IndexStatus returns what the index currently looks like.
func (w *Workspace) IndexStatus() IndexStatus {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.status
}

// --- panel snapshot ---------------------------------------------------------

// EntryRow is one published memory as the panel draws it.
type EntryRow struct {
	ID         string   `json:"id"`
	Revision   int      `json:"revision"`
	Title      string   `json:"title"`
	UpdatedAt  string   `json:"updated_at"`
	Confidence string   `json:"confidence"`
	Triggers   []string `json:"triggers"`
	Tags       []string `json:"tags"`
	ScopePaths []string `json:"scope_paths"`
	Chars      int      `json:"chars"`
}

// CandidateRow is one proposal awaiting review.
type CandidateRow struct {
	ID               string   `json:"id"`
	Op               string   `json:"op"`
	TargetID         string   `json:"target_id"`
	ExpectedRevision int      `json:"expected_revision"`
	Title            string   `json:"title"`
	CreatedAt        string   `json:"created_at"`
	Confidence       string   `json:"confidence"`
	Triggers         []string `json:"triggers"`
	Tags             []string `json:"tags"`
	Body             string   `json:"body"`
	Chars            int      `json:"chars"`
	Reason           string   `json:"reason"`
}

// Snapshot is everything the workspace-memory panel needs, in one message.
//
// One message rather than four requests, for the same reason the terminal list is
// one message: a panel that assembles its own view out of several replies has a
// window in which it is showing a candidate list that no longer matches the entry
// list that was drawn beside it.
type Snapshot struct {
	Root       string         `json:"root"`
	Config     Config         `json:"config"`
	Entries    []EntryRow     `json:"entries"`
	Candidates []CandidateRow `json:"candidates"`
	Index      IndexStatus    `json:"index"`
	// Problem is the runtime's own sentence about anything wrong, and it is
	// deliberately part of the snapshot rather than only a notice: notices land in the
	// transcript, and the panel is a modal layer covering it — the same trap the files
	// panel hit.
	Problem string `json:"problem"`
	// Truncated lists entries whose file could not be read, so the panel can say so
	// without hiding the rows that did read.
	Unreadable []string `json:"unreadable"`
}

// Snapshot builds the panel's view.
func (w *Workspace) Snapshot() Snapshot {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.ensureIndexLocked(true)

	entries := make([]EntryRow, 0, len(w.index.Entries))
	for _, row := range w.index.Entries {
		chars := 0
		if entry, err := w.repo.load(w.repo.entriesDir(), row.ID); err == nil {
			chars = len([]rune(entry.Body))
		}
		entries = append(entries, EntryRow{
			ID:         row.ID,
			Revision:   row.Revision,
			Title:      row.Title,
			UpdatedAt:  row.UpdatedAt,
			Confidence: row.Confidence,
			Triggers:   nonNil(row.Triggers),
			Tags:       nonNil(row.Tags),
			ScopePaths: nonNil(row.ScopePaths),
			Chars:      chars,
		})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].UpdatedAt != entries[j].UpdatedAt {
			return entries[i].UpdatedAt > entries[j].UpdatedAt
		}
		return entries[i].ID < entries[j].ID
	})

	candidates := make([]CandidateRow, 0)
	unreadable := make([]string, 0)
	for _, id := range mustIDs(w.repo.listIDs(w.repo.candidatesDir())) {
		candidate, err := w.repo.loadCandidate(id)
		if err != nil {
			unreadable = append(unreadable, err.Error())
			continue
		}
		candidates = append(candidates, CandidateRow{
			ID:               candidate.ID,
			Op:               candidate.Op,
			TargetID:         candidate.TargetID,
			ExpectedRevision: candidate.ExpectedRevision,
			Title:            candidate.Title,
			CreatedAt:        candidate.CreatedAt,
			Confidence:       candidate.Confidence,
			Triggers:         nonNil(candidate.Triggers),
			Tags:             nonNil(candidate.Tags),
			Body:             candidate.Body,
			Chars:            len([]rune(candidate.Body)),
			Reason:           candidate.Reason,
		})
	}
	// Oldest first: a review queue is read from the bottom, and the candidate that
	// has been waiting longest is the one to deal with next.
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].ID < candidates[j].ID })

	return Snapshot{
		Root:       w.root,
		Config:     w.cfg,
		Entries:    entries,
		Candidates: candidates,
		Index:      w.status,
		Problem:    strings.Join(w.problems, "; "),
		Unreadable: unreadable,
	}
}

// mustIDs drops the error from a directory listing.
//
// A directory that cannot be listed has already been reported by the open (there is
// no memory system at all in that case), and a snapshot is a report rather than an
// operation: returning no candidates is the honest answer for "there are none I can
// read".
func mustIDs(ids []string, _ error) []string { return ids }

// nonNil turns a nil slice into an empty one.
//
// It is not cosmetic. `null` and `[]` are different statements on the wire, and this
// program's protocol says an empty list goes out as `[]` — a front end that has to
// tell "there are none" apart from "the runtime did not say" is a front end with a
// second definition of the panel's shape, and the first bug it produces is a crash on
// the empty case. A memory with no tags is a memory with no tags, not an unknown.
func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
