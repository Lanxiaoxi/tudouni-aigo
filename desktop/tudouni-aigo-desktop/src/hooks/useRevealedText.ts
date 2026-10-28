import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FrameClock } from '@/frameClock';
import { RevealEngine, type RevealLimits } from '@/streamReveal';

/**
 * Draw a growing string at a paced cadence instead of at arrival.
 *
 * The accumulator (`text`) is the entry's, exactly as the reducer built it; this
 * hook owns only the cursor, so the store stays a function of the event stream
 * and nothing about "how far the eye has caught up" is persisted, replayed or
 * synced to another window.
 *
 * ### Why the cursor lives in a hook and not in the DOM
 *
 * Rewriting a `Text` node's `data` every frame would be faster — no React
 * reconcile, no element tree — and it was the first shape considered. It is
 * rejected here because this front end's tests assert the transcript by reading
 * DOM, and `Ctrl+F` scans those same nodes: a value written behind React's back
 * is a value that disagrees with the model until the next commit, and the find
 * layer would count hits in text the person cannot see yet. A `setState` per
 * frame costs one small component's render, which at 60 Hz for one
 * `<div>{text}</div>` is not the expensive part of this window.
 *
 * ### The three ways this hook lets go
 *
 *   - **`enabled` is false** — the feature is off, or reduced motion is on, or
 *     the find bar is up. The full text is returned synchronously, in this
 *     render, so nothing is ever paced that somebody is searching or has opted
 *     out of.
 *   - **the text is replaced** rather than extended (a `delta_reset`, a retried
 *     step) — the cursor is dropped with it, because the characters it counted
 *     no longer exist.
 *   - **the stream ends** — the tail drains at a bounded rate over the next few
 *     frames rather than being committed in one teleport.
 *
 * @param text - The full accumulated text, as the entry holds it.
 * @param live - Whether the entry can still grow (`entry.streaming`).
 * @param enabled - Whether to pace at all. False is the honest "show it now".
 * @param limits - The ends of the pacing curve the person chose in the
 *   settings (the untouched fields run at the curve's own defaults). Read
 *   **once, at mount**: a row is mounted by its first delta, and an engine
 *   that changes curve mid-sentence would be a speed change under text that
 *   is on screen — the jump the pacing exists to prevent. A value changed
 *   later reaches the next row's engine, which is the "takes effect at the
 *   next reply" rule the settings panel promises.
 * @returns The prefix of `text` that should be on screen right now.
 */
export function useRevealedText(
  text: string,
  live: boolean,
  enabled: boolean,
  limits?: Partial<RevealLimits>,
): string {
  const engine = useRef<RevealEngine | null>(null);
  engine.current ??= new RevealEngine(limits);

  /**
   * The last string handed to the engine.
   *
   * Kept as render-time state rather than as a ref so a chunk is folded in
   * **during** the render that first sees it: an effect lands one frame after
   * the data, and the row would paint the previous frame's cursor over the new
   * text.
   */
  const [foldedText, setFoldedText] = useState(text);
  const [shown, setShown] = useState(() => {
    const e = engine.current!;
    e.push(text, live);
    return e.displayed;
  });

  if (!enabled) {
    // Off means off: the caller asked for the whole text, in this render.
    if (foldedText !== text) setFoldedText(text);
    engine.current.snap(text, live);
  } else if (foldedText !== text) {
    setFoldedText(text);
    engine.current.push(text, live);
    // A replacement drops the cursor with it, so `shown` is stale until the
    // loop writes — and a stream that is now fully shown registers no work at
    // all. Land it here instead of waiting for a frame that will not come.
    if (!engine.current.pending) setShown(engine.current.displayed);
  } else {
    // The text is unchanged but its **liveness** may not be: an empty
    // `run_finished.answer` settles every streamed row without touching a
    // character (`entries.ts`, `settleAbandonedTurn`). That flip is what turns
    // the pacing curve into the completion drain, so it has to reach the
    // engine even when there is nothing new to fold in.
    engine.current.push(text, live);
  }

  /**
   * A cursor with nothing owed must be drawn, not waited for.
   *
   * No frame is coming for a settled engine, so a `shown` left behind stays
   * behind: that is the case where pacing was turned back **on** mid-session —
   * the engine was snapped while it was off, and the state still holds whatever
   * the last paced frame wrote. Reconciling here rather than in an effect keeps
   * it in the same render; a pending cursor is left alone, because its next
   * frame is the writer.
   */
  if (enabled && !engine.current.pending && engine.current.displayed !== shown) {
    setShown(engine.current.displayed);
  }

  const shownRef = useRef(shown);
  shownRef.current = shown;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  /**
   * Registered once for the component's lifetime, never re-registered.
   *
   * The clock stops itself when every task reports nothing left, so a task that
   * outlives its work costs nothing — whereas a task armed and disarmed on a
   * boolean would have to be re-registered on every chunk, and the gap between
   * a chunk landing and that re-registration is a frame of held-back text.
   */
  useLayoutEffect(() => {
    const clock = FrameClock.forDocument();
    const e = engine.current!;
    const id = clock.register({
      onSimulate: (dtMs) => {
        if (!enabledRef.current) return false;
        e.step(dtMs);
        return e.pending;
      },
      onWrite: () => {
        const next = e.displayed;
        if (next === shownRef.current) return;
        shownRef.current = next;
        setShown(next);
      },
    });
    return () => clock.unregister(id);
  }, []);

  /**
   * Re-arm the clock after every render that left something owed.
   *
   * No dependency array on purpose: a chunk arrives as a prop change, so the
   * render *is* the notification, and the check is one boolean. The clock's own
   * `arm` is a no-op while a loop is already running.
   */
  useLayoutEffect(() => {
    if (enabledRef.current && engine.current!.pending) FrameClock.forDocument().kick();
  });

  // Turning pacing off mid-stream (a find opening, the reduced-motion preference)
  // settles at once rather than waiting for the tail: the caller asked for the
  // text, not for a reason to keep holding it. The render-time `snap` above did
  // the engine's half; this is the state that has to follow it.
  useEffect(() => {
    if (enabled) return;
    setShown(text);
  }, [enabled, text]);

  if (!enabled) return text;
  // A finished, fully-shown stream needs no special case: `shown` already equals
  // `text`, because the drain's last step wrote it.
  return shown;
}
