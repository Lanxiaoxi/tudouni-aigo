/**
 * tickets slice: `src/ticket/` wired into zustand.
 *
 * Nothing here decides anything about a Ticket. Every status change is a call
 * to `machine.apply`, every byte of persistence goes through `ticket/store`,
 * and this file only holds the in-memory list between the two — so replacing
 * the storage (design §9) touches `ticket/store.ts` and not this slice.
 *
 * **The list is not in `desktop.json` and not in `extract()`**: Tickets have
 * their own file and their own write path (`saveTickets`), written after every
 * change rather than debounced, because one event is one durable fact and the
 * file is small. A mutation is refused until the file has been read
 * (`ticketsLoaded`) and while it is read-only: a write from either state would
 * replace the person's Tickets with a list this window never saw.
 */
import type { StoreContext } from '../storeContext';
import type { AppStore, TicketDispatchResult } from '../storeShape';
import { apply, type TicketInput } from '@/ticket/machine';
import { emptyTicket, unbindableField, type Report, type Ticket } from '@/ticket/model';
import { originOf, planScan, type InboxDrop } from '@/ticket/inbox';
import { loadTickets, reconcile, saveTickets } from '@/ticket/store';
import { archiveInboxFile, listInboxFiles } from '@/runtime/tauri';

export function ticketsSlice(ctx: StoreContext): Pick<
  AppStore,
  | 'loadTickets'
  | 'createTicket'
  | 'updateTicketDraft'
  | 'dispatchTicket'
  | 'deleteTicket'
  | 'clearFinishedTickets'
  | 'ingestTicketReport'
  | 'reconcileTicket'
  | 'scanTicketInbox'
