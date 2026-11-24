/**
 * The Explorer and Git modules' pure halves (docs/design/workspace-dock.md 4.5,
 * 5, 6): what a workspace event invalidates, how a status becomes groups, how a
 * unified diff becomes numbered lines, how a preview grows, how the tree moves.
 *
 * Each of these is wrong silently: a tree that stops following the disk, a file
 * with staged and unstaged edits shown once, a line number off by one in a
 * hunk. None of it shows in a type check.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  WorkspaceDataCache,
  ancestorsOf,
  forgetWorkspaceData,
  planEvent,
  shouldReloadDiff,
  shouldReloadPreview,
  workspaceDataFor,
  type CacheClient,
} from '@/state/workspaceDock/dataCache';
import {
  applyGitFilter,
  decorFromStatus,
  flattenGroups,
  groupGitStatus,
  pickDiffSource,
} from '@/state/workspaceDock/gitModel';
import { parseUnifiedDiff, splitAvailable, splitRows } from '@/state/workspaceDock/diffParse';
import {
  appendRead,
  countShownLines,
  isTruncated,
  languageOfPath,
  lineSummary,
  nextLimit,
  previewFromRead,
  previewKindOf,
} from '@/state/workspaceDock/previewModel';
import { buildTreeRows, isPathVisible, terminalDirFor, treeKeyAction } from '@/state/workspaceDock/treeModel';
import type {
  FsListData,
  FsReadData,
  GitStatus,
  GitStatusEntry,
  HostEntry,
  WorkspaceEvent,
} from '@/workspaceHost';

/* ---------------- fixtures ---------------- */

function entry(path: string, kind: HostEntry['kind'] = 'file'): HostEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { name, path, kind, size: 1, mtime_ms: 0, hidden: name.startsWith('.') };
}

function ev(revision: number, over: Partial<WorkspaceEvent> = {}): WorkspaceEvent {
  return {
    workspace_id: 'w',
    revision,
    changes: [],
    invalidates: ['files', 'git'],
    reset_required: false,
    ...over,
  };
}

function status(entries: GitStatusEntry[], over: Partial<GitStatus> = {}): GitStatus {
  return {
    repo: true,
    branch: 'main',
    head: 'abc1234',
    upstream: '',
    ahead: 0,
    behind: 0,
    detached: false,
    unborn: false,
    operation: '',
    entries,
    truncated: false,
    ...over,
  };
}

function g(path: string, index: string, worktree: string, over: Partial<GitStatusEntry> = {}): GitStatusEntry {
  return { path, orig_path: '', index, worktree, conflict: false, untracked: false, ...over };
}

/** A host client that answers from tables and lets a test fire its pushes. */
function fakeClient() {
  const events = new Set<(e: WorkspaceEvent) => void>();
  const conns = new Set<(c: { state: string }) => void>();
  const listCalls: string[] = [];
  let gitCalls = 0;
  const lists: Record<string, HostEntry[]> = { '': [entry('src', 'dir'), entry('a.txt')], src: [entry('src/m.ts')] };
  let current: GitStatus = status([]);
  const client: CacheClient = {
    async fsList(path: string): Promise<FsListData> {
      listCalls.push(path);
      return { path, entries: lists[path] ?? [], truncated: false };
    },
    async gitStatus(): Promise<GitStatus> {
      gitCalls += 1;
      return current;
    },
    onWorkspaceEvent(cb) {
      events.add(cb);
      return () => events.delete(cb);
    },
    onConnection(cb) {
      conns.add(cb);
      return () => conns.delete(cb);
    },
  };
  return {
    client,
    listCalls,
    gitCalls: () => gitCalls,
    setStatus: (s: GitStatus) => {
      current = s;
    },
    push: (e: WorkspaceEvent) => events.forEach((cb) => cb(e)),
    conn: (state: string) => conns.forEach((cb) => cb({ state })),
    listenerCount: () => events.size,
  };
}

/* ============================================================
   Event rules
   ============================================================ */

test('ancestorsOf lists the directories above a path, outermost first', () => {
  assert.deepEqual(ancestorsOf('a/b/c.txt'), ['a', 'a/b']);
  assert.deepEqual(ancestorsOf('c.txt'), []);
});

