/**
 * The ticket inbox: work that did not come from a button.
 *
 * `~/.tudouni/tickets/inbox/` is a **one-way door**. A script, another agent or
 * a person's editor may drop a `.md` file there; the desktop reads it, turns it
 * into an **OPEN** Ticket, and moves the file into `processed/`. Nothing outside
 * this app ever writes `tickets.json`, which is what keeps the "exactly one
 * writer" rule true (`docs/design/ticket.md` §6.3) while still letting work
 * arrive from somewhere other than the New Ticket dialog.
 *
 * ## Three rules this module exists to keep
 *
 * 1. **A drop never starts work.** What arrives is `open`: the person still
 *    presses Start. This is the whole difference between an inbox and an
 *    autoresponder, and it is the same rule that keeps `done` a person's
 *    verdict — an outside program may propose, not command.
 * 2. **The same drop yields one Ticket.** Re-scanning is the normal case (the
 *    scan runs on every board open), so the source and thread in the file are
 *    the idempotence key, checked against the Tickets that already exist. A
 *    redelivered issue adds a file, not a Ticket.
 * 3. **A bad file is skipped, not fatal.** One unreadable drop must not hide the
 *    nine good ones beside it, and must not stop the board from loading.
 *
 * ## The file
 *
 * ```markdown
 * ---
 * source: github
 * thread: issue#123
 * ---
 * Fix the blank page in Safari.
 * ```
 *
 * The front matter is optional; without it the source is `inbox` and the thread
 * is the file's stem, so a person can drop a plain note and still get a Ticket.
 * Everything after the front matter is the brief.
 */
import type { Ticket, TicketOrigin } from './model';

/** The directory names inside `~/.tudouni/tickets/`. Mirrors
 *  `src-tauri/src/tickets_data.rs`, which owns the real paths. */
export const INBOX_DIR = 'inbox';
export const PROCESSED_DIR = 'processed';

/** What a source that did not name itself is called. */
export const DEFAULT_SOURCE = 'inbox';

/** One file as the Rust door returned it. */
export interface InboxFile {
  /** The file's stem, without `.md`. Also the fallback thread. */
  name: string;
  text: string;
}

/** A drop, read and understood. */
export interface InboxDrop {
  /** The idempotence key. */
  source: string;
  thread: string;
  /** The file's stem, kept so the original can be found under `processed/`. */
  file: string;
  /** The Ticket's title: the first line of the brief, or the front matter's own
   *  `title` when it has one. */
  title: string;
  /** The work, and what the session is given. */
  brief: string;
}

/** The front matter fields this build reads. Anything else is ignored rather
 *  than rejected: a source that adds a field should not stop the drop. */
const KNOWN_FIELDS = new Set(['source', 'thread', 'title']);

/**
 * Split `---` front matter from the body.
 *
 * Deliberately a tiny parser rather than a YAML dependency: the shape is
 * `key: value` lines between two `---` rules, and a full YAML parser would
 * accept documents this door has no business accepting (nested maps, anchors,
 * multi-document streams). Every line that is not a known field is ignored.
 *
 * A file that opens with `---` but never closes it has no front matter and is
 * read as a plain body: guessing where the block was meant to end would turn
 * the first paragraph of somebody's brief into a field.
 */
export function splitFrontMatter(text: string): { fields: Record<string, string>; body: string } {
  const normalised = text.replace(/^\uFEFF/, '');
  const lines = normalised.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { fields: {}, body: normalised };

  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close === -1) return { fields: {}, body: normalised };

  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, close)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1].toLowerCase();
    if (!KNOWN_FIELDS.has(key)) continue;
    fields[key] = match[2].trim();
  }
  return { fields, body: lines.slice(close + 1).join('\n') };
}

/** The first non-empty line of a body, trimmed and cut, as `ticketTitle` does
 *  for a brief with no title of its own. */
function firstLine(body: string): string {
  const line = body.split(/\r?\n/).find((row) => row.trim() !== '')?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * Read one drop, or `null` when it carries no work.
 *
 * Empty is the one refusal: a file whose body is blank would become a Ticket
 * nobody can start (`start` refuses an empty brief), so it is reported as
 * nothing rather than added to the board.
 */
export function parseInboxFile(file: InboxFile): InboxDrop | null {
  const { fields, body } = splitFrontMatter(file.text);
  const brief = body.trim();
  if (brief === '') return null;
  // The source is folded to lower case because it is half of the idempotence
  // key, and two programs spelling it `GitHub` and `github` are describing the
  // same feed — without this, the second spelling yields a duplicate Ticket and
  // nothing anywhere reports it. `thread` is deliberately **not** folded: it
  // may name a path or an id whose case is meaningful, and two threads that
  // differ only in case are two threads.
  const source = (fields.source ?? '').trim().toLowerCase() || DEFAULT_SOURCE;
  const thread = (fields.thread ?? file.name).trim() || file.name;
  const title = (fields.title ?? '').trim() || firstLine(brief);
  return { source, thread, file: file.name, title, brief };
}

/** The origin a drop becomes. */
export function originOf(drop: InboxDrop): TicketOrigin {
  return { kind: 'source', source: drop.source, thread: drop.thread, file: drop.file };
}

/**
 * Whether a Ticket is already answering this drop.
 *
 * **Any status counts except a finished one**: a dropped or done Ticket was
 * somebody's answer to this thread, so a redelivery of it is the same request
 * arriving again — not new work. `done` is deliberately included with `dropped`:
 * the issue was fixed, and re-opening it on every scan would be a machine
 * undoing a person's verdict.
 *
 * The match is on the pair, never on the file name: two different issues from
 * one source are two Tickets whose files happen to share a prefix.
 */
export function hasTicketFor(tickets: readonly Ticket[], drop: InboxDrop): boolean {
  return tickets.some((ticket) => {
    if (ticket.origin.kind !== 'source') return false;
    return ticket.origin.source === drop.source && ticket.origin.thread === drop.thread;
  });
}

/** What one scan did, for a sentence in the UI and for a test. */
export interface InboxScan {
  /** Drops that need a new Ticket; a known `source/thread` is excluded. */
  fresh: InboxDrop[];
  /** Drops whose Ticket already exists: archived without a new Ticket. */
  known: InboxDrop[];
  /** Files that carried no work, and are left in place for a person to fix. */
  empty: string[];
}

/**
 * Turn a listing into the drops worth acting on.
 *
 * Pure: the caller does the archiving and the storing. Two filters, in order —
 * a blank file is left where it is (a person may still be typing into it), and
 * a drop whose Ticket already exists is archived without a new Ticket.
 *
 * **"Already exists" includes this batch.** Two files naming the same
 * `source/thread` in one scan are one request delivered twice, so only the
 * first becomes a Ticket and the rest are archived as `known` — the same
 * answer the second file would get if it had arrived one scan later.
 */
export function planScan(files: readonly InboxFile[], tickets: readonly Ticket[]): InboxScan {
  const fresh: InboxDrop[] = [];
  const known: InboxDrop[] = [];
  const empty: string[] = [];
  // NUL cannot appear in either half (both come from one line of front matter
  // or a file name), so the joined key cannot make two pairs collide.
  const batch = new Set<string>();
  for (const file of files) {
    const drop = parseInboxFile(file);
    if (drop === null) {
      empty.push(file.name);
      continue;
    }
    const key = `${drop.source}\u0000${drop.thread}`;
    if (batch.has(key) || hasTicketFor(tickets, drop)) {
      known.push(drop);
      continue;
    }
    batch.add(key);
    fresh.push(drop);
  }
  return { fresh, known, empty };
}
