/**
 * Whether the guide's "say hi" has been answered.
 *
 * The test is an `answer` entry **after a prompt typed in this window**. A
 * transcript rebuilt by `session_load` carries answers too, but its prompts are
 * restored with `atMs: 0` — so a session that already had a conversation
 * cannot finish the guide by itself; only a reply to something just sent does.
 */
import type { Entry } from '@/state/entries';

export function helloAnswered(entries: readonly Entry[]): boolean {
  let lastTyped = -1;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.kind === 'user' && entry.atMs > 0) lastTyped = i;
  }
  if (lastTyped < 0) return false;
  for (let i = lastTyped + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.kind === 'answer' && entry.text.trim() !== '') return true;
  }
  return false;
}
