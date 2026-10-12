import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tokPerSecond } from '@/utils/format';
import { reduceEvent, type Entry, type LooseEvent } from '@/state/entries';
import { streamBlocks, type StreamRow } from '@/streamBlocks';

/* ============================================================
   tokPerSecond
   ============================================================ */

test('190 tokens in 5s is 38.0 tok/s', () => {
  assert.equal(tokPerSecond(190, 5000), '38.0');
});

test('a hundred and above drops the decimal: the endpoint is not stable to it', () => {
  assert.equal(tokPerSecond(200, 1000), '200');
  assert.equal(tokPerSecond(1500, 1000), '1500');
});

test('just below a hundred keeps it', () => {
  assert.equal(tokPerSecond(99, 1000), '99.0');
});

/** No measurement is never zero. `0.0 tok/s` reads as a claim the ledger
 *  cannot make: a tool-only call reports no completion tokens, a failed
 *  attempt carries no duration, and both must render as "no figure", the
 *  same rule the reference front end follows (`OutputRateText`). */
test('a missing half is no measurement, not zero', () => {
  assert.equal(tokPerSecond(null, 5000), null);
  assert.equal(tokPerSecond(190, null), null);
  assert.equal(tokPerSecond(0, 5000), null);
  assert.equal(tokPerSecond(190, 0), null);
});

/* ============================================================
   the figure reaches the two places that draw it
   ============================================================ */

function freshOptions(overrides: Partial<Parameters<typeof reduceEvent>[2]> = {}) {
  return {
    activeRunId: 'r1' as string | null,
    lastRunId: null as string | null,
    lookup: () => ({ risk: 'low' as const, parallelSafe: false, interactive: false, external: false }),
    maxSteps: 120,
    ...overrides,
  };
}

function ev(kind: string, extra: Record<string, unknown> = {}): LooseEvent {
  return {
    v: 1,
    t: 'event',
    kind,
    session_id: 's-1',
    run_id: 'r1',
    step: 0,
    ts: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

function rowsOf(entries: Entry[]): StreamRow[] {
  return entries.map((e) => ({ kind: 'entry' as const, key: e.id, entry: e }));
}

test('the call row carries the completion count beside the duration', () => {
  let entries: Entry[] = [];
  entries = reduceEvent(entries, ev('run_started', {}), freshOptions({ activeRunId: null })).entries;
  const result = reduceEvent(
    entries,
    ev('model_call', {
      status: 'ok',
      step: 0,
      duration_ms: 5000,
      prompt_tokens: 1000,
      completion_tokens: 190,
    }),
    freshOptions(),
  );
  entries = result.entries;

  const row = entries.find((e) => e.kind === 'model') as Extract<Entry, { kind: 'model' }>;
  assert.equal(row.completionTokens, 190);
  assert.equal(row.durationMs, 5000);
  assert.equal(tokPerSecond(row.completionTokens, row.durationMs), '38.0');
  // The live record the status bar reads carries the same pair.
  assert.ok(result.lastCall);
  assert.equal(result.lastCall.completionTokens, 190);
  assert.equal(result.lastCall.durationMs, 5000);
});

test('a call that reports no usage clears the count, it does not keep the last one', () => {
  let entries: Entry[] = [];
  entries = reduceEvent(entries, ev('run_started', {}), freshOptions({ activeRunId: null })).entries;
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 0, duration_ms: 5000, completion_tokens: 190 }),
    freshOptions(),
  ).entries;
  // A second call with no usage block at all — the "clear the record" rule.
  const result = reduceEvent(entries, ev('model_call', { status: 'ok', step: 1 }), freshOptions());
  entries = result.entries;

  const rows = entries.filter((e) => e.kind === 'model') as Extract<Entry, { kind: 'model' }>[];
  assert.equal(rows[1].completionTokens, null);
  assert.equal(rows[1].durationMs, null);
  assert.equal(tokPerSecond(rows[1].completionTokens, rows[1].durationMs), null);
  assert.equal(tokPerSecond(result.lastCall!.completionTokens, result.lastCall!.durationMs), null);
});

test('a step block settles its metrics with the completion count', () => {
  let entries: Entry[] = [];
  entries = reduceEvent(entries, ev('run_started', {}), freshOptions({ activeRunId: null })).entries;
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 0, duration_ms: 5000, completion_tokens: 190 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_call', { step: 0, tool_index: 0, tool: 'grep', call_id: 'c1', arguments: '{}' }),
    freshOptions(),
  ).entries;

  const blocks = streamBlocks(rowsOf(entries));
  const step = blocks.find((block) => block.kind === 'step');
  assert.ok(step && step.kind === 'step');
  assert.equal(step.metrics.durationMs, 5000);
  assert.equal(step.metrics.completionTokens, 190);
  assert.equal(tokPerSecond(step.metrics.completionTokens, step.metrics.durationMs), '38.0');
});
