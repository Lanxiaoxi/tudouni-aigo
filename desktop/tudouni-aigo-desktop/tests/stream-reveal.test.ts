/**
 * The reveal engine's arithmetic.
 *
 * A pacing curve is the kind of thing that is easy to get roughly right and
 * hard to keep right: every number in it is a feel judgement, so nothing about
 * a wrong one looks wrong in a diff — the reply just types too fast, or lags for
 * a second after a hiccup, and nobody connects the symptom to the constant.
 * These assertions pin the properties that make the feel, not the constants
 * themselves: the curve accelerates with backlog, it never exceeds its ceiling,
 * it always makes progress, and a stall cannot cause a lurch.
 *
 * The cursor's half is asserted at the boundary that actually breaks things —
 * surrogate pairs — because a frame boundary is the one place a UTF-16 index can
 * land inside a character.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_REVEAL_LIMITS,
  REVEAL_BASE_CPS,
  REVEAL_COMPLETION_CHARS_PER_FRAME,
  REVEAL_MAX_CPS,
  REVEAL_MAX_GROWTH_MS,
  REVEAL_MAX_LAG_CODEPOINTS,
  RevealEngine,
  advanceCodePoints,
  countCodePoints,
  revealStep,
} from '@/streamReveal';

/* ============================================================
   revealStep: the pacing curve
   ============================================================ */

test('nothing queued reveals nothing, and keeps no debt', () => {
  assert.deepEqual(revealStep(0, 16, 5), { chars: 0, debt: 0, cps: 0 });
});

/** The exponent above 1 is the whole design: a deeper queue must be cleared
 *  faster, or a hiccup leaves the text permanently behind the wire. */
test('the cadence accelerates superlinearly with backlog', () => {
  const small = revealStep(10, 16, 0);
  const large = revealStep(1000, 16, 0);
  assert.ok(large.cps > small.cps, 'a deep queue must clear faster than a shallow one');
  // Superlinear, not merely monotonic: a 100x backlog more than 100x the rate
  // (before the cap), which is what repays a stall in a fraction of a second.
  assert.ok(large.cps / small.cps > 100 || large.cps === REVEAL_MAX_CPS);
});

test('the cadence never exceeds its ceiling', () => {
  for (const backlog of [1, 10, 100, 5000, 100_000]) {
    assert.ok(revealStep(backlog, 16, 0).cps <= REVEAL_MAX_CPS);
  }
});

/** A frame must always make progress, or a queue drained at a cadence below one
 *  character per frame would never advance: `floor` of a small number is zero. */
test('an ordinary frame reveals at least one character', () => {
  assert.ok(revealStep(1, 16, 0).chars >= 1);
  assert.ok(revealStep(5, 16, 0).chars >= 1);
});

/** The fractional carry is what makes a slow cadence advance at all. Without
 *  it the reader sees nothing for several frames and then one character. */
test('a fraction is carried into the next frame rather than dropped', () => {
  // 1ms at the base cadence is far below one character per frame.
  const first = revealStep(100, 1, 0);
  assert.equal(first.chars, 0);
  assert.ok(first.debt > 0, 'the unused fraction must be kept');

  // Accumulated over enough sub-frame steps, the carry must produce characters.
  let debt = 0;
  let revealed = 0;
  for (let i = 0; i < 60; i += 1) {
    const step = revealStep(100 - revealed, 1, debt);
    revealed += step.chars;
    debt = step.debt;
  }
  assert.ok(revealed > 0, 'carried fractions must eventually reveal text');
});

/** The lag ceiling is the floor under the curve: past it the cursor jumps, so a
 *  pathological queue costs one frame rather than seconds. */
test('a queue deeper than the lag ceiling paints clear of it immediately', () => {
  const backlog = REVEAL_MAX_LAG_CODEPOINTS + 500;
  const step = revealStep(backlog, 16, 0);
  assert.ok(step.chars >= backlog - REVEAL_MAX_LAG_CODEPOINTS);
  assert.equal(step.debt, 0, 'the jump owes the next frame nothing');
});

/** A long frame must not be repaid in one go: the reveal is sized by the frame,
 *  so an unclamped dt is a visible lurch after a stall. */
test('a stalled frame reveals no more than a clamped one', () => {
  const clamped = revealStep(5000, REVEAL_MAX_GROWTH_MS, 0);
  const stalled = revealStep(5000, 5000, 0);
  assert.equal(stalled.chars, clamped.chars);
});

test('the curve reads its limits from the caller', () => {
  const step = revealStep(100, 16, 0, { ...DEFAULT_REVEAL_LIMITS, maxCps: REVEAL_BASE_CPS });
  assert.equal(step.cps, REVEAL_BASE_CPS);
});

