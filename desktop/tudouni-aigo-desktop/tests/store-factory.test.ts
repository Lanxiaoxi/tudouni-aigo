/**
 * The factory seam.
 *
 * `store.ts` used to export one store created at module load, and nothing could
 * make a second one: every test that wanted a fresh state had to snapshot and
 * restore the singleton by hand. `createAppStore()` is that seam.
 *
 * These are deliberately small assertions: the point is not to re-test the
 * store's behaviour (the projection suite does that), it is that two stores are
 * two stores, and a fresh one starts in the state the app starts in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppStore } from '@/state/store';

test('two factories make two independent stores', () => {
  const a = createAppStore();
  const b = createAppStore();

  a.setState({ userName: 'a' });

  assert.equal(a.getState().userName, 'a');
  assert.equal(b.getState().userName, '', 'the second store must not see the first one');
});

test('a fresh store has the app\'s initial shape and its actions', () => {
  const s = createAppStore().getState();

  assert.equal(s.activeKey, null);
  assert.deepEqual(s.sessions, {});
  assert.deepEqual(s.pendingModals, []);
  assert.equal(typeof s.send, 'function');
  assert.equal(typeof s.attachSession, 'function');
  assert.equal(typeof s.applyRuntimeMessage, 'function');
});
