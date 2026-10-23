/**
 * The words this window says about the runtime's own records.
 *
 * These four note types (`context_degraded`, `context_compacted`, `goal_round`,
 * `image_attached`) used to have their English assembled inside the store, which
 * is the one place the project's rule says words may not live: `text` belongs to
 * the runtime, verbatim, or stays `''` for a `FrontMessage`. The reducer now
 * keeps only the facts, and this suite pins the sentences that come back out —
 * including the one thing a naive formatter gets wrong, which is printing a
 * missing figure as `0`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeT } from '@/i18n';
import { frontMessageText } from '@/components/stream/frontMessageText';

const t = makeT();

test('context_degraded names what was squeezed, and omits absent figures', () => {
  assert.equal(
    frontMessageText(t, {
      code: 'contextDegraded',
      items: 12,
      estimated: 1200,
      limit: 800,
      changes: ['history', 'tools'],
    }),
    'Context degraded (12 items · 1200 → 800 tok · history, tools)',
  );

  // No figures at all: the bare sentence, not "0 items".
  assert.equal(
    frontMessageText(t, {
      code: 'contextDegraded',
      items: null,
      estimated: null,
      limit: null,
      changes: [],
    }),
    'Context degraded',
  );

  // Half a measurement is not a measurement: one side missing drops the pair
  // rather than printing "→ 800 tok".
  assert.equal(
    frontMessageText(t, {
      code: 'contextDegraded',
      items: null,
      estimated: null,
      limit: 800,
      changes: [],
    }),
    'Context degraded',
  );
});

test('context_compacted reports the fold and the size it went from and to', () => {
  assert.equal(
    frontMessageText(t, { code: 'contextCompacted', folded: 4, before: 900, after: 400 }),
    'History compacted (4 folded · 900 → 400 tok)',
  );
  assert.equal(
    frontMessageText(t, { code: 'contextCompacted', folded: null, before: null, after: null }),
    'History compacted',
  );
});

test('a goal round keeps its decision, position and progress, and drops what is absent', () => {
  assert.equal(
    frontMessageText(t, {
      code: 'goalRound',
      decision: 'started',
      round: 3,
      rounds: 3,
      maxRounds: 10,
      reason: '',
    }),
    'Goal round started · #3 · 3/10',
  );
  assert.equal(
    frontMessageText(t, {
      code: 'goalRound',
      decision: 'skipped',
      round: null,
      rounds: null,
      maxRounds: null,
      reason: 'no goal',
    }),
    'Goal round skipped · no goal',
  );
  // An event with no decision is still a round, not an empty row.
  assert.equal(
    frontMessageText(t, {
      code: 'goalRound',
      decision: '',
      round: 2,
      rounds: null,
      maxRounds: null,
      reason: '',
    }),
    'Goal round · #2',
  );
});

test('each picture outcome gets its own honest sentence', () => {
  assert.equal(
    frontMessageText(t, {
      code: 'imageAttached',
      name: 'shot.png',
      width: 800,
      height: 600,
    }),
    'Attached shot.png (800×600)',
  );
  // No measurement: the size is omitted, never "0×0".
  assert.equal(
    frontMessageText(t, { code: 'imageAttached', name: 'shot.png', width: null, height: null }),
    'Attached shot.png',
  );

  assert.equal(
    frontMessageText(t, { code: 'imageSkipped', path: 'big.png', reason: 'too large' }),
    'big.png was not attached: too large',
  );
  assert.equal(
    frontMessageText(t, { code: 'imageSkipped', path: 'big.png', reason: '' }),
    'big.png was not attached',
  );

  assert.equal(
    frontMessageText(t, {
      code: 'imageRefused',
      names: ['a.png', 'b.png'],
      model: 'deepseek-chat',
    }),
    'The model in use (deepseek-chat) cannot be shown pictures, so 2 named picture(s) were not attached: a.png, b.png',
  );
  assert.equal(
    frontMessageText(t, { code: 'imageRefused', names: ['a.png'], model: '' }),
    'The model in use cannot be shown pictures, so 1 named picture(s) were not attached: a.png',
  );

  assert.equal(
    frontMessageText(t, {
      code: 'imageOverLimit',
      rest: 4,
      limit: 5,
      paths: ['a.png', 'b.png'],
    }),
    '4 more picture(s) did not fit (limit 5 per message): a.png, b.png',
  );
  assert.equal(
    frontMessageText(t, { code: 'imageOverLimit', rest: 4, limit: 5, paths: [] }),
    '4 more picture(s) did not fit (limit 5 per message)',
  );
  // The runtime always sends both figures today; if it ever stops, the row says
  // what happened instead of inventing "0 more".
  assert.equal(
    frontMessageText(t, { code: 'imageOverLimit', rest: null, limit: null, paths: [] }),
    'Some pictures did not fit in this message.',
  );
});

test('a task whose first prompt never went out says so, and names the task when it has one', () => {
  assert.match(frontMessageText(t, { code: 'handshakeTimeout', seconds: 30, task: null }), /30 seconds/);
  assert.match(frontMessageText(t, { code: 'handshakeTimeout', seconds: 30, task: null }), /this prompt/);

  const named = frontMessageText(t, { code: 'handshakeTimeout', seconds: 30, task: 'Fix the build' });
  assert.match(named, /“Fix the build”/);
  assert.match(named, /30 seconds/);
});
