import { useEffect } from 'react';
import { useApp } from '@/state/store';

/**
 * 全局键位（desktop-ui-spec.md §8 能力清单）。
 *
 * 分工原则：模态内部的键位交给模态自己（Radix Dialog 已吃 Esc 前会先问我们），
 * 面板内部的键位交给面板自己，这里只管「全局 + 落空时」的那一层。
 *
 * 注意：`F5 / Ctrl+R 禁用刷新` 属于原生层职责（tauri-native-spec.md §5），
 * 浏览器里拦刷新会把开发体验搞坏，所以不在这一层实现。
 */
export function useGlobalKeys(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const s = useApp.getState();
      const mod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement | null;
      const inField =
        !!target &&
        (target.tagName === 'TEXTAREA' ||
          target.tagName === 'INPUT' ||
          target.isContentEditable);

      /* ---- Esc：模态 > 面板 > 中断本轮 ---- */
      if (e.key === 'Escape') {
        // 模态由 Radix 自己处理 Esc（会走 onEscapeKeyDown → 拒绝 / 跳过）
        if (s.modal !== null) return;
        if (s.panel !== null) {
          e.preventDefault();
          useApp.setState({ panel: null });
          return;
        }
        if (s.status?.phase === 'running') {
          e.preventDefault();
          s.interrupt();
        }
        return;
      }

      /* ---- Ctrl/Cmd 系列 ---- */
      if (mod && !e.shiftKey) {
        switch (e.key.toLowerCase()) {
          case 'k': {
            e.preventDefault();
            useApp.setState({ panel: s.panel === 'commands' ? null : 'commands' });
            return;
          }
          case 'b': {
            e.preventDefault();
            s.toggleSidebar();
            return;
          }
          case 's': {
            e.preventDefault();
            useApp.setState({ panel: s.panel === 'skills' ? null : 'skills' });
            return;
          }
          case 't': {
            // 折叠展开思考块：对当前流里最后一个思考块生效
            e.preventDefault();
            const last = [...s.entries].reverse().find((x) => x.kind === 'reason');
            if (last) s.toggleReasoning(last.id);
            return;
          }
          case 'c': {
            // 退出：只在没有选中文本时拦截，避免抢掉复制
            if (!inField && !window.getSelection()?.toString()) {
              e.preventDefault();
              s.send({ type: 'shutdown' });
            }
            return;
          }
          case '\\': {
            e.preventDefault();
            s.toggleQuiet();
            return;
          }
          default:
            break;
        }

        /* ---- Ctrl+1..9：切会话（在面板内由面板优先处理） ---- */
        if (/^[1-9]$/.test(e.key) && s.panel === null) {
          const idx = Number(e.key) - 1;
          const item = s.sessionList[idx];
          if (item) {
            e.preventDefault();
            s.switchSession(item.id);
          }
        }
        return;
      }

      /* ---- Ctrl+数字：面板数字直选（交给面板，这里不拦） ---- */
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
