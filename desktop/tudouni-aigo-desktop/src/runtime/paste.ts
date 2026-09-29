/**
 * Pictures pasted into the composer, decided as pure functions.
 *
 * The whole feature rests on the same fact the drop handler rests on: **a path is
 * the only channel a picture travels on.** `internal/runtime/images.go` scans the
 * user's sentence for path-shaped words, stores what resolves, and attaches it.
 * There is no upload command and no markup. So a paste can only ever do one
 * thing — put the picture on disk *inside the workspace* and write its path into
 * the sentence.
 *
 * A drop already has an absolute path, handed over by the OS. A paste does not:
 * the clipboard carries **bytes**, and the WebView has no filesystem. So the
 * bytes go to the Rust side to be written (see `image_stash` in `src-tauri`), and
 * this module owns everything that can be decided **before** that call, plus the
 * two text operations that follow it.
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

/** One picture this front end stashed, as the composer needs to know it. */
export interface PastedImage {
  /** The workspace-relative path exactly as it was written into the sentence. */
  path: string;
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
 * Insert a path at the caret, keeping it a separate word.
 *
 * Separate on both sides, and that is load-bearing rather than tidy: the runtime
 * finds pictures by splitting the sentence into tokens (`content.FindImagePaths`)
 * and asking the filesystem about each one. A path glued to the word in front of
 * it is a single token, and the reading that would rescue it (`看这个/a.png`) is a
 * guess the scanner offers rather than a rule it applies — so a paste that
 * silently failed to attach is exactly the failure this spacing prevents.
 *
 * The caret lands **after** the path, before any space added for the following
 * text, so typing continues where the person expects.
 */
export function insertPathAtCaret(
  draft: string,
  caret: number,
  path: string,
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  const lead = before === '' || /[\s\p{Cc}]$/u.test(before) ? '' : ' ';
  const trail = after === '' || /^[\s\p{Cc}]/u.test(after) ? '' : ' ';
  return {
    text: `${before}${lead}${path}${trail}${after}`,
    caret: before.length + lead.length + path.length,
  };
}

/**
 * The pictures still named in the draft.
 *
 * **The text is the single source of truth**, because the text is the only thing
 * that gets sent: the runtime never hears about a chip. So a chip is drawn while
 * its path is still in the sentence and disappears the moment the person deletes
 * that word — no second piece of state to keep in step, and no way for the tray
 * to claim a picture that is not going anywhere.
 *
 * The matching is a **port of the runtime's own scanner** (`content.FindImagePaths`
 * and `content.pathCandidates`), not a `includes` check, and that is the whole
 * difficulty of this function. A token in a sentence is wrapped in punctuation and,
 * in Chinese input, glued to the words around it, so the scanner offers several
 * readings and lets the filesystem pick. Comparing the raw token would therefore
 * be wrong in both directions at once:
 *
 *   - it would **miss** a picture the runtime does attach, when the path arrives
 *     inside brackets (`看这个（a.png）。`) or after prose with no separator;
 *   - it would **claim** one it does not, when the token only *contains* the path
 *     (`xa.png` does not name `a.png`).
 *
 * A missed chip is a picture the person cannot see is attached; a false chip is a
 * picture they believe is attached. Both are the "plausible screen" failure this
 * file exists to avoid, so the readings are reproduced here in the same order.
 *
 * Order of the result follows the **sentence**, not the order they were pasted:
 * that is the order the pictures will appear in the message.
 */
export function referencedImages(draft: string, images: PastedImage[]): PastedImage[] {
  if (images.length === 0) return [];
  const stashed = new Map<string, PastedImage>();
  for (const image of images) stashed.set(image.path, image);

  const found: PastedImage[] = [];
  const seen = new Set<string>();
  for (const token of splitTokens(draft)) {
    for (const candidate of pathCandidates(token)) {
      const image = stashed.get(candidate);
      if (image === undefined) continue;
      // The first reading that really is one of this front end's files is the one
      // the resolver would take, so the walk stops here — a later reading is only
      // reached when an earlier one does not exist, which is not this case.
      if (!seen.has(image.path)) {
        seen.add(image.path);
        found.push(image);
      }
      break;
    }
  }
  return found;
}

/** Split a sentence into tokens the way `content.FindImagePaths` does: on
 *  whitespace **and control characters**. */
function splitTokens(text: string): string[] {
  return text.split(/[\s\p{Cc}]+/u).filter((token) => token !== '');
}

/**
 * Remove one picture's path from the sentence — what a chip's dismiss button does.
 *
 * It edits the **text**, not a list of attachments, and that is the whole design
 * in one function: the text is what gets sent, so dropping the path is what
 * actually un-attaches the picture. Anything else would leave a chip's absence
 * and the message disagreeing.
 *
 * The match is by token, not by substring, so dismissing `a.png` cannot damage
 * `xa.png` or a sentence that happens to contain those letters. It walks the same
 * candidate readings `referencedImages` does, for the same reason: the token in
 * the sentence may be `看这个（a.png）。` and the path to remove is `a.png`.
 *
 * Surrounding whitespace is collapsed so the sentence does not keep a hole where
 * the path was, and the result is trimmed at both ends.
 */
export function removePathFromDraft(draft: string, path: string): string {
  const tokens = draft.split(/([\s\p{Cc}]+)/u);
  const kept: string[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const token = tokens[index];
    const separator = tokens[index + 1] ?? '';
    // The token is edited only when the path is one of the readings it resolves
    // to — exactly the condition `referencedImages` used to draw its chip, so a
    // chip that is on screen can always be dismissed.
    if (!pathCandidates(token).includes(path)) {
      kept.push(token + separator);
      continue;
    }
    // **Only the path comes out, never the whole token.** A path glued to prose
    // (`看这个（a.png）。`) is a single token, and dropping the token would delete
    // words the person wrote — silently, and as the result of an action they took
    // to remove a *picture*. The path is always a substring of the token, because
    // every candidate is derived from it by trimming or slicing.
    const at = token.indexOf(path);
    const rest = at < 0 ? token : token.slice(0, at) + token.slice(at + path.length);
    kept.push(rest + separator);
  }
  // Runs of **spaces and tabs** collapse, so removing a word does not leave a
  // double space behind. Newlines are deliberately left alone: a draft can be
  // several lines, and flattening it into one would be a much bigger edit than
  // the one that was asked for.
  return kept.join('').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Strip the punctuation a path is routinely wrapped in — `content.trimToken`.
 *
 * Two rounds, because `("/a.png"),` needs both: the comma comes off first and
 * exposes the bracket, which the second round removes. Note what is **not** in
 * these sets: a smart quote (`“”`) is not an ASCII quote, so a path wrapped in
 * one keeps it and the runtime does not resolve it either. That agreement is the
 * point — the tray must not promise an attachment that will not happen.
 */
function trimToken(token: string): string {
  let trimmed = token.trim();
  for (let round = 0; round < 2; round++) {
    trimmed = trimmed.replace(/^["'`]+|["'`]+$/g, '');
    trimmed = trimmed.replace(/^[()[\]{}<>（）【】《》「」]+|[()[\]{}<>（）【】《》「」]+$/g, '');
    trimmed = trimmed.replace(/[.,;:!?，。、；：！？…]+$/, '');
  }
  return trimmed.replace(/^@/, '').trim();
}

/** `filepath.Ext`: the suffix from the final dot **in the final path element**,
 *  so `a.b/c` has none. */
function extensionOf(value: string): string {
  for (let index = value.length - 1; index >= 0; index--) {
    const character = value[index];
    if (character === '/' || character === '\\') return '';
    if (character === '.') return value.slice(index);
  }
  return '';
}

/** `content.IsImagePath`: the same three formats the runtime can measure. */
function isImagePath(value: string): boolean {
  const extension = extensionOf(value.trim()).toLowerCase();
  return extension === '.png' || extension === '.jpg' || extension === '.jpeg' || extension === '.gif';
}

/**
 * `content.looksLikePicture`: the right extension **and** a name in front of it.
 *
 * The name matters: `the .png format is lossless` is a sentence about an
 * extension, and a scanner that accepted `.png` would send the resolver looking
 * for a file literally called `.png` in the workspace.
 */
function looksLikePicture(value: string): boolean {
  if (!isImagePath(value)) return false;
  const name = value.slice(0, value.length - extensionOf(value).length);
  return name !== '' && name !== '.' && name !== '..';
}

/** `content.isPathByte`: the characters a path can be built from, ASCII only. */
function isPathByte(character: string): boolean {
  if (character.length !== 1) return false;
  const code = character.charCodeAt(0);
  if (code < 0x20 || code > 0x7e) return false;
  if ((code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a)) return true; // a-z A-Z
  if (code >= 0x30 && code <= 0x39) return true; // 0-9
  return '/\\._-~'.includes(character);
}

/** `content.asciiSuffix`: the longest tail made only of path characters, which is
 *  the reading for a picture glued to a Chinese word with no separator. */
function asciiSuffix(value: string): string {
  let start = value.length;
  for (let index = value.length - 1; index >= 0; index--) {
    if (!isPathByte(value[index])) break;
    start = index;
  }
  if (start >= value.length) return '';
  const suffix = value.slice(start);
  return looksLikePicture(suffix) ? suffix : '';
}

/**
 * `content.pathCandidates`: the ways one token could be read as a picture's path,
 * most likely first. No candidates means "this token is not a path at all".
 *
 * Nothing is decided here in the runtime and nothing is decided here either — the
 * caller walks the readings and takes the first that is real. The order is
 * reproduced exactly, because it is the order the resolver tries them in and
 * therefore the order that decides which picture a token refers to.
 */
function pathCandidates(token: string): string[] {
  const trimmed = trimToken(token);
  if (!looksLikePicture(trimmed)) return [];

  const candidates = [trimmed];

  // Reading 2: from the first separator on, for `看这个/tmp/a.png`.
  const firstSeparator = trimmed.search(/[/\\]/);
  if (firstSeparator > 0) candidates.push(trimmed.slice(firstSeparator));

  // Reading 3: the longest all-ASCII tail, for `看这个shot.png`.
  const suffix = asciiSuffix(trimmed);
  if (suffix !== '' && suffix !== trimmed) candidates.push(suffix);

  // Reading 4: the last segment, for `截图/首页.png` written inside prose.
  const lastSeparator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (lastSeparator >= 0 && lastSeparator + 1 < trimmed.length) {
    candidates.push(trimmed.slice(lastSeparator + 1));
  }

  return [...new Set(candidates)];
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
