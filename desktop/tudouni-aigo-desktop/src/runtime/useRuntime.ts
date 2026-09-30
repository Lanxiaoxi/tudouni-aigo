import { useLayoutEffect } from 'react';
import { useApp } from '@/state/store';
import {
  attachRuntimeListener,
  checkWorkspace,
  initBridge,
  isHosted,
  readRuntimeVersion,
  readUserName,
} from './tauri';

/**
 * Wire the bridge to the store.
 *
 * `useLayoutEffect` rather than `useEffect`: the subscription must be in place
 * before this commit ends. The runtime is a separate process and the handshake
 * can be faster than a passive effect — once `init` lands in the gap between
 * "started the child" and "subscribed", the UI would sit in its booting phase
 * forever. A layout effect is synchronous, so there is no yield point between
 * starting and subscribing.
 *
 * **The order in this effect is load-bearing**, and it is why the two calls are
 * awaited rather than fired together:
 *
 *   1. `initBridge` registers the window's three listeners.
 *   2. `attachRuntimeListener` tells the bridge to stop queueing.
 *   3. only then is a session started.
 *
 * Announcing before the listeners exist is the same as having no listeners: the
 * bridge flushes the opening `init` -> `session_load` -> `ui(state)` triple into
 * nothing and the UI boots forever over a perfectly healthy runtime. That used to
 * be a real failure here, and it was invisible because the `catch` that swallowed
 * it had a comment explaining that the UI would stay in its booting phase.
 *
 * This function is about the **window**; opening and closing sessions lives in
 * the store (`attachSession` / `detachSession`), because those are actions the
 * interface triggers long after mount.
 */
export function useRuntimeBridge(): void {
  useLayoutEffect(() => {
    let cancelled = false;

    // A version mismatch is the one drop that is not survivable: every further
    // line fails the same check, so counting them one at a time turns "these two
    // ends cannot talk" into a plausible-looking tally. The fatal case is a
    // statement about the window — every child is the same binary — which is why
    // it is reported there rather than on a row. The non-fatal count is per
    // session, because "this child's writer produced half a line" is a fact about
    // that child.
    const onDrop = (key: string, reason: string, fatal: boolean): void => {
      if (fatal && reason.startsWith('envelope-version-mismatch:')) {
        const theirVersion = reason.slice('envelope-version-mismatch:'.length);
        useApp
          .getState()
          .setStartupProblem(
            `the runtime speaks protocol envelope v=${theirVersion} and this build only ` +
              `understands v=1. The packaged runtime and the application are from ` +
              `different releases.`,
          );
        return;
      }
      useApp.getState().countDrop(key);
    };

    // Failing to register the listeners is not survivable either, and the symptom
    // is silence: `forward_line` would queue every line forever.
    const onAttachFailure = (problem: string): void => {
      useApp.getState().setStartupProblem(problem);
    };

    void (async () => {
      await initBridge(onDrop, onAttachFailure);
      if (cancelled) return;

      // The listener exists now, so the bridge may release whatever it queued
      // before this moment.
      await attachRuntimeListener();

      if (cancelled) return;

      // Not hosted (plain `npm run dev` in a browser): nothing to start, and the
      // UI stays in its booting phase rather than pretending.
      if (!isHosted()) return;

      // The greeting's name comes from the OS, and the runtime's version from a
      // one-shot `--version` — neither is in the protocol. Both are window-level
      // facts, read once.
      const [userName, version] = await Promise.all([readUserName(), readRuntimeVersion()]);
      if (cancelled) return;
      useApp.getState().setRuntimeInfo({ version, userName });

      // The first session, in the workspace last worked in. Every later session
      // is opened from the interface.
      await openFirstSession(() => cancelled);
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}

/**
 * Start this launch's first session, in the workspace last worked in.
 *
 * **The workspace is always named explicitly here, and that is the point of the
 * function.** Leaving it out does not mean "no opinion" — it means the bridge
 * falls back to the *process's* working directory, which for a packaged
 * application is its own install folder. That is what used to happen, and the
 * symptom was the one thing this cannot be allowed to do: a launch coming up in
 * a directory nobody chose, with no session file in it and nothing said about
 * why. So the three outcomes are each spelled out rather than left to a fallback:
 *
 *   1. **Something was remembered and still works** → a child is started there.
 *   2. **Something was remembered and no longer works** → the directory was
 *      deleted, unmounted, or is one the runtime refuses (home, a volume root, an
 *      ancestor of home). **Nothing is started**, and the reason goes on the
 *      first screen — which is still fully usable, because the workspace list
 *      beside it never depended on this. Reporting is the improvement: the old
 *      path opened the wrong workspace silently.
 *   3. **Nothing was remembered** (a first launch) → nothing is started. There
 *      is no honest directory to guess, so the first screen asks.
 *
 * The check is `workspace_check` — the same rule `spawn` applies, shared rather
 * than reimplemented — so a directory is never accepted here and refused by the
 * runtime a moment later. It costs one round trip, once per launch.
 */
async function openFirstSession(isCancelled: () => boolean): Promise<void> {
  const store = useApp.getState();
  const remembered = store.lastWorkspace;

  // Nothing to go back to. The first screen is the answer, and it is where
  // somebody picks the place they will be working in.
  if (remembered === null) return;

  const refusal = await checkWorkspace(remembered);
  if (isCancelled()) return;

  if (refusal !== null) {
    // Kept on the first screen rather than covering the window: the interface
    // runs perfectly well, it just has no conversation open yet — and a
    // full-screen error for something a click can fix would be a lie about the
    // state of the application.
    useApp.getState().setStartupNotice({
      code: 'last-workspace-gone',
      path: remembered,
      reason: refusal,
    });
    return;
  }

  await useApp.getState().attachSession({ workspace: remembered });
}
