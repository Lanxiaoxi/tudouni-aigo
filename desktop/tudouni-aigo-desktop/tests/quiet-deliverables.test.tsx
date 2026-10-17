/**
 * A declared deliverable survives quiet mode.
 *
 * Quiet mode compresses every tool call into one line, and it did that to
 * `present` as well 鈥?so a turn whose whole result *was* a file drew a row saying
 * "present 路 done" and nothing else. The card disappeared at the exact moment it
 * mattered: the model says "宸茬粡鎶婂畠浣滀负鏂囦欢鍗＄墖鏀惧埌涓嬮潰浜?, the person scrolls and
 * finds no card. That is a broken promise in prose, and it is the kind of failure
 * that looks like a rendering bug in the card rather than a rule in the rollup.
 *
 * The fix is not "show cards in quiet mode" but "a declaration is not detail about
 * the call" 鈥?it is the turn's result, which is why it is also drawn when the line
 * is collapsed. This suite pins both halves of that, because the second one is the
 * half that would quietly regress: rendering the cards only inside `expanded` would
 * pass a test that only checked the expanded case.
 *
 * `renderToStaticMarkup` against the real component, no stub, for the reason
 * `markdown-fence.test.tsx` gives: the claim is about what the component tree
 * actually produces.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server.browser';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QuietGroup } from '@/components/stream/QuietGroup';
import { isPicturePath } from '@/components/panels/panels';
import type { Entry } from '@/state/entries';

/**
 * A finished `present` call, in the shape the reducer produces.
 *
 * Built as a literal rather than by replaying wire events, because what is under
 * test is the render of a declaration that already landed 鈥?the reducer's own
 * behaviour is pinned by `stream-blocks.test.ts`.
 */
function presentEntry(deliverables: { path: string; description?: string }[]): Entry {
  return {
    kind: 'tool',
    id: 'tool-1',
    index: 0,
    tool: 'present',
    arguments: '{"files":[{"path":"out/chart.png"}]}',
    risk: 'low',
    runId: 'r1',
    step: 0,
    result: {
      status: 'ok',
      chars: 139,
      durationMs: 1,
      exitCode: null,
      parallel: false,
      preview: 'Presented out/chart.png',
      deliverables: deliverables.map((file) => ({
        path: file.path,
        description: file.description ?? '',
      })),
    },
  } as Entry;
}

function renderQuiet(entry: Entry): string {
  // `DeliverableCards` wraps its open control in a Radix `Tooltip`, which refuses
  // to render without a provider above it. The real app supplies one at the root;
  // a static render has to be given the same context or it throws before the
  // assertion runs — and the throw is about the harness, not about cards.
  return renderToStaticMarkup(
    <Tooltip.Provider>
      <QuietGroup entries={[entry]} />
    </Tooltip.Provider>,
  );
}

/* ---------------- the card is drawn at all ---------------- */

test('a declaration under quiet mode still draws its card', () => {
  const html = renderQuiet(presentEntry([{ path: 'out/chart.png' }]));
  assert.match(html, /dl-card/, 'the card list is what the model promised the person');
  assert.match(html, /chart\.png/, 'the card names the file');
});

test('the card is drawn with the line collapsed, not only when expanded', () => {
  // QuietLine's own expansion state is local and starts collapsed, so this is the
  // default a person actually sees. A fix that hung the cards off `expanded` would
  // still hide them in the common case while looking correct in a manual test
  // where somebody had clicked the row first.
  const html = renderQuiet(presentEntry([{ path: 'out/chart.png' }]));
  assert.doesNotMatch(html, /e-tool/, 'the row body is collapsed by default');
  assert.match(html, /dl-card/, 'and the card is still there');
});

test('every declared file gets a card, not just the first', () => {
  const html = renderQuiet(
    presentEntry([{ path: 'a.png' }, { path: 'b.png' }, { path: 'c.png' }]),
  );
  for (const name of ['a.png', 'b.png', 'c.png']) {
    assert.match(html, new RegExp(name.replace('.', '\\.')), `${name} is missing`);
  }
});

/* ---------------- and nothing else changed ---------------- */

test('a call that declares nothing draws no card', () => {
  // The one-line summary is still the whole of an ordinary tool call under quiet
  // mode; the cards are for declarations, not for every row.
  const entry = {
    ...presentEntry([]),
    result: { ...presentEntry([]).result!, deliverables: [] },
  } as Entry;
  const html = renderQuiet(entry);
  assert.doesNotMatch(html, /dl-card/);
});

test('quiet mode still compresses an ordinary call to one line', () => {
  const entry = {
    kind: 'tool',
    id: 'tool-2',
    index: 1,
    tool: 'list_files',
    arguments: '{}',
    risk: 'low',
    runId: 'r1',
    step: 1,
    result: {
      status: 'ok',
      chars: 10,
      durationMs: 0,
      exitCode: null,
      parallel: false,
      preview: null,
    },
  } as Entry;
  const html = renderQuiet(entry);
  assert.match(html, /quiet-line/);
  assert.doesNotMatch(html, /dl-card/);
});

/* ---------------- a picture is a picture, not text ---------------- */

test('the extensions the card draws are the ones the panel draws', () => {
  // One predicate, imported by both. A file the card refuses to draw but the
  // browser tries to read as text is a card that opens onto "not UTF-8 text".
  for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'dir/a.webp', 'dir\\a.bmp']) {
    assert.equal(isPicturePath(name), true, `${name} should be drawn`);
  }
  for (const name of ['a.md', 'a.go', 'a', '.hidden', 'a.', 'dir/a.txt']) {
    assert.equal(isPicturePath(name), false, `${name} should be read as text`);
  }
});

test('a dotted directory does not make its files pictures', () => {
  // The first dot is in the directory, not the name. Deriving the extension from
  // the whole path would call this a `.png` directory entry.
  assert.equal(isPicturePath('v1.2/README'), false);
});

