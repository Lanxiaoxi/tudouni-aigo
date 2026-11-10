package runtime

import (
	"fmt"
	"time"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/state"
	"github.com/Lanxiaoxi/tudouni-aigo/internal/tools/builtin"
)

// The ticket binding, runtime side.
//
// The runtime only remembers "I am working for ticket X" (in session metadata, beside
// the goal), offers the model a reporting tool while that is true, and forwards each
// report. It never interprets the ticket: the ticket's state lives on the front end.

// ticket reads the binding under the metadata lock.
func (r *Runtime) ticket() (state.Ticket, bool) {
	var ticket state.Ticket
	var ok bool
	r.meta().Read(func(metadata map[string]any) { ticket, ok = state.LoadTicket(metadata) })
	return ticket, ok
}

// BindTicket implements protocol.TicketBinder. A nil spec unbinds.
//
// The metadata is written, checkpointed, and only then is the tool set changed, so
// the file never claims a binding the registry has not caught up with.
//
// **A re-bind that changes nothing is checkpointed by nobody.** The front end
// sends this on every session open, and the common case is the same ticket with
// the same title and brief — writing the session file for that would be a save per
// open carrying no new fact. `BindTicket` reports whether the record actually
// moved so the decision is made where the comparison is, rather than guessed at
// here. The tool registry is reconciled either way: a resumed session can come back
// with a binding the registry has not caught up with, and `applyTicketTool` is
// cheap and idempotent.
func (r *Runtime) BindTicket(spec map[string]any) error {
	if r.SessionValue == nil {
		return fmt.Errorf("no session is mounted")
	}
	var err error
	changed := false
	r.meta().Write(func(metadata map[string]any) {
		if spec == nil {
			changed = state.ClearTicket(metadata)
			return
		}
		_, changed, err = state.BindTicket(metadata, state.TicketSpec{
			ID:          stringOf(spec["id"]),
			Title:       stringOf(spec["title"]),
			Brief:       stringOf(spec["brief"]),
			Attachments: attachmentsOf(spec["attachments"]),
		})
	})
	if err != nil {
		return err
	}
	if changed {
		r.Checkpoint()
	}
	return r.applyTicketTool()
}

// attachmentsOf reads the bind's attachment list. A row that does not parse is
// dropped here only because the protocol layer has already refused such binds;
// BindTicket validates again, so nothing unchecked reaches the record.
func attachmentsOf(raw any) []state.TicketAttachment {
	rows, _ := raw.([]any)
	var out []state.TicketAttachment
	for _, row := range rows {
		if attachment, ok := state.TicketAttachmentOf(row); ok {
			out = append(out, attachment)
		}
	}
	return out
}

// applyTicketTool brings the registry in line with the binding: registered while a
// ticket is bound, absent otherwise.
//
// Called at assembly (a resumed session comes back bound) and after every bind. A
// tool that is only ever answering "no ticket" would cost a schema in every request
// and teach the model that tools lie, which is the rule `code_explore` follows.
func (r *Runtime) applyTicketTool() error {
	if r.Tools == nil || r.SessionValue == nil {
		return nil
	}
	_, bound := r.ticket()
	_, present := r.Tools.Get(builtin.TicketReportToolName)
	switch {
	case !bound && present:
		r.Tools.Unregister(builtin.TicketReportToolName)
	case bound && !present:
		tool := builtin.NewTicketReport(r.meta(), r.SessionIDValue, r.Checkpoint, r.emitTicketEvent)
		if err := r.Tools.Register(tool); err != nil {
			return fmt.Errorf("could not register %s: %w", builtin.TicketReportToolName, err)
		}
	}
	return nil
}

// emitTicketEvent reads the hook at call time rather than capturing it, so a hook
// installed after the tool was registered is still the one that is called.
//
// It is also where "this turn has reported" is noted: the tool only calls it after
// a report was validated and recorded, so a refused call (no question on a blocked
// report, a call after the unbind) never counts as having reported.
func (r *Runtime) emitTicketEvent(payload map[string]any) {
	if kind, _ := payload["kind"].(string); kind == "ticket_report" {
		r.ticketReported.Store(true)
	}
	if r.onTicketEvent != nil {
		r.onTicketEvent(payload)
	}
}

// beginTicketTurn forgets the previous turn's report. Called where a turn really
// starts — a person's turn in RunTurn, an automatic round once it is admitted — so
// the question asked at the end is about this turn only.
func (r *Runtime) beginTicketTurn() { r.ticketReported.Store(false) }

// ObserveTicketTurn implements protocol.TicketTurnObserver (protocol 21).
//
// The protocol layer calls it only for a turn that **answered** and after which no
// automatic round was queued — the two conditions it is the one to know. The two
// left are checked here: a ticket is bound, and this turn made no report. Then the
// fact is recorded and announced, in that order, for the reason reports are: an
// announced fact must be recoverable from `init.ticket.turn_ends`.
//
// This never says the work is done. It says the agent stopped without saying, and
// what that means for the ticket is the front end's state machine's call.
func (r *Runtime) ObserveTicketTurn(turnID string) {
	if r.SessionValue == nil || turnID == "" || r.ticketReported.Load() {
		return
	}
	end := state.TicketTurnEnd{TurnID: turnID, AtMs: time.Now().UnixMilli()}
	var ticket state.Ticket
	var bound bool
	r.meta().Write(func(metadata map[string]any) {
		ticket, bound = state.AppendTicketTurnEnd(metadata, end)
	})
	if !bound {
		return
	}
	r.Checkpoint()
	if r.onTicketEvent != nil {
		r.onTicketEvent(map[string]any{
			"kind":       "ticket_turn_end",
			"ticket_id":  ticket.ID,
			"turn_id":    end.TurnID,
			"session_id": r.SessionIDValue,
			"at_ms":      end.AtMs,
		})
	}
}

// ticketInit is `init.ticket`: the binding with every report, or nil when unbound.
// The key is always present in `init` so a front end has one case to read; nil
// marshals to JSON null.
func (r *Runtime) ticketInit() any {
	ticket, ok := r.ticket()
	if !ok {
		return nil
	}
	return ticket.Block()
}
