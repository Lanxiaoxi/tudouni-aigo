/**
 * The turn rail's rules: which marks exist, what they are called, and which one
 * the reader is in.
 *
 * The drawing half is `components/stream/TurnRail.tsx`; this suite drives the
 * pure half (`src/turnRail.ts`), because every defect worth guarding against
 * here is a *rule* that cannot be seen in a rendered string:
 *
 *   - **the prompt sits above its turn head, not inside it.** `submitDraft`
 *     appends the `user` echo and only then sends the message that produces
 *     `run_started`, so a rail that read "the first user row in this turn's span"
 *     would show an empty card on every single turn — and it would look right,
 *     because the mark is still there and still navigable.
 *   - **a restored transcript has no turn heads at all.** `session_load` rebuilds
 *     from the session's own `{role, content}` message list, which carries no turn
 *     boundary, so `store.ts` emits `user` and `answer` rows only. Without the
 *     pairing rule the rail would be empty for every session a person reopened —
 *     the exact sessions that need navigating.
 *   - **a turn can answer more than once.** A steering message produces a second
 *     assistant message, so "the answer" is the **last** one in the span.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeMark,
  HEADING_BAND_PX,
  LANDING_PX,
  MIN_RAIL_TURNS,
  preview,
  PROMPT_LIMIT,
  RESPONSE_LIMIT,
  turnRail,
} from '@/turnRail';
import type { Entry } from '@/state/entries';

/* ---------------- builders ---------------- */

let seq = 0;
const next = (prefix: string) => `${prefix}-${(seq += 1)}`;

function head(runId: string, status = 'running'): Entry {
  return {
    kind: 'turn',
    id: `head-${runId}`,
    runId,
    ordinal: 0,
    step: 1,
    maxSteps: 120,
    status,
    startedAt: 0,
  };
}

function user(text: string, id?: string): Entry {
  return { kind: 'user', id: id ?? next('user'), text, atMs: 0 };
}

function answer(text: string, runId = 'r'): Entry {
  return { kind: 'answer', id: next('answer'), runId, text };
}

/** A model step and a tool row: rows that must contribute no marks. */
function noise(runId = 'r'): Entry[] {
  return [
    {
      kind: 'model',
      id: next('model'),
      runId,
      step: 1,
      durationMs: 900,
      inputTokens: 1000,
      cachedTokens: 700,
      retry: null,
    },
    {
      kind: 'tool',
      id: next('tool'),
      runId,
      step: 1,
      index: 0,
      callId: 'c1',
      tool: 'shell',
      arguments: '{"command":"ls"}',
      risk: 'low',
      parallelSafe: true,
      interactive: false,
      external: false,
      result: null,
    },
  ];
}

/* ============================================================
   A live session
   ============================================================ */

test('the mark takes its prompt from the echo above the head, not from inside the turn', () => {
  // The ordering `submitDraft` produces: the echo, then the head.
  const entries = [user('what is in this repo?'), head('r-1')];

  const turns = turnRail(entries);

  assert.equal(turns.length, 1);
  assert.equal(
    turns[0]?.prompt,
    'what is in this repo?',
    'the prompt was read from inside the turn, where the echo does not live',
  );
  assert.equal(turns[0]?.anchor, 'head-r-1', 'a live turn is anchored on its head');
  assert.equal(turns[0]?.turn, 1);
});

test('a turn in flight has no response preview yet', () => {
  // The answer arrives with `ui(run_finished)`, so anything shown before it would
  // be invented. The head is still `running` here.
  const entries = [user('go'), head('r-1', 'running'), ...noise('r-1')];

  const turns = turnRail(entries);

  assert.equal(turns[0]?.response, '');
  assert.equal(turns[0]?.running, true, 'the rail must agree with the head about "in flight"');
});

