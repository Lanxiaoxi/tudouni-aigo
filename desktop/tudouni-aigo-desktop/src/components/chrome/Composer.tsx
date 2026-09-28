import { useEffect, useRef } from 'react';
import { CornerDownLeft, Square } from 'lucide-react';
import { selectPhase, useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Kbd, Tip, BusyDots } from '@/components/ui/kit';

/**
 * §1·7 The composer: a multi-line editor with a caret and history.
 *
 * Keys follow the capability list. This layer is the only place allowed to carry
 * emacs-style bindings:
 *   Enter send · Shift+Enter / Ctrl+J newline · Esc interrupt
 *   ↑/↓ history · Ctrl+W delete word · Ctrl+U delete to line start
 *   Ctrl+A line start · Ctrl+E line end · Delete forward · Ctrl+←/→ word move
 *   (the last one is native browser behaviour)
 *
 * While a modal is up the composer does not compete: it neither sends nor
 * intercepts.
 *
 * Images are attached by **writing their path into the sentence** — that is the
 * only channel that exists. The runtime recognises a path in the text itself;
 * there is no upload command and no markup. So a drop inserts the path (and,
 * outside the workspace, says why it will not work) rather than trying to ship
 * bytes down a channel that is not there. The drop handler itself lives in
 * `hooks/useFileDrop.ts`, at the window level, because a drop can land anywhere
 * in the window and not only on this box.
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
  const panel = useApp((s) => s.panel);
  const ready = useApp((s) => s.ready);
  const phase = useApp(selectPhase);
  const dragging = useApp((s) => s.dragging);
  const dropNotice = useApp((s) => s.dropNotice);
  const setDropNotice = useApp((s) => s.setDropNotice);
  const blocked = modal !== null;
  const running = phase === 'running' && !blocked;

  /**
   * Put the caret back in the box whenever nothing is covering it.
   *
   * React's `autoFocus` only fires on mount, and this component never unmounts —
   * so before this, closing a panel or answering a prompt left focus on
   * `<body>`, where typing did nothing at all and the only way back was to click
   * the box. Radix restores focus to whatever opened a dialog, and nothing in
   * this app triggers one from a focusable element (the palette, the modals and
   * the panels are all opened from keys or from elements that are gone by then),
   * so the restore target was always the body.
   */
  useEffect(() => {
    if (!ready || blocked || panel !== null) return;
    // Not while a person is typing somewhere else deliberately.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) return;
    taRef.current?.focus();
  }, [ready, blocked, panel]);

  // Recompute the height on every change; the row cap is CSS's job.
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

    // An IME is mid-composition. Enter there means "commit the candidate", not
    // "send": for a Chinese or Japanese user that is the key they press to put
    // the characters on the screen, and treating it as a send posts half a
    // sentence. `keyCode === 229` is the legacy signal that some IMEs still
    // only deliver through.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    const el = e.currentTarget;
    const v = el.value;
    const s = el.selectionStart;
    const en = el.selectionEnd;
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      e.preventDefault();
      submitDraft();
      return;
    }

    if (e.key === 'Enter' && e.shiftKey) return; // The browser's own newline.

    if (mod && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      const next = `${v.slice(0, s)}\n${v.slice(en)}`;
      setValueAndCaret(el, next, s + 1);
      return;
    }

    if (e.key === 'Escape') {
      if (running) {
        e.preventDefault();
        // The window-level handler would otherwise send a second `interrupt`
        // for the same press: it sees the bubbled event and the phase still
        // reads "running".
        e.stopPropagation();
        interrupt();
      }
      return;
    }

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

    if (e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setValueAndCaret(el, v, v.lastIndexOf('\n', s - 1) + 1);
      return;
    }
    if (e.key.toLowerCase() === 'e') {
      e.preventDefault();
      const nl = v.indexOf('\n', s);
      setValueAndCaret(el, v, nl === -1 ? v.length : nl);
      return;
    }
    if (e.key.toLowerCase() === 'w') {
      e.preventDefault();
      const before = v.slice(0, s);
      const trimmed = before.replace(/\s*\S*$/, '');
      setValueAndCaret(el, trimmed + v.slice(en), trimmed.length);
      return;
    }
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
              <button type="button" className="btn btn-secondary btn-compact" onClick={interrupt}>
                <Square size={11} />
                <span>{t('composer.interrupt')}</span>
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
        ) : dropNotice !== null ? (
          // A refused path is said out loud: it would otherwise sit in the
          // sentence looking exactly like one that worked, and the reader would
          // believe their file had been sent.
          <span className="cp-drop-warn">
            <span className="faint">·</span>
            {dropNotice.reason === 'no-workspace'
              ? t('composer.dropNoWorkspace', { names: dropNotice.rejected.join(', ') })
              : t('composer.dropOutside', { names: dropNotice.rejected.join(', ') })}
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              onClick={() => setDropNotice(null)}
            >
              {t('common.close')}
            </button>
          </span>
        ) : dragging ? (
          <span>{t('composer.dropHint')}</span>
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
