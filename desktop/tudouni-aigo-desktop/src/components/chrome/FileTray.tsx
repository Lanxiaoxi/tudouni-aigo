import { FileText, X } from 'lucide-react';
import { NO_ATTACHED, NO_PENDING_FILES, useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { referencedFiles, type AttachedFile, type PendingFile } from '@/runtime/paste';

/**
 * The row of attached files, above the input.
 *
 * The pasted pictures' tray (`ImageTray`), minus the preview: a file picked
 * from the workspace browser or a native dialog already has a path, so there
 * are no bytes in this window to show. What the chip adds is *the name* — the
 * draft carries a placeholder (`⟦file-0⟧`) and the path is put back at submit
 * time, so this row is the only place the person can see what is going out.
 *
 * ## Two kinds of chip, one row
 *
 * On a **remote** screen a dropped file is uploaded first, which takes seconds.
 * Like a pasted picture it is drawn the moment the drop happens
 * (`pendingFiles`) and stops saying "Uploading…" when the host answers — same
 * token, same place in the row. The order comes from the **sentence** across
 * both lists, because that is the order the files will appear in the message.
 *
 * The chips are derived from the draft by the same rule as the picture tray:
 * deleting the placeholder drops the chip, and a chip never claims a file that
 * is not going anywhere. The dismiss button edits the text, for the same
 * one-source-of-truth reason its picture counterpart does.
 */
export function FileTray() {
  const t = useT();
  // Per session, like the pictures: the path each entry holds is relative to
  // *this* conversation's workspace.
  const draft = useSessionField((rt) => rt.draft, '');
  const attachedFiles = useSessionField((rt) => rt.attachedFiles, NO_ATTACHED);
  const pendingFiles = useSessionField((rt) => rt.pendingFiles, NO_PENDING_FILES);
  const forgetAttachedFile = useApp((s) => s.forgetAttachedFile);
  const forgetPendingFile = useApp((s) => s.forgetPendingFile);

  const chips: { file: AttachedFile | PendingFile; pending: boolean }[] = [
    ...referencedFiles(draft, pendingFiles).map((file) => ({ file, pending: true })),
    ...referencedFiles(draft, attachedFiles).map((file) => ({ file, pending: false })),
  ].sort((a, b) => draft.indexOf(a.file.placeholder) - draft.indexOf(b.file.placeholder));

  if (chips.length === 0) return null;

  return (
    <ul className="cp-images" aria-label={t('composer.files')}>
      {chips.map(({ file, pending }) => (
        <li
          key={file.placeholder}
          className={`cp-chip${pending ? ' is-pending' : ''}`}
          aria-busy={pending || undefined}
        >
          <span className="cp-chip-file" aria-hidden>
            <FileText size={16} />
          </span>
          {/* A pending chip already knows the local name, so unlike a pending
              picture it shows it, with the state beside it: the person dropped
              this file by that name and is looking for it. */}
          <span
            className="cp-chip-name"
            title={pending ? t('composer.imageUploading') : (file as AttachedFile).path}
          >
            {file.name}
          </span>
          {pending && <span className="cp-chip-size">{t('composer.imageUploading')}</span>}
          <Tip label={t('composer.removeFile')}>
            <button
              type="button"
              className="cp-chip-drop"
              aria-label={t('composer.removeFile')}
              onClick={() =>
                pending
                  ? forgetPendingFile(file.placeholder)
                  : forgetAttachedFile((file as AttachedFile).path)
              }
            >
              <X size={12} />
            </button>
          </Tip>
        </li>
      ))}
    </ul>
  );
}
