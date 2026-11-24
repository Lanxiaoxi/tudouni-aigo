/**
 * The Dock's state: workspace identity, the per-workspace UI state, the
 * shortcuts, and the capability gate.
 *
 * What these protect is invisible in a screenshot. Two spellings of one
 * directory landing on two keys silently resets the person's file tree; a
 * session switch that moved the dock would be a bug nobody can point at; a
 * shortcut that does the wrong thing in one state does it only in that state.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAppStore, createSessionBucket } from '@/state/store';
import { selectActiveWorkspaceKey } from '@/state/workspaceDock/selectors';
import { workspaceIdFor } from '@/state/workspaceDock/workspaceId';
import { workspaceIdOf } from '@/workspaceHost/workspaceId';
import {
  EMPTY_WORKSPACE_UI,
  MAX_REMEMBERED_WORKSPACES,
  sanitizeWorkspaceUi,
  sanitizeWorkspaceUiMap,
  withDirExpanded,
  withWorkspaceUi,
} from '@/state/workspaceDock/uiState';
import {
  applyDockShortcut,
  focusIsInDockTerminal,
  matchDockShortcut,
  type DockKeyEvent,
} from '@/state/workspaceDock/shortcuts';
import { regionState } from '@/state/workspaceDock/capabilities';

const LAUNCH = { ericai: false, maxSteps: null };

/* ---------------- workspaceIdFor ---------------- */

test('the dock UI key is the host channel id (one identity, not two schemes)', () => {
  for (const [root, remote] of [['C:\\Repo', null], ['/srv/app', 'rw-1']] as const) {
    assert.equal(workspaceIdFor(root, remote), workspaceIdOf(root, remote));
  }
});

test('a remote workspace is its saved entry id, whatever its path says', () => {
  assert.equal(workspaceIdFor('/srv/app', 'rw-1'), workspaceIdFor('C:/work', 'rw-1'));
  assert.notEqual(workspaceIdFor('/srv/app', 'rw-1'), workspaceIdFor('/srv/app', null));
});

test('local roots: case and separator spellings are one workspace', () => {
  const id = workspaceIdFor('C:\\Users\\Me\\Repo', null);
  assert.match(id, /^local:[0-9a-f]{16}$/);
  for (const spelling of ['c:/users/me/repo', 'C:/Users/Me/Repo/', 'C:\\Users\\Me\\Repo\\', 'c:\\USERS\\me\\repo\\\\']) {
    assert.equal(workspaceIdFor(spelling, null), id, spelling);
  }
  assert.notEqual(workspaceIdFor('D:\\a', null), workspaceIdFor('C:\\a', null));
  assert.equal(workspaceIdFor('/home/me/repo/', null), workspaceIdFor('/home//me/repo', null));
});

/* ---------------- useActiveWorkspaceKey's pure half ---------------- */

test('the active session names the workspace; two sessions of one directory share it', () => {
  const store = createAppStore();
  store.setState({
    activeKey: 'a',
    sessions: {
      a: createSessionBucket('a', 'C:/Work/App', LAUNCH),
      b: createSessionBucket('b', 'c:\\work\\app\\', LAUNCH),
      r: createSessionBucket('r', '/srv/app', LAUNCH, 'rw-9'),
    },
  });
  const a = selectActiveWorkspaceKey(store.getState());
  assert.deepEqual(a, { workspaceId: workspaceIdOf('C:/Work/App', null), root: 'C:/Work/App', remoteWorkspaceId: null });

  store.setState({ activeKey: 'b' });
  assert.equal(selectActiveWorkspaceKey(store.getState())?.workspaceId, a?.workspaceId);

  store.setState({ activeKey: 'r' });
  assert.deepEqual(selectActiveWorkspaceKey(store.getState()), {
    workspaceId: workspaceIdOf('/srv/app', 'rw-9'),
    root: '/srv/app',
    remoteWorkspaceId: 'rw-9',
  });
});

test('no session, or a session with no directory yet, is no workspace', () => {
  const store = createAppStore();
  assert.equal(selectActiveWorkspaceKey(store.getState()), null);
  store.setState({ activeKey: 'x', sessions: { x: createSessionBucket('x', '', LAUNCH) } });
  assert.equal(selectActiveWorkspaceKey(store.getState()), null);
});

/* ---------------- per-workspace UI state ---------------- */

test('a patch that changes nothing returns the same map (no re-render, no write)', () => {
  const m1 = withWorkspaceUi({}, 'local:/a', { selectedFile: 'x.go' });
  assert.equal(withWorkspaceUi(m1, 'local:/a', { selectedFile: 'x.go' }), m1);
  const empty: Record<string, never> = {};
  assert.equal(withWorkspaceUi(empty, 'local:/a', {}), empty, 'an untouched workspace is not recorded');
  assert.equal(withWorkspaceUi(m1, '', { selectedFile: 'y' }), m1, 'no id, no state');
});

