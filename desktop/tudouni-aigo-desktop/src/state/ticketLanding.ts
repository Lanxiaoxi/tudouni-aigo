/**
 * Where a session's facts become a Ticket's facts.
 *
 * The runtime slice receives `init`, `ui(ticket_report)` and `runtime_exited`;
 * the composer sends the person's messages. None of them knows what a Ticket
 * is, and none of them should: each calls one function here, and this file
 * turns it into the fact the machine (`ticket/machine.ts`) understands and
 * hands it to `dispatchTicket`. It decides nothing about a status.
 *
 * Two rules run through all of it:
 *
 *   - **Nothing is dropped because the file has not been read yet.** The
 *     Tickets load at start-up, but a session's first messages can beat them;
 *     a fact that arrives early waits for the read (`whenLoaded`) instead of
 *     being refused with `not_loaded` and lost.
 *   - **Nothing is concluded from a list this window may not have read.** The
 *     binding check treats a missing Ticket as stale, so a failed or read-only
 *     load (an empty list that is not the person's list) must never reach it:
 *     it would unbind every session that asked.
 */
import type { StoreContext } from './storeContext';
import type { VmInit } from '@/runtime/adapt';
import { projectTicketNote, projectTicketReport, projectTicketTurnEnd } from '@/runtime/adapt';
import { sendTo } from '@/runtime/bus';
import type { UiTicketNoteMsg, UiTicketReportMsg, UiTicketTurnEndMsg } from '@/protocol/types';
import { bindingIsStale, currentAssignment, isPresentSession, presentSessions, sessionOwns } from '@/ticket/machine';
import { TICKET_MIN_PROTOCOL, TICKET_NOTES_MIN_PROTOCOL, type Ticket, type WorkerSession } from '@/ticket/model';
import { rebindSession } from './ticketBind';

/** Run `run` now if the Tickets are in memory, otherwise once they are. */
function whenLoaded(ctx: StoreContext, run: () => void): void {
  if (ctx.get().ticketsLoaded) {
    run();
    return;
  }
  ctx
    .get()
    .loadTickets()
    .then(run)
    .catch((err: unknown) => console.warn('a Ticket fact could not be landed:', err));
}

/** The present session of `ticket`'s worker that a (key, id) pair names, by the
 *  same identity rule the machine uses (`sessionOwns`), or `null`. */
function presentSessionOf(ticket: Ticket, key: string, sessionId: string): WorkerSession | null {
  const ref = { sessionKey: key, sessionId };
  return presentSessions(currentAssignment(ticket)).find((s) => sessionOwns(s, ref)) ?? null;
}

/**
 * Whether `init` should write the new key or id into the worker's session.
 *
 * Two cases, both "the same session, newly seen": a session resumed by hand
 * (`/resume`, the saved list) comes back with a **new key** and the id the
 * record already holds; and a fresh start whose `init` has not been written
 * back yet has the key but no id. The machine treats a repeat of either as a
 * no-op, so asking twice (this, and the Ticket's own start) is free.
 */
function needsBackfill(session: WorkerSession, key: string, sessionId: string): boolean {
  const { sessionKey, sessionId: known } = session;
  if (known === sessionId && sessionKey !== key) return true;
  return sessionKey === key && known === '';
}
/**
 * `init` arrived: teach the Assignment this session's key and id, fold in the
 * reports the window missed, and clear a binding that no longer holds
 * (design 5.1, 6.3). **In that order**: a missed report can be what makes the
 * binding current, and the runtime deletes the whole record, reports included,
 * when it is unbound.
 */
