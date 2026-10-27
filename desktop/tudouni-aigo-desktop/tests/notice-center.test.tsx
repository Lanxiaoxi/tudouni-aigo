/**
 * The notice center: the unread ledger, and the fact that the transcript floor
 * no longer draws notes.
 *
 * Both halves are invisible when wrong in the same way. A ledger that never
 * moves badges nothing (the capsule looks broken); one that never resets
 * badges diagnostics that were on screen when the session was closed. A floor
 * that still draws the rows makes the capsule a duplicate rather than a
 * replacement. All three are asserted here against the pure read model and a
 * static render, not by looking at a window.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.browser';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { selectNoticeCenter } from '@/state/selectors/session';
import { createSessionBucket, useApp } from '@/state/store';
import { EntryView } from '@/components/stream/EntryView';
import type { Entry, NoteEntry } from '@/state/entries';

/* ---------------- fixtures ---------------- */

function note(partial: Partial<NoteEntry> & { id: string }): NoteEntry {
  return { kind: 'note', tone: 'info', code: 'mcp', text: '', ...partial };
}

function notes(...list: NoteEntry[]): Entry[] {
  return list;
}

/** The stylesheet entry, read as text — the import wiring has no behaviour in
 *  Node, and what the test protects is that the wiring exists. */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const indexCss = () => readFileSync(resolve(root, 'src/styles/index.css'), 'utf8');
const noticeCss = () => readFileSync(resolve(root, 'src/styles/components/notice-center.css'), 'utf8');

/* ---------------- 1. the read model ---------------- */

test('a session with no notes has nothing to show', () => {
  const view = selectNoticeCenter([], 0);
  assert.deepEqual(view, { notes: [], unread: 0, hasWarnUnread: false });
});

test('everything is unread until the popover first opens', () => {
  const view = selectNoticeCenter(
    notes(
      note({ id: 'n1', text: 'one' }),
      note({ id: 'n2', tone: 'warn', text: 'two' }),
      note({ id: 'n3', text: 'three' }),
    ),
    0,
  );
  assert.equal(view.notes.length, 3);
  assert.equal(view.unread, 3);
  assert.equal(view.hasWarnUnread, true, 'an unread warn note colours the badge');
});

test('opening the popover reads the whole backlog', () => {
  const view = selectNoticeCenter(
    notes(
      note({ id: 'n1', text: 'one' }),
      note({ id: 'n2', tone: 'warn', text: 'two' }),
      note({ id: 'n3', text: 'three' }),
    ),
    3,
  );
  assert.equal(view.unread, 0);
  assert.equal(view.hasWarnUnread, false, 'a *read* warn note must not badge again');
});

test('only notes that arrive after the last open are unread', () => {
  const list = [
    note({ id: 'n1', text: 'one' }),
    note({ id: 'n2', tone: 'warn', text: 'two' }),
    note({ id: 'n3', text: 'three' }),
    note({ id: 'n4', tone: 'warn', text: 'a later failure' }),
  ];
  const warnAgain = selectNoticeCenter(list, 3);
  assert.equal(warnAgain.unread, 1);
  assert.equal(warnAgain.hasWarnUnread, true);

  const infoAgain = selectNoticeCenter(
    [...list.slice(0, 3), note({ id: 'n4', text: 'a later line' })],
    3,
  );
  assert.equal(infoAgain.unread, 1);
  assert.equal(infoAgain.hasWarnUnread, false, 'an unread info line does not colour the badge');
});

test('a ledger ahead of the notes clamps to zero', () => {
  // A session_load rebuild and a markNotesRead can interleave; the badge must
  // never go negative whatever order they land in.
  const view = selectNoticeCenter(notes(note({ id: 'n1', text: 'one' })), 5);
  assert.equal(view.unread, 0);
});

/* ---------------- 2. the store action ---------------- */

const KEY = 'sess-1';

function resetStore(entries: Entry[], notesReadCount: number): void {
  useApp.setState({
    sessions: {
      [KEY]: { ...createSessionBucket(KEY, 'C:/work', { ericai: false, maxSteps: null }), entries, notesReadCount },
    },
    order: [KEY],
    activeKey: KEY,
  });
}

test('markNotesRead moves the ledger to the current count', () => {
  resetStore(
    notes(note({ id: 'n1', text: 'one' }), note({ id: 'n2', text: 'two' })),
    0,
  );
  useApp.getState().markNotesRead();
  assert.equal(useApp.getState().sessions[KEY]?.notesReadCount, 2);
});

test('markNotesRead is a no-op with no active session', () => {
  useApp.setState({ sessions: {}, order: [], activeKey: null });
  // The seam: the action must neither throw nor invent a bucket.
  useApp.getState().markNotesRead();
  assert.deepEqual(useApp.getState().sessions, {});
});

