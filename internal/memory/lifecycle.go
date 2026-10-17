package memory

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The lifecycle: nothing becomes a memory without a person publishing it.
//
//	propose → candidates/proposal_00N.md → review → publish → entries/mem_00N.md
//	                                        └→ reject
//
// Every published memory is a file a person could have written themselves, and every
// proposal is a file they can read before deciding. That is the whole point of
// staging proposals on the disk rather than holding them in memory: a review
// decision has to be possible from outside the program, and a proposal that only
// exists inside a runtime is a proposal nobody can review after a restart.

// Operations a proposal can carry.
const (
	// OpCreate adds a new memory.
	OpCreate = "create"
	// OpUpdate replaces an existing memory's content, under a revision check.
	OpUpdate = "update"
	// OpDeprecate retires an existing memory.
	OpDeprecate = "deprecate"
)

// Ops is the accepted vocabulary, for validation messages.
var Ops = []string{OpCreate, OpUpdate, OpDeprecate}

// ValidOp reports whether an op is one this build knows.
func ValidOp(op string) bool { return op == OpCreate || op == OpUpdate || op == OpDeprecate }

// Proposal is what a caller asks to have considered.
//
// The fields mirror `Entry` deliberately: a proposal is a memory that has not been
// approved yet, and giving the two different shapes would force every reviewer — a
// person reading a file, a model calling the tool, the panel drawing a card — to
// know two formats for the same content.
type Proposal struct {
	// Op is create, update or deprecate.
	Op string
	// TargetID is the memory being changed, for update and deprecate.
	TargetID string
	// ExpectedRevision is the revision the proposer read. Zero means "whatever is
	// current", which is filled in here rather than at publish time — filling it at
	// publish time would defeat the check entirely, because by then it always
	// matches.
	ExpectedRevision int
	Title            string
	Body             string
	Scope            Scope
	Triggers         []string
	Tags             []string
	Confidence       string
	// Reason is why a deprecation is being proposed. It is written into the archive
	// copy so a retired memory explains itself a year later.
	Reason string
}

// Candidate is a proposal read back off the disk.
type Candidate struct {
	ID               string
	Op               string
	TargetID         string
	ExpectedRevision int
	CreatedAt        string
	Title            string
	Body             string
	Scope            Scope
	Triggers         []string
	Tags             []string
	Confidence       string
	Reason           string
}

// ConflictError is a proposal written against a memory that has moved on.
//
// It is a distinct type because every surface has to say something different about
// it: the tool tells the model to re-read and re-propose, the panel tells the person
// that another change landed, and neither message is the generic one.
type ConflictError struct {
	TargetID string
	Expected int
	Current  int
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("memory %s has changed since this proposal was written "+
		"(it was revision %d, it is now %d); re-read it and propose again",
		e.TargetID, e.Expected, e.Current)
}

