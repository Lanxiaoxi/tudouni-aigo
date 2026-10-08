import type { Entry } from '@/state/entries';

/**
 * The transcript's turn rail: one mark per turn, down the right edge.
 *
 * This module is the **pure** half — marks, their previews, and which one the
 * reader is in. `components/stream/TurnRail.tsx` is the drawing half. They are
 * split for the usual reason: the rules below are where the defects live, and a
 * rule that can only be observed by scrolling a window is a rule that gets
 * discovered by a person rather than by a test.
 *
 * ### Why the rail numbers its own turns
 *
 * A mark could carry `entry.ordinal` — the turn head's own display number. It
 * does not, on purpose. `ordinal` is "a local ordinal over turns received"
 * (`entries.ts`), so after `session_load` rebuilds a stored transcript from
 * `user`/`answer` rows — which carry no turn number at all — the next live turn
 * is numbered `1` while the rail, numbering by position, is on turn 40. The
 * ordinal is a fact about *this window's* turns; the rail is a map of the
 * *conversation*. Where the two disagree the rail is the one telling the truth,
 * so the rail counts for itself and lets the hover card say which mark it is.
 */

/** One mark on the rail. */
export interface RailTurn {
  /** 1-based position in the conversation — the rail's own count, see above. */
  turn: number;
  /** `id` of the row this mark scrolls to. Every anchor row carries
   *  `data-anchor`; see `EntryView`. */
  anchor: string;
  /** The prompt that opened the turn, clipped for the hover card. `''` when no
   *  text ever opened it (a goal round, a scheduled turn). */
  prompt: string;
  /** The turn's final answer, clipped. `''` until the turn settles. */
  response: string;
  /** The turn is still in flight. Read off the head's own status, so the rail
   *  and the head can never disagree about it. */
  running: boolean;
}

/**
 * Preview budgets, in **characters**, matched to the hover card's clamps: one
 * line of prompt, up to three of response, in a card `min(320px, …)` wide.
 *
 * They are the same shape as the runtime's own previews elsewhere in this
 * interface, and they are deliberately counted in characters rather than
 * measured in pixels: a measured clamp is a layout read on every hover, and the
 * card already ends in `-webkit-line-clamp`, which is the thing that actually
 * guarantees the height.
 */
export const PROMPT_LIMIT = 50;
export const RESPONSE_LIMIT = 120;

/**
 * How many turns a transcript needs before the rail is worth its lane.
 *
 * Read by `StreamView`, which owns the decision because it is the thing that has
 * to leave the 36px out of the transcript's width. One mark is not navigation —
 * and a lone dash down the edge of a column reads as a rendering artifact — so
 * the lane is not taken until there is somewhere to go.
 */
export const MIN_RAIL_TURNS = 2;

/**
 * Where a jumped-to turn head lands, in px below the top of the transcript.
 *
 * A heading flush against the top edge reads as a row that has been cut in half —
 * no sticky bar covers the transcript — so a jump leaves this much air above it.
 * `StreamView` publishes it as `--rail-landing` and the stylesheet spends it on
 * `scroll-margin-top`; the number lives here because the rule below has to agree
 * with it, and two constants in two files is how they stop agreeing.
 */
export const LANDING_PX = 12;

/**
 * How close to the top a heading has to get before it counts as scrolled past.
 *
 * Strictly larger than `LANDING_PX`, and that is the whole point: a jump puts the
 * heading `LANDING_PX` below the top, and if the band were the same width with a
 * sub-pixel landing the mark would light up as the turn *before* the one that was
 * clicked. The band is a few px of slack for exactly that rounding.
 */
export const HEADING_BAND_PX = LANDING_PX + 4;

