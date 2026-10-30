import { X } from 'lucide-react';
import { NO_PASTED, NO_PENDING, useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { formatBytes, referencedImages, type PastedImage, type PendingImage } from '@/runtime/paste';

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
 * ## Two kinds of chip, one row
 *
 * A picture is drawn the moment the paste happens, while the write is still in
 * flight (`pendingImages`), because a remote upload takes seconds and a paste
 * that shows nothing for that long reads as a dropped keystroke. When the write
 * lands the chip changes list and stops saying "uploading" — same token, same
 * thumbnail, same place in the row. The order comes from the **sentence** across
 * both lists, because that is the order the pictures will appear in the message.
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
 * which is why it lives here and not in a store action about attachments. While a
 * chip is pending the same button also drops it from the write's outcome: the
 * upload cannot be cancelled, but a picture the person removed must not reappear
 * as a chip when it finishes.
 */
export function ImageTray() {
  const t = useT();
  // The draft and its pictures belong to the session being shown: the path each
  // entry holds is workspace-relative, so a chip from another conversation would
  // name a file this one cannot resolve.
  const draft = useSessionField((rt) => rt.draft, '');
  const pastedImages = useSessionField((rt) => rt.pastedImages, NO_PASTED);
  const pendingImages = useSessionField((rt) => rt.pendingImages, NO_PENDING);
  const forgetImage = useApp((s) => s.forgetImage);

  // The token's position decides the order, across both lists: a picture being
  // written sits where the person pasted it, not at the end.
  const chips: { image: PastedImage | PendingImage; pending: boolean }[] = [
    ...referencedImages(draft, pendingImages).map((image) => ({ image, pending: true })),
    ...referencedImages(draft, pastedImages).map((image) => ({ image, pending: false })),
  ].sort((a, b) => draft.indexOf(a.image.placeholder) - draft.indexOf(b.image.placeholder));

  if (chips.length === 0) return null;

  return (
    <ul className="cp-images" aria-label={t('composer.images')}>
      {chips.map(({ image, pending }) => (
        <li
          key={image.placeholder}
          className={`cp-chip${pending ? ' is-pending' : ''}`}
          // What the picture is going to ship as, where it is known: the chip's
          // own label is a name, and the path is the fact the sentence carries.
          title={pending ? t('composer.imageUploading') : (image as PastedImage).path}
        >
          {/* The preview is a `blob:` URL of the bytes already in this window, so
              no asset protocol and no disk read are involved — and it is there
              before the write is, which is the point of a pending chip. `alt=""`
              on purpose: the name beside it is the accessible name, and a
              thumbnail is decoration for someone who can already see it. */}
          <img className="cp-chip-thumb" src={image.url} alt="" />
          <span className="cp-chip-name">
            {pending ? t('composer.imageUploading') : (image as PastedImage).name}
          </span>
          <span className="cp-chip-size">{formatBytes(image.bytes)}</span>
          <Tip label={t('composer.removeImage')}>
            <button
              type="button"
              className="cp-chip-drop"
              aria-label={t('composer.removeImage')}
              onClick={() => forgetImage(image.placeholder)}
            >
              <X size={12} />
            </button>
          </Tip>
        </li>
      ))}
    </ul>
  );
}
