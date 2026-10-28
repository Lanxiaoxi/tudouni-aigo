/**
 * The reveal engine: turning a burst-arrived chunk into a paced one.
 *
 * A model's output reaches this window in packets, not in a stream. The bridge
 * already holds each packet for a frame (`runtime/tauri.ts`, `deliverLines`),
 * which bounds *when* a chunk lands but does nothing about *how much* lands at
 * once: one SSE packet can carry several hundred characters, and the row that
 * draws them paints all of it in one commit. The reading experience is a
 * paragraph appearing, not a paragraph being written.
 *
 * This engine is the missing half: the full text accumulates as it always did,
 * and a per-frame cursor decides how many of its characters may be on screen
 * by the end of this frame. Everything here is pure state and arithmetic, so
 * the pacing can be asserted in Node rather than watched in a window — see
 * `tests/stream-reveal.test.ts`.
 *
 * ### Why the pacing curve looks like this
 *
 * `speed = base + backlog^1.25 × pressure`, capped. The exponent above 1 is the
 * point: a small backlog (the ordinary case, a few characters behind) reveals
 * just faster than it arrives, so the text stays within a character or two of
 * the wire; a large backlog (a stalled socket, a retry landing all at once)
 * accelerates superlinearly, so a hiccup is repaid in a fraction of a second
 * instead of leaving the visible text permanently behind. A linear curve had to
 * choose between lagging for seconds after a hiccup and typing too fast to
 * read; this one does neither.
 *
 * The numbers are lifted from `dsh-smooth-stream` (`useSmoothStreamContent.ts`,
 * `computeAdaptiveQueueStep`), which runs this curve against the same class of
 * problem in the same renderer framework. They are a hand-feel judgement, not a
 * derivation — which is exactly why the curve lives in one exported function.
 */

/** Reveal cadence with nothing queued ahead of the cursor, in characters/second. */
export const REVEAL_BASE_CPS = 90;

/**
 * Backlog's exponent in the pacing curve. Above 1 so a deep queue is cleared
 * superlinearly; see the module note. Changing this changes the *feel* and
 * nothing about correctness.
 */
export const REVEAL_ACCEL_EXPONENT = 1.25;

/** Multiplier on the backlog term — the curve's overall aggressiveness. */
export const REVEAL_PRESSURE = 0.85;

/** Hard ceiling, in characters/second, on the reveal cadence. */
export const REVEAL_MAX_CPS = 600;

/**
 * The visible text is never allowed to trail by more than this many characters.
 *
 * The pacing curve alone bounds the *rate*, not the *distance*: a long enough
 * stall would leave a queue that still takes the capped maximum to clear. This
 * ceiling is the floor under that — past it the cursor jumps forward, so a
 * pathological queue costs one frame of extra text rather than seconds of it.
 * 600 characters at the cap is one second, which is the longest lag this
 * window is willing to be seen in.
 */
export const REVEAL_MAX_LAG_CODEPOINTS = 600;

/**
 * Longest slice of elapsed time one frame's reveal may be paced by.
 *
 * Reveal volume is proportional to the frame's dt, which inverts into a
 * feedback loop: a long task or a GC pause makes dt large, that frame reveals
 * proportionally more text, and the next frame is heavier still — the visible
 * catch-up lurch. Two 60 Hz intervals is enough to repay a stall over the
 * following frames instead of in one.
 */
export const REVEAL_MAX_GROWTH_MS = 32;

/**
 * Hard ceiling on characters the completion drain may reveal per frame.
 *
 * 400 is three to six times what the pacing curve would spend at 60–120 Hz, so
 * an ordinary tail closes in one or two frames while a pathological one is still
 * spread across a handful rather than committed in a single layout.
 */
export const REVEAL_COMPLETION_CHARS_PER_FRAME = 400;

/**
 * The bounds a person may choose for the two exposed ends, and the clamps that
 * enforce them. One definition here because the curve's meaning lives here —
 * both the settings rows and the record validators import these rather than
 * each keeping a copy.
 *
 * The ranges are generous but bounded: below `MIN` a reply takes a visible
 * minute to appear at all, and above `MAX` the reveal is no longer paced
 * (at 60 Hz one frame already carries more text than that would reveal).
 */
export const REVEAL_BASE_CPS_MIN = 10;
export const REVEAL_BASE_CPS_MAX = 300;
export const REVEAL_MAX_CPS_MIN = 30;
export const REVEAL_MAX_CPS_MAX = 3000;

