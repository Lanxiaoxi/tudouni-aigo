/**
 * The only module that reads or writes `~/.tudouni/tickets/tickets.json`.
 *
 * `slices/tickets.ts` is just this file wired into zustand; a Ticket store that
 * moves somewhere else (a runtime-side database, a server) replaces this module
 * and nothing above it (`docs/design/ticket.md` §6.2, §9).
 *
 * The rules it owns:
 *
 *   - **A file it cannot fully understand is never written over.** The Rust
 *     door moves bytes and will replace anything, so the refusal lives here:
 *     a file from a newer schema, a file that is not JSON, and a read that
 *     failed all load as *read-only*. Overwriting any of them with the empty
 *     shelf this build would otherwise hold is the one write that cannot be
 *     taken back. (Rust refuses the newer-schema case a second time on its own,
 *     in case another window of a newer build wrote the file after this one
 *     read it.)
 *   - **Writes are ordered.** Every change is a whole-file write, and two in
 *     flight could land out of order and leave the older snapshot on disk, so
 *     they are chained: each waits for the one before it.
 *   - **A record that fails `isValidTicket` is dropped whole** on load, never
 *     patched up.
 */
import { isHosted, readTicketsFile, writeTicketsFile } from '@/runtime/tauri';
import { TICKET_SCHEMA, isValidTicket, type Report, type Ticket, type TurnEnd } from './model';
import { apply, hasSeenReport, type TicketInput } from './machine';

export interface LoadedTickets {
  tickets: Ticket[];
  /** True when this build must not write the file back. */
  readOnly: boolean;
  /** Why it is read-only (or what was lost), for a notice. `null` when clean. */
  problem: string | null;
  /** How many records failed the guard and were dropped. */
  dropped: number;
}

/** What the file's text means, without touching the disk. */
export function parseTicketFile(text: string | null): LoadedTickets {
  if (text === null) return { tickets: [], readOnly: false, problem: null, dropped: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      tickets: [],
      readOnly: true,
      problem: 'tickets.json is not valid JSON; it was left untouched',
      dropped: 0,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      tickets: [],
      readOnly: true,
      problem: 'tickets.json is not a Ticket file; it was left untouched',
      dropped: 0,
    };
  }
  const file = parsed as Record<string, unknown>;
  const schema = file.schema;
  if (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 1) {
    return {
      tickets: [],
      readOnly: true,
      problem: 'tickets.json has no usable schema; it was left untouched',
      dropped: 0,
    };
  }
  const newer = schema > TICKET_SCHEMA;
  const records = Array.isArray(file.tickets) ? file.tickets : [];
  const tickets: Ticket[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const record of records) {
    // A duplicate id is a damaged file; keeping the first is as arbitrary as
    // any rule, and two Tickets answering to one id is worse.
    if (isValidTicket(record) && !seen.has(record.id)) {
      seen.add(record.id);
      tickets.push(record);
    } else {
      dropped += 1;
    }
  }
  return {
    tickets,
    readOnly: newer,
    problem: newer
      ? `tickets.json was written by a newer version (schema ${schema}); it is read-only here`
      : null,
    dropped,
  };
}

/** The file's text for a list of Tickets. Compact, like `desktop.json`. */
export function serializeTickets(tickets: Ticket[]): string {
  return JSON.stringify({ schema: TICKET_SCHEMA, tickets });
}

/* ============================================================
   The disk
   ============================================================ */

/** Whether the last load left the file unwritable. Process-wide because the
 *  file is: two stores in one window share it. */
let fileReadOnly = false;
/** The tail of the write chain. */
let chain: Promise<unknown> = Promise.resolve();

/** A test seam: this module's state outlives one suite. */
export function resetTicketStoreForTests(): void {
  fileReadOnly = false;
  chain = Promise.resolve();
}

/**
 * Read the file once. Never rejects: an unreadable file comes back read-only
 * with the reason, so the caller has one shape to handle.
 */
export async function loadTickets(): Promise<LoadedTickets> {
  let text: string | null;
  try {
    text = await readTicketsFile();
  } catch (err) {
    fileReadOnly = true;
    return {
      tickets: [],
      readOnly: true,
      problem: `tickets.json could not be read: ${String(err)}`,
      dropped: 0,
    };
  }
  const loaded = parseTicketFile(text);
  fileReadOnly = loaded.readOnly;
  return loaded;
}

/**
 * Write the whole list. Resolves to whether it landed; a refusal is reported
 * to the console and never thrown into a click handler, the same rule
 * `desktopData.flush` follows. A no-op outside Tauri (tests, `npm run dev`),
 * where there is no file.
 */
export function saveTickets(tickets: Ticket[]): Promise<boolean> {
  if (fileReadOnly || !isHosted()) return Promise.resolve(false);
  // Serialised now, not when the turn comes: the snapshot is the state at the
  // moment of the change, and a later change queues its own.
  const text = serializeTickets(tickets);
  const run = chain
    .then(() => writeTicketsFile(text))
    .then(() => true)
    .catch((err) => {
      console.error('tickets could not be written:', err);
      return false;
    });
  chain = run;
  return run;
}

/** Resolves when every write queued so far has settled. For tests and for a
 *  caller that must not read the file back before its own write landed. */
export function ticketWritesSettled(): Promise<void> {
  return chain.then(
    () => undefined,
    () => undefined,
  );
}

/* ============================================================
   Reconcile
   ============================================================ */

/**
 * Fold reports the Ticket has not seen into it, in the order given.
 *
 * Used when a bound session is opened: its metadata lists every report it ever
 * made, and one may have been lost in the narrow window between the runtime
 * writing it and this process saving it (design §6.3). **Idempotent** — a
 * report already folded in (live, or by an earlier reconcile) is skipped by id
 * inside the machine — so running it on every open is free. Returns the same
 * object when nothing was new, so a caller can skip the write.
 */
export function reconcile(ticket: Ticket, reports: Report[], turnEnds: TurnEnd[] = []): Ticket {
  // Merged by time, not "reports then turn ends": "stopped without reporting,
  // then reported" and "reported blocked, then stopped" end in different
  // statuses, and replaying one list after the other would swap them. At the
  // same millisecond the report goes first, because a turn that made a report
  // never produces a turn end; the tie can only mean the report came first.
  // `sort` is stable, so equal items keep the order the runtime gave them.
  const facts: Array<{ at: number; rank: number; fact: TicketInput }> = [
    ...reports.map((report) => ({
      at: report.atMs,
      rank: 0,
      fact: { type: 'reported', at: report.atMs, report } as TicketInput,
    })),
    ...turnEnds.map((turnEnd) => ({
      at: turnEnd.atMs,
      rank: 1,
      fact: { type: 'turnEnded', at: turnEnd.atMs, turnEnd } as TicketInput,
    })),
  ].sort((a, b) => a.at - b.at || a.rank - b.rank);

  let next = ticket;
  for (const { fact } of facts) {
    // Redelivery is already a no-op inside the machine for both kinds; the
    // report pre-check just skips the call.
    if (fact.type === 'reported' && hasSeenReport(next, fact.report.reportId)) continue;
    // Facts are never refused, so `ok` is always true here; the check is for
    // the type, and for a future refusal not to be silently skipped.
    const result = apply(next, fact);
    if (result.ok) next = result.ticket;
  }
  return next;
}
