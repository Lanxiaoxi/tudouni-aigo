/**
 * The terminal tails: one per terminal id, bounded, copy-on-write.
 *
 * These are the store's pure half of the terminal pane — everything here takes
 * the map and returns a new one, so it is testable without a store. They were
 * declared in `store.ts`; that file re-exports them, so no call site changed.
 */
import type { TerminalRow } from '@/protocol/types';
import {
  applyTerminalOutput,
  DEFAULT_VIEWPORT_ROWS,
  EMPTY_TERMINAL_STATE,
  fitViewport,
  initialTerminalState,
} from '@/runtime/terminalOutput';
import type { VmModel } from '@/runtime/adapt';
import type { FrontMessage } from '@/state/entries';
import type { SessionRuntime, TerminalTail } from './types';

/**
 * How many lines of one terminal's output this front end keeps.
 *
 * The runtime keeps **none** by design — a terminal's output must not become a
 * second terminal — so showing more than the last screenful is necessarily this
 * end's job. 4000 lines is about fifty screens; a build log is megabytes, and an
 * unbounded buffer would make this window's memory grow with the length of a
 * command somebody ran.
 */
export const TERMINAL_SCROLLBACK = 4000;

/** The shared empty tail, so a selector's fallback is a stable reference. */
export const EMPTY_TAIL: TerminalTail = EMPTY_TERMINAL_STATE;

/**
 * Apply one output batch to a terminal's bounded tail.
 *
 * The work is in `applyTerminalOutput`, which is pure and tested on its own; this
 * function's job is the store-shaped half — the per-terminal keying and the
 * copy-on-write.
 *
 * A terminal this window has never heard of starts with a **full-height screen**,
 * not the shared one-row placeholder: the cursor's row is addressed against the
 * screen's height, so a state that is one row tall would clamp every cursor row to
 * the top line until a resize happened to arrive.
 *
 * Copying rather than mutating is required, not tidiness: the store's selectors
 * compare by identity, so mutating the object a previous state holds is how a React
 * render silently shows nothing new.
 */
export function appendTerminalOutput(
  store: Record<string, TerminalTail>,
  id: string,
  data: string,
): Record<string, TerminalTail> {
  const existing = store[id] ?? initialTerminalState(DEFAULT_VIEWPORT_ROWS);
  return {
    ...store,
    [id]: applyTerminalOutput(existing, data, TERMINAL_SCROLLBACK),
  };
}

/**
 * Tell one terminal how tall its screen is.
 *
 * The pane measures itself and says so; this is the store's half of that, and it
 * exists separately from `appendTerminalOutput` because the two events are
 * genuinely different: bytes arrive constantly and the size changes when a rail is
 * folded. Keeping them apart is also what stops a resize from being charged to the
 * output — the pane would otherwise redraw its scrollback every time a panel opened.
 */
export function resizeTerminalTail(
  store: Record<string, TerminalTail>,
  id: string,
  rows: number,
): Record<string, TerminalTail> {
  // **A terminal with no output yet still gets its tail, and that is the whole of
  // this branch.** It used to `return store` here, on the reasoning that creating
  // a tail would throw away the size the next batch would have fitted itself to —
  // and the reasoning was backwards. A tail is created by whichever event arrives
  // first, and a pane's size *is* the first event: the view measures itself on
  // mount, before the shell has printed anything.
  //
  // Measured against a real ConPTY, returning early produced exactly this, and it
  // is the screenshot this was reported from:
  //
  //   1. the pane mounts, measures 30 rows, sends `terminal_resize`;
  //   2. the tail does not exist yet, so the 30 is **dropped on the floor**;
  //   3. the shell's first byte arrives and the tail is born at the
  //      `DEFAULT_VIEWPORT_ROWS` fallback — **24**, while the shell is drawing a
  //      30-row screen;
  //   4. ConPTY answers the resize with a full repaint of its 30-row screen: home,
  //      then 29 `ESC[K\r\n`, then home again;
  //   5. a model that believes it has 24 rows scrolls six times on the way down.
  //
  // So the prompt ended up six blank lines below the top of the pane — "why does
  // it start from the middle" — and it stayed there, because nothing would ever
  // correct a `viewportRows` the shell had already been told about.
  const existing = store[id];
  if (!existing) {
    return { ...store, [id]: initialTerminalState(rows) };
  }
  const fitted = fitViewport(existing, rows);
  if (fitted === existing) return store;
  return { ...store, [id]: fitted };
}

