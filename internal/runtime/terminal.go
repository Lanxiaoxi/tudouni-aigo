package runtime

import (
	"fmt"

	"github.com/Lanxiaoxi/tudouni-aigo/internal/terminal"
)

// --- the terminal surface a front end drives --------------------------------
//
// Every method below is a thin translation between the protocol's vocabulary and
// `terminal.Manager`'s. That thinness is the point: the manager owns the PTY, the
// lifecycle and the coalescing, and this layer owns nothing but the shapes — so
// there is exactly one place where "what a terminal is" is decided.
//
// **None of it enters the audit log.** A shell is a runtime resource with its own
// event channel, and the design is explicit that its output must not reach the
// session history, the context or the artifact store. The audit is deliberately
// included in that: a terminal writes an unbounded stream, and a log that carried
// it would be a second terminal — one that grows without limit, on disk, with no
// way to scroll it.

// terminalUnavailable is the refusal every terminal method shares. It is one
// sentence rather than five because the reason is the same one: this runtime was
// built without a terminal manager (a test double, or a future front end that
// mounts the protocol without `Boot`). Refusing beats an empty list, which would
// read as "there are no terminals" — a different statement, and a false one.
const terminalUnavailable = "this runtime has no terminal manager"

// ListTerminals answers `terminal_list`.
//
// The answer is the **whole workspace's** list, not this session's: terminals
// belong to the workspace, so switching sessions must not make them appear or
// vanish. Rows are built by the manager (`Info.Row`), which is the one place the
// shape is defined.
func (r *Runtime) ListTerminals() []map[string]any {
	if r.Terminals == nil {
		return []map[string]any{}
	}
	infos := r.Terminals.List()
	rows := make([]map[string]any, 0, len(infos))
	for _, info := range infos {
		rows = append(rows, info.Row())
	}
	return rows
}

// CreateTerminal answers `terminal_create`.
//
// The cwd is resolved against the workspace by the manager before anything is
// spawned, so a request that escapes is refused with no process left behind.
//
// A refusal is an **error**, and that is a protocol decision rather than a Go
// one: the answer to a successful create is a `terminal_created` carrying the row,
// and a failure has no row to carry. Answering with an empty row would give a
// front end an id to remember for a shell that does not exist. The caller turns
// this into a notice plus a fresh full list.
func (r *Runtime) CreateTerminal(cwd string, cols, rows int) (map[string]any, error) {
	if r.Terminals == nil {
		return nil, fmt.Errorf("%s", terminalUnavailable)
	}
	info, err := r.Terminals.Create(cwd, cols, rows)
	if err != nil {
		return nil, err
	}
	return info.Row(), nil
}

// TerminalInput answers `terminal_input`, or rather does not answer it.
//
// There is no return payload on success, and that is the design's shape rather
// than an omission: a terminal is `command → PTY → asynchronous output`, not
// `input → wait for the complete output → respond`. A front end that treated this
// as an RPC would block on a reply that never comes for a command that prints
// nothing, and would have no way to show a program that is waiting for input —
// which is most of what a terminal does.
func (r *Runtime) TerminalInput(id, data string) error {
	if r.Terminals == nil {
		return fmt.Errorf("%s", terminalUnavailable)
	}
	return r.Terminals.Input(id, data)
}

// TerminalResize answers `terminal_resize`. See terminal.Manager.Resize for why a
// nonsensical size is ignored rather than clamped.
func (r *Runtime) TerminalResize(id string, cols, rows int) error {
	if r.Terminals == nil {
		return fmt.Errorf("%s", terminalUnavailable)
	}
	return r.Terminals.Resize(id, cols, rows)
}

// TerminalKill answers `terminal_kill`.
//
// It reports only that the request was accepted. The ending itself arrives as the
// `terminal_exit` event the manager emits from the same code path a shell that
// exited by itself goes through, because the design's rule is that **the runtime
// is the only source of truth for whether a terminal is running** — a kill that
// answered "done" directly would be a second truth, and the two would disagree
// whenever a process refused to die.
func (r *Runtime) TerminalKill(id string) error {
	if r.Terminals == nil {
		return fmt.Errorf("%s", terminalUnavailable)
	}
	return r.Terminals.Kill(id)
}

// RemoveTerminal answers `terminal_close`.
//
// It drops a terminal that has already ended from the workspace's list. The
// manager refuses one that is still running, and that refusal is the point
// rather than an inconvenience: a record that disappeared while its process kept
// going would be a terminal nobody can see and nobody can end.
//
// Unlike `terminal_kill` this **does** answer with the resulting list. The two
// differ because they change different things: a kill ends a process, and the
// ending has its own event (`terminal_exit`) emitted from the wait path, so a
// reply here would be a second truth about whether the shell is running; a close
// changes the list, and the list is the only thing that can report it.
func (r *Runtime) RemoveTerminal(id string) error {
	if r.Terminals == nil {
		return fmt.Errorf("%s", terminalUnavailable)
	}
	return r.Terminals.Remove(id)
}

// terminalsPanel is the `terminals` array on every `ui(state)` snapshot.
//
// Always `[]` and never nil, for the reason every other panel list follows that
// rule: a front end that has to tell "there are none" apart from "the runtime did
// not say" is a front end with a second definition of the panel's shape, and the
// first bug it produces is a crash on the empty case.
//
// Carrying the list here as well as on `terminal_list` is not redundancy. The
// snapshot is sent on every tool result and at the end of every turn, so a front
// end that started *after* a shell was created — or one that lost a message —
// learns about it from the next snapshot rather than never. It also means a front
// end can implement terminals without ever asking `terminal_list`.
func (r *Runtime) terminalsPanel() []any {
	if r.Terminals == nil {
		return []any{}
	}
	infos := r.Terminals.List()
	rows := make([]any, 0, len(infos))
	for _, info := range infos {
		rows = append(rows, info.Row())
	}
	return rows
}

// terminalEventPayload renders one manager event as the `ui` message body the
// protocol layer sends.
//
// It lives here rather than in the protocol package for the reason the rest of
// this file exists: the mapping from "an event a terminal produced" to "what
// travels" is a fact about terminals, and the protocol layer is deliberately
// ignorant of what one is. The protocol layer's job is to put an envelope on this
// and write it down.
//
// `terminal_output` carries the id and the bytes and **nothing else** — that is
// the high-frequency message, and repeating a full row on every batch would
// multiply the cost of the one thing that is sent thousands of times. The exit
// carries the whole row instead, because it is sent once and because a front end
// replacing the row is simpler and less error-prone than patching two fields.
func terminalEventPayload(event terminal.Event) map[string]any {
	switch event.Kind {
	case terminal.EventOutput:
		return map[string]any{
			"kind":        "terminal_output",
			"terminal_id": event.Info.ID,
			"data":        event.Data,
		}
	case terminal.EventExit:
		// `exit_code` appears twice on purpose — once inside the row and once
		// beside it. They are written from the same value here, so they cannot
		// disagree, and a consumer that only wants the number does not have to
		// unwrap the row to get it.
		payload := map[string]any{
			"kind":        "terminal_exit",
			"terminal_id": event.Info.ID,
			"terminal":    event.Info.Row(),
			"reason":      event.Reason,
		}
		if event.Info.ExitCode == nil {
			payload["exit_code"] = nil
		} else {
			payload["exit_code"] = *event.Info.ExitCode
		}
		return payload
	default:
		// An event kind this build does not know. Returning nil means "nothing to
		// send", which is the safe direction: inventing a payload for a kind the
		// front end has never heard of would be a message it cannot parse.
		return nil
	}
}