// Propose writes a candidate and returns its id.
//
// Nothing published changes here. That is the design's central safety property: a
// model may record what it believes it learned without being able to make the corpus
// say it.
func (w *Workspace) Propose(proposal Proposal) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.cfg.Enabled {
		return "", fmt.Errorf("workspace memory is turned off for this workspace")
	}

	op := strings.TrimSpace(proposal.Op)
	if op == "" {
		op = OpCreate
	}
	if !ValidOp(op) {
		return "", fmt.Errorf("unknown operation %q (expected one of %s)", op, strings.Join(Ops, ", "))
	}
	confidence, err := NormaliseConfidence(proposal.Confidence)
	if err != nil {
		return "", err
	}

	candidate := Candidate{
		Op:         op,
		CreatedAt:  today(),
		Title:      strings.TrimSpace(proposal.Title),
		Body:       strings.TrimSpace(proposal.Body),
		Scope:      proposal.Scope,
		Triggers:   cleanList(proposal.Triggers),
		Tags:       cleanList(proposal.Tags),
		Confidence: confidence,
		Reason:     strings.TrimSpace(proposal.Reason),
	}

	switch op {
	case OpCreate:
		if candidate.Title == "" {
			return "", fmt.Errorf("a new memory needs a title")
		}
		if candidate.Body == "" {
			return "", fmt.Errorf("a new memory needs a body: what was learned, and under what conditions")
		}
		// A create proposal may still name a target — the model read an existing memory
		// and decided it should be extended rather than replaced. That is an update, and
		// treating it as one is what keeps the review from seeing two memories that say
		// almost the same thing.
		if target := strings.TrimSpace(proposal.TargetID); target != "" {
			if w.entryExists(target) {
				candidate.Op = OpUpdate
				candidate.TargetID = target
				candidate.ExpectedRevision = proposal.ExpectedRevision
			}
		}
	case OpUpdate:
		candidate.TargetID = strings.TrimSpace(proposal.TargetID)
		if candidate.TargetID == "" {
			return "", fmt.Errorf("an update needs target_id: which memory is being changed")
		}
		current, err := w.repo.load(w.repo.entriesDir(), candidate.TargetID)
		if err != nil {
			return "", fmt.Errorf("no memory called %s to update (%w)", candidate.TargetID, err)
		}
		if candidate.ExpectedRevision <= 0 {
			candidate.ExpectedRevision = current.Revision
		}
		if candidate.Title == "" {
			candidate.Title = current.Title
		}
		if candidate.Body == "" {
			candidate.Body = current.Body
		}
		if len(candidate.Triggers) == 0 {
			candidate.Triggers = current.Triggers
		}
		if len(candidate.Tags) == 0 {
			candidate.Tags = current.Tags
		}
		if len(candidate.Scope.Paths) == 0 {
			candidate.Scope = current.Scope
		}
	case OpDeprecate:
		candidate.TargetID = strings.TrimSpace(proposal.TargetID)
		if candidate.TargetID == "" {
			return "", fmt.Errorf("a deprecation needs target_id: which memory is being retired")
		}
		current, err := w.repo.load(w.repo.entriesDir(), candidate.TargetID)
		if err != nil {
			return "", fmt.Errorf("no memory called %s to deprecate (%w)", candidate.TargetID, err)
		}
		// The title is copied so the review card names the memory rather than an id.
		candidate.Title = current.Title
		if candidate.Body == "" {
			candidate.Body = proposal.Reason
		}
		candidate.Scope = current.Scope
		candidate.Triggers = current.Triggers
		candidate.Tags = current.Tags
		candidate.Confidence = current.Confidence
		if candidate.Reason == "" {
			candidate.Reason = candidate.Body
		}
	}

	existing, err := w.repo.listIDs(w.repo.candidatesDir())
	if err != nil {
		return "", fmt.Errorf("listing proposals: %w", err)
	}
	// The id is allocated and written under the same cross-process lock a publish takes.
	// Two sessions in one workspace can both propose at the same instant, and without
	// this they would both compute `proposal_004` — then one atomic rename would silently
	// replace the other's file, and a proposal would be lost with nothing to show for it.
	release, err := w.repo.lock()
	if err != nil {
		return "", err
	}
	defer release()
	// Re-read under the lock: another process may have taken the number between the
	// listing above and the lock.
	if existing, err = w.repo.listIDs(w.repo.candidatesDir()); err != nil {
		return "", fmt.Errorf("listing proposals: %w", err)
	}
	candidate.ID = nextID("proposal", existing)
	if err := writeAtomic(filepath.Join(w.repo.candidatesDir(), candidate.ID+".md"),
		[]byte(candidate.Render())); err != nil {
		return "", err
	}
	return candidate.ID, nil
}

