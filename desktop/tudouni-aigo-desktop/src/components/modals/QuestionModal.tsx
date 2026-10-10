import { useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Check, MessageCircleQuestion, SkipForward } from 'lucide-react';
import { selectModalOrigin, selectModalVisible, selectQueuedModals, useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Badge } from '@/components/ui/kit';
import { isTypingTarget } from '@/hooks/useListKeys';

/**
 * §6.2 The question modal — the second blocking modal.
 *
 * Hard constraints:
 *   - Show the question, the header label, the options, and a free-text field.
 *   - `options` is a `string[]`: an **empty array means free-form**. There are no
 *     option ids and no `allow_free_text` / `allow_skip` flags — the protocol
 *     does not have them, so this view does not behave as if it did.
 *   - Free text wins over a selection: if there is text, the text is the answer.
 *   - **Skip is an independent action.** An empty submit must never stand in for
 *     "I did not decide", so Skip is its own button and Esc resolves to it.
 *   - Numeric keys 1–9 pick the corresponding option.
 *   - It blocks until a person answers: no auto-skip, no timeout, no guess.
 */
export function QuestionModal() {
  const t = useT();
  const modal = useApp((s) => s.modal);
  const answer = useApp((s) => s.answerQuestion);
  // Same as the approval modal: with several conversations open, a question
  // whose session is not named is a question about an unknown session — and the
  // answer goes to whichever one asked, so knowing which is not cosmetic.
  const origin = useApp((s) => (s.modal ? selectModalOrigin(s, s.modal.key) : ''));
  const queued = useApp(selectQueuedModals);
  // **Held is not the same as rendered.** The session board holds the
  // conversation column while it is open, and it is the surface that already
  // names the session that is waiting — so a question arriving there stays
  // unrendered (see `selectModalVisible`) until the click on its card surfaces
  // it. The queue keeps it alive; nobody answers it from here.
  const visible = useApp(selectModalVisible);

  const open = visible && modal?.kind === 'question';
  const req = open ? modal.req : null;

  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState('');

  // Every question is a fresh decision, so the draft is cleared when the
  // question changes.
  const reqId = req?.id ?? null;
  const [lastId, setLastId] = useState<string | null>(null);
  if (reqId !== lastId) {
    setLastId(reqId);
    setSelected([]);
    setText('');
  }

  const options = req?.options ?? [];
  const hasOptions = options.length > 0;
  const canSubmit = text.trim() !== '' || selected.length > 0;

  function toggle(option: string) {
    setSelected((cur) =>
      cur.includes(option) ? cur.filter((x) => x !== option) : [...cur, option],
    );
  }

  function submit() {
    // Free text wins: if there is text, that is the answer.
    if (text.trim() !== '') {
      answer('answered', text.trim());
      return;
    }
    if (selected.length > 0) {
      // Options are plain strings — what goes back is the text, joined.
      answer('answered', selected.join(', '));
      return;
    }
  }

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
            answer('skipped', ''); // Skip is an independent action, not "nothing happened".
          }}
          onKeyDown={(e) => {
            if (!req) return;
            // The free-text box is inside this content, so without this check a
            // `1` typed into "3 replicas please" would bubble up and select
            // option 1 instead of reaching the field.
            if (isTypingTarget(e.target)) return;
            if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
              const option = req.options[Number(e.key) - 1];
              if (option === undefined) return;
              e.preventDefault();
              if (req.multi_select) toggle(option);
              else setSelected([option]);
            }
          }}
        >
          {req ? (
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
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="dialog-desc">
                    {t('q.subtitle')}
                  </DialogPrimitive.Description>
                </div>

                {/* The header is a label of at most 12 characters; an empty
                    string means there is none. */}
                {req.header ? (
                  <Badge tone="neutral" dot={false}>
                    {req.header}
                  </Badge>
                ) : null}
                <Badge tone={req.multi_select ? 'info' : 'neutral'} dot={false}>
                  {req.multi_select ? t('q.multi') : t('q.single')}
                </Badge>
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

              <div className="dialog-body scroll">
                <p style={{ fontSize: 'var(--text-body)', marginBottom: 'var(--space-3)' }}>
                  {req.question}
                </p>

                {hasOptions ? (
                  <>
                    <div className="etb-label">{t('q.options')}</div>
                    <div className="col" style={{ gap: 2, marginTop: 4 }}>
                      {req.options.map((option, i) => {
                        const checked = selected.includes(option);
                        return (
                          <div
                            key={option}
                            className="radio-item"
                            role="button"
                            tabIndex={0}
                            data-state={checked ? 'checked' : 'unchecked'}
                            onClick={() => (req.multi_select ? toggle(option) : setSelected([option]))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                if (req.multi_select) toggle(option);
                                else setSelected([option]);
                              }
                            }}
                          >
                            {/* Multi-select draws a checkbox; single choice draws
                                a radio. Same primitive, different affordance. */}
                            <span
                              className={req.multi_select ? 'checkbox-box' : 'radio-outer'}
                              aria-hidden
                            >
                              {checked ? (
                                req.multi_select ? (
                                  <Check size={11} />
                                ) : (
                                  <span className="radio-inner" />
                                )
                              ) : null}
                            </span>
                            <span className="seq">{i + 1}</span>
                            <span className="grow">
                              <span className="strong">{option}</span>
                            </span>
                          </div>
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
                  value={text}
                  onChange={(e) => setText(e.target.value)}
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
                  {text.trim() !== ''
                    ? t('q.freeTextPriority')
                    : selected.length > 0
                      ? t('q.submit')
                      : hasOptions
                        ? t('q.pickAtLeastOne')
                        : t('q.freeTextPriority')}
                </span>
                <span className="grow" />

                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => answer('skipped', '')}
                >
                  <SkipForward size={12} />
                  {t('q.skip')}
                  <kbd className="kbd" style={{ marginLeft: 4 }}>
                    Esc
                  </kbd>
                </button>

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={submit}
                  disabled={!canSubmit}
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
