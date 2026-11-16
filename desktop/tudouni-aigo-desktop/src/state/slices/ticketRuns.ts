/**
 * ticketRuns slice: the session side of a Ticket.
 *
 * `slices/tickets.ts` holds the list and routes every status change through the
 * machine; this file is the part that touches **sessions** - opening one,
 * binding it, resuming it, talking into it. It never writes a `status`: it
 * opens or finds a session first and only then hands the machine the fact
 * (`start` once a bucket exists, so a failed open leaves the Ticket untouched).
 *
 * A Ticket's worker owns several sessions (`docs/design/ticket-notes.md` 3):
 * `newTicketSession` adds one, `restartTicket` adds one and takes the others
 * off, `removeTicketSession` takes one off. Every session on the Ticket is bound
 * to it; one taken off is unbound (`ticket_bind null`) when its child is alive,
 * and when it is not, `landTicketInit` clears the binding the next time it opens.
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
import {
  currentAssignment,
  isBindable,
  mostRecentSession,
  presentSessions,
  sessionOwns,
  type SessionRef,
} from '@/ticket/machine';
import {
  attachmentsOf,
  briefExceedsTail,
  isReservedAttachmentName,
  newAssignmentId,
  TICKET_ATTACHMENTS_MAX,
  TICKET_ATTACHMENTS_MIN_PROTOCOL,
  ticketTitle,
  type Assignment,
  type Ticket,
  type WorkerSession,
} from '@/ticket/model';
import type { TaskWorkspaceRef } from '@/task/tasks';
import { attachmentLines } from '@/ticket/attachments';
import { sendTo } from '@/runtime/bus';
import { stageTicketAttachments, type StagedTicketAttachment } from '@/runtime/tauri';
import { nextId } from '@/state/entries';
import { liveKeyOfSession, selectTicketAnyTurnRunning } from '../selectors/tickets';
import { landTicketUnreachable } from '../ticketLanding';
import { bindTicket } from '../ticketBind';
import {
  claimNewSession,
  openNewSession,
  sayHandshakeTimedOut,
  speak,
  waitForReady,
} from '../sessionRun';

/** What a freshly opened session is given once it is ready and bound. */
type OpenMode =
  /** The brief is sent now, with autopilot on ("run now"). */
  | 'run_now'
  /** The brief waits in the composer for the person to read and add to. */
  | 'brief'
  /** Nothing: a new conversation on work already under way. */
  | 'none';