/** Collapse whitespace and clip, marking the clip. `''` stays `''`. */
export function preview(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** A turn before its response has been read out of the transcript. */
interface Draft {
  anchor: string;
  prompt: string;
  running: boolean;
  /** Half-open span of entry indexes the response is read from. */
  from: number;
  to: number;
}

/**
 * Where each turn begins and ends, as indexes into `entries`.
 *
 * Two kinds of turn are folded here, and the difference between them is the
 * whole reason this function exists rather than a `.filter`.
 *
 * **A live turn** opens at its `turn` head. Its prompt, though, is *above* the
 * head: `submitDraft` appends the `user` echo and only then sends the message
 * that produces `run_started`. So the head absorbs the **last** unclaimed `user`
 * row above it, and nothing else can claim that row — nothing is appended
 * between the echo and the head.
 *
 * **A stored turn** has no head. `session_load` rebuilds the transcript from the
 * session's own message list, which is `{role, content}` and carries no turn
 * boundary at all (`internal/runtime/composition.go`, `Messages()`), so
 * `store.ts` emits `user` and `answer` rows and no `turn` row. Those turns are
 * therefore opened by their `user` row and closed where the next one opens —
 * which is exactly the `user`/`answer` pairing the history arrived in.
 *
 * The rule that separates the two is positional and is worth stating plainly:
 * **for each `turn` head, every unclaimed `user` row above it except the last is
 * a stored turn; the last one is the head's own echo.**
 *
 * That reading is safe because this build has no steering: the composer replaces
 * its send button with **interrupt** while a turn is running (`Composer.tsx`), so
 * a second `user` row cannot be appended inside an open turn and the only rows
 * the rule can meet are echoes and stored history. Should steering ever arrive,
 * a mid-turn prompt would become a turn of its own — wrong, but wrong in the
 * harmless direction, and the assertion that catches it is in
 * `tests/turn-rail.test.ts`.
 */
function drafts(entries: Entry[]): Draft[] {
  const out: Draft[] = [];
  /** `user` rows seen since the last group opened, with their position. */
  let pending: { row: Extract<Entry, { kind: 'user' }>; at: number }[] = [];
  let open: Draft | null = null;

  const close = (at: number) => {
    if (open === null) return;
    open.to = at;
    out.push(open);
    open = null;
  };

  /** Stored turns, each closed where the next `user` row begins. */
  const flush = (end: number) => {
    pending.forEach((item, index) => {
      const next = pending[index + 1];
      out.push({
        anchor: item.row.id,
        prompt: item.row.text,
        running: false,
        from: item.at + 1,
        to: next ? next.at : end,
      });
    });
    pending = [];
  };

  entries.forEach((entry, at) => {
    if (entry.kind === 'user') {
      pending.push({ row: entry, at });
      return;
    }
    if (entry.kind !== 'turn') return;

    // Closed first, then the stored turns above the echo, then the head — so a
    // mark's order on the rail is the order of the conversation even when a
    // previous turn is still open.
    close(at);
    const echo = pending.pop();
    flush(at);
    open = {
      anchor: entry.id,
      prompt: echo?.row.text ?? '',
      // The same field the turn head draws its badge from: a rail that decided
      // "running" for itself would be a second answer to one question.
      running: entry.status === 'running',
      from: at + 1,
      to: at,
    };
  });

  // Close the turn in flight **before** the rows below it, for the same reason as
  // the head branch: a mark's position on the rail has to be the order of the
  // conversation, and a trailing `user` row is after the turn that preceded it.
  close(entries.length);
  flush(entries.length);
  return out;
}

/**
 * Every turn in the transcript, in order, ready for the rail.
 *
 * Returns `[]` for a transcript with no turns in it — notices, blocks and the
 * handshake's own lines are not conversation and get no marks. Whether the rail
 * is drawn at all is `MIN_RAIL_TURNS`'s business, not this function's.
 */
export function turnRail(entries: Entry[]): RailTurn[] {
  return drafts(entries).map((draft, index) => {
    // The response is the **last** answer in the span, not the first: a turn can
    // answer more than once (a steering message produces a second assistant
    // message), and the one a reader wants on the card is how it ended.
    let response = '';
    for (let i = draft.from; i < draft.to; i += 1) {
      const entry = entries[i];
      if (entry !== undefined && entry.kind === 'answer' && entry.text.trim() !== '') {
        response = entry.text;
      }
    }
    return {
      turn: index + 1,
      anchor: draft.anchor,
      prompt: preview(draft.prompt, PROMPT_LIMIT),
      response: preview(response, RESPONSE_LIMIT),
      running: draft.running,
    };
  });
}

/**
 * Which mark the reader is in, from the anchor rows' tops relative to the
 * visible top of the transcript.
 *
 * The rule is "the last turn whose heading has been scrolled past", which is the
 * same thing a person means by "I am in this turn". `offsets` are in transcript
 * order, and `limit` is how far below the top a heading still counts as passed —
 * `HEADING_BAND_PX` by default, so that a heading a jump just landed on is the
 * active one rather than its predecessor.
 *
 * **A row that is off screen is not measured here, and that is deliberate.**
 * Rows carry `content-visibility: auto` (`app.css`), so a far-off row's position
 * is an estimate and only the rows around the viewport are laid out for real —
 * and those are precisely the ones near the crossing point this reads. The
 * comparison is also order-preserving, so an estimated row above the fold can
 * only ever read as "above", which is the answer anyway.
 */
export function activeMark(offsets: number[], limit = HEADING_BAND_PX): number | null {
  if (offsets.length === 0) return null;
  let active = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    const top = offsets[i];
    if (top !== undefined && top <= limit) active = i;
  }
  return active;
}