// Candidates lists the proposals waiting for review, oldest first.
func (w *Workspace) Candidates() ([]*Candidate, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	ids, err := w.repo.listIDs(w.repo.candidatesDir())
	if err != nil {
		return nil, err
	}
	out := make([]*Candidate, 0, len(ids))
	for _, id := range ids {
		candidate, err := w.repo.loadCandidate(id)
		if err != nil {
			continue
		}
		out = append(out, candidate)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// Candidate reads one proposal.
func (w *Workspace) Candidate(id string) (*Candidate, error) {
	if err := validateID(id); err != nil {
		return nil, err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.repo.loadCandidate(id)
}

// Publish turns a proposal into a published memory.
//
// The sequence is the design's: validate, lock, write the fact atomically, rebuild
// the index, then drop the proposal. Note the order of the last two — the memory file
// is on disk before the index knows about it, so a failure between them leaves a
// memory that exists and an index that is stale, never the other way round. A stale
// index is repaired by a rebuild; a memory that was never written is simply lost.
func (w *Workspace) Publish(proposalID string) (*Entry, error) {
	if err := validateID(proposalID); err != nil {
		return nil, err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.cfg.Enabled {
		return nil, fmt.Errorf("workspace memory is turned off for this workspace")
	}

	release, err := w.repo.lock()
	if err != nil {
		return nil, err
	}
	defer release()

	candidate, err := w.repo.loadCandidate(proposalID)
	if err != nil {
		return nil, err
	}

	switch candidate.Op {
	case OpCreate:
		entry, err := w.publishCreateLocked(candidate)
		if err != nil {
			return nil, err
		}
		w.dropCandidate(proposalID)
		return entry, nil
	case OpUpdate:
		entry, err := w.publishUpdateLocked(candidate)
		if err != nil {
			return nil, err
		}
		w.dropCandidate(proposalID)
		return entry, nil
	case OpDeprecate:
		if err := w.publishDeprecateLocked(candidate); err != nil {
			return nil, err
		}
		w.dropCandidate(proposalID)
		return nil, nil
	default:
		return nil, fmt.Errorf("proposal %s has unknown op %q", proposalID, candidate.Op)
	}
}

func (w *Workspace) publishCreateLocked(candidate *Candidate) (*Entry, error) {
	ids, err := w.repo.listIDs(w.repo.entriesDir())
	if err != nil {
		return nil, err
	}
	archived, _ := w.repo.listIDs(w.repo.archives())
	ids = append(ids, archived...)

	entry := &Entry{
		// Revision starts at 1 and the id is allocated **at publish time**, not at
		// proposal time: two proposals written before either is reviewed would
		// otherwise claim the same number, and the second would overwrite the first.
		ID:         nextID("mem", ids),
		Revision:   1,
		CreatedAt:  today(),
		UpdatedAt:  today(),
		Title:      candidate.Title,
		Body:       candidate.Body,
		Scope:      candidate.Scope,
		Triggers:   candidate.Triggers,
		Tags:       candidate.Tags,
		Confidence: candidate.Confidence,
	}
	if err := w.repo.save(w.repo.entriesDir(), entry.ID, entry); err != nil {
		return nil, err
	}
	w.rebuildLocked()
	return entry, nil
}

func (w *Workspace) publishUpdateLocked(candidate *Candidate) (*Entry, error) {
	if candidate.TargetID == "" {
		return nil, fmt.Errorf("proposal %s updates nothing: it has no target_id", candidate.ID)
	}
	current, err := w.repo.load(w.repo.entriesDir(), candidate.TargetID)
	if err != nil {
		return nil, fmt.Errorf("no memory called %s to update (%w)", candidate.TargetID, err)
	}
	expected := candidate.ExpectedRevision
	if expected <= 0 {
		// A proposal that never recorded a revision cannot be checked. Refusing is the
		// only honest answer: applying it would be exactly the silent overwrite the
		// check exists to prevent.
		return nil, fmt.Errorf("proposal %s does not say which revision of %s it was written against",
			candidate.ID, candidate.TargetID)
	}
	if current.Revision != expected {
		return nil, &ConflictError{TargetID: candidate.TargetID, Expected: expected, Current: current.Revision}
	}

	// The superseded revision is kept. "Do not delete, archive" is the design's rule,
	// and the reason is concrete: an update that turns out to be wrong has to be
	// reversible by a person reading the old text.
	if err := w.archiveEntry(current, "r"+itoa(current.Revision)); err != nil {
		return nil, err
	}

	updated := &Entry{
		ID:         current.ID,
		Revision:   current.Revision + 1,
		CreatedAt:  current.CreatedAt,
		UpdatedAt:  today(),
		Title:      firstNonEmpty(candidate.Title, current.Title),
		Body:       firstNonEmpty(candidate.Body, current.Body),
		Scope:      candidate.Scope,
		Triggers:   candidate.Triggers,
		Tags:       candidate.Tags,
		Confidence: firstNonEmpty(candidate.Confidence, current.Confidence),
		Extra:      current.Extra,
	}
	if len(updated.Scope.Paths) == 0 {
		updated.Scope = current.Scope
	}
	if len(updated.Triggers) == 0 {
		updated.Triggers = current.Triggers
	}
	if len(updated.Tags) == 0 {
		updated.Tags = current.Tags
	}
	if err := w.repo.save(w.repo.entriesDir(), updated.ID, updated); err != nil {
		return nil, err
	}
	w.rebuildLocked()
	return updated, nil
}

func (w *Workspace) publishDeprecateLocked(candidate *Candidate) error {
	if candidate.TargetID == "" {
		return fmt.Errorf("proposal %s deprecates nothing: it has no target_id", candidate.ID)
	}
	current, err := w.repo.load(w.repo.entriesDir(), candidate.TargetID)
	if err != nil {
		return fmt.Errorf("no memory called %s to deprecate (%w)", candidate.TargetID, err)
	}
	reason := candidate.Reason
	if reason == "" {
		reason = candidate.Body
	}
	if reason != "" {
		current.Extra["deprecated_reason"] = reason
	}
	current.Extra["deprecated_at"] = today()
	if err := w.archiveEntry(current, "deprecated"); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(w.repo.entriesDir(), current.ID+".md")); err != nil {
		return fmt.Errorf("removing %s: %w", current.ID, err)
	}
	w.rebuildLocked()
	return nil
}

// archiveEntry copies a memory into `archive/entries/` under a suffix.
func (w *Workspace) archiveEntry(entry *Entry, suffix string) error {
	path := filepath.Join(w.repo.archives(), entry.ID+"-"+suffix+".md")
	return writeAtomic(path, []byte(entry.Render()))
}

// dropCandidate removes a proposal that has been dealt with.
//
// It is deleted rather than archived: the published memory is the record of what was
// approved, and a directory of rejected proposals would be an event log — which the
// design puts explicitly out of scope for this version. A failed delete is reported
// but does not fail the publish: the memory is already on disk and the leftover
// proposal is visible in the panel.
func (w *Workspace) dropCandidate(id string) {
	if err := os.Remove(filepath.Join(w.repo.candidatesDir(), id+".md")); err != nil && !os.IsNotExist(err) {
		w.noteProblem("published %s but could not remove the proposal file: %v", id, err)
	}
}

// Reject discards a proposal.
func (w *Workspace) Reject(proposalID string) error {
	if err := validateID(proposalID); err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	path := filepath.Join(w.repo.candidatesDir(), proposalID+".md")
	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("there is no proposal called %s", proposalID)
		}
		return fmt.Errorf("removing %s: %w", path, err)
	}
	return nil
}

// Deprecate proposes retiring a memory, and returns the proposal id.
//
// A proposal rather than an immediate removal, because the design's rule for
// deprecation is the same as its rule for writing: somebody looks at it first. The
// panel's "Deprecate" button therefore produces a candidate, and publishing that
// candidate is the second click.
func (w *Workspace) Deprecate(entryID, reason string) (string, error) {
	return w.Propose(Proposal{
		Op:       OpDeprecate,
		TargetID: entryID,
		Reason:   reason,
		Body:     reason,
	})
}

// entryExists reports whether a published memory exists.
func (w *Workspace) entryExists(id string) bool {
	if validateID(id) != nil {
		return false
	}
	_, err := os.Stat(filepath.Join(w.repo.entriesDir(), id+".md"))
	return err == nil
}

// --- candidate file format --------------------------------------------------

// Render writes a proposal in the same frontmatter-plus-Markdown shape a memory uses.
func (c *Candidate) Render() string {
	fields := map[string]any{
		"id":         c.ID,
		"op":         c.Op,
		"created_at": c.CreatedAt,
	}
	if c.TargetID != "" {
		fields["target_id"] = c.TargetID
	}
	if c.ExpectedRevision > 0 {
		fields["expected_revision"] = c.ExpectedRevision
	}
	if len(c.Scope.Paths) > 0 {
		fields["scope"] = map[string]any{"paths": c.Scope.Paths}
	}
	if len(c.Triggers) > 0 {
		fields["triggers"] = c.Triggers
	}
	if len(c.Tags) > 0 {
		fields["tags"] = c.Tags
	}
	confidence := c.Confidence
	if confidence == "" {
		confidence = ConfidenceObserved
	}
	fields["evidence"] = map[string]any{"confidence": confidence}
	if c.Reason != "" {
		fields["reason"] = c.Reason
	}

	var builder strings.Builder
	builder.WriteString("---\n")
	writeFrontmatter(&builder, fields)
	builder.WriteString("---\n\n")
	if c.Title != "" {
		builder.WriteString("# " + c.Title + "\n\n")
	}
	if body := strings.TrimRight(c.Body, "\n"); body != "" {
		builder.WriteString(body + "\n")
	}
	return builder.String()
}

// loadCandidate reads one proposal.
func (r *repository) loadCandidate(id string) (*Candidate, error) {
	path := filepath.Join(r.candidatesDir(), id+".md")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	candidate, err := ParseCandidate(string(raw))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if candidate.ID == "" {
		candidate.ID = id
	}
	if candidate.ID != id {
		return nil, fmt.Errorf("%s declares id %q but its file is named %q", path, candidate.ID, id)
	}
	return candidate, nil
}

// ParseCandidate decodes a proposal file.
func ParseCandidate(text string) (*Candidate, error) {
	fields, body, err := splitFrontmatter(text)
	if err != nil {
		return nil, err
	}
	candidate := &Candidate{
		ID:               scalarString(fields["id"]),
		Op:               scalarString(fields["op"]),
		TargetID:         scalarString(fields["target_id"]),
		ExpectedRevision: scalarInt(fields["expected_revision"]),
		CreatedAt:        scalarString(fields["created_at"]),
		Reason:           scalarString(fields["reason"]),
		Scope:            Scope{Paths: nestedList(fields["scope"], "paths")},
		Triggers:         listOf(fields["triggers"]),
		Tags:             listOf(fields["tags"]),
	}
	candidate.Confidence, _ = NormaliseConfidence(nestedString(fields["evidence"], "confidence"))
	candidate.Title, candidate.Body = splitTitle(body)
	if candidate.Op == "" {
		candidate.Op = OpCreate
	}
	if !ValidOp(candidate.Op) {
		return nil, fmt.Errorf("unknown operation %q", candidate.Op)
	}
	return candidate, nil
}

// --- small helpers ----------------------------------------------------------

// cleanList trims, drops blanks and removes duplicates, keeping order.
func cleanList(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func itoa(value int) string { return fmt.Sprintf("%d", value) }