test('an event refreshes only the cached parent directories of the changed paths', () => {
  const plan = planEvent(1, ev(2, { changes: [{ path: 'src/m.ts', type: 'modified' }] }), ['', 'src', 'docs']);
  assert.deepEqual(plan.dirs, ['src']);
  assert.equal(plan.reset, false);
  assert.equal(plan.git, true);
  assert.deepEqual(plan.paths, ['src/m.ts']);
});

test('a parent that is not cached is not refetched (nothing is shown there)', () => {
  const plan = planEvent(1, ev(2, { changes: [{ path: 'deep/er/x.go', type: 'created' }] }), ['', 'src']);
  assert.deepEqual(plan.dirs, []);
});

test('a deleted directory also flags the cached directories under it', () => {
  const plan = planEvent(1, ev(2, { changes: [{ path: 'src', type: 'deleted' }] }), ['', 'src', 'src/inner', 'srcx']);
  assert.deepEqual([...plan.dirs].sort(), ['', 'src', 'src/inner']);
});

test('a plain modification does not flag the directory it names', () => {
  const plan = planEvent(1, ev(2, { changes: [{ path: 'src', type: 'modified' }] }), ['', 'src']);
  assert.deepEqual(plan.dirs, ['']);
});

test('a git-only event flags git and no directory', () => {
  const plan = planEvent(1, ev(2, { invalidates: ['git'] }), ['', 'src']);
  assert.equal(plan.git, true);
  assert.equal(plan.files, false);
  assert.deepEqual(plan.dirs, []);
});

test('a files-only event leaves git alone', () => {
  const plan = planEvent(1, ev(2, { invalidates: ['files'], changes: [{ path: 'a.txt', type: 'modified' }] }), ['']);
  assert.equal(plan.git, false);
});

test('reset_required reloads every cached directory and git', () => {
  const plan = planEvent(5, ev(6, { reset_required: true, changes: [], invalidates: ['files', 'git'] }), ['', 'src']);
  assert.equal(plan.reset, true);
  assert.equal(plan.resetReason, 'host');
  assert.deepEqual([...plan.dirs].sort(), ['', 'src']);
  assert.equal(plan.git, true);
});

test('a revision gap is a reset even when the host did not say so', () => {
  const plan = planEvent(5, ev(8, { invalidates: ['files'], changes: [{ path: 'a.txt', type: 'modified' }] }), ['', 'src']);
  assert.equal(plan.reset, true);
  assert.equal(plan.resetReason, 'gap');
  assert.deepEqual([...plan.dirs].sort(), ['', 'src']);
  assert.equal(plan.git, true);
});

test('the first event of a subscription is never a gap', () => {
  assert.equal(planEvent(null, ev(40), ['']).reset, false);
});

test('a repeated or older revision is a gap too (the host restarted)', () => {
  assert.equal(planEvent(9, ev(9), ['']).reset, true);
  assert.equal(planEvent(9, ev(1), ['']).reset, true);
});

test('the open preview reloads on its own path, on a reset, never on another file', () => {
  const other = { revision: 2, reset: false, files: true, git: true, paths: ['b.txt'] };
  assert.equal(shouldReloadPreview(other, 'a.txt'), false);
  assert.equal(shouldReloadPreview({ ...other, paths: ['a.txt'] }, 'a.txt'), true);
  assert.equal(shouldReloadPreview({ ...other, paths: [], reset: true }, 'a.txt'), true);
  assert.equal(shouldReloadPreview({ ...other, paths: [], git: true, files: false }, 'a.txt'), false);
});

test('the open diff reloads on its path, its old name, a reset, or a git-only event', () => {
  const base = { revision: 2, reset: false, files: false, git: true, paths: [] as string[] };
  assert.equal(shouldReloadDiff({ ...base, paths: ['x'] }, 'a.txt'), false);
  assert.equal(shouldReloadDiff({ ...base, files: true, paths: ['a.txt'] }, 'a.txt'), true);
  assert.equal(shouldReloadDiff({ ...base, files: true, paths: ['old.txt'] }, 'new.txt', 'old.txt'), true);
  assert.equal(shouldReloadDiff(base, 'a.txt'), true, 'a stage/commit changes a diff without touching the file');
  assert.equal(shouldReloadDiff({ ...base, reset: true }, 'a.txt'), true);
});

