/**
 * Pasting into the composer: pictures, and long text folded into a chip.
 *
 * The runtime's only image channel is a **path in the user's sentence**
 * (`internal/runtime/images.go`: there is no upload command and no markup).
 * This handler therefore still writes the picture into a file inside the
 * workspace — but the draft receives a **placeholder**, not the path. The
 * path goes into the sentence at submit time (`restorePastedPaths`), which is
 * why the runtime sees exactly the text it always has: the person sees a chip
 * in the input, and the wire carries `.tudouni/paste/paste-1759...-1.png`.
 * Everything else — the scanner, the size ceiling, the vision gate, the
 * degradation ladder — is already there and is not duplicated here.
 *
 * ## The one rule that matters most
 *
 * **An ordinary paste of text must behave exactly as it did before.** So the
 * handler answers `false` (the editor's own paste runs) unless the clipboard
 * really holds a picture, or text past `LONG_PASTE_CHARS`. Intercepting every
 * paste would break the ordinary case (a sentence, a path, a snippet) in the
 * name of the rare one — the composer is the one control a person uses
 * constantly.
 *
 * A file copied in the file manager is left alone too, deliberately. Windows puts
 * both a file list and text on the clipboard for it, so the default paste already
 * inserts a path — which is a path the runtime can resolve if the file is in the
 * workspace.
 *
 * ## Why the gates are checked here and not only in Rust
 *
 * The Rust side re-checks all of them, but a refusal from there is an error
 * string that has to be turned into a sentence. Checking first means the
 * sentence is written where the wording lives, and the round trip is skipped for
 * something that cannot succeed.
 *
 * ## Why every picture is read before the first one is inserted
 *
 * One gesture is one body (`stashImages`): the pictures are framed together and
 * written by one call, which keeps a remote paste to a single SSH handshake. The
 * refusals therefore have to be finished first — a batch cannot be half refused.
 * The chips appear at that point, before the write finishes (`pendingImages`).
 */

import { activeRuntime, useApp } from '@/state/store';
import {
  LONG_PASTE_CHARS,
  MAX_IMAGE_BYTES,
  classify,
  formatBytes,
  referencedImages,
  refuseBeforeRead,
  type PastedPicture,
  type PasteRefusal,
} from '@/runtime/paste';
import type { ComposerNotice } from '@/state/store';
import { placeComposerCaret } from '@/components/chrome/composerBridge';

/**
 * Handle one paste into the composer. `caret` is the draft offset the paste
 * lands at, read by the caller **before** anything changes: the store's write
 * re-renders the box, and an offset read after that describes the new text.
 *
 * Returns `true` when the paste was taken over (the caller must then stop the
 * default), `false` to let the editor paste as usual.
 */
export function handleComposerPaste(clipboard: DataTransfer | null, caret: number): boolean {
  if (!clipboard) return false;

  // The pictures on the clipboard. `items` rather than `files` because an item
  // carries the type before a `File` exists.
  const pictures: File[] = [];
  for (const item of Array.from(clipboard.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) pictures.push(file);
  }

  if (pictures.length === 0) {
    // A long text is folded into one chip at the caret; anything shorter is the
    // editor's to paste.
    const text = clipboard.getData('text/plain').replace(/\r\n?/g, '\n');
    if (text.length <= LONG_PASTE_CHARS) return false;
    const moved = useApp.getState().pasteLongText(text, caret);
    if (moved !== null) placeComposerCaret(moved);
    return true;
  }

  const rt = activeRuntime(useApp.getState());
  const workspace = rt?.session?.workspace ?? rt?.workspace ?? '';

  void (async () => {
    // How many pictures this front end would actually send: the ones still
    // named in the sentence, **completed or still being written**.
    const now = activeRuntime(useApp.getState());
    const countOf =
      referencedImages(now?.draft ?? '', now?.pastedImages ?? []).length +
      referencedImages(now?.draft ?? '', now?.pendingImages ?? []).length;

    const ready: PastedPicture[] = [];
    for (const picture of pictures) {
      // Before reading a byte: the ceiling exists to keep a large file out of
      // memory, and holding it in memory to measure it defeats that.
      const refusal = refuseBeforeRead(picture.size, workspace, countOf + ready.length);
      if (refusal) {
        useApp.getState().setComposerNotice(noticeFor(refusal));
        return;
      }
      const bytes = new Uint8Array(await picture.arrayBuffer());
      // The bytes decide, never `picture.type`: that field is what the clipboard
      // *claims*, and the runtime sniffs the same way.
      const kind = classify(bytes);
      if (kind === null) {
        useApp.getState().setComposerNotice({ code: 'paste-not-an-image', tone: 'warn' });
        return;
      }
      ready.push({ bytes, mime: kind.mime });
    }

    // `pasteImages` inserts every placeholder immediately and settles when the
    // write does; the caret is placed as soon as the chips are in the draft.
    const settled = useApp.getState().pasteImages(ready, caret);
    const inserted = activeRuntime(useApp.getState())?.draft ?? '';
    const lastToken = /⟦pimg-\d+⟧/g;
    let end = -1;
    for (const m of inserted.matchAll(lastToken)) {
      if ((m.index ?? 0) >= caret) {
        end = (m.index ?? 0) + m[0].length;
      }
    }
    if (end >= 0) placeComposerCaret(end);
    const moved = await settled;
    if (moved === null) return;

    // A heads-up, not a refusal: the turn still runs, with the path in the
    // sentence. An unknown model says nothing: `vision` absent is not
    // `vision: false`.
    const finalState = useApp.getState();
    const current = activeRuntime(finalState)?.models.find((model) => model.current);
    finalState.setComposerNotice(
      current && !current.vision ? { code: 'paste-no-vision', model: current.id, tone: 'info' } : null,
    );
  })();
  return true;
}

/** One refusal from the pure gate, as the composer's notice. */
function noticeFor(refusal: PasteRefusal): ComposerNotice {
  switch (refusal.code) {
    case 'no-workspace':
      return { code: 'paste-no-workspace', tone: 'warn' };
    case 'at-capacity':
      return { code: 'paste-at-capacity', limit: refusal.limit, tone: 'warn' };
    case 'too-large':
      return {
        code: 'paste-too-large',
        size: formatBytes(refusal.size),
        limit: formatBytes(MAX_IMAGE_BYTES),
        tone: 'warn',
      };
    case 'not-an-image':
      return { code: 'paste-not-an-image', tone: 'warn' };
  }
}
