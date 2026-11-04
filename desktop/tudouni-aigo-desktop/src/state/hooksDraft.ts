/**
 * The hooks panel's form, as data.
 *
 * Kept out of the component for the reason the effort probe's write-back rules are:
 * every claim here is invisible in a window. A refused save that throws the typing
 * away, a result still shown beside a command it did not come from, a "dirty" flag
 * that never clears — each is easy to write and hard to see, and all of them are pure.
 *
 * **The runtime is the validator.** It runs the check start-up uses over the bytes it
 * would write and refuses anything start-up would refuse. What is checked here is only
 * what makes a row meaningless on its face (no name, no command, two hooks with one
 * name), so that Save is not offered for a form that cannot possibly be accepted; a
 * second copy of the full rules would be a second answer that eventually disagrees.
 */
import type {
  HookDraftEntry,
  HookEventInfo,
  HookRow,
  HooksDocument,
  HooksSnapshot,
} from '@/protocol/types';

/** One row of the form. `uid` is the React key and never leaves the browser;
 *  `seed` is what the runtime resolved for the **saved** version of this row.
 *
 *  A saved row's `uid` is made from its event and name rather than from a counter, so a
 *  card that was open stays open when the form is re-drawn from the runtime's answer to
 *  a save. It is assigned once and does not follow the name while it is being typed. */
export interface DraftRow extends HookDraftEntry {
  uid: string;
  seed: HookRow | null;
}

export interface Draft {
  /** Carried through untouched: the form has no field for the file's `defaults`,
   *  and dropping them on save would silently change every hook that follows them. */
  defaults: HooksDocument['defaults'];
  rows: DraftRow[];
}

let uidCounter = 0;

/** A key for a row that is not in the file yet. */
export function nextUid(): string {
  uidCounter += 1;
  return `new:${uidCounter}`;
}

function entryOf(row: HookRow): HookDraftEntry {
  return {
    event: row.event,
    name: row.name,
    matcher: row.matcher,
    command: row.command,
    shell: row.shell,
    timeout_ms: row.timeout_ms,
    max_output_bytes: row.max_output_bytes,
    fail_closed: row.fail_closed,
    enabled: row.enabled,
    status_message: row.status_message,
  };
}

/** The form as the runtime's snapshot describes it. */
export function seedDraft(snapshot: HooksSnapshot): Draft {
  return {
    defaults: { ...snapshot.defaults },
    rows: snapshot.entries.map((row) => ({
      ...entryOf(row),
      uid: `saved:${row.event}/${row.name}`,
      seed: row,
    })),
  };
}

/** The first protocol revision that has the hooks panel. A runtime below it would
 *  answer `hooks_list` with nothing, and a button that answers with nothing is a
 *  promise the runtime cannot keep. */
export const HOOKS_MIN_PROTOCOL = 16;

/** One row without the browser's own fields. The key order is fixed on purpose:
 *  `rowEdited` and `isDirty` compare these as text. */
function entryFromRow(row: DraftRow): HookDraftEntry {
  return {
    event: row.event,
    name: row.name.trim(),
    matcher: row.matcher,
    command: row.command,
    shell: row.shell,
    timeout_ms: row.timeout_ms,
    max_output_bytes: row.max_output_bytes,
    fail_closed: row.fail_closed,
    enabled: row.enabled,
    status_message: row.status_message,
  };
}

/** What `hooks_action(save)` carries: the whole form, without the browser's own fields. */
export function toDocument(draft: Draft): HooksDocument {
  return { defaults: { ...draft.defaults }, entries: draft.rows.map(entryFromRow) };
}

/** Whether this row says something the saved row does not. A row that was never saved is
 *  always edited. */
export function rowEdited(row: DraftRow): boolean {
  if (row.seed === null) return true;
  return JSON.stringify(entryOf(row.seed)) !== JSON.stringify(entryFromRow(row));
}

/** Apply a field change. Switching event also drops the settings the new event cannot use:
 *  a matcher on an event with no tool name, or `fail_closed` on one whose answer has
 *  nowhere to go, would otherwise stay in the file as something that looks meaningful. */
export function withPatch(
  row: DraftRow,
  patch: Partial<HookDraftEntry>,
  events: readonly HookEventInfo[],
): DraftRow {
  const next: DraftRow = { ...row, ...patch };
  if (patch.event !== undefined && patch.event !== row.event) {
    const info = events.find((event) => event.name === patch.event);
    if (info !== undefined && !info.tool_event) next.matcher = '';
    if (info !== undefined && !info.can_decide) next.fail_closed = null;
  }
  return next;
}

/** The index of the nearest row of the **same event** in that direction, or -1.
 *  Hooks of one event run in list order, and rows of different events never swap
 *  places: the order between events means nothing, and a move that crossed one would
 *  look like it did something. */
function neighbour(draft: Draft, index: number, direction: -1 | 1): number {
  const event = draft.rows[index]?.event;
  for (let at = index + direction; at >= 0 && at < draft.rows.length; at += direction) {
    if (draft.rows[at]?.event === event) return at;
  }
  return -1;
}