/**
 * Replace one terminal's row, or append it when it was never seen.
 *
 * The exit event carries the whole row, so it is **replaced** rather than patched
 * field by field. Merging two fields by hand is how a row and the runtime end up
 * describing different terminals — and the append case is real: a shell can end
 * before this window ever received a snapshot that mentioned it.
 */
/**
 * Drop the tails of terminals the runtime no longer lists.
 *
 * The same identity rule as `appendTerminalOutput`, and it is not an
 * optimisation: a tail belongs to a terminal that exists, and one kept for an id
 * the runtime has forgotten is memory this window can never free — nothing will
 * ever append to it again, and nothing will ever draw it.
 *
 * The map is returned unchanged when nothing was dropped, so a snapshot that
 * mentions only terminals this window already knows does not re-render the pane.
 */
export function pruneTails(
  tails: Record<string, TerminalTail>,
  rows: TerminalRow[],
  keepId: string | null,
): Record<string, TerminalTail> {
  // **A tail is kept while its terminal is running, or while somebody is reading
  // it.** The row stays in the list either way — it is what answers "what was I
  // running" — but the *output* is up to 4000 lines, and a long session with a
  // dozen finished shells was holding a dozen of those for ever: nothing appends
  // to them any more, and only the attached one can be drawn.
  const kept = Object.keys(tails).filter((id) => {
    if (id === keepId) return true;
    return rows.some((row) => row.id === id && row.status === 'running');
  });
  if (kept.length === Object.keys(tails).length) return tails;
  const next: Record<string, TerminalTail> = {};
  for (const id of kept) next[id] = tails[id];
  return next;
}

export function replaceTerminal(rows: TerminalRow[], row: TerminalRow): TerminalRow[] {
  const at = rows.findIndex((candidate) => candidate.id === row.id);
  if (at < 0) return [...rows, row];
  const next = [...rows];
  next[at] = row;
  return next;
}

/**
 * Which terminal this window should be showing, out of the ones that are left.
 *
 * **Two callers, one rule**, and that is why it is a function rather than an
 * expression at each of them:
 *
 *   - the status bar's terminals badge, which has nothing attached and has to
 *     pick one when it is pressed;
 *   - `closeTerminal`, where the terminal being read is going away and staying
 *     put is not an option.
 *
 * The second one is a **bug fix, and the bug is worth writing down** because the
 * old behaviour looked deliberate: closing a tab set `activeTerminalId` to
 * `null` unconditionally, which is this window's "leave the terminal view". So a
 * person with two tabs who pressed the X on either one was thrown back to the
 * conversation — with the other shell still running behind them, reachable only
 * by going back in through the panel. The screenshot that reported it shows
 * exactly that: `term-02 running` and `term-05 running`, one closed, and the
 * transcript. Closing **the last** tab is the only case where leaving is right,
 * and that is what a `null` result means here.
 *
 * A running shell wins over an ended one: the reason a terminal page is open is
 * to type into something, and a row whose process is gone is a record. Newest
 * first among equals — the list is in creation order (`terminal.Manager.List`),
 * so the last match is the shell somebody opened most recently, which is the one
 * a person means when they say "the terminal".
 *
 * Exported and pure so the rule can be asserted without a window, a child or a
 * shell — see `tests/terminal.test.ts`.
 */
export function nextTerminalId(rows: TerminalRow[], exclude: string | null = null): string | null {
  const candidates = rows.filter((row) => row.id !== exclude);
  if (candidates.length === 0) return null;
  const running = candidates.filter((row) => row.status === 'running');
  const pool = running.length > 0 ? running : candidates;
  return pool[pool.length - 1].id;
}