/* ---------------- 3. the transcript floor draws nothing ---------------- */

test('EntryView renders a note as nothing', () => {
  const html = renderToStaticMarkup(
    createElement(EntryView, { entry: note({ id: 'n1', text: '[mcp] a line' }) }),
  );
  assert.equal(html, '');
});

/* ---------------- 4. the capsule ----------------
 *
 * Rendered through `NoticeCapsule`, not `NoticeCenter`: a zustand hook answers
 * a server render from the store's **initial** state (`getInitialState` is the
 * server snapshot), so `setState` before `renderToStaticMarkup` is invisible.
 * The store half is covered by the action tests above; the capsule takes its
 * read model as a prop, which is the seam this suite renders through. */

import { NoticeCapsule, NoticeRow } from '@/components/NoticeCenter';

test('a session with no notes renders no capsule at all', () => {
  const html = renderToStaticMarkup(
    createElement(NoticeCapsule, { view: selectNoticeCenter([], 0) }),
  );
  assert.equal(html, '');
});

test('the collapsed capsule shows the unread count, warning-coloured', () => {
  const view = selectNoticeCenter(
    notes(
      note({ id: 'n1', text: '[MCP] one' }),
      note({ id: 'n2', tone: 'warn', text: '[search] two' }),
    ),
    0,
  );
  const html = renderToStaticMarkup(createElement(NoticeCapsule, { view }));
  assert.match(html, /nc-capsule/);
  assert.match(html, /nc-badge is-warn/);
  assert.match(html, />2</);
  assert.match(html, /Notices: 2 total, 2 unread/);
});

test('a read backlog shows no badge', () => {
  const view = selectNoticeCenter(
    notes(note({ id: 'n1', text: '[MCP] one' }), note({ id: 'n2', text: '[web] two' })),
    2,
  );
  const html = renderToStaticMarkup(createElement(NoticeCapsule, { view }));
  assert.match(html, /nc-capsule/);
  assert.doesNotMatch(html, /nc-badge/);
});

test('rows keep the two-source rule: a window-composed message beats the verbatim text', () => {
  const composed = note({
    id: 'n1',
    text: 'a stale runtime sentence',
    message: { code: 'terminalEnded', id: 'term-1', reason: 'exited', exitCode: 0 },
  });
  const html = renderToStaticMarkup(createElement(NoticeRow, { entry: composed }));
  assert.match(html, /Terminal term-1 exited with code 0\./);
  assert.doesNotMatch(html, /a stale runtime sentence/);

  const verbatim = renderToStaticMarkup(
    createElement(NoticeRow, { entry: note({ id: 'n2', text: '[MCP] a verbatim sentence' }) }),
  );
  assert.match(verbatim, /\[MCP\] a verbatim sentence/);
});

/* ---------------- 5. the stylesheet wiring ---------------- */

test('notice-center.css exists and is imported by the entry point', () => {
  const css = noticeCss();
  assert.match(css, /\.nc-capsule \{/);
  assert.match(css, /\.nc-popover \{/);
  assert.match(css, /\.nc-row\.is-warn/);
  assert.match(indexCss(), /@import '\.\/components\/notice-center\.css';/);
});

test('the capsule is a circle closed and a pill open, on the rim badge', () => {
  const css = noticeCss();
  // A constant stadium radius is the whole trick: at the 32px floor it is a
  // circle, wider it is the pill — one shape changing size, not two swapping.
  assert.match(css, /min-width: 32px/);
  assert.match(css, /border-radius: 999px/);
  // The states are driven by Radix's own data-state on the trigger.
  assert.match(css, /\.nc-capsule\[data-state='open'\]/);
  assert.match(css, /\.nc-capsule\[data-state='open'\] \.nc-label/);
  // The badge floats on the rim in both states — the circle has no room for
  // it in the flow, and a badge that only existed open would hide the one
  // fact the closed state exists to tell.
  assert.match(css, /\.nc-badge \{[\s\S]*?position: absolute/);
  // The panel answers close with a real exit animation (Radix waits for it
  // before unmounting), not a disappearance.
  assert.match(css, /@keyframes nc-sink/);
  assert.match(css, /\.nc-popover\[data-state='closed'\]/);
});

test('the capsule animates within the motion contract', () => {
  // tokens.css allows opacity and transform only; the keyframes must not
  // smuggle a layout property back in.
  const css = noticeCss();
  const keyframes = css.slice(css.indexOf('@keyframes nc-rise'));
  assert.ok(keyframes.length > 0, 'the rise keyframes exist');
  assert.doesNotMatch(keyframes, /\b(width|height|top|left)\s*:/);
});
