/**
 * The language bar on a fenced code block.
 *
 * `Markdown.tsx` reads the fence's tag out of the element tree `react-markdown`
 * builds, and **nothing in that tree carries the tag as an attribute** — it is
 * only the `language-go` class on the inner `<code>`. That makes the reading a
 * claim about a third-party renderer's output shape rather than about this
 * codebase, and it is exactly the kind of claim that survives until
 * `react-markdown` changes how it emits `pre`, at which point the bar silently
 * loses its label and every fence renders untagged. So the first half of this
 * suite feeds the **real** renderer (no stub, no hand-built tree) and asserts
 * what came out.
 *
 * The second half reads `stream.css` as text. That is the same technique
 * `stream-layout.test.ts` uses for its performance declaration, and for the same
 * reason: a stylesheet has no behaviour to observe in Node, and what is being
 * protected here is that the design's rules are *present* and pointed at the
 * right token. A rule deleted in a refactor, or one that quietly went back to a
 * hard-coded grey, is invisible in every other test.
 */

import { test } from 'node:test';
import { streamCss as readStreamCss } from './stream-css';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.browser';
import { Markdown, ensureHighlightLoaded } from '@/components/ui/Markdown';
import { fenceLanguage, fenceLayout } from '@/components/ui/fence';

/* ---------------- the reading, against the real renderer ---------------- */

/**
 * The `class` the real renderer puts on the `<code>` inside the `<pre>`, read
 * out of the rendered HTML.
 *
 * This is deliberately *not* a hand-built element tree handed to
 * `fenceLanguage`: a stub proves only that the function agrees with itself. What
 * needs pinning is that the class is on the inner `<code>` and that it still
 * says `language-go` after `rehype-highlight` has had the element (that plugin
 * rewrites class lists), because the bar's label is read from exactly there and
 * from nowhere else.
 */
function codeClasses(markdown: string): string | null {
  const html = renderToStaticMarkup(<Markdown text={markdown} />);
  const match = /<pre><code[^>]*\sclass="([^"]*)"/.exec(html);
  return match ? match[1] : null;
}

/**
 * The same element `fenceLanguage` is handed in production, built with the real
 * factory rather than as an object literal: React identifies its elements with a
 * private symbol, so a literal is **not** an element and `isValidElement` says
 * so — which is exactly what a hand-built stub got wrong here first.
 */
function asChildren(className: string | null): ReactNode {
  if (className === null) return null;
  return createElement('code', { className });
}

test('a tagged fence keeps its language class through the highlight pass', () => {
  const classes = codeClasses('```go\nfunc main() {}\n```');
  assert.ok(classes, 'react-markdown emitted no <code> inside <pre>');
  assert.match(classes, /(?:^|\s)language-go(?:\s|$)/, `classes were: ${classes}`);
  assert.equal(fenceLanguage(asChildren(classes)), 'go');
});

test('a fence with no tag carries no language class at all', () => {
  // Not merely "a class without `language-`": an untagged `<code>` has **no
  // `class` attribute**, so the extraction finds nothing — which is the shape
  // this whole branch keys off.
  assert.equal(codeClasses('```\nplain\n```'), null);
  assert.equal(fenceLanguage(asChildren(codeClasses('```\nplain\n```'))), null);
});

test('punctuation in a tag survives, because the model wrote it', () => {
  // `c++`, `c#`, `objective-c` and `dockerfile.build` are all real tags, and the
  // last two are why the tag is not matched with `\w`.
  assert.equal(fenceLanguage(asChildren(codeClasses('```c++\nint main() {}\n```'))), 'c++');
  assert.equal(
    fenceLanguage(asChildren(codeClasses('```objective-c\nint main() {}\n```'))),
    'objective-c',
  );
});

test('an inline code span has no language and never gets a bar', () => {
  // No `<pre>` at all, so the language read is `null` — which is what keeps an
  // inline span out of the bar branch.
  assert.equal(codeClasses('a `inline` span'), null);
  assert.equal(fenceLanguage(asChildren(codeClasses('a `inline` span'))), null);
});

test('`text` and `plaintext` are not languages', () => {
  // Several renderers normalise a bare fence to `plaintext`; printing that in a
  // bar would be the renderer talking about itself.
  for (const name of ['text', 'plaintext', 'TEXT']) {
    assert.equal(
      fenceLanguage(asChildren(`language-${name}`)),
      null,
      `${name} was treated as a language`,
    );
  }
});

test('the layout is a bar exactly when there is a tag', () => {
  assert.deepEqual(fenceLayout('go'), { bar: true, language: 'go' });
  assert.deepEqual(fenceLayout(null), { bar: false, language: null });
});

