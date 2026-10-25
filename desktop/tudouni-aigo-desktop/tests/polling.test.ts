/**
 * The poll loop's own arithmetic, with the clock in hand.
 *
 * The loop used to check the throttle floor where the snapshot lands. That
 * check can never pass: the landing that answers a poll arrives a few dozen
 * milliseconds after the send, so the floor was always unexpired there, and
 * nothing else ever called again — the loop died after one iteration, and a
 * job or a delegation running in a quiet session (no tool results, no turn
 * boundary) sat on a frozen `seconds` figure for its whole life. These tests
 * hold the loop to what it claims: a landing only books, a timer sends, the
 * cadence is the floor, the give-up stops a static situation, and a change
 * restarts it.
 *
 * Everything here runs on mocked timers and a mocked `Date`, so the loop is
 * exercised exactly as it fires — the send is never called for free.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  forgetPolling,
  noteOutstanding,
  pollNow,
  wakePolling,
  POLL_FLOOR_MS,
} from '@/state/polling';

/** A time safely past the epoch, so a `lastPollAt` of 0 reads as "long ago"
 *  and the first booking fires immediately — the shape real time has. */
const T0 = 10_000;

function harness() {
  let sends = 0;
  return {
    get sends() {
      return sends;
    },
    send: () => {
      sends += 1;
    },
  };
}

test('a landing books, never sends; the loop then keeps the floor cadence on its own', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(T0);
  const h = harness();

  // The turn-end snapshot reveals a running job. The landing itself must not
  // send: the data on screen is the snapshot's own, and the poll exists for
  // the moment after it.
  noteOutstanding('loop', 'job:j:running:12', h.send);
  assert.equal(h.sends, 0);

  // The floor has long expired, so the first booking fires at once.
  t.mock.timers.tick(1);
  assert.equal(h.sends, 1);

  // Ten seconds of a quiet session: each answer lands ~30ms after its send
  // and advances the seconds (a changed key), which is what keeps the loop
  // alive. One send per floor interval, with no external event in between.
  for (let seconds = 13; seconds <= 22; seconds += 1) {
    t.mock.timers.tick(30);
    noteOutstanding('loop', `job:j:running:${seconds}`, h.send);
    t.mock.timers.tick(POLL_FLOOR_MS);
  }
  assert.equal(h.sends, 11);
  forgetPolling('loop');
});

test('dense external snapshots do not multiply the sends — the cadence stays at the floor', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(T0);
  const h = harness();

  // A busy turn: a tool-result snapshot every 100ms for ten seconds, each
  // carrying a fresh `seconds`. A hundred landings must not mean a hundred
  // requests — the pending booking is kept, not re-armed.
  for (let i = 0; i < 100; i += 1) {
    t.mock.timers.tick(100);
    noteOutstanding('dense', `job:j:running:${12 + i}`, h.send);
  }
  // One send right away (the floor had expired), then one per floor interval:
  // 10s of cadence is five more, with slack for the exact fire instants.
  assert.ok(h.sends >= 5 && h.sends <= 7, `expected ~6 sends over 10s, got ${h.sends}`);
  forgetPolling('dense');
});

test('five identical answers stop the polling; a changed key restarts it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(T0);
  const h = harness();

  noteOutstanding('giveup', 'job:j:uncollected:44', h.send);
  t.mock.timers.tick(1);
  // The answer never changes — an uncollected job's seconds are frozen — so
  // the streak deepens on every send until the give-up stops the loop.
  for (let i = 0; i < 10; i += 1) {
    t.mock.timers.tick(30);
    noteOutstanding('giveup', 'job:j:uncollected:44', h.send);
    t.mock.timers.tick(POLL_FLOOR_MS);
  }
  assert.equal(h.sends, 5, 'the give-up must stop the loop after five identical answers');

  // A real change — the person collected the job and a new one appeared —
  // resets the streak, and the next send is booked for immediately.
  noteOutstanding('giveup', 'job:j2:running:1', h.send);
  assert.equal(h.sends, 5);
  t.mock.timers.tick(1);
  assert.equal(h.sends, 6);
  forgetPolling('giveup');
});

test('an empty outstanding set cancels the booking', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(T0);
  const h = harness();

  noteOutstanding('empty', 'job:j:running:3', h.send);
  noteOutstanding('empty', '', h.send);
  t.mock.timers.tick(POLL_FLOOR_MS * 2);
  assert.equal(h.sends, 0, 'nothing outstanding, nothing to keep fresh');

  // And the loop is re-armable: work appearing again books a fresh send.
  noteOutstanding('empty', 'job:j:running:4', h.send);
  t.mock.timers.tick(1);
  assert.equal(h.sends, 1);
  forgetPolling('empty');
});

test('forgetPolling drops the booking with the session', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(T0);
  const h = harness();

  noteOutstanding('gone', 'job:j:running:3', h.send);
  forgetPolling('gone');
  t.mock.timers.tick(POLL_FLOOR_MS * 2);
  assert.equal(h.sends, 0, 'a closed session must not be polled');

  // The state is really gone: the key behaves as a fresh session afterwards.
  noteOutstanding('gone', 'job:j:running:4', h.send);
  t.mock.timers.tick(1);
  assert.equal(h.sends, 1);
  forgetPolling('gone');
});

test('pollNow is the manual nudge: floor-checked, give-up-blind', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(T0);
  const h = harness();

  // A burst of asks is one send: the floor still applies to the manual path.
  pollNow('nudge', h.send);
  pollNow('nudge', h.send);
  pollNow('nudge', h.send);
  assert.equal(h.sends, 1);
  t.mock.timers.tick(POLL_FLOOR_MS);
  pollNow('nudge', h.send);
  assert.equal(h.sends, 2);
  forgetPolling('nudge');
});

test('wakePolling lifts the give-up, and the next landing sends right away', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(T0);
  const h = harness();

  noteOutstanding('wake', 'job:j:uncollected:9', h.send);
  t.mock.timers.tick(1);
  for (let i = 0; i < 10; i += 1) {
    t.mock.timers.tick(30);
    noteOutstanding('wake', 'job:j:uncollected:9', h.send);
    t.mock.timers.tick(POLL_FLOOR_MS);
  }
  assert.equal(h.sends, 5);

  // A turn just ended: the wake clears the backoff, so even a key that has
  // not changed is polled again the moment its next snapshot lands.
  wakePolling('wake');
  noteOutstanding('wake', 'job:j:uncollected:9', h.send);
  assert.equal(h.sends, 5);
  t.mock.timers.tick(1);
  assert.equal(h.sends, 6);
  forgetPolling('wake');
});
