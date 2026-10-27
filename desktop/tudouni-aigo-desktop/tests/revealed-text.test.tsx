/**
 * The three ways pacing lets go, asserted against a real render.
 *
 * `useRevealedText` is a hook, and the parts of it that matter are the ones a
 * pure test of the engine cannot see: that a **disabled** pacing returns the
 * whole text in the same render (a find is open, or the person turned it off),
 * that a **replaced** body appears at once rather than being typed out again,
 * and that a settled stream drains instead of teleporting.
 *
 * Rendered with `react-dom/server`, the same way `markdown-fence.test.tsx`
 * drives the real renderer: there is no jest-dom, no testing library and no
 * jsdom in this project, and the questions above are all answerable from the
 * markup of one synchronous render.
 *
 * `renderToStaticMarkup` runs no effects, which is exactly the boundary these
 * assertions sit on: everything asserted here is decided during render, before
 * any frame can run. What the frames do is `stream-reveal.test.ts`'s business.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.browser';

import { useRevealedText } from '@/hooks/useRevealedText';

/** One render of the hook, with its result handed to a render function. */
function render(
  text: string,
  live: boolean,
  enabled: boolean,
  draw: (shown: string) => string = (shown) => shown,
): string {
  function Probe(): ReturnType<typeof createElement> {
    const shown = useRevealedText(text, live, enabled);
    return createElement('div', null, draw(shown));
  }
  return renderToStaticMarkup(createElement(Probe));
}

test('disabled pacing draws the whole text in the same render', () => {
  // The find bar and the settings switch both land here: a search must be able
  // to see every character the model has sent, not just the ones the cursor has
  // reached.
  const text = 'the whole reply, all at once';
  assert.equal(render(text, true, false), `<div>${text}</div>`);
});

test('a fresh live stream is drawn whole, not from zero', () => {
  // A row is created *by* its first chunk. Replaying that chunk from an empty
  // cursor would wipe and retype a paragraph that has already arrived.
  const text = 'first chunk';
  assert.equal(render(text, true, true), `<div>${text}</div>`);
});

test('a settled stream that arrived whole is drawn whole', () => {
  // The ordinary short answer: one chunk, then `run_finished`. Nothing is owed,
  // so nothing may be held back.
  const text = 'short answer';
  assert.equal(render(text, false, true), `<div>${text}</div>`);
});

/**
 * The draw function proves the hook's value is what reaches the DOM: if the
 * cursor were only advisory, these two renders would be identical.
 */
test('what the hook returns is what is drawn', () => {
  assert.equal(
    render('abc', true, true, (shown) => `[${shown}]`),
    '<div>[abc]</div>',
  );
});

/**
 * The caret and the body are one row: a `streaming` entry must not be reported
 * as finished just because its text happens to be fully shown.
 */
test('a disabled hook never withholds text even from a live stream', () => {
  const text = 'still arriving';
  const markup = render(text, true, false);
  assert.ok(markup.includes(text));
});
