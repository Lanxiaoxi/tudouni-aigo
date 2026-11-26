import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { EditorContent, ReactNodeViewRenderer, useEditor, type Editor } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Placeholder, UndoRedo } from '@tiptap/extensions';
import { selectModalVisible, selectPhase, useApp, useSessionField, type ComposerNotice } from '@/state/store';
import { activeWorkspaceOf } from '@/state/appView';
import { promptHistoryKey, suggestPrompt } from '@/state/promptHistory';
import { usePromptHistory } from '@/hooks/usePromptHistory';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { PlusMenu } from '@/components/chrome/PlusMenu';
import { TokenChip } from '@/components/chrome/TokenChip';
import { TokenNode, docToDraft, draftToContent, fragmentToDraft, offsetToPos, posToOffset } from '@/components/chrome/composerDoc';
import { registerComposer } from '@/components/chrome/composerBridge';
import { handleComposerPaste } from '@/hooks/useClipboardPaste';

/**
 * §1·7 The composer: a multi-line editor with a caret, history, and chips.
 *
 * **The draft is a string; the box is a document.** The store keeps the draft as
 * plain text in which every attachment is a placeholder token (`⟦pimg-0⟧`,
 * `⟦file-0⟧`, `⟦note-0⟧`, `⟦text-0⟧`), and everything downstream — the uploads,
 * the restore at submit, the history — reads that string. The box is a Tiptap
 * editor that draws each token as an inline chip (`TokenChip`), so the person
 * sees a thumbnail or a file name where the token sits, and deletes it as one
 * unit. `composerDoc.ts` is the only translation between the two readings.
 *
 * **Who writes what.** While the person types, the editor owns the content and
 * pushes the string to the store (`onUpdate`). Anything else that changes the
 * draft — history, a suggestion, a paste's chips, the plus menu, the send that
 * empties it — writes the store, and the effect below loads that string into the
 * editor. The two are told apart by `emitted`: the last string the editor
 * produced. Re-loading on every keystroke would break an IME composition and
 * throw the caret around.
 *
 * **Three fixed heights, and one row of controls at a time.** Empty, the box is
 * 48px and is a single row: the `+`, the placeholder, the action. Once there is
 * something to say it becomes 96px — two lines with a toolbar under them. When
 * the draft outgrows those two lines (`isLargeDraft`) it becomes 192px. The
 * height is CSS's, never a measured `scrollHeight`.
 *
 * Keys follow the capability list. This layer is the only place allowed to carry
 * emacs-style bindings:
 *   Enter send · Shift+Enter / Ctrl+J newline · Esc interrupt · Tab complete
 *   ↑/↓ history · Ctrl+W delete word · Ctrl+U delete to line start
 *   Ctrl+A line start · Ctrl+E line end · Ctrl+Z / Ctrl+Y undo / redo
 *
 * **Tab is claimed only while a suggestion is showing**; the toolbar says what
 * it would insert, and the box itself is never drawn into.
 *
 * While a modal is up the composer does not compete: it is not editable, and it
 * neither sends nor intercepts.
 */
