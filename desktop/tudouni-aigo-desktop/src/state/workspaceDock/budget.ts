/**
 * The Workspace Dock's space budget (docs/design/workspace-dock.md §2.1, §2.2).
 *
 * Everything here is arithmetic on numbers and nothing reads the DOM or the
 * store, because this is the decision a rendered string cannot show: "the
 * conversation was squeezed to 480px" is only visible in a window of exactly
 * the wrong size. With the rules in one pure module they are asserted at the
 * sizes that matter (`tests/dock-budget.test.ts`) instead of being checked by
 * dragging a window.
 *
 * **Preferred width and actual width are different things.** The store keeps
 * what the person dragged (`dockWidth`); this module derives what is drawn from
 * it and from the window. Shrinking the window must not overwrite the
 * preference, so nothing here is ever written back.
 */

/** The conversation column is never squeezed below this (§2.2). */
export const CONVERSATION_MIN = 560;
/** The narrowest the dock stays docked at; below it the dock overlays (§2.2). */
export const DOCK_MIN = 320;
/** Ceiling of a *preference*: a wider dock is never useful beside a transcript. */
export const DOCK_MAX = 1000;
/** Width of a dock the person never resized. Wide enough for two columns. */
export const DOCK_DEFAULT = 560;
/** From this width the navigator and the viewer sit side by side (§2.1). */
export const DOCK_DUAL_MIN = 520;

export const NAV_MIN = 160;
export const NAV_DEFAULT = 240;
export const NAV_MAX = 480;
/** The viewer keeps at least this much beside the navigator. */
export const VIEWER_MIN = 240;
/** The 1px splitter between the two columns. */
export const SPLITTER_THICKNESS = 1;

export const TERM_MIN = 120;
export const TERM_DEFAULT = 260;
export const TERM_MAX = 900;
/** The upper (navigator/viewer) area keeps at least this much height. */
export const UPPER_MIN = 160;
/** Height of the mode-switch row at the dock's top; `--dock-head-h` in dock.css. */
export const DOCK_HEADER_H = 36;

/** When the dock overlays, this much conversation stays visible to its left. */
export const OVERLAY_GUTTER = 48;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/* ------------------------------------------------------------------ */
/* Preference clamps: the range a stored or dragged value lands in.    */
/* ------------------------------------------------------------------ */

export function clampDockWidth(px: number): number {
  if (!Number.isFinite(px)) return DOCK_MIN;
  return clamp(Math.round(px), DOCK_MIN, DOCK_MAX);
}

export function clampDockNavWidth(px: number): number {
  if (!Number.isFinite(px)) return NAV_MIN;
  return clamp(Math.round(px), NAV_MIN, NAV_MAX);
}

export function clampDockTermHeight(px: number): number {
  if (!Number.isFinite(px)) return TERM_MIN;
  return clamp(Math.round(px), TERM_MIN, TERM_MAX);
}

/* ------------------------------------------------------------------ */
/* The outer column                                                    */
/* ------------------------------------------------------------------ */

/**
 * The widths the two rails nominally have, mirroring `global.css`.
 *
 * The stylesheet owns the defaults (a dragged width is written as
 * `--rail-w-dragged`), so JS has to restate them to budget against. They are
 * asserted against the stylesheet text in `dock-budget.test.ts`, so a change on
 * one side cannot go unnoticed on the other.
 */
export const RAIL_DEFAULTS = {
  left: { wide: 244, narrow: 216 },
  right: { wide: 268, narrow: 236 },
} as const;

/** The breakpoint at which `global.css` swaps in the narrow rail defaults. */
export const NARROW_RAIL_BREAKPOINT = 1180;

export function nominalRailWidth(
  side: 'left' | 'right',
  dragged: number | null,
  windowWidth: number,
): number {
  if (dragged !== null) return dragged;
  const d = RAIL_DEFAULTS[side];
  return windowWidth <= NARROW_RAIL_BREAKPOINT ? d.narrow : d.wide;
}

export interface DockLayoutInput {
  windowWidth: number;
  /** The workspace rail's width as it would be drawn; 0 when it is hidden. */
  leftRail: number;
  /**
   * The width the workspace rail could degrade to (a narrow icon rail), or
   * `null` when it has no such form. The rail has none today, so the caller
   * passes `null` and step 3 of the degradation order is skipped.
   */
  leftRailNarrow: number | null;
  /** The session-info rail's width as it would be drawn; 0 when it is hidden. */
  rightRail: number;
  /** What the person asked for (`dockWidth ?? DOCK_DEFAULT`). */
  preferredWidth: number;
}

