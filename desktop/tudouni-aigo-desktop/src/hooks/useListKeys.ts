import { useEffect, useState } from 'react';

/**
 * The shared list interaction for panels:
 *   ↑ ↓ move · Enter/Space confirm · Esc close · 1-9 pick by number
 *
 * Every overlay panel goes through this, so "one consistent list interaction" is
 * a fact rather than a slogan.
 */

/**
 * Is this key event aimed at something the person is typing into?
 *
 * The listener is on `window` and the palette's own search box is `autoFocus`,
 * so without this check a digit typed into the box is *both* a character and a
 * command pick. `1` ran `/new` (wiping the stream) and `4` ran `/exit` (shutting
 * the runtime down) before the character ever reached the field — one mistyped
 * key, one irreversible action.
 */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/** What a key press should do to a list. `null` means "leave it alone". */
export type ListKeyAction =
  | { kind: 'close' }
  | { kind: 'move'; delta: 1 | -1 }
  | { kind: 'confirm' }
  | { kind: 'pick'; index: number };

/**
 * The decision, as a pure function.
 *
 * Split out from the listener so the rules can be asserted directly — "a digit
 * typed into the search box must not run a command" is exactly the kind of thing
 * that silently regresses, and it cannot be seen in a rendered string.
 *
 * Movement and confirm work from a field on purpose: a person typing in the
 * palette's search box expects ↑/↓/Enter to drive the list. The numeric pick is
 * the only one that must not, because a digit there is a character.
 */
export function listKeyAction(input: {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  typing: boolean;
  count: number;
}): ListKeyAction | null {
  if (input.key === 'Escape') return { kind: 'close' };
  if (input.count === 0) return null;

  if (input.key === 'ArrowDown') return { kind: 'move', delta: 1 };
  if (input.key === 'ArrowUp') return { kind: 'move', delta: -1 };
  if (input.key === 'Enter') return { kind: 'confirm' };

  if (input.typing) return null;
  if (!/^[1-9]$/.test(input.key) || input.ctrl || input.meta || input.alt) return null;
  const index = Number(input.key) - 1;
  return index < input.count ? { kind: 'pick', index } : null;
}

export function useListKeys({
  count,
  onPick,
  onClose,
  enabled = true,
}: {
  count: number;
  onPick: (index: number) => void;
  onClose: () => void;
  enabled?: boolean;
}): { active: number; setActive: (i: number) => void } {
  const [active, setActive] = useState(0);

  // Converge the cursor when the list length changes, so it never points at
  // nothing.
  useEffect(() => {
    setActive((a) => (count === 0 ? 0 : Math.min(a, count - 1)));
  }, [count]);

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(e: KeyboardEvent) {
      const action = listKeyAction({
        key: e.key,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        alt: e.altKey,
        typing: isTypingTarget(e.target),
        count,
      });
      if (action === null) return;

      switch (action.kind) {
        case 'close':
          e.preventDefault();
          onClose();
          return;
        case 'move':
          e.preventDefault();
          setActive((a) => (a + action.delta + count) % count);
          return;
        case 'confirm':
          e.preventDefault();
          onPick(active);
          return;
        case 'pick':
          e.preventDefault();
          setActive(action.index);
          onPick(action.index);
          return;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, count, enabled, onClose, onPick]);

  return { active, setActive };
}
