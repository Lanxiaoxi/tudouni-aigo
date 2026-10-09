/**
 * Pictures pasted into the composer, decided as pure functions.
 *
 * The whole feature rests on the same fact the drop handler rests on: **a path is
 * the only channel a picture travels on.** `internal/runtime/images.go` scans the
 * user's sentence for path-shaped words, stores what resolves, and attaches it.
 * There is no upload command and no markup.
 *
 * A drop already has an absolute path, handed over by the OS. A paste does not:
 * the clipboard carries **bytes**, and the WebView has no filesystem. So the
 * bytes go to the Rust side to be written (see `image_stash` in `src-tauri`), and
 * this module owns everything that can be decided **before** that call, plus the
 * placeholder text operations that follow it.
 *
 * **The draft carries a placeholder, not the path.** The path has to be in the
 * sentence *when it goes out*, and it can be a short marker while it is being
 * written: `nextPlaceholder` mints the token, `insertAtCaret` puts it in the
 * draft, `restorePastedPaths` swaps it for the path at submit time, and
 * `removePlaceholderFromDraft` takes it out again when a chip is dismissed. The
 * runtime never sees a placeholder, and the person never sees a path.
 *
 * The three gates are all mirrors of the runtime's own rules, and the reason to
 * mirror rather than invent is that a refusal here is a sentence a person reads
 * immediately, while the same refusal there arrives after a round trip:
 *
 *   - **inside the workspace** — `tools.Workspace.SafePath` is the boundary, and
 *     a path outside it is one the runtime cannot resolve;
 *   - **png / jpeg / gif** — `content.ImageMIMEs`, decided from the **bytes**
 *     (`http.DetectContentType` there, magic numbers here), never from the
 *     clipboard's declared type, because a `.png` that is really a JPEG is
 *     common and a media type that disagrees with the data is refused downstream;
 *   - **5MB** — `content.MaxImageBytes`.
 *
 * Two numbers are therefore hard-coded here, and both say where they come from.
 * That is the established pattern for this boundary: `src-tauri/src/lib.rs`'s
 * `unsafe_workspace` mirrors `paths.UnsafeWorkspace` for the same reason, and the
 * comment there says the two must not drift.
 */

/** The per-picture ceiling. Mirrors `content.MaxImageBytes`
 *  (`internal/content/content.go`) — the smallest request-side limit of the three
 *  protocols this program speaks, in its base64 form. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * How many pictures one message may carry. Mirrors
 * `content.MaxImagesPerMessage` (`internal/content/paths.go`).
 *
 * The front end counts only the pictures **it** stashed, which is a deliberate
 * limit rather than an oversight: the real cap counts every picture named in the
 * sentence, including dropped paths and ones typed by hand, and only the runtime
 * sees all of them. So this is the ceiling on this front end's own contribution,
 * and the runtime's `over_limit` row stays the authority on the total.
 */
export const MAX_IMAGES_PER_MESSAGE = 10;

/** The three formats the runtime can measure and every wire protocol accepts.
 *  WebP is absent for the same reason it is absent there: no decoder means no
 *  dimensions and no thumbnail. */
export interface ImageType {
  mime: string;
  /** The extension to store it under. Decided from the bytes, never from what
   *  the clipboard claimed. */
  ext: string;
}

export type PasteRefusal =
  | { code: 'no-workspace' }
  | { code: 'at-capacity'; limit: number }
  | { code: 'too-large'; size: number; limit: number }
  | { code: 'not-an-image'; declared: string };

/**
 * A pasted picture in the draft is **a placeholder, not a path**.
 *
 * The runtime's only image channel is a path-shaped word in the sentence
 * (`internal/runtime/images.go`), so the sentence that goes out the door must
 * still name the file — but the sentence the person *reads* should be the
 * sentence they typed. A path like `.tudouni/paste/paste-1759...-1.png` is
 * machine noise in a conversation, so the draft carries a short marker and the
 * real path is put back at submit time (`restorePastedPaths`). The runtime
 * never sees a placeholder; it is a front-end concern that ends at the wire.
 */

