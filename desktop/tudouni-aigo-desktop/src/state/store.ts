/**
 * Global state.
 *
 * The split (§6.1) is still the whole design here, and multi-session adds a
 * third axis to it:
 *
 *   - **Runtime facts** are written only by `applyRuntimeMessage`. The front end
 *     stores them, it never invents them.
 *   - **Front-end preferences** (sidebar and block folding, the workspace list)
 *     are presentation choices and not runtime state.
 *   - **Each fact belongs to a session.** A runtime fact is never "the model" —
 *     it is "the model *in this conversation*". So the facts live in
 *     `sessions[key]` and `activeKey` decides only which bucket is **drawn**.
 *     That separation is what makes two conversations able to run at once: a
 *     message arriving for a session nobody is looking at still lands in its own
 *     bucket, and switching the display changes no fact at all.
 *
 * And two prohibitions, both unchanged:
 *   - **no optimistic updates.** Pressing "always allow" sends an outbound
 *     message and nothing else; the display changes when `ui(state)` comes back.
 *   - **nothing is inferred from `activeKey`** except what to draw. If a value
 *     can be computed from the message, it is stored when the message arrives,
 *     not when the session becomes visible — otherwise a background session's
 *     history depends on when somebody happened to look at it.
 */

import { create } from 'zustand';
import { createStoreContext } from './storeContext';
import { FIND_IDLE } from './find';
import { prefs } from './prefs';
import { desktopDataSnapshot } from './desktopData';
import { activeRuntime } from './appView';
import type { AppStore } from './storeShape';
import type { SessionRuntime } from './types';
import { sessionsSlice } from './slices/sessions';
import { runtimeSlice } from './slices/runtime';
import { composerSlice } from './slices/composer';
import { modalsSlice } from './slices/modals';
import { terminalsSlice } from './slices/terminals';
import { workspacesSlice } from './slices/workspaces';


/* ============================================================
   The store
   ============================================================ */

/* ------------------------------------------------------------
   Reading the active session from a component
   ------------------------------------------------------------

   Every component that draws "the conversation on screen" has to say which
   conversation it means, and with several open that is `activeKey` rather than
   the store itself. `useSessionField` is that answer in one place: it is a hook
   rather than a `select*(s, key)` because the *caller* almost never has a key —
   the component is drawing whatever is focused — and threading `activeKey` into
   forty call sites is forty chances to pass the wrong one.

   The fallbacks are shared constants rather than fresh literals, and that is not
   tidiness: zustand compares selector output by identity, so `rt.entries ??
   []` allocates a new array on every call and re-renders forever without ever
   committing — which shows up as a blank component rather than as an error.
*/

/** The key of the session being drawn, or null when nothing is open. */
export function useActiveKey(): string | null {
  return useApp((s) => s.activeKey);
}

/**
 * One field of the active session's bucket.
 *
 * `pick` must return a stored value or a shared constant — never a fresh object
 * or array literal — for the identity reason above.
 */
export function useSessionField<T>(pick: (rt: SessionRuntime) => T, fallback: T): T {
  return useApp((s) => {
    const rt = activeRuntime(s);
    return rt ? pick(rt) : fallback;
  });
}



