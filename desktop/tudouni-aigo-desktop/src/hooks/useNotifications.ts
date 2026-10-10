import { useEffect, useRef } from 'react';
import { selectNotifyKey, selectSavedSessions, useApp } from '@/state/store';
import { isHosted } from '@/runtime/tauri';
import {
  decodeNotifySnapshot,
  notifyDecision,
  notifyContent,
  sendNotification,
  type NotifyReason,
} from '@/runtime/notify';
import { makeT } from '@/i18n';
import type { RowStatus } from '@/state/store';

/**
 * Say something when a session behind the window wants a person.
 *
 * Thin on purpose, and everything it could have decided is somewhere else:
 *
 *   - **what counts as news** is `notifyDecision` in `runtime/notify.ts`, which
 *     is pure and asserted on its own;
 *   - **which status a session is in** is `selectRowStatus`, the same function
 *     the left rail's dots and the session board read — so a notification cannot
 *     disagree with the dot beside it;
 *   - **the sentences** are `i18n`'s.
 *
 * What is left, and what this file is actually for, is the *transition*: a status
 * has no memory, and "it finished" is a change rather than a state. So the
 * previous observation is kept here, in a ref, keyed by child key.
 *
 * ## Why a `ref` and not state
 *
 * The previous statuses are not rendered and must not cause a render. Putting
 * them in state would make the comparison depend on when React chose to commit —
 * and a status that changed twice between two commits would collapse into one
 * observation, losing a notification. A ref is read and written inside the same
 * effect run, in order, so no transition can be missed.
 *
 * ## Why the per-session loop is not in the selector
 *
 * The selector returns one **string** (see `selectNotifyKey`), because zustand
 * compares by identity and this effect must not run on every streamed token. The
 * string is decoded here, and the previous map is keyed by child key rather than
 * by screen position, so a session's history survives another one closing and
 * the rail reordering itself.
 *
 * ## What it never does
 *
 * It never sends a notification for a session that has just appeared (there is no
 * transition, and at start-up that would be one per open session), and never for
 * one somebody is looking at — see `isWatched` for why "the window is focused"
 * is not on its own enough to count as looking.
 */
export function useNotifications(): void {
  const key = useApp(selectNotifyKey);
  const enabled = useApp((s) => s.notifyEnabled);

  /** The last status seen for each session, by child key. */
  const seen = useRef(new Map<string, RowStatus>());
  /** Whether the window is in the foreground: focused **and** not minimized. */
  const foreground = useRef(true);

  // The window's own state, which is not in the store: it belongs to the OS, and
  // nothing is rendered from it.
  useEffect(() => {
    if (!isHosted()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const sync = async () => {
      try {
        const mod = await import('@tauri-apps/api/window');
        const win = mod.getCurrentWindow();
        const [focused, minimized] = await Promise.all([win.isFocused(), win.isMinimized()]);
        if (!cancelled) foreground.current = focused && !minimized;
      } catch {
        // Not hosted, or the permission is missing. Assume foreground, which is
        // the *quiet* direction: it suppresses notifications rather than sending
        // them.
        if (!cancelled) foreground.current = true;
      }
    };
    void sync();
    void (async () => {
      try {
        const mod = await import('@tauri-apps/api/window');
        const off = await mod
          .getCurrentWindow()
          .onFocusChanged(() => void sync());
        if (cancelled) off();
        else unlisten = off;
      } catch {
        /* Not hosted: the ref keeps its value. */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // The transitions.
  useEffect(() => {
    const snapshot = decodeNotifySnapshot(key);
    const previous = seen.current;
    const next = new Map<string, RowStatus>();

    for (const row of snapshot.rows) {
      // Recorded before the decision, so a session that appears and changes
      // within one render is still judged from its own history next time.
      next.set(row.key, row.status);

      // Switched off is not "do not look": the map above is still built, so
      // turning notifications back on does not immediately fire for every
      // session that changed while it was off.
      if (!enabled) continue;

      const reason: NotifyReason | null = notifyDecision(previous.get(row.key), row.status, {
        key: row.key,
        activeKey: snapshot.activeKey === '' ? null : snapshot.activeKey,
        windowForeground: foreground.current,
        modalKey: snapshot.modalKey === '' ? null : snapshot.modalKey,
        modalVisible: snapshot.modalVisible,
      });
      if (reason === null) continue;

      void deliver(reason, row.key, row.sessionId);
    }

    seen.current = next;
  }, [key, enabled]);
}

/**
 * Build the sentence and hand it to the OS.
 *
 * The preview is read **here** rather than carried in the watched string, and
 * that is a deliberate split: a preview changes as a session is written, so
 * including it would make the notifier wake on every checkpoint for no decision
 * that depends on it. It is looked up once, at the moment a notification is
 * actually being sent.
 *
 * The session's own workspace is the key, so the lookup is the same
 * `selectSavedSessions` the rail and the board use — one source for what a
 * session's preview is, rather than a second copy assembled here.
 */
async function deliver(reason: NotifyReason, key: string, sessionId: string): Promise<void> {
  const s = useApp.getState();
  const bucket = s.sessions[key];
  const workspace = bucket?.session?.workspace ?? bucket?.workspace ?? '';
  const saved = selectSavedSessions(s, workspace);
  const row = saved.items.find((item) => item.id === sessionId);
  // `makeT()` rather than `useT()`: this runs outside a render, and a
  // notification is not part of the rendered tree. It is the same closure over
  // the same table, so the sentences are exactly the ones on screen — and using
  // the hook here would either be a rules-of-hooks violation or a second,
  // hand-rolled interpolator that could drift from its `{placeholders}`.
  const content = notifyContent(makeT(), reason, {
    workspace,
    sessionId,
    preview: row?.preview ?? '',
  });
  await sendNotification(content);
}