/* ============================================================
   The cache
   ============================================================ */

test('listings are fetched once and reused; an event flags only the affected directory stale', async () => {
  const f = fakeClient();
  const cache = new WorkspaceDataCache('w');
  cache.attach(f.client, true);
  await cache.ensureDir('');
  await cache.ensureDir('src');
  await cache.ensureDir('');
  assert.deepEqual(f.listCalls, ['', 'src'], 'a fresh directory is not fetched again');

  f.push(ev(1, { changes: [{ path: 'src/m.ts', type: 'modified' }] }));
  assert.equal(cache.getState().dirs['src']!.stale, true);
  assert.equal(cache.getState().dirs['']!.stale, false);

  await cache.ensureDir('');
  await cache.ensureDir('src');
  assert.deepEqual(f.listCalls, ['', 'src', 'src'], 'only the stale one refetched');
  assert.equal(cache.getState().dirs['src']!.stale, false);
});

test('git status is marked stale by an event and refetched on demand, not before', async () => {
  const f = fakeClient();
  const cache = new WorkspaceDataCache('w');
  cache.attach(f.client, true);
  await cache.ensureGit();
  await cache.ensureGit();
  assert.equal(f.gitCalls(), 1);
  f.push(ev(1, { invalidates: ['git'] }));
  assert.equal(cache.getState().git.stale, true);
  assert.equal(f.gitCalls(), 1, 'an event only flags');
  await cache.ensureGit();
  assert.equal(f.gitCalls(), 2);
  assert.equal(cache.getState().git.stale, false);
});

test('a status that says the same thing keeps its object (no re-render storm)', async () => {
  const f = fakeClient();
  f.setStatus(status([g('a', 'M', '.')]));
  const cache = new WorkspaceDataCache('w');
  cache.attach(f.client, true);
  await cache.ensureGit();
  const first = cache.getState().git.status;
  f.setStatus(status([g('a', 'M', '.')]));
  await cache.ensureGit(true);
  assert.equal(cache.getState().git.status, first);
  f.setStatus(status([g('a', 'M', 'M')]));
  await cache.ensureGit(true);
  assert.notEqual(cache.getState().git.status, first);
});

test('an event that lands while a fetch is in flight keeps the answer stale', async () => {
  const f = fakeClient();
  const cache = new WorkspaceDataCache('w');
  cache.attach(f.client, true);
  await cache.ensureDir('');
  f.push(ev(1, { changes: [{ path: 'a.txt', type: 'modified' }] }));
  const pending = cache.ensureDir('');
  // The request is out; a second change arrives before it is answered.
  f.push(ev(2, { changes: [{ path: 'b.txt', type: 'created' }] }));
  await pending;
  assert.equal(cache.getState().dirs['']!.stale, true, 'the answer may predate the second change');
});

test('reset_required and a revision gap flag everything cached and tell watchers', async () => {
  const f = fakeClient();
  const cache = new WorkspaceDataCache('w');
  cache.attach(f.client, true);
  await cache.ensureDir('');
  await cache.ensureDir('src');
  await cache.ensureGit();
  const heard: boolean[] = [];
  cache.onInvalidate((n) => heard.push(n.reset));

  f.push(ev(1));
  f.push(ev(2, { reset_required: true, invalidates: ['files', 'git'] }));
  assert.ok(cache.getState().dirs['']!.stale && cache.getState().dirs['src']!.stale);
  assert.ok(cache.getState().git.stale);

  await cache.ensureDir('');
  await cache.ensureDir('src');
  await cache.ensureGit();
  f.push(ev(7, { invalidates: ['files'], changes: [{ path: 'a.txt', type: 'modified' }] }));
  assert.ok(cache.getState().dirs['src']!.stale, 'a gap reaches directories the change did not name');
  assert.deepEqual(heard, [false, true, true]);
});