export function createAppStore() {
  return create<AppStore>()((set, get) => {
    const ctx = createStoreContext(set, get);
    return {
    sessions: {},
    order: [],
    activeKey: null,
    savedSessions: {},

    runtimeVersion: null,
    desktopVersion: __DESKTOP_VERSION__,
    userName: '',
    startupProblem: null,
    splashTick: 0,
    startupNotice: null,

    modal: null,
    pendingModals: [],
    panel: null,
    filePick: false,
    fileFocus: false,
    closePrompt: false,
    questionMinimizedId: null,
    boardOpen: false,
    // The usage panel's snapshot: window-level (see `storeShape`), `null` until
    // the first open of the panel asks for it.
    usage: null,
    usageProblem: null,
    // The desktop's steady state: archived sessions are hidden, so archiving
    // frees one of the runtime's fifty slots. See `SessionFilter`.
    sessionFilter: 'active',
    // `findFocus` is a counter of requests, so it starts at zero and is not part
    // of `FIND_IDLE`.
    findFocus: 0,
    ...FIND_IDLE,

    sidebarVisible: prefs.sidebarVisible,
    leftbarVisible: prefs.leftbarVisible,
    sidebarWidth: prefs.sidebarWidth,
    leftbarWidth: prefs.leftbarWidth,
    blockCollapsed: prefs.blockCollapsed,
    blockTouched: prefs.blockTouched,
    blockAutoExpanded: {},
    reasoningOpen: {},
    toolOpen: {},
    turnFolded: {},
    sessionsCollapsed: prefs.sessionsCollapsed,
    workspacesCollapsed: prefs.workspacesCollapsed,
    footCollapsed: prefs.footCollapsed,
    // The user data starts from the in-memory copy, which at module load is
    // the empty shelf: the file that holds it is read asynchronously by
    // `hydrateDesktopData`, and the start-up applies the result to the store
    // before the first session. Until then these fields hold the empty shelf,
    // and nothing draws or runs that reads them before the first session.
    ...desktopDataSnapshot(),
    installStatus: {},
    configSyncPrompt: null,
    configSyncBusy: null,
    configSyncError: null,
    pendingRemoteOpen: null,
    openingRemote: null,

    dragging: false,
    resizing: null,

    /* ==========================================================
       Sessions: the lifecycle
       ========================================================== */
      ...sessionsSlice(ctx),
      ...runtimeSlice(ctx),
      ...composerSlice(ctx),
      ...modalsSlice(ctx),
      ...terminalsSlice(ctx),
      ...workspacesSlice(ctx),
    };
  });
}

/**
 * The one store the app uses.
 *
 * `createAppStore` is the seam: a test (or a second window) can hold its own
 * store without sharing state with the running one. The hook is a bound store,
 * so `useApp(selector)` and `useApp.getState()` are unchanged.
 */
export const useApp = createAppStore();


/* ============================================================
   Helpers
   ============================================================ */

/* ============================================================
   Compatibility surface

   The selectors, the empty values and the view readers now live in
   their own files, but every component still imports them from here.
   Re-exporting is what keeps that true; it is not a second
   definition.
   ============================================================ */
export * from './selectors/session';
export {
  activeRuntime,
  activeWorkspaceOf,
  isUntouchedSession,
  remoteConnectionOf,
  remoteWorkspaceIdOf,
  resolveAttachWorkspace,
  screenIsRemote,
} from './appView';
export {
  NO_ALIASES,
  NO_ATTACHED,
  NO_ENTRIES,
  NO_FILE_ENTRIES,
  NO_INIT_TOOLS,
  NO_MCP_ROWS,
  NO_MODEL_ROWS,
  NO_OUTPUT,
  NO_PASTED,
  NO_SAVED_SESSIONS,
  NO_SKILLS,
  NO_STRINGS,
  NO_TERMINALS,
} from './empty';

export { RAIL_MAX, RAIL_MIN, clampRailWidth } from './prefs';
export { POLL_FLOOR_MS } from './polling';
/** The key that names "which place's saved list this is". Exported alongside the
 *  store because a reader outside the state tree (the board, a test that writes
 *  a list the way the store does) has to build it the same way the store does. */
export { savedSessionsKey } from './savedSessionsKey';
/** Whether a refused remote dial means "the recorded binary is gone" — the
 *  judgement the automatic reinstall turns on. Exported because it is a decision
 *  about words, and a decision about words is worth asserting on its own. */
export { looksLikeMissingBinary } from './runtimeLanding';

/* ============================================================
   Compatibility surface

   The vocabulary, the bucket factory and the store's shape now live
   in their own modules; every existing import still comes from here.
   ============================================================ */
export * from './types';
export * from './sessionBucket';
export * from './terminal';
export type { AppStore } from './storeShape';
