/**
 * The Explorer's file-choosing state (design 5.4: the composer's "attach file"
 * entry opens the Explorer in a selection state) and the path conversion the
 * deliverable cards use to open a file in it.
 *
 * Both are invisible when wrong: a pick flag that survives closing the dock
 * makes the next ordinary click attach a file nobody asked for, and a path
 * prefix test that ignores case or separators sends a workspace file to the OS
 * instead of the Explorer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAppStore } from '@/state/store';
import { workspaceRelativePath } from '@/state/workspaceDock/relPath';

function fresh() {
  const store = createAppStore();
  store.setState({ dockOpen: false, dockMode: 'git', dockPick: null });
  return store;
}

/* ---------------- the pick flag ---------------- */

test('starting a pick opens the dock on the Explorer, on its navigator half', () => {
  const store = fresh();
  store.setState({ dockPane: 'viewer' });
  store.getState().startDockPick('attach');
  const s = store.getState();
  assert.equal(s.dockPick, 'attach');
  assert.equal(s.dockOpen, true);
  assert.equal(s.dockMode, 'explorer');
  assert.equal(s.dockPane, 'navigator', 'the choice is made in the navigator');
});

test('finishing hands the pending choice back exactly once', () => {
  const store = fresh();
  store.getState().startDockPick('attach');
  assert.equal(store.getState().finishDockPick(), 'attach');
  assert.equal(store.getState().dockPick, null);
  assert.equal(store.getState().finishDockPick(), null, 'a second click is an ordinary selection');
});

test('cancelling clears it and leaves the dock open', () => {
  const store = fresh();
  store.getState().startDockPick('attach');
  store.getState().cancelDockPick();
  assert.equal(store.getState().dockPick, null);
  assert.equal(store.getState().dockOpen, true);
});

test('anything that takes the Explorer away abandons the pick', () => {
  const closers: [string, (s: ReturnType<typeof fresh>) => void][] = [
    ['close', (st) => st.getState().setDockOpen(false)],
    ['toggle', (st) => st.getState().toggleDock()],
    ['switch to Git', (st) => st.getState().setDockMode('git')],
    ['shortcut that closes', (st) => st.getState().runDockShortcut('explorer')],
    ['shortcut to Git', (st) => st.getState().runDockShortcut('git')],
    ['shortcut that toggles the dock', (st) => st.getState().runDockShortcut('dock')],
  ];
  for (const [what, act] of closers) {
    const store = fresh();
    store.getState().startDockPick('attach');
    act(store);
    assert.equal(store.getState().dockPick, null, `${what} must cancel the pick`);
  }
});

test('things that leave the Explorer on screen keep the pick', () => {
  const store = fresh();
  store.getState().startDockPick('attach');
  store.getState().setDockMode('explorer');
  store.getState().runDockShortcut('terminal'); // folds/unfolds the terminal area only
  store.getState().setDockTermVisible(false);
  assert.equal(store.getState().dockPick, 'attach');
});

test('the pick is window state that is never persisted', () => {
  const store = fresh();
  store.getState().startDockPick('attach');
  const raw = typeof localStorage === 'undefined' ? '' : (localStorage.getItem('aigo.prefs') ?? '');
  assert.equal(raw.includes('dockPick'), false);
});

/* ---------------- workspaceRelativePath ---------------- */

test('a relative path is normalised and kept relative', () => {
  assert.equal(workspaceRelativePath('docs/a.md', 'C:/w'), 'docs/a.md');
  assert.equal(workspaceRelativePath('./docs//a.md', 'C:/w'), 'docs/a.md');
  assert.equal(workspaceRelativePath('docs\\a.md', 'C:/w'), 'docs/a.md');
  assert.equal(workspaceRelativePath('docs/x/../a.md', 'C:/w'), 'docs/a.md');
});

test('an absolute path inside the root is made relative, case and separators aside', () => {
  assert.equal(workspaceRelativePath('C:\\Work\\App\\out\\r.html', 'c:/work/app'), 'out/r.html');
  assert.equal(workspaceRelativePath('c:/work/app/out/r.html', 'C:\\Work\\App\\'), 'out/r.html');
  assert.equal(workspaceRelativePath('/srv/app/src/main.go', '/srv/app'), 'src/main.go');
});

test('outside the workspace answers null', () => {
  assert.equal(workspaceRelativePath('C:\\elsewhere\\x.docx', 'C:/work/app'), null);
  assert.equal(workspaceRelativePath('../escape.md', 'C:/work/app'), null);
  assert.equal(workspaceRelativePath('docs/../../escape.md', 'C:/work/app'), null);
  // A sibling that merely shares the prefix is not inside it.
  assert.equal(workspaceRelativePath('C:/work/app2/x.md', 'C:/work/app'), null);
  assert.equal(workspaceRelativePath('/etc/passwd', '/srv/app'), null);
});

test('the root itself and blanks are not files to show', () => {
  assert.equal(workspaceRelativePath('C:/work/app', 'C:/work/app'), null);
  assert.equal(workspaceRelativePath('', 'C:/work/app'), null);
  assert.equal(workspaceRelativePath('   ', 'C:/work/app'), null);
  assert.equal(workspaceRelativePath('.', 'C:/work/app'), null);
});