test('a host that reconnects invalidates everything and restarts the revision count', async () => {
  const f = fakeClient();
  const cache = new WorkspaceDataCache('w');
  cache.attach(f.client, true);
  await cache.ensureDir('');
  await cache.ensureGit();
  f.push(ev(30));
  f.conn('disconnected');
  f.conn('ready');
  assert.ok(cache.getState().dirs['']!.stale);
  assert.ok(cache.getState().git.stale);
  assert.equal(cache.getState().revision, null);
  // The new host counts from 1 again: that is not a gap.
  f.push(ev(1, { invalidates: ['git'] }));
  assert.equal(cache.getState().revision, 1);
});

test('a ready update that is not a reconnect does not flush the cache', async () => {
  const f = fakeClient();
  const cache = new WorkspaceDataCache('w');
  cache.attach(f.client, true);
  await cache.ensureDir('');
  f.conn('ready');
  assert.equal(cache.getState().dirs['']!.stale, false);
});

test('a failed listing is not retried on its own, but can be forced', async () => {
  let calls = 0;
  const client: CacheClient = {
    async fsList() {
      calls += 1;
      throw new Error('denied');
    },
    async gitStatus() {
      return status([]);
    },
    onWorkspaceEvent: () => () => undefined,
    onConnection: () => () => undefined,
  };
  const cache = new WorkspaceDataCache('w');
  cache.attach(client, true);
  await cache.ensureDir('x');
  await cache.ensureDir('x');
  assert.equal(calls, 1);
  assert.equal(cache.getState().dirs['x']!.error, 'denied');
  await cache.ensureDir('x', true);
  assert.equal(calls, 2);
});

test('caches are isolated by workspace; one client subscribes once; a new client is a new cache', async () => {
  const a = fakeClient();
  const b = fakeClient();
  const ca = workspaceDataFor('ws-a', a.client, true);
  const cb = workspaceDataFor('ws-b', b.client, true);
  assert.notEqual(ca, cb);
  assert.equal(workspaceDataFor('ws-a', a.client, true), ca, 'a session switch inside the workspace reuses it');
  assert.equal(a.listenerCount(), 1, 'subscribed once, however many times it was asked for');

  await ca.ensureDir('');
  await cb.ensureDir('');
  a.push(ev(1, { changes: [{ path: 'a.txt', type: 'modified' }] }));
  assert.equal(ca.getState().dirs['']!.stale, true);
  assert.equal(cb.getState().dirs['']!.stale, false, "another workspace's event does not touch this one");
  assert.equal(b.listCalls.length, 1);

  const a2 = fakeClient();
  const fresh = workspaceDataFor('ws-a', a2.client, true);
  assert.notEqual(fresh, ca);
  assert.equal(a.listenerCount(), 0, 'the old cache let go of the old client');
  forgetWorkspaceData('ws-a');
  forgetWorkspaceData('ws-b');
});

/* ============================================================
   Git grouping
   ============================================================ */

test('a file changed in both the index and the worktree is a row in both groups', () => {
  const groups = groupGitStatus([g('src/a.go', 'M', 'M')]);
  assert.deepEqual(groups.staged.map((r) => [r.path, r.letter, r.source]), [['src/a.go', 'M', 'index']]);
  assert.deepEqual(groups.unstaged.map((r) => [r.path, r.letter, r.source]), [['src/a.go', 'M', 'worktree']]);
  assert.notEqual(groups.staged[0]!.key, groups.unstaged[0]!.key);
});

test('index-only and worktree-only changes land in one group each', () => {
  const groups = groupGitStatus([g('a', 'A', '.'), g('b', '.', 'D')]);
  assert.deepEqual(groups.staged.map((r) => r.path), ['a']);
  assert.deepEqual(groups.unstaged.map((r) => r.path), ['b']);
  assert.deepEqual(groups.unstaged.map((r) => r.letter), ['D']);
});

test('untracked files are unstaged rows with the untracked diff', () => {
  const groups = groupGitStatus([g('t.txt', '?', '?', { untracked: true })]);
  assert.equal(groups.staged.length, 0);
  assert.deepEqual(groups.unstaged.map((r) => [r.letter, r.source]), [['?', 'untracked']]);
});

