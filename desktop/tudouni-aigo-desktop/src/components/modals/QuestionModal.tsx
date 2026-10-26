import { useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Check, ChevronLeft, ChevronRight, MessageCircleQuestion, Minus, SkipForward } from 'lucide-react';
import {
  selectModalOrigin,
  selectModalVisible,
  selectQueuedModals,
  selectQuestionMinimized,
  useApp,
} from '@/state/store';
import { useT } from '@/i18n/useT';
import { Badge, Tip } from '@/components/ui/kit';
import { isTypingTarget } from '@/hooks/useListKeys';

/**
 * §6.2 The question modal — the second blocking modal.
 *
 * One panel holds the whole batch: every question an `ask_user` call asked,
 * drawn as pages with a navigation strip over them. The runtime sends the
 * batch back to back and waits on every id of it, so answering is one act per
 * batch — `answerQuestion` fans the per-page drafts out to one
 * `question_response` per request id.
 *
 * Hard constraints (unchanged from the single-question panel):
 *   - Show the question, the header label, the options, and a free-text field.
 *   - `options` is a `string[]`: an **empty array means free-form**. There are
 *     no option ids and no `allow_free_text` / `allow_skip` flags — the
 *     protocol does not have them, so this view does not behave as if it did.
 *   - Free text wins over a selection: if there is text, the text is the
 *     answer.
 *   - **Skip is explicit.** Esc skips the whole batch as one independent
 *     action; an unanswered page is submitted as a skipped question — and the
 *     footer says that, so "nothing happened" is never read as an answer.
 *   - Numeric keys 1–9 pick the corresponding option of the page on screen;
 *     `←`/`→` move between pages.
 *   - It blocks until a person answers: no auto-skip, no timeout, no guess.
 *   - **Minimize hides, it does not answer.** The foot's minimize button takes
 *     the overlay away so the reply above the prompt can be read; the runtime
 *     keeps waiting on the same ids and the queue keeps the request. Nothing
 *     is sent, and `selectModalVisible` deliberately stays true while it is
 *     set (see its comment) — the composer's blocked state is the deadlock
 *     guard, and the minimized pill beside the status bar is the way back.
 *
 * **The dialog stays open for the whole batch.** That is what fixes the
 * one-question-at-a-time flicker: switching pages changes the body, not the
 * overlay, so Radix never unmounts and remounts the panel between questions
 * (its close→open cycle was eating the second question's content).
 */

/** One page's draft: the selection and the free text. Both are the person's,
 *  kept until the batch is submitted — moving pages and minimizing never
 *  clear them. */
interface Draft {
  selected: string[];
  text: string;
}

/** What the draft becomes on the wire: free text wins, then the selection,
 *  then `null` — an explicit "this one was skipped", never an empty string. */
function answerOf(draft: Draft): string | null {
  const text = draft.text.trim();
  if (text !== '') return text;
  if (draft.selected.length > 0) return draft.selected.join(', ');
  return null;
}

