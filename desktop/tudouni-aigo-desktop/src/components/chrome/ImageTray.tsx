import { X } from 'lucide-react';
import { NO_PASTED, useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { formatBytes, referencedImages } from '@/runtime/paste';

/**
 * The row of pasted pictures, above the input.
 *
 * ## What it is for
 *
 * A pasted picture reaches the model as **a path in the sentence** — the runtime
 * has no other channel (`internal/runtime/images.go`). The sentence that goes out
 * is complete without this row; what the row adds is *sight*. The draft carries a
 * placeholder (`⟦pimg-0⟧`) and the path is put back at submit time, so what this
 * row names is the picture, not a string the person would have to read.
 *
 * ## Why the chips are derived from the draft
 *
 * `referencedImages` decides which chips to draw by looking at the **text**, not
 * at the list of stashed pictures. That is the whole design: the text is the only
 * surface the person reads, so deleting a placeholder from the sentence must drop
 * its chip, and a chip must never claim a picture that is not going anywhere.
 * The alternative — a separate list of attachments — is a second source of truth,
 * and the failure it produces is the worst kind: a screen that says three pictures
 * are attached when the message carries two.
 *
 * The dismiss button therefore edits the **text** (`removePlaceholderFromDraft`),
 * which is why it lives here and not in a store action about attachments.
 */
export function ImageTray() {
  const t = useT();
  // The draft and its pictures belong to the session being shown: the path each
  // entry holds is workspace-relative, so a chip from another conversation would
  // name a file this one cannot resolve.
  const draft = useSessionField((rt) => rt.draft, '');
  const pastedImages = useSessionField((rt) => rt.pastedImages, NO_PASTED);
  const forgetPastedImage = useApp((s) => s.forgetPastedImage);

  const shown = referencedImages(draft, pastedImages);
  if (shown.length === 0) return null;

  return (
    <ul className="cp-images" aria-label={t('composer.images')}>
      {shown.map((image) => (
        <li key={image.path} className="cp-chip">
          {/* The preview is a `blob:` URL of the bytes already in this window, so
              no asset protocol and no disk read are involved. `alt=""` on
              purpose: the file name beside it is the accessible name, and a
              thumbnail is decoration for someone who can already see it. */}
          <img className="cp-chip-thumb" src={image.url} alt="" />
          <span className="cp-chip-name" title={image.path}>
            {image.name}
          </span>
          <span className="cp-chip-size">{formatBytes(image.bytes)}</span>
          <Tip label={t('composer.removeImage')}>
            <button
              type="button"
              className="cp-chip-drop"
              aria-label={t('composer.removeImage')}
              onClick={() => forgetPastedImage(image.path)}
            >
              <X size={12} />
            </button>
          </Tip>
        </li>
      ))}
    </ul>
  );
}