test('a conflict is only in Conflicts, not also staged and unstaged', () => {
  const groups = groupGitStatus([g('c.go', 'U', 'U', { conflict: true })]);
  assert.equal(groups.conflicts.length, 1);
  assert.equal(groups.staged.length + groups.unstaged.length, 0);
  assert.equal(groups.conflicts[0]!.letter, 'U');
});

test('a staged rename carries its old name; the worktree side of the same file does not', () => {
  const groups = groupGitStatus([g('new.go', 'R', 'M', { orig_path: 'old.go' })]);
  assert.equal(groups.staged[0]!.origPath, 'old.go');
  assert.equal(groups.unstaged[0]!.origPath, '');
});

test('the filter narrows only the unstaged group, by tracked vs untracked', () => {
  const groups = groupGitStatus([
    g('s', 'A', '.'), // staged: tracked by construction
    g('m', '.', 'M'), // unstaged: tracked worktree change
    g('t.txt', '?', '?', { untracked: true }), // unstaged: untracked
    g('c.go', 'U', 'U', { conflict: true }),
  ]);
  assert.equal(applyGitFilter(groups, 'all'), groups, 'all is a no-op with stable identity');
  const tracked = applyGitFilter(groups, 'tracked');
  assert.deepEqual(tracked.unstaged.map((r) => r.path), ['m']);
  assert.deepEqual(tracked.staged.map((r) => r.path), ['s'], 'staged is never filtered');
  assert.deepEqual(tracked.conflicts.map((r) => r.path), ['c.go'], 'conflicts are never filtered');
  const untracked = applyGitFilter(groups, 'untracked');
  assert.deepEqual(untracked.unstaged.map((r) => r.path), ['t.txt']);
  assert.equal(untracked.staged.length, 1);
  assert.equal(untracked.conflicts.length, 1);
});

test('display order is staged, unstaged, conflicts', () => {
  const groups = groupGitStatus([
    g('c', 'U', 'U', { conflict: true }),
    g('u', '.', 'M'),
    g('s', 'A', '.'),
  ]);
  assert.deepEqual(flattenGroups(groups).map((r) => r.path), ['s', 'u', 'c']);
});

test('tree decoration: worktree letter first, a dot on every directory above a change', () => {
  const decor = decorFromStatus([g('src/deep/a.go', 'M', 'M'), g('b.txt', 'A', '.'), g('same', '.', '.')]);
  assert.equal(decor.letters.get('src/deep/a.go'), 'M');
  assert.equal(decor.letters.get('b.txt'), 'A');
  assert.equal(decor.letters.has('same'), false);
  assert.deepEqual([...decor.dirs].sort(), ['src', 'src/deep']);
});

test('which diff the Explorer opens for a file', () => {
  const entries = [
    g('w', '.', 'M'),
    g('i', 'M', '.'),
    g('both', 'M', 'M'),
    g('u', '?', '?', { untracked: true }),
    g('c', 'U', 'U', { conflict: true }),
  ];
  assert.equal(pickDiffSource(entries, 'w'), 'worktree');
  assert.equal(pickDiffSource(entries, 'i'), 'index');
  assert.equal(pickDiffSource(entries, 'both'), 'worktree');
  assert.equal(pickDiffSource(entries, 'u'), 'untracked');
  assert.equal(pickDiffSource(entries, 'c'), 'worktree');
  assert.equal(pickDiffSource(entries, 'nope'), null);
});

/* ============================================================
   Diff parser
   ============================================================ */

const SAMPLE = [
  'diff --git a/src/a.go b/src/a.go',
  'index 111..222 100644',
  '--- a/src/a.go',
  '+++ b/src/a.go',
  '@@ -10,4 +10,5 @@ func main() {',
  ' keep one',
  '-old line',
  '+new line',
  '+added line',
  ' keep two',
  '@@ -40 +41,2 @@',
  ' tail',
  '+extra',
  '',
].join('\n');

