/**
 * What every slice shares.
 *
 * The store's action object used to be one closure with seven helpers defined at
 * its top. A slice cannot close over those helpers, so they are built once here
 * and handed to each slice as one object. The functions are the same ones, with
 * the same bodies — only their home moved.
 */
import type { StoreApi } from 'zustand';
import { isUntouchedSession } from './appView';
import type { AppStore } from './storeShape';
import type { SessionRuntime } from './types';
import type { VmSessionListItem } from '@/runtime/adapt';
import { savedSessionsKey } from './savedSessionsKey';

export interface StoreContext {
  set: StoreApi<AppStore>['setState'];
  get: StoreApi<AppStore>['getState'];
  patch: (key: string, changes: Partial<SessionRuntime>) => void;
  patchWith: (
    key: string,
    build: (current: SessionRuntime) => Partial<SessionRuntime>,
  ) => void;
  patchActive: (changes: Partial<SessionRuntime>) => void;
  noteSavedSessions: (
    workspace: string,
    remoteWorkspaceId: string | null,
    items: VmSessionListItem[],
    listed: boolean,
  ) => void;
  markSavedSessionsPending: (workspace: string, remoteWorkspaceId: string | null) => void;
  activeKeyForSend: () => string | null;
  abandonIfUntouched: (key: string | null) => void;
}

export function createStoreContext(
  set: StoreApi<AppStore>['setState'],
  get: StoreApi<AppStore>['getState'],
): StoreContext {
  /**
   * Write into one session's bucket.
   *
   * Every per-session write goes through here, which is what keeps
   * `sessions[key]` the single source and makes "who is this fact about" a
   * required argument rather than something a caller can forget. A write for a
   * session that is gone is dropped: the child it belonged to no longer exists,
   * and inventing a bucket for it would resurrect a session nothing owns.
   */
  function patch(key: string, changes: Partial<SessionRuntime>): void {
    set((s) => {
      const current = s.sessions[key];
      if (!current) return {};
      return { sessions: { ...s.sessions, [key]: { ...current, ...changes } } };
    });
  }

  /** The same, applied by a function of the current bucket. */
  function patchWith(
    key: string,
    build: (current: SessionRuntime) => Partial<SessionRuntime>,
  ): void {
    set((s) => {
      const current = s.sessions[key];
      if (!current) return {};
      return { sessions: { ...s.sessions, [key]: { ...current, ...build(current) } } };
    });
  }

  /** Patch the active session, when there is one. */
  function patchActive(changes: Partial<SessionRuntime>): void {
    const key = get().activeKey;
    if (key === null) return;
    patch(key, changes);
  }

  /**
   * Record the saved sessions a runtime reported for one workspace.
   *
   * The workspace is a parameter rather than being read off the reply, because
   * `sessions.items` does not name one: the runtime answers for the directory
   * its child is in, and the connection is the only place that fact exists —
   * exactly like the session attribution `applyRuntimeMessage` takes a key for.
   *
   * **`remoteWorkspaceId` is part of the identity, not decoration.** A path is
   * not enough to say which list this is: `hostA:/srv/app`, `hostB:/srv/app` and
   * a local `/srv/app` are three different places that compare equal as strings,
   * so keying by the path alone let one machine's answer overwrite another's —
   * two rails drawing one list, and a row clicked in it carrying the wrong
   * host's `sessionId`. See `state/savedSessionsKey.ts`.
   *
   * Written into `savedSessions[key]` and nothing else: this is a **workspace**
   * fact, so it must not land in the bucket of whichever child happened to
   * answer. That was the bug — see `SavedSessions`.
   */
  function noteSavedSessions(
    workspace: string,
    remoteWorkspaceId: string | null,
    items: VmSessionListItem[],
    listed: boolean,
  ): void {
    if (workspace.trim() === '' && remoteWorkspaceId === null) return;
    const key = savedSessionsKey(workspace, remoteWorkspaceId);
    // The rail's view, computed here rather than in a selector — see
    // `SavedSessions.active` for why a filtering selector would loop forever.
    const active = items.filter((row) => !row.archived);
    set((s) => ({
      savedSessions: {
        ...s.savedSessions,
        [key]: { workspace, remoteWorkspaceId, items, active, listed },
      },
    }));
  }

  /** Mark one workspace's list as not-yet-answered, so a reader shows loading
   *  rather than a stale list that a request is on its way to replace. */
  function markSavedSessionsPending(workspace: string, remoteWorkspaceId: string | null): void {
    if (workspace.trim() === '' && remoteWorkspaceId === null) return;
    const key = savedSessionsKey(workspace, remoteWorkspaceId);
    set((s) => {
      const current = s.savedSessions[key];
      if (!current) return {};
      return { savedSessions: { ...s.savedSessions, [key]: { ...current, listed: false } } };
    });
  }

  /** The key a message should be sent to: the active session, or nothing. */
  function activeKeyForSend(): string | null {
    return get().activeKey;
  }

  /**
   * Close the session the screen just left, when it never became a conversation.
   *
   * Called **after** the new focus is in place, never before: the test is "is
   * this one still on screen", and reading `activeKey` a moment early would make
   * every ordinary switch look like leaving. There is one caller per way the
   * screen moves — `focusSession` and `attachSession` — because those are the
   * store's only two ways for `activeKey` to change to a session that already
   * existed.
   *
   * Closing is a real act and it is deliberately the one taken: this session has
   * no file, so the row it would leave behind has no delete button, and a live
   * child that is drawn nowhere is a process nobody can reach or end. Closing
   * loses nothing — by `isUntouchedSession` there is nothing in it to lose — and
   * the runtime's own shutdown is graceful, so a turn that somehow started
   * between the two still finishes.
   */
  function abandonIfUntouched(key: string | null): void {
    if (key === null) return;
    if (key === get().activeKey) return;
    if (!isUntouchedSession(get(), key)) return;
    void get().detachSession(key);
  }

  return {
    set,
    get,
    patch,
    patchWith,
    patchActive,
    noteSavedSessions,
    markSavedSessionsPending,
    activeKeyForSend,
    abandonIfUntouched,
  };
}
