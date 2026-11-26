import { useMemo } from 'react';
import { makeT, type Translate } from './index';
import { useApp } from '@/state/store';

/**
 * The `t` a component reads interface copy through. It subscribes to
 * `uiLang`, so a language switch re-renders every reader in one frame — the
 * whole window, including panels already open, at once. `useMemo` on the field
 * (not on the object the hook would otherwise return) keeps the reference
 * stable between renders while the language is unchanged.
 */
export function useT(): Translate {
  const lang = useApp((s) => s.uiLang);
  return useMemo(() => makeT(lang), [lang]);
}
