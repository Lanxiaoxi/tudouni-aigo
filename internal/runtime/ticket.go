package runtime

import (
	"fmt"

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
			ID:    stringOf(spec["id"]),
			Title: stringOf(spec["title"]),
			Brief: stringOf(spec["brief"]),
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
func (r *Runtime) emitTicketEvent(payload map[string]any) {
	if r.onTicketEvent != nil {
		r.onTicketEvent(payload)
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
