import type { Translate, TKey } from '@/i18n';

/** A porcelain letter's name, for the tooltip and the accessible label. */
const LETTER_KEYS: Record<string, TKey> = {
  M: 'dock.git.status.modified',
  A: 'dock.git.status.added',
  D: 'dock.git.status.deleted',
  R: 'dock.git.status.renamed',
  C: 'dock.git.status.copied',
  T: 'dock.git.status.typeChanged',
  '?': 'dock.git.status.untracked',
  U: 'dock.git.status.conflict',
};

export function gitLetterLabel(t: Translate, letter: string): string {
  return t(LETTER_KEYS[letter] ?? 'dock.git.status.modified');
}
