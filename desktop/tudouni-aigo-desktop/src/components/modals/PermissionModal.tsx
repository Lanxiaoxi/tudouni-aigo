import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AlertOctagon, AlertTriangle, ShieldCheck } from 'lucide-react';
import { selectModalOrigin, selectQueuedModals, useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Badge, Fact, RiskTag } from '@/components/ui/kit';
import { formatArguments } from '@/utils/format';

/**
 * §6.1 The approval modal — one of the two blocking modals.
 *
 * Hard constraints, all of them fail-closed:
 *   - Show the tool name, its risk, and the arguments **in full, untruncated**.
 *     The decisive half of a risky command is usually at the end.
 *   - The runtime's two hints are displayed **verbatim**. Whoever wrote them is
 *     the only party that knows what "remember" means, so not one character is
 *     changed — and they are never translated.
 *   - It blocks until a person answers: no auto-skip, no timeout fallback, no
 *     guessing.
 *   - "Always allow" appears **only** when the runtime supplied something to
 *     remember. Offering it with nothing to record would be a key that looks
 *     like it works and changes nothing.
 *   - "Allow all" appears **only** when `allow_trust_all` is set.
 *   - Deny and closing are the same thing, so Esc resolves to `deny` — it does
 *     not leave the question open.
 *
 * `always_group` covers a group the runtime looks up by request id; this view
 * never names the tools, because letting the client name them would let the
 * client rewrite the policy.
 */
export function PermissionModal() {
  const t = useT();
  const modal = useApp((s) => s.modal);
  const answer = useApp((s) => s.answerPermission);
  // **Which conversation is asking, and whether another is waiting.** With one
  // session this prompt was self-evidently about the only conversation there
  // was; with several, an approval with no origin is a question about an
  // unknown session — and a decision made for the wrong one.
  const origin = useApp((s) => (s.modal ? selectModalOrigin(s, s.modal.key) : ''));
  const queued = useApp(selectQueuedModals);

  const open = modal?.kind === 'permission';
  const req = open ? modal.req : null;

  return (
    <DialogPrimitive.Root open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content
          className="dialog"
          // No `aria-describedby={undefined}`: that is what you pass when there
          // is **no** description and Radix's dev warning has to be silenced. A
          // visible `DialogPrimitive.Description` is rendered below
          // ("The runtime is blocked here until you decide"), so leaving Radix
          // to wire it is the accurate thing — a screen reader then hears the
          // sentence a sighted reader sees.
          //
          // A stray click outside is not a decision; closing can only happen
          // explicitly.
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            answer('deny'); // Deny and close are the same thing.
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
                    background:
                      req.risk === 'high' ? 'var(--destructive-subtle)' : 'var(--warning-subtle)',
                    color: req.risk === 'high' ? 'var(--destructive)' : 'var(--warning)',
                  }}
                >
                  {req.risk === 'high' ? <AlertOctagon size={15} /> : <ShieldCheck size={15} />}
                </span>

                <div className="grow">
                  <DialogPrimitive.Title className="dialog-title">
                    {t('perm.title')}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="dialog-desc">
                    {t('perm.subtitle')}
                  </DialogPrimitive.Description>
                </div>

                <RiskTag level={req.risk} />
              </div>

              <div className="dialog-body scroll">
                {/* Tool / origin / call id — read-only facts, not controls. */}
                <div
                  className="row"
                  style={{ gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}
                >
                  <Fact mono title={t('perm.tool')}>
                    {req.tool}
                  </Fact>
                  <Fact title={t('perm.callId')}>{req.call_id}</Fact>
                  {/* Which conversation is asking. Shown only when it is
                      knowable: a session whose `init` has not landed has no id
                      yet, and an invented label would be worse than none. */}
                  {origin ? (
                    <Fact title={t('modal.from')}>
                      {t('modal.from')} <span className="mono">{origin}</span>
                    </Fact>
                  ) : null}
                  {/* And whether another one is waiting behind this. The queue
                      has always held them; saying so is what keeps the second
                      request from being a surprise after this one is answered. */}
                  {queued > 0 ? (
                    <Badge tone="neutral" dot={false}>
                      {t('modal.queued', { n: queued })}
                    </Badge>
                  ) : null}
                </div>

                {req.risk === 'high' ? (
                  <div
                    className="e-denied"
                    style={{ marginBottom: 'var(--space-3)', borderLeftColor: 'var(--destructive)' }}
                  >
                    <AlertOctagon size={12} />
                    <span className="ed-text">{t('perm.escalate')}</span>
                  </div>
                ) : null}

                {/* The runtime's own sentences, not one character changed. Each
                    is rendered only if it was sent: a null hint is a fact, not
                    an invitation to substitute our own wording. */}
                {req.remember_hint || req.trust_all_hint ? (
                  <>
                    <div className="etb-label">{t('perm.hintLabel')}</div>
                    <div
                      className="col"
                      style={{
                        gap: 'var(--space-2)',
                        padding: 'var(--space-3)',
                        marginTop: 4,
                        marginBottom: 'var(--space-4)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--bg-secondary)',
                      }}
                    >
                      {req.remember_hint ? (
                        <p style={{ color: 'var(--fg-secondary)' }}>{req.remember_hint}</p>
                      ) : null}
                      {req.trust_all_hint ? (
                        <p style={{ color: 'var(--fg-secondary)' }}>{req.trust_all_hint}</p>
                      ) : null}
                    </div>
                  </>
                ) : null}

                {/* Arguments in full: no truncation, no folding, horizontally
                    scrollable. */}
                <div className="etb-label">{t('perm.params')}</div>
                <div className="terminal" style={{ marginTop: 4 }}>
                  {formatArguments(req.arguments)}
                </div>

                {/* What pressing "always" would actually write. The shape is the
                    runtime's; this view only prints it. */}
                {req.remember ? (
                  <div className="caption muted" style={{ marginTop: 'var(--space-2)' }}>
                    <span className="mono">{JSON.stringify(req.remember)}</span>
                  </div>
                ) : null}
              </div>

              <div className="dialog-foot">
                <span className="caption faint">{t('perm.denySameAsClose')}</span>
                <span className="grow" />

                <button type="button" className="btn btn-outline" onClick={() => answer('deny')}>
                  {t('perm.action.deny')}
                  <kbd className="kbd" style={{ marginLeft: 4 }}>
                    Esc
                  </kbd>
                </button>

                {/* Only when the runtime gave something to remember. */}
                {req.remember ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => answer('always')}
                  >
                    {t('perm.action.always')}
                  </button>
                ) : null}

                {/* Only when the runtime set the flag; the hint has already
                    explained that this is a snapshot. */}
                {req.allow_trust_all ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => answer('always_group')}
                  >
                    <AlertTriangle size={11} />
                    {t('perm.action.allowAll')}
                  </button>
                ) : null}

                {/* One primary per screen: this is the turn's single main action. */}
                <button type="button" className="btn btn-primary" onClick={() => answer('allow')}>
                  {t('perm.action.allow')}
                </button>
              </div>
            </>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
