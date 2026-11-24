/**
 * The Workspace Dock opens **outward**: the window grows past its right edge by
 * the dock's width, so the conversation and the two rails keep exactly the room
 * they had. The session-info rail is the one that opens *inward* (it takes room
 * from the conversation); the dock is a fourth column added to the window, and
 * the two directions are what tell them apart.
 *
 * Inward is still the fallback, and `planDockLayout` (budget.ts) still decides
 * that case: a maximized or full-screen window has no edge to move, and a screen
 * that cannot hold the window plus the dock leaves the window as it is.
 *
 * Everything is in **physical pixels** (what Tauri reports for positions, sizes
 * and the monitor's work area), so no rounding happens between the read and the
 * write. Pure, so the edge cases are asserted rather than dragged.
 */

export interface Rect {
  x: number;
  width: number;
}

export interface GrowthInput {
  /** The window's outer left edge and outer width. */
  window: Rect;
  /** The monitor's work area (the screen minus the taskbar). */
  workArea: Rect;
  /** How much wider the window has to become: the dock's drawn width. */
  extra: number;
  /** A maximized or full-screen window is never resized. */
  maximized: boolean;
}

/** Where the window goes so the dock fits outside the old right edge, or
 *  `null` when it should stay put and the dock opens inward instead. */
export function planGrowth(input: GrowthInput): Rect | null {
  const { window: win, workArea, extra, maximized } = input;
  if (maximized || !(extra > 0)) return null;
  const width = Math.round(win.width + extra);
  const workRight = workArea.x + workArea.width;
  // The screen cannot hold both: growing would push part of the window off it.
  if (width > workArea.width) return null;
  // Grow to the right; slide left only by what the right edge cannot give, and
  // never past the work area's left edge.
  const x = Math.max(workArea.x, Math.min(win.x, workRight - width));
  return { x: Math.round(x), width };
}

/** What a growth changed, remembered so closing the dock can undo it. */
export interface Growth {
  before: Rect;
  after: Rect;
}

/**
 * Where the window goes when the dock closes.
 *
 *   - untouched since the dock opened → back exactly where it was;
 *   - resized or moved by the person since → only the growth comes off its
 *     width, and the left edge stays where they put it (their change wins);
 *   - never narrower than the window's minimum width.
 */
export function planShrink(growth: Growth, current: Rect, minWidth: number): Rect | null {
  if (current.x === growth.after.x && current.width === growth.after.width) {
    return growth.before;
  }
  const grewBy = growth.after.width - growth.before.width;
  const width = Math.max(minWidth, current.width - grewBy);
  if (width === current.width) return null;
  return { x: current.x, width };
}
