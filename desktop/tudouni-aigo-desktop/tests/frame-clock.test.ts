/**
 * The shared frame clock.
 *
 * Its whole reason to exist is that there is **one** loop, not one per paced
 * row, so the assertions are about that: one registration arms one callback, the
 * loop stops when nothing is owed, and every task's simulate runs before any
 * task's write. That last one is the contract a future layout read depends on,
 * and it is invisible in a window where everything happens to be fast.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_FRAME_DT_MS, FrameClock } from '@/frameClock';

/** A document-shaped stub: `FrameClock` resolves its window through it. */
function fakeDocument(): Document {
  return { defaultView: null } as unknown as Document;
}

test('a frame runs every simulate before any write', () => {
  const clock = FrameClock.forDocument(fakeDocument());
  const order: string[] = [];
  clock.register({
    onSimulate: () => {
      order.push('simulate-a');
      return false;
    },
    onWrite: () => order.push('write-a'),
  });
  clock.register({
    onSimulate: () => {
      order.push('simulate-b');
      return false;
    },
    onWrite: () => order.push('write-b'),
  });

  clock.advance(16);
  // Writes batched after all the arithmetic is the whole point of the split: a
  // read between two writes would force the browser to flush layout.
  assert.deepEqual(order, ['simulate-a', 'simulate-b', 'write-a', 'write-b']);
  clock.shutdown();
});

test('a task that reports no work stops the loop', () => {
  const clock = FrameClock.forDocument(fakeDocument());
  clock.register({ onSimulate: () => false });
  assert.equal(clock.advance(16), false);
  clock.shutdown();
});

test('one task with work keeps the frame going for all of them', () => {
  const clock = FrameClock.forDocument(fakeDocument());
  let writes = 0;
  clock.register({ onSimulate: () => false, onWrite: () => (writes += 1) });
  clock.register({ onSimulate: () => true, onWrite: () => (writes += 1) });
  assert.equal(clock.advance(16), true);
  // Both tasks wrote, not only the one that had work: a task whose own state is
  // settled still owns a commit this frame.
  assert.equal(writes, 2);
  clock.shutdown();
});

test('the frame delta is clamped, so a stall cannot compound', () => {
  const clock = FrameClock.forDocument(fakeDocument());
  let seen = 0;
  clock.register({
    onSimulate: (dtMs) => {
      seen = dtMs;
      return false;
    },
  });
  clock.advance(10_000);
  assert.equal(seen, MAX_FRAME_DT_MS);
  // And the floor: a zero-length frame is still a frame.
  clock.advance(0);
  assert.equal(seen, 1);
  clock.shutdown();
});

test('unregistering the last task empties the clock', () => {
  const clock = FrameClock.forDocument(fakeDocument());
  const id = clock.register({ onSimulate: () => true });
  assert.equal(clock.size, 1);
  clock.unregister(id);
  assert.equal(clock.size, 0);
  // Unregistering twice (a cleanup that ran after a shutdown) must not throw.
  clock.unregister(id);
  clock.unregister(null);
  clock.unregister(undefined);
});

test('one document owns one clock', () => {
  const doc = fakeDocument();
  assert.equal(FrameClock.forDocument(doc), FrameClock.forDocument(doc));
  assert.notEqual(FrameClock.forDocument(doc), FrameClock.forDocument(fakeDocument()));
});
