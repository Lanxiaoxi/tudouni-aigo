/**
 * Pictures in model output.
 *
 * A model that generates a picture hands back **a path**, and the chat used to
 * print it. This suite pins the three things that make the path into pixels:
 *
 * 1. the **classification** — which destinations are drawn as authored, which go
 *    to the bridge, and which are refused outright;
 * 2. that the **real renderer** produces a picture element for `![](…)` at all,
 *    since `Markdown.tsx` maps `img` and a mapping that silently stopped being
 *    applied would look exactly like a renderer that never had one;
 * 3. that the **refusal** path does not disappear: an unreadable destination is a
 *    visible row naming the path, not a blank.
 *
 * `renderToStaticMarkup` rather than a shallow renderer, for the reason
 * `markdown-fence.test.tsx` gives: the claim being protected is about a
 * third-party renderer's output shape, and a stub would only prove that this
 * suite agrees with itself.
 *
 * The effect that actually reads bytes cannot run in a static render, which is
 * why the bridge is not reached here. What is asserted is the synchronous half:
 * what the element tree says before any bytes arrive, and what it says for a
 * destination that never needs bytes at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server.browser';
import { Markdown } from '@/components/ui/Markdown';

function html(markdown: string): string {
  return renderToStaticMarkup(<Markdown text={markdown} />);
}

/* ---------------- the renderer mapping ---------------- */

test('a markdown image reaches the picture component rather than a bare img', () => {
  // `![a](b.png)` is an image, and the `img` mapping in `Markdown.tsx` is what
  // makes it one. Without that mapping react-markdown emits a plain `<img
  // src="b.png">`, which the WebView cannot load — the exact bug this feature
  // exists to fix. The observable difference: the mapped component draws
  // `.md-img-alt` while it waits, and the bare tag draws nothing.
  const out = html('![out](out.png)');
  assert.match(out, /md-img-alt/, 'a workspace path should wait, not render a dead src');
  assert.doesNotMatch(out, /src="out\.png"/, 'the authored path must not reach the DOM as a src');
  assert.match(out, />out</, 'the alt text is what the person sees while it loads');
});

test('a data URL is drawn as authored, with no bridge round trip', () => {
  // Already-resolved bytes need no workspace and no command, so the element is a
  // real `img` on the first render.
  const out = html('![a](data:image/png;base64,iVBORw0KGgo=)');
  assert.match(out, /<img[^>]*class="md-img"/);
  assert.match(out, /data:image\/png;base64,iVBORw0KGgo=/);
});

test('a blob URL is drawn as authored', () => {
  const out = html('![a](blob:http://localhost/abc-123)');
  assert.match(out, /<img[^>]*src="blob:http:\/\/localhost\/abc-123"/);
});

/* ---------------- what is refused ---------------- */

test('a non-image data payload is refused rather than put in an img slot', () => {
  // Nothing executes from `img src`, but a data URL is still a string the model
  // controls being handed to the DOM. Only image media types are accepted.
  const out = html('![a](data:text/html;base64,PHNjcmlwdD4=)');
  assert.doesNotMatch(out, /<img/, 'a data:text/html destination must not become a picture');
  assert.match(out, /md-img-broken/);
});

test('a file URL is refused, because it names a path outside the workspace', () => {
  // This is the destination the boundary exists for: an absolute path on this
  // machine. It is refused at classification time, so it never reaches the
  // command that would have to refuse it again.
  const out = html('![a](file:///C:/Users/someone/.ssh/id_rsa)');
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /md-img-broken/);
});

test('a refused picture still shows the path it named', () => {
  // The row is the actionable part: "the model says it made this and it is not
  // drawable" is something the person can respond to, so the path stays on
  // screen instead of the element being dropped.
  const out = html('![a](file:///C:/tmp/x.png)');
  assert.match(out, /C:\/tmp\/x\.png|file:\/\/\/C:\/tmp\/x\.png/);
});

test('an image with neither destination nor alt draws nothing at all', () => {
  const out = html('![]()');
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /md-img-broken/);
});

/* ---------------- the stylesheet rules are present ---------------- */

/**
 * `stream.css` read as text. Same technique and same reason as
 * `stream-layout.test.ts`: a stylesheet has no behaviour to observe in Node, and
 * a rule deleted in a refactor is invisible to every other test.
 */
const streamCss = readFileSync(
  resolve(import.meta.dirname, '../src/styles/stream.css'),
  'utf8',
);

test('the picture rule caps width, so one screenshot cannot fill the column', () => {
  // Without this, a generated picture is drawn at its intrinsic pixel size and
  // pushes the transcript's column out of the window.
  assert.match(streamCss, /\.md img,\s*\n\.md-img \{[^}]*max-width: 100%/);
});

test('the picture rule caps height too, because a portrait screenshot is tall', () => {
  // **The bug this pins.** `max-width: 100%` alone fixes landscape only: a
  // 390×844 phone screenshot is 1688px tall once its width fills the column, so
  // one picture became a whole screen and pushed every following line out of
  // view. A width cap and a height cap are two different failures, and the CSS
  // reads as complete while only one of them is present.
  assert.match(streamCss, /\.md img,\s*\n\.md-img \{[^}]*max-height: 60vh/);
});

test('the height cap is proportional, not a crop', () => {
  // `object-fit: cover` would slice the top and bottom off a screenshot — a UI
  // capture with its buttons cropped out is a picture that lies. `contain` scales
  // the whole thing down instead.
  const rule = /\.md img,\s*\n\.md-img \{([^}]*)\}/.exec(streamCss)?.[1] ?? '';
  assert.match(rule, /object-fit: contain/);
  assert.doesNotMatch(rule, /object-fit: cover/);
  // Both axes auto, so the browser derives the other dimension from the aspect
  // ratio rather than stretching the picture to the box.
  assert.match(rule, /width: auto/);
  assert.match(rule, /height: auto/);
});

test('the full-size view is not capped, or the cap would be permanent', () => {
  // A lightbox that also shrank the picture would make `zoom-in` a lie and the
  // 60vh cap un-undoable — the same failure as no lightbox at all, for anyone
  // who actually needs to read the screenshot.
  const rule = /\.md-img-lightbox img \{([^}]*)\}/.exec(streamCss)?.[1] ?? '';
  assert.notEqual(rule, '', 'the lightbox picture rule is missing');
  assert.match(rule, /max-height: 100%/);
  assert.doesNotMatch(rule, /max-height: 60vh/);
});

test('the unreadable row can truncate a long path instead of overflowing', () => {
  assert.match(streamCss, /\.md-img-broken-path \{[^}]*text-overflow: ellipsis/);
});
