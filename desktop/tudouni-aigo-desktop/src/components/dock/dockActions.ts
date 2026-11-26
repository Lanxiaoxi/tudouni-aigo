/**
 * Requests the Explorer makes of other Dock modules and of the composer.
 *
 * **Terminal hand-off.** The Explorer's "open terminal here" does not own a
 * terminal; the Terminal module does. They meet through this tiny emitter so
 * neither imports the other:
 *
 *   - the Explorer calls `requestTerminalAt(cwd)` — `cwd` is **workspace-relative**
 *     (`''` is the root), the form `term_create` takes;
 *   - the Terminal module subscribes with `onTerminalRequest(cb)` while it is
 *     mounted and creates + attaches a terminal at that directory.
 *
 * A request made while nobody listens (the terminal area is not mounted yet) is
 * **kept** and delivered to the first subscriber, so the click is not lost; only
 * the latest one is kept. The caller also shows the terminal area
 * (`setDockTermVisible(true)`) before asking, because folded, it is not mounted.
 */
import { useApp } from '@/state/store';
import { insertAtCaret } from '@/runtime/paste';
import { composerCaret, placeComposerCaret } from '@/components/chrome/composerBridge';
import { ancestorsOf } from '@/state/workspaceDock/dataCache';
import { workspaceRelativePath } from '@/state/workspaceDock/relPath';
import { selectActiveWorkspaceKey } from '@/state/workspaceDock/selectors';

export type TerminalRequestHandler = (cwd: string) => void;

const handlers = new Set<TerminalRequestHandler>();
let pending: string | null = null;

/** Ask for a terminal in `cwd` (workspace-relative). Shows the terminal area. */
export function requestTerminalAt(cwd: string): void {
  useApp.getState().setDockTermVisible(true);
  if (handlers.size === 0) {
    pending = cwd;
    return;
  }
  for (const cb of [...handlers]) cb(cwd);
}

/** Subscribe to terminal requests. Delivers one that arrived before anybody
 *  listened. Returns the unsubscribe. */
export function onTerminalRequest(cb: TerminalRequestHandler): () => void {
  handlers.add(cb);
  if (pending !== null) {
    const cwd = pending;
    pending = null;
    cb(cwd);
  }
  return () => {
    handlers.delete(cb);
  };
}

/* ---------------- composer ---------------- */

/** Put `path` into the draft as its own word, at the caret. */
export function insertPathIntoComposer(path: string): void {
  const s = useApp.getState();
  const key = s.activeKey;
  if (key === null) return;
  const draft = s.sessions[key]?.draft ?? '';
  const moved = insertAtCaret(draft, composerCaret(draft.length), path);
  s.setDraft(moved.text);
  placeComposerCaret(moved.caret);
}

/**
 * Attach a **workspace file** as context: the same chip a picked file gets.
 * `attachFilePath` inserts the path as given, which for a workspace-relative
 * path is exactly what the runtime resolves (the file already lives in the
 * workspace, local or remote, so there is nothing to upload).
 */
export function attachWorkspaceFile(path: string): void {
  const s = useApp.getState();
  const key = s.activeKey;
  if (key === null) return;
  const draft = s.sessions[key]?.draft ?? '';
  const caret = s.attachFilePath(path, composerCaret(draft.length));
  if (caret !== null) placeComposerCaret(caret);
}

/* ---------------- showing a file in the Explorer ---------------- */

/**
 * Show one file in the Dock's Explorer: open the Dock in Explorer mode, expand
 * the directories above it, select it. `path` may be absolute or
 * workspace-relative (a deliverable card holds whatever the model wrote).
 *
 * Answers `false` when there is nothing to show it in (no workspace, or the
 * path is outside it), so the caller can keep its own fallback (system open).
 */
export function revealWorkspaceFile(path: string): boolean {
  const s = useApp.getState();
  const ws = selectActiveWorkspaceKey(s);
  if (ws === null) return false;
  const rel = workspaceRelativePath(path, ws.root);
  if (rel === null) return false;
  for (const dir of ancestorsOf(rel)) s.toggleWorkspaceDir(ws.workspaceId, dir, true);
  // A name filter would replace the tree with its hits and hide the row.
  s.setWorkspaceSearch(ws.workspaceId, '');
  s.setWorkspaceSelectedFile(ws.workspaceId, rel);
  s.setDockMode('explorer');
  s.setDockPane('viewer');
  return true;
}
