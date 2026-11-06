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
)

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
}

// TicketSpec is what a bind carries.
type TicketSpec struct {
	ID    string
	Title string
	Brief string
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
	return map[string]any{
		"id":      t.ID,
		"title":   t.Title,
		"brief":   t.Brief,
		"reports": reports,
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
	ticket := Ticket{ID: id, Title: spec.Title, Brief: spec.Brief}
	previous, wasBound := LoadTicket(metadata)
	if wasBound && previous.ID == id {
		ticket.Reports = previous.Reports
	}
	// Compared on the fields a bind can carry, not on the whole record: the
	// reports are carried over untouched just above, so an unchanged re-bind can
	// only differ in one of these three. `!wasBound` is included so the first
	// bind of a ticket is never mistaken for a no-op.
	changed := !wasBound || previous.ID != ticket.ID ||
		previous.Title != ticket.Title || previous.Brief != ticket.Brief
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
