/**
 * The one door from the rest of the window into the composer's caret.
 *
 * Every caller that inserts into the draft — the plus menu, the Explorer, the
 * paste handler — works in **draft offsets**, because the store's insertions
 * (`insertAtCaret`, `pasteImages`, `attachFilePath`) are string operations. The
 * editor works in document positions. The composer registers a handle here that
 * answers in offsets, so no caller has to know there is an editor at all; before
 * this, three of them reached for `.composer textarea` with `querySelector`.
 *
 * With no composer mounted the answers fall back to "the end of the draft",
 * which is where an insertion without a caret has always gone.
 */

export interface ComposerHandle {
  /** The caret (selection head) as a draft offset. */
  caret(): number;
  /** Put the caret at a draft offset and focus the box. The draft may still be
   *  catching up with a store write; the handle applies it once it has. */
  placeCaret(offset: number): void;
}

let handle: ComposerHandle | null = null;

export function registerComposer(next: ComposerHandle): () => void {
  handle = next;
  return () => {
    if (handle === next) handle = null;
  };
}

/** The caret as a draft offset, or `fallback` when no composer is mounted. */
export function composerCaret(fallback: number): number {
  return handle?.caret() ?? fallback;
}

/** Move the caret to `offset` (a draft offset) once the draft has landed. */
export function placeComposerCaret(offset: number): void {
  handle?.placeCaret(offset);
}