test('a settled turn stops running and carries its answer', () => {
  const entries = [user('go'), head('r-1', 'answered'), ...noise('r-1'), answer('Done.')];

  const turns = turnRail(entries);

  assert.equal(turns[0]?.running, false);
  assert.equal(turns[0]?.response, 'Done.');
});

test('a duplicated answer for one turn keeps the last', () => {
  // `applyFinalAnswer` appends a fresh `answer` row every time it is called with a
  // non-empty answer, and it is called from a `run_finished` path whose two
  // messages are explicitly not ordered (`entries.ts`). So "the response" is the
  // last one, which is also the only rule that stays right if that ever happens.
  const entries = [user('go'), head('r-1', 'answered'), answer('Draft.'), answer('Final.')];

  assert.equal(turnRail(entries)[0]?.response, 'Final.');
});

test('a user row inside an open turn becomes its own mark rather than being swallowed', () => {
  // The composer cannot produce this — while a turn runs its button is interrupt,
  // not send (`Composer.tsx`), so this build has no steering. The case is asserted
  // anyway because it is what a steering message *would* look like, and because
  // the same shape does occur for real: a stored prompt whose reply never arrived,
  // sitting above a later turn. Either way it must be navigable, and it must not
  // steal the previous turn's answer.
  const entries = [
    user('go'),
    head('r-1', 'answered'),
    answer('Done.'),
    user('and this one?', 'user-trailing'),
  ];

  const turns = turnRail(entries);

  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.response, 'Done.', 'the trailing prompt stole the previous answer');
  assert.equal(turns[1]?.prompt, 'and this one?');
  assert.equal(turns[1]?.anchor, 'user-trailing', 'it must anchor on its own row');
});

test('a head with no echo above it still gets a mark', () => {
  // A goal round and a scheduled turn open a head with no `user` row at all. The
  // card falls back to the turn number; the mark must not disappear.
  const entries = [head('r-1', 'answered'), answer('round 1')];

  const turns = turnRail(entries);

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.prompt, '');
  assert.equal(turns[0]?.response, 'round 1');
});

test('rows that are not conversation contribute no marks', () => {
  const entries = [user('go'), head('r-1', 'answered'), ...noise('r-1'), answer('done')];

  assert.equal(turnRail(entries).length, 1, 'a model step or a tool row became a turn');
});

/* ============================================================
   A restored session
   ============================================================ */

test('a restored transcript becomes one mark per prompt, each paired with its answer', () => {
  // Exactly what `session_load` rebuilds: `user` and `answer` rows, no heads.
  const entries = [user('first question'), answer('first answer'), user('second'), answer('second')];

  const turns = turnRail(entries);

  assert.equal(turns.length, 2, 'a reopened session must be navigable');
  assert.deepEqual(
    turns.map((turn) => [turn.prompt, turn.response]),
    [
      ['first question', 'first answer'],
      ['second', 'second'],
    ],
    'each stored prompt must keep its own answer — the classic off-by-one here is ' +
      'to let the first prompt absorb the second answer',
  );
  assert.ok(
    turns.every((turn) => turn.anchor.startsWith('user-')),
    'a stored turn has no head, so every mark must anchor on its own prompt row',
  );
});

test('a stored prompt is the anchor when there is no head to anchor on', () => {
  const prompt = user('first question', 'user-stored');
  const entries = [prompt, answer('first answer')];

  assert.equal(turnRail(entries)[0]?.anchor, 'user-stored');
});

test('a restored session numbers the turn that follows it by position, not by ordinal', () => {
  // The defect this guards: `lastTurnOrdinal` counts only `turn` rows, so the
  // first live turn after a restore is numbered 1 while it is the conversation's
  // third. The head says "Turn 1"; the rail must say 3, because the rail is a map
  // of the conversation and the ordinal is a fact about this window.
  const entries = [
    user('first question'),
    answer('first answer'),
    user('second question'),
    answer('second answer'),
    user('third question'),
    head('r-1', 'running'),
  ];

  const turns = turnRail(entries);

  assert.equal(turns.length, 3);
  assert.deepEqual(
    turns.map((turn) => turn.turn),
    [1, 2, 3],
  );
  assert.deepEqual(
    turns.map((turn) => turn.prompt),
    ['first question', 'second question', 'third question'],
    'the live head must claim the echo (the third prompt), not the stored second one',
  );
  assert.deepEqual(
    turns.map((turn) => turn.response),
    ['first answer', 'second answer', ''],
    'the live head must not inherit a stored answer',
  );
});

