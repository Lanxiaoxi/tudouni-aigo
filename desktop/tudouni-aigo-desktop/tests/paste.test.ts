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
  insertAtCaret,
  nameOfPath,
  nextPlaceholder,
  referencedImages,
  refuseBeforeRead,
  removePlaceholderFromDraft,
  restorePastedPaths,
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
   the placeholder in the draft
   ============================================================ */

test('a placeholder is short, numbered, and never reused in the same draft', () => {
  assert.equal(nextPlaceholder(''), '⟦pimg-0⟧');
  assert.equal(nextPlaceholder('⟦pimg-0⟧'), '⟦pimg-1⟧');
  assert.equal(nextPlaceholder('⟦pimg-1⟧ ⟦pimg-0⟧'), '⟦pimg-2⟧');
  // A number the person deleted is recycled, not skipped: the gaps would read
  // as a mistake.
  assert.equal(nextPlaceholder('⟦pimg-0⟧ ⟦pimg-2⟧'), '⟦pimg-1⟧');
  // A longer word that merely *contains* the token is not a collision.
  assert.equal(nextPlaceholder('x⟦pimg-0⟧'), '⟦pimg-1⟧');
});

test('the placeholder is a word the runtime’s scanner cannot read as a path', () => {
  // The swap happens before anything leaves the window, but the draft itself
  // must not accidentally carry a token the runtime could try to resolve.
  // `content.looksLikePicture` needs an image extension **and** a name in front
  // of it, and `pathCandidates` can only cut from a separator or an ASCII tail —
  // none of which a token built as `⟦pimg-n⟧` has: no image extension anywhere,
  // no separator, and the only ASCII part is a name, not a tail.
  const token = nextPlaceholder('');
  assert.ok(!/\.(png|jpe?g|gif)/i.test(token));
  assert.ok(!/[\\/]/.test(token));
  // The bracket characters are what keep the whole thing out of the runtime’s
  // path-character set: drop them and the remainder is a plain name with no
  // extension, which the scanner reads as prose.
  assert.ok(!/^[\x21-\x7e]+$/.test(token));
  assert.ok(!/\.(png|jpe?g|gif)/i.test(token.replace(/⟦|⟧/g, '')));
});

test('an inserted token stays a separate word on both sides', () => {
  // The spacing is load-bearing: at submit the token is swapped for a path in
  // the same sentence, and a path glued to the previous word would be one token
  // the runtime will not resolve. The token is eight characters long.
  assert.deepEqual(insertAtCaret('', 0, '⟦pimg-0⟧'), { text: '⟦pimg-0⟧', caret: 8 });
  assert.deepEqual(insertAtCaret('look at this', 12, '⟦pimg-0⟧'), {
    text: 'look at this ⟦pimg-0⟧',
    caret: 21,
  });
  // Already at a word boundary: no second space.
  assert.deepEqual(insertAtCaret('look at this ', 13, '⟦pimg-0⟧'), {
    text: 'look at this ⟦pimg-0⟧',
    caret: 21,
  });
});

test('a token goes in at the caret, not at the end', () => {
  assert.deepEqual(insertAtCaret('see  and this', 4, '⟦pimg-0⟧'), {
    text: 'see ⟦pimg-0⟧ and this',
    caret: 12,
  });
  // The caret lands just after the token, and a space is added so the next word
  // stays its own token.
  assert.deepEqual(insertAtCaret('seeand this', 3, '⟦pimg-0⟧'), {
    text: 'see ⟦pimg-0⟧ and this',
    caret: 12,
  });
});

test('a caret outside the text is clamped rather than trusted', () => {
  // A stale caret (the draft changed under it) must not slice past the end.
  assert.deepEqual(insertAtCaret('abc', 99, '⟦pimg-0⟧'), { text: 'abc ⟦pimg-0⟧', caret: 12 });
  assert.deepEqual(insertAtCaret('abc', -5, '⟦pimg-0⟧'), { text: '⟦pimg-0⟧ abc', caret: 8 });
});

/* ============================================================
   the tray and the sentence, kept in step
   ============================================================ */

function image(path: string, placeholder: string, bytes = 1024): PastedImage {
  return {
    path,
    placeholder,
    name: nameOfPath(path),
    bytes,
    mime: 'image/png',
    url: `blob:${path}`,
  };
}

const A = image('.tudouni/paste/s-1/a.png', '⟦pimg-0⟧');
const B = image('.tudouni/paste/s-1/b.png', '⟦pimg-1⟧');

test('a chip is drawn only while its placeholder is still in the sentence', () => {
  const images = [A, B];

  // Both marked: both drawn.
  assert.deepEqual(referencedImages('看看这两张 ⟦pimg-0⟧ ⟦pimg-1⟧', images).map((i) => i.path), [
    A.path,
    B.path,
  ]);

  // The person deleted one marker. The tray must follow the text — a chip left
  // behind would claim a picture that is not going anywhere.
  assert.deepEqual(referencedImages('看看这张 ⟦pimg-1⟧', images).map((i) => i.path), [B.path]);

  // Both deleted: no chips at all.
  assert.deepEqual(referencedImages('算了', images), []);
});

