import { useLayoutEffect } from 'react';
import { setRuntime } from './bus';
import { startRuntime, useApp } from '@/state/store';
import {
  attachRuntimeListener,
  createTauriRuntime,
  isHosted,
  readRuntimeVersion,
  readRuntimeStderr,
  readUserName,
} from './tauri';

/**
 * Wire the bridge to the store.
 *
 * `useLayoutEffect` rather than `useEffect`: the subscription must be in place
 * before this commit ends. The runtime is a separate process and the handshake
 * can be faster than a passive effect — once `init` lands in the gap between
 * "created the runtime" and "subscribed", the UI would sit in its booting phase
 * forever. A layout effect is synchronous, so there is no yield point between
 * creating and subscribing.
 *
 * The Rust side queues lines until the first subscriber exists, so this is belt
 * and braces rather than the only defence — the WebView's load timing is not
 * something we control.
 */
export function useRuntimeBridge(): void {
  useLayoutEffect(() => {
    const runtime = createTauriRuntime(
      (reason, fatal) => {
        // A version mismatch is the one drop that is not survivable: every
        // further line fails the same check, so counting them one at a time
        // turns "these two ends cannot talk" into a plausible-looking tally.
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
        useApp.setState({ dropped: useApp.getState().dropped + 1 });
      },
      // The child's stderr, kept for the diagnostics panel. Diagnostics only:
      // the runtime's own sentences for a person arrive as `notice` messages.
      (line) => {
        useApp.getState().pushStderr(line);
      },
      // Failing to register the listeners is not survivable either, and the
      // symptom is silence: `forward_line` would queue every line forever.
      (problem) => {
        useApp.getState().setStartupProblem(problem);
      },
    );
    setRuntime(runtime);

    const unsubscribe = runtime.subscribe((msg) => {
      useApp.getState().applyRuntimeMessage(msg);
    });

    // The listener exists now, so the bridge may release whatever it queued
    // before this moment. Doing it after `subscribe` rather than before is the
    // whole point: flushing first would emit into nothing.
    void attachRuntimeListener().catch((err: unknown) => {
      useApp.getState().setStartupProblem(`the runtime bridge could not attach: ${String(err)}`);
    });

    void (async () => {
      // Not hosted (plain `npm run dev` in a browser): nothing to start, and the
      // UI stays in its booting phase rather than pretending.
      if (!isHosted()) return;

      // The greeting's name comes from the OS, and the runtime's version from a
      // one-shot `--version` — neither is in the protocol.
      const [userName, version] = await Promise.all([readUserName(), readRuntimeVersion()]);
      useApp.getState().setRuntimeInfo({ version, userName });

      // Anything the child printed before it gave up is already in the bridge's
      // ring; read it once so a start-up failure has something to show even if
      // it died faster than the event subscription.
      const early = await readRuntimeStderr();
      for (const line of early) useApp.getState().pushStderr(line);

      await startRuntime({});
    })();

    return () => {
      unsubscribe();
      runtime.dispose();
      setRuntime(null);
    };
  }, []);
}
