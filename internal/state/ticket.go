package state

import (
	"fmt"
	"strings"
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

// Ticket is the binding plus the reports made under it.
type Ticket struct {
	ID      string
	Title   string
	Brief   string
	Reports []TicketReport
	// Attachments is what the front end staged into the workspace (protocol 19).
	Attachments []TicketAttachment
}

// TicketSpec is what a bind carries.
type TicketSpec struct {
	ID          string
	Title       string
	Brief       string
	Attachments []TicketAttachment
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
	return map[string]any{
		"id":          t.ID,
		"title":       t.Title,
		"brief":       t.Brief,
		"reports":     reports,
		"attachments": attachments,
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
	return ticket, true
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
	ticket := Ticket{ID: id, Title: spec.Title, Brief: spec.Brief}
	if len(spec.Attachments) > 0 {
		ticket.Attachments = append([]TicketAttachment(nil), spec.Attachments...)
	}
	previous, wasBound := LoadTicket(metadata)
	if wasBound && previous.ID == id {
		ticket.Reports = previous.Reports
	}
	// Compared on the fields a bind can carry, not on the whole record: the
	// reports are carried over untouched just above, so an unchanged re-bind can
	// only differ in one of these four. `!wasBound` is included so the first
	// bind of a ticket is never mistaken for a no-op. Attachments count because
	// they reach the model every round: a changed list that was not saved would
	// be forgotten on resume.
	changed := !wasBound || previous.ID != ticket.ID ||
		previous.Title != ticket.Title || previous.Brief != ticket.Brief ||
		!sameAttachments(previous.Attachments, ticket.Attachments)
	metadata[TicketKey] = ticket.Block()
	return ticket, changed, nil
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
	builder.WriteString("\n做完时调用 ticket_report(status=\"done\", summary=...)；" +
		"卡住、需要用户回答一个具体问题才能继续时，调用 ticket_report(status=\"blocked\", summary=..., question=...)。" +
		"调用它不会结束本轮；done 只是你的声明，是否验收由用户决定。")
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
	return string(cut) + fmt.Sprintf("\n……（工单描述共 %d 字，这里只引用前 %d 字；完整内容在会话的第一条消息里）", total, limit)
}
