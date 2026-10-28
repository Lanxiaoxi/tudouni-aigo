/**
 * The effort probe's write-back rules, asserted where they are decided.
 *
 * Every claim here is about a **file write**, and each one is invisible in a
 * window: a save that silently drops a level, a result marked as belonging to a
 * route it did not probe, a sentence that says "the endpoint refused every
 * level" about a run that never got an answer. The functions are pure, so the
 * cases can be constructed instead of staged — which matters, because the ones
 * that go wrong need a rate limit or a second route with one model id, and
 * neither is something a screenshot can arrange.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProbeEffortSnapshot } from '@/protocol/types';
import {
  PROBE_DEADLINE_SECONDS,
  PROBE_RESULT_TTL_SECONDS,
  nothingToSaveReason,
  probeApplies,
  probeResultExpired,
  probeSaveable,
  probeTally,
  saveLevels,
  stillProbing,
  writableLevels,
} from '@/components/panels/effortProbe';

/** A probe of one endpoint with the given rows. */
function snapshot(
  rows: Array<{ level: string; result: string; note?: string }>,
  overrides: Partial<ProbeEffortSnapshot> = {},
): ProbeEffortSnapshot {
  return { model: 'm', provider: 'p', levels: rows, ...overrides };
}

/* ---------------- what a save writes ---------------- */

test('a save keeps the unclear levels, because unclear is not a refusal', () => {
  // The bug this pins: writing only `ok` deleted every `uncertain` level from
  // the file — three levels nobody asked to remove, gone on one click.
  const probe = snapshot([
    { level: 'low', result: 'ok' },
    { level: 'medium', result: 'uncertain', note: 'HTTP 429' },
    { level: 'high', result: 'ok' },
    { level: 'xhigh', result: 'rejected' },
  ]);
  assert.deepEqual(writableLevels(probe), ['low', 'medium', 'high']);
});

test('a save drops exactly the levels the endpoint refused', () => {
  const probe = snapshot([
    { level: 'low', result: 'rejected' },
    { level: 'max', result: 'rejected' },
  ]);
  assert.deepEqual(writableLevels(probe), []);
  assert.equal(nothingToSaveReason(probe), 'all-refused');
});

test('a save keeps every ok level and the unchecked uncertain ones, in probe order', () => {
  const probe = snapshot([
    { level: 'low', result: 'ok' },
    { level: 'medium', result: 'uncertain', note: 'HTTP 429' },
    { level: 'high', result: 'ok' },
    { level: 'xhigh', result: 'uncertain', note: 'HTTP 500' },
    { level: 'max', result: 'rejected' },
  ]);
  // Nothing unchecked: same list as the old "not refused" rule.
  assert.deepEqual(saveLevels(probe, new Set()), ['low', 'medium', 'high', 'xhigh']);
  // Unchecking one uncertain level drops exactly that one — the ok levels
  // are not a checkbox, they are the endpoint's own answer.
  assert.deepEqual(saveLevels(probe, new Set(['xhigh'])), ['low', 'medium', 'high']);
  // A refusal has no box: excluding it changes nothing.
  assert.deepEqual(saveLevels(probe, new Set(['max'])), ['low', 'medium', 'high', 'xhigh']);
  // Order is the probe's order, not a sort.
  assert.deepEqual(saveLevels(probe, new Set(['medium', 'xhigh'])), ['low', 'high']);
  assert.deepEqual(saveLevels(null, new Set()), []);
});

test('no result at all writes nothing', () => {
  assert.deepEqual(writableLevels(null), []);
  assert.equal(nothingToSaveReason(null), null);
  assert.equal(probeSaveable(null), false);
});

test('a save needs one confirmed level, not just a non-refusal', () => {
  // ok + uncertain: writable, and the confirmed level is the one that vouches
  // for the list.
  assert.equal(
    probeSaveable(
      snapshot([
        { level: 'low', result: 'ok' },
        { level: 'high', result: 'uncertain', note: 'HTTP 429' },
      ]),
    ),
    true,
  );
  // Nothing but "we do not know" is not a result: it would write a list no
  // probe vouched for and print it as saved.
  assert.equal(
    probeSaveable(
      snapshot([
        { level: 'low', result: 'uncertain', note: 'HTTP 429' },
        { level: 'high', result: 'uncertain', note: 'HTTP 429' },
      ]),
    ),
    false,
  );
  // Nothing but refusals would empty the list, which is a deletion.
  assert.equal(probeSaveable(snapshot([{ level: 'low', result: 'rejected' }])), false);
});