/** Clamp one setting into its range. Non-finite and non-integral input maps
 *  to the fallback: a record outlives every build, and a corrupted field must
 *  land on a value the curve was tuned around rather than on a guess. */
function clampCps(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** The base pace, clamped to its range. */
export function clampBaseCps(value: unknown, fallback: number = REVEAL_BASE_CPS): number {
  return clampCps(value, REVEAL_BASE_CPS_MIN, REVEAL_BASE_CPS_MAX, fallback);
}

/** The catch-up cap, clamped to its range and to at least the base — a cap
 *  below the base pace would make the curve's ordinary case run at the cap,
 *  and the two settings would fight over the same number. */
export function clampMaxCps(value: unknown, baseCps: number, fallback: number = REVEAL_MAX_CPS): number {
  return Math.max(clampCps(value, REVEAL_MAX_CPS_MIN, REVEAL_MAX_CPS_MAX, fallback), baseCps);
}

export interface RevealLimits {
  readonly baseCps: number;
  readonly exponent: number;
  readonly pressure: number;
  readonly maxCps: number;
  readonly maxLag: number;
}

export const DEFAULT_REVEAL_LIMITS: RevealLimits = {
  baseCps: REVEAL_BASE_CPS,
  exponent: REVEAL_ACCEL_EXPONENT,
  pressure: REVEAL_PRESSURE,
  maxCps: REVEAL_MAX_CPS,
  maxLag: REVEAL_MAX_LAG_CODEPOINTS,
};

export interface RevealStep {
  /** Code points this frame may make visible. */
  readonly chars: number;
  /**
   * Fractional remainder carried into the next frame. Non-zero is what lets a
   * cadence below one character per frame actually advance: without it,
   * `Math.floor` would round every small step to zero and the text would never
   * appear.
   */
  readonly debt: number;
  /** The cadence the step was taken at, in characters/second, for diagnostics. */
  readonly cps: number;
}

/**
 * How much of the backlog may be revealed this frame.
 *
 * @param backlog - Code points behind the cursor.
 * @param dtMs - Time since the previous frame.
 * @param debt - Fractional carry from the previous frame.
 * @param limits - The pacing curve; defaults to the module's.
 */
export function revealStep(
  backlog: number,
  dtMs: number,
  debt: number,
  limits: RevealLimits = DEFAULT_REVEAL_LIMITS,
): RevealStep {
  if (backlog <= 0) return { chars: 0, debt: 0, cps: 0 };

  const growthMs = Math.max(1, Math.min(dtMs, REVEAL_MAX_GROWTH_MS));
  const cps = Math.min(
    limits.maxCps,
    limits.baseCps + Math.pow(backlog, limits.exponent) * limits.pressure,
  );
  const accumulated = Math.max(0, debt) + (cps * growthMs) / 1000;
  const paced = Math.min(backlog, Math.floor(accumulated));

  // The lag ceiling, applied after the curve rather than inside it: a queue
  // deeper than this is cleared in one step and the carry is dropped, because
  // the whole point of the ceiling is to not owe the next frame anything.
  const floorChars = Math.max(0, backlog - limits.maxLag);
  if (paced < floorChars) return { chars: floorChars, debt: 0, cps };

  return { chars: paced, debt: paced >= backlog ? 0 : accumulated - paced, cps };
}

/** User-perceived characters (code points), not UTF-16 units. */
export function countCodePoints(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

/**
 * Advance a UTF-16 offset by whole code points.
 *
 * The cursor has to be addressable two ways at once: the pacing curve counts
 * characters, and a JS string is indexed by UTF-16 units. Advancing by units
 * would cut a surrogate pair in half at some frame boundary and paint a
 * replacement glyph for one frame — the "tofu flicker" that shows up on emoji
 * and on CJK extension characters. So the walk is always by code point, and it
 * is linear in what it consumes rather than in the string's length.
 *
 * @param text - The string being advanced through.
 * @param from - Starting UTF-16 offset.
 * @param count - Code points to consume.
 * @returns The new offset, and how many code points were actually available.
 */
export function advanceCodePoints(
  text: string,
  from: number,
  count: number,
): { offset: number; consumed: number } {
  let offset = Math.max(0, Math.min(from, text.length));
  let consumed = 0;
  while (offset < text.length && consumed < count) {
    const code = text.charCodeAt(offset);
    if (code >= 0xd800 && code <= 0xdbff && offset + 1 < text.length) {
      const next = text.charCodeAt(offset + 1);
      if (next >= 0xdc00 && next <= 0xdfff) offset += 1;
    }
    offset += 1;
    consumed += 1;
  }
  return { offset, consumed };
}

/**
 * The cursor over one accumulator string.
 *
 * The accumulated text already lives on the entry (`entry.text`), so this holds
 * no copy of it: it holds only *where the reader has got to*. That is the one
 * piece of state the renderer cannot derive, and keeping it here rather than in
 * the store preserves the rule the reducers are written under — the store is a
 * function of the event stream, and how far the eye has caught up is not an
 * event.
 */
export class RevealEngine {
  private text = '';
  private live = false;
  /** Code points the accumulator holds. */
  private targetCps = 0;
  /** UTF-16 offset of the cursor; how much of `text` is on screen. */
  private shownUtf16 = 0;
  /** The same cursor, in code points — what the pacing curve speaks. */
  private shownCps = 0;
  private debt = 0;
  /**
   * A stream is primed by its first push rather than started from zero.
   *
   * A row is created by its first delta, so that delta is what mounts this
   * engine, and at that moment there is nothing to smooth — the chunk has
   * already arrived and the person is waiting for it. Priming also makes a
   * remount (a quiet-mode switch, a list re-key) safe: the text that is already
   * there is *there*, and replaying it from zero would wipe a paragraph off the
   * screen and type it back out.
   */
  private primed = false;
  private readonly limits: RevealLimits;

  constructor(limits: Partial<RevealLimits> = {}) {
    this.limits = { ...DEFAULT_REVEAL_LIMITS, ...limits };
  }

  /**
   * Hand the current accumulator to the engine.
   *
   * @param text - The full accumulated text, as the entry holds it.
   * @param live - Whether the entry can still grow.
   */
  push(text: string, live: boolean): void {
    if (!this.primed) {
      this.primed = true;
      this.snap(text, live);
      return;
    }
    if (text === this.text) {
      // Same body, maybe a different liveness. It must **not** snap: going
      // non-live with a tail still held back is precisely the case the drain
      // exists for, and snapping here is how a reply ends one sentence short
      // of what the model said.
      this.live = live;
      return;
    }
    if (!text.startsWith(this.text)) {
      // A replacement rather than an append. Nothing about the cursor is
      // still true — the text it counted no longer exists — so it is dropped
      // and the new body appears at once instead of being typed out again.
      this.snap(text, live);
      return;
    }
    const appended = text.slice(this.text.length);
    this.text = text;
    this.targetCps += countCodePoints(appended);
    this.live = live;
  }

  /** Show everything currently accumulated, and stop pacing. */
  snap(text: string, live: boolean): void {
    this.text = text;
    this.targetCps = countCodePoints(text);
    this.shownUtf16 = text.length;
    this.shownCps = this.targetCps;
    this.debt = 0;
    this.live = live;
  }

  /**
   * Advance one frame.
   *
   * A live stream advances at the pacing curve. A **finished** one drains
   * instead: the text that is coming has already come, so the only question is
   * how fast the tail closes. It is capped rather than uncapped because the
   * tail can be hundreds of characters when a stream ends mid-burst, and the
   * one commit that shows all of them is a visible teleport — the same jerk the
   * pacing exists to prevent, at the exact moment the person is settling in to
   * read.
   */
  step(dtMs: number): void {
    const backlog = this.targetCps - this.shownCps;
    if (backlog <= 0) {
      this.debt = 0;
      return;
    }

    let chars: number;
    if (this.live) {
      const step = revealStep(backlog, dtMs, this.debt, this.limits);
      this.debt = step.debt;
      chars = step.chars;
    } else {
      this.debt = 0;
      chars = Math.min(backlog, REVEAL_COMPLETION_CHARS_PER_FRAME);
    }
    if (chars <= 0) return;

    const walked = advanceCodePoints(this.text, this.shownUtf16, chars);
    this.shownUtf16 = walked.offset;
    this.shownCps += walked.consumed;
    if (this.shownCps >= this.targetCps) this.debt = 0;
  }

  /** The text to draw right now. */
  get displayed(): string {
    return this.shownUtf16 >= this.text.length ? this.text : this.text.slice(0, this.shownUtf16);
  }

  /**
   * Whether a frame would still find something to reveal.
   *
   * Not gated on `live`: a finished stream that is still holding back a tail is
   * the case that most needs the loop, and gating here is how a reply ends one
   * sentence short of what the model actually said.
   */
  get pending(): boolean {
    return this.shownCps < this.targetCps;
  }
}
