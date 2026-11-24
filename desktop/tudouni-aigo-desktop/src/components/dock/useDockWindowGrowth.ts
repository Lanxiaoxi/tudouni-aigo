import { useEffect, useRef, useState } from 'react';
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
 *
 * **Returns `settled`: the window has finished deciding its size for this
 * opening**, and the dock may now be drawn. The window calls are a chain of
 * awaits, so a dock mounted the instant `open` flips is laid out inside the old
 * window (squeezing the conversation and, through `planDockLayout`, folding the
 * session-info rail), and then the window grows under it and everything jumps
 * back out. Waiting here is what turns that into two ordered steps: the window
 * grows, then the dock slides in. It is `true` whether or not the window could
 * grow (maximized, no room): the dock then slides in *inward*, which is the
 * fallback and is still better as a motion than as a one-frame appearance.
 * Closing resets it at once, so the dock leaves the tree the moment `open`
 * goes false, exactly as before.
 */
export function useDockWindowGrowth(open: boolean, extraWidth: number): boolean {
  const growth = useRef<Growth | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [settled, setSettled] = useState(false);
  // The width is read when the dock opens, not tracked: dragging the dock's
  // edge afterwards resizes the dock inside the window, it does not move the
  // window under the pointer.
  const widthRef = useRef(extraWidth);
  widthRef.current = extraWidth;

  useEffect(() => {
    // An effect that was superseded (close, or a quick close-open) must not
    // report on behalf of the opening that replaced it.
    let live = true;
    if (!open) setSettled(false);
    queue.current = queue.current.then(async () => {
      let resized = false;
      const widthBefore = window.innerWidth;
      if (isHosted()) {
        try {
          if (open) resized = await grow(growth, widthRef.current);
          else await shrink(growth);
        } catch {
          // A window call that failed leaves the window as it was; the dock then
          // fits inside it, which is the fallback anyway.
        }
      }
      if (!open) return;
      // `setSize` resolving is the OS's word; the page learns the new width from
      // its own `resize` event, a beat later. Settling before it would lay the
      // dock out against the old width once more.
      if (resized) await innerWidthChanged(widthBefore, WINDOW_RESIZE_WAIT_MS);
      // Two frames, so the tree is painted *without* the dock first: the
      // slide-in is a mount animation and needs a before to start from.
      await twoFrames();
      if (live) setSettled(true);
    });
    return () => {
      live = false;
    };
  }, [open]);

  return open && settled;
}

/** How long to wait for the page to notice a resize the OS already made. */
const WINDOW_RESIZE_WAIT_MS = 250;

/** Resolves once `window.innerWidth` is no longer `from`, or after `timeoutMs`
 *  — a resize that never arrives must not leave the dock unmounted forever. */
function innerWidthChanged(from: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (window.innerWidth !== from) {
      resolve();
      return;
    }
    const done = () => {
      window.removeEventListener('resize', done);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, timeoutMs);
    window.addEventListener('resize', done);
  });
}

function twoFrames(): Promise<void> {
  return new Promise((resolve) => {
    // A hidden renderer does not run animation frames; the timeout keeps the
    // dock from waiting on a frame that is not coming.
    const timer = window.setTimeout(resolve, 100);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.clearTimeout(timer);
        resolve();
      }),
    );
  });
}

async function windowApi() {
  const mod = await import('@tauri-apps/api/window');
  return { mod, win: mod.getCurrentWindow() };
}

async function readRect(win: Awaited<ReturnType<typeof windowApi>>['win']): Promise<Rect> {
  const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
  return { x: pos.x, width: size.width };
}

/** Whether the window was actually resized (false: it stays, dock goes inward). */
async function grow(growth: { current: Growth | null }, extraCss: number): Promise<boolean> {
  if (growth.current !== null) return false;
  const { mod, win } = await windowApi();
  if ((await win.isMaximized()) || (await win.isFullscreen())) return false;
  const monitor = await mod.currentMonitor();
  if (monitor === null) return false;
  const scale = await win.scaleFactor();
  const before = await readRect(win);
  const plan = planGrowth({
    window: before,
    workArea: { x: monitor.workArea.position.x, width: monitor.workArea.size.width },
    extra: Math.round(extraCss * scale),
    maximized: false,
  });
  if (plan === null) return false;
  await apply(mod, win, before, plan);
  growth.current = { before, after: await readRect(win) };
  return true;
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