export function canMove(draft: Draft, index: number, direction: -1 | 1): boolean {
  return neighbour(draft, index, direction) !== -1;
}

export function moveRow(draft: Draft, index: number, direction: -1 | 1): Draft {
  const other = neighbour(draft, index, direction);
  const a = draft.rows[index];
  const b = draft.rows[other];
  if (other === -1 || a === undefined || b === undefined) return draft;
  const rows = draft.rows.slice();
  rows[index] = b;
  rows[other] = a;
  return { ...draft, rows };
}

/** Whether the form says something the file does not.
 *
 *  Compared as documents, not row by row: the order of the rows is part of what a
 *  save writes (hooks of one event run in file order), so a move is a change. */
export function isDirty(draft: Draft, snapshot: HooksSnapshot): boolean {
  return JSON.stringify(toDocument(draft)) !== JSON.stringify(toDocument(seedDraft(snapshot)));
}

/**
 * Whether an incoming snapshot should replace the form.
 *
 * The answer to a save arrives as a snapshot either way. After a **successful** save the
 * form must be re-drawn from it (the runtime may have normalised what was typed). After a
 * **refusal** it must not: the person's typing is the only copy of what they were doing,
 * and throwing it away because one field was wrong is the worst thing a form can do.
 *
 * The one refusal that does re-draw is the stale one, recognisable by the revision having
 * moved: the file is no longer the one this form was written against, so keeping the
 * typing would be offering to save over somebody else's edit. The notice says so.
 */
export function shouldReseed(
  seededRevision: string | null,
  snapshot: HooksSnapshot,
  problem: string | null,
): boolean {
  if (seededRevision === null) return true;
  if (problem === null) return true;
  return snapshot.file.revision !== seededRevision;
}

export type DraftProblemCode = 'noName' | 'noCommand' | 'duplicate' | 'tooMany';

export interface DraftProblem {
  code: DraftProblemCode;
  /** 1-based row number, as a person counts. */
  row: number;
  name: string;
  event: string;
}

/** What makes a row meaningless on its face. See the file's note on why this is short. */
export function problemsOf(draft: Draft, maxPerEvent: number): DraftProblem[] {
  const out: DraftProblem[] = [];
  const seen = new Set<string>();
  const perEvent = new Map<string, number>();
  const reportedTooMany = new Set<string>();

  draft.rows.forEach((row, index) => {
    const name = row.name.trim();
    const problem = (code: DraftProblemCode): DraftProblem => ({ code, row: index + 1, name, event: row.event });

    if (name === '') out.push(problem('noName'));
    if (row.command.trim() === '') out.push(problem('noCommand'));

    if (name !== '') {
      const key = `${row.event}\u0000${name}`;
      if (seen.has(key)) out.push(problem('duplicate'));
      seen.add(key);
    }

    const count = (perEvent.get(row.event) ?? 0) + 1;
    perEvent.set(row.event, count);
    if (count > maxPerEvent && !reportedTooMany.has(row.event)) {
      reportedTooMany.add(row.event);
      out.push(problem('tooMany'));
    }
  });
  return out;
}

/** A name no row of this event has yet: `hook-1`, `hook-2`, … */
export function freshName(draft: Draft, event: string): string {
  const taken = new Set(draft.rows.filter((row) => row.event === event).map((row) => row.name.trim()));
  let n = draft.rows.length + 1;
  while (taken.has(`hook-${n}`)) n += 1;
  return `hook-${n}`;
}

/** A blank hook on the event that matters most: the gate before a tool call. */
export function blankRow(draft: Draft): DraftRow {
  const event = 'pre_tool_use';
  return {
    uid: nextUid(),
    seed: null,
    event,
    name: freshName(draft, event),
    matcher: '',
    command: '',
    shell: false,
    timeout_ms: null,
    max_output_bytes: null,
    fail_closed: null,
    enabled: true,
    status_message: '',
  };
}

/**
 * What the runtime said about the **saved** version of this row — or null when what is on
 * screen is no longer that row.
 *
 * Renaming a hook or moving it to another event makes it a different hook as far as the
 * session is concerned (the result is recorded under event and name), and a result shown
 * beside a hook it was not recorded for is a statement about a script that has not run.
 */
export function savedFacts(row: DraftRow): HookRow | null {
  if (row.seed === null) return null;
  if (row.seed.name !== row.name.trim() || row.seed.event !== row.event) return null;
  return row.seed;
}

/** Whether the saved row's lookup of the program still describes the command on screen. */
export function sameCommand(row: DraftRow): boolean {
  return row.seed !== null && row.seed.command === row.command && row.seed.shell === row.shell;
}

/** The program a command line starts: its first word, honouring a leading double quote.
 *  It is for a sentence ("was not found on PATH") and never for deciding anything. */
export function firstWord(command: string): string {
  const text = command.trim();
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    return end === -1 ? text.slice(1) : text.slice(1, end);
  }
  const space = text.search(/\s/);
  return space === -1 ? text : text.slice(0, space);
}

/** The text of a number field: empty means "not written in the file". */
export function parseWhole(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value > 0 ? value : null;
}
