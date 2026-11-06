package builtin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// TicketReportToolName is the model-facing name.
//
// A constant because the runtime's register/unregister and the sub-agent's
// session-scoped exclusion list both spell it, and a rename that missed one would
// leave a child agent holding a tool that writes its parent's metadata.
const TicketReportToolName = "ticket_report"

// TicketBoard is the reporting side of a ticket binding.
//
// The runtime does not know what a ticket's state machine is; this only records
// what the agent says and forwards it. The three injected functions keep it free of
// the runtime and the protocol layer, which is also what makes the ordering rule
// testable: Commit must have returned before Emit is called.
type TicketBoard struct {
	meta      *state.Meta
	sessionID string
	// Commit persists the metadata. Nil is legal (tests, one-shot use) and means the
	// report is in memory only.
	Commit func()
	// Emit announces a recorded report to the front end. It is called **after** Commit,
	// so a front end that has seen the message can always find the report again in
	// `init.ticket.reports`. Nil means nobody is listening.
	Emit func(payload map[string]any)
	// Now and NewID are seams for tests.
	Now   func() time.Time
	NewID func() string
}

// NewTicketReport builds the ticket_report tool over a session's metadata.
func NewTicketReport(meta *state.Meta, sessionID string, commit func(), emit func(payload map[string]any)) tools.Tool {
	if meta == nil {
		meta = state.NewMeta(nil)
	}
	board := &TicketBoard{
		meta: meta, sessionID: sessionID, Commit: commit, Emit: emit,
		Now: time.Now, NewID: newReportID,
	}
	return board.Tool()
}

// Tool is the model-facing tool over this board.
func (b *TicketBoard) Tool() tools.Tool {
	return tools.Tool{
		Name: TicketReportToolName,
		Description: `向用户回报当前工单（Ticket）的进展。这个会话绑定了一个工单，这是你把"做完了"或"卡住了"告诉用户的正式通道。
- 工作做完时：调用 status="done"，summary 写做了什么；有验证命令、PR 链接、文件路径之类的凭据就放进 evidence。done 只是你的声明，是否验收由用户决定，所以不要夸大。
- 卡住、并且需要用户回答一个具体问题才能继续时：调用 status="blocked"，summary 写卡在哪，question 写**一个**只有用户能回答的具体问题（必填）。难度大、还没做完、还能自己继续查，都不算 blocked。
调用它不会结束本轮；报完 done 之后给出最终回答即可，报完 blocked 之后以那个问题结束本轮。
只有会话绑定了工单时这个工具才存在。`,
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"status": tools.StringSchema(
				"done 做完了 / blocked 卡住了，需要用户回答一个问题",
				tools.Enum(state.TicketStatusDone, state.TicketStatusBlocked),
			),
			"summary": tools.StringSchema("给人看的简短说明：做了什么（done）或卡在哪（blocked）", tools.MinLength(1)),
			"question": tools.StringSchema(
				"仅 status=blocked，且必填：一个具体问题，只有用户能回答",
			),
			"evidence": tools.ArraySchema(
				"可选：验证命令、PR 链接、文件路径等凭据，每条一个字符串",
				map[string]any{"type": "string"},
			),
		}, "status", "summary"),
		ParallelSafe: false,
		Interactive:  false,
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			return b.Report(args)
		},
	}
}

// Report handles one ticket_report call.
//
// A malformed call (no summary, a blocked report with no question) is an
// invalid-arguments error: it is the model's mistake and it can fix it by calling
// again. A call that arrives after the unbind is a normal answer instead, because
// there is nothing for the model to correct.
func (b *TicketBoard) Report(args map[string]any) (tools.Result, error) {
	status := stringOf(args["status"])
	summary := strings.TrimSpace(stringOf(args["summary"]))
	question := strings.TrimSpace(stringOf(args["question"]))

	switch status {
	case state.TicketStatusDone, state.TicketStatusBlocked:
	default:
		return tools.Result{}, &tools.InvalidArgumentsError{Msg: i18n.T("ticket.report.bad_status")}
	}
	if summary == "" {
		return tools.Result{}, &tools.InvalidArgumentsError{Msg: i18n.T("ticket.report.needs_summary")}
	}
	if status == state.TicketStatusBlocked && question == "" {
		return tools.Result{}, &tools.InvalidArgumentsError{Msg: i18n.T("ticket.report.needs_question")}
	}
	// `question` only means something on a blocked report; carrying it on a done one
	// would make the front end show a question nobody is waiting on.
	if status == state.TicketStatusDone {
		question = ""
	}

	report := state.TicketReport{
		ID:       b.NewID(),
		Status:   status,
		Summary:  summary,
		Question: question,
		Evidence: evidenceOf(args["evidence"]),
		AtMs:     b.Now().UnixMilli(),
	}

	// The bound check and the write share one lock, so an unbind that lands between
	// "the model decided to report" and "the report is stored" turns the call away
	// instead of recording a report against a ticket that is no longer ours.
	var ticket state.Ticket
	var bound bool
	b.meta.Write(func(metadata map[string]any) {
		ticket, bound = state.AppendTicketReport(metadata, report)
	})
	if !bound {
		return tools.Result{
			Text:  i18n.T("ticket.report.unbound"),
			Audit: map[string]any{"ticket_bound": false},
		}, nil
	}

	// Persist first, announce second. Reversed, a front end that crashed right after
	// receiving the message would find, on reopening, a report the file never held.
	if b.Commit != nil {
		b.Commit()
	}
	if b.Emit != nil {
		payload := report.Wire()
		payload["kind"] = "ticket_report"
		payload["ticket_id"] = ticket.ID
		payload["session_id"] = b.sessionID
		b.Emit(payload)
	}

	return tools.Result{
		Text: i18n.T("ticket.report.recorded."+status, "id", report.ID),
		Audit: map[string]any{
			"ticket_bound":  true,
			"ticket_id":     ticket.ID,
			"ticket_report": report.ID,
			"ticket_status": status,
		},
	}, nil
}

// evidenceOf reads the optional evidence list, dropping blanks. Validation has
// already checked the items are strings; the type switch is for a handler reached
// without it.
func evidenceOf(raw any) []string {
	items, ok := raw.([]any)
	if !ok {
		if direct, ok := raw.([]string); ok {
			items = make([]any, 0, len(direct))
			for _, item := range direct {
				items = append(items, item)
			}
		}
	}
	var out []string
	for _, item := range items {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
			out = append(out, text)
		}
	}
	return out
}

// newReportID mints a report id. Random rather than a counter: the id is the
// front end's idempotency key across sessions and restarts, and a counter that
// restarted would collide with ids it has already processed.
func newReportID() string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "rpt-" + time.Now().Format("20060102150405.000000000")
	}
	return "rpt-" + hex.EncodeToString(raw[:])
}
