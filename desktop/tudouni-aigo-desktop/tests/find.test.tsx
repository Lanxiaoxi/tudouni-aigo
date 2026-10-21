/**
 * Find in the conversation (`Ctrl+F`).
 *
 * Three claims are asserted here, and each one fails **silently** in a window,
 * which is why none of them is left to a look:
 *
 *   1. **Where a match is.** A highlight is a `Range` over live text nodes, so an
 *      offset that is one out — or a match that is allowed to span the separator
 *      between two paragraphs — puts the mark on the wrong word, or draws it
 *      across two blocks. `locateRange` is pure, so the arithmetic is asserted
 *      directly rather than by eye.
 *   2. **Case folding that keeps its offsets.** `toLowerCase` is not
 *      length-preserving for every character; a folded offset would point left of
 *      the mark for every hit after it.
 *   3. **That the row carries the link back to the model.** The paint layer finds
 *      a hit as an offset into a row's text and has to get from there to a `Text`
 *      node, which it does through `data-entry`. A row kind that is searchable in
 *      `FIND_CONTENT_SELECTORS` but does not render that attribute is a row whose
 *      hits are counted and never drawn — invisible, because the counter is built
 *      from the same scan.
 *
 * The stylesheet half is read as text, the way `markdown-fence.test.tsx` reads
 * `stream.css`: the highlight is drawn by the CSS Custom Highlight API, whose
 * registry names are string constants in `find/engine.ts` and selector names in
 * the stylesheet. Rename one and the other keeps working — perfectly, and
 * invisibly, by painting nothing at all.
 */

import { test } from 'node:test';
import { streamCss as readStreamCss } from './stream-css';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.browser';
import { findAll, locateRange, FIND_CONTENT_SELECTORS, FIND_ROW_ATTRIBUTE } from '@/find/matches';
import type { Segment } from '@/find/matches';
import { EntryView } from '@/components/stream/EntryView';
import type { Entry } from '@/state/entries';

/* ---------------- 1. finding ---------------- */

test('findAll reports every occurrence, overlapping ones included', () => {
  // A browser's own find reports both: hiding the second would make the count
  // disagree with what the reader can see.
  assert.deepEqual(findAll('aaa', 'aa'), [0, 1]);
  assert.deepEqual(findAll('one two one', 'one'), [0, 8]);
  assert.deepEqual(findAll('nothing here', 'zzz'), []);
  assert.deepEqual(findAll('anything', ''), []);
});

test('findAll folds case in the ordinary case', () => {
  assert.deepEqual(findAll('Find the FInd', 'find'), [0, 9]);
  assert.deepEqual(findAll('ÄÖÜ', 'äöü'), [0]);
});

test('findAll keeps offsets exact when folding would change the length', () => {
  // `İ`.toLowerCase() is two code points, so the folded string is longer than the
  // original: offsets taken from it would be one to the left of every match after
  // that character. The offset has to stay in the original string.
  assert.equal('İstanbul'.toLowerCase().length, 'İstanbul'.length + 1);
  assert.deepEqual(findAll('İstanbul', 'stan'), [1]);
  assert.deepEqual(findAll('İSTANBUL', 'stan'), [1]);
});

/* ---------------- 2. mapping a match back to nodes ---------------- */

/** Segments over a fake DOM: `locateRange` only ever passes `node` through, so
 *  the node can be a token standing in for a `Text`. */
function segs(...slices: [string, number][]): Segment[] {
  return slices.map(([label, start]) => ({
    node: { label } as unknown as Text,
    start,
    end: start + label.length,
  }));
}

test('locateRange maps a match inside one text node', () => {
  const located = locateRange(segs(['hello world', 0]), 6, 5);
  assert.deepEqual(located, {
    start: { node: { label: 'hello world' }, offset: 6 },
    end: { node: { label: 'hello world' }, offset: 11 },
  });
});

test('locateRange spans two text nodes, and end is one past the last character', () => {
  // `the ` + `find` — the shape an answer's inline markup produces, where the
  // phrase a reader sees is three nodes under two elements.
  const located = locateRange(segs(['the ', 0], ['find', 4]), 0, 8);
  assert.deepEqual(located, {
    start: { node: { label: 'the ' }, offset: 0 },
    end: { node: { label: 'find' }, offset: 4 },
  });
});

test('locateRange refuses a match that straddles a separator', () => {
  // Two paragraphs, with a `\n` between them: offsets 0..2 and 4..7, and offset 3
  // is the separator. A query cannot contain a newline, so a "match" here is one
  // nobody typed.
  const two = segs(['one', 0], ['two', 4]);
  assert.equal(locateRange(two, 1, 5), null, 'must not run from one paragraph into the next');
  assert.equal(locateRange(two, 3, 2), null, 'must not begin on the separator');
  assert.deepEqual(locateRange(two, 1, 2), {
    start: { node: { label: 'one' }, offset: 1 },
    end: { node: { label: 'one' }, offset: 3 },
  });
});

