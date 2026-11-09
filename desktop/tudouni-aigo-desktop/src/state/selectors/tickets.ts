/**
 * Read-only views over the tickets, for the chrome that only needs a number.
 *
 * They return primitives so a zustand subscription is stable without memoising
 * a filtered array — the same reason `selectRowStatusKey` returns a string.
 */
import type { AppStore } from '@/state/storeShape';
import { hasRunningTurn } from '@/state/entries';
import { currentAssignment } from '@/ticket/machine';
import type { Assignment, Ticket } from '@/ticket/model';
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
 * The key of the **live child** an Assignment's session is running in, or `null`.
 *
 * "Live" is stricter than "has a bucket": a child that exited (the bucket stays
 * so its transcript can be read) or that failed to start is not somewhere work
 * can be sent. The identity is the runtime's session id once `init` has named
 * it - a bridge key is a per-run counter, and last week's can equal today's -
 * and the key only before that.
 *
 * Shared by the board (which draws "not connected" from it) and the session
 * actions (which decide between focusing and resuming from it), so the two can
 * never disagree about whether a Ticket's session is there.
 */
export function liveKeyOfAssignment(s: AppStore, assignment: Assignment | null): string | null {
  if (assignment === null) return null;
  const { sessionId, sessionKey } = assignment.executor;
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

/**
 * The bucket an Assignment's session sits in, **alive or not**, or `''`.
 *
 * The notifier's question is "which conversation would show this", and a child
 * that just died still has the conversation on screen: the person who is looking
 * at it has been told. Identity follows `liveKeyOfAssignment` (the runtime's
 * session id once known, the key only before that).
 */
function bucketKeyOfAssignment(s: AppStore, assignment: Assignment | null): string {
  if (assignment === null) return '';
  const { sessionId, sessionKey } = assignment.executor;
  if (sessionId !== '') {
    return s.order.find((candidate) => s.sessions[candidate]?.sessionId === sessionId) ?? '';
  }
  return sessionKey !== '' && s.sessions[sessionKey] !== undefined ? sessionKey : '';
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
    const assignment = currentAssignment(ticket);
    const key = bucketKeyOfAssignment(s, assignment);
    return {
      ticketId: ticket.id,
      status: ticket.status,
      key,
      // The Assignment's own id when no bucket is open: a click on the toast
      // reopens the session by it (`notifyDestination`'s reopen branch).
      sessionId:
        (key !== '' ? s.sessions[key]?.sessionId : null) ?? assignment?.executor.sessionId ?? '',
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

/** `liveKeyOfAssignment` for a Ticket's current Assignment. */
export function selectTicketLiveKey(s: AppStore, ticket: Ticket): string | null {
  return liveKeyOfAssignment(s, currentAssignment(ticket));
}
