import { useEffect, useRef } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { selectModalVisible, selectPhase, useApp, useSessionField, type ComposerNotice } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { ImageTray } from '@/components/chrome/ImageTray';
import { FileTray } from '@/components/chrome/FileTray';
import { PlusMenu } from '@/components/chrome/PlusMenu';
import { useClipboardPaste } from '@/hooks/useClipboardPaste';

/**
 * §1·7 The composer: a multi-line editor with a caret and history.
 *
 * **Two fixed heights, and one row of controls at a time.** Empty, the box is
 * 48px and is a single row: the `+`, the placeholder, the action. Once there is
 * something to say it becomes 96px — two lines of text with a toolbar under
 * them, holding the `+`, the key hint, and the action. That split is the
 * redesign's, and the reason it is worth having is that the empty box stops
 * reserving a toolbar nobody is using, while the filled box stops growing: a
 * long sentence scrolls inside its two lines instead of pushing the transcript
 * up the window.
 *
 * The height is CSS's (`height: 48px` / `96px` on `.cp-box`), never a measured
 * `scrollHeight` written back by this component. That measurement is what made
 * the old box grow without a bound.
 *
 * Only two controls, on purpose. The reference has four (attach, permission,
 * model, send); this build's plus opens the **plus menu** (`PlusMenu`): files
 * (workspace picker or OS dialog), this session's skills, and the command
 * palette — the same panel `Ctrl+K` opens, which was what the plus did before
 * the menu gave it company.
 *
 * There is **no hint line below the box**. The key hint and the transient
 * statements share the filled box's toolbar: a refused drop, a blocked runtime,
 * a drag in progress, the sentence a running turn's stop button deserves. Those
 * are statements, not standing hints, so they are still said — a drop refusal
 * especially, since a path the runtime cannot resolve sits in the sentence
 * looking exactly like one that worked.
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

  // **The draft belongs to the conversation, not to the window.** With two
  // sessions open a person types into one, switches to answer something in the
  // other, and comes back — and a shared draft would have interleaved the two
  // sentences. The same goes for the notice about this input and for the
  // history: all three are about "what I am saying here".
  const key = useApp((s) => s.activeKey);
  const draft = useSessionField((rt) => rt.draft, '');
  const setDraft = useApp((s) => s.setDraft);
  const submitDraft = useApp((s) => s.submitDraft);
  const historyNav = useApp((s) => s.historyNav);
  const interrupt = useApp((s) => s.interrupt);
  // **Asked of visibility, not of the slot.** A request held because its
  // session is not the one on screen has drawn nothing here, so the composer of
  // the conversation being typed into stays live — the same rule the rail's
  // inertness follows, and the reason switching to the asker is allowed at all.
  const blocked = useApp(selectModalVisible);
  const panel = useApp((s) => s.panel);
  const ready = useSessionField((rt) => rt.ready, false);
  const phase = useApp((s) => selectPhase(s, key));
  const dragging = useApp((s) => s.dragging);
  const composerNotice = useSessionField((rt) => rt.composerNotice, null);
  const setComposerNotice = useApp((s) => s.setComposerNotice);
  const onPaste = useClipboardPaste(taRef);
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

  /**
   * The composer has **two fixed heights**, not a growing box.
   *
   * Empty it is one 48px row: `+`, the placeholder, the send button. Once there
   * is something to send it is 96px: two lines of text above, and a toolbar
   * under them holding `+`, the key hint and the action. The quote "two fixed
   * heights" is the design's, and it is the reason the box no longer measures the
   * textarea: a long sentence does not turn the composer into a panel that grows
   * until it reaches the transcript — the input scrolls inside two lines instead.
   *
   * The toolbar is drawn for anything that has something to say in it, not only
   * for text: a running turn (the stop button and its sentence), a drop notice,
   * a refused file. An empty box has no toolbar to reserve.
   */
  const empty = draft.trim() === '';
  const showTools = !empty || running || composerNotice !== null || dragging;

  return (
    <div className="composer">
      <div className={`cp-box${blocked ? ' is-blocked' : ''}${showTools ? ' is-filled' : ''}`}>
        {/* The two attachment trays share one grid area, above both states.
            Wrapped rather than passed through because they are two components
            with one job, and an empty wrapper must not leave a gap. */}
        <div className="cp-trays">
          {/* The files attached from the plus menu, beside the pasted pictures.
              Same tray shape, same derive-from-the-draft rule; see `FileTray`. */}
          <FileTray />

          {/* The pasted pictures, above the input. They are a *reading* of the
              draft, not a second list of attachments: a chip is drawn while its
              path is still in the sentence and gone the moment it is not. See
              `ImageTray`. */}
          <ImageTray />
        </div>

        {/* The input. One line when the box is empty, two when it has content;
            the height is CSS's (see `.cp-box.is-filled`), not a measured
            `scrollHeight`, so typing cannot make the composer grow without a
            bound. */}
        <textarea
          ref={taRef}
          className="cp-input"
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          // A paste of text is left entirely alone: the handler returns before
          // `preventDefault` unless the clipboard really holds a picture. See
          // `hooks/useClipboardPaste.ts`.
          onPaste={onPaste}
          placeholder={blocked ? t('composer.blocked') : t('composer.placeholder')}
          disabled={blocked}
          aria-label={t('composer.placeholder')}
        />

        {/* The plus menu: files, skills, commands. In the empty row it sits at
            the leading edge beside the placeholder; once the box is filled it
            drops to the toolbar's leading edge. The grid area decides that, so
            there is one button, not two copies that could disagree. */}
        <PlusMenu taRef={taRef} disabled={blocked} />

        {/* The toolbar's middle: the transient statement if there is one, the
            key hint otherwise, and the stop sentence while a turn runs. Only
            rendered when there is a toolbar at all — an empty box reserves no
            second row. */}
        {showTools ? (
          <div className="cp-note">
            {blocked ? (
              <span>{t('composer.hint.modal')}</span>
            ) : composerNotice !== null ? (
              <span className={composerNotice.tone === 'warn' ? 'is-warn' : undefined}>
                {noticeText(t, composerNotice)}
                <button
                  type="button"
                  className="btn btn-ghost btn-compact"
                  onClick={() => setComposerNotice(null)}
                >
                  {t('common.close')}
                </button>
              </span>
            ) : dragging ? (
              <span>{t('composer.dropHint')}</span>
            ) : running ? (
              <span>{t('composer.hint.streaming')}</span>
            ) : (
              <span>{t('composer.hint.send')}</span>
            )}
          </div>
        ) : null}

        <div className="cp-actions">
          {running ? (
            <Tip label="Esc">
              <button
                type="button"
                className="cp-send is-stop"
                onClick={interrupt}
                aria-label={t('composer.interrupt')}
              >
                <Square size={13} />
              </button>
            </Tip>
          ) : (
            <Tip label={t('composer.send')}>
              <button
                type="button"
                className="cp-send"
                onClick={submitDraft}
                // While the child is still starting there is no process for a
                // message to reach — the send stays available-looking is a
                // lie, so it is disabled with everything else the store
                // refuses (`submitDraft` guards the same condition for the
                // Enter key).
                disabled={blocked || !ready || draft.trim() === ''}
                aria-label={t('composer.send')}
              >
                <ArrowUp size={16} />
              </button>
            </Tip>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One notice, as the sentence it says.
 *
 * A function rather than a field on the notice, because the store has no business
 * holding English and the parameters are punctuation the translation owns (a list
 * of file names, a byte count). `switch` over the code with no `default`: a new
 * code has to be given a sentence, and TypeScript's exhaustiveness check is what
 * enforces that rather than a fallback that would print nothing.
 */
function noticeText(t: ReturnType<typeof useT>, notice: ComposerNotice): string {
  switch (notice.code) {
    case 'drop-outside':
      return t('composer.dropOutside', { names: notice.names.join(', ') });
    case 'drop-no-workspace':
      return t('composer.dropNoWorkspace', { names: notice.names.join(', ') });
    case 'paste-no-workspace':
      return t('composer.pasteNoWorkspace');
    case 'paste-at-capacity':
      return t('composer.pasteAtCapacity', { limit: notice.limit });
    case 'paste-too-large':
      return t('composer.pasteTooLarge', { size: notice.size, limit: notice.limit });
    case 'paste-not-an-image':
      return t('composer.pasteNotAnImage');
    case 'paste-no-vision':
      return t('composer.pasteNoVision', { model: notice.model });
    case 'paste-failed':
      return t('composer.pasteFailed', { reason: notice.reason });
  }
}
