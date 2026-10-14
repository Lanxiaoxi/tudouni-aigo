/**
 * The rails' drag geometry.
 *
 * Both rails wear their drag handle on their **inner** edge — the divider that
 * faces the conversation — and dragging that edge outward must widen the rail.
 * Which way "outward" points is the whole difference between them: the right
 * rail's inner edge is its **left** one, so outward is to the left and the
 * pointer's travel enters negated; the left rail's is its **right** one, so
 * outward is to the right and the travel enters as it is.
 *
 * That is a two-line function, and it is a module rather than one expression
 * inside `App.tsx` because this is the one thing here that is invisible when it
 * is wrong in the obvious way: `startW + dx` reads perfectly sensibly and
 * produces a rail that *narrows* as you pull it wider. It shipped that way once
 * on the right rail (the commit that fixed the drag direction says so), and the
 * left rail is its mirror image — one keystroke away from repeating it. With
 * the geometry here, both signs are asserted in `rail-drag.test.ts` instead of
 * being checked by eye in a window, where a wrong sign looks like a rail that
 * merely resists you.
 */

/** Which rail — the workspace one on the left, or the runtime one on the right. */
export type RailSide = 'left' | 'right';

/**
 * The width a drag lands on, **before** the store clamps it.
 *
 * `startW` is the rail's width when the gesture began, and `dx` is the pointer's
 * horizontal travel since then (positive = rightward). The caller reads
 * `startW` once, from the rail element, so the deltas are measured against the
 * width the person actually grabbed.
 */
export function draggedRailWidth(rail: RailSide, startW: number, dx: number): number {
  return rail === 'right' ? startW - dx : startW + dx;
}
