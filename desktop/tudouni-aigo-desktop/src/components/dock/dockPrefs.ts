import { useCallback, useState } from 'react';

/**
 * Small per-window view preferences of the Dock (hidden files shown, the diff
 * layout). Kept out of `prefs.ts` and the workspace UI state on purpose: they
 * are how this person likes to read, not where they were in a workspace, and a
 * lost one costs a click.
 */
const KEY = 'aigo.dock.view';

function readAll(): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readDockPref<T>(name: string, fallback: T, valid: (v: unknown) => v is T): T {
  const v = readAll()[name];
  return valid(v) ? v : fallback;
}

export function writeDockPref(name: string, value: unknown): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [name]: value }));
  } catch {
    // Storage full or blocked: the preference lasts until the window closes.
  }
}

export function usePersistedPref<T>(
  name: string,
  fallback: T,
  valid: (v: unknown) => v is T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => readDockPref(name, fallback, valid));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writeDockPref(name, next);
    },
    [name],
  );
  return [value, set];
}

export const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
