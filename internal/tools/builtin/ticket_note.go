package builtin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/i18n"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/security"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools"
)

// TicketNoteToolName is the model-facing name. A constant for the same reason as
// TicketReportToolName: the runtime's register/unregister and the sub-agent's
// exclusion list both spell it.
const TicketNoteToolName = "ticket_note"

// TicketNoteBoard is the notes side of a ticket binding (protocol 22).
//
// The front end owns the notes; this edits the runtime's **copy** so the change
// is visible in the very next payload tail, logs it in `note_ops`, and forwards
// it. The ordering rule is the report's: Commit has returned before Emit runs.
type TicketNoteBoard struct {
	meta      *state.Meta
	sessionID string
	// Commit persists the metadata. Nil means in-memory only (tests).
	Commit func()
	// Emit announces a recorded write; called only after Commit.
	Emit func(payload map[string]any)
	// Now, NewID and NewOpID are seams for tests.
	Now     func() time.Time
	NewID   func(at time.Time) string
	NewOpID func() string
}

// NewTicketNote builds the ticket_note tool over a session's metadata.
func NewTicketNote(meta *state.Meta, sessionID string, commit func(), emit func(payload map[string]any)) tools.Tool {
	if meta == nil {
		meta = state.NewMeta(nil)
	}
	board := &TicketNoteBoard{
		meta: meta, sessionID: sessionID, Commit: commit, Emit: emit,
		Now: time.Now, NewID: newNoteID, NewOpID: newNoteOpID,
	}
	return board.Tool()
}

// Tool is the model-facing tool over this board.
func (b *TicketNoteBoard) Tool() tools.Tool {
	return tools.Tool{
		Name: TicketNoteToolName,
		Description: `在当前工单的「笔记」里记录、修改或删除一条内容。笔记是这张工单上**所有会话共享**的上下文：今天写下的结论、决策、用户的判断，明天另一个会话打开时都能在系统提示里看到。
**只在用户明确要求你记录某件事时调用**（例如"把这个结论记到笔记里"）。不要自作主张记录，也不要用它代替 ticket_report 或最终回答。
- op="add"：新增一条，text 必填。一条笔记写一件事，用 Markdown，简短、可独立阅读；不要贴大段日志或代码。
- op="update"：改写一条你之前写的笔记，id 和 text 必填。
- op="remove"：删除一条你之前写的笔记，id 必填。
你只能改、删 author 是 agent 的条目；用户写的条目不能动，想改它请在回复里向用户提出。笔记有条数和字数上限，满了先合并或删掉你写过的旧条目。
只有会话绑定了工单时这个工具才存在。`,
		Risk: security.RiskLow,
		Schema: tools.ObjectSchema(map[string]any{
			"op": tools.StringSchema(
				"add 新增 / update 改写自己写的条目 / remove 删除自己写的条目",
				tools.Enum(state.TicketNoteOpAdd, state.TicketNoteOpUpdate, state.TicketNoteOpRemove),
			),
			"id":   tools.StringSchema("update / remove 必填：笔记 id（见系统提示里「工单笔记」的方括号）；只能是你（agent）写的条目"),
			"text": tools.StringSchema("add / update 必填：笔记正文，Markdown"),
		}, "op"),
		ParallelSafe: false,
		Interactive:  false,
		Handler: func(ctx context.Context, args map[string]any) (tools.Result, error) {
			return b.Note(args)
		},
	}
}

// Note handles one ticket_note call.
//
// As with Report, a malformed or refused call is an invalid-arguments error (the
// model can fix it by calling again, and the message says how), while a call that
// arrives after the unbind is a normal answer.
func (b *TicketNoteBoard) Note(args map[string]any) (tools.Result, error) {
	op := stringOf(args["op"])
	id := strings.TrimSpace(stringOf(args["id"]))
	text := strings.TrimSpace(stringOf(args["text"]))

	switch op {
	case state.TicketNoteOpAdd:
		if text == "" {
			return tools.Result{}, invalidNote("ticket.note.needs_text")
		}
	case state.TicketNoteOpUpdate:
		if id == "" || text == "" {
			return tools.Result{}, invalidNote("ticket.note.update_needs")
		}
	case state.TicketNoteOpRemove:
		if id == "" {
			return tools.Result{}, invalidNote("ticket.note.needs_id")
		}
	default:
		return tools.Result{}, invalidNote("ticket.note.bad_op")
	}

	now := b.Now()
	change := state.TicketNoteChange{
		Op: op, ID: id, Text: text, SessionID: b.sessionID,
		NewNoteID: b.NewID(now), OpID: b.NewOpID(), AtMs: now.UnixMilli(),
	}

	// Check and write share one lock (see ApplyTicketNote), and a refusal writes
	// nothing, so there is nothing to undo and nothing to announce.
	var ticket state.Ticket
	var applied state.TicketNoteOp
	var refused string
	b.meta.Write(func(metadata map[string]any) {
		ticket, applied, refused = state.ApplyTicketNote(metadata, change)
	})
	switch refused {
	case "":
	case state.NoteRefusedUnbound:
		return tools.Result{
			Text:  i18n.T("ticket.note.unbound"),
			Audit: map[string]any{"ticket_bound": false},
		}, nil
	default:
		return tools.Result{}, invalidNote("ticket.note.refused." + refused)
	}

	// Persist first, announce second: a front end that has seen the message must
	// be able to find the op again in `init.ticket.note_ops`.
	if b.Commit != nil {
		b.Commit()
	}
	if b.Emit != nil {
		payload := applied.Wire()
		payload["kind"] = "ticket_note"
		payload["ticket_id"] = ticket.ID
		payload["session_id"] = b.sessionID
		b.Emit(payload)
	}

	return tools.Result{
		Text: i18n.T("ticket.note.recorded."+op, "id", applied.NoteID),
		Audit: map[string]any{
			"ticket_bound": true,
			"ticket_id":    ticket.ID,
			"ticket_note":  applied.NoteID,
			"ticket_op":    op,
		},
	}, nil
}

func invalidNote(key string) error {
	return &tools.InvalidArgumentsError{Msg: i18n.T(key)}
}

// newNoteID mints `nt-<base36 ms>-<random>`, the shape the desktop mints too, so
// an id does not reveal who wrote the note. The random tail keeps two sessions
// writing in the same millisecond apart.
func newNoteID(at time.Time) string {
	var raw [3]byte
	suffix := ""
	if _, err := rand.Read(raw[:]); err == nil {
		suffix = hex.EncodeToString(raw[:])
	} else {
		suffix = strconv.FormatInt(at.UnixNano()%46656, 36)
	}
	return "nt-" + strconv.FormatInt(at.UnixMilli(), 36) + "-" + suffix
}

// newNoteOpID mints an op id. Random for the reason report ids are: it is the
// front end's idempotency key across sessions and restarts.
func newNoteOpID() string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "nop-" + time.Now().Format("20060102150405.000000000")
	}
	return "nop-" + hex.EncodeToString(raw[:])
}
