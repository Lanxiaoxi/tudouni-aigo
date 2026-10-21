import { MessageCircleQuestion } from 'lucide-react';
import {
  selectModalOrigin,
  selectQuestionMinimized,
  useApp,
} from '@/state/store';
import { useT } from '@/i18n/useT';

/**
 * The way back from a minimized question.
 *
 * The question modal's minimize hides its overlay so the reply above it can
 * be read, and it does not send anything — the runtime keeps waiting on the
 * same id. While it is set there is no other surface that says "a prompt is
 * waiting here and you put it aside": the rail's amber dot means the same
 * thing as "another session is asking", and the session board is the surface
 * for *that*. So the minimized state gets its own pill, beside the status
 * bar, on purpose:
 *
 *   - it is drawn only while `selectQuestionMinimized` holds — the mark is
 *     keyed to the request's id, so a pill can never name a question that is
 *     not in the drawn slot and still drawn;
 *   - it names the conversation that asked, like the modal's own origin row
 *     does, because several sessions open the pill would otherwise say a
 *     question is waiting without saying whose;
 *   - pressing it restores the prompt with the draft it had: minimize is not
 *     a decision, so the selection and the free text are left intact (they
 *     live in `QuestionModal`, which stays mounted — only the Radix overlay
 *     unmounts).
 *
 * Bottom-centred, above the status bar: the transcript the person is reading
 * is above, and the pill must not be the thing they have to hunt for when
 * they are done.
 */
export function QuestionMinimizedPill() {
  const t = useT();
  const minimized = useApp(selectQuestionMinimized);
  const origin = useApp((s) =>
    minimized && s.modal ? selectModalOrigin(s, s.modal.key) : '',
  );

  if (!minimized) return null;

  return (
    <button
      type="button"
      className="qmp"
      onClick={() => useApp.getState().restoreQuestion()}
      aria-label={t('q.minimized.restore')}
    >
      <MessageCircleQuestion size={13} className="qmp-icon" aria-hidden />
      <span className="qmp-text">{t('q.minimized.restore')}</span>
      {origin ? <span className="qmp-origin">{origin}</span> : null}
    </button>
  );
}