/**
 * Build the next placeholder.
 *
 * The shape is deliberately far from anything the runtime's scanner could read
 * as a path: the `⟦⟧` brackets are not in its path-character set (nor are they
 * whitespace, so the token survives intact), and the name is a literal — the
 * front end is English-only, so the marker does not need to follow the user's
 * language. Numbered, because one sentence can carry several pictures and the
 * person should be able to point at one in the text ("the second one").
 *
 * `taken` is what the **draft** already contains — not what is stashed — so a
 * number the person deleted is recycled rather than skipped: the sentence is
 * the surface these tokens live on, and a gap (`1`, `3`) reads as a mistake.
 */
export function nextPlaceholder(taken: string): string {
  let number = 0;
  let candidate = `⟦pimg-${number}⟧`;
  while (taken.includes(candidate)) {
    number += 1;
    candidate = `⟦pimg-${number}⟧`;
  }
  return candidate;
}

/**
 * The text that goes to the runtime, from the text the person wrote.
 *
 * Every placeholder is swapped for its picture's path — the path the scanner
 * will resolve, and the one the runtime's notices quote, so what arrives is
 * exactly the sentence it always arrived as.
 *
 * **A placeholder the person deleted is not a lost picture.** The picture is
 * stashed and the chip is still on screen; what is gone is the *marker*.
 * Appending the path at the end keeps the promise that a visible chip always
 * ships a picture, in the failure mode that costs the least surprise: the
 * sentence is untouched where the person edited it, and the extra word at the
 * end is one they can see and delete — unlike a picture that silently never
 * arrived.
 *
 * The path is appended as its own trailing word: the scanner splits on
 * whitespace, so a path glued to the last word is one token it will not
 * resolve, and a silently unattached picture is the one failure this layer
 * exists to prevent.
 */
export function restorePastedPaths(draft: string, images: PastedImage[]): string {
  if (images.length === 0) return draft;
  let text = draft;
  const orphans: string[] = [];
  for (const image of images) {
    if (text.includes(image.placeholder)) {
      text = text.replaceAll(image.placeholder, image.path);
    } else {
      orphans.push(image.path);
    }
  }
  if (orphans.length === 0) return text;
  const trail = text === '' || /\s$/.test(text) ? '' : ' ';
  return `${text}${trail}${orphans.join(' ')}`;
}

/** Remove one placeholder from the draft — what a chip's dismiss button does.
 *
 * Same reason it edits text rather than a list: the text is the only surface
 * that exists, and leaving the marker where a chip was removed would make the
 * sentence promise a picture the tray no longer shows. The hole is closed and
 * runs of spaces collapse, so the sentence does not keep a gap where the
 * token was.
 */
