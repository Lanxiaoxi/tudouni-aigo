import { FileText, X } from 'lucide-react';
import { NO_ATTACHED, useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { referencedFiles } from '@/runtime/paste';

/**
 * The row of files attached from the plus menu, above the input.
 *
 * The pasted pictures' tray (`ImageTray`), minus the preview: a file picked
 * from the workspace browser or a native dialog already has a path, so there
 * are no bytes in this window to show. What the chip adds is *the name* — the
 * draft carries a placeholder (`⟦file-0⟧`) and the path is put back at submit
 * time, so this row is the only place the person can see what is going out.
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
  const forgetAttachedFile = useApp((s) => s.forgetAttachedFile);

  const shown = referencedFiles(draft, attachedFiles);
  if (shown.length === 0) return null;

  return (
    <ul className="cp-images" aria-label={t('composer.files')}>
      {shown.map((file) => (
        <li key={file.path} className="cp-chip">
          <span className="cp-chip-file" aria-hidden>
            <FileText size={16} />
          </span>
          <span className="cp-chip-name" title={file.path}>
            {file.name}
          </span>
          <Tip label={t('composer.removeFile')}>
            <button
              type="button"
              className="cp-chip-drop"
              aria-label={t('composer.removeFile')}
              onClick={() => forgetAttachedFile(file.path)}
            >
              <X size={12} />
            </button>
          </Tip>
        </li>
      ))}
    </ul>
  );
}