test('the rendered answer keeps the fence text intact under the bar', async () => {
  // The bar is added *around* the code, never in place of it: a fenced block
  // whose body disappeared would still look like a code block from a screenshot.
  // The body is matched piecewise because `rehype-highlight` splits it into
  // `<span>`s — `func `, `main` and `()` are three tokens — so what is asserted
  // is that the words survive, not that they survive in one text node.
  //
  // The plugin is loaded out of band in production (`Markdown.tsx`), so it has
  // to be in place before this synchronous render: the promise is awaited here
  // and the module-level slot it fills is what the component reads at render
  // time, effects or no effects.
  await ensureHighlightLoaded();
  const html = renderToStaticMarkup(<Markdown text={'```go\nfunc main() {}\n```'} />);
  assert.match(html, /hljs-keyword/);
  assert.match(html, /func/);
  assert.match(html, /main/);
  assert.match(html, /class="md-lang"/);
  assert.match(html, /class="md-lang-name"/);
  // The label is the tag's own text; CSS uppercases it, this code does not.
  assert.match(html, />go</);
});

test('an untagged fence is drawn without the bar', () => {
  const html = renderToStaticMarkup(<Markdown text={'```\nplain\n```'} />);
  assert.doesNotMatch(html, /class="md-lang"/);
  // The copy button is still there 鈥?it just floats over the block instead.
  assert.match(html, /md-copy-btn/);
});

/* ---------------- the stylesheet's half ---------------- */

const streamCss = readStreamCss();

/** One rule body, by its exact selector line. */
function ruleBody(selector: string): string {
  const index = streamCss.indexOf(`\n${selector} {`);
  assert.notEqual(index, -1, `stream.css has no rule for \`${selector}\``);
  const open = streamCss.indexOf('{', index);
  const close = streamCss.indexOf('}', open);
  return streamCss.slice(open + 1, close);
}

test('the language bar exists and is one hairline under the block', () => {
  const bar = ruleBody('.md-lang');
  assert.match(bar, /border-bottom: 1px solid/);
  assert.match(bar, /justify-content: space-between/);
  // The tag is uppercased for display, not rewritten in the DOM.
  assert.match(ruleBody('.md-lang-name'), /text-transform: uppercase/);
});

test('an untagged block keeps the floating copy button', () => {
  // This is the `:has()` branch the untagged case rides on; without it the
  // button would be laid out inside the block's flow and the code would sit
  // under it.
  assert.match(ruleBody('.md-codeblock:not(:has(.md-lang)) .md-copy-btn'), /position: absolute/);
});

test('the restyle takes its colours from the theme, not from fixed hex values', () => {
  // The typography this follows is a single fixed palette (light + teal); these
  // four are the ones that would go illegible in the dark theme if a hex value
  // were pasted in instead of a token.
  assert.match(ruleBody('.md a'), /color: var\(--accent\)/);
  assert.match(ruleBody('.md blockquote'), /border-left: 3px solid var\(--accent\)/);
  assert.match(ruleBody('.md :not(pre) > code'), /color: var\(--accent\)/);
  assert.match(ruleBody('.md strong'), /color: var\(--fg\)/);
});

test('nothing in the block reintroduces the old values', () => {
  // These were the three the restyle replaced: link-blue links, a 2px grey
  // quote rule, and a low-offset underline. A merge that brought any of them
  // back would look deliberate.
  assert.doesNotMatch(streamCss, /\.md a \{[^}]*color: var\(--info\)/);
  assert.doesNotMatch(streamCss, /\.md blockquote \{[^}]*border-left: 2px/);
  assert.doesNotMatch(streamCss, /\.md a \{[^}]*text-underline-offset: 2px/);
});

test('the three list levels are three different markers', () => {
  assert.match(ruleBody('.md ul li::marker'), /content: '\\2022'/);
  assert.match(ruleBody('.md ul ul li::marker'), /content: '\\2013'/);
  assert.match(ruleBody('.md ul ul ul li::marker'), /content: '\\00B7'/);
});

test('a table cell honours its own alignment', () => {
  // GFM writes `align="center"` on the cells of a `:---:` column, so one
  // attribute selector covers the header and the body.
  assert.match(ruleBody(".md :is(th, td)[align='center']"), /text-align: center/);
  assert.match(ruleBody(".md :is(th, td)[align='right']"), /text-align: right/);
  assert.match(ruleBody(".md :is(th, td)[align='right']"), /font-variant-numeric: tabular-nums/);
});
