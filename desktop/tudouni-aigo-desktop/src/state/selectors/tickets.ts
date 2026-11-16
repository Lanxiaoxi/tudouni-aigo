/**
 * Read-only views over the tickets, for the chrome that only needs a number.
 *
 * They return primitives so a zustand subscription is stable without memoising
 * a filtered array — the same reason `selectRowStatusKey` returns a string.
 */
import type { AppStore } from '@/state/storeShape';
import { hasRunningTurn } from '@/state/entries';
import { currentAssignment, isBindable, mostRecentSession, mostRecentSessionOf, presentSessions } from '@/ticket/machine';
import type { Assignment, Ticket, WorkerSession } from '@/ticket/model';
import { encodeTicketNotifySnapshot, type TicketNotifyRow } from '@/runtime/notify';

/**
 * How many tickets are waiting on the person: `needs_you` plus `review`.
 *
 * Those two are the states only a person can move on (answer the question,
 * accept or send back), so they are what the workbench badge counts. `running`
 * is not: it is the agent's turn.
 */
export function selectTicketAttention(s: AppStore): number {
  let n = 0;
  for (const ticket of s.tickets) {
    if (ticket.status === 'needs_you' || ticket.status === 'review') n += 1;
  }
  return n;
}

/**
 * The key of the **live child** a worker session runs in, or `null`.
 *
 * "Live" is stricter than "has a bucket": a child that exited (the bucket stays
 * so its transcript can be read) or that failed to start is not somewhere work
 * can be sent. The identity is the runtime's session id once `init` has named
 * it - a bridge key is a per-run counter, and last week's can equal today's -
 * and the key only before that.
 *
 * Shared by the board (which draws "not connected" from it) and the session
 * actions (which decide between focusing and resuming from it), so the two can
 * never disagree about whether a session is there.
 */
export function liveKeyOfSession(s: AppStore, session: WorkerSession | null): string | null {
  if (session === null) return null;
  const { sessionId, sessionKey } = session;
  const alive = (key: string): boolean => {
    const bucket = s.sessions[key];
    return bucket !== undefined && bucket.runtimeExit === null && bucket.problem === null;
  };
  if (sessionId !== '') {
    const key = s.order.find((candidate) => s.sessions[candidate]?.sessionId === sessionId);
    return key !== undefined && alive(key) ? key : null;
  }
  return sessionKey !== '' && alive(sessionKey) ? sessionKey : null;
}

/** The live child of the session a worker would open by default (the most
 *  recently active one on the Ticket), or `null`. */
export function liveKeyOfAssignment(s: AppStore, assignment: Assignment | null): string | null {
  return liveKeyOfSession(s, mostRecentSessionOf(assignment));
}

/**
 * The bucket a worker session sits in, **alive or not**, or `''`.
 *
 * The notifier's question is "which conversation would show this", and a child
 * that just died still has the conversation on screen: the person who is looking
 * at it has been told. Identity follows `liveKeyOfSession` (the runtime's
 * session id once known, the key only before that).
 */
export function bucketKeyOfSession(s: AppStore, session: WorkerSession | null): string {
  if (session === null) return '';
  const { sessionId, sessionKey } = session;
  if (sessionId !== '') {
    return s.order.find((candidate) => s.sessions[candidate]?.sessionId === sessionId) ?? '';
  }
  return sessionKey !== '' && s.sessions[sessionKey] !== undefined ? sessionKey : '';
}

/**
 * Whether the conversation in `key` is a session that is **no longer on** the
 * Ticket it used to be bound to: it names a Ticket's worker session that was
 * removed, and is not present on any current worker. Drives the banner at the
 * top of such a conversation. A primitive, so the chrome can subscribe to it.
 */
export function selectRemovedFromTicket(s: AppStore, key: string | null): boolean {
  if (key === null) return false;
  const sessionId = s.sessions[key]?.sessionId ?? '';
  if (sessionId === '') return false;
  let removed = false;
  for (const ticket of s.tickets) {
    // The history of every worker counts for "was once on a Ticket", but only
    // the current worker's present list can say "still is".
    const current = currentAssignment(ticket);
    if (isBindable(ticket) && presentSessions(current).some((x) => x.sessionId === sessionId)) {
      return false;
    }
    for (const assignment of ticket.assignments) {
      if (assignment.executor.sessions.some((x) => x.sessionId === sessionId && x.removedAtMs !== null)) {
        removed = true;
      }
    }
  }
  return removed;
}
/**
 * Every Ticket's notification-relevant facts as one string, for
 * `useNotifications` (design 7.3). A string for the reason `selectNotifyKey`
 * is one: it changes on a status or a binding change, not on a streamed token.
 *
 * **`activeKey` is blanked while any board holds the column.** The session
 * "on screen" is then behind the board, and nobody reading a card is reading
 * that conversation.
 */
export function selectTicketNotifyKey(s: AppStore): string {
  const rows: TicketNotifyRow[] = s.tickets.map((ticket) => {
    const session = mostRecentSession(ticket);
    const key = bucketKeyOfSession(s, session);
    return {
      ticketId: ticket.id,
      status: ticket.status,
      key,
      // The Assignment's own id when no bucket is open: a click on the toast
      // reopens the session by it (`notifyDestination`'s reopen branch).
      sessionId:
        (key !== '' ? s.sessions[key]?.sessionId : null) ?? session?.sessionId ?? '',
    };
  });
  return encodeTicketNotifySnapshot({
    activeKey: s.board === null ? (s.activeKey ?? '') : '',
    rows,
  });
}

/**
 * Whether the session under `key` has a turn in flight. A boolean, so a card
 * subscribed to it repaints when a turn starts or ends, not on every token.
 */
export function selectTicketTurnRunning(s: AppStore, key: string | null): boolean {
  if (key === null) return false;
  const bucket = s.sessions[key];
  return bucket !== undefined && hasRunningTurn(bucket.entries);
}

/**
 * Whether any session **on** the Ticket has a turn in flight. Accept waits for
 * all of them: signing off while a second conversation is still changing files
 * would be the half-finished change `ticketAgentBusy` exists to prevent.
 */
export function selectTicketAnyTurnRunning(s: AppStore, ticket: Ticket): boolean {
  for (const session of presentSessions(currentAssignment(ticket))) {
    if (selectTicketTurnRunning(s, liveKeyOfSession(s, session))) return true;
  }
  return false;
}
/** `liveKeyOfSession` for the session a Ticket would open by default. */
export function selectTicketLiveKey(s: AppStore, ticket: Ticket): string | null {
  return liveKeyOfSession(s, mostRecentSession(ticket));
}
