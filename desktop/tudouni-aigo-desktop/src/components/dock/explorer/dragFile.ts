/**
 * Dragging a workspace file onto the composer.
 *
 * **Pointer events, not HTML5 drag-and-drop.** `tauri.conf.json` keeps
 * `dragDropEnabled: true` (it is what makes the OS file drop deliver real paths,
 * see `hooks/useFileDrop.ts`), and with it on, Windows' WebView2 does not
 * deliver in-page HTML5 `dragstart`/`drop` at all. So the drag is tracked by
 * hand: a ghost label follows the pointer, the composer shows its own drop hint
 * (`setDragging`, the same state an OS drag raises), and releasing over the
 * composer attaches the file like the context menu's "attach" does.
 *
 * Esc cancels. A drag swallows the click that follows it, so a row is not also
 * selected by the gesture that moved it.
 */
import { useApp } from '@/state/store';
import { attachWorkspaceFile } from '../dockActions';

const THRESHOLD_PX = 5;
let suppressClickUntil = 0;

/** True for a moment after a drag ended: the row's click handler skips it. */
export function dragJustEnded(): boolean {
  return Date.now() < suppressClickUntil;
}

function overComposer(x: number, y: number): boolean {
  return document.elementFromPoint(x, y)?.closest('.composer') != null;
}

export function beginPathDrag(
  start: { button: number; clientX: number; clientY: number },
  path: string,
  label: string,
): void {
  if (start.button !== 0) return;
  let ghost: HTMLDivElement | null = null;
  let over = false;

  const setOver = (value: boolean) => {
    if (value === over) return;
    over = value;
    useApp.getState().setDragging(value);
  };

  const onMove = (e: PointerEvent) => {
    if (ghost === null) {
      if (Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) < THRESHOLD_PX) return;
      ghost = document.createElement('div');
      ghost.className = 'dock-drag-ghost';
      ghost.textContent = label;
      document.body.appendChild(ghost);
      document.body.classList.add('is-dock-dragging');
    }
    ghost.style.left = `${e.clientX + 12}px`;
    ghost.style.top = `${e.clientY + 12}px`;
    setOver(overComposer(e.clientX, e.clientY));
  };

  const end = (e: PointerEvent | null, drop: boolean) => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    window.removeEventListener('keydown', onKey, true);
    if (ghost === null) return;
    ghost.remove();
    document.body.classList.remove('is-dock-dragging');
    suppressClickUntil = Date.now() + 150;
    const landed = drop && e !== null && overComposer(e.clientX, e.clientY);
    setOver(false);
    if (landed) attachWorkspaceFile(path);
  };

  const onUp = (e: PointerEvent) => end(e, true);
  const onCancel = () => end(null, false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    end(null, false);
  };

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('keydown', onKey, true);
}