test('locateRange refuses a match that runs past the end', () => {
  assert.equal(locateRange(segs(['short', 0]), 2, 10), null);
  assert.equal(locateRange(segs(['short', 0]), 99, 1), null);
  assert.equal(locateRange([], 0, 1), null);
  assert.equal(locateRange(segs(['short', 0]), 0, 0), null);
});

/* ---------------- 3. the model -> DOM link ---------------- */

/**
 * The four surfaces — **a literal list**, so that widening the search is a
 * deliberate edit here as well as there. The point of naming them again is that
 * `find/matches.ts` claims this is the class vocabulary of `EntryView.tsx`, and a
 * claim about another module's markup is exactly the kind that survives until
 * somebody renames a class.
 */
test('the searched surfaces are the four the design named', () => {
  assert.deepEqual([...FIND_CONTENT_SELECTORS], [
    '.e-user',
    '.e-stream',
    '.e-reason-body',
    '.e-answer .md',
  ]);
});

/** One entry of each kind, minimal but complete. */
const ENTRIES: Record<string, Entry> = {
  user: { kind: 'user', id: 'u1', text: 'the question', atMs: 0 },
  answer: { kind: 'answer', id: 'a1', runId: 'r', text: 'the **find** layer', userBefore: 1 },
  stream: { kind: 'stream', id: 's1', runId: 'r', step: 1, text: 'live body', streaming: true },
  reason: { kind: 'reason', id: 'r1', runId: 'r', step: 1, text: 'thinking', streaming: false },
};

/**
 * Which selector finds each kind's text — the allowlist, read from the model's
 * side. A kind whose row renders no class any selector names is a kind whose hits
 * are counted and never drawn.
 */
const SEARCHABLE: [keyof typeof ENTRIES, string][] = [
  ['user', '.e-user'],
  ['answer', '.e-answer .md'],
  ['stream', '.e-stream'],
  ['reason', '.e-reason-body'],
];

/**
 * What this asserts, and what it deliberately does not.
 *
 * It asserts the **markup** half: the row carries `data-entry`, and every class
 * the allowlist names is somewhere in that row. It cannot assert the other half —
 * *how the engine looks the container up* — because that is DOM behaviour and
 * there is no DOM here. The distinction is not academic: the engine's defect was
 * `querySelector` alone, which searches descendants and therefore skipped every
 * row that **is** its own container (a prompt, and the live body being written),
 * while the markup was perfectly correct. No markup assertion could have seen it.
 *
 * That one is guarded by `scripts/find-check.mjs`, which drives a real prompt and
 * a real streamed body through the bar and reports the count. It found the defect
 * on its first run; this suite is where the class vocabulary is pinned, not where
 * the lookup is.
 */
for (const [kind, selector] of SEARCHABLE) {
  test(`the ${kind} row carries ${FIND_ROW_ATTRIBUTE}, and the classes the allowlist names`, () => {
    const entry = ENTRIES[kind];
    const html = renderToStaticMarkup(createElement(EntryView, { entry }));
    assert.match(
      html,
      new RegExp(`${FIND_ROW_ATTRIBUTE}="${entry.id}"`),
      `${kind} is searchable, so the paint layer has to be able to find its row`,
    );
    for (const step of selector.split(' ')) {
      const cls = step.replace(/^\./, '');
      // Extra classes on the same element are fine (`class="e-note is-image"`),
      // which is why this is a word-boundary match rather than an equality.
      assert.match(
        html,
        new RegExp(`class="[^"]*\\b${cls}\\b`),
        `${selector} is in the allowlist, so ${kind} must draw a .${cls} or the walk finds nothing`,
      );
    }
  });
}

test('a row that v1 does not search carries no link, so the walk skips it', () => {
  // Not an accident of the markup: `find/engine.ts` enumerates rows by this
  // attribute, so a kind without it cannot produce a hit. Widening the search in
  // v2 means adding the attribute *and* a selector, and this test is where that
  // shows up.
  const model: Entry = {
    kind: 'model',
    id: 'm1',
    runId: 'r',
    step: 0,
    durationMs: null,
    inputTokens: null,
    cachedTokens: null,
    completionTokens: null,
    retry: null,
  };
  assert.doesNotMatch(renderToStaticMarkup(createElement(EntryView, { entry: model })), /data-entry/);
});

/* ---------------- 4. the registry names the stylesheet must match ---------------- */

test('stream.css styles both highlight registries', () => {
  // `process.cwd()`, like `markdown-fence.test.tsx`: the suite is bundled into
  // `.test-build/`, so a path relative to the bundle would be a path relative to
  // nothing. The runner's cwd is the project root.
  const css = readStreamCss();
  for (const name of ['find-match', 'find-current']) {
    assert.match(
      css,
      new RegExp(`::highlight\\(${name}\\)\\s*\\{[^}]*background-color`),
      `::highlight(${name}) must set a background, or the mark is drawn as nothing`,
    );
  }
});
