import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

// Style assembly order matters: fonts -> tokens -> global -> components -> shell -> stream.
import '@/styles/fonts.css';
import '@/styles/tokens.css';
import '@/styles/global.css';
import '@/styles/components.css';
import '@/styles/app.css';
import '@/styles/stream.css';

import { App } from './App';
import { applyDelta } from '@/state/entries';
import { createSessionBucket, useApp } from '@/state/store';

const host = document.getElementById('root');
if (!host) throw new Error('#root not found');

// Development-only handle on the store this tree actually reads.
//
// It exists so an automated render check can feed the interface real protocol
// payloads and read back what the DOM did. Without it, a check that imports
// `/src/state/store` gets a *second* module instance (Vite keys modules by their
// resolved specifier, so `store` and `store.ts` are two of them), drives a store
// nobody is rendering, and reports failures that are artefacts of the harness.
//
// It is stripped from production builds by the `import.meta.env.DEV` guard.
//
// `VITE_PERF_HARNESS` is the second way in, and it exists because the numbers
// this file's handle produces are only meaningful from a **production** bundle:
// a dev build runs StrictMode's double render and the JSX dev runtime's prop
// validation, neither of which is in the shipped application, and both of which
// are large enough to hide the effect being measured. Build with
// `--mode production` and this variable set to `true` and the handles survive;
// without it the whole branch is dead code and is eliminated, so nothing ships.
if (import.meta.env.DEV || import.meta.env.VITE_PERF_HARNESS === 'true') {
  (window as unknown as { __aigoStore?: typeof useApp }).__aigoStore = useApp;
  // The bucket factory too, and for the same reason: a session's runtime facts
  // live in `sessions[key]`, and the only production path that creates a bucket
  // is `attachSession`, which needs a real child process. A check running in a
  // plain browser has no bridge, so without this it has no bucket to address its
  // payloads to — and `applyRuntimeMessage` drops anything for a key that does
  // not exist, silently, which is how a whole harness came to fail at `init`.
  (window as unknown as { __aigoCreateBucket?: typeof createSessionBucket }).__aigoCreateBucket =
    createSessionBucket;
  // And `flushSync`, because a streamed delta's cost cannot be measured without
  // it. React otherwise batches the store's notification into a later task, so a
  // timer around `applyRuntimeMessage` measures the reducer and nothing else —
  // which is exactly how a measurement came to report that the expensive part of
  // a delta was free. `flushSync` makes the render and the commit happen inside
  // the window being timed.
  (window as unknown as { __aigoFlushSync?: typeof flushSync }).__aigoFlushSync = flushSync;
  // And the reducer itself, so a measurement can time the pure part on its own.
  // It is the one stage that does not go through React, and separating it is
  // what says whether a delta's cost is the array scanning or the rendering.
  (window as unknown as { __aigoApplyDelta?: typeof applyDelta }).__aigoApplyDelta = applyDelta;
}

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
