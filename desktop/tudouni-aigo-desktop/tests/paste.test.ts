/**
 * Pasted pictures: the decisions that can be made before anything is written.
 *
 * These exist for the same reason the drop tests do. The failure mode of this
 * feature is not a crash — it is a sentence that *looks* like it carried a
 * picture and did not: a path glued to the previous word (one token to the
 * runtime's scanner), a refusal that never got said, or a chip claiming a picture
 * the person already deleted from the sentence. All three render as a plausible
 * screen, which is exactly what makes them worth pinning here.
 *
 * The constants mirrored from the Go side are asserted against the numbers the
 * runtime actually uses, so a change there shows up as a failing test rather than
 * as a paste that the runtime refuses a round trip later.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  classify,
  formatBytes,
  insertPathAtCaret,
  nameOfPath,
  referencedImages,
  refuseBeforeRead,
  removePathFromDraft,
  type PastedImage,
} from '@/runtime/paste';

/* ============================================================
   identifying a picture from its bytes
   ============================================================ */

test('a picture is identified from its bytes, not from what the clipboard claimed', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.deepEqual(classify(png), { mime: 'image/png', ext: 'png' });

  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  assert.deepEqual(classify(jpeg), { mime: 'image/jpeg', ext: 'jpg' });

  // Both GIF versions, which differ in the two bytes after the signature.
  assert.deepEqual(classify(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), {
    mime: 'image/gif',
    ext: 'gif',
  });
  assert.deepEqual(classify(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])), {
    mime: 'image/gif',
    ext: 'gif',
  });
});

test('a format the runtime cannot measure is refused here rather than a round trip later', () => {
  // WebP is deliberately not accepted: `content.ImageMIMEs` leaves it out because
  // no stdlib decoder means no dimensions and no thumbnail. Accepting it here
  // would produce a file that gets attached and then refused.
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assert.equal(classify(webp), null);

  // Text, a truncated signature, and nothing at all.
  assert.equal(classify(new TextEncoder().encode('this is not a picture')), null);
  assert.equal(classify(new Uint8Array([0x89, 0x50])), null);
  assert.equal(classify(new Uint8Array([])), null);

  // A PNG signature that is one byte short must not match the eight-byte check.
  assert.equal(classify(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a])), null);
});

/* ============================================================
   the gates, and the order they are applied in
   ============================================================ */

test('the mirrored ceilings are the runtime’s own numbers', () => {
  // `internal/content/content.go`: MaxImageBytes.
  assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
  // `internal/content/paths.go`: MaxImagesPerMessage. Asserted as a literal on
  // purpose — this is the one place that says out loud what the two sides agree
  // on, so a change on the Go side has to be acknowledged here.
  assert.equal(MAX_IMAGES_PER_MESSAGE, 10);
});

test('there is no workspace, so nothing can be checked or written', () => {
  assert.deepEqual(refuseBeforeRead(1024, '', 0), { code: 'no-workspace' });
  // Whitespace is not a workspace either.
  assert.deepEqual(refuseBeforeRead(1024, '   ', 0), { code: 'no-workspace' });
  // And it is refused *before* the size is considered: a picture that fits is
  // still not writable without a workspace to write it inside.
  assert.deepEqual(refuseBeforeRead(10, '', 0), { code: 'no-workspace' });
});

test('an oversized picture is refused before its bytes are read', () => {
  const workspace = 'C:\\work\\proj';
  // Exactly at the ceiling is fine — the runtime's test is `>`, not `>=`.
  assert.equal(refuseBeforeRead(MAX_IMAGE_BYTES, workspace, 0), null);

  const over = refuseBeforeRead(MAX_IMAGE_BYTES + 1, workspace, 0);
  assert.deepEqual(over, {
    code: 'too-large',
    size: MAX_IMAGE_BYTES + 1,
    limit: MAX_IMAGE_BYTES,
  });
});

