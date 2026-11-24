/**
 * The Dock's per-workspace data cache (docs/design/workspace-dock.md 4.5, 5.2, 6.2).
 *
 * **Keyed by workspace, never by session.** Two conversations in one directory
 * share one tree and one `git status`, and switching between them must not
 * reload anything; so the cache hangs off the workspace's host client and
 * nothing here knows a session exists.
 *
 * Two halves:
 *   - **pure** (`planEvent`, `markDirsStale`, ...): what a `workspace_event`
 *     invalidates. The rules are the part that is invisible when wrong (a tree
 *     that quietly stops following the disk), so they are plain functions the
 *     tests can drive without a host;
 *   - `WorkspaceDataCache`: holds the state, fetches through a minimal client
 *     interface, and tells subscribers what changed.
 *
 * **Stale, not eager.** An event only flags what it touches. Whatever is on
 * screen refetches because its component asks (`ensureDir` / `ensureGit` are
 * idempotent and skip what is fresh); a directory nobody is looking at stays
 * flagged until somebody does. That is the design's "unshown caches are marked
 * stale, not all loaded at once".
 */
import type { FsListData, GitStatus, HostEntry, WorkspaceEvent } from '@/workspaceHost/protocol';

/* ============================================================
   Paths
   ============================================================ */

/** A workspace-relative path in the form the host uses: `/`-separated, no
 *  leading `./`, no trailing slash; the root is `''`. */
export function cleanPath(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return p === '.' ? '' : p;
}

/** The directory that holds `path`; the root's parent is the root. */
export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Every directory above `path`, outermost first: `a/b/c` → `['a', 'a/b']`. */
export function ancestorsOf(path: string): string[] {
  const parts = cleanPath(path).split('/').filter((p) => p !== '');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join('/'));
  return out;
}

/* ============================================================
   State
   ============================================================ */

export interface DirState {
  entries: readonly HostEntry[];
  truncated: boolean;
  /** At least one answer has landed (an empty directory is loaded). */
  loaded: boolean;
  loading: boolean;
  /** Something changed since the answer; refetch when it is next wanted. */
  stale: boolean;
  error: string | null;
  /** Bumped by every invalidation, so a fetch that was in flight when one
   *  happened can tell its answer is already out of date. */
  version: number;
}

export interface GitCacheState {
  status: GitStatus | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
  /** The host's error code (`not_git`, ...) when it gave one. */
  errorCode: string | null;
  version: number;
}

export interface DataState {
  /** The last `workspace_event` revision applied; `null` before the first one
   *  (and after a reconnect, whose host counts from 1 again). */
  revision: number | null;
  dirs: Readonly<Record<string, DirState>>;
  git: GitCacheState;
}

export const EMPTY_DIR: DirState = Object.freeze({
  entries: Object.freeze([]) as readonly HostEntry[],
  truncated: false,
  loaded: false,
  loading: false,
  stale: false,
  error: null,
  version: 0,
});

export const EMPTY_GIT: GitCacheState = Object.freeze({
  status: null,
  loading: false,
  stale: false,
  error: null,
  errorCode: null,
  version: 0,
});

export const EMPTY_DATA: DataState = Object.freeze({
  revision: null,
  dirs: Object.freeze({}) as Readonly<Record<string, DirState>>,
  git: EMPTY_GIT,
});

/* ============================================================
   Event rules (pure)
   ============================================================ */

export interface EventPlan {
  /** Reload everything shown: the host said so, or events were lost. */
  reset: boolean;
  resetReason: 'host' | 'gap' | null;
  /** Cached directories whose listing may have changed. */
  dirs: string[];
  /** Git status (and a diff of it) may have changed. */
  git: boolean;
  /** Anything under the file tree may have changed. */
  files: boolean;
  /** The changed paths, normalised; empty for a reset or a `.git`-only event. */
  paths: string[];
}

