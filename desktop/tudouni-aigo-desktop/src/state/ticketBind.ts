/**
 * `ticket_bind`: the one place a bind is built and sent.
 *
 * Starting a session, re-binding after the notes changed, and clearing a binding
 * all send the same message, and the runtime's "did anything change?" check
 * (`state.BindTicket`) compares it with the copy it holds. So every sender has to
 * produce **the same spec for the same facts**; otherwise a re-bind that meant
 * "only the notes moved" would also rewrite the brief or drop the attachments
 * (a bind is a whole replacement: a bind without `attachments` clears them).
 *
 * That is why the spec a session was last bound with is kept on its bucket
 * (`ticketSpec`) and a re-bind replays it, swapping in only the notes. It also
 * keeps the promise the edit dialog makes: a change to the brief does not reach a
 * session that is already working.
 */
import type { StoreContext } from './storeContext';
import { sendTo } from '@/runtime/bus';
import type { TicketBindAttachment, TicketBindNote } from '@/protocol/types';
import { currentAssignment, isBindable, presentSessions } from '@/ticket/machine';
import {
  TICKET_ATTACHMENTS_MIN_PROTOCOL,
  TICKET_MIN_PROTOCOL,
  TICKET_NOTES_MIN_PROTOCOL,
  ticketTitle,
  type Ticket,
  type TicketNote,
} from '@/ticket/model';
import { liveKeyOfSession } from './selectors/tickets';

/** A note in the snake_case shape the runtime validates. Optional keys are left
 *  out rather than sent as null, like the runtime's own `Wire()`. */
export function noteToWire(note: TicketNote): TicketBindNote {
  return {
    id: note.id,
    text: note.text,
    author: note.author,
    updated_at_ms: note.updatedAtMs,
    ...(note.sessionId !== undefined && note.sessionId !== '' ? { session_id: note.sessionId } : {}),
    ...(note.createdAtMs > 0 ? { created_at_ms: note.createdAtMs } : {}),
  };
}

/** What a bound session holds, as this window last told it (or as `init`
 *  reported it back). */
export interface BoundSpec {
  ticketId: string;
  title: string;
  brief: string;
  attachments: TicketBindAttachment[];
}

/** The message for one session. Gated by the **session's** protocol: a runtime
 *  below 19 would ignore `attachments`, below 22 `notes`, and an older key is
 *  better absent than silently dropped. */
function bindMessage(spec: BoundSpec, notes: readonly TicketNote[], protocol: number) {
  return {
    v: 1,
    t: 'ticket_bind' as const,
    ticket: {
      id: spec.ticketId,
      title: spec.title,
      brief: spec.brief,
      ...(protocol >= TICKET_ATTACHMENTS_MIN_PROTOCOL && spec.attachments.length > 0
        ? { attachments: spec.attachments }
        : {}),
      ...(protocol >= TICKET_NOTES_MIN_PROTOCOL ? { notes: notes.map(noteToWire) } : {}),
    },
  };
}

const protocolOf = (ctx: StoreContext, key: string): number =>
  ctx.get().sessions[key]?.session?.protocol ?? 0;

/**
 * Tell a session which Ticket it works for (or, with `null`, that it no longer
 * does). Nothing is sent to a runtime that predates the message.
 *
 * `staged` are the attachments already copied into this session's workspace;
 * they ride the bind from protocol 19 on.
 */
export function bindTicket(
  ctx: StoreContext,
  key: string,
  ticket: Ticket | null,
  staged: readonly TicketBindAttachment[] = [],
): void {
  const protocol = protocolOf(ctx, key);
  if (protocol < TICKET_MIN_PROTOCOL) return;
  if (ticket === null) {
    sendTo(key, { v: 1, t: 'ticket_bind', ticket: null });
    ctx.patch(key, { ticketSpec: undefined });
    return;
  }
  const spec: BoundSpec = {
    ticketId: ticket.id,
    title: ticketTitle(ticket),
    brief: ticket.brief,
    attachments:
      protocol >= TICKET_ATTACHMENTS_MIN_PROTOCOL
        ? staged.map(({ name, path, bytes }) => ({ name, path, bytes }))
        : [],
  };
  sendTo(key, bindMessage(spec, ticket.notes, protocol));
  ctx.patch(key, { ticketSpec: spec });
}

/**
 * Re-send one session's bind with the Ticket's canonical notes. A no-op for a
 * session that cannot hold notes (protocol < 22), or whose binding this window
 * does not know (nothing to replay: guessing the attachments would clear them).
 * Returns whether a message went out.
 */
export function rebindSession(ctx: StoreContext, key: string, ticket: Ticket): boolean {
  const protocol = protocolOf(ctx, key);
  if (protocol < TICKET_NOTES_MIN_PROTOCOL) return false;
  const spec = ctx.get().sessions[key]?.ticketSpec;
  if (spec === undefined || spec.ticketId !== ticket.id) return false;
  sendTo(key, bindMessage(spec, ticket.notes, protocol));
  return true;
}

/**
 * The Ticket's notes changed (or may have diverged from a runtime's copy): send
 * the full bind again to **every live present session** of its current worker.
 * The canonical list is the desktop's; each runtime only holds a copy, so this is
 * what makes the two agree - including when two sessions wrote at once.
 *
 * A session that is closed cannot hear it; `landTicketInit` re-binds it the next
 * time it opens. A removed session was unbound and is not written to.
 */
export function rebindTicketNotes(ctx: StoreContext, ticket: Ticket): void {
  if (!isBindable(ticket)) return;
  for (const session of presentSessions(currentAssignment(ticket))) {
    const key = liveKeyOfSession(ctx.get(), session);
    if (key !== null) rebindSession(ctx, key, ticket);
  }
}