test('workspaces are isolated, and the least recently touched is evicted first', () => {
  let map: ReturnType<typeof withWorkspaceUi> = {};
  for (let i = 0; i < MAX_REMEMBERED_WORKSPACES + 5; i++) {
    map = withWorkspaceUi(map, `local:/w${i}`, { selectedFile: `f${i}` });
  }
  assert.equal(Object.keys(map).length, MAX_REMEMBERED_WORKSPACES);
  assert.equal('local:/w0' in map, false);
  assert.equal(map[`local:/w${MAX_REMEMBERED_WORKSPACES + 4}`]?.selectedFile, `f${MAX_REMEMBERED_WORKSPACES + 4}`);

  // Touching an old one saves it from the next eviction.
  map = withWorkspaceUi(map, 'local:/w5', { searchQuery: 'q' });
  map = withWorkspaceUi(map, 'local:/new', { selectedFile: 'n' });
  assert.equal('local:/w5' in map, true);
  assert.equal(map['local:/w5']?.selectedFile, 'f5', 'a patch keeps the rest of the record');
});

test('directories open, close and toggle without duplicates', () => {
  let dirs: readonly string[] = [];
  dirs = withDirExpanded(dirs, 'src');
  dirs = withDirExpanded(dirs, 'src/a');
  assert.deepEqual(dirs, ['src', 'src/a']);
  assert.equal(withDirExpanded(dirs, 'src', true), dirs, 'already open: same array');
  assert.deepEqual(withDirExpanded(dirs, 'src'), ['src/a']);
  assert.equal(withDirExpanded(dirs, 'nope', false), dirs);
});

test('a stored record is read back defensively', () => {
  assert.equal(sanitizeWorkspaceUi(null), EMPTY_WORKSPACE_UI);
  assert.equal(sanitizeWorkspaceUi('x'), EMPTY_WORKSPACE_UI);
  const ok = sanitizeWorkspaceUi({
    expandedDirs: ['a', 'a', 3, '', 'b'],
    selectedFile: 'a/x.go',
    gitSelection: { path: 'y.go', source: 'index' },
    activeTerminalId: 't1',
    searchQuery: 'foo',
  });
  assert.deepEqual(ok.expandedDirs, ['a', 'b']);
  assert.deepEqual(ok.gitSelection, { path: 'y.go', source: 'index' });
  const bad = sanitizeWorkspaceUi({ gitSelection: { path: 'y.go', source: 'bogus' }, selectedFile: 5, searchQuery: 1 });
  assert.equal(bad.gitSelection, null, 'an unknown diff source is not guessed');
  assert.equal(bad.selectedFile, null);
  assert.equal(bad.searchQuery, '');
  assert.deepEqual(sanitizeWorkspaceUiMap([]), {});
  assert.deepEqual(Object.keys(sanitizeWorkspaceUiMap({ '': {}, 'local:/a': {} })), ['local:/a']);
});

/* ---------------- the store slice ---------------- */

test('Explorer and Git selections are independent, and neither lives on a session', () => {
  const store = createAppStore();
  const s = () => store.getState();
  const id = 'local:/w';

  s().setWorkspaceSelectedFile(id, 'a.go');
  s().setWorkspaceGitSelection(id, { path: 'b.go', source: 'worktree' });
  s().toggleWorkspaceDir(id, 'src');
  s().setWorkspaceSearch(id, 'needle');
  s().setWorkspaceActiveTerminal(id, 'term-2');

  const ui = s().workspaceUi[id];
  assert.equal(ui?.selectedFile, 'a.go');
  assert.deepEqual(ui?.gitSelection, { path: 'b.go', source: 'worktree' });
  assert.deepEqual(ui?.expandedDirs, ['src']);
  assert.equal(ui?.searchQuery, 'needle');
  assert.equal(ui?.activeTerminalId, 'term-2');

  // Switching mode and sessions leaves all of it alone.
  s().setDockMode('git');
  s().setDockMode('explorer');
  store.setState({ activeKey: 'other', sessions: { other: createSessionBucket('other', 'C:/x', LAUNCH) } });
  assert.equal(s().workspaceUi[id]?.selectedFile, 'a.go');
  assert.deepEqual(s().workspaceUi[id]?.gitSelection, { path: 'b.go', source: 'worktree' });

  // Another workspace starts empty.
  assert.equal(s().workspaceUi['local:/other'], undefined);

  s().forgetWorkspaceUi(id);
  assert.equal(id in s().workspaceUi, false);
});

test('window state: sizes are preferences, clamped, and null hands back the default', () => {
  const store = createAppStore();
  const s = () => store.getState();
  s().setDockWidth(5);
  assert.equal(s().dockWidth, 320);
  s().setDockWidth(100000);
  assert.equal(s().dockWidth, 1000);
  s().setDockWidth(null);
  assert.equal(s().dockWidth, null);
  s().setDockNavWidth(10);
  assert.equal(s().dockNavWidth, 160);
  s().setDockTermHeight(10);
  assert.equal(s().dockTermHeight, 120);
  s().setDockTermMaximized(true);
  assert.equal(s().dockTermMaximized, true);
  s().setDockPane('viewer');
  assert.equal(s().dockPane, 'viewer');
});

