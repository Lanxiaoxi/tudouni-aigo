/**
 * Theme: the system's, and only the system's.
 *
 * `docs/tauri-native-spec.md` §4 is explicit — one theme source, no in-app
 * manual switch — and the protocol agrees: `init` carries no theme list. So
 * there is nothing to persist and nothing to select, and this module is just the
 * subscription that keeps `data-theme` in step with the OS.
 *
 * (The runtime's own `--theme` flag is the *TUI's* palette. It is not wired in
 * here; the two have nothing to do with each other.)
 */

export type ThemeName = 'dark' | 'light';

function prefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}

/** Apply the system theme. Called on mount and on every system change. */
export function applySystemTheme(): void {
  document.documentElement.dataset.theme = prefersDark() ? 'dark' : 'light';
}

/** Watch the system preference. Returns an unsubscribe function. */
export function watchSystemTheme(): () => void {
  let mq: MediaQueryList;
  try {
    mq = window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    return () => undefined;
  }
  const onChange = () => applySystemTheme();
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** The theme in force right now. Read-only: nothing sets it but the system. */
export function currentTheme(): ThemeName {
  return prefersDark() ? 'dark' : 'light';
}