test('hunks, counts and old/new line numbers', () => {
  const d = parseUnifiedDiff(SAMPLE);
  assert.equal(d.hunks.length, 2);
  const h = d.hunks[0]!;
  assert.deepEqual([h.oldStart, h.oldCount, h.newStart, h.newCount], [10, 4, 10, 5]);
  assert.equal(h.section, 'func main() {');
  assert.deepEqual(
    h.lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text]),
    [
      ['context', 10, 10, 'keep one'],
      ['del', 11, null, 'old line'],
      ['add', null, 11, 'new line'],
      ['add', null, 12, 'added line'],
      ['context', 12, 13, 'keep two'],
    ],
  );
  assert.equal(d.added, 3);
  assert.equal(d.removed, 1);
});

test('a hunk header without a count means one line', () => {
  const second = parseUnifiedDiff(SAMPLE).hunks[1]!;
  assert.deepEqual([second.oldStart, second.oldCount, second.newStart, second.newCount], [40, 1, 41, 2]);
  assert.deepEqual(second.lines.map((l) => [l.kind, l.oldNo, l.newNo]), [
    ['context', 40, 41],
    ['add', null, 42],
  ]);
});

test('"\\ No newline at end of file" marks the line above it, and is not a line', () => {
  const d = parseUnifiedDiff(
    ['--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', ' same', '-a', '\\ No newline at end of file', '+b', '\\ No newline at end of file', ''].join('\n'),
  );
  const lines = d.hunks[0]!.lines;
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.noNewline), [false, true, true]);
});

test('a removed line that starts with "--" is a removal, not a header', () => {
  const d = parseUnifiedDiff(['--- a/f', '+++ b/f', '@@ -1,2 +1,1 @@', '--- yaml', ' x', ''].join('\n'));
  assert.deepEqual(d.hunks[0]!.lines.map((l) => [l.kind, l.text]), [
    ['del', '-- yaml'],
    ['context', 'x'],
  ]);
});

test('rename and copy headers, with and without content changes', () => {
  const r = parseUnifiedDiff(
    ['diff --git a/old.go b/new.go', 'similarity index 90%', 'rename from old.go', 'rename to new.go', '--- a/old.go', '+++ b/new.go', '@@ -1 +1 @@', '-x', '+y', ''].join('\n'),
  );
  assert.equal(r.renameFrom, 'old.go');
  assert.equal(r.renameTo, 'new.go');
  assert.equal(r.copy, false);
  assert.equal(r.hunks.length, 1);

  const pure = parseUnifiedDiff(['diff --git a/a b/b', 'similarity index 100%', 'rename from a', 'rename to b', ''].join('\n'));
  assert.equal(pure.renameFrom, 'a');
  assert.equal(pure.hunks.length, 0);

  const c = parseUnifiedDiff(['diff --git a/a b/b', 'copy from a', 'copy to b', ''].join('\n'));
  assert.equal(c.copy, true);
});

test('binary notices and whole-file modes', () => {
  assert.equal(parseUnifiedDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n').binary, true);
  assert.equal(parseUnifiedDiff('diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+hi\n').newFile, true);
  assert.equal(parseUnifiedDiff('diff --git a/n b/n\ndeleted file mode 100644\n').deletedFile, true);
});

test('empty and truncated input do not throw and keep what parsed', () => {
  assert.equal(parseUnifiedDiff('').hunks.length, 0);
  const cut = parseUnifiedDiff('--- a/f\n+++ b/f\n@@ -1,5 +1,5 @@\n a\n-b\n+c\n d');
  assert.equal(cut.hunks.length, 1);
  assert.equal(cut.hunks[0]!.lines.length, 4);
});

test('CRLF diffs parse the same and keep their text clean', () => {
  const d = parseUnifiedDiff('--- a/f\r\n+++ b/f\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n');
  assert.deepEqual(d.hunks[0]!.lines.map((l) => l.text), ['a', 'b']);
});

test('split rows lay a run of removals against the additions after it', () => {
  const rows = splitRows(parseUnifiedDiff(SAMPLE).hunks[0]!.lines);
  assert.deepEqual(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null]), [
    ['keep one', 'keep one'],
    ['old line', 'new line'],
    [null, 'added line'],
    ['keep two', 'keep two'],
  ]);
});

test('split is offered from 720px, and not under it', () => {
  assert.equal(splitAvailable(719), false);
  assert.equal(splitAvailable(720), true);
});