test('this front end stops stashing at its own share of the cap', () => {
  const workspace = '/home/u/proj';
  assert.equal(refuseBeforeRead(1024, workspace, MAX_IMAGES_PER_MESSAGE - 1), null);
  assert.deepEqual(refuseBeforeRead(1024, workspace, MAX_IMAGES_PER_MESSAGE), {
    code: 'at-capacity',
    limit: MAX_IMAGES_PER_MESSAGE,
  });
});

/* ============================================================
   writing the path into the sentence
   ============================================================ */

test('an inserted path stays a separate word on both sides', () => {
  // The runtime finds pictures by splitting the sentence into tokens, so a path
  // glued to the word before it is one token it will not recognise — and a
  // silently unattached picture is the one failure this whole layer exists to
  // prevent.
  assert.deepEqual(insertPathAtCaret('', 0, 'a.png'), { text: 'a.png', caret: 5 });
  assert.deepEqual(insertPathAtCaret('look at this', 12, 'a.png'), {
    text: 'look at this a.png',
    caret: 18,
  });
  // Already at a word boundary: no second space.
  assert.deepEqual(insertPathAtCaret('look at this ', 13, 'a.png'), {
    text: 'look at this a.png',
    caret: 18,
  });
});

test('a path goes in at the caret, not at the end', () => {
  // Unlike a drop, a paste has a caret: the person put it somewhere.
  assert.deepEqual(insertPathAtCaret('see  and this', 4, 'a.png'), {
    text: 'see a.png and this',
    caret: 9,
  });
  // The caret lands just after the path, and a space is added so the next word
  // stays its own token.
  assert.deepEqual(insertPathAtCaret('seeand this', 3, 'a.png'), {
    text: 'see a.png and this',
    caret: 9,
  });
});

test('a caret outside the text is clamped rather than trusted', () => {
  // A stale caret (the draft changed under it) must not slice past the end.
  assert.deepEqual(insertPathAtCaret('abc', 99, 'a.png'), { text: 'abc a.png', caret: 9 });
  assert.deepEqual(insertPathAtCaret('abc', -5, 'a.png'), { text: 'a.png abc', caret: 5 });
});

/* ============================================================
   the tray and the sentence, kept in step
   ============================================================ */

function image(path: string, bytes = 1024): PastedImage {
  return { path, name: nameOfPath(path), bytes, mime: 'image/png', url: `blob:${path}` };
}

test('a chip is drawn only while its path is still in the sentence', () => {
  const images = [image('.tudouni/paste/s-1/a.png'), image('.tudouni/paste/s-1/b.png')];

  // Both named: both drawn.
  assert.deepEqual(
    referencedImages('看看这两张 .tudouni/paste/s-1/a.png .tudouni/paste/s-1/b.png', images).map(
      (i) => i.path,
    ),
    ['.tudouni/paste/s-1/a.png', '.tudouni/paste/s-1/b.png'],
  );

  // The person deleted one word. The tray must follow the text, because the text
  // is the only thing that gets sent — a chip left behind would claim a picture
  // that is not going anywhere.
  assert.deepEqual(
    referencedImages('看看这张 .tudouni/paste/s-1/b.png', images).map((i) => i.path),
    ['.tudouni/paste/s-1/b.png'],
  );

  // Both deleted: no chips at all.
  assert.deepEqual(referencedImages('算了', images), []);
});

test('a path the person wrapped in punctuation still counts', () => {
  // `content.trimToken` strips the punctuation a path is routinely wrapped in,
  // and the question this function answers is "would the runtime still resolve
  // this?" — so the two have to agree.
  const images = [image('.tudouni/paste/s-1/a.png')];
  assert.equal(referencedImages('"`.tudouni/paste/s-1/a.png`"', images).length, 1);
  assert.equal(referencedImages('看这个（.tudouni/paste/s-1/a.png）。', images).length, 1);
  assert.equal(referencedImages('@.tudouni/paste/s-1/a.png', images).length, 1);
});