test('the tray follows the sentence, not the order the pictures arrived', () => {
  // The person rearranged the tokens by hand: the chips follow, because that is
  // the order the pictures will appear in the message.
  assert.deepEqual(referencedImages('⟦pimg-1⟧ 然后 ⟦pimg-0⟧', [A, B]).map((i) => i.path), [
    B.path,
    A.path,
  ]);
});

test('no images means no work', () => {
  assert.deepEqual(referencedImages('anything at all', []), []);
});

/* ============================================================
   the swap at submit: placeholder out, path in
   ============================================================ */

test('every placeholder becomes its picture’s path, in place', () => {
  assert.equal(
    restorePastedPaths('看看这个 ⟦pimg-0⟧', [A]),
    '看看这个 .tudouni/paste/s-1/a.png',
  );
  assert.equal(
    restorePastedPaths('a ⟦pimg-0⟧ b ⟦pimg-1⟧ c', [A, B]),
    'a .tudouni/paste/s-1/a.png b .tudouni/paste/s-1/b.png c',
  );
});

test('a draft with no pictures is sent byte-for-byte as it is', () => {
  // Nothing stashed: nothing to restore, and the text must not be touched at all.
  assert.equal(restorePastedPaths('just words', []), 'just words');
  // A token the person typed that is not one of the minted ones is prose: it
  // stays, because a restore that rewrites foreign text is an edit no one asked
  // for. (The stashed picture’s marker is missing, so it still ships — as its
  // own trailing word, which is the orphan rule asserted below.)
  assert.equal(
    restorePastedPaths('see ⟦pimg-9⟧', [A]),
    'see ⟦pimg-9⟧ .tudouni/paste/s-1/a.png',
  );
});

test('a picture whose marker the person deleted still ships, as its own trailing word', () => {
  // The chip was still on screen, so the promise is that the picture arrives.
  // Appending the path at the end is the failure with the least surprise: the
  // sentence is untouched where the person edited it, and the extra word is one
  // they can see and delete.
  assert.equal(
    restorePastedPaths('看看这个', [A]),
    '看看这个 .tudouni/paste/s-1/a.png',
  );
  // An empty draft with one orphan: the path alone, still a whole sentence.
  assert.equal(restorePastedPaths('', [A]), '.tudouni/paste/s-1/a.png');
});

test('the restored path lands as its own word, so the scanner resolves it', () => {
  // The swap keeps the token’s spacing: the token sat as a separate word, so the
  // path that takes its place is one too. Gluing it on would make it part of the
  // previous token and the runtime would not find it.
  const out = restorePastedPaths('see ⟦pimg-0⟧ this', [A]);
  assert.deepEqual(out.split(' '), ['see', '.tudouni/paste/s-1/a.png', 'this']);
});

test('one picture marked twice is restored at both places', () => {
  // `replaceAll`, deliberately: a marker the person duplicated by hand is still
  // two mentions of the same picture, and the runtime dedupes the second naming.
  assert.equal(
    restorePastedPaths('⟦pimg-0⟧ and again ⟦pimg-0⟧', [A]),
    '.tudouni/paste/s-1/a.png and again .tudouni/paste/s-1/a.png',
  );
});

/* ============================================================
   dismissing a chip
   ============================================================ */

test('dismissing a chip takes its marker out of the sentence', () => {
  assert.equal(removePlaceholderFromDraft('看看这个 ⟦pimg-0⟧', '⟦pimg-0⟧'), '看看这个');
  // The hole the token left is closed, so the sentence does not keep a double space.
  assert.equal(removePlaceholderFromDraft('see ⟦pimg-0⟧ and this', '⟦pimg-0⟧'), 'see and this');
  // The only word: nothing left.
  assert.equal(removePlaceholderFromDraft('⟦pimg-0⟧', '⟦pimg-0⟧'), '');
});

test('dismissing one picture leaves the others alone', () => {
  const draft = 'a ⟦pimg-0⟧ ⟦pimg-1⟧ b';
  assert.equal(removePlaceholderFromDraft(draft, '⟦pimg-0⟧'), 'a ⟦pimg-1⟧ b');
});

test('a marker the person edited by hand is not a chip to dismiss', () => {
  // The placeholder is one this front end minted; the tray only matches it whole.
  // A string the person typed that *contains* it is still removed, which is the
  // right answer: it is the token, glued to their prose, and only the token
  // comes out.
  assert.equal(removePlaceholderFromDraft('x⟦pimg-0⟧', '⟦pimg-0⟧'), 'x');
  assert.equal(removePlaceholderFromDraft('⟦pimg-1⟧', '⟦pimg-0⟧'), '⟦pimg-1⟧');
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
