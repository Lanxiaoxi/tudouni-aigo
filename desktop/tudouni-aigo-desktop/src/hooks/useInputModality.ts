/**
 * Track whether the last interaction came from a pointer or the keyboard.
 *
 * This exists because **`:focus-visible` cannot answer the question for a text
 * field**. Browsers deliberately match it whenever a `<textarea>` or `<input>` is
 * focused, regardless of how focus got there — the caret is something the user
 * needs to locate, so suppressing its indicator on a click was judged worse than
 * showing it. That is the right default for a form on a web page, and the wrong
 * one here: the composer's ring is drawn around the *whole* 980px box, so a
 * person who simply clicked to type gets a green rectangle around a third of the
 * window.
 *
 * So the modality is tracked explicitly and published as `data-input-mode` on
 * `<html>`, which CSS reads. It is deliberately a **global document attribute**
 * rather than React state:
 *
 *   - the listeners are on `window` in the capture phase, so they see the event
 *     before any component can `stopPropagation` it;
 *   - nothing re-renders. A `useState` here would re-render the composer (and,
 *     with the store, potentially the tree) on every mousedown and keydown in the
 *     window, to change one outline.
 *
 * `keydown` rather than `keyup`: pressing Tab should show the ring on the frame
 * focus moves, not one key-release later.
 */

import { useEffect } from 'react';

export function useInputModality(): void {
  useEffect(() => {
    const root = document.documentElement;

    const toKeyboard = () => root.setAttribute('data-input-mode', 'keyboard');
    const toPointer = () => root.setAttribute('data-input-mode', 'pointer');

    // Start as `pointer`: the first thing anybody does with a window is look at
    // it, and no ring should be lit until there is a reason.
    toPointer();

    // Capture phase, so a component that stops propagation cannot hide the fact
    // that a pointer was used.
    window.addEventListener('mousedown', toPointer, true);
    window.addEventListener('pointerdown', toPointer, true);
    window.addEventListener('touchstart', toPointer, true);
    window.addEventListener('keydown', toKeyboard, true);

    return () => {
      window.removeEventListener('mousedown', toPointer, true);
      window.removeEventListener('pointerdown', toPointer, true);
      window.removeEventListener('touchstart', toPointer, true);
      window.removeEventListener('keydown', toKeyboard, true);
    };
  }, []);
}
