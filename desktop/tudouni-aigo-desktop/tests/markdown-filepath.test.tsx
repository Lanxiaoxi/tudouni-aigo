/**
 * File paths in a model's answer become clickable links.
 *
 * The claim this suite pins: `remarkFilePath` makes a path clickable in
 * **prose** — and, since models quote paths in backticks far more often than
 * they write them bare, in **inline code spans** too. A path that is only
 * clickable when unquoted is a feature nobody meets. Fenced code blocks
 * stay plain (a block is a wall of paths; linking every one is noise).
 *
 * `renderToStaticMarkup` against the real renderer, for the reason
 * `markdown-fence.test.tsx` gives: the contract is the output shape a
 * third-party renderer emits, and a stub would only prove the suite agrees
 * with itself. The click itself (the Rust bridge) cannot run in a static
 * render; what is asserted is the synchronous half — that the element tree
 * carries the `md-filepath` mark and no `href`, so the `a` mapping in
 * `Markdown.tsx` is what will catch the click.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server.browser';
import { Markdown } from '@/components/ui/Markdown';

function html(markdown: string): string {
  return renderToStaticMarkup(<Markdown text={markdown} />);
}

function filepathLinkCount(out: string): number {
  return (out.match(/class="md-filepath"/g) ?? []).length;
}

/* ---------------- inline code spans ---------------- */

test('a path quoted in an inline code span becomes a file link', () => {
  // The report that started this: `doors-filter-ppt/index.html` in backticks
  // was never clickable because the visitor only saw `text` nodes.
  const out = html('文件：`doors-filter-ppt/index.html`（浏览器直接打开即可）');
  assert.equal(filepathLinkCount(out), 1);
  // The label keeps the code-chip element, so the span's styling carries over.
  assert.match(out, /<code>doors-filter-ppt\/index\.html<\/code>/);
  // No `href` anywhere: a file link must not navigate the webview.
  assert.doesNotMatch(out, /href=/);
});

test('a code span holds only the path when it carries more text', () => {
  // The link label is the matched token, not the whole span — a span can
  // hold prose around the path.
  const out = html('看 `详见 doors-filter-ppt/index.html 这里`');
  assert.equal(filepathLinkCount(out), 1);
  assert.match(out, /<code>doors-filter-ppt\/index\.html<\/code>/);
});

test('a code span without a path stays a plain span', () => {
  const out = html('运行 `npm run test` 即可');
  assert.equal(filepathLinkCount(out), 0);
  assert.doesNotMatch(out, /<a/);
});

test('two paths in two spans are two links', () => {
  const out = html('改了 `src/a.ts`，再看 `tests/b.ts`');
  assert.equal(filepathLinkCount(out), 2);
});

/* ---------------- plain prose (the original behaviour) ---------------- */

test('a bare path in prose is still a file link', () => {
  // The first release only looked at text nodes; that half must survive the
  // extension to code spans.
  const out = html('输出在 doors-filter-ppt/index.html，直接打开');
  assert.equal(filepathLinkCount(out), 1);
  assert.match(out, /doors-filter-ppt\/index\.html/);
});

/* ---------------- what stays untouched ---------------- */

test('a fenced code block is never linked', () => {
  // A block is a wall of paths; linking every line would be noise.
  const out = html('```\ndocs/a.md\nsrc/b.ts\n```\n');
  assert.equal(filepathLinkCount(out), 0);
  assert.doesNotMatch(out, /<a/);
});

test('an authored markdown link is left alone', () => {
  const out = html('[点这里](https://example.com/a.md)');
  assert.equal(filepathLinkCount(out), 0);
  assert.match(out, /href="https:\/\/example\.com\/a\.md"/);
});

test('a path with an unsupported extension is not linked', () => {
  const out = html('模板在 `templates/deck.pptx.bak`');
  assert.equal(filepathLinkCount(out), 0);
});