export function QuestionModal() {
  const t = useT();
  const modal = useApp((s) => s.modal);
  const answer = useApp((s) => s.answerQuestion);
  // Same as the approval modal: with several conversations open, a question
  // whose session is not named is a question about an unknown session — and
  // the answer goes to whichever one asked, so knowing which is not cosmetic.
  const origin = useApp((s) => (s.modal ? selectModalOrigin(s, s.modal.key) : ''));
  const queued = useApp(selectQueuedModals);
  // **Held is not the same as rendered.** The session board holds the
  // conversation column while it is open, and it is the surface that already
  // names the session that is waiting — so a question arriving there stays
  // unrendered (see `selectModalVisible`) until the click on its card surfaces
  // it. The queue keeps it alive; nobody answers it from here.
  const visible = useApp(selectModalVisible);
  // The person's own hold, on top of the two `selectModalVisible` already
  // knows. It un-draws the prompt without touching the queue or the blocked
  // state — the overlay is what covers the reply, not the blocking.
  const minimized = useApp(selectQuestionMinimized);

  // A half-arrived batch must not open: it would show a missing page and
  // collect answers for questions the person has not seen.
  const open =
    visible && !minimized && modal?.kind === 'question' && modal.batch.ready;
  // The batch in the drawn slot, regardless of the minimize: the drafts below
  // key off **it** rather than off what is drawn, so a minimize (which only
  // un-draws) does not read as a new batch and wipe the selections and the
  // free text. Restoring must find the draft the person had.
  const slotBatch = visible && modal?.kind === 'question' ? modal.batch : null;
  const batch = open ? slotBatch : null;

  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>([]);

  // Every batch is a fresh decision, so the drafts are cleared when the
  // batch changes — the slot's batch, not the draw, is the question.
  const batchId = slotBatch?.batch_id ?? null;
  const [lastBatchId, setLastBatchId] = useState<string | null>(null);
  if (batchId !== lastBatchId) {
    setLastBatchId(batchId);
    setPage(0);
    setDrafts(
      slotBatch
        ? slotBatch.questions.map(() => ({ selected: [], text: '' }))
        : [],
    );
  }

  const questions = batch?.questions ?? [];
  const current = Math.min(page, Math.max(0, questions.length - 1));
  const question = questions[current];
  const draft = drafts[current] ?? { selected: [], text: '' };
  const hasOptions = question ? question.options.length > 0 : false;

  function patchDraft(patch: Partial<Draft>) {
    setDrafts((cur) => cur.map((d, i) => (i === current ? { ...d, ...patch } : d)));
  }

  function toggle(option: string) {
    if (!question) return;
    const selected = draft.selected.includes(option)
      ? draft.selected.filter((x) => x !== option)
      : [...draft.selected, option];
    patchDraft({ selected: question.multi_select ? selected : [option] });
  }

  /** The per-question state for the navigation strip: answered, or (with
   *  nothing chosen) skipped-on-submit. Both are the person's explicit
   *  decisions, so the strip draws them both. */
  function navState(index: number): 'answered' | 'pending' {
    return answerOf(drafts[index] ?? { selected: [], text: '' }) !== null
      ? 'answered'
      : 'pending';
  }

  function submit() {
    if (!batch) return;
    // One array, in the batch's order: each entry is answered, or null —
    // which the store sends back as a skipped question for that id.
    answer(drafts.map((d) => answerOf(d)));
  }

  // **Hides the overlay, nothing else.** No answer is sent — the runtime keeps
  // waiting on this id, the queue keeps the request, and the drafts above are
  // left intact (minimizing is not a decision). The transcript underneath is
  // the whole reason the button exists.
  function minimize() {
    useApp.getState().minimizeQuestion();
  }

  const unanswered = drafts.filter((d) => answerOf(d) === null).length;

  return (
    <DialogPrimitive.Root open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content
          className="dialog"
          // As in `PermissionModal`: a visible `Description` is rendered, so
          // Radix's automatic association is the accurate one. Passing
          // `undefined` here silenced it while the sentence stayed on screen.
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            // Skip is an independent action, not "nothing happened": the whole
            // batch goes back unanswered.
            answer(null);
          }}
          onKeyDown={(e) => {
            if (!question) return;
            // The free-text box is inside this content, so without this check a
            // `1` typed into "3 replicas please" would bubble up and select
            // option 1 instead of reaching the field.
            if (isTypingTarget(e.target)) return;
            if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
              const option = question.options[Number(e.key) - 1];
              if (option === undefined) return;
              e.preventDefault();
              if (question.multi_select) toggle(option);
              else patchDraft({ selected: [option] });
              return;
            }
            if (e.key === 'ArrowLeft' && !e.ctrlKey && !e.metaKey && !e.altKey) {
              e.preventDefault();
              setPage((p) => Math.max(0, p - 1));
              return;
            }
            if (e.key === 'ArrowRight' && !e.ctrlKey && !e.metaKey && !e.altKey) {
              e.preventDefault();
              setPage((p) => Math.min(questions.length - 1, p + 1));
            }
          }}
        >
          {batch && question ? (
            <>
              <div className="dialog-head">
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 28,
                    height: 28,
                    flex: 'none',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--info-subtle)',
                    color: 'var(--info)',
                  }}
                >
                  <MessageCircleQuestion size={15} />
                </span>

                <div className="grow">
                  <DialogPrimitive.Title className="dialog-title">
                    {t('q.title')}
                    {questions.length > 1 ? (
                      <span className="q-page-of">
                        {' '}
                        {t('q.pageOf', { n: current + 1, total: questions.length })}
                      </span>
                    ) : null}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="dialog-desc">
                    {t('q.subtitle')}
                  </DialogPrimitive.Description>
                </div>

                {/* The header is a label of at most 12 characters; an empty
                    string means there is none. */}
                {question.header ? (
                  <Badge tone="neutral" dot={false}>
                    {question.header}
                  </Badge>
                ) : null}
                <Badge tone={question.multi_select ? 'info' : 'neutral'} dot={false}>
                  {question.multi_select ? t('q.multi') : t('q.single')}
                </Badge>

                {/* The minimize control lives in the head's far right — the
                    corner a window's minimize button sits in — rather than
                    among the foot's answer actions: hiding the panel is about
                    the panel, not about the answer, so it does not belong
                    beside Skip all and Submit. */}
                <Tip label={t('q.minimizeHint')} side="bottom">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ flex: 'none', width: 26, height: 26, padding: 0 }}
                    onClick={() => minimize()}
                    aria-label={t('q.minimize')}
                  >
                    <Minus size={14} />
                  </button>
                </Tip>
              </div>

              {/* Which conversation asked, and whether another request is
                  queued behind this one. Both are stated rather than implied:
                  the answer goes back to the session that asked, so a reader
                  who cannot tell which one that is cannot answer safely — and
                  the queue is still invisible after this prompt is answered. */}
              {origin || queued > 0 ? (
                <div
                  className="row"
                  style={{
                    gap: 'var(--space-2)',
                    flexWrap: 'wrap',
                    padding: '0 var(--space-4)',
                    marginTop: 'calc(-1 * var(--space-2))',
                  }}
                >
                  {origin ? (
                    <span className="caption muted">
                      {t('modal.from')} <span className="mono">{origin}</span>
                    </span>
                  ) : null}
                  {queued > 0 ? (
                    <Badge tone="neutral" dot={false}>
                      {t('modal.queued', { n: queued })}
                    </Badge>
                  ) : null}
                </div>
              ) : null}

              {/* The navigation strip: one stop per question of the batch. A
                  tick says answered; the plain number says nothing chosen yet
                  (and the footer says that submits as a skip). It is the one
                  place the person sees the whole batch at a glance. */}
              {questions.length > 1 ? (
                <div className="qnav" role="tablist" aria-label={t('q.pageOf', { n: current + 1, total: questions.length })}>
                  {questions.map((q, i) =>
                    // `ready` holds only when every slot is filled, so a null
                    // page here would mean the batch opened early; draw nothing
                    // for it rather than a phantom stop.
                    q === null ? null : (
                      <button
                        key={q.id}
                        type="button"
                        role="tab"
                        aria-selected={i === current}
                        aria-label={`${i + 1}${q.header ? ` ${q.header}` : ''}`}
                        className={`qnav-item${i === current ? ' is-on' : ''}${navState(i) === 'answered' ? ' is-answered' : ''}`}
                        onClick={() => setPage(i)}
                      >
                        <span className="qnav-num">{i + 1}</span>
                        {navState(i) === 'answered' ? <Check size={11} /> : null}
                      </button>
                    ),
                  )}
                </div>
              ) : null}

              <div className="dialog-body scroll-fade">
                <p style={{ fontSize: 'var(--text-body)', marginBottom: 'var(--space-3)' }}>
                  {question.question}
                </p>

                {hasOptions ? (
                  <>
                    <div className="etb-label">{t('q.options')}</div>
                    {/* The same row as the model picker: a tick column, the
                        label, nothing else. `tk-menu-item` is flex with
                        `width: 100%`, so it draws as a list row here without
                        any of the popover chrome. */}
                    <div className="col" style={{ gap: 2, marginTop: 4 }}>
                      {question.options.map((option) => {
                        const checked = draft.selected.includes(option);
                        return (
                          <button
                            key={option}
                            type="button"
                            role="option"
                            aria-selected={checked}
                            className={`tk-menu-item${checked ? ' is-on' : ''}`}
                            onClick={() => toggle(option)}
                          >
                            {checked ? (
                              <Check size={13} />
                            ) : (
                              <span className="tk-menu-gap" />
                            )}
                            <span className="tk-menu-item-label">{option}</span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  // An empty array means free-form — say so rather than drawing
                  // an empty list.
                  <div className="caption muted">{t('q.noOptions')}</div>
                )}

                {/* Free text is always available: with no options it is the only
                    way to answer, and with options it takes priority. */}
                <div className="etb-label" style={{ marginTop: 'var(--space-4)' }}>
                  {t('q.freeText')}
                </div>
                <textarea
                  className="input"
                  value={draft.text}
                  onChange={(e) => patchDraft({ text: e.target.value })}
                  placeholder={t('q.freeTextPlaceholder')}
                  style={{
                    display: 'block',
                    width: '100%',
                    height: 'auto',
                    minHeight: 72,
                    marginTop: 4,
                    padding: 'var(--space-2) var(--space-3)',
                    resize: 'vertical',
                    lineHeight: 'var(--leading-body)',
                  }}
                />
              </div>

              <div className="dialog-foot">
                <span className="caption faint">
                  {draft.text.trim() !== ''
                    ? t('q.freeTextPriority')
                    : drafts.length > 1
                      ? unanswered > 0
                        ? t('q.unansweredSkipped', { n: unanswered })
                        : t('q.allAnswered')
                      : hasOptions
                        ? t('q.pickAtLeastOne')
                        : t('q.freeTextPriority')}
                </span>
                <span className="grow" />

                {/* Page arrows flank the foot's primary actions only; the
                    navigation strip above is the primary way to move. */}
                {questions.length > 1 ? (
                  <span className="row" style={{ gap: 2 }}>
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={current === 0}
                      aria-label={t('q.prev')}
                    >
                      <ChevronLeft size={13} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={() => setPage((p) => Math.min(questions.length - 1, p + 1))}
                      disabled={current === questions.length - 1}
                      aria-label={t('q.next')}
                    >
                      <ChevronRight size={13} />
                    </button>
                  </span>
                ) : null}

                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => answer(null)}
                >
                  <SkipForward size={12} />
                  {t('q.skipAll')}
                  <kbd className="kbd" style={{ marginLeft: 4 }}>
                    Esc
                  </kbd>
                </button>

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => submit()}
                >
                  {t('q.submit')}
                </button>
              </div>
            </>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
