import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  draggedValue,
  keyboardValue,
  type SplitterGrow,
  type SplitterOrientation,
} from '@/state/workspaceDock/splitter';

export interface SplitterProps {
  /** ARIA's meaning: `vertical` is a vertical bar that resizes a **width**. */
  orientation: SplitterOrientation;
  /** Which way of travel enlarges `value`; see `workspaceDock/splitter.ts`. */
  grow: SplitterGrow;
  value: number;
  min: number;
  max: number;
  /** Accessible name; the separator has no visible text. */
  label: string;
  /** Called with every value a drag or key lands on, already clamped. */
  onChange(value: number): void;
  /** Double-click hands the value back to its default. */
  onReset?(): void;
  /** Lets the owner drop a width transition while the pointer is down. */
  onDragChange?(dragging: boolean): void;
  /** `splitter-edge` draws it as a 6px strip on the owner's edge (the dock's
   *  outer handle) rather than as a 1px divider between two panes. */
  className?: string;
}

/**
 * A resize handle, horizontal or vertical, with the keyboard and ARIA contract
 * of a window splitter: `role="separator"`, focusable, `aria-valuenow` /
 * `min` / `max`, arrows move it, Shift takes the larger step, Home/End jump.
 *
 * The existing `RailDragHandle` (App.tsx) resizes exactly the two rails and
 * writes their store fields; this one owns no state. It reports a value and the
 * caller decides where it lands, which is what lets the dock's outer width, the
 * navigator's width and the terminal's height share it. The sign of a drag is
 * computed in `splitter.ts`, where it is asserted, rather than inlined here.
 *
 * Pointer capture keeps the move stream aimed at the strip when the pointer
 * leaves it mid-sweep, so no document-level listeners are needed.
 */
export function Splitter(props: SplitterProps) {
  const { orientation, grow, value, min, max, label, onChange, onReset, onDragChange, className } = props;
  const drag = useRef<{ start: number; origin: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const bodyClass = orientation === 'vertical' ? 'is-resizing' : 'is-resizing-row';

  const stop = () => {
    if (drag.current === null) return;
    drag.current = null;
    document.body.classList.remove('is-resizing', 'is-resizing-row');
    setDragging(false);
    onDragChange?.(false);
  };

  // A handle unmounted mid-drag (the dock folds under the pointer) must not
  // leave the whole window with a resize cursor and no text selection.
  useEffect(
    () => () => {
      if (drag.current !== null) document.body.classList.remove('is-resizing', 'is-resizing-row');
    },
    [],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: value, origin: orientation === 'vertical' ? e.clientX : e.clientY };
    document.body.classList.add(bodyClass);
    setDragging(true);
    onDragChange?.(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null) return;
    const pos = orientation === 'vertical' ? e.clientX : e.clientY;
    onChange(draggedValue(d.start, pos - d.origin, grow, min, max));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = keyboardValue({
      key: e.key,
      shiftKey: e.shiftKey,
      orientation,
      grow,
      value,
      min,
      max,
    });
    if (next === null) return;
    e.preventDefault();
    if (next !== value) onChange(next);
  };

  return (
    <div
      className={`splitter ${orientation === 'vertical' ? 'splitter-v' : 'splitter-h'}${dragging ? ' is-dragging' : ''}${className ? ` ${className}` : ''}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  );
}