export interface DockLayout {
  /** `docked` is a real fourth column; `overlay` floats over the conversation. */
  placement: 'docked' | 'overlay';
  /** The width actually drawn. Never written back to the preference. */
  width: number;
  /** The least and most the outer splitter may take `width` to. */
  minWidth: number;
  maxWidth: number;
  /** Degradation steps the caller must apply to make the dock fit. */
  dropRightRail: boolean;
  narrowLeftRail: boolean;
  /** `dual` puts the navigator and the viewer side by side. */
  columns: 'single' | 'dual';
}

export function dockColumns(width: number): 'single' | 'dual' {
  return width >= DOCK_DUAL_MIN ? 'dual' : 'single';
}

/**
 * Decide how the dock fits, in the order the design gives (§2.2):
 *
 *   1. as it is, with every rail visible;
 *   2. the session-info rail folds away first;
 *   3. the workspace rail degrades to its narrow form (when it has one);
 *   4. otherwise the dock overlays the conversation — the transcript is never
 *      squeezed below `CONVERSATION_MIN` to make room.
 *
 * In every docked case the width is `min(preferred, available)`, floored at
 * `DOCK_MIN` (a dock narrower than that is an overlay, not a column).
 */
export function planDockLayout(input: DockLayoutInput): DockLayout {
  const { windowWidth, leftRail, leftRailNarrow, rightRail } = input;
  const preferred = clampDockWidth(input.preferredWidth);

  const docked = (
    available: number,
    dropRightRail: boolean,
    narrowLeftRail: boolean,
  ): DockLayout => {
    const width = Math.max(DOCK_MIN, Math.min(preferred, available));
    return {
      placement: 'docked',
      width,
      minWidth: DOCK_MIN,
      maxWidth: Math.min(DOCK_MAX, Math.max(DOCK_MIN, available)),
      dropRightRail,
      narrowLeftRail,
      columns: dockColumns(width),
    };
  };

  if (Number.isFinite(windowWidth) && windowWidth > 0) {
    const fits = (available: number) => available >= DOCK_MIN;

    const withRails = windowWidth - leftRail - rightRail - CONVERSATION_MIN;
    if (fits(withRails)) return docked(withRails, false, false);

    const withoutRight = windowWidth - leftRail - CONVERSATION_MIN;
    if (fits(withoutRight)) return docked(withoutRight, true, false);

    if (leftRailNarrow !== null && leftRailNarrow < leftRail) {
      const narrowed = windowWidth - leftRailNarrow - CONVERSATION_MIN;
      if (fits(narrowed)) return docked(narrowed, true, true);
    }
  }

  // Overlay: the layout underneath is left as it was, so opening the dock
  // moves nothing. The dock may cover everything to the right of the rail
  // except a small gutter of conversation.
  const room = Number.isFinite(windowWidth) && windowWidth > 0
    ? Math.max(DOCK_MIN, windowWidth - leftRail - OVERLAY_GUTTER)
    : DOCK_MAX;
  const cap = Math.min(DOCK_MAX, room);
  const width = Math.min(
    Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : DOCK_MAX,
    clamp(preferred, DOCK_MIN, cap),
  );
  return {
    placement: 'overlay',
    width,
    minWidth: Math.min(DOCK_MIN, width),
    maxWidth: Math.max(width, cap),
    dropRightRail: false,
    narrowLeftRail: false,
    columns: dockColumns(width),
  };
}

/* ------------------------------------------------------------------ */
/* Inside the dock                                                     */
/* ------------------------------------------------------------------ */

/** The navigator's range for a dock of this width; the viewer keeps its floor. */
export function navigatorRange(dockWidth: number): { min: number; max: number } {
  const max = Math.min(NAV_MAX, dockWidth - VIEWER_MIN - SPLITTER_THICKNESS);
  return { min: NAV_MIN, max: Math.max(NAV_MIN, max) };
}

export function navigatorWidth(preferred: number | null, dockWidth: number): number {
  const { min, max } = navigatorRange(dockWidth);
  return clamp(preferred ?? NAV_DEFAULT, min, max);
}

/**
 * The terminal's range for a dock of this height. The upper area keeps
 * `UPPER_MIN` and the mode row keeps its own height; when the dock is too short
 * for both, the terminal's floor wins (a usable shell beats a usable preview).
 */
export function terminalRange(containerHeight: number): { min: number; max: number } {
  const room = containerHeight - DOCK_HEADER_H - UPPER_MIN - SPLITTER_THICKNESS;
  const max = Math.min(TERM_MAX, Number.isFinite(room) ? room : TERM_MAX);
  return { min: TERM_MIN, max: Math.max(TERM_MIN, max) };
}

export function terminalHeight(preferred: number | null, containerHeight: number): number {
  const { min, max } = terminalRange(containerHeight);
  return clamp(preferred ?? TERM_DEFAULT, min, max);
}