test('setDockMode opens the dock; the terminal is never touched by the mode', () => {
  const store = createAppStore();
  const s = () => store.getState();
  s().setDockOpen(false);
  s().setDockTermVisible(false);
  s().setDockMode('git');
  assert.equal(s().dockOpen, true);
  assert.equal(s().dockMode, 'git');
  assert.equal(s().dockTermVisible, false);
});

/* ---------------- shortcuts ---------------- */

function key(k: string, mods: Partial<DockKeyEvent> = {}): DockKeyEvent {
  return { key: k, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...mods };
}

test('the four Dock shortcuts match, and Ctrl+B is not one of them', () => {
  assert.equal(matchDockShortcut(key('D', { shiftKey: true })), 'dock');
  assert.equal(matchDockShortcut(key('E', { shiftKey: true })), 'explorer');
  assert.equal(matchDockShortcut(key('g', { shiftKey: true })), 'git');
  assert.equal(matchDockShortcut(key('`')), 'terminal');
  assert.equal(matchDockShortcut(key('Dead', { code: 'Backquote' })), 'terminal');
  assert.equal(matchDockShortcut(key('D', { shiftKey: true, ctrlKey: false, metaKey: true })), 'dock');
  assert.equal(matchDockShortcut(key('b')), null, 'Ctrl+B stays the right rail');
  assert.equal(matchDockShortcut(key('B', { shiftKey: true })), null);
});

test('shortcuts that are not the Dock\'s are left alone', () => {
  assert.equal(matchDockShortcut(key('d')), null, 'Ctrl+D without Shift');
  assert.equal(matchDockShortcut(key('d', { ctrlKey: false })), null, 'plain typing');
  assert.equal(matchDockShortcut(key('D', { shiftKey: true, ctrlKey: false })), null);
  assert.equal(matchDockShortcut(key('D', { shiftKey: true, altKey: true })), null, 'AltGr is typing');
  assert.equal(matchDockShortcut(key('R', { shiftKey: true })), null, 'a reload key is not ours');
  assert.equal(matchDockShortcut(key('\\', { shiftKey: true })), null, 'the old shell pane keeps Ctrl+Shift+\\');
});

test('shortcut transitions: toggle, mode toggle, terminal fold', () => {
  const closed = { dockOpen: false, dockMode: 'explorer', dockTermVisible: true } as const;
  const open = { dockOpen: true, dockMode: 'explorer', dockTermVisible: true } as const;
  assert.deepEqual(applyDockShortcut(closed, 'dock'), { dockOpen: true });
  assert.deepEqual(applyDockShortcut(open, 'dock'), { dockOpen: false });
  assert.deepEqual(applyDockShortcut(closed, 'git'), { dockOpen: true, dockMode: 'git' });
  assert.deepEqual(applyDockShortcut(open, 'git'), { dockOpen: true, dockMode: 'git' });
  assert.deepEqual(applyDockShortcut(open, 'explorer'), { dockOpen: false }, 'again closes');
  assert.deepEqual(applyDockShortcut(open, 'terminal'), { dockTermVisible: false });
  assert.deepEqual(applyDockShortcut({ ...open, dockTermVisible: false }, 'terminal'), { dockTermVisible: true });
  assert.deepEqual(applyDockShortcut(closed, 'terminal'), { dockOpen: true, dockTermVisible: true });
});

test('runDockShortcut drives the store the same way', () => {
  const store = createAppStore();
  const s = () => store.getState();
  s().setDockOpen(false);
  s().runDockShortcut('git');
  assert.equal(s().dockOpen, true);
  assert.equal(s().dockMode, 'git');
  s().runDockShortcut('git');
  assert.equal(s().dockOpen, false);
  assert.equal(s().dockMode, 'git', 'closing keeps the mode for next time');
});

test('focus routing: only elements inside a data-terminal-focus surface count', () => {
  const inside = { closest: (sel: string) => (sel === '[data-terminal-focus]' ? {} : null) };
  const outside = { closest: () => null };
  assert.equal(focusIsInDockTerminal(inside), true);
  assert.equal(focusIsInDockTerminal(outside), false);
  assert.equal(focusIsInDockTerminal(null), false);
  assert.equal(focusIsInDockTerminal({} as never), false, 'not an element');
});

/* ---------------- capabilities ---------------- */

test('a region is ready only with a workspace and its capability', () => {
  const caps = { files: true, git: false, terminal: true };
  assert.equal(regionState(true, caps, 'files'), 'ready');
  assert.equal(regionState(true, caps, 'git'), 'unsupported');
  assert.equal(regionState(true, undefined, 'files'), 'not-connected');
  assert.equal(regionState(true, null, 'terminal'), 'not-connected');
  assert.equal(regionState(false, caps, 'files'), 'no-workspace');
  assert.equal(regionState(false, undefined, 'files'), 'no-workspace');
});
