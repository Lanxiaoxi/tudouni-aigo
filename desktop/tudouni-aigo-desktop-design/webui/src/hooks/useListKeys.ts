import { useEffect, useState } from 'react';

/**
 * 面板统一列表交互（desktop-ui-spec.md §8）：
 *   ↑ ↓ 移动 · Enter/Space 确认 · Esc 关闭 · 1-9 数字直选
 *
 * 所有弹层面板都走这一套，保证「统一列表交互」不是口号。
 */
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

  // 列表长度变化时收敛游标，避免指向空气
  useEffect(() => {
    setActive((a) => (count === 0 ? 0 : Math.min(a, count - 1)));
  }, [count]);

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (count === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % count);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + count) % count);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        onPick(active);
        return;
      }
      // 数字直选
      if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const idx = Number(e.key) - 1;
        if (idx < count) {
          e.preventDefault();
          setActive(idx);
          onPick(idx);
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, count, enabled, onClose, onPick]);

  return { active, setActive };
}
