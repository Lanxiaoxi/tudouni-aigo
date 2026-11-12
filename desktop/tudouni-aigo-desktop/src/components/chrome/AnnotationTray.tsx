import { MessageSquareQuote, X } from 'lucide-react';
import { NO_ANNOTATIONS, useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { referencedFiles } from '@/runtime/paste';

/**
 * The row of annotated passages, beside the file and picture trays.
 *
 * Same rule as `FileTray`: the chips are a reading of the draft, drawn while
 * each `⟦note-N⟧` token is still in the sentence, and the dismiss button edits
 * the text. The chip shows the head of the quote and of the note; the title
 * carries both in full, because that is the only place the person can read
 * what will be sent before it is.
 */
export function AnnotationTray() {
  const t = useT();
  const draft = useSessionField((rt) => rt.draft, '');
  const annotations = useSessionField((rt) => rt.annotations, NO_ANNOTATIONS);
  const forgetAnnotation = useApp((s) => s.forgetAnnotation);

  // `referencedFiles` is the generic "still in the draft, in sentence order".
  const chips = referencedFiles(draft, annotations);
  if (chips.length === 0) return null;

  return (
    <ul className="cp-images" aria-label={t('composer.annotations')}>
      {chips.map((annotation) => (
        <li
          key={annotation.placeholder}
          className="cp-chip"
          title={`${annotation.quote}\n\n${t('composer.annotationNote')}${annotation.note}`}
        >
          <span className="cp-chip-file" aria-hidden>
            <MessageSquareQuote size={16} />
          </span>
          <span className="cp-chip-note-body">
            <span className="cp-chip-note-quote">{annotation.quote}</span>
            <span className="cp-chip-name">{annotation.note}</span>
          </span>
          <Tip label={t('composer.removeAnnotation')}>
            <button
              type="button"
              className="cp-chip-drop"
              aria-label={t('composer.removeAnnotation')}
              onClick={() => forgetAnnotation(annotation.placeholder)}
            >
              <X size={12} />
            </button>
          </Tip>
        </li>
      ))}
    </ul>
  );
}