export function Composer() {
  const t = useT();

  // The draft, the notice and the history belong to the conversation, not to
  // the window: two open sessions must not interleave their sentences.
  const key = useApp((s) => s.activeKey);
  const draft = useSessionField((rt) => rt.draft, '');
  const setDraft = useApp((s) => s.setDraft);
  const submitDraft = useApp((s) => s.submitDraft);
  const historyNav = useApp((s) => s.historyNav);
  const interrupt = useApp((s) => s.interrupt);
  // Asked of visibility, not of the slot: a request held by a background
  // session has drawn nothing here.
  const blocked = useApp(selectModalVisible);
  const panel = useApp((s) => s.panel);
  const ready = useSessionField((rt) => rt.ready, false);
  const phase = useApp((s) => selectPhase(s, key));
  const dragging = useApp((s) => s.dragging);
  const composerNotice = useSessionField((rt) => rt.composerNotice, null);
  const setComposerNotice = useApp((s) => s.setComposerNotice);
  const running = phase === 'running' && !blocked;

  // The suggestion belongs to the workspace: a habit of the directory.
  const workspace = useApp(activeWorkspaceOf);
  const remoteWorkspaceId = useSessionField((rt) => rt.remoteWorkspaceId, null);
  const promptKey = workspace === '' ? null : promptHistoryKey(workspace, remoteWorkspaceId);
  const prompts = usePromptHistory(promptKey, workspace, remoteWorkspaceId);
  // The completion replaces the whole draft, so it is only offered while the
  // caret is at the end of it.
  const [caretAtEnd, setCaretAtEnd] = useState(true);
  const suggestion = useMemo(() => {
    if (blocked || running || composerNotice !== null || dragging || !caretAtEnd) return null;
    return suggestPrompt(draft, prompts);
  }, [blocked, running, composerNotice, dragging, caretAtEnd, draft, prompts]);

  /** The last string the editor itself produced — see the header. */
  const emitted = useRef<string>(draft);
  /** A caret asked for before the draft it belongs to has reached the editor. */
  const pendingCaret = useRef<number | null>(null);

  // The editor's handlers are created once; they read the latest values here.
  const live = useRef({ blocked, running, suggestion, submitDraft, historyNav, interrupt, setDraft });
  live.current = { blocked, running, suggestion, submitDraft, historyNav, interrupt, setDraft };

  const editor = useEditor({
    extensions: [
      Document,
      Paragraph,
      Text,
      TokenNode.extend({
        addNodeView() {
          return ReactNodeViewRenderer(TokenChip, { as: 'span' });
        },
      }),
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
      UndoRedo,
    ],
    content: draftToContent(draft),
    editorProps: {
      attributes: {
        class: 'cp-editor',
        role: 'textbox',
        'aria-multiline': 'true',
        spellcheck: 'false',
      },
      handleKeyDown: (_view, event) => onKey(event),
      handlePaste: (_view, event) => {
        const ed = editorRef.current;
        if (ed === null) return false;
        const taken = handleComposerPaste(event.clipboardData, caretOf(ed));
        if (taken) event.preventDefault();
        return taken;
      },
      // A copy out of the box carries the tokens as text, so a paste back into
      // it (or into another session) keeps the chips' tokens.
      clipboardTextSerializer: (slice) => fragmentToDraft(slice.content),
    },
    onUpdate: ({ editor: ed }) => {
      const next = docToDraft(ed.state.doc);
      if (next === emitted.current) return;
      emitted.current = next;
      live.current.setDraft(next);
      noteCaret(ed);
    },
    onSelectionUpdate: ({ editor: ed }) => noteCaret(ed),
  });

  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;
  const placeholderRef = useRef('');
  placeholderRef.current = blocked ? t('composer.blocked') : t('composer.placeholder');

  /** The caret (selection head) as a draft offset. */
  function caretOf(ed: Editor): number {
    return posToOffset(ed.state.doc, ed.state.selection.head);
  }

  function selectionOf(ed: Editor): { from: number; to: number } {
    const { from, to } = ed.state.selection;
    return { from: posToOffset(ed.state.doc, from), to: posToOffset(ed.state.doc, to) };
  }

  function noteCaret(ed: Editor) {
    const { from, to } = selectionOf(ed);
    const length = docToDraft(ed.state.doc).length;
    setCaretAtEnd(from === length && to === length);
  }

  /** Apply a pending caret once the editor holds the draft it was meant for. */
  function applyPendingCaret(ed: Editor) {
    const offset = pendingCaret.current;
    if (offset === null) return;
    if (docToDraft(ed.state.doc) !== emitted.current) return;
    pendingCaret.current = null;
    ed.chain().focus().setTextSelection(offsetToPos(ed.state.doc, offset)).run();
  }

  /** Write the draft and put the caret at `caret` once it has landed. */
  function setValueAndCaret(value: string, caret: number) {
    pendingCaret.current = caret;
    live.current.setDraft(value);
    requestAnimationFrame(() => {
      const ed = editorRef.current;
      if (ed) applyPendingCaret(ed);
    });
  }

  /**
   * Load a draft written by someone other than the editor. Without the
   * `emitted` check this would re-load on every keystroke, which is what breaks
   * an IME composition.
   */
  useEffect(() => {
    if (!editor || draft === emitted.current) return;
    emitted.current = draft;
    editor.commands.setContent(draftToContent(draft), { emitUpdate: false });
    if (pendingCaret.current !== null) {
      applyPendingCaret(editor);
    } else {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    }
    noteCaret(editor);
    // `noteCaret`/`applyPendingCaret` read refs only.
  }, [editor, draft]);

  // The rest of the window inserts at the caret through this handle.
  useEffect(() => {
    if (!editor) return;
    return registerComposer({
      caret: () => caretOf(editor),
      placeCaret: (offset) => {
        pendingCaret.current = offset;
        applyPendingCaret(editor);
        requestAnimationFrame(() => applyPendingCaret(editor));
      },
    });
  }, [editor]);

  // A modal covers the box: it stops being editable rather than refusing keys
  // one by one.
  useEffect(() => {
    editor?.setEditable(!blocked, false);
  }, [editor, blocked]);

  /**
   * Put the caret back in the box whenever nothing is covering it. `autoFocus`
   * only fires on mount, and this component never unmounts — so closing a panel
   * used to leave focus on `<body>`, where typing did nothing.
   */
  useEffect(() => {
    if (!editor || !ready || blocked || panel !== null) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) return;
    editor.commands.focus();
  }, [editor, ready, blocked, panel]);

  /**
   * Accept one clause of the suggestion (Tab), or the whole thing (click).
   * Only at the end of the draft: mid-sentence it would overwrite the tail.
   */
  function accept(full: boolean) {
    const ed = editorRef.current;
    const current = live.current.suggestion;
    if (ed === null || current === null) return;
    const length = docToDraft(ed.state.doc).length;
    const { from, to } = selectionOf(ed);
    if (from !== length || to !== length) return;
    const accepted = full ? current.text : current.text.slice(0, current.acceptTo);
    setValueAndCaret(accepted, accepted.length);
    setCaretAtEnd(true);
  }

  /** The composer's keys. `true` means the key was handled here. */
  function onKey(e: KeyboardEvent): boolean {
    const ed = editorRef.current;
    const now = live.current;
    if (ed === null || now.blocked) return false;

    // An IME is mid-composition: Enter commits the candidate, it does not send.
    // `keyCode === 229` is the legacy signal some IMEs still only deliver.
    if (e.isComposing || e.keyCode === 229) return false;

    const mod = e.ctrlKey || e.metaKey;
    const v = docToDraft(ed.state.doc);
    const { from: s, to: en } = selectionOf(ed);

    if (e.key === 'Tab' && !e.shiftKey && !mod && !e.altKey && now.suggestion !== null) {
      e.preventDefault();
      accept(false);
      return true;
    }

    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      e.preventDefault();
      now.submitDraft();
      return true;
    }

    if ((e.key === 'Enter' && e.shiftKey) || (mod && e.key.toLowerCase() === 'j')) {
      e.preventDefault();
      ed.commands.splitBlock();
      return true;
    }

    if (e.key === 'Escape') {
      if (now.running) {
        // The window-level handler would otherwise send a second `interrupt`.
        e.preventDefault();
        e.stopPropagation();
        now.interrupt();
        return true;
      }
      return false;
    }

    if (e.key === 'ArrowUp' && (mod || (s === 0 && en === 0))) {
      e.preventDefault();
      now.historyNav(-1);
      return true;
    }
    if (e.key === 'ArrowDown' && (mod || (s === v.length && en === v.length))) {
      e.preventDefault();
      now.historyNav(1);
      return true;
    }

    if (!mod || e.shiftKey || e.altKey) return false;
    const letter = e.key.toLowerCase();

    if (letter === 'a') {
      e.preventDefault();
      const start = v.lastIndexOf('\n', s - 1) + 1;
      ed.commands.setTextSelection(offsetToPos(ed.state.doc, start));
      return true;
    }
    if (letter === 'e') {
      e.preventDefault();
      const nl = v.indexOf('\n', s);
      ed.commands.setTextSelection(offsetToPos(ed.state.doc, nl === -1 ? v.length : nl));
      return true;
    }
    if (letter === 'w') {
      e.preventDefault();
      const before = v.slice(0, s);
      const trimmed = before.replace(/\s*\S*$/, '');
      setValueAndCaret(trimmed + v.slice(en), trimmed.length);
      return true;
    }
    if (letter === 'u') {
      e.preventDefault();
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      setValueAndCaret(v.slice(0, lineStart) + v.slice(en), lineStart);
      return true;
    }
    return false;
  }

  const empty = draft.trim() === '';
  const showTools = !empty || running || composerNotice !== null || dragging;
  // A height state on top of `is-filled`, never instead of it.
  const large = !empty && isLargeDraft(draft);

  return (
    <div className="composer">
      <div
        className={`cp-box${blocked ? ' is-blocked' : ''}${showTools ? ' is-filled' : ''}${large ? ' is-large' : ''}`}
      >
        {/* The input. Attachments are chips inside it, at the place in the
            sentence they were put; there is no tray above the box. */}
        <EditorContent editor={editor} className="cp-input" aria-label={t('composer.placeholder')} />

        {/* The plus menu: files, skills, commands. The grid area decides where
            it sits, so there is one button, not two copies. */}
        <PlusMenu disabled={blocked} />

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
            ) : suggestion !== null ? (
              <span className="cp-suggest">
                <Tip label={t('composer.suggestAccept', { text: suggestion.text })}>
                  <button
                    type="button"
                    className="cp-suggest-text"
                    onClick={() => accept(true)}
                    aria-label={t('composer.suggestAccept', { text: suggestion.text })}
                  >
                    {suggestion.text}
                  </button>
                </Tip>
                <span className="cp-suggest-key" aria-hidden="true">
                  Tab
                </span>
              </span>
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
                // message to reach; `submitDraft` guards the same for Enter.
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
 * Whether the draft has outgrown the filled box's two 20px lines and earns the
 * 192px tier: several lines, or one long enough to wrap past both. Counts on the
 * string, never a measurement of the rendered box.
 */
function isLargeDraft(draft: string): boolean {
  return draft.split('\n').length >= 3 || draft.length > 200;
}

/**
 * One notice, as the sentence it says. `switch` with no `default`: a new code
 * has to be given a sentence, and the exhaustiveness check enforces that.
 */
function noticeText(t: ReturnType<typeof useT>, notice: ComposerNotice): string {
  switch (notice.code) {
    case 'drop-outside':
      return t('composer.dropOutside', { names: notice.names.join(', ') });
    case 'drop-no-workspace':
      return t('composer.dropNoWorkspace', { names: notice.names.join(', ') });
    case 'attach-remote-failed':
      return t('composer.attachRemoteFailed', { names: notice.names.join(', '), reason: notice.reason });
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
    case 'paste-pending':
      return t('composer.pastePending');
    case 'attach-pending':
      return t('composer.attachPending');
    case 'quiet-unknown':
      return t('composer.quietUnknown', { reason: notice.reason });
  }
}