export function landTicketInit(ctx: StoreContext, key: string, init: VmInit): void {
  // An older runtime has no bind and no reports; there is nothing to reconcile
  // and nothing it could be told.
  if (init.protocol < TICKET_MIN_PROTOCOL) return;
  const binding = init.ticket;
  // Unbound is the state the Ticket side wants to be in unless it said
  // otherwise: nothing to do.
  if (binding === null || init.sessionId === '') return;

  whenLoaded(ctx, () => {
    const s = ctx.get();
    const bucket = s.sessions[key];
    // Gone, or the key now belongs to another session: the handshake is stale.
    if (bucket === undefined || bucket.sessionId !== init.sessionId) return;
    // See the header: an unread list would read every binding as stale.
    if (!s.ticketsLoaded || s.ticketsReadOnly) return;

    const ticket = s.tickets.find((row) => row.id === binding.id);
    if (ticket !== undefined) {
      const session = presentSessionOf(ticket, key, init.sessionId);
      if (session !== null && needsBackfill(session, key, init.sessionId)) {
        s.dispatchTicket(ticket.id, {
          type: 'sessionStarted',
          sessionKey: key,
          sessionId: init.sessionId,
        });
      }
      // Reports, turn ends and note writes are folded in **together, by time**:
      // a note op is a fact like the other two, and replaying the three lists one
      // after the other would reorder what the session did.
      ctx.get().reconcileTicket(ticket.id, binding.reports, binding.turnEnds, binding.noteOps);
    }

    // Re-read: the two calls above replaced the Ticket.
    const after = ctx.get().tickets.find((row) => row.id === binding.id);
    if (bindingIsStale(after, init.sessionId)) {
      sendTo(key, { v: 1, t: 'ticket_bind', ticket: null });
      return;
    }
    // The binding holds. Remember what the runtime says it holds (a re-bind
    // replays it), then tell it the canonical notes: the runtime's copy is only
    // a copy, and this window may have changed the list while the session was
    // closed. Only from protocol 22, and only when the sentence differs would
    // the runtime write anything (state.BindTicket compares).
    if (after !== undefined) {
      ctx.patch(key, {
        ticketSpec: {
          ticketId: binding.id,
          title: binding.title,
          brief: binding.brief,
          attachments: binding.attachments,
        },
      });
      if (init.protocol >= TICKET_NOTES_MIN_PROTOCOL) rebindSession(ctx, key, after);
    }
  });
}

/** `ui(ticket_report)`: the agent said something; the machine decides what it
 *  means. Idempotent by report id, so a replay by `init` is harmless. */
export function landTicketReport(ctx: StoreContext, msg: UiTicketReportMsg): void {
  const projected = projectTicketReport(msg);
  if (projected === null) return;
  whenLoaded(ctx, () => {
    ctx.get().ingestTicketReport(projected.ticketId, projected.report);
  });
}

/** `ui(ticket_note)`: the agent wrote, changed or removed a note. The machine
 *  decides whether it counts (a present session, an agent-written note) and the
 *  slice re-binds every live session with the canonical list afterwards.
 *  Idempotent by op id, so a replay by `init` is harmless. */
export function landTicketNote(ctx: StoreContext, msg: UiTicketNoteMsg): void {
  const projected = projectTicketNote(msg);
  if (projected === null) return;
  whenLoaded(ctx, () => {
    ctx.get().ingestTicketNote(projected.ticketId, projected.op);
  });
}

/** `ui(ticket_turn_end)`: the agent stopped without reporting. The machine
 *  decides whether that moves anything (only a running Ticket, only from its
 *  own session). Idempotent by turn id, so a replay by `init` is harmless. */
export function landTicketTurnEnd(ctx: StoreContext, msg: UiTicketTurnEndMsg): void {
  const projected = projectTicketTurnEnd(msg);
  if (projected === null) return;
  whenLoaded(ctx, () => {
    ctx.get().ingestTicketTurnEnd(projected.ticketId, projected.turnEnd);
  });
}

/**
 * A child ended. Every Ticket that has this session **on it** hears it; the
 * machine decides what it means (`sessionExited`, `docs/design/ticket-notes.md`
 * 3.4). `ssh_closed` is the bridge's own statement that a connection dropped
 * (design 6.5) - the workspace type is never consulted.
 *
 * **`midTurn` is read here, at the moment of the exit, from the session's own
 * transcript** (`hasRunningTurn`, the source `selectPhase` reads) - the caller
 * passes it in because the transcript is settled a few lines after the exit is
 * recorded, and by then no turn is running any more. It only *narrows* an
 * existing transition (a running Ticket needs the person when a session that was
 * working dies); it never creates one. That is the tension with "status is not
 * inferred from what a session displays" (invariant 1), accepted for that reason.
 *
 * This is the worker-level summary rule of 3.4, and it lives in the fact's
 * translation on purpose: `machine.ts` sees only the translated fact.
 *
 * **The session is identified here, not left to the machine.** The machine's
 * `sessionOwns` is the last word and still runs (it is what turns a stale
 * `sessionKey` into a no-op), but walking every open Ticket on every child exit
 * just to have all but one of them refuse the fact is work the caller can skip.
 */
