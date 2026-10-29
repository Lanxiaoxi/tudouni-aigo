/**
 * The context ledger's breakdown, asserted against a real render.
 *
 * Three questions the arithmetic test in Go cannot answer:
 *
 *   - the headline and the rows use **the same denominator** (the window), so
 *     the percentages can be read against each other;
 *   - the bar's track is the window — the remainder is drawn, not absorbed —
 *     and each segment's share is the token count, not a rounded percentage;
 *   - a runtime that sends no `parts` still draws the ledger table, and a
 *     session with no known window gets **no** percentages rather than a
 *     division by a number nobody has.
 *
 * Rendered with `react-dom/server`, the same way `revealed-text.test.tsx`
 * drives the real component: there is no jsdom here, and `ContextBlock` decides
 * everything during render.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.browser';

import { ContextBlock } from '@/components/stream/InBlock';
import type { ContextPart, UiContextMsg } from '@/protocol/types';

function message(overrides: {
  parts?: ContextPart[];
  window?: number | null;
  used?: number | null;
}): UiContextMsg {
  return {
    v: 1,
    t: 'ui',
    kind: 'context',
    context: {
      context: {
        estimated_tokens: overrides.used === undefined ? 281_000 : (overrides.used ?? undefined),
        limit_tokens: 900_000,
        artifacts: 4,
      },
      window: overrides.window === undefined ? 1_000_000 : overrides.window,
      messages: 12,
      folded: 0,
      parts: overrides.parts,
    },
  };
}

const PARTS: ContextPart[] = [
  { key: 'messages', tokens: 187_200 },
  { key: 'files', tokens: 41_900 },
  { key: 'note', tokens: 29_900 },
  { key: 'system', tokens: 22_000 },
];

function draw(msg: UiContextMsg): string {
  return renderToStaticMarkup(createElement(ContextBlock, { p: msg }));
}

test('the headline is the share of the window, with the two numbers beside it', () => {
  const html = draw(message({ parts: PARTS }));
  // 281,000 of 1,000,000 — 28%, not 100% of what was sent.
  assert.match(html, /28% used/);
  assert.match(html, /281,000/);
  assert.match(html, /1,000,000/);
});

test('each row carries its own share of the window, the same denominator', () => {
  const html = draw(message({ parts: PARTS }));
  // 187.2k of 1M is 18.7%; the rows add up to the 28% above them.
  assert.match(html, /Messages/);
  assert.match(html, /187,200/);
  assert.match(html, /18\.7%/);
  assert.match(html, /4\.2%/); // 41.9k
  assert.match(html, /Files &amp; text/);
  assert.match(html, /System prompt/);
});

test('the rows keep the runtime order and every part gets a swatch', () => {
  const html = draw(message({ parts: PARTS }));
  const order = ['Messages', 'Files &amp; text', 'Session note', 'System prompt'].map((label) =>
    html.indexOf(label),
  );
  assert.ok(order.every((at) => at >= 0), 'a part is missing from the render');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the rows were re-sorted');
  assert.equal((html.match(/class="ctx-dot"/g) ?? []).length, PARTS.length);
});

test('the bar is drawn against the window, so the remainder is a segment', () => {
  // The fixture's parts add up to the headline exactly, which is what the
  // runtime guarantees (`ContextParts` decomposes `Measure`). Keeping the
  // fixture honest is what makes the next assertion mean something.
  assert.equal(
    PARTS.reduce((sum, part) => sum + part.tokens, 0),
    281_000,
    'the fixture no longer matches its own headline',
  );
  const html = draw(message({ parts: PARTS }));
  // One segment per part, plus the headroom (1M − 281k). Each segment grows by
  // its token count rather than by a percentage rounded somewhere else.
  assert.equal((html.match(/class="ctx-seg"/g) ?? []).length, PARTS.length);
  assert.match(html, /flex-grow:187200/);
  assert.match(html, /class="ctx-seg is-rest" style="flex-grow:719000"/);
});

test('the remainder follows the headline, never the rows', () => {
  // A state the runtime does not produce — parts that do not add up to
  // `estimated_tokens` — kept as a pin on the direction of the fallback. The
  // bar must agree with the number printed above it; a gap that quietly absorbs
  // the difference would be the one thing this panel cannot do.
  const html = draw(
    message({
      parts: [{ key: 'messages', tokens: 100_000 }],
      used: 250_000,
    }),
  );
  assert.match(html, /class="ctx-seg is-rest" style="flex-grow:750000"/);
});

test('a runtime that sends no parts still draws the ledger', () => {
  const html = draw(message({ parts: undefined }));
  assert.equal((html.match(/class="ctx-bar"/g) ?? []).length, 0);
  assert.equal((html.match(/class="ctx-row"/g) ?? []).length, 0);
  // The raw ledger table and the used/window pair are what was there before.
  assert.match(html, /ledger/);
  assert.match(html, /estimated_tokens/);
});

test('with no known window the percentages are omitted, never divided by nothing', () => {
  const html = draw(message({ parts: PARTS, window: null }));
  assert.doesNotMatch(html, /% used/);
  assert.doesNotMatch(html, /18\.7%/);
  // The token counts are still stated; the bar is a share of what was sent.
  assert.match(html, /187,200/);
  assert.equal((html.match(/class="ctx-seg is-rest"/g) ?? []).length, 0);
});