/**
 * What one event invalidates, given the last revision seen and the directories
 * that are cached.
 *
 *   - `reset_required`, or `revision !== last + 1`, reloads everything cached;
 *   - otherwise only the **parent directory of each changed path** (when it is
 *     cached), plus any cached directory *under* a path that was created,
 *     deleted or renamed (its whole subtree went with it);
 *   - `invalidates` containing `files` with no paths (a bare nudge) is treated
 *     like a reset of the tree, because nothing says which directory moved;
 *   - `git` in `invalidates` flags the status.
 *
 * A `null` last revision is a fresh subscription: nothing was missed that the
 * cache could be holding, so the first event is never a gap.
 */
export function planEvent(
  last: number | null,
  event: WorkspaceEvent,
  cachedDirs: readonly string[],
): EventPlan {
  const gap = last !== null && event.revision !== last + 1;
  const reset = event.reset_required === true || gap;
  const invalidates = Array.isArray(event.invalidates) ? event.invalidates : [];
  const changes = Array.isArray(event.changes) ? event.changes : [];
  const paths = changes.map((c) => cleanPath(c.path)).filter((p) => p !== '');
  const git = reset || invalidates.includes('git');
  const files = reset || invalidates.includes('files') || paths.length > 0;

  const dirs = new Set<string>();
  if (reset || (files && paths.length === 0)) {
    for (const d of cachedDirs) dirs.add(d);
  } else if (files) {
    const cached = new Set(cachedDirs);
    for (const change of changes) {
      const p = cleanPath(change.path);
      if (p === '') continue;
      const parent = parentOf(p);
      if (cached.has(parent)) dirs.add(parent);
      if (change.type !== 'modified') {
        const prefix = `${p}/`;
        for (const d of cachedDirs) if (d === p || d.startsWith(prefix)) dirs.add(d);
      }
    }
  }

  return {
    reset,
    resetReason: !reset ? null : event.reset_required === true ? 'host' : 'gap',
    dirs: [...dirs],
    git,
    files,
    paths: reset ? [] : paths,
  };
}

/** The state with the named cached directories flagged stale. Directories that
 *  are not cached are left out: there is nothing to refetch for them. */
export function markDirsStale(state: DataState, dirs: readonly string[]): DataState {
  let next: Record<string, DirState> | null = null;
  for (const d of dirs) {
    const cur = (next ?? state.dirs)[d];
    if (!cur) continue;
    next ??= { ...state.dirs };
    next[d] = { ...cur, stale: true, version: cur.version + 1 };
  }
  return next === null ? state : { ...state, dirs: next };
}

export function markGitStale(state: DataState): DataState {
  return { ...state, git: { ...state.git, stale: true, version: state.git.version + 1 } };
}

/** Apply one plan to the state: the revision, the stale flags. */
export function applyPlan(state: DataState, plan: EventPlan, revision: number | null): DataState {
  let next: DataState = { ...state, revision };
  next = markDirsStale(next, plan.dirs);
  if (plan.git) next = markGitStale(next);
  return next;
}

/** A status that says the same thing keeps its old object, so a 10s poll that
 *  found nothing new does not re-render the tree or refetch a diff. */
