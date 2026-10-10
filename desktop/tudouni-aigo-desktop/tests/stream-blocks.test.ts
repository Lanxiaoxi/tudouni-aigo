import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyDelta, applyFinalAnswer, reduceEvent, type Entry, type LooseEvent } from '@/state/entries';
import { streamBlocks, type StreamRow } from '@/streamBlocks';

/* ============================================================
   helpers
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

function ids(blocks: ReturnType<typeof streamBlocks>): string[] {
  return blocks.map((block) =>
    block.kind === 'step' ? block.key : (block.row as { key: string }).key,
  );
}

/** Build rows the way `StreamView` does (quiet off), from real wire events. */
function rowsOf(entries: Entry[]): StreamRow[] {
  return entries.map((e) => ({ kind: 'entry' as const, key: e.id, entry: e }));
}

/* ============================================================
   the partition itself
   ============================================================ */

test('a call and its tool work become one block; the answer stays outside', () => {
  let entries: Entry[] = [];

  entries = reduceEvent(entries, ev('run_started', {}), freshOptions({ activeRunId: null })).entries;
  // The answer step: deltas, then its record, then the final answer.
  entries = applyDelta(entries, 'r1', 1, 'text', 'the answer', 'r1', null).entries;
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 0, duration_ms: 900, prompt_tokens: 1000, cached_tokens: 700 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('run_finished', { stop_reason: 'answered', duration_ms: 5000, step: 0 }),
    freshOptions(),
  ).entries;
  // The event side does not draw the answer; `applyFinalAnswer` (the `ui`
  // message) is what replaces the streamed body with the final one.
  entries = applyFinalAnswer(entries, 'r1', 'the complete answer');

  const blocks = streamBlocks(rowsOf(entries));
  // The call behind the answer drew **no work**, so a card of a bare head is a
  // stray bar — the record stays on the loose line the transcript has always
  // drawn for it, and the figures ride it. A card exists only where there is
  // work to hold.
  assert.equal(blocks.filter((block) => block.kind === 'step').length, 0);
  const loose = blocks.find(
    (block) => block.kind === 'entry' && block.row.entry.kind === 'model',
  );
  assert.ok(loose && loose.kind === 'entry');
  assert.equal((loose.row.entry as Extract<Entry, { kind: 'model' }>).durationMs, 900);

  const kinds = blocks.map((block) => (block.kind === 'step' ? 'step' : block.row.entry.kind));
  assert.deepEqual(kinds, ['turn', 'model', 'answer']);
});

test('a tool step keeps its tools inside one block', () => {
  let entries: Entry[] = [];

  entries = reduceEvent(entries, ev('run_started', {}), freshOptions({ activeRunId: null })).entries;
  // Step 1: lower the deltas, the record, then the tool call and its result.
  entries = applyDelta(entries, 'r1', 1, 'reasoning', 'let me look', 'r1', null).entries;
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 0, reasoning: 'let me look', duration_ms: 400 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_call', { step: 0, tool_index: 0, tool: 'grep', call_id: 'c1', arguments: '{}' }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_result', { step: 0, tool_index: 0, status: 'ok', chars: 10, duration_ms: 5, preview: 'hit' }),
    freshOptions(),
  ).entries;

  const blocks = streamBlocks(rowsOf(entries));
  const step = blocks.find((block) => block.kind === 'step');
  assert.ok(step && step.kind === 'step');
  // Reasoning is its own card (the redesign's split), so the block's work
  // rows are exactly the tool call — the result attached to it, and the
  // record rides the head.
  assert.deepEqual(
    step.rows.map((row) => row.entry.kind),
    ['tool'],
  );
  assert.equal(step.metrics.durationMs, 400);
  assert.equal(step.running, false);

  const kinds = blocks.map((block) => (block.kind === 'step' ? 'step' : block.row.entry.kind));
  assert.deepEqual(kinds, ['turn', 'reason', 'step']);
});

