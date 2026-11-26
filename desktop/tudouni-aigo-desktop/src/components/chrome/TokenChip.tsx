import { FileText, MessageSquareQuote, TextQuote, X } from 'lucide-react';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import {
  NO_ANNOTATIONS,
  NO_ATTACHED,
  NO_LONG_PASTES,
  NO_PASTED,
  NO_PENDING,
  NO_PENDING_FILES,
  useApp,
  useSessionField,
} from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { formatBytes, tokenKind } from '@/runtime/paste';

/**
 * One placeholder token, drawn inline in the composer as a chip.
 *
 * The chip **is** the token: the draft holds `⟦pimg-0⟧`, the editor holds one
 * atom node for it, and this view reads the session's lists to say what the
 * token stands for. Deleting the chip (its ✕, or Backspace) deletes the node,
 * the draft loses the token, and the submit path ships nothing for it — the
 * lists are not edited here because an entry whose token is gone is already
 * inert, and editing them would rewrite the draft under the caret.
 *
 * The hover preview is where the detail lives: the full picture, the file's
 * path, the annotated quote, the head of a long paste. A long paste also
 * expands back into its text on click, which is how a person edits one.
 */
export function TokenChip({ node, selected, deleteNode }: ReactNodeViewProps) {
  const t = useT();
  const token = String(node.attrs.token);
  const kind = tokenKind(token);

  const pasted = useSessionField((rt) => rt.pastedImages, NO_PASTED);
  const pendingImages = useSessionField((rt) => rt.pendingImages, NO_PENDING);
  const attached = useSessionField((rt) => rt.attachedFiles, NO_ATTACHED);
  const pendingFiles = useSessionField((rt) => rt.pendingFiles, NO_PENDING_FILES);
  const annotations = useSessionField((rt) => rt.annotations, NO_ANNOTATIONS);
  const longPastes = useSessionField((rt) => rt.longPastes, NO_LONG_PASTES);

  let body: React.ReactNode = null;
  let preview: React.ReactNode = null;
  let pending = false;
  let removeLabel = t('composer.removeFile');
  let onOpen: (() => void) | null = null;

  if (kind === 'pimg') {
    const done = pasted.find((image) => image.placeholder === token);
    const busy = pendingImages.find((image) => image.placeholder === token);
    const image = done ?? busy;
    if (image) {
      pending = !done;
      removeLabel = t('composer.removeImage');
      body = (
        <>
          <img className="cp-tok-thumb" src={image.url} alt="" />
          <span className="cp-tok-name">{done ? done.name : t('composer.imageUploading')}</span>
        </>
      );
      preview = (
        <span className="cp-tok-preview">
          <img className="cp-tok-preview-img" src={image.url} alt="" />
          <span className="cp-tok-preview-meta">
            {done ? `${done.path} · ` : ''}
            {formatBytes(image.bytes)}
          </span>
        </span>
      );
    }
  } else if (kind === 'file') {
    const done = attached.find((file) => file.placeholder === token);
    const busy = pendingFiles.find((file) => file.placeholder === token);
    const file = done ?? busy;
    if (file) {
      pending = !done;
      body = (
        <>
          <FileText size={13} className="cp-tok-icon" aria-hidden />
          <span className="cp-tok-name">{file.name}</span>
          {pending ? <span className="cp-tok-meta">{t('composer.imageUploading')}</span> : null}
        </>
      );
      preview = done ? done.path : t('composer.imageUploading');
    }
  } else if (kind === 'note') {
    const annotation = annotations.find((entry) => entry.placeholder === token);
    if (annotation) {
      removeLabel = t('composer.removeAnnotation');
      body = (
        <>
          <MessageSquareQuote size={13} className="cp-tok-icon" aria-hidden />
          <span className="cp-tok-name">{annotation.note}</span>
        </>
      );
      preview = (
        <span className="cp-tok-preview">
          <span className="cp-tok-preview-quote">{annotation.quote}</span>
          <span>
            {t('composer.annotationNote')}
            {annotation.note}
          </span>
        </span>
      );
    }
  } else if (kind === 'text') {
    const paste = longPastes.find((entry) => entry.placeholder === token);
    if (paste) {
      removeLabel = t('composer.removeLongPaste');
      body = (
        <>
          <TextQuote size={13} className="cp-tok-icon" aria-hidden />
          <span className="cp-tok-name">{t('composer.longPaste', { chars: paste.text.length })}</span>
        </>
      );
      preview = <span className="cp-tok-preview-text">{paste.text.slice(0, 600)}</span>;
      // Expanding swaps the token for its text in the draft; the composer's
      // sync puts the text into the box.
      onOpen = () => {
        const s = useApp.getState();
        const draft = s.sessions[s.activeKey ?? '']?.draft ?? '';
        s.setDraft(draft.split(token).join(paste.text));
      };
    }
  }

  // A token nothing stands for (typed by hand, or left by an old message) is
  // prose: shown as the text it is, quietly.
  if (body === null) {
    return (
      <NodeViewWrapper as="span" className="cp-tok-raw">
        {token}
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as="span"
      className={`cp-tok${pending ? ' is-pending' : ''}${selected ? ' is-selected' : ''}`}
      contentEditable={false}
      aria-busy={pending || undefined}
    >
      <Tip label={preview} side="top">
        <span
          className={`cp-tok-body${onOpen ? ' is-openable' : ''}`}
          onClick={onOpen ?? undefined}
        >
          {body}
        </span>
      </Tip>
      <button
        type="button"
        className="cp-tok-drop"
        aria-label={removeLabel}
        title={removeLabel}
        // Keep the editor's selection: a mousedown on a button would blur it.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => deleteNode()}
      >
        <X size={11} />
      </button>
    </NodeViewWrapper>
  );
}
