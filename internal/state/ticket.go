package state

import (
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// The ticket binding: which task-level work item this session is the worker for.
//
// A Ticket lives on the front end (it outlives any session), so the runtime keeps
// only the narrowest fact it needs: "I am working for ticket X, this is its brief,
// and these are the reports I have already made". Three rules shape this file:
//
//  1. **It is session state, not conversation.** The block sits in `session.Metadata`
//     beside `goal`, so it survives a restart, a `/resume` and a compaction. That is
//     what lets a reopened session keep its reporting tool without being told again.
//  2. **The runtime never interprets the ticket.** It does not know the ticket's
//     state machine; reports are recorded and forwarded verbatim. Keeping the
//     runtime ignorant is what allows the ticket store to move later without a
//     runtime change.
//  3. **A report is written down before it is announced.** The list here is the
//     reconciliation source for a front end that missed the live message, so a
//     report that was announced but not recorded would be a report nobody can
//     recover.
const (
	// TicketKey is where the binding lives in session metadata, at the same level
	// as GoalKey.
	TicketKey = "ticket"

	// Report statuses. These are the only two the tool accepts: "ready" and
	// "draft" distinctions are the person's to make when reviewing.
	TicketStatusDone    = "done"
	TicketStatusBlocked = "blocked"

	// MaxTicketReports bounds the retained report list. Every report rewrites the
	// metadata record, and the list is also sent in `init`, so an unbounded list
	// would turn a chatty agent into a growing tax on both. The oldest are dropped
	// first; a front end reconciles by report id, so a dropped old id is simply one
	// it has long since processed.
	MaxTicketReports = 200

	// MaxTicketTurnEnds bounds the retained "turn ended without a report" list
	// (protocol 21). It only matters while the front end's ticket is `running`, and
	// the number of such facts a front end can miss in that window is tiny, so a
	// short list is enough for reconciliation without taxing every `init`.
	MaxTicketTurnEnds = 20

	// Ceilings on what a bind may carry. The brief goes into the payload tail every
	// round (see TicketText, which only quotes its head), so an accidental paste of
	// a whole file must not become a permanent per-request cost.
	TicketIDCeiling    = 200
	TicketTitleCeiling = 500
	TicketBriefCeiling = 20000

	// TicketTailBriefRunes is how much of the brief the payload tail quotes.
	//
	// The tail is sent with **every** request, so its size is a cost paid once per
	// round for the whole session: 20000 characters is roughly 5k tokens each time,
	// which is an order of magnitude more than the note is worth. The full brief is
	// already message one of the conversation, where it is read once and then
	// compacted away with the rest of the early history — which is exactly the
	// trade the goal note makes (it quotes the objective, not the plan).
	TicketTailBriefRunes = 2000

	// Ceilings on the attachment list (protocol 19). The list is quoted in the
	// payload tail on every round, one line per entry, so the count cap is also
	// the cap on what the tail can grow by. The file contents never travel here:
	// only where the files were put.
	MaxTicketAttachments        = 50
	TicketAttachmentNameCeiling = 255
	TicketAttachmentPathCeiling = 1024

	// Ticket notes (protocol 22): the people-and-agent written context shared by
	// every session on one ticket. Unlike the brief, **every note is quoted in
	// full in the payload tail** (a truncated note may be exactly the one that
	// mattered), so the cost is bounded here, at write time, instead.
	//
	// The desktop mirrors these three numbers and a test there reads this file to
	// keep them equal: rename them and that test fails loudly, which is the point.
	TicketNoteTextCeiling   = 4000  // runes in one note
	MaxTicketNotes          = 100   // notes on one ticket
	TicketNotesTotalCeiling = 12000 // runes across all notes: ~3-4k tokens per round

	// MaxTicketNoteOps bounds the retained agent-note operation log, the
	// reconciliation source for a front end that missed `ui(ticket_note)`. Same
	// trade as MaxTicketTurnEnds: the window of facts a front end can miss is
	// small, and the list rides every `init`.
	MaxTicketNoteOps = 50

	// Who wrote a note. The runtime only needs the distinction to refuse an agent
	// editing what a person wrote.
	TicketNoteAuthorPerson = "person"
	TicketNoteAuthorAgent  = "agent"

	// The three operations `ticket_note` performs.
	TicketNoteOpAdd    = "add"
	TicketNoteOpUpdate = "update"
	TicketNoteOpRemove = "remove"

	// ticketNoteIDCeiling keeps one id from being a way to inflate the tail.
	ticketNoteIDCeiling = 200
)

// TicketAttachment is one file the person attached to the ticket, already copied
// into the session's workspace by the front end.
//
// The runtime does not copy, read or keep the file; it only remembers where it
// is, so the model can be told every round and a resumed session still knows.
// Path is workspace-relative with forward slashes.
type TicketAttachment struct {
	Name  string
	Path  string
	Bytes int64
}

// Wire is the attachment in the shape `init.ticket.attachments[]` carries and
// the metadata record stores. Bytes is int64 so a live payload and a value that
// went through a JSON round trip (float64) are told apart only by type, not by
// meaning; LoadTicket accepts both.
func (a TicketAttachment) Wire() map[string]any {
	return map[string]any{"name": a.Name, "path": a.Path, "bytes": a.Bytes}
}

// ValidateTicketAttachment reports why an attachment is not acceptable, or nil.
//
// The protocol layer checks the same rules on the raw message so the person gets
// a precise notice; this copy exists because the text is quoted to the model
// every round, so the record must not trust whichever caller built it. A path
// that escapes the workspace would send the model reading files the person never
// attached, and a name or path with a line break could forge extra lines in the
// tail.
func ValidateTicketAttachment(a TicketAttachment) error {
	if a.Name == "" {
		return fmt.Errorf("an attachment needs a non-empty name")
	}
	if utf8.RuneCountInString(a.Name) > TicketAttachmentNameCeiling {
		return fmt.Errorf("an attachment name is longer than %d characters", TicketAttachmentNameCeiling)
	}
	if strings.ContainsAny(a.Name, `/\`) {
		return fmt.Errorf("attachment name %q must not contain / or \\", a.Name)
	}
	if hasControlRune(a.Name) {
		return fmt.Errorf("an attachment name must not contain control characters")
	}
	if a.Path == "" {
		return fmt.Errorf("attachment %q needs a non-empty path", a.Name)
	}
	if utf8.RuneCountInString(a.Path) > TicketAttachmentPathCeiling {
		return fmt.Errorf("an attachment path is longer than %d characters", TicketAttachmentPathCeiling)
	}
	if hasControlRune(a.Path) {
		return fmt.Errorf("an attachment path must not contain control characters")
	}
	if strings.HasPrefix(a.Path, "/") || strings.HasPrefix(a.Path, `\`) || hasDriveLetter(a.Path) {
		return fmt.Errorf("attachment path %q must be relative to the workspace", a.Path)
	}
	// Both separators are split on: the contract says forward slashes, but a
	// `..\` segment is just as much a way out on the platform that uses `\`.
	for _, segment := range strings.FieldsFunc(a.Path, func(r rune) bool { return r == '/' || r == '\\' }) {
		if segment == ".." {
			return fmt.Errorf("attachment path %q must not contain a .. segment", a.Path)
		}
	}
	if a.Bytes < 0 {
		return fmt.Errorf("attachment %q has a negative size", a.Name)
	}
	return nil
}

func hasControlRune(text string) bool {
	for _, r := range text {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// hasDriveLetter spots `C:` at the start, which names a drive on Windows whether
// or not a slash follows.
func hasDriveLetter(path string) bool {
	if len(path) < 2 || path[1] != ':' {
		return false
	}
	letter := path[0]
	return (letter >= 'a' && letter <= 'z') || (letter >= 'A' && letter <= 'Z')
}

func sameAttachments(a, b []TicketAttachment) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}

// TicketAttachmentOf reads one attachment out of a decoded JSON object. It is
// lenient on purpose (see LoadTicket): a row that is not understood is dropped
// rather than failing the whole record.
func TicketAttachmentOf(raw any) (TicketAttachment, bool) {
	row, ok := raw.(map[string]any)
	if !ok {
		return TicketAttachment{}, false
	}
	attachment := TicketAttachment{}
	attachment.Name, _ = row["name"].(string)
	attachment.Path, _ = row["path"].(string)
	switch size := row["bytes"].(type) {
	case int64:
		attachment.Bytes = size
	case int:
		attachment.Bytes = int64(size)
	case float64:
		attachment.Bytes = int64(size)
	}
	if attachment.Name == "" || attachment.Path == "" {
		return TicketAttachment{}, false
	}
	return attachment, true
}

// TicketReport is one fact the agent reported.
type TicketReport struct {
	ID       string
	Status   string
	Summary  string
	Question string // "" means none; it travels as null
	Evidence []string
	AtMs     int64
}

// TicketTurnEnd is one turn that ended normally while bound, without the agent
// having reported (protocol 21). It is a fact about the turn, never a claim that
// the work is done; the front end's state machine decides what it means.
type TicketTurnEnd struct {
	TurnID string
	AtMs   int64
}

// Wire is the turn end in the shape `init.ticket.turn_ends[]` carries.
func (e TicketTurnEnd) Wire() map[string]any {
	return map[string]any{"turn_id": e.TurnID, "at_ms": e.AtMs}
}

// Ticket is the binding plus the reports made under it.
type Ticket struct {
	ID      string
	Title   string
	Brief   string
	Reports []TicketReport
	// TurnEnds are the turns that ended without a report (protocol 21).
	TurnEnds []TicketTurnEnd
	// Attachments is what the front end staged into the workspace (protocol 19).
	Attachments []TicketAttachment
	// Notes is the runtime's **copy** of the ticket's shared notes (protocol 22).
	// The front end owns the original; every bind replaces this wholesale.
	Notes []TicketNote
	// NoteOps is the log of notes the agent wrote through `ticket_note`, kept so a
	// front end that missed `ui(ticket_note)` can reconcile from `init`.
	NoteOps []TicketNoteOp
}

// TicketSpec is what a bind carries.
type TicketSpec struct {
	ID          string
	Title       string
	Brief       string
	Attachments []TicketAttachment
	// Notes is the front end's current notes. Nil means none, which **clears** the
	// copy: the original is the source of truth, so an absent list is a statement.
	Notes []TicketNote
}

// TicketNote is one shared note on the ticket.
//
// CreatedAtMs and SessionID are optional on the wire in (the bind only has to
// carry id, text, author and updated_at_ms); notes the agent adds here always
// have both.
type TicketNote struct {
	ID          string
	Text        string
	Author      string // TicketNoteAuthorPerson | TicketNoteAuthorAgent
	SessionID   string
	CreatedAtMs int64
	UpdatedAtMs int64
}

// Wire is the note in the shape `init.ticket.notes[]` carries and the metadata
// record stores. Optional keys are left out rather than sent as null/0 so a
// consumer cannot mistake "unknown" for "the epoch".
func (n TicketNote) Wire() map[string]any {
	wire := map[string]any{
		"id":            n.ID,
		"text":          n.Text,
		"author":        n.Author,
		"updated_at_ms": n.UpdatedAtMs,
	}
	if n.SessionID != "" {
		wire["session_id"] = n.SessionID
	}
	if n.CreatedAtMs > 0 {
		wire["created_at_ms"] = n.CreatedAtMs
	}
	return wire
}

// TicketNoteOp is one write the agent made through `ticket_note`.
type TicketNoteOp struct {
	OpID   string
	Op     string // add | update | remove
	NoteID string
	Text   string // "" for remove; it travels as null
	AtMs   int64
}

// Wire is the op in the shape `init.ticket.note_ops[]` carries: the same fields
// as `ui(ticket_note)` minus `kind`, `ticket_id` and `session_id`.
func (o TicketNoteOp) Wire() map[string]any {
	var text any
	if o.Op != TicketNoteOpRemove {
		text = o.Text
	}
	return map[string]any{
		"op_id":   o.OpID,
		"op":      o.Op,
		"note_id": o.NoteID,
		"text":    text,
		"at_ms":   o.AtMs,
	}
}

// ValidateTicketNotes reports why a list of notes cannot be bound, or nil.
//
// The protocol layer applies the same rules to the raw message so the person
// gets a precise notice; this copy exists because every note is quoted to the
// model in full every round, so the record must not trust its caller.
func ValidateTicketNotes(notes []TicketNote) error {
	if len(notes) > MaxTicketNotes {
		return fmt.Errorf("a ticket takes at most %d notes, got %d", MaxTicketNotes, len(notes))
	}
	seen := make(map[string]struct{}, len(notes))
	total := 0
	for index, note := range notes {
		if strings.TrimSpace(note.ID) == "" {
			return fmt.Errorf("note %d needs a non-empty id", index)
		}
		if utf8.RuneCountInString(note.ID) > ticketNoteIDCeiling {
			return fmt.Errorf("note %d: the id is longer than %d characters", index, ticketNoteIDCeiling)
		}
		if _, dup := seen[note.ID]; dup {
			return fmt.Errorf("note %d: the id %q is used twice", index, note.ID)
		}
		seen[note.ID] = struct{}{}
		if note.Author != TicketNoteAuthorPerson && note.Author != TicketNoteAuthorAgent {
			return fmt.Errorf("note %d: `author` must be %q or %q", index, TicketNoteAuthorPerson, TicketNoteAuthorAgent)
		}
		runes := utf8.RuneCountInString(note.Text)
		if runes > TicketNoteTextCeiling {
			return fmt.Errorf("note %d is %d characters; one note takes at most %d", index, runes, TicketNoteTextCeiling)
		}
		total += runes
	}
	if total > TicketNotesTotalCeiling {
		return fmt.Errorf("the notes total %d characters; the limit is %d", total, TicketNotesTotalCeiling)
	}
	return nil
}

func noteRunes(notes []TicketNote) int {
	total := 0
	for _, note := range notes {
		total += utf8.RuneCountInString(note.Text)
	}
	return total
}

func sameNotes(a, b []TicketNote) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}

// Wire is the report in the shape both `init.ticket.reports[]` and
// `ui(ticket_report)` carry. One shape for both on purpose: the front end
// reconciles the two by the same id, and two spellings would be two parsers.
//
// Evidence is `[]any` rather than `[]string` so the value is already what a JSON
// round trip would produce; a consumer comparing a live payload with a reloaded
// one then sees the same types.
func (r TicketReport) Wire() map[string]any {
	evidence := make([]any, 0, len(r.Evidence))
	for _, item := range r.Evidence {
		evidence = append(evidence, item)
	}
	var question any
	if r.Question != "" {
		question = r.Question
	}
	return map[string]any{
		"report_id": r.ID,
		"status":    r.Status,
		"summary":   r.Summary,
		"question":  question,
		"evidence":  evidence,
		"at_ms":     r.AtMs,
	}
}

// Block is the ticket as it is stored in metadata and as `init.ticket` sends it.
// It is built fresh on every call so a caller can never alias the stored map.
func (t Ticket) Block() map[string]any {
	reports := make([]any, 0, len(t.Reports))
	for _, report := range t.Reports {
		reports = append(reports, report.Wire())
	}
	// Always an array, never null: a front end reading `init.ticket.attachments`
	// should have one case to handle, the same reasoning as `reports`.
	attachments := make([]any, 0, len(t.Attachments))
	for _, attachment := range t.Attachments {
		attachments = append(attachments, attachment.Wire())
	}
	turnEnds := make([]any, 0, len(t.TurnEnds))
	for _, end := range t.TurnEnds {
		turnEnds = append(turnEnds, end.Wire())
	}
	// Both note lists are arrays for the same reason as the others (protocol 22).
	notes := make([]any, 0, len(t.Notes))
	for _, note := range t.Notes {
		notes = append(notes, note.Wire())
	}
	noteOps := make([]any, 0, len(t.NoteOps))
	for _, op := range t.NoteOps {
		noteOps = append(noteOps, op.Wire())
	}
	return map[string]any{
		"id":          t.ID,
		"title":       t.Title,
		"brief":       t.Brief,
		"reports":     reports,
		"attachments": attachments,
		"turn_ends":   turnEnds,
		"notes":       notes,
		"note_ops":    noteOps,
	}
}

// LoadTicket reads the binding out of metadata. A missing, mistyped or id-less
// block reads as "not bound": a tool that registers itself on a half-understood
// block would report against a ticket nobody can name.
func LoadTicket(metadata map[string]any) (Ticket, bool) {
	raw, ok := metadata[TicketKey].(map[string]any)
	if !ok {
		return Ticket{}, false
	}
	id, _ := raw["id"].(string)
	if strings.TrimSpace(id) == "" {
		return Ticket{}, false
	}
	ticket := Ticket{ID: id}
	ticket.Title, _ = raw["title"].(string)
	ticket.Brief, _ = raw["brief"].(string)
	if rows, ok := raw["reports"].([]any); ok {
		for _, row := range rows {
			if report, ok := ticketReportOf(row); ok {
				ticket.Reports = append(ticket.Reports, report)
			}
		}
	}
	// A record written before protocol 21 has no such key; that reads as none.
	if rows, ok := raw["turn_ends"].([]any); ok {
		for _, row := range rows {
			if end, ok := ticketTurnEndOf(row); ok {
				ticket.TurnEnds = append(ticket.TurnEnds, end)
			}
		}
	}
	// A record written before protocol 19 has no such key; that reads as none.
	// A row that fails validation is dropped rather than quoted to the model,
	// since a hand-edited session file is the only way one gets here.
	if rows, ok := raw["attachments"].([]any); ok {
		for _, row := range rows {
			if attachment, ok := TicketAttachmentOf(row); ok && ValidateTicketAttachment(attachment) == nil {
				ticket.Attachments = append(ticket.Attachments, attachment)
			}
		}
	}
	// A record written before protocol 22 has neither key; that reads as none.
	// Rows that are not understood are dropped, as with attachments.
	if rows, ok := raw["notes"].([]any); ok {
		for _, row := range rows {
			if note, ok := ticketNoteOf(row); ok {
				ticket.Notes = append(ticket.Notes, note)
			}
		}
	}
	if rows, ok := raw["note_ops"].([]any); ok {
		for _, row := range rows {
			if op, ok := ticketNoteOpOf(row); ok {
				ticket.NoteOps = append(ticket.NoteOps, op)
			}
		}
	}
	return ticket, true
}

// wireInt reads a JSON-ish number: int64 from a live payload, float64 from a
// value that went through a JSON round trip.
func wireInt(raw any) int64 {
	switch number := raw.(type) {
	case int64:
		return number
	case int:
		return int64(number)
	case float64:
		return int64(number)
	}
	return 0
}

// TicketNoteOf reads one note out of a decoded JSON object. Lenient like the
// other loaders: it only insists on what the record cannot do without.
func ticketNoteOf(raw any) (TicketNote, bool) {
	row, ok := raw.(map[string]any)
	if !ok {
		return TicketNote{}, false
	}
	id, _ := row["id"].(string)
	author, _ := row["author"].(string)
	if id == "" || (author != TicketNoteAuthorPerson && author != TicketNoteAuthorAgent) {
		return TicketNote{}, false
	}
	note := TicketNote{ID: id, Author: author}
	note.Text, _ = row["text"].(string)
	note.SessionID, _ = row["session_id"].(string)
	note.CreatedAtMs = wireInt(row["created_at_ms"])
	note.UpdatedAtMs = wireInt(row["updated_at_ms"])
	return note, true
}

func ticketNoteOpOf(raw any) (TicketNoteOp, bool) {
	row, ok := raw.(map[string]any)
	if !ok {
		return TicketNoteOp{}, false
	}
	id, _ := row["op_id"].(string)
	if id == "" {
		return TicketNoteOp{}, false
	}
	op := TicketNoteOp{OpID: id}
	op.Op, _ = row["op"].(string)
	op.NoteID, _ = row["note_id"].(string)
	op.Text, _ = row["text"].(string)
	op.AtMs = wireInt(row["at_ms"])
	return op, true
}

// TicketNoteOf is the bind-side reader: it converts one already-validated wire
// row (`{id, text, author, updated_at_ms}`) into a note.
func TicketNoteOf(raw any) (TicketNote, bool) { return ticketNoteOf(raw) }

func ticketTurnEndOf(raw any) (TicketTurnEnd, bool) {
	row, ok := raw.(map[string]any)
	if !ok {
		return TicketTurnEnd{}, false
	}
	id, _ := row["turn_id"].(string)
	if id == "" {
		return TicketTurnEnd{}, false
	}
	end := TicketTurnEnd{TurnID: id}
	switch at := row["at_ms"].(type) {
	case int64:
		end.AtMs = at
	case int:
		end.AtMs = int64(at)
	case float64:
		end.AtMs = int64(at)
	}
	return end, true
}

func ticketReportOf(raw any) (TicketReport, bool) {
	row, ok := raw.(map[string]any)
	if !ok {
		return TicketReport{}, false
	}
	id, _ := row["report_id"].(string)
	if id == "" {
		return TicketReport{}, false
	}
	report := TicketReport{ID: id}
	report.Status, _ = row["status"].(string)
	report.Summary, _ = row["summary"].(string)
	report.Question, _ = row["question"].(string)
	if items, ok := row["evidence"].([]any); ok {
		for _, item := range items {
			if text, ok := item.(string); ok {
				report.Evidence = append(report.Evidence, text)
			}
		}
	}
	switch at := row["at_ms"].(type) {
	case int64:
		report.AtMs = at
	case int:
		report.AtMs = int64(at)
	case float64:
		report.AtMs = int64(at)
	}
	return report, true
}

// BindTicket records the binding and reports whether the record changed.
//
// Binding the ticket that is already bound refreshes its title and brief and
// **keeps its reports**: a front end that re-sends the bind (reopening a session)
// must not erase the history it will reconcile against. Binding a different
// ticket starts a fresh list, because reports belong to the ticket they were made
// under.
//
// The second return value is what lets the runtime skip a checkpoint: a front end
// re-sends the same bind on every session open, so "unchanged" is a common case
// and rewriting the session file for it would be a save carrying no new fact.
func BindTicket(metadata map[string]any, spec TicketSpec) (Ticket, bool, error) {
	id := strings.TrimSpace(spec.ID)
	if id == "" {
		return Ticket{}, false, fmt.Errorf("a ticket needs a non-empty id")
	}
	if utf8.RuneCountInString(id) > TicketIDCeiling {
		return Ticket{}, false, fmt.Errorf("the ticket id is longer than %d characters", TicketIDCeiling)
	}
	if utf8.RuneCountInString(spec.Title) > TicketTitleCeiling {
		return Ticket{}, false, fmt.Errorf("the ticket title is longer than %d characters", TicketTitleCeiling)
	}
	if utf8.RuneCountInString(spec.Brief) > TicketBriefCeiling {
		return Ticket{}, false, fmt.Errorf("the ticket brief is longer than %d characters", TicketBriefCeiling)
	}
	if len(spec.Attachments) > MaxTicketAttachments {
		return Ticket{}, false, fmt.Errorf("a ticket takes at most %d attachments", MaxTicketAttachments)
	}
	for _, attachment := range spec.Attachments {
		if err := ValidateTicketAttachment(attachment); err != nil {
			return Ticket{}, false, err
		}
	}
	if err := ValidateTicketNotes(spec.Notes); err != nil {
		return Ticket{}, false, err
	}
	ticket := Ticket{ID: id, Title: spec.Title, Brief: spec.Brief}
	if len(spec.Attachments) > 0 {
		ticket.Attachments = append([]TicketAttachment(nil), spec.Attachments...)
	}
	// Notes are replaced wholesale: the front end's copy is the original, so a
	// note it no longer lists is gone here too (protocol 22).
	if len(spec.Notes) > 0 {
		ticket.Notes = append([]TicketNote(nil), spec.Notes...)
	}
	previous, wasBound := LoadTicket(metadata)
	if wasBound && previous.ID == id {
		ticket.Reports = previous.Reports
		ticket.TurnEnds = previous.TurnEnds
		// The op log is what the front end reconciles against, so it outlives a
		// re-bind exactly like the reports do.
		ticket.NoteOps = previous.NoteOps
	}
	// Compared on the fields a bind can carry, not on the whole record: the
	// reports are carried over untouched just above, so an unchanged re-bind can
	// only differ in one of these four. `!wasBound` is included so the first
	// bind of a ticket is never mistaken for a no-op. Attachments count because
	// they reach the model every round: a changed list that was not saved would
	// be forgotten on resume.
	changed := !wasBound || previous.ID != ticket.ID ||
		previous.Title != ticket.Title || previous.Brief != ticket.Brief ||
		!sameAttachments(previous.Attachments, ticket.Attachments) ||
		!sameNotes(previous.Notes, ticket.Notes)
	metadata[TicketKey] = ticket.Block()
	return ticket, changed, nil
}

// Refusal codes of ApplyTicketNote. The tool turns each into a message that
// tells the model what to do next.
const (
	NoteRefusedUnbound    = "unbound"
	NoteRefusedNotFound   = "not_found"
	NoteRefusedPersonNote = "person_note"
	NoteRefusedTooLong    = "too_long"
	NoteRefusedFull       = "full"
	NoteRefusedTotal      = "total"
	NoteRefusedBadOp      = "bad_op"
)

// TicketNoteChange is what the agent asks for through `ticket_note`.
type TicketNoteChange struct {
	Op        string
	ID        string // update / remove
	Text      string // add / update
	SessionID string
	// NewNoteID and OpID are minted by the caller so this stays deterministic.
	NewNoteID string
	OpID      string
	AtMs      int64
}

// ApplyTicketNote applies one agent write to the metadata copy and logs it in
// note_ops. The returned code is "" on success; on any refusal **nothing** has
// been written. The check and the write happen under the caller's metadata lock,
// so a racing unbind cannot leave a note on a ticket that is gone.
//
// An agent may only touch notes it wrote itself: a person's note is their
// judgement, and the quietest way to lose it is a model "tidying" it.
func ApplyTicketNote(metadata map[string]any, change TicketNoteChange) (Ticket, TicketNoteOp, string) {
	ticket, ok := LoadTicket(metadata)
	if !ok {
		return Ticket{}, TicketNoteOp{}, NoteRefusedUnbound
	}
	notes := append([]TicketNote(nil), ticket.Notes...)
	op := TicketNoteOp{OpID: change.OpID, Op: change.Op, AtMs: change.AtMs}
	index := -1
	if change.Op != TicketNoteOpAdd {
		for position, note := range notes {
			if note.ID == change.ID {
				index = position
				break
			}
		}
		if index < 0 {
			return ticket, TicketNoteOp{}, NoteRefusedNotFound
		}
		if notes[index].Author != TicketNoteAuthorAgent {
			return ticket, TicketNoteOp{}, NoteRefusedPersonNote
		}
	}

	switch change.Op {
	case TicketNoteOpAdd:
		if utf8.RuneCountInString(change.Text) > TicketNoteTextCeiling {
			return ticket, TicketNoteOp{}, NoteRefusedTooLong
		}
		if len(notes) >= MaxTicketNotes {
			return ticket, TicketNoteOp{}, NoteRefusedFull
		}
		if noteRunes(notes)+utf8.RuneCountInString(change.Text) > TicketNotesTotalCeiling {
			return ticket, TicketNoteOp{}, NoteRefusedTotal
		}
		notes = append(notes, TicketNote{
			ID: change.NewNoteID, Text: change.Text, Author: TicketNoteAuthorAgent,
			SessionID: change.SessionID, CreatedAtMs: change.AtMs, UpdatedAtMs: change.AtMs,
		})
		op.NoteID, op.Text = change.NewNoteID, change.Text
	case TicketNoteOpUpdate:
		if utf8.RuneCountInString(change.Text) > TicketNoteTextCeiling {
			return ticket, TicketNoteOp{}, NoteRefusedTooLong
		}
		without := noteRunes(notes) - utf8.RuneCountInString(notes[index].Text)
		if without+utf8.RuneCountInString(change.Text) > TicketNotesTotalCeiling {
			return ticket, TicketNoteOp{}, NoteRefusedTotal
		}
		notes[index].Text = change.Text
		notes[index].UpdatedAtMs = change.AtMs
		op.NoteID, op.Text = change.ID, change.Text
	case TicketNoteOpRemove:
		notes = append(notes[:index], notes[index+1:]...)
		op.NoteID = change.ID
	default:
		return ticket, TicketNoteOp{}, NoteRefusedBadOp
	}

	ticket.Notes = notes
	ticket.NoteOps = append(ticket.NoteOps, op)
	if over := len(ticket.NoteOps) - MaxTicketNoteOps; over > 0 {
		ticket.NoteOps = append([]TicketNoteOp(nil), ticket.NoteOps[over:]...)
	}
	metadata[TicketKey] = ticket.Block()
	return ticket, op, ""
}

// ClearTicket removes the binding and reports whether there was one.
func ClearTicket(metadata map[string]any) bool {
	if _, present := metadata[TicketKey]; !present {
		return false
	}
	delete(metadata, TicketKey)
	return true
}

// AppendTicketReport adds one report to the bound ticket. It reports false when no
// ticket is bound, which is how a call that raced an unbind is turned away: the
// check and the write happen under one metadata lock, so "bound" cannot change
// between them.
func AppendTicketReport(metadata map[string]any, report TicketReport) (Ticket, bool) {
	ticket, ok := LoadTicket(metadata)
	if !ok {
		return Ticket{}, false
	}
	ticket.Reports = append(ticket.Reports, report)
	if over := len(ticket.Reports) - MaxTicketReports; over > 0 {
		ticket.Reports = append([]TicketReport(nil), ticket.Reports[over:]...)
	}
	metadata[TicketKey] = ticket.Block()
	return ticket, true
}

// AppendTicketTurnEnd records one unreported turn end against the bound ticket.
// Like AppendTicketReport it reports false when nothing is bound, under the same
// lock, so a turn that raced an unbind leaves no record.
func AppendTicketTurnEnd(metadata map[string]any, end TicketTurnEnd) (Ticket, bool) {
	ticket, ok := LoadTicket(metadata)
	if !ok {
		return Ticket{}, false
	}
	ticket.TurnEnds = append(ticket.TurnEnds, end)
	if over := len(ticket.TurnEnds) - MaxTicketTurnEnds; over > 0 {
		ticket.TurnEnds = append([]TicketTurnEnd(nil), ticket.TurnEnds[over:]...)
	}
	metadata[TicketKey] = ticket.Block()
	return ticket, true
}

// TicketText is the binding as the payload tail shows it every round.
//
// It is in the tail rather than the history for the reason the goal is: the
// history holds one stale copy per round and compaction folds the oldest away
// first, while the instruction to report is only useful if it is in front of the
// model when it decides it is finished or stuck.
//
// **The brief is quoted only at its head**, and the cut says so in words. The
// tail rides every request, so quoting the whole thing would charge the session
// once per round for text the model read on the first turn; a silent cut would be
// worse still, because the model would take a truncated brief for the whole job.
func TicketText(ticket Ticket) string {
	var builder strings.Builder
	builder.WriteString("## 当前工单（Ticket，运行时持有，跨轮持续）\n\n")
	builder.WriteString("这个会话在为下面这个工单工作。\n")
	if title := strings.TrimSpace(ticket.Title); title != "" {
		builder.WriteString("标题：" + title + "\n")
	}
	if brief := strings.TrimSpace(ticket.Brief); brief != "" {
		builder.WriteString("工作描述：\n" + truncateRunes(brief, TicketTailBriefRunes) + "\n")
	}
	if len(ticket.Attachments) > 0 {
		builder.WriteString("\n这个工单带有附件，已经复制到工作区里，可以直接读取：文本和日志用 read_file，" +
			"docx / pptx / xlsx / pdf 用 read_document。这些文件是用户为这项工作提供的依据，" +
			"动手前先看相关的部分。大日志不要整份读，按行区间读，或先用 grep 定位。\n")
		// Capped by the same limit the bind enforces, so a hand-edited session
		// file cannot make the per-round tail grow without bound.
		shown := ticket.Attachments
		if len(shown) > MaxTicketAttachments {
			shown = shown[:MaxTicketAttachments]
		}
		for _, attachment := range shown {
			builder.WriteString(fmt.Sprintf("- %s: %s (%d bytes)\n", attachment.Name, attachment.Path, attachment.Bytes))
		}
	}
	if len(ticket.Notes) > 0 {
		builder.WriteString("\n")
		builder.WriteString(ticketNotesText(ticket.Notes))
	}
	builder.WriteString("\n做完时调用 ticket_report(status=\"done\", summary=...)；" +
		"卡住、需要用户回答一个具体问题才能继续时，调用 ticket_report(status=\"blocked\", summary=..., question=...)。" +
		"调用它不会结束本轮；done 只是你的声明，是否验收由用户决定。")
	return builder.String()
}

// ticketNotesText is the shared-notes section of the tail.
//
// **Nothing is truncated**: a cut note may be the one that mattered, so the cost
// is bounded by the write-time ceilings instead. Order is by creation time when
// every note says when it was created; a bind only has to carry updated_at_ms,
// and sorting a list that is partly dated would produce an order that depends on
// which rows happened to have the field, so then the slice order (the front
// end's own) stands.
func ticketNotesText(notes []TicketNote) string {
	ordered := append([]TicketNote(nil), notes...)
	dated := true
	for _, note := range ordered {
		if note.CreatedAtMs <= 0 {
			dated = false
		}
	}
	if dated {
		sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].CreatedAtMs < ordered[j].CreatedAtMs })
	}
	var builder strings.Builder
	builder.WriteString("## 工单笔记（跨会话共享；这张工单上的每个会话都能看到）\n\n")
	for _, note := range ordered {
		who := "用户"
		if note.Author == TicketNoteAuthorAgent {
			who = "agent"
		}
		label := note.ID + " · " + who
		when := note.CreatedAtMs
		if when <= 0 {
			when = note.UpdatedAtMs
		}
		if when > 0 {
			label += " · " + time.UnixMilli(when).Format("01-02")
		}
		builder.WriteString("- [" + label + "] " + note.Text + "\n")
	}
	builder.WriteString("\n用户写的条目代表用户的判断，优先级高于你自己的推断。" +
		"用户要求你记录什么时，调用 ticket_note；其余时候不要写。\n")
	return builder.String()
}

// truncateRunes cuts text to at most limit runes and says how much was left out.
//
// Runes rather than bytes because the brief is prose in whatever language the
// person wrote it: cutting a UTF-8 sequence in half produces a replacement
// character in a note the model then reasons about.
func truncateRunes(text string, limit int) string {
	total := utf8.RuneCountInString(text)
	if total <= limit {
		return text
	}
	cut := []rune(text)[:limit]
	return string(cut) + fmt.Sprintf("\n……（工单描述共 %d 字，这里只引用前 %d 字；完整内容在会话的第一条消息里，不在的话读附件 brief.md）", total, limit)
}