test('a trailing stored prompt with no answer is still a mark', () => {
  // A session saved between the prompt and the reply: `projectHistory` emits the
  // `user` row and nothing after it.
  const entries = [user('asked, then the window closed')];

  const turns = turnRail(entries);

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.response, '');
});

test('an empty transcript has no turns', () => {
  assert.deepEqual(turnRail([]), []);
  assert.deepEqual(turnRail(noise()), [], 'a transcript of tool rows alone is not a conversation');
});

test('the rail is not worth a lane until there is somewhere to go', () => {
  assert.equal(MIN_RAIL_TURNS, 2);
  assert.ok(
    turnRail([user('only one'), head('r-1')]).length < MIN_RAIL_TURNS,
    'a one-turn transcript must not reserve the lane',
  );
});

/* ============================================================
   Previews
   ============================================================ */

test('a preview collapses whitespace and marks where it was clipped', () => {
  assert.equal(preview('  a\n\n b\tc  ', 50), 'a b c');
  assert.equal(preview('x'.repeat(PROMPT_LIMIT), PROMPT_LIMIT), 'x'.repeat(PROMPT_LIMIT));
  assert.equal(preview('x'.repeat(PROMPT_LIMIT + 1), PROMPT_LIMIT), `${'x'.repeat(PROMPT_LIMIT - 1)}…`);
  assert.equal(preview('', PROMPT_LIMIT), '');
});

test('a clipped preview is exactly the budget, ellipsis included', () => {
  // The budget is what the card's clamps are sized for, so a preview that came out
  // longer than it — an ellipsis appended to the full limit, say — would be the
  // one thing the clamp has to hide, on every long turn.
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  assert.equal(preview(words, RESPONSE_LIMIT).length, RESPONSE_LIMIT);
});

/* ============================================================
   Which mark the reader is in
   ============================================================ */

test('the active mark is the last heading scrolled past', () => {
  // Tops relative to the visible top of the transcript; the reader is between the
  // second and third turns.
  assert.equal(activeMark([-800, -300, 120, 600]), 1);
});

test('the first turn is active while the transcript is above every heading', () => {
  // A short session does not scroll at all, and a session whose first rows are
  // notices has its first heading below the fold.
  assert.equal(activeMark([40, 200, 900]), 0);
});

test('a heading exactly at the top edge is the reader’s turn', () => {
  // The boundary case the rule is defined by: scrolled precisely to a heading.
  assert.equal(activeMark([-500, 0, 400]), 1);
});

test('a heading a jump just landed on is the reader’s turn', () => {
  // The defect this guards: a jump leaves the heading `LANDING_PX` below the top
  // (a heading flush against the edge reads as a row cut in half — see
  // `stream.css`). If the band that decides "scrolled past" were narrower than
  // that, clicking mark 4 would highlight mark 3, which looks like a broken rail
  // rather than a rule that disagrees with itself by 12px.
  assert.ok(
    HEADING_BAND_PX > LANDING_PX,
    'the band must be wider than the landing inset, or a jump resolves to the previous turn',
  );
  assert.equal(activeMark([-3000, LANDING_PX, 900]), 1);
});

test('a heading below the band has not been reached yet', () => {
  assert.equal(activeMark([-100, HEADING_BAND_PX + 1]), 0);
});

test('no marks means no active mark', () => {
  assert.equal(activeMark([]), null);
});