export function removePlaceholderFromDraft(draft: string, placeholder: string): string {
  return draft
    .split(placeholder)
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** One picture this front end stashed, as the composer needs to know it. */
export interface PastedImage {
  /** The workspace-relative path — what the sentence names at submit time. */
  path: string;
  /** The token standing for this picture in the draft while it is being written. */
  placeholder: string;
  /** The file's own name, for the chip's label. */
  name: string;
  bytes: number;
  mime: string;
  /** A `blob:` URL for the thumbnail. Created by the caller — this module stays
   *  free of side effects so it can be tested directly. */
  url: string;
}

/**
 * Identify a picture from its leading bytes.
 *
 * Magic numbers rather than the clipboard's `type`, because that field is a claim
 * about what the clipboard *says* it holds and this is what it actually holds.
 * The runtime makes the same decision the same way (`http.DetectContentType`), so
 * a file this accepts is one that layer accepts — which is the point of doing it
 * here at all rather than letting the refusal arrive a round trip later.
 *
 * The three signatures are the shortest ones that are unambiguous. JPEG's is two
 * bytes and could in principle appear in something else; that is acceptable
 * because the runtime re-checks the bytes on the way in, and a false accept here
 * costs a sentence from there rather than a wrong picture.
 */
export function classify(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 8 && matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (bytes.length >= 3 && matches(bytes, [0xff, 0xd8, 0xff])) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (bytes.length >= 6 && matches(bytes, [0x47, 0x49, 0x46, 0x38])) {
    // GIF87a and GIF89a share the first four bytes; the fifth and sixth are the
    // version letters. Both are accepted, and both are stored as `.gif`.
    return { mime: 'image/gif', ext: 'gif' };
  }
  return null;
}

function matches(bytes: Uint8Array, signature: number[]): boolean {
  for (let index = 0; index < signature.length; index++) {
    if (bytes[index] !== signature[index]) return false;
  }
  return true;
}

/**
 * Everything that can be refused from the blob's size alone — before its bytes
 * are read.
 *
 * The order is the one that matters and is not cosmetic: the size is checked
 * **before** the read, because the ceiling exists to keep a large file out of
 * memory, and holding it in memory to measure it defeats that. The same order is
 * in the runtime's `storePicture`, for the same reason.
 *
 * `existing` is how many pictures this front end has already stashed for the
 * draft. See `MAX_IMAGES_PER_MESSAGE` for why that is not the whole cap.
 */
export function refuseBeforeRead(
  size: number,
  workspace: string,
  existing: number,
): PasteRefusal | null {
  if (normalizeWorkspace(workspace) === '') return { code: 'no-workspace' };
  if (existing >= MAX_IMAGES_PER_MESSAGE) {
    return { code: 'at-capacity', limit: MAX_IMAGES_PER_MESSAGE };
  }
  if (size > MAX_IMAGE_BYTES) {
    return { code: 'too-large', size, limit: MAX_IMAGE_BYTES };
  }
  return null;
}

/** A workspace of only whitespace is no workspace: the runtime cannot be
 *  started in it and `SafePath` would have no root to compare against. */
function normalizeWorkspace(workspace: string): string {
  return workspace.trim();
}

/**
 * Insert a token at the caret, keeping it a separate word.
 *
 * Separate on both sides, and that is load-bearing rather than tidy: at submit
 * the placeholder is swapped for a path in the **same** sentence (`restorePastedPaths`),
 * and a path glued to the word in front of it would be one token the runtime's
 * scanner will not resolve — so the spacing that is kept here is what keeps the
 * restored path its own word.
 *
 * The caret lands **after** the token, before any space added for the following
 * text, so typing continues where the person expects.
 */
export function insertAtCaret(
  draft: string,
  caret: number,
  token: string,
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  const lead = before === '' || /[\s\p{Cc}]$/u.test(before) ? '' : ' ';
  const trail = after === '' || /^[\s\p{Cc}]/u.test(after) ? '' : ' ';
  return {
    text: `${before}${lead}${token}${trail}${after}`,
    caret: before.length + lead.length + token.length,
  };
}

/**
 * The pictures the draft still carries.
 *
 * A picture is in the draft exactly while its **placeholder** is: a chip is
 * drawn for it and it ships when the sentence goes out. The person deletes the
 * marker — not a path, since there is no path in the sentence — and the chip
 * follows; the file stays on disk but goes nowhere, which is the same as
 * deleting the path used to mean.
 *
 * The matching is by literal token, and it can be trusted, because the
 * placeholder is one this front end minted and nobody else writes it. That is
 * the point of moving the draft off paths: the tray no longer has to re-port the
 * runtime's scanner to agree with what the runtime will resolve — the sentence
 * the tray reads and the one that gets sent differ only by the swap
 * `restorePastedPaths` performs.
 *
 * Order of the result follows the **sentence**, not the order they were pasted:
 * that is the order the pictures will appear in the message.
 */
export function referencedImages(draft: string, images: PastedImage[]): PastedImage[] {
  if (images.length === 0) return [];
  const placed = images
    .map((image) => ({ image, at: draft.indexOf(image.placeholder) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at);
  return placed.map((entry) => entry.image);
}

/**
 * The file's own name, from the path the runtime will read.
 *
 * Taken from the path rather than from the clipboard, because the clipboard's
 * name is not what the file is called: the Rust side generates the name, and this
 * is only a label for a person to recognise the chip by.
 */
export function nameOfPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/**
 * A byte count the way a person reads it. Mirrors `content.HumanSize`, so the
 * same file is not "1.5MB" in one sentence and "1536KB" in the next — the two
 * appear side by side when the runtime reports an oversized picture.
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0B';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.floor(bytes / 1024)}KB`;
  return `${bytes}B`;
}
