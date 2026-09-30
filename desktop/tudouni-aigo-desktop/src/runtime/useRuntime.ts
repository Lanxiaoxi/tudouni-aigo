import { useLayoutEffect } from 'react';
import { useApp } from '@/state/store';
import {
  attachRuntimeListener,
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

      // The first session. Every later one is opened from the interface.
      await useApp.getState().attachSession({});
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}