> {
  const { set, get } = ctx;

  /** The read in flight, so two callers (the start-up and a retry) share one. */
  let loading: Promise<void> | null = null;

  /** Replace the list and persist it. The only place the slice writes. */
  function commitList(tickets: Ticket[]): void {
    set({ tickets });
    void saveTickets(tickets);
  }

  /** Why a mutation cannot be made right now, or `null`. */
  function blocked(): 'not_loaded' | 'read_only' | null {
    const s = get();
    if (!s.ticketsLoaded) return 'not_loaded';
    if (s.ticketsReadOnly) return 'read_only';
    return null;
  }

  /**
   * Run `produce` on one Ticket and persist the result if it changed.
   *
   * "Changed" is object identity: the machine returns the same object for a
   * fact that has nothing to record (a repeated report, a message in a
   * Ticket that is not waiting), and a write for those would be pure churn.
   */
  function update(
    id: string,
    produce: (ticket: Ticket) => TicketDispatchResult,
  ): TicketDispatchResult {
    const why = blocked();
    if (why !== null) return { ok: false, reason: why };
    const current = get().tickets.find((row) => row.id === id);
    if (current === undefined) return { ok: false, reason: 'not_found' };
    const result = produce(current);
    if (!result.ok || result.ticket === current) return result;
    commitList(get().tickets.map((row) => (row.id === id ? result.ticket : row)));
    return result;
  }

  return {
    loadTickets() {
      if (get().ticketsLoaded) return Promise.resolve();
      if (loading !== null) return loading;
      loading = (async () => {
        const loaded = await loadTickets();
        if (loaded.problem !== null) console.warn(loaded.problem);
        if (loaded.dropped > 0) {
          // Dropped whole by the guard. The next write persists the loss, which
          // is the same rule `desktop.json` follows for a malformed task.
          console.warn(`${loaded.dropped} malformed ticket record(s) were dropped`);
        }
        set({
          tickets: loaded.tickets,
          ticketsLoaded: true,
          ticketsReadOnly: loaded.readOnly,
          ticketsProblem: loaded.problem,
        });
      })().finally(() => {
        loading = null;
      });
      return loading;
    },

    createTicket(draft) {
      if (blocked() !== null) return null;
      const now = Date.now();
      // Born through `emptyTicket`, not through the machine: creation is not a
      // transition, and the `created` event comes with the blank.
      const base = emptyTicket(now);
      const ticket: Ticket = {
        ...base,
        title: draft.title ?? '',
        brief: draft.brief,
        workspace: draft.workspace ?? base.workspace,
        model: draft.model ?? '',
      };
      // A Ticket whose bind the runtime would refuse must not exist at all: it
      // would be a card saying Running with no report tool behind it. The form
      // says so while typing; this is the second half of the same rule, for
      // every caller that is not the form.
      if (unbindableField(ticket) !== null) return null;
      commitList([...get().tickets, ticket]);
      return ticket.id;
    },

    updateTicketDraft(id, patch) {
      return update(id, (ticket) => {
        const result = apply(ticket, { type: 'edit', at: Date.now(), patch });
        // An edit that would make the record unbindable is refused as a whole,
        // rather than stored and left to fail at the next Start: the same rule
        // `createTicket` applies, from the other end of the same record.
        if (result.ok && unbindableField(result.ticket) !== null) {
          return { ok: false, reason: 'invalid_edit' };
        }
        return result;
      });
    },

    dispatchTicket(id, input) {
      return update(id, (ticket) =>
        apply(ticket, { ...input, at: input.at ?? Date.now() } as TicketInput),
      );
    },

    deleteTicket(id) {
      if (blocked() !== null) return false;
      if (!get().tickets.some((row) => row.id === id)) return false;
      // Allowed in any status, including one with a live Assignment: removing
      // the record is the person's call (the board asks twice). Unbinding a
      // session that is still attached is the caller's job, as it is for
      // accept and drop, because only the caller knows if it is alive.
      commitList(get().tickets.filter((row) => row.id !== id));
      return true;
    },

    clearFinishedTickets() {
      if (blocked() !== null) return 0;
      const kept = get().tickets.filter((row) => row.status !== 'done' && row.status !== 'dropped');
      const removed = get().tickets.length - kept.length;
      if (removed > 0) commitList(kept);
      return removed;
    },

    ingestTicketReport(ticketId: string, report: Report) {
      // The report's own time, not "now": a report delivered late (a reconcile,
      // a window that was reloading) happened when the agent made it.
      return update(ticketId, (ticket) =>
        apply(ticket, { type: 'reported', at: report.atMs, report }),
      );
    },

    reconcileTicket(ticketId: string, reports: Report[]) {
      return update(ticketId, (ticket) => ({ ok: true, ticket: reconcile(ticket, reports) }));
    },

    async scanTicketInbox() {
      const why = blocked();
      if (why !== null) return null;

      let files;
      try {
        files = await listInboxFiles();
      } catch (err) {
        // A directory that cannot be read is not "no drops": say so and stop,
        // rather than reporting a clean scan that silently saw nothing.
        console.warn('the ticket inbox could not be read:', err);
        return null;
      }

      const plan = planScan(files, get().tickets);
      if (plan.fresh.length === 0 && plan.known.length === 0) {
        return { created: 0, known: 0, empty: plan.empty };
      }

      // **Every fresh drop is `open`.** Nothing here calls `startTicket`: a
      // program that can write a file must not be able to make work begin, for
      // the same reason it cannot make a Ticket `done`.
      const born: Ticket[] = [];
      const now = Date.now();
      for (const [index, drop] of plan.fresh.entries()) {
        // One `now` for the batch would give every Ticket the same timestamp,
        // which is fine for the record but makes the list order arbitrary; a
        // millisecond apart keeps arrival order readable.
        const base = emptyTicket(now + index);
        const ticket: Ticket = {
          ...base,
          // `emptyTicket` mints its own id and `created` event; both are wanted.
          title: drop.title,
          brief: drop.brief,
          origin: originOf(drop),
        };
        // The ceilings `ticket_bind` enforces are checked here too: a drop that
        // would be refused at Start must not reach the board at all.
        if (unbindableField(ticket) !== null) {
          console.warn(`inbox file ${drop.file} carries a brief the runtime would refuse; left in place`);
          continue;
        }
        born.push(ticket);
      }

      if (born.length > 0) commitList([...get().tickets, ...born]);

      // Archive only what this scan accounted for: a fresh drop whose Ticket was
      // created, and a known one. A drop left in place (empty, or too long) is
      // still a person's to fix, so its file must stay where they can see it.
      const archivable = [
        ...plan.fresh.filter((drop) => born.some((ticket) => sameDrop(ticket, drop))),
        ...plan.known,
      ];
      for (const drop of archivable) {
        try {
          await archiveInboxFile(drop.file);
        } catch (err) {
          // The Ticket exists; a file that stays behind is re-scanned and
          // matched as `known` next time, so this is untidy, not wrong.
          console.warn(`inbox file ${drop.file} could not be archived:`, err);
        }
      }

      return { created: born.length, known: plan.known.length, empty: plan.empty };
    },
  };
}

/** Whether a Ticket answers this drop. Used to pick the files to archive, so a
 *  drop refused for length is not archived as if it had been taken. */
function sameDrop(ticket: Ticket, drop: InboxDrop): boolean {
  return (
    ticket.origin.kind === 'source' &&
    ticket.origin.source === drop.source &&
    ticket.origin.thread === drop.thread
  );
}
