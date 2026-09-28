import { useEffect, useRef } from 'react';
import { CornerDownLeft, Square } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Kbd, Tip } from '@/components/ui/kit';
import { BusyDots } from '@/components/ui/kit';

/**
 * §1·7 输入框：多行编辑器，带光标与历史。
 *
 * 键位按 §8 能力清单实现（这一层是唯一允许「行首行尾」这类 emacs 风格绑定的地方）：
 *   Enter 发送 · Shift+Enter / Ctrl+J 换行 · Esc 中断
 *   ↑/↓ 或 Ctrl+↑/↓ 翻历史 · Ctrl+W 删词 · Ctrl+U 删到行首
 *   Ctrl+A 行首 · Ctrl+E 行尾 · Delete 前删 · Ctrl+←/→ 按词移动（浏览器原生）
 *
 * 模态存在时输入框不抢占：不发送、不拦截键位（§1·3 优先级）。
 */
export function Composer() {
  const t = useT();
  const taRef = useRef<HTMLTextAreaElement>(null);

  const draft = useApp((s) => s.draft);
  const setDraft = useApp((s) => s.setDraft);
  const submitDraft = useApp((s) => s.submitDraft);
  const historyNav = useApp((s) => s.historyNav);
  const interrupt = useApp((s) => s.interrupt);
  const modal = useApp((s) => s.modal);
  const phase = useApp((s) => s.status?.phase);
  const blocked = modal !== null;
  const running = phase === 'running' && !blocked;

  // 内容变化时重算高度（不写死行数上限，交给 CSS 的 max-height 兜）
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  function setValueAndCaret(el: HTMLTextAreaElement, value: string, caret: number) {
    setDraft(value);
    requestAnimationFrame(() => {
      el.selectionStart = caret;
      el.selectionEnd = caret;
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (blocked) return;
    const el = e.currentTarget;
    const v = el.value;
    const s = el.selectionStart;
    const en = el.selectionEnd;
    const mod = e.ctrlKey || e.metaKey;

    // 发送
    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      e.preventDefault();
      submitDraft();
      return;
    }

    // 换行
    if (e.key === 'Enter' && e.shiftKey) return; // 浏览器默认即换行
    if (mod && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      const next = `${v.slice(0, s)}\n${v.slice(en)}`;
      setValueAndCaret(el, next, s + 1);
      return;
    }

    // 中断本轮
    if (e.key === 'Escape') {
      if (running) {
        e.preventDefault();
        interrupt();
      }
      return;
    }

    // 历史
    if (e.key === 'ArrowUp' && (mod || (s === 0 && en === 0))) {
      e.preventDefault();
      historyNav(-1);
      return;
    }
    if (e.key === 'ArrowDown' && (mod || (s === v.length && en === v.length))) {
      e.preventDefault();
      historyNav(1);
      return;
    }

    if (!mod) return;

    // 行首行尾
    if (e.key.toLowerCase() === 'a') {
      e.preventDefault();
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      setValueAndCaret(el, v, lineStart);
      return;
    }
    if (e.key.toLowerCase() === 'e') {
      e.preventDefault();
      const nl = v.indexOf('\n', s);
      const lineEnd = nl === -1 ? v.length : nl;
      setValueAndCaret(el, v, lineEnd);
      return;
    }

    // 删词（光标前一个词）
    if (e.key.toLowerCase() === 'w') {
      e.preventDefault();
      const before = v.slice(0, s);
      const trimmed = before.replace(/\s*\S*$/, '');
      setValueAndCaret(el, trimmed + v.slice(en), trimmed.length);
      return;
    }

    // 删到行首
    if (e.key.toLowerCase() === 'u') {
      e.preventDefault();
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      setValueAndCaret(el, v.slice(0, lineStart) + v.slice(en), lineStart);
      return;
    }
  }

  return (
    <div className="composer">
      <div className={`cp-box${blocked ? ' is-blocked' : ''}`}>
        <textarea
          ref={taRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={blocked ? t('composer.blocked') : t('composer.placeholder')}
          disabled={blocked}
          aria-label={t('composer.placeholder')}
        />

        <div className="cp-tools">
          {running ? (
            <Tip label="Esc">
              <button
                type="button"
                className="btn btn-secondary btn-compact"
                onClick={interrupt}
              >
                <Square size={11} />
                <span>{t('phase.interrupted')}</span>
              </button>
            </Tip>
          ) : (
            <Tip label={<Kbd>⏎</Kbd>}>
              <button
                type="button"
                className="btn btn-primary btn-compact"
                onClick={submitDraft}
                disabled={blocked || draft.trim() === ''}
              >
                <CornerDownLeft size={11} />
                <span>{t('composer.send')}</span>
              </button>
            </Tip>
          )}
        </div>
      </div>

      <div className="cp-hint">
        {blocked ? (
          <span>{t('composer.hint.modal')}</span>
        ) : (
          <>
            <span>{t('composer.hint.send')}</span>
            <span className="faint">·</span>
            <span>
              <Kbd>Ctrl K</Kbd> {t('topbar.commands')}
            </span>
            <span className="faint">·</span>
            <span>
              <Kbd>Ctrl B</Kbd> {t('key.sidebar')}
            </span>
            {running ? (
              <>
                <span className="faint">·</span>
                <span>
                  <BusyDots /> {t('phase.running')}
                </span>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
