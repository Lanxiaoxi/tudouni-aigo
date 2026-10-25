/**
 * Declare the Maple Mono CJK faces after boot, not during it.
 *
 * `?url` gives the built stylesheet's hashed asset URL — Vite emits
 * `maple-mono.css` (and the woff2 files it references) into `dist/assets`
 * exactly as if it were imported for side effects, so the faces ship in the
 * bundle and nothing is fetched from anywhere but the app itself.
 *
 * The `<link>` is the whole mechanism: a `@font-face` nobody has declared
 * does not exist as far as the browser is concerned, so until this runs the
 * mono stacks fall through Maple to the faces that precede it — exactly the
 * rendering a still-loading Maple produces under `font-display: swap`.
 */
import mapleFacesUrl from '@/styles/maple-mono.css?url';

let injected = false;

/** Idempotent: every caller after the first is a no-op. */
export function injectMapleFonts(): void {
  if (injected) return;
  injected = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = mapleFacesUrl;
  document.head.appendChild(link);
}