export function ticketRunsSlice(ctx: StoreContext): Pick<
  AppStore,
  | 'startTicket'
  | 'newTicketSession'
  | 'removeTicketSession'
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
   *  be refused after its session was already open. */
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
   *  does). Nothing is sent to a runtime that predates the message.
   *
   *  `staged` are the attachments already copied into this session's workspace.
   *  They ride the bind only from protocol 19 on: an older runtime would ignore
   *  the key, so for it the paths go into the first message instead
   *  (`briefWith`). */
  function bind(key: string, ticket: Ticket | null, staged: StagedTicketAttachment[] = []): void {
    // One builder for every bind (`ticketBind.ts`), so a later re-bind for
    // changed notes replays exactly what this one sent.
    bindTicket(ctx, key, ticket, staged);
  }

  /**
   * Copy the Ticket's attachments into session `key`'s workspace, before the
   * bind (which names their paths). A failure is said in that session's
   * transcript and the session is bound without them: starting the work with
   * the person told is better than refusing a Start over a missing log.
   *
   * **A brief the runtime's tail would cut is staged whole as `brief.md`, every
   * time a session is opened** (design 3.6): a session that is not handed the
   * brief as its first message (a plain "new session") has nowhere else to read
   * the rest. It is skipped when the Ticket already carries as many files as one
   * bind may name, because one more would make the runtime refuse the whole bind.
   */
  async function stage(key: string, ticket: Ticket): Promise<StagedTicketAttachment[]> {
    // A record from before the name was reserved may carry a person's file under
    // it; it must not be staged on top of the brief (the Rust door refuses too).
    const names = attachmentsOf(ticket)
      .map((item) => item.name)
      .filter((name) => !isReservedAttachmentName(name));
    const wholeBrief = briefExceedsTail(ticket.brief) && names.length < TICKET_ATTACHMENTS_MAX;
    if (names.length === 0 && !wholeBrief) return [];
    try {
      return await stageTicketAttachments(key, ticket.id, names, wholeBrief ? ticket.brief : null);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      patchWith(key, (bucket) => ({
        entries: [
          ...bucket.entries,
          {
            kind: 'note',
            id: nextId('note'),
            tone: 'warn',
            code: 'ticket_attachments_failed',
            text: '',
            message: { code: 'ticketAttachmentsFailed', names, reason },
          },
        ],
      }));
      return [];
    }
  }

  /** The first message for a runtime that cannot carry attachments on the bind:
   *  the brief, then the staged paths, so the agent still knows where they are. */
  function briefWith(key: string, ticket: Ticket, staged: StagedTicketAttachment[]): string {
    const protocol = get().sessions[key]?.session?.protocol ?? 0;
    if (staged.length === 0 || protocol >= TICKET_ATTACHMENTS_MIN_PROTOCOL) return ticket.brief;
    return `${ticket.brief}\n\n${attachmentLines(staged)}`;
  }

  /** Unbind every session of a worker that is still on the Ticket and whose
   *  child is alive. A closed session cannot hear it; the next open reconciles
   *  instead (`landTicketInit`). */
  function unbindLive(assignment: Assignment | null): void {
    for (const session of presentSessions(assignment)) {
      const key = liveKeyOfSession(get(), session);
      if (key !== null) bind(key, null);
    }
  }

  /** Give the worker's session its session id (and, after a resume, its new key)
   *  once `init` has named it. Idempotent in the machine. */
  function backfill(key: string, ticketId: string): void {
    const sessionId = get().sessions[key]?.sessionId ?? '';
    if (sessionId === '') return;
    get().dispatchTicket(ticketId, { type: 'sessionStarted', sessionKey: key, sessionId });
  }

  /**
   * Resume a worker session **where it ran**, not where the screen is: a remote
   * one goes to its remote workspace, a local one to the directory recorded on
   * it. Resolves to the new bucket's key, or `null` when it could not be
   * reopened (no saved id, the workspace is gone, the open was refused).
   */
  async function resume(session: WorkerSession, ticket: Ticket): Promise<string | null> {
    const { sessionId, remoteWorkspaceId } = session;
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
        session.workspace ?? (ticket.workspace.kind === 'local' ? ticket.workspace.path : '');
      if (workspace === '') return null;
      opened = get().attachSession({ workspace, sessionId });
    }
    const key = await claimNewSession(ctx, previous, opened);
    if (key === null) return null;
    // Resuming moves no status (invariant 7); it only teaches the worker its
    // session's new key once the child is up.
    void (async () => {
      if ((await waitForReady(ctx, key)) === 'ready') backfill(key, ticket.id);
    })();
    return key;
  }

  /** The tail of opening a session for a Ticket: everything that needs the
   *  child to be ready. */
  async function deliverOpen(key: string, ticket: Ticket, mode: OpenMode): Promise<void> {
    const wait = await waitForReady(ctx, key);
    // **The handshake is what makes the session real.** The command has already
    // written the status and the session by the time this runs, so a child that
    // never answered would leave a session with no id - and a Ticket whose only
    // button ("Continue") cannot resolve an id to reopen. The failure is turned
    // into the fact it is: an executor that went away without being asked
    // (`landTicketUnreachable`), which takes that session off the Ticket and, if
    // it was the only one that could work, asks for the person.
    if (wait !== 'ready') {
      if (wait === 'timeout') sayHandshakeTimedOut(ctx, key, ticketTitle(ticket));
      landTicketUnreachable(ctx, key, ticket.id);
      return;
    }
    backfill(key, ticket.id);
    // Attachments are staged before the bind, because the bind names their
    // paths in the workspace.
    const staged = await stage(key, ticket);
    if (get().sessions[key] === undefined) return;
    // Bind first, then the model: the bind is what registers the report tool,
    // and nothing the model switch does depends on it - but the order is the
    // one the design states (5.1) and is asserted.
    bind(key, ticket, staged);
    const model = ticket.model.trim();
    if (model !== '') sendTo(key, { v: 1, t: 'set_model', model });
    if (mode === 'none') return;
    const brief = briefWith(key, ticket, staged);
    if (mode === 'run_now') {
      // Before the message, for the reason `runTask` gives: a run that is
      // already working is one the switch may not reach.
      sendTo(key, { v: 1, t: 'set_autopilot', on: true });
      speak(ctx, key, brief);
      return;
    }
    // Attended by default: the brief waits in the composer so the person can
    // add what they know before pressing Enter. Patched on this bucket, not
    // through `setDraft` (which writes the *active* one).
    patchWith(key, () => ({ draft: brief, historyCursor: null }));
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
    const staged = await stage(key, ticket);
    if (get().sessions[key] === undefined) return;
    bind(key, ticket, staged);
    const model = ticket.model.trim();
    if (model !== '') sendTo(key, { v: 1, t: 'set_model', model });
    patchWith(key, () => ({ draft: `${briefWith(key, ticket, staged)}\n\n${feedback}`, historyCursor: null }));
  }

  /** Run a command that ends the worker, then unbind every session it had. */
  function ending(id: string, type: 'accept' | 'drop'): TicketDispatchResult {
    const before = find(id);
    const assignment = before === undefined ? null : currentAssignment(before);
    const result = get().dispatchTicket(id, { type });
    if (result.ok) unbindLive(assignment);
    return result;
  }

  /** Where a conversation added to a running worker is opened: where that
   *  worker last ran, because the Ticket's own ref may say `active` (whatever
   *  the screen shows now) and the new session belongs beside the others. */
  function workspaceRefFor(ticket: Ticket): TaskWorkspaceRef {
    const last = mostRecentSession(ticket);
    if (last !== null) {
      if (last.remoteWorkspaceId !== null) return { kind: 'remote', id: last.remoteWorkspaceId };
      if (last.workspace !== undefined && last.workspace !== '') {
        return { kind: 'local', path: last.workspace };
      }
    }
    return ticket.workspace;
  }

  /** `start` (open) and `restart` (needs_you): a fresh session with the brief. */
  async function start(id: string, runNow: boolean, restarting: boolean): Promise<string | null> {
    const ticket = find(id);
    if (ticket === undefined || unavailable() !== null || inFlight.has(id)) return null;
    // The machine would refuse these too, but only *after* a session was
    // opened; asking first keeps a refused Start from leaving one behind.
    if (ticket.status !== (restarting ? 'needs_you' : 'open')) return null;
    if (ticket.brief.trim() === '') return null;

    inFlight.add(id);
    try {
      const opened = await openNewSession(ctx, ticket.workspace);
      if (opened === null) return null;

      const fresh = find(id);
      if (fresh === undefined) return null;
      const previous = currentAssignment(fresh);
      const fields = {
        sessionKey: opened.key,
        remoteWorkspaceId: opened.remoteWorkspaceId,
        workspace: opened.workspaceLabel,
      };
      const result = restarting
        ? get().dispatchTicket(id, { type: 'restart', ...fields })
        : get().dispatchTicket(id, { type: 'start', assignmentId: newAssignmentId(), ...fields });
      if (!result.ok) return null;
      // The sessions a restart took off, if they are still talking: they must
      // not keep a report channel to a Ticket that has moved on. (A `start` has
      // no previous worker, so there is nothing to unbind.)
      if (restarting) unbindLive(previous);
      void deliverOpen(opened.key, result.ticket, runNow ? 'run_now' : 'brief');
      return opened.key;
    } finally {
      inFlight.delete(id);
    }
  }

  /** The session a "go to the session" press means: the one asked for, else the
   *  most recently active one on the Ticket. */
  function sessionToOpen(ticket: Ticket, ref: SessionRef | undefined): WorkerSession | null {
    if (ref === undefined) return mostRecentSession(ticket);
    // Every session of every worker can be opened for reading, removed or not;
    // only a present one is a session of the Ticket.
    return ticket.assignments.flatMap((a) => a.executor.sessions).find((s) => sessionOwns(s, ref)) ?? null;
  }

  return {
    startTicket(id, opts) {
      return start(id, opts?.runNow === true, false);
    },

    restartTicket(id) {
      return start(id, false, true);
    },

    async newTicketSession(id, opts) {
      const ticket = find(id);
      if (ticket === undefined || unavailable() !== null || inFlight.has(id)) return null;
      // A conversation on work under way. The machine refuses the same states,
      // but only after a session was opened.
      if (!isBindable(ticket) || currentAssignment(ticket) === null) return null;
      const withBrief = opts?.withBrief === true;
      if (withBrief && ticket.brief.trim() === '') return null;

      inFlight.add(id);
      try {
        const opened = await openNewSession(ctx, workspaceRefFor(ticket));
        if (opened === null) return null;
        const result = get().dispatchTicket(id, {
          type: 'newSession',
          sessionKey: opened.key,
          remoteWorkspaceId: opened.remoteWorkspaceId,
          workspace: opened.workspaceLabel,
          withBrief,
        });
        // Nothing to unbind: every session already on the Ticket stays on it.
        if (!result.ok) return null;
        void deliverOpen(opened.key, result.ticket, withBrief ? 'brief' : 'none');
        return opened.key;
      } finally {
        inFlight.delete(id);
      }
    },

    removeTicketSession(id, ref) {
      const ticket = find(id);
      if (ticket === undefined) return { ok: false, reason: 'not_found' };
      const target = presentSessions(currentAssignment(ticket)).find((s) => sessionOwns(s, ref));
      // Read before the command: afterwards the session is no longer present.
      const live = target === undefined ? null : liveKeyOfSession(get(), target);
      const result = get().dispatchTicket(id, {
        type: 'removeSession',
        sessionKey: ref.sessionKey,
        sessionId: ref.sessionId,
      });
      // A closed session cannot hear it; the next open clears the binding.
      if (result.ok && live !== null) bind(live, null);
      return result;
    },

    async openTicketSession(id, ref) {
      const ticket = find(id);
      if (ticket === undefined) return null;
      const session = sessionToOpen(ticket, ref);
      if (session === null) return null;
      const live = liveKeyOfSession(get(), session);
      if (live !== null) {
        get().focusSession(live);
        return live;
      }
      if (inFlight.has(id)) return null;
      inFlight.add(id);
      try {
        return await resume(session, ticket);
      } finally {
        inFlight.delete(id);
      }
    },

    acceptTicket(id) {
      // The card disables Accept while the agent works, but a drop into Done
      // reaches here too: the store is the one place both entrances share, so
      // the rule is kept here and not only on the button. Any session on the
      // Ticket counts: signing off while a second conversation is still changing
      // files would be signing off a half-finished change.
      const ticket = find(id);
      if (ticket !== undefined && ticket.status === 'review') {
        if (selectTicketAnyTurnRunning(get(), ticket)) return { ok: false, reason: 'agent_busy' };
      }
      return ending(id, 'accept');
    },

    dropTicket(id) {
      return ending(id, 'drop');
    },

    async sendBackTicket(id, feedback, sessionId) {
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
        const worker = currentAssignment(ticket);
        const chosen =
          sessionId !== undefined && sessionId !== ''
            ? (presentSessions(worker).find((s) => s.sessionId === sessionId) ?? null)
            : mostRecentSession(ticket);
        if (sessionId !== undefined && sessionId !== '' && chosen === null) {
          return { ok: false, reason: 'unknown_session' };
        }
        let target = liveKeyOfSession(get(), chosen);
        let mode: 'live' | 'resumed' | 'replaced' = 'live';
        if (target === null) {
          mode = 'resumed';
          target = chosen === null ? null : await resume(chosen, ticket);
          if (target === null) {
            // The chosen session cannot be reopened: a replacement joins the
            // worker, and the old one leaves it as having failed to restore.
            const opened = await openNewSession(ctx, ticket.workspace);
            if (opened === null) return { ok: false, reason: 'session_unavailable' };
            const restored = get().dispatchTicket(id, {
              type: 'sessionRestoreFailed',
              failed: {
                sessionKey: chosen?.sessionKey ?? '',
                sessionId: chosen?.sessionId ?? '',
              },
              sessionKey: opened.key,
              remoteWorkspaceId: opened.remoteWorkspaceId,
              workspace: opened.workspaceLabel,
            });
            if (!restored.ok) return restored;
            target = opened.key;
            mode = 'replaced';
          }
        }

        // For a replacement the machine's default (the most recently active
        // present session) is the new session itself.
        const sent = get().dispatchTicket(id, {
          type: 'sendBack',
          feedback: text,
          ...(mode !== 'replaced' && chosen !== null && chosen.sessionId !== ''
            ? { sessionId: chosen.sessionId }
            : {}),
        });
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
