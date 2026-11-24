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
import { previewFile } from '@/components/stream/DeliverableCards';
import { createSessionBucket, useApp } from '@/state/store';
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

/* ---------------- a card opens the Dock's Explorer ---------------- */

const LAUNCH = { ericai: false, maxSteps: null };

/** Make `root` the active session's workspace, the way the Dock reads it. */
function activateWorkspace(root: string | null): void {
  if (root === null) {
    useApp.setState({ activeKey: null, sessions: {} });
    return;
  }
  useApp.setState({
    activeKey: 'k1',
    sessions: { k1: createSessionBucket('k1', root, LAUNCH) },
  });
}

function reset(): void {
  useApp.setState({ dockOpen: false, dockMode: 'git', dockPane: 'navigator', workspaceUi: {} });
}

test('a card for a workspace file opens the Explorer with that file selected', () => {
  reset();
  activateWorkspace('C:\\work\\app');
  let external = 0;
  previewFile({ path: 'docs/guide/readme.md', description: '' }, () => {
    external += 1;
  });
  const s = useApp.getState();
  assert.equal(s.dockOpen, true);
  assert.equal(s.dockMode, 'explorer');
  assert.equal(external, 0, 'a workspace file is shown in the Dock, not handed to the OS');
  const ui = Object.values(s.workspaceUi)[0];
  assert.equal(ui?.selectedFile, 'docs/guide/readme.md');
  assert.deepEqual(ui?.expandedDirs, ['docs', 'docs/guide'], 'its parent directories are opened');
  activateWorkspace(null);
});

test('an absolute path inside the workspace is converted, whichever separator it uses', () => {
  reset();
  activateWorkspace('C:\\work\\app');
  previewFile({ path: 'C:\\Work\\App\\out\\report.html', description: '' }, () => {
    assert.fail('inside the workspace');
  });
  assert.equal(Object.values(useApp.getState().workspaceUi)[0]?.selectedFile, 'out/report.html');
  activateWorkspace(null);
});

test('a file outside the workspace keeps the old fallback: the open door', () => {
  reset();
  activateWorkspace('C:\\work\\app');
  const opened: string[] = [];
  previewFile({ path: 'C:\\elsewhere\\x.docx', description: '' }, (file) => opened.push(file.path));
  previewFile({ path: '../escape.md', description: '' }, (file) => opened.push(file.path));
  assert.deepEqual(opened, ['C:\\elsewhere\\x.docx', '../escape.md']);
  assert.equal(useApp.getState().dockOpen, false, 'nothing opened in the Dock');
  activateWorkspace(null);
});

test('with no workspace at all the card falls back too', () => {
  reset();
  activateWorkspace(null);
  let opened = 0;
  previewFile({ path: 'a.md', description: '' }, () => {
    opened += 1;
  });
  assert.equal(opened, 1);
});