/* ============================================================
   File preview
   ============================================================ */

function read(over: Partial<FsReadData> = {}): FsReadData {
  return {
    path: 'a.go',
    size: 600000,
    offset: 0,
    bytes_read: 262144,
    content: 'one\ntwo\n',
    next_offset: 262144,
    truncated: true,
    total_lines: null,
    encoding: 'utf-8',
    status: 'ok',
    mime: 'text/x-go',
    ...over,
  };
}

test('a first range is truncated and never claims a total it does not have', () => {
  const p = previewFromRead(read());
  assert.equal(isTruncated(p), true);
  assert.equal(p.totalLines, null);
  assert.deepEqual(lineSummary(p), { shown: 2, total: null, atLeast: true });
});

test('a whole-file read reports the host\'s total, and only that', () => {
  const p = previewFromRead(read({ truncated: false, next_offset: null, total_lines: 2, bytes_read: 8, size: 8 }));
  assert.equal(isTruncated(p), false);
  assert.deepEqual(lineSummary(p), { shown: 2, total: 2, atLeast: false });
});

test('"load more" continues at next_offset and then drops any total', () => {
  const first = previewFromRead(read());
  const next = appendRead(first, read({ offset: 262144, bytes_read: 337856, content: 'three\n', next_offset: null, truncated: false }));
  assert.ok(next);
  assert.equal(next.content, 'one\ntwo\nthree\n');
  assert.equal(next.nextOffset, null);
  assert.equal(next.bytesRead, 600000);
  assert.equal(next.totalLines, null);
  assert.equal(isTruncated(next), false);
  assert.equal(countShownLines(next.content), 3);
});

test('a continuation that does not start where the last one ended is refused', () => {
  const first = previewFromRead(read());
  assert.equal(appendRead(first, read({ offset: 100 })), null);
  assert.equal(appendRead(first, read({ offset: 262144, status: 'binary' })), null);
});

test('a continuation may start later (the cut was inside a character)', () => {
  const first = previewFromRead(read());
  assert.ok(appendRead(first, read({ offset: 262146, content: 'x', next_offset: null })));
});

test('the next range is the chunk, never more than what is left', () => {
  const first = previewFromRead(read({ size: 300000 }));
  assert.equal(nextLimit(first), 300000 - 262144);
  assert.equal(nextLimit(previewFromRead(read({ size: 9_000_000 }))), 262144);
});

test('binary and non-UTF-8 are an empty state with no content, not an error', () => {
  for (const status of ['binary', 'non_utf8'] as const) {
    const p = previewFromRead(read({ status, content: '', bytes_read: 0, next_offset: null, encoding: '' }));
    assert.equal(p.status, status);
    assert.equal(p.content, '');
    assert.equal(isTruncated(p), false);
  }
});

test('line counting ignores the final newline and counts an unterminated last line', () => {
  assert.equal(countShownLines(''), 0);
  assert.equal(countShownLines('a'), 1);
  assert.equal(countShownLines('a\n'), 1);
  assert.equal(countShownLines('a\nb'), 2);
});

test('what kind of file: images by name or mime, markdown, code, text', () => {
  assert.equal(previewKindOf('a/b.PNG', ''), 'image');
  assert.equal(previewKindOf('x', 'image/webp'), 'image');
  assert.equal(previewKindOf('logo.svg', 'image/svg+xml'), 'code', 'SVG is read as highlighted XML, not injected as an image');
  assert.equal(previewKindOf('README.md', ''), 'markdown');
  assert.equal(previewKindOf('main.go', ''), 'code');
  assert.equal(previewKindOf('notes.log', ''), 'text');
  assert.equal(languageOfPath('Makefile'), 'makefile');
  assert.equal(languageOfPath('src/x.tsx'), 'typescript');
  assert.equal(languageOfPath('noext'), null);
});

/* ============================================================
   Tree rows and keys
   ============================================================ */

function dir(entries: HostEntry[], over: Record<string, unknown> = {}) {
  return { entries, truncated: false, loaded: true, loading: false, stale: false, error: null, version: 0, ...over };
}

