import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

export interface ContextMenuProps {
  /** Where it opens (viewport coordinates); clamped to stay on screen. */
  x: number;
  y: number;
  label: string;
  items: readonly MenuItem[];
  onClose: () => void;
}

/**
 * A small keyboard-operable menu for the Dock's rows.
 *
 * Portalled to `body` so the dock's `overflow: hidden` and its stacking context
 * cannot clip or bury it. Focus moves into the menu when it opens and returns to
 * where it was when it closes, so a keyboard user lands back on their row.
 */
export function ContextMenu({ x, y, label, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const box = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = () => onClose();
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      if (before !== null && document.contains(before)) before.focus();
    };
    // Mount-only: `onClose` is read through the closure of the first render, and
    // the owner closes by unmounting this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => {
      e.preventDefault();
      e.stopPropagation();
      buttons[(i + buttons.length) % buttons.length]?.focus();
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(buttons.length - 1);
    else if (e.key === 'Tab') {
      e.preventDefault();
      onClose();
    }
  }

  return createPortal(
    <div
      className="dock-menu-scrim"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={ref}
        className="dock-menu"
        role="menu"
        aria-label={label}
        style={{ left: pos.left, top: pos.top }}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="dock-menu-item"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
