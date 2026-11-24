/**
 * React bindings for the Dock's per-workspace data cache
 * (`state/workspaceDock/dataCache.ts`).
 *
 * The cache lives with the workspace's host client, not with a component, so a
 * navigator that unmounts (mode switch, single-column pane switch) and mounts
 * again finds the same listings and the same status instead of reloading.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { workspaceHosts, type WorkspaceHostClient } from '@/workspaceHost';
import {
  EMPTY_DATA,
  workspaceDataFor,
  type DataState,
  type WorkspaceDataCache,
} from '@/state/workspaceDock/dataCache';

const NO_SUBSCRIBE = (): (() => void) => () => undefined;
const EMPTY = (): DataState => EMPTY_DATA;

/** The request client of a workspace the Dock is drawing, or `undefined`. */
export function useHostClient(workspaceId: string): WorkspaceHostClient | undefined {
  return workspaceHosts.get(workspaceId);
}

/** The workspace's cache, subscribed to its host once; `null` without a client. */
export function useWorkspaceCache(workspaceId: string): WorkspaceDataCache | null {
  const client = workspaceHosts.get(workspaceId);
  return useMemo(
    () => (client ? workspaceDataFor(workspaceId, client, client.isReady) : null),
    [workspaceId, client],
  );
}

/** The cache's state, re-rendering when it changes. */
export function useDataState(cache: WorkspaceDataCache | null): DataState {
  return useSyncExternalStore(cache ? cache.subscribe : NO_SUBSCRIBE, cache ? cache.getState : EMPTY);
}

/** How often a visible Git page re-asks (design 4.5): the watcher is the fast
 *  path, this is the floor for what it cannot see. */
export const GIT_POLL_MS = 10_000;

/**
 * Keep `git status` fresh while a Git page is on screen: when it opens, every
 * `GIT_POLL_MS` while the window is visible, and when the window regains focus.
 * The manual refresh is the caller's button.
 */
export function useGitCalibration(cache: WorkspaceDataCache | null, active: boolean): void {
  useEffect(() => {
    if (cache === null || !active) return;
    void cache.ensureGit(true);
    const poll = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void cache.ensureGit(true);
    }, GIT_POLL_MS);
    const onFocus = () => void cache.ensureGit(true);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener('focus', onFocus);
    };
  }, [cache, active]);
}

/** Refetch `git status` whenever an event (or a refresh) flagged it stale. */
export function useGitWhenStale(cache: WorkspaceDataCache | null, enabled: boolean, state: DataState): void {
  const { stale, status, error } = state.git;
  useEffect(() => {
    if (cache === null || !enabled) return;
    void cache.ensureGit();
    // `status`/`error` are in the deps so a first load happens on mount even
    // though nothing is stale yet.
  }, [cache, enabled, stale, status === null, error === null]);
}
