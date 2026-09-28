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
import { useApp } from '@/state/store';

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
}

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
