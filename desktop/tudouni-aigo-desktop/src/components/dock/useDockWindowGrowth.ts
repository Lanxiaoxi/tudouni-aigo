import { useEffect, useRef } from 'react';
import { isHosted } from '@/runtime/tauri';
import { planGrowth, planShrink, type Growth, type Rect } from '@/state/workspaceDock/windowGrowth';

/** `minWidth` of the main window in tauri.conf.json (logical px). */
const WINDOW_MIN_WIDTH = 960;

/**
 * Open the Workspace Dock **outward**: when it opens, the window grows past its
 * right edge by the dock's width; when it closes, the growth comes off again.
 * The rails and the conversation keep the room they had, which is what makes
 * the dock read as a column added to the window rather than one more rail
 * pushing inward (the session-info rail's direction).
 *
 * `extraWidth` is the dock's width in CSS px. The window cannot always grow (a
 * maximized or full-screen window, a screen that cannot hold both); then nothing
 * happens here and `planDockLayout` fits the dock inside, as before.
 *
 * Window calls are serialised: a quick open-close-open must not interleave two
 * reads and two writes and leave the window at a size neither asked for.
 */
export function useDockWindowGrowth(open: boolean, extraWidth: number): void {
  const growth = useRef<Growth | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  // The width is read when the dock opens, not tracked: dragging the dock's
  // edge afterwards resizes the dock inside the window, it does not move the
  // window under the pointer.
  const widthRef = useRef(extraWidth);
  widthRef.current = extraWidth;

  useEffect(() => {
    if (!isHosted()) return;
    queue.current = queue.current.then(() =>
      (open ? grow(growth, widthRef.current) : shrink(growth)).catch(() => {
        // A window call that failed leaves the window as it was; the dock then
        // fits inside it, which is the fallback anyway.
      }),
    );
  }, [open]);
}

async function windowApi() {
  const mod = await import('@tauri-apps/api/window');
  return { mod, win: mod.getCurrentWindow() };
}

async function readRect(win: Awaited<ReturnType<typeof windowApi>>['win']): Promise<Rect> {
  const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
  return { x: pos.x, width: size.width };
}

async function grow(growth: { current: Growth | null }, extraCss: number): Promise<void> {
  if (growth.current !== null) return;
  const { mod, win } = await windowApi();
  if ((await win.isMaximized()) || (await win.isFullscreen())) return;
  const monitor = await mod.currentMonitor();
  if (monitor === null) return;
  const scale = await win.scaleFactor();
  const before = await readRect(win);
  const plan = planGrowth({
    window: before,
    workArea: { x: monitor.workArea.position.x, width: monitor.workArea.size.width },
    extra: Math.round(extraCss * scale),
    maximized: false,
  });
  if (plan === null) return;
  await apply(mod, win, before, plan);
  growth.current = { before, after: await readRect(win) };
}

async function shrink(growth: { current: Growth | null }): Promise<void> {
  const g = growth.current;
  if (g === null) return;
  growth.current = null;
  const { mod, win } = await windowApi();
  // Maximized since it grew: the person chose a size, and restoring it later
  // is the OS's business.
  if ((await win.isMaximized()) || (await win.isFullscreen())) return;
  const scale = await win.scaleFactor();
  const current = await readRect(win);
  const plan = planShrink(g, current, Math.round(WINDOW_MIN_WIDTH * scale));
  if (plan === null) return;
  await apply(mod, win, current, plan);
}

/** Move and resize to `to`. `setSize` takes the **inner** size, so the outer
 *  width is converted by the frame the window currently has. */
async function apply(
  mod: Awaited<ReturnType<typeof windowApi>>['mod'],
  win: Awaited<ReturnType<typeof windowApi>>['win'],
  from: Rect,
  to: Rect,
): Promise<void> {
  const [inner, pos] = await Promise.all([win.innerSize(), win.outerPosition()]);
  const frame = from.width - inner.width;
  if (to.x !== from.x) await win.setPosition(new mod.PhysicalPosition(to.x, pos.y));
  await win.setSize(new mod.PhysicalSize(to.width - frame, inner.height));
}