/* ============================================================
   code points: the cursor's unit
   ============================================================ */

test('code points count a surrogate pair as one character', () => {
  assert.equal(countCodePoints('abc'), 3);
  assert.equal(countCodePoints('中文'), 2);
  // A single emoji outside the BMP is two UTF-16 units, one character.
  assert.equal(countCodePoints('\u{1F600}'), 1);
  assert.equal(countCodePoints('a\u{1F600}b'), 3);
});

test('advancing by code points never splits a surrogate pair', () => {
  const text = 'a\u{1F600}b';
  // One character from offset 1 must consume both halves of the pair.
  assert.deepEqual(advanceCodePoints(text, 1, 1), { offset: 3, consumed: 1 });
  assert.deepEqual(advanceCodePoints(text, 1, 2), { offset: 4, consumed: 2 });
});

test('advancing past the end stops at the end', () => {
  assert.deepEqual(advanceCodePoints('ab', 0, 10), { offset: 2, consumed: 2 });
  assert.deepEqual(advanceCodePoints('ab', 5, 1), { offset: 2, consumed: 0 });
});

/* ============================================================
   RevealEngine: the cursor
   ============================================================ */

test('the first push is primed, not typed out', () => {
  const e = new RevealEngine();
  e.push('hello', true);
  // The row was created *by* this chunk; replaying it from zero would wipe and
  // retype a paragraph that had already arrived.
  assert.equal(e.displayed, 'hello');
  assert.equal(e.pending, false);
});

test('a later append is queued rather than shown', () => {
  const e = new RevealEngine();
  e.push('hello', true);
  e.push('hello world', true);
  assert.equal(e.displayed, 'hello');
  assert.equal(e.pending, true);
});

test('frames advance the cursor and it converges on the full text', () => {
  const e = new RevealEngine();
  e.push('', true);
  e.push('x'.repeat(500), true);
  assert.equal(e.displayed, '');
  for (let i = 0; i < 600 && e.pending; i += 1) e.step(16);
  assert.equal(e.displayed, 'x'.repeat(500));
  assert.equal(e.pending, false);
});

test('a replacement drops the cursor and shows the new body at once', () => {
  const e = new RevealEngine();
  e.push('hello', true);
  e.push('hello world', true);
  // A `delta_reset` rebuilds the entry; the text no longer starts with what the
  // cursor counted, so nothing about the cursor is still true.
  e.push('something else entirely', true);
  assert.equal(e.displayed, 'something else entirely');
  assert.equal(e.pending, false);
});

test('ending the stream drains the tail instead of snapping it', () => {
  const e = new RevealEngine();
  e.push('a'.repeat(100), true);
  e.push('a'.repeat(1000), true);
  e.push('a'.repeat(1000), false);
  // The tail is still owed, and the drain is capped per frame rather than
  // committed in one teleport.
  assert.equal(e.displayed, 'a'.repeat(100));
  e.step(16);
  assert.ok(e.displayed.length > 100);
  assert.ok(
    e.displayed.length < 1000,
    'a finished stream must not reveal its whole tail in one frame',
  );
  for (let i = 0; i < 20 && e.pending; i += 1) e.step(16);
  assert.equal(e.displayed.length, 1000);
  assert.ok(REVEAL_COMPLETION_CHARS_PER_FRAME > 0);
});

/** Going non-live must not snap. This is the case the drain exists for, and a
 *  snap here is how a reply ends one sentence short of what the model said. */
test('going non-live keeps the tail owed rather than discarding it', () => {
  const e = new RevealEngine();
  e.push('a'.repeat(100), true);
  e.push('a'.repeat(500), true);
  e.push('a'.repeat(500), false);
  assert.ok(e.pending, 'the tail is still owed after the stream ends');
});

test('the cursor stays on character boundaries', () => {
  const e = new RevealEngine();
  const text = '\u{1F600}'.repeat(200);
  e.push('', true);
  e.push(text, true);
  for (let i = 0; i < 200 && e.pending; i += 1) {
    e.step(16);
    // Every intermediate frame is a whole number of emoji: cutting a pair in
    // half paints a replacement glyph for one frame.
    assert.equal(countCodePoints(e.displayed), e.displayed.length / 2);
  }
});

test('snap shows everything and stops pacing', () => {
  const e = new RevealEngine();
  e.push('a'.repeat(10), true);
  e.push('a'.repeat(900), true);
  e.snap('done', false);
  assert.equal(e.displayed, 'done');
  assert.equal(e.pending, false);
});