export function sameStatus(a: GitStatus | null, b: GitStatus | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ============================================================
   The cache
   ============================================================ */

/** The part of a host client the cache needs; a fake satisfies it in tests. */
export interface CacheClient {
  fsList(path: string): Promise<FsListData>;
  gitStatus(): Promise<GitStatus>;
  onWorkspaceEvent(cb: (event: WorkspaceEvent) => void): () => void;
  onConnection(cb: (connection: { state: string }) => void): () => void;
}

/** What subscribers of `onInvalidate` hear for each event: enough to decide
 *  whether the thing they show (a preview, a diff) is affected. */
export interface InvalidationNotice {
  revision: number | null;
  /** Reload everything shown. */
  reset: boolean;
  files: boolean;
  git: boolean;
  /** The changed paths; empty on a reset or a `.git`-only event. */
  paths: readonly string[];
}

/**
 * Should an open file preview re-read after this event? Yes when the host said
 * to reset, when the path itself changed, or when the event named no path at
 * all but claimed the files moved (nothing says it was not this one).
 */
export function shouldReloadPreview(notice: InvalidationNotice, path: string): boolean {
  if (notice.reset) return true;
  if (notice.paths.includes(path)) return true;
  return notice.files && notice.paths.length === 0;
}

/**
 * Should the open diff re-query? The path itself changing is the obvious case;
 * the other is a **git-only** event (`.git/index`, `HEAD`: a stage, a commit),
 * which changes a diff without touching the file. A different file changing
 * does not.
 */
export function shouldReloadDiff(notice: InvalidationNotice, path: string, origPath = ''): boolean {
  if (notice.reset) return true;
  if (notice.paths.includes(path)) return true;
  if (origPath !== '' && notice.paths.includes(origPath)) return true;
  return notice.git && notice.paths.length === 0;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function codeOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

export class WorkspaceDataCache {
  private state: DataState = EMPTY_DATA;
  private readonly listeners = new Set<() => void>();
  private readonly invalidators = new Set<(notice: InvalidationNotice) => void>();
  private offs: Array<() => void> = [];
  private seenReady = false;
  private lastState = 'idle';
  private disposed = false;
  private client: CacheClient | null = null;

  constructor(readonly workspaceId: string) {}

  /* ---------------- reading ---------------- */

  getState = (): DataState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  /** Every event, after the cache has applied it. */
  onInvalidate(cb: (notice: InvalidationNotice) => void): () => void {
    this.invalidators.add(cb);
    return () => {
      this.invalidators.delete(cb);
    };
  }

  /* ---------------- wiring ---------------- */

  /** Subscribe to the client **once**. `ready` says the host is already up, so
   *  the first `ready` this cache hears is a reconnect only if it saw one. */
  attach(client: CacheClient, ready = false): void {
    this.detach();
    this.client = client;
    this.seenReady = ready;
    this.lastState = ready ? 'ready' : 'idle';
    this.offs.push(client.onWorkspaceEvent((e) => this.applyEvent(e)));
    this.offs.push(client.onConnection((c) => this.onConnection(c.state)));
  }

  detach(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.client = null;
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
    this.listeners.clear();
    this.invalidators.clear();
  }

  private onConnection(state: string): void {
    const was = this.lastState;
    this.lastState = state;
    // Only the *transition* into ready counts: the client also reports other
    // changes (an error, a capability refresh) while it stays ready.
    if (state !== 'ready' || was === 'ready') return;
    // A host that came back is a different process: its revisions count from 1
    // again and nothing it said before is evidence about what is on disk now.
    if (this.seenReady) this.invalidateAll();
    this.seenReady = true;
  }

  /* ---------------- events ---------------- */

  applyEvent(event: WorkspaceEvent): void {
    if (this.disposed) return;
    const plan = planEvent(this.state.revision, event, Object.keys(this.state.dirs));
    this.setState(applyPlan(this.state, plan, event.revision));
    this.notify({
      revision: event.revision,
      reset: plan.reset,
      files: plan.files,
      git: plan.git,
      paths: plan.paths,
    });
  }

  /** Flag everything stale and tell watchers to reload (a manual refresh, a
   *  reconnect). The revision is forgotten: the next event is a fresh start. */
  invalidateAll(): void {
    if (this.disposed) return;
    let next: DataState = { ...this.state, revision: null };
    next = markDirsStale(next, Object.keys(next.dirs));
    next = markGitStale(next);
    this.setState(next);
    this.notify({ revision: null, reset: true, files: true, git: true, paths: [] });
  }

  /* ---------------- fetching ---------------- */

  /**
   * Make sure `path`'s listing is fresh. Skips a directory that is loaded and
   * not stale, one already loading, and one whose last attempt failed (an
   * automatic retry of a failing request is a loop); `force` retries it.
   */
  async ensureDir(path: string, force = false): Promise<void> {
    const client = this.client;
    if (client === null || this.disposed) return;
    const cur = this.state.dirs[path];
    if (cur?.loading) return;
    if (cur && !cur.stale && !force && (cur.loaded || cur.error !== null)) return;
    const version = cur?.version ?? 0;
    this.patchDir(path, { ...(cur ?? EMPTY_DIR), loading: true, stale: false, error: null });
    try {
      const data = await client.fsList(path);
      if (this.disposed) return;
      const now = this.state.dirs[path] ?? EMPTY_DIR;
      this.patchDir(path, {
        ...now,
        entries: Array.isArray(data.entries) ? data.entries : [],
        truncated: data.truncated === true,
        loaded: true,
        loading: false,
        // An invalidation that landed while the request was out: its answer
        // may predate the change, so it is fresh only if nothing bumped it.
        stale: now.version !== version,
        error: null,
      });
    } catch (err) {
      if (this.disposed) return;
      const now = this.state.dirs[path] ?? EMPTY_DIR;
      this.patchDir(path, { ...now, loading: false, stale: false, error: messageOf(err) });
    }
  }

  /** The same for `git status`. */
  async ensureGit(force = false): Promise<void> {
    const client = this.client;
    if (client === null || this.disposed) return;
    const cur = this.state.git;
    if (cur.loading) return;
    if (!force && !cur.stale && (cur.status !== null || cur.error !== null)) return;
    const version = cur.version;
    this.patchGit({ ...cur, loading: true, stale: false, error: null, errorCode: null });
    try {
      const status = await client.gitStatus();
      if (this.disposed) return;
      const now = this.state.git;
      this.patchGit({
        ...now,
        status: sameStatus(now.status, status) ? now.status : status,
        loading: false,
        stale: now.version !== version,
        error: null,
        errorCode: null,
      });
    } catch (err) {
      if (this.disposed) return;
      const now = this.state.git;
      this.patchGit({
        ...now,
        loading: false,
        stale: false,
        error: messageOf(err),
        errorCode: codeOf(err),
      });
    }
  }

  /* ---------------- internals ---------------- */

  private patchDir(path: string, dir: DirState): void {
    this.setState({ ...this.state, dirs: { ...this.state.dirs, [path]: dir } });
  }

  private patchGit(git: GitCacheState): void {
    this.setState({ ...this.state, git });
  }

  private setState(next: DataState): void {
    if (next === this.state) return;
    this.state = next;
    for (const cb of [...this.listeners]) cb();
  }

  private notify(notice: InvalidationNotice): void {
    for (const cb of [...this.invalidators]) {
      try {
        cb(notice);
      } catch (err) {
        // One watcher's bug must not stop the others from reloading.
        console.error('workspace data watcher failed:', err);
      }
    }
  }
}

/* ============================================================
   One cache per workspace
   ============================================================ */

interface Held {
  cache: WorkspaceDataCache;
  client: CacheClient;
}
const held = new Map<string, Held>();

/**
 * The cache of `workspaceId`, created on first use and bound to `client`.
 * Asking again with the same client returns the same cache (a session switch
 * inside a workspace reloads nothing); a **new** client for the id (the host
 * registry dropped the old one) gets a fresh cache, because the old one's
 * answers belong to a process that is gone.
 */
export function workspaceDataFor(workspaceId: string, client: CacheClient, ready = false): WorkspaceDataCache {
  const existing = held.get(workspaceId);
  if (existing && existing.client === client) return existing.cache;
  existing?.cache.dispose();
  const cache = new WorkspaceDataCache(workspaceId);
  cache.attach(client, ready);
  held.set(workspaceId, { cache, client });
  return cache;
}

/** Drop one workspace's cache (tests, and a workspace being forgotten). */
export function forgetWorkspaceData(workspaceId: string): void {
  held.get(workspaceId)?.cache.dispose();
  held.delete(workspaceId);
}
