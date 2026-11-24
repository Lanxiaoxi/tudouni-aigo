/**
 * The splitter's arithmetic: what a drag and what an arrow key land on.
 *
 * Pure for the reason `railWidth.ts` is: the sign is the thing that is invisible
 * when wrong. `start + dx` reads sensibly and produces a column that *narrows*
 * as you pull it wider, which is exactly how the right rail shipped once. Here
 * the sign is a named parameter (`grow`) rather than an inlined negation, and
 * both directions are asserted in `dock-splitter.test.ts`.
 *
 * Terms:
 *   - `orientation` is the **separator's** (ARIA's): a `vertical` separator is a
 *     vertical bar between two side-by-side panes and resizes a *width*; a
 *     `horizontal` one is a bar between stacked panes and resizes a *height*.
 *   - `grow` says which way of travel enlarges the value: `'end'` when moving
 *     right/down grows it (a navigator whose edge is on its right; a pane above
 *     the bar), `'start'` when moving left/up grows it (the dock, whose handle is
 *     on its left edge; a terminal below the bar).
 */

export type SplitterOrientation = 'vertical' | 'horizontal';
export type SplitterGrow = 'start' | 'end';

export const SPLITTER_STEP = 16;
export const SPLITTER_STEP_LARGE = 64;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** The value a drag lands on: `delta` is the pointer's travel (right/down positive). */
export function draggedValue(
  start: number,
  delta: number,
  grow: SplitterGrow,
  min: number,
  max: number,
): number {
  const next = grow === 'end' ? start + delta : start - delta;
  return clamp(Math.round(next), min, max);
}

export interface SplitterKeyInput {
  key: string;
  shiftKey: boolean;
  orientation: SplitterOrientation;
  grow: SplitterGrow;
  value: number;
  min: number;
  max: number;
}

/**
 * The value an arrow key lands on, or `null` when the key is not the splitter's.
 *
 * The arrows that move the bar are the ones along the axis it can travel:
 * Left/Right for a vertical separator, Up/Down for a horizontal one. The key
 * moves the **bar** in its own direction (Right moves it right), so with
 * `grow: 'start'` the Right arrow *shrinks* the value, as it does on screen.
 * `Home`/`End` jump to the extremes; Shift takes the larger step.
 */
export function keyboardValue(input: SplitterKeyInput): number | null {
  const { key, shiftKey, orientation, grow, value, min, max } = input;
  const step = shiftKey ? SPLITTER_STEP_LARGE : SPLITTER_STEP;
  const forward = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
  const backward = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';

  if (key === 'Home') return min;
  if (key === 'End') return max;
  if (key !== forward && key !== backward) return null;

  const towardEnd = key === forward;
  // Moving the bar toward the end enlarges the value only when `grow` is 'end'.
  const sign = towardEnd === (grow === 'end') ? 1 : -1;
  return clamp(value + sign * step, min, max);
}
