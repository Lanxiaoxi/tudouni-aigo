/**
 * The composer's string ↔ document translation. The store keeps the draft as
 * text with placeholder tokens; the editor draws each token as a chip. A round
 * trip that lost a character, or a caret one position off, reads as a broken
 * editor — and neither is visible until somebody types into it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Node as PMNode } from '@tiptap/pm/model';

import {
  TokenNode,
  docToDraft,
  draftToContent,
  offsetToPos,
  posToOffset,
} from '@/components/chrome/composerDoc';
import {
  expandLongPastes,
  labelDraft,
  restorePastedPaths,
  tokenKind,
  type TokenLabels,
} from '@/runtime/paste';

const schema = getSchema([Document, Paragraph, Text, TokenNode]);
const doc = (draft: string) => PMNode.fromJSON(schema, draftToContent(draft));

test('a draft survives the round trip through the document', () => {
  for (const draft of [
    '',
    'plain words',
    '看看⟦pimg-0⟧这个',
    '⟦file-0⟧',
    'a\nb\n\n⟦note-1⟧ c',
    '⟦text-0⟧⟦pimg-1⟧',
    'trailing newline\n',
  ]) {
    assert.equal(docToDraft(doc(draft)), draft, JSON.stringify(draft));
  }
});

test('a token becomes one atom node, not text', () => {
  const d = doc('a ⟦pimg-0⟧ b');
  const para = d.firstChild!;
  assert.equal(para.childCount, 3);
  assert.equal(para.child(1).type.name, 'token');
  assert.equal(para.child(1).attrs.token, '⟦pimg-0⟧');
});

test('offsets and positions map onto each other at every token edge', () => {
  const draft = 'ab⟦pimg-0⟧c\nd';
  const d = doc(draft);
  // Every offset that is not inside a token survives the trip.
  const edges = [0, 1, 2, 2 + '⟦pimg-0⟧'.length, draft.indexOf('c') + 1, draft.indexOf('\n') + 1, draft.length];
  for (const offset of edges) {
    assert.equal(posToOffset(d, offsetToPos(d, offset)), offset, `offset ${offset}`);
  }
  // An offset inside a token lands after the chip.
  assert.equal(posToOffset(d, offsetToPos(d, 4)), 2 + '⟦pimg-0⟧'.length);
});

test('the end of the draft is the end of the document', () => {
  const d = doc('x\n⟦file-0⟧');
  assert.equal(offsetToPos(d, 'x\n⟦file-0⟧'.length), d.content.size - 1);
});

test('a token tells its family', () => {
  assert.equal(tokenKind('⟦text-3⟧'), 'text');
  assert.equal(tokenKind('⟦pimg-0⟧'), 'pimg');
  assert.equal(tokenKind('pimg-0'), null);
});

test('a restored path is its own word even where the chip sat flush against text', () => {
  const image = { path: 'p/a.png', placeholder: '⟦pimg-0⟧', name: 'a.png', bytes: 1, mime: 'image/png', url: '' };
  assert.equal(restorePastedPaths('看看⟦pimg-0⟧这个', [image]), '看看 p/a.png 这个');
  // A deleted chip ships nothing: there is no tray promising it any more.
  assert.equal(restorePastedPaths('just words', [image]), 'just words');
});

test('a long paste is expanded at send, set off by line breaks', () => {
  const pastes = [{ placeholder: '⟦text-0⟧', text: 'L1\nL2' }];
  assert.equal(expandLongPastes('see ⟦text-0⟧ ok', pastes), 'see \nL1\nL2\n ok');
  assert.equal(expandLongPastes('⟦text-0⟧', pastes), 'L1\nL2');
  assert.equal(expandLongPastes('⟦text-1⟧', pastes), '⟦text-1⟧', 'a token with no entry is prose');
});

test('the transcript reads each token as a label', () => {
  const labels: TokenLabels = {
    image: (name) => `[image: ${name}]`,
    file: (name) => `[file: ${name}]`,
    note: (note) => `[note: ${note}]`,
    text: (chars) => `[text · ${chars}]`,
  };
  const out = labelDraft(
    '⟦pimg-0⟧ ⟦file-0⟧ ⟦note-0⟧ ⟦text-0⟧ ⟦pimg-9⟧',
    {
      pastedImages: [{ path: 'p', placeholder: '⟦pimg-0⟧', name: 'a.png', bytes: 1, mime: 'image/png', url: '' }],
      attachedFiles: [{ path: 'q', placeholder: '⟦file-0⟧', name: 'b.md' }],
      annotations: [{ placeholder: '⟦note-0⟧', quote: 'q', note: 'fix' }],
      longPastes: [{ placeholder: '⟦text-0⟧', text: 'abcd' }],
    },
    labels,
  );
  assert.equal(out, '[image: a.png] [file: b.md] [note: fix] [text · 4] ⟦pimg-9⟧');
});
