/**
 * The rail's **Presented files** block.
 *
 * The transcript's card and this row are two faces of one fact — a `present`
 * call declared a file — and they differ in one decision: the card's face is a
 * preview, while the rail row's whole face is the open, because a 200px row has
 * room for one target and the question the block answers is answered by the file
 * opening, not by its name being drawn again.
 *
 * What is pinned here is what the row *says* before anyone clicks: the
 * accessible name is the default-application open (a column of bare file names
 * would read as nothing to a screen reader), and the note falls back to the file
 * kind when the model wrote none.
 *
 * `renderToStaticMarkup` against the real component, for the reason
 * `quiet-deliverables.test.tsx` gives: the claim is about the tree the component
 * actually produces. The remote half of the trailing glyph cannot be observed
 * this way — a server render reads the store's **initial** state, so a session
 * `setState` before `renderToStaticMarkup` is invisible (the same limitation
 * `notice-center.test.tsx` states) — and it is shared with the transcript card's
 * control rather than re-implemented here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server.browser';
import { PresentedFiles } from '@/components/sidebar/Sidebar';
import type { Deliverable } from '@/state/entries';

const FILES: Deliverable[] = [
  { path: 'out/report.md', description: 'the analysis' },
  { path: 'out/chart.png', description: '' },
];

test('one row per file, each named as the default-application open', () => {
  const html = renderToStaticMarkup(<PresentedFiles files={FILES} />);

  assert.equal(
    html.match(/class="sb-file-face"/g)?.length,
    2,
    'every presented file gets a row',
  );
  assert.match(html, /title="out\/report\.md"/, 'the full path is the hover title');
  assert.match(
    html,
    /aria-label="Open report\.md in its default application"/,
    'the accessible name is the act, not a bare file name',
  );
  assert.match(
    html,
    /aria-label="Open chart\.png in its default application"/,
    'and it is named per file',
  );
});

test("the model's note is shown, and its absence falls back to the file kind", () => {
  const html = renderToStaticMarkup(<PresentedFiles files={FILES} />);

  assert.match(html, /the analysis/, 'a written note is the second line');
  assert.match(html, /Image/, 'a picture with no note says what kind of file it is');
});

test('a markdown file with no note says "Markdown document"', () => {
  const html = renderToStaticMarkup(
    <PresentedFiles files={[{ path: 'notes/todo.md', description: '' }]} />,
  );
  assert.match(html, /Markdown document/);
});