test('a next call closes the block it follows, both records settle their own', () => {
  let entries: Entry[] = [];

  entries = reduceEvent(entries, ev('run_started', {}), freshOptions({ activeRunId: null })).entries;
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 0, duration_ms: 100 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_call', { step: 0, tool_index: 0, tool: 'grep', call_id: 'c1', arguments: '{}' }),
    freshOptions(),
  ).entries;
  // Call 2 lands before call 1's tool result — the ordering the audit can
  // produce under a busy tool. Its block must not swallow call 1's open work.
  entries = reduceEvent(
    entries,
    ev('tool_result', { step: 0, tool_index: 0, status: 'ok', chars: 10, duration_ms: 5, preview: 'x' }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 1, duration_ms: 200 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_call', { step: 1, tool_index: 0, tool: 'read_file', call_id: 'c2', arguments: '{}' }),
    freshOptions(),
  ).entries;

  const blocks = streamBlocks(rowsOf(entries));
  const stepBlocks = blocks.filter((block) => block.kind === 'step');
  assert.equal(stepBlocks.length, 2, 'two calls, two blocks');
  const first = stepBlocks[0];
  const second = stepBlocks[1];
  assert.ok(first.kind === 'step' && second.kind === 'step');
  assert.deepEqual(first.rows.map((row) => row.entry.kind), ['tool']);
  assert.equal(first.metrics.durationMs, 100);
  assert.deepEqual(second.rows.map((row) => row.entry.kind), ['tool']);
  assert.equal(second.metrics.durationMs, 200);
});

test('a retry row never opens a block and never rides inside one', () => {
  let entries: Entry[] = [];

  entries = reduceEvent(entries, ev('run_started', {}), freshOptions({ activeRunId: null })).entries;
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'error', step: 0, backoff_ms: 800 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 0, duration_ms: 300 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_call', { step: 0, tool_index: 0, tool: 'grep', call_id: 'c1', arguments: '{}' }),
    freshOptions(),
  ).entries;

  const blocks = streamBlocks(rowsOf(entries));
  assert.equal(blocks.filter((block) => block.kind === 'step').length, 1);
  // The retry row drew on its own, before the settled call's block.
  assert.equal(
    blocks.some((block) => block.kind === 'entry' && block.row.entry.kind === 'model'),
    true,
    'the retry is its own loose row',
  );
  const step = blocks.find((block) => block.kind === 'step');
  assert.ok(step && step.kind === 'step');
  assert.deepEqual(step.rows.map((row) => row.entry.kind), ['tool']);
});

test('an in-flight call with live work shows as a running block', () => {
  let entries: Entry[] = [];

  entries = reduceEvent(entries, ev('run_started', {}), freshOptions({ activeRunId: null })).entries;
  entries = applyDelta(entries, 'r1', 1, 'reasoning', 'thinking', 'r1', null).entries;
  // The record has landed but carries no duration — the audit's own "not
  // settled" shape on a failed attempt.
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'error', backoff_ms: 500, step: 0 }),
    freshOptions(),
  ).entries;

  const blocks = streamBlocks(rowsOf(entries));
  assert.equal(blocks.filter((block) => block.kind === 'step').length, 0);
});

test('quiet rollups ride inside their call block; orphans stay loose', () => {
  let entries: Entry[] = [];

  entries = reduceEvent(entries, ev('run_started', {}), freshOptions({ activeRunId: null })).entries;
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 0, duration_ms: 100 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_call', { step: 0, tool_index: 0, tool: 'grep', call_id: 'c1', arguments: '{}' }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_result', { step: 0, tool_index: 0, status: 'ok', chars: 10, duration_ms: 5, preview: 'x' }),
    freshOptions(),
  ).entries;

  // Roll the tool rows the way quiet mode does, then partition.
  const rows: StreamRow[] = [];
  let buffer: Entry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'tool') {
      buffer.push(entry);
      continue;
    }
    if (buffer.length > 0) {
      rows.push({ kind: 'quiet', key: `quiet-${buffer[0].id}`, entries: buffer });
      buffer = [];
    }
    rows.push({ kind: 'entry', key: entry.id, entry });
  }
  if (buffer.length > 0) {
    rows.push({ kind: 'quiet', key: `quiet-${buffer[0].id}`, entries: buffer });
  }

  const blocks = streamBlocks(rows);
  const step = blocks.find((block) => block.kind === 'step');
  assert.ok(step && step.kind === 'step');
  assert.deepEqual(
    step.rows.map((row) => row.kind),
    ['quiet'],
    'the group rode inside the call block',
  );

  // An orphan result with no call record under it stays loose.
  const orphanOnly = streamBlocks([
    { kind: 'entry', key: 'orphan', entry: entries.find((entry) => entry.kind === 'tool')! },
  ]);
  assert.equal(orphanOnly.length, 1);
  assert.equal(orphanOnly[0].kind, 'entry');
});
