/**
 * The composer's view of one workspace's prompt history.
 *
 * The list is read from the window's cache rather than held per mount: two
 * composers (a conversation and the board's) showing the same workspace must
 * agree, and a remount must not re-read the file. `useSyncExternalStore` is the
 * subscription that makes the load's arrival visible — the effect below starts
 * it, and the cache's publish is what draws the suggestion.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { cachedPrompts, ensurePromptHistory, subscribePrompts } from '@/state/promptStore';
import type { PromptEntry } from '@/state/promptHistory';

export function usePromptHistory(
  key: string | null,
  workspace: string,
  remoteWorkspaceId: string | null,
): readonly PromptEntry[] {
  const entries = useSyncExternalStore(
    subscribePrompts,
    () => cachedPrompts(key),
    () => cachedPrompts(key),
  );

  useEffect(() => {
    if (key === null) return;
    void ensurePromptHistory(key, workspace, remoteWorkspaceId);
  }, [key, workspace, remoteWorkspaceId]);

  return entries;
}