test('the tally counts each row once, and the total is the row count', () => {
  const probe = snapshot([
    { level: 'a', result: 'ok' },
    { level: 'b', result: 'ok' },
    { level: 'c', result: 'uncertain' },
    { level: 'd', result: 'rejected' },
  ]);
  assert.deepEqual(probeTally(probe), { ok: 2, rejected: 1, uncertain: 1, total: 4 });
  assert.deepEqual(probeTally(null), { ok: 0, rejected: 0, uncertain: 0, total: 0 });
});

/* ---------------- which sentence an empty result earns ---------------- */

test('"refused every level" is only said when every level was refused', () => {
  const allRejected = snapshot([
    { level: 'low', result: 'rejected' },
    { level: 'high', result: 'rejected' },
  ]);
  assert.equal(nothingToSaveReason(allRejected), 'all-refused');

  // The case the old wording got wrong: six limit-hit asks are not a refusal,
  // and telling the person their endpoint refuses everything is the exact lie
  // the three-way reading was built to avoid.
  const allUncertain = snapshot([
    { level: 'low', result: 'uncertain', note: 'HTTP 429' },
    { level: 'high', result: 'uncertain', note: 'HTTP 429' },
  ]);
  assert.equal(nothingToSaveReason(allUncertain), 'no-answer');

  // Something to save: no sentence at all.
  const mixed = snapshot([
    { level: 'low', result: 'ok' },
    { level: 'high', result: 'rejected' },
  ]);
  assert.equal(nothingToSaveReason(mixed), null);

  // And an empty row list is not a verdict about the endpoint either.
  assert.equal(nothingToSaveReason(snapshot([])), null);
});

/* ---------------- which endpoint a result belongs to ---------------- */

test('a result belongs to the route it probed, not to the model id alone', () => {
  // One model id on two routes is ordinary (a primary and a relay). The save
  // writes into `probe.provider`'s entry, so a switch to the other route must
  // not keep showing this result as a match.
  const probe = snapshot([{ level: 'low', result: 'ok' }], { model: 'm', provider: 'relay' });
  assert.equal(probeApplies(probe, { model: 'm', provider: 'relay' }), true);
  assert.equal(probeApplies(probe, { model: 'm', provider: 'primary' }), false);
  assert.equal(probeApplies(probe, { model: 'other', provider: 'relay' }), false);
  assert.equal(probeApplies(null, { model: 'm', provider: 'relay' }), false);
});

/* ---------------- how long the result stays usable ---------------- */

test('a probe that never answers stops reading as running at the deadline', () => {
  const started = 1_000_000;
  const at = (seconds: number) => (started + seconds) * 1000;

  assert.equal(stillProbing(started, false, at(0)), true);
  assert.equal(stillProbing(started, false, at(PROBE_DEADLINE_SECONDS - 1)), true);
  // Past it: the runtime owed a reply and did not send one, and the panel has
  // to say so instead of spinning for ever.
  assert.equal(stillProbing(started, false, at(PROBE_DEADLINE_SECONDS + 1)), false);
  // An answer ends the pass whatever the clock says.
  assert.equal(stillProbing(started, true, at(1)), false);
  // Nothing asked is nothing running.
  assert.equal(stillProbing(null, false, at(0)), false);
});

test('the deadline has room for one ask per offered level', () => {
  // The runtime caps one ask at a minute and offers six levels today, so a
  // deadline below six minutes would call a working probe dead.
  assert.ok(PROBE_DEADLINE_SECONDS >= 6 * 60);
});

test('a result older than the TTL is drawn but cannot be saved', () => {
  const answered = 2_000_000;
  const at = (seconds: number) => (answered + seconds) * 1000;

  assert.equal(probeResultExpired(answered, at(0)), false);
  assert.equal(probeResultExpired(answered, at(PROBE_RESULT_TTL_SECONDS - 1)), false);
  assert.equal(probeResultExpired(answered, at(PROBE_RESULT_TTL_SECONDS + 1)), true);
  // No result means nothing is stale — the panel has its own empty state.
  assert.equal(probeResultExpired(null, at(PROBE_RESULT_TTL_SECONDS * 4)), false);
});

test('the TTL is measured in minutes, not days', () => {
  // `probeEffortAt` exists precisely because a week-old list is not evidence
  // about what an endpoint takes now; a TTL of days would make the field
  // decorative again.
  assert.ok(PROBE_RESULT_TTL_SECONDS <= 60 * 60);
  assert.ok(PROBE_RESULT_TTL_SECONDS >= 60);
});