test('punctuation the runtime does not strip does not count here either', () => {
  // Smart quotes are **not** in `content.trimToken`'s set, so the runtime's own
  // scanner would not resolve a path wrapped in them — and the tray must not
  // claim otherwise. Asserting the agreement is the point: a chip drawn for a
  // picture the runtime will not attach is exactly the "looks like it worked"
  // failure this feature has to avoid, and it would be invisible on screen.
  const images = [image('.tudouni/paste/s-1/a.png')];
  assert.equal(referencedImages('“`.tudouni/paste/s-1/a.png`”', images).length, 0);
});

test('a path that is only a prefix of another is not a match', () => {
  // Token equality, not `includes`: `a.png` must not light up because `xa.png`
  // happens to contain it.
  const images = [image('a.png')];
  assert.equal(referencedImages('xa.png', images).length, 0);
  assert.equal(referencedImages('a.png', images).length, 1);
});

test('no images means no work', () => {
  assert.deepEqual(referencedImages('anything at all', []), []);
});

/* ============================================================
   dismissing a chip
   ============================================================ */

test('dismissing a chip edits the sentence, because the sentence is what gets sent', () => {
  // The chip's dismiss button removes the **path**, not an entry in a list of
  // attachments. Anything else would leave the tray and the message disagreeing
  // about whether the picture is going anywhere.
  assert.equal(
    removePathFromDraft('看看这个 .tudouni/paste/a.png', '.tudouni/paste/a.png'),
    '看看这个',
  );
  // The hole the path left is closed, so the sentence does not keep a double space.
  assert.equal(
    removePathFromDraft('see .tudouni/paste/a.png and this', '.tudouni/paste/a.png'),
    'see and this',
  );
  // The only word: nothing left.
  assert.equal(removePathFromDraft('.tudouni/paste/a.png', '.tudouni/paste/a.png'), '');
});

test('dismissing one picture leaves the others alone', () => {
  const draft = 'a .tudouni/paste/one.png .tudouni/paste/two.png b';
  assert.equal(
    removePathFromDraft(draft, '.tudouni/paste/one.png'),
    'a .tudouni/paste/two.png b',
  );
});

test('dismissing by token cannot damage a longer word', () => {
  // Substring matching would eat `xa.png` here, and the person would lose text
  // they never asked to remove.
  assert.equal(removePathFromDraft('xa.png', 'a.png'), 'xa.png');
  assert.equal(removePathFromDraft('a.png', 'a.png'), '');
});

test('a path the person wrapped in punctuation is removed with it', () => {
  // The same readings `referencedImages` uses to draw the chip, so a chip that is
  // visible can always be dismissed. Only the **path** comes out: the brackets and
  // the full stop are punctuation the person wrote, and a button that removes a
  // picture has no business editing their prose. What is left resolves to no file,
  // so the runtime's scanner sees a word and the sentence is unchanged for it.
  assert.equal(
    removePathFromDraft('看这个（.tudouni/paste/a.png）。', '.tudouni/paste/a.png'),
    '看这个（）。',
  );
});

/* ============================================================
   labels
   ============================================================ */

test('a name comes from the path, and both separators are handled', () => {
  assert.equal(nameOfPath('.tudouni/paste/s-1/paste-1.png'), 'paste-1.png');
  assert.equal(nameOfPath('C:\\work\\proj\\shot.png'), 'shot.png');
  assert.equal(nameOfPath('a.png'), 'a.png');
  // A trailing separator is not part of the name.
  assert.equal(nameOfPath('docs/'), 'docs');
});

test('byte counts read the way the runtime writes them', () => {
  // Mirrors `content.HumanSize`, so the same file is not "1.5MB" in one sentence
  // and "1536KB" in the next — the two appear side by side when the runtime
  // reports an oversized picture.
  assert.equal(formatBytes(0), '0B');
  assert.equal(formatBytes(-1), '0B');
  assert.equal(formatBytes(512), '512B');
  assert.equal(formatBytes(1024), '1KB');
  assert.equal(formatBytes(1536 * 1024), '1.5MB');
  assert.equal(formatBytes(MAX_IMAGE_BYTES), '5.0MB');
});
