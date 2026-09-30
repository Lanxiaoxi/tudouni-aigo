import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Style assembly order matters: fonts -> tokens -> global -> components -> shell -> stream.
import '@/styles/fonts.css';
import '@/styles/tokens.css';
import '@/styles/global.css';
import '@/styles/components.css';
import '@/styles/app.css';
import '@/styles/stream.css';

import { App } from './App';
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
if (import.meta.env.DEV) {
  (window as unknown as { __aigoStore?: typeof useApp }).__aigoStore = useApp;
  // The bucket factory too, and for the same reason: a session's runtime facts
  // live in `sessions[key]`, and the only production path that creates a bucket
  // is `attachSession`, which needs a real child process. A check running in a
  // plain browser has no bridge, so without this it has no bucket to address its
  // payloads to — and `applyRuntimeMessage` drops anything for a key that does
  // not exist, silently, which is how a whole harness came to fail at `init`.
  (window as unknown as { __aigoCreateBucket?: typeof createSessionBucket }).__aigoCreateBucket =
    createSessionBucket;
}

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
