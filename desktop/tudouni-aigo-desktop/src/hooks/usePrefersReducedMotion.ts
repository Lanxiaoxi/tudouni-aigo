import { useSyncExternalStore } from 'react';

/**
 * Whether the operating system asks for reduced motion.
 *
 * The stylesheet already honours it for everything CSS animates
 * (`global.css`, the `prefers-reduced-motion` block). Pacing text is the one
 * motion this window produces in JavaScript, so it has to ask the same question
 * in the same place — a person who turned motion down system-wide should not
 * then be given a typewriter effect the stylesheet cannot reach.
 *
 * **One listener for the whole window, not one per row.** This is read by every
 * reasoning row and every live reply row, and a folded reasoning block stays
 * mounted for the life of the session (that is what lets `Ctrl+F` find it and
 * the fold animate) — so a per-hook `matchMedia` subscription would put one
 * listener per turn on a media query nothing else queries. A module-level
 * singleton with `useSyncExternalStore` is one listener and an array of
 * subscribers, which is what a media query actually is.
 */
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function supported(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

function read(): boolean {
  return supported() && window.matchMedia(REDUCED_MOTION).matches;
}

const subscribers = new Set<() => void>();
let attached = false;

/** Subscribe the singleton to the OS on first use, so an idle window has no
 *  listener and a window that asked has exactly one. */
function attach(): void {
  if (attached || !supported()) return;
  attached = true;
  window.matchMedia(REDUCED_MOTION).addEventListener('change', () => {
    for (const notify of subscribers) notify();
  });
}

function subscribe(notify: () => void): () => void {
  attach();
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
