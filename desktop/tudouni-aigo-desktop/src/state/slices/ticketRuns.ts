/**
 * ticketRuns slice: the session side of a Ticket.
 *
 * `slices/tickets.ts` holds the list and routes every status change through the
 * machine; this file is the part that touches **sessions** - opening one,
 * binding it, resuming it, talking into it. It never writes a `status`: it
 * opens or finds a session first and only then hands the machine the fact
 * (`start` once a bucket exists, so a failed open leaves the Ticket untouched).
 *
 * The open itself is `openNewSession` (`sessionRun.ts`), the same code a
 * template's Run uses, so the "only a bucket this open created counts" rule is
 * one rule.
 *
 * **`ticket_bind` is gated on the session's `init.protocol`** (design 5.4): an
 * older runtime drops the message silently, and sending it anyway would let the
 * card imply a report channel that does not exist.
 */
import type { StoreContext } from '../storeContext';
import type { AppStore, TicketDispatchResult } from '../storeShape';
import { currentAssignment } from '@/ticket/machine';
import {
  newAssignmentId,
  TICKET_MIN_PROTOCOL,
  ticketTitle,
  type Assignment,
  type Ticket,
} from '@/ticket/model';
import { sendTo } from '@/runtime/bus';
import { liveKeyOfAssignment } from '../selectors/tickets';
import { landTicketUnreachable } from '../ticketLanding';
import {
  claimNewSession,
  openNewSession,
  sayHandshakeTimedOut,
  speak,
  waitForReady,
} from '../sessionRun';

export function ticketRunsSlice(ctx: StoreContext): Pick<
  AppStore,
  | 'startTicket'
  | 'openTicketSession'
  | 'acceptTicket'
  | 'dropTicket'
  | 'sendBackTicket'
  | 'restartTicket'
  | 'removeTicket'
