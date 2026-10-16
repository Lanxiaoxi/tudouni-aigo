/**
 * Scroll a transcript row into view, exactly.
 *
 * **The one implementation, because two readers now jump** — the turn rail's
 * marks and the find bar's hits. They were the same five lines with the same
 * three paragraphs of reasoning beside them, and the reasoning is the part that
 * must not drift: what it is protecting against is a layout optimisation that is
 * invisible until somebody jumps.
 *
 * ### Why `scrollIntoView` alone is not enough
 *
 * Every transcript row carries `content-visibility: auto` (`app.css`), so a row
 * that has never been on screen contributes an **estimate** (120px) rather than
 * its real height. That makes the document shorter than it is, and a jump into
 * the far end of a long conversation aims at a position the browser then moves.
 * Measured in `scripts/turn-rail-check.mjs` on a 60-turn session (1282 rows,
 * 181,449px): a click on the last mark left its turn head **15,561px below the
 * top**, with the transcript not moving at all from the previous jump.
 *
 * Re-aiming does not fix it. In the same task every pass reads the pre-scroll
 * position (`scrollIntoView` is compositor-async), and on the next frame only one
 * screenful has been laid out — a long jump would need one frame per screen of
 * history.
 *
 * ### So the estimate is lifted for the length of the jump
 *
 * `is-landing` turns `content-visibility` off for the transcript's rows, the
 * forced read below pays for the real layout once, and the scroll then lands
 * exactly. Removing the class does not undo that — `contain-intrinsic-size: auto`
 * means a row's estimate *becomes* its real height the first time it is rendered
 * — so this is paid once per session, on a jump, and never on the streaming path.
 *
 * The `void scroller.scrollHeight` is load-bearing rather than a lint workaround:
 * `scrollIntoView` would force the layout anyway, but only for the rows it
 * decides to touch, and the thing that has to be correct is the document's total
 * height.
 *
 * `scripts/find-proto.mjs` re-measured this on a freshly seeded 164-row
 * transcript: the document reported 38,240px against a real 59,256px (1.55x), and
 * the far row reported 34,853px where it really sits at 55,829px. On that
 * transcript all three jump methods happened to land anyway — the rail's
 * shortfall did **not** reproduce — so this is not here because the alternatives
 * were measured failing; it is here because it is exact (0px against 40px for
 * rect arithmetic) and because it does not depend on an estimate being
 * self-consistent.
 */
export function landOn(scroller: HTMLElement, row: HTMLElement): void {
  scroller.classList.add('is-landing');
  void scroller.scrollHeight;
  row.scrollIntoView({ block: 'start' });
  scroller.classList.remove('is-landing');
}