test('the tree hides dotfiles by default, .git always, and walks only open directories', () => {
  const dirs = {
    '': dir([entry('.git', 'dir'), entry('.env'), entry('src', 'dir'), entry('a.txt')]),
    src: dir([entry('src/m.ts')]),
  };
  const closed = buildTreeRows(dirs, [], false).filter((r) => r.type === 'entry');
  assert.deepEqual(closed.map((r) => r.path), ['src', 'a.txt']);
  const opened = buildTreeRows(dirs, ['src'], true).filter((r) => r.type === 'entry');
  assert.deepEqual(opened.map((r) => r.path), ['.env', 'src', 'src/m.ts', 'a.txt'], 'hidden shown, .git never');
});

test('an open directory without a listing shows a loading note, an empty one says so', () => {
  const loading = buildTreeRows({ '': dir([entry('src', 'dir')]) }, ['src'], false);
  assert.deepEqual(loading.map((r) => (r.type === 'note' ? r.note : r.path)), ['src', 'loading']);
  const empty = buildTreeRows({ '': dir([entry('src', 'dir')]), src: dir([]) }, ['src'], false);
  assert.deepEqual(empty.map((r) => (r.type === 'note' ? r.note : r.path)), ['src', 'empty']);
});

test('a truncated listing says so', () => {
  const rows = buildTreeRows({ '': dir([entry('a')], { truncated: true }) }, [], false);
  assert.equal(rows[rows.length - 1]!.type === 'note' && (rows[rows.length - 1] as { note: string }).note, 'truncated');
});

test('a search hit inside a hidden directory is hidden with it', () => {
  assert.equal(isPathVisible('.config/x.json', false), false);
  assert.equal(isPathVisible('.config/x.json', true), true);
  assert.equal(isPathVisible('.git/HEAD', true), false);
  assert.equal(isPathVisible('src/x.ts', false), true);
});

test('keyboard: arrows move, Right opens then descends, Left closes then climbs', () => {
  const dirs = {
    '': dir([entry('src', 'dir'), entry('z.txt')]),
    src: dir([entry('src/m.ts')]),
  };
  const rows = buildTreeRows(dirs, ['src'], false);
  assert.deepEqual(treeKeyAction(rows, 'src', 'ArrowDown'), { type: 'focus', path: 'src/m.ts' });
  assert.deepEqual(treeKeyAction(rows, 'src/m.ts', 'ArrowUp'), { type: 'focus', path: 'src' });
  assert.deepEqual(treeKeyAction(rows, 'z.txt', 'ArrowDown'), { type: 'focus', path: 'z.txt' }, 'stops at the end');
  assert.deepEqual(treeKeyAction(rows, 'src', 'ArrowLeft'), { type: 'collapse', path: 'src' });
  assert.deepEqual(treeKeyAction(rows, 'src/m.ts', 'ArrowLeft'), { type: 'focus', path: 'src' });
  assert.deepEqual(treeKeyAction(rows, 'src', 'ArrowRight'), { type: 'focus', path: 'src/m.ts' });
  const closed = buildTreeRows(dirs, [], false);
  assert.deepEqual(treeKeyAction(closed, 'src', 'ArrowRight'), { type: 'expand', path: 'src' });
  assert.deepEqual(treeKeyAction(closed, 'z.txt', 'Enter'), { type: 'activate', path: 'z.txt' });
  assert.equal(treeKeyAction(closed, 'z.txt', 'ArrowRight'), null);
  assert.equal(treeKeyAction(closed, 'z.txt', 'a'), null, 'typing is left alone');
  assert.deepEqual(treeKeyAction(closed, null, 'ArrowDown'), { type: 'focus', path: 'src' });
  assert.deepEqual(treeKeyAction(closed, 'src', 'End'), { type: 'focus', path: 'z.txt' });
});

test('"open a terminal here" uses the folder itself, or a file\'s parent', () => {
  assert.equal(terminalDirFor('src/app', 'dir'), 'src/app');
  assert.equal(terminalDirFor('src/app/x.ts', 'file'), 'src/app');
  assert.equal(terminalDirFor('x.ts', 'file'), '');
});