export function landTicketExit(
  ctx: StoreContext,
  key: string,
  sessionId: string | null,
  exit: { requested: boolean; reason?: string; midTurn: boolean },
): void {
  whenLoaded(ctx, () => {
    const id = sessionId ?? '';
    for (const ticket of ctx.get().tickets) {
      // An exit from a child that never named itself cannot be matched to a
      // session that already knows its id (`sessionOwns`): only the key counts
      // before `init`.
      if (presentSessionOf(ticket, key, id) === null) continue;
      ctx.get().dispatchTicket(ticket.id, {
        type: 'sessionExited',
        sessionKey: key,
        sessionId: id,
        requested: exit.requested,
        midTurn: exit.midTurn,
        ...(exit.requested
          ? {}
          : { reason: exit.reason === 'ssh_closed' ? ('disconnected' as const) : ('crashed' as const) }),
      });
    }
  });
}
/**
 * The person sent a message in a session. For a Ticket that is waiting on them
 * in exactly this session, that is the answer (`personReplied`); in any other
 * state the machine ignores it, so the pre-filter is only to avoid walking the
 * list with a dispatch per Ticket on every message.
 *
 * Goes through `whenLoaded` like the other three: the person can type in the
 * first second of a launch, before the Ticket file has been read, and a fact
 * dropped there is a Ticket left saying "needs you" over a question that has
 * already been answered.
 */
export function landPersonReplied(ctx: StoreContext, key: string): void {
  whenLoaded(ctx, () => {
    const s = ctx.get();
    const sessionId = s.sessions[key]?.sessionId ?? '';
    if (sessionId === '') return;
    for (const ticket of s.tickets) {
      if (ticket.status !== 'needs_you') continue;
      if (!isPresentSession(ticket, sessionId)) continue;
      s.dispatchTicket(ticket.id, { type: 'personReplied', sessionId });
    }
  });
}

/**
 * A Start whose session never came up: the brief could not be delivered and the
 * Assignment has no session id, so `running` would be a Ticket whose only
 * button ("Continue") cannot resolve anything to reopen.
 *
 * Reported as an **unrequested exit**, which is what it is — the executor is
 * gone without anybody asking — so the machine's ordinary rule moves it to
 * `needs_you`, where "Start over" is offered. Raising it here rather than
 * teaching `ticketActions` a `running`-without-a-session case keeps the
 * transition table the single place a status is decided: the card is stuck
 * because nothing told the machine, not because the buttons were incomplete.
 *
 * `requested: false` with `reason: 'unreachable'` is also why the front end must
 * not reuse `crashed`: nothing ran and nothing crashed, and the card's sentence
 * would be a lie about a process that never started.
 */
export function landTicketUnreachable(ctx: StoreContext, key: string, ticketId: string): void {
  whenLoaded(ctx, () => {
    const s = ctx.get();
    // The Ticket may have moved on (dropped, accepted, restarted) while the
    // handshake was waited on, so there may be nothing left to tell.
    if (!s.tickets.some((row) => row.id === ticketId)) return;
    // No bucket check for "did it arrive after all": if the child did come up,
    // the backfill has written the Assignment's session id and the machine's
    // own `owns` turns this into a no-op. Asking a second question here would
    // be a second definition of "which session is this", and the machine's is
    // the one that decides.
    s.dispatchTicket(ticketId, {
      type: 'sessionExited',
      sessionKey: key,
      sessionId: '',
      requested: false,
      // Nothing ran, so nothing was cut short; the machine's unreachable branch
      // does not read it.
      midTurn: false,
      reason: 'unreachable',
    });
  });
}