/**
 * Install a full terminal list, and clean up what no longer has a terminal.
 *
 * One function because the rule is one rule, and it now has **two callers**: the
 * `ui(terminals)` reply, and `ui(state)`. The snapshot carries the workspace's
 * whole list too (`runtime.terminalsPanel`) precisely so a front end that started
 * after a shell existed — or that lost a message — learns about it rather than
 * never. Reading it in only one of the two places left that promise unfulfilled:
 * the field was declared on the wire type, projected nowhere, and the bucket's
 * list therefore only ever changed when a panel happened to be opened.
 *
 * The list is **replaced**, never merged. A union would keep a closed terminal's
 * tab alive for ever, which is the one thing `terminal_close` exists to prevent.
 *
 * Two leftovers go with it, and both would otherwise be permanent:
 *   - a **tail** for an id the runtime has forgotten can never receive another
 *     byte, and nothing will ever draw it;
 *   - an **attach** to a row that is gone would draw a terminal view with no tab
 *     to switch away from it.
 *
 * `'new'` is released here as well, because a **refused create** answers with this
 * same list rather than with a row (see the runtime's `handleTerminalCreate`).
 * Without that, one refusal would leave the button disabled for the rest of the
 * session.
 */
export function applyTerminalList(
  current: Pick<
    SessionRuntime,
    'terminals' | 'terminalTails' | 'activeTerminalId' | 'terminalPending'
  >,
  rows: TerminalRow[],
): Partial<SessionRuntime> {
  const stillThere =
    current.activeTerminalId !== null && rows.some((row) => row.id === current.activeTerminalId);
  return {
    terminals: rows,
    terminalTails: pruneTails(current.terminalTails, rows, current.activeTerminalId),
    activeTerminalId: stillThere ? current.activeTerminalId : null,
    terminalPending: current.terminalPending.filter((id) => id !== 'new'),
  };
}

/**
 * Re-stamp each catalogue row's `current` from the snapshot's live model.
 *
 * The catalogue's flag is written once, at `init`, and the snapshot is the only
 * later message that names the model actually in effect. Without this the flag
 * stays on the first row forever after a model is chosen — which is what left
 * the panel's "current" badge pinned while the top bar (reading `session.model`)
 * moved on. This is the same rule the TUI's picker applies rather than trusting
 * the stored flag: `current` is "this row is the one in effect", recomputed from
 * the live model, not a fact the catalogue asserts.
 *
 * The comparison is `id` **and** `provider`, exactly as the runtime stamps it
 * (`modelCatalog`): two routes can serve a same-named model, and only the pair
 * is the answer — a same-name row on another route must not light up too.
 *
 * Reconcile, and emit only when something actually moved. The snapshot rides on
 * every tool result and turn end, so a fresh array on each one would re-render
 * the model panel on every snapshot even when the model is unchanged. If every
 * row's flag already agrees with the snapshot's model, the same list reference
 * is returned — nothing to draw, no re-render. Only the one snapshot after a
 * real switch produces a corrected array, and that is the moment the badge must
 * move.
 *
 * An absent model (the projection's `''`) or provider names nothing to mark, so
 * the stored flags are left alone rather than wiped.
 */
export function recomputeModelCurrent(
  models: VmModel[],
  snapModel: string,
  snapProvider: string,
): VmModel[] {
  if (models.length === 0 || snapModel === '' || snapProvider === '') return models;
  let changed = false;
  for (const row of models) {
    if (row.current !== (row.id === snapModel && row.provider === snapProvider)) {
      changed = true;
      break;
    }
  }
  if (!changed) return models;
  return models.map((row) => ({
    ...row,
    current: row.id === snapModel && row.provider === snapProvider,
  }));
}

/**
 * A front end note about a terminal ending, as the code the store holds.
 *
 * The **sentence** lives in `i18n` (`note.text.terminalEnded*`), not here: the
 * store records facts, and this used to return English from the reducer — which
 * put the one line a person reads about a dead shell out of the translation
 * table's reach. See `FrontMessage`.
 *
 * It is still a function rather than an object literal at the call site because
 * the three endings have to stay distinguishable: `killed`, `exited` with a code,
 * and `exited` without one are different facts, and printing a number for the
 * last would invent one.
 */
export function terminalEndedNote(
  id: string,
  reason: 'exited' | 'killed',
  code: number | null,
): FrontMessage {
  return { code: 'terminalEnded', id, reason, exitCode: code };
}
