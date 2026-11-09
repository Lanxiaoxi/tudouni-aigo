/**
 * A GFM autolink that has swallowed the prose after it.
 *
 * The claim this suite pins: when a bare `http://…` sits in Chinese prose
 * with no space after it (），你验收时… right on the URL), the link ends at
 * the first non-ASCII character and the sentence after it renders as plain
 * text, not as part of the link. Without `remarkAutolinkFix`, GFM extends
 * the autolink to the next whitespace and the whole sentence is drawn with
 * the link's colour and underline.
 *
 * `renderToStaticMarkup` against the real renderer, the same way
 * `markdown-filepath.test.tsx` does it: the contract is the element shape a
 * third-party renderer emits.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWithTooltip } from './with-tooltip';
import { Markdown } from '@/components/ui/Markdown';

function html(markdown: string): string {
  return renderWithTooltip(<Markdown text={markdown} />);
}

/** The href and the text of the first `<a>` in the output. */
function firstLink(out: string): { href: string; label: string } {
  const match = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(out);
  assert.ok(match, `no <a> in output: ${out}`);
  return { href: match[1], label: match[2] };
}

/* ---------------- the swallowed tail ---------------- */

test('an autolink does not swallow the CJK sentence after it', () => {
  // The report that started this: the URL followed by ），你验收时… with no
  // space, the whole tail was inside the <a>.
  const out = html(
    'dev server 还在后台运行（http://localhost:3000/stats），你验收时改一下日期范围看数字是否变化即可。有新问题继续说。',
  );
  const { href, label } = firstLink(out);
  assert.equal(href, 'http://localhost:3000/stats');
  assert.equal(label, 'http://localhost:3000/stats');
  // The tail is plain text outside the link, with no link markup of its own.
  // （））是尾巴的第一个字符——全角括号不属于 ASCII，正是切割点。）
  assert.match(out, /<\/a>），你验收时改一下日期范围看数字是否变化即可。有新问题继续说。/);
  assert.equal((out.match(/<a/g) ?? []).length, 1);
});

test('an autolink in English prose is untouched', () => {
  // A URL already bounded by whitespace ends itself; the fix must not cut it.
  const out = html('dev server is running at http://localhost:3000/stats, check it');
  const { href } = firstLink(out);
  assert.equal(href, 'http://localhost:3000/stats');
});

test('an autolink with ASCII punctuation after it keeps the punctuation in the url', () => {
  // GFM keeps `,` `.` `;` inside the literal by rule; only the non-ASCII
  // boundary is our business. (This is what the parser does today; pin it so
  // the fix is not mistaken for a general url trimmer.)
  const out = html('see http://example.com/a,b for details');
  const { href } = firstLink(out);
  assert.equal(href, 'http://example.com/a,b');
});

/* ---------------- what stays untouched ---------------- */

test('an authored markdown link is left alone', () => {
  const out = html('[点这里](<http://example.com/>)');
  const { href, label } = firstLink(out);
  // The label is its own text, not the url — that is what identifies a
  // hand-written link, and the fix must not cut it.
  assert.equal(href, 'http://example.com/');
  assert.equal(label, '点这里');
});

test('an authored link whose url carries a non-ASCII character is still untouched', () => {
  // The only nodes the fix may cut are autolinks: an http(s) url **and** a
  // label that equals that url. A url with CJK in it but a different label is
  // a hand-written link, whatever the parser let into the destination.
  // (react-markdown percent-encodes the href at render time, so assert on the
  // prefix, not the exact byte form — the invariant is "not cut", not the
  // encoder's output.)
  const out = html('[点这里](<http://example.com/a？b>)');
  const { href, label } = firstLink(out);
  assert.match(href, /^http:\/\/example\.com\/a/);
  assert.equal(label, '点这里');
});

test('a workspace-file link is left alone', () => {
  // remarkFilePath synthesises these; their urls do not start with http.
  const out = html('输出在 doors-filter-ppt/index.html，直接打开');
  assert.doesNotMatch(out, /<a[^>]*href="http/);
  assert.match(out, /class="md-filepath"/);
});
