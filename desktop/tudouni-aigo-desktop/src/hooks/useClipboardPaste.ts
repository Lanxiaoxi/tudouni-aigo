/**
 * Pasting a picture into the composer.
 *
 * The runtime's only image channel is a **path in the user's sentence**
 * (`internal/runtime/images.go`: there is no upload command and no markup), so
 * this handler does exactly two things: put the clipboard's bytes into a file
 * inside the workspace, and write that file's path into the draft. Everything
 * else — the scanner, the size ceiling, the vision gate, the degradation ladder —
 * is already there and is not duplicated here.
 *
 * ## The one rule that matters most
 *
 * **A paste of text must behave exactly as it did before.** So the handler
 * returns without doing anything unless the clipboard really holds a picture, and
 * only then calls `preventDefault`. Intercepting every paste to look for an image
 * would break the ordinary case (a sentence, a path, a snippet) in the name of
 * the rare one, and that is the regression this feature can least afford — the
 * composer is the one control a person uses constantly.
 *
 * A file copied in the file manager is left alone too, deliberately. Windows puts
 * both a file list and text on the clipboard for it, so the default paste already
 * inserts a path — which is a path the runtime can resolve if the file is in the
 * workspace. Handling it here would replace a working behaviour with a second
 * copy of it.
 *
 * ## Why the gates are checked here and not only in Rust
 *
 * The Rust side re-checks all of them (different process, different language), but
 * a refusal from there is an error string that has to be turned into a sentence.
 * Checking first means the sentence is written where the wording lives, and the
 * round trip is skipped for something that cannot succeed.
 */

import { useCallback, type ClipboardEvent, type RefObject } from 'react';
import { useApp, type ComposerNotice } from '@/state/store';
import {
  MAX_IMAGE_BYTES,
  classify,
  formatBytes,
  referencedImages,
  refuseBeforeRead,
  type PasteRefusal,
} from '@/runtime/paste';

export function useClipboardPaste(
  taRef: RefObject<HTMLTextAreaElement | null>,
): (e: ClipboardEvent<HTMLTextAreaElement>) => void {
  return useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const clipboard = e.clipboardData;
      if (!clipboard) return;

      // The pictures on the clipboard, and nothing else. `items` rather than
      // `files` because an item is what carries the type before a `File` exists;
      // a clipboard holding only text has no `image/*` item and this returns
      // immediately, leaving the browser's own paste untouched.
      const pictures: File[] = [];
      for (const item of Array.from(clipboard.items ?? [])) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file) pictures.push(file);
      }
      if (pictures.length === 0) return;

      // From here on the paste is ours, so the default must be stopped — a
      // browser would otherwise try to insert the picture itself and produce
      // nothing visible in a textarea.
      e.preventDefault();

      const state = useApp.getState();
      const workspace = state.session?.workspace ?? '';
      // The caret is tracked **here** rather than re-read from the DOM inside the
      // loop. The store's `set` re-renders the textarea, and until that render
      // lands `selectionStart` still describes the old string — so a second
      // picture pasted in the same gesture would be inserted at a position that
      // belongs to the previous text. The store hands back where the caret went,
      // and that is what the next insertion is placed against.
      let at = taRef.current?.selectionStart ?? state.draft.length;

      void (async () => {
        // How many pictures this front end would actually send: the ones still
        // named in the sentence. Counting stashed-but-deleted ones would refuse a
        // paste for pictures that are not going anywhere.
        let existing = referencedImages(
          useApp.getState().draft,
          useApp.getState().pastedImages,
        ).length;

        for (const picture of pictures) {
          // Before reading a byte: the ceiling exists to keep a large file out of
          // memory, and holding it in memory to measure it defeats that.
          const refusal = refuseBeforeRead(picture.size, workspace, existing);
          if (refusal) {
            useApp.getState().setComposerNotice(noticeFor(refusal));
            return;
          }

          const bytes = new Uint8Array(await picture.arrayBuffer());

          // The bytes decide, never `picture.type`: that field is what the
          // clipboard *claims*, and a `.png` that is really a JPEG is common. The
          // runtime sniffs the same way, so a file refused here is one it would
          // have refused too.
          if (classify(bytes) === null) {
            useApp.getState().setComposerNotice({ code: 'paste-not-an-image', tone: 'warn' });
            return;
          }

          const moved = await useApp.getState().stashPastedImage(bytes, at);
          // A null answer means the store already recorded why nothing was
          // inserted, so there is nothing left to say here.
          if (moved === null) return;
          existing += 1;
          // The next path goes where this one ended, so several pictures pasted
          // together read in the order they arrived.
          at = moved;

          // The caret follows the inserted path. Deferred by a frame because the
          // store's `set` re-renders the textarea with the new value, and setting
          // a selection before that lands on the old string.
          requestAnimationFrame(() => {
            const element = taRef.current;
            if (!element) return;
            element.selectionStart = moved;
            element.selectionEnd = moved;
            element.focus();
          });
        }

        // A heads-up, not a refusal: the turn still runs, with the path in the
        // sentence, exactly as the runtime's own `refused` row describes. Saying
        // it now is worth the one line, because the alternative is a person
        // attaching a screenshot, getting an answer about the words, and having
        // to work out why.
        //
        // An unknown model says nothing: `vision` absent is not `vision: false`,
        // and claiming either would be inventing a fact.
        const current = useApp.getState().models.find((model) => model.current);
        useApp.getState().setComposerNotice(
          current && !current.vision
            ? { code: 'paste-no-vision', model: current.id, tone: 'info' }
            : null,
        );
      })();
    },
    [taRef],
  );
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