> {
  const { get, patchWith } = ctx;

  /** Tickets with a session action in flight. A double press on Start would
   *  otherwise open two sessions for one Ticket, and the second `start` would
   *  supersede the first for nothing. */
  const inFlight = new Set<string>();

  const find = (id: string): Ticket | undefined => get().tickets.find((row) => row.id === id);

  /** Why a mutation is refused before it begins, or `null`. */
  function unavailable(): 'not_loaded' | 'read_only' | null {
    const s = get();
    if (!s.ticketsLoaded) return 'not_loaded';
    if (s.ticketsReadOnly) return 'read_only';
    return null;
  }

  /** Tell a session which Ticket it works for (or, `null`, that it no longer
   *  does). Nothing is sent to a runtime that predates the message. */
  function bind(key: string, ticket: Ticket | null): void {
    const protocol = get().sessions[key]?.session?.protocol ?? 0;
    if (protocol < TICKET_MIN_PROTOCOL) return;
    sendTo(key, {
      v: 1,
      t: 'ticket_bind',
      ticket:
        ticket === null
          ? null
          : { id: ticket.id, title: ticketTitle(ticket), brief: ticket.brief },
    });
  }

  /** Unbind the session an Assignment ran in, when that child is still alive.
   *  A closed session cannot hear it; the next open reconciles instead. */
  function unbindLive(assignment: Assignment | null): void {
    const key = liveKeyOfAssignment(get(), assignment);
    if (key !== null) bind(key, null);
  }

  /** Give the Assignment its session id (and, after a resume, its new key) once
   *  `init` has named it. Idempotent in the machine. */
  function backfill(key: string, ticketId: string): void {
    const sessionId = get().sessions[key]?.sessionId ?? '';
    if (sessionId === '') return;
    get().dispatchTicket(ticketId, { type: 'assignmentStarted', sessionKey: key, sessionId });
  }

  /**
   * Resume an Assignment's own session **where it ran**, not where the screen
   * is: a remote Assignment goes to its remote workspace, a local one to the
   * directory recorded on the Assignment. Resolves to the new bucket's key, or
   * `null` when it could not be reopened (no saved id, the workspace is gone,
   * the open was refused).
   */
  async function resume(assignment: Assignment, ticket: Ticket): Promise<string | null> {
    const { sessionId, remoteWorkspaceId } = assignment.executor;
    if (sessionId === '') return null;
    const s = get();

    // A dead bucket still holding this id would be focused by `openSession`
    // and would also leave two rows for one session. It has nothing left to
    // lose: the transcript is read again from the saved file.
    const stale = s.order.find((key) => s.sessions[key]?.sessionId === sessionId);
    if (stale !== undefined) await get().detachSession(stale);

    const previous = new Set(get().order);
    let opened: Promise<unknown>;
    if (remoteWorkspaceId !== null) {
      const entry = s.remoteWorkspaces.find((item) => item.id === remoteWorkspaceId);
      const host = entry !== undefined ? s.sshHosts.find((item) => item.id === entry.hostId) : undefined;
      if (entry === undefined || host === undefined) return null;
      opened = get().connectRemoteWorkspace(remoteWorkspaceId, { forceNew: true, sessionId });
    } else {
      const workspace =
        assignment.executor.workspace ??
        (ticket.workspace.kind === 'local' ? ticket.workspace.path : '');
      if (workspace === '') return null;
      opened = get().attachSession({ workspace, sessionId });
    }
    const key = await claimNewSession(ctx, previous, opened);
    if (key === null) return null;
    // Resuming moves no status (invariant 7); it only teaches the Assignment
    // its new key once the child is up.
    void (async () => {
      if ((await waitForReady(ctx, key)) === 'ready') backfill(key, ticket.id);
    })();
    return key;
  }

  /** The tail of a start: everything that needs the child to be ready. */
  async function deliverStart(key: string, ticket: Ticket, runNow: boolean): Promise<void> {
    const wait = await waitForReady(ctx, key);
    // **The handshake is what makes `running` true.** A `start` has already
    // written the status and the Assignment by the time this runs, so a child
    // that never answered would leave a Ticket with no session id — and the
    // only button a `running` Ticket offers is "Continue", which cannot resolve
    // an id to reopen. Nothing else would ever move it out of that state, so
    // the failure is turned into the fact it is: an executor that went away
    // without being asked (`landTicketUnreachable`).
    if (wait !== 'ready') {
      if (wait === 'timeout') sayHandshakeTimedOut(ctx, key, ticketTitle(ticket));
      landTicketUnreachable(ctx, key, ticket.id);
      return;
    }
    backfill(key, ticket.id);
    // Bind first, then the model: the bind is what registers the report tool,
    // and nothing the model switch does depends on it - but the order is the
    // one the design states (5.1) and is asserted.
    bind(key, ticket);
    const model = ticket.model.trim();
    if (model !== '') sendTo(key, { v: 1, t: 'set_model', model });
    if (runNow) {
      // Before the message, for the reason `runTask` gives: a run that is
      // already working is one the switch may not reach.
      sendTo(key, { v: 1, t: 'set_autopilot', on: true });
      speak(ctx, key, ticket.brief);
      return;
    }
    // Attended by default: the brief waits in the composer so the person can
    // add what they know before pressing Enter. Patched on this bucket, not
    // through `setDraft` (which writes the *active* one).
    patchWith(key, () => ({ draft: ticket.brief, historyCursor: null }));
  }

  /** The tail of a send-back into a session that was not already listening. */
  async function deliverFeedback(
    key: string,
    mode: 'resumed' | 'replaced',
    ticket: Ticket,
    feedback: string,
  ): Promise<void> {
    const wait = await waitForReady(ctx, key);
    if (wait === 'gone') return;
    if (wait === 'timeout') {
      sayHandshakeTimedOut(ctx, key, ticketTitle(ticket));
      return;
    }
    if (mode === 'resumed') {
      speak(ctx, key, feedback);
      return;
    }
    // A replacement session knows nothing: the brief and the opinion go
    // together, and as a prefill because the person is reading along.
    backfill(key, ticket.id);
    bind(key, ticket);
    const model = ticket.model.trim();
    if (model !== '') sendTo(key, { v: 1, t: 'set_model', model });
    patchWith(key, () => ({ draft: `${ticket.brief}\n\n${feedback}`, historyCursor: null }));
  }

  /** Run a command that ends the executor, then unbind the session it had. */
  function ending(id: string, type: 'accept' | 'drop'): TicketDispatchResult {
    const before = find(id);
    const assignment = before === undefined ? null : currentAssignment(before);
    const result = get().dispatchTicket(id, { type });
    if (result.ok) unbindLive(assignment);
    return result;
  }

  async function start(id: string, runNow: boolean): Promise<string | null> {
    const ticket = find(id);
    if (ticket === undefined || unavailable() !== null || inFlight.has(id)) return null;
    // The machine would refuse these too, but only *after* a session was
    // opened; asking first keeps a refused Start from leaving one behind.
    if (ticket.status !== 'open' && ticket.status !== 'needs_you') return null;
    if (ticket.brief.trim() === '') return null;

    inFlight.add(id);
    try {
      const opened = await openNewSession(ctx, ticket.workspace);
      if (opened === null) return null;

      const fresh = find(id);
      if (fresh === undefined) return null;
      const previous = currentAssignment(fresh);
      const result = get().dispatchTicket(id, {
        type: 'start',
        assignmentId: newAssignmentId(),
        sessionKey: opened.key,
        remoteWorkspaceId: opened.remoteWorkspaceId,
        workspace: opened.workspaceLabel,
      });
      if (!result.ok) return null;
      // The superseded session, if it is still talking: it must not keep a
      // report channel to a Ticket that has moved on.
      unbindLive(previous);
      void deliverStart(opened.key, result.ticket, runNow);
      return opened.key;
    } finally {
      inFlight.delete(id);
    }
  }

  return {
    startTicket(id, opts) {
      return start(id, opts?.runNow === true);
    },

    restartTicket(id) {
      return start(id, false);
    },

    async openTicketSession(id) {
      const ticket = find(id);
      if (ticket === undefined) return null;
      const assignment = currentAssignment(ticket);
      if (assignment === null) return null;
      const live = liveKeyOfAssignment(get(), assignment);
      if (live !== null) {
        get().focusSession(live);
        return live;
      }
      if (inFlight.has(id)) return null;
      inFlight.add(id);
      try {
        return await resume(assignment, ticket);
      } finally {
        inFlight.delete(id);
      }
    },

    acceptTicket(id) {
      return ending(id, 'accept');
    },

    dropTicket(id) {
      return ending(id, 'drop');
    },

    async sendBackTicket(id, feedback) {
      const ticket = find(id);
      if (ticket === undefined) return { ok: false, reason: 'not_found' };
      const why = unavailable();
      if (why !== null) return { ok: false, reason: why };
      if (ticket.status !== 'review') return { ok: false, reason: 'wrong_status' };
      const text = feedback.trim();
      if (text === '') return { ok: false, reason: 'empty_feedback' };
      if (inFlight.has(id)) return { ok: false, reason: 'busy' };

      inFlight.add(id);
      try {
        // **The session is found or reopened before the Ticket moves**, so a
        // send-back that cannot reach anyone leaves the Ticket in review with
        // the person's words still in the box, instead of "running" with
        // nobody listening.
        const assignment = currentAssignment(ticket);
        let target = liveKeyOfAssignment(get(), assignment);
        let mode: 'live' | 'resumed' | 'replaced' = 'live';
        if (target === null) {
          mode = 'resumed';
          target = assignment === null ? null : await resume(assignment, ticket);
          if (target === null) {
            // The original cannot be reopened: a new executor takes over, and
            // the old Assignment is recorded as having failed to restore.
            const opened = await openNewSession(ctx, ticket.workspace);
            if (opened === null) return { ok: false, reason: 'session_unavailable' };
            const restored = get().dispatchTicket(id, {
              type: 'assignmentRestoreFailed',
              assignmentId: newAssignmentId(),
              sessionKey: opened.key,
              remoteWorkspaceId: opened.remoteWorkspaceId,
              workspace: opened.workspaceLabel,
            });
            if (!restored.ok) return restored;
            target = opened.key;
            mode = 'replaced';
          }
        }

        const sent = get().dispatchTicket(id, { type: 'sendBack', feedback: text });
        if (!sent.ok) return sent;
        if (mode === 'live') speak(ctx, target, text);
        else void deliverFeedback(target, mode, sent.ticket, text);
        return sent;
      } finally {
        inFlight.delete(id);
      }
    },

    removeTicket(id) {
      const ticket = find(id);
      if (ticket === undefined) return false;
      const assignment = currentAssignment(ticket);
      const removed = get().deleteTicket(id);
      if (removed) unbindLive(assignment);
      return removed;
    },
  };
}
