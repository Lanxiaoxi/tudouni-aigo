import { useState } from 'react';
import { Pause, Zap } from 'lucide-react';
import { selectPhase, useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Badge, Info, Tip } from '@/components/ui/kit';
import { PanelBody, PanelShell } from './PanelShell';

/**
 * Settings.
 *
 * **One group only, and it is not a taste group.** Everything here is a *start-up
 * argument*: `--ericai` and `--max-steps`. The runtime reads both while it is
 * being assembled and neither can be changed by a later message —
 * `Options.EricAI` says so in as many words ("a start-up decision rather than a
 * per-turn one"), and `--max-steps` goes into the agent at open. So "apply" means
 * "start another child", which is why every change is confirmed and why the whole
 * group is inert while that would be unsafe.
 *
 * Three rules shape the rest of this file:
 *
 *   1. **It shows what is in force, not what is remembered.** `launch` records the
 *      argv this session's child was actually given, which is a fact this window
 *      has. A remembered default is not, and the two are never merged — a value
 *      kept for next time must not read as "this is on now".
 *   2. **Nothing is applied optimistically.** The toggle moves when the person
 *      chooses, and the "in force" badge moves only when a new child has been
 *      accepted — the same rule the approval modal follows.
 *   3. **A confirmation is inline, not a modal.** The two blocking modals exist for
 *      questions *the runtime* is waiting on; borrowing one here would freeze the
 *      global keys and the sidebar for an ordinary local decision, and
 *      `component-states.md` §danger puts a confirmation in a popover for exactly
 *      that reason.
 */
export function SettingsPanel() {
  const t = useT();

  // What the **session on screen** was started with. Each session has its own
  // argv, so this panel describes that one rather than "the runtime".
  const key = useApp((s) => s.activeKey);
  const launch = useSessionField((rt) => rt.launch, { ericai: false, maxSteps: null });
  const phase = useApp((s) => selectPhase(s, key));
  const modal = useApp((s) => s.modal);
  const applyLaunch = useApp((s) => s.applyLaunch);

  // The draft starts from what is **in force**, so the panel opens showing the
  // truth rather than a remembered value that nothing is using.
  const [ericai, setEricai] = useState(launch.ericai);
  const [maxSteps, setMaxSteps] = useState(launch.maxSteps === null ? '' : String(launch.maxSteps));
  const [confirming, setConfirming] = useState(false);

  const parsed = parseMaxSteps(maxSteps);
  const invalid = !parsed.ok;

  const changed =
    ericai !== launch.ericai || parsed.value !== launch.maxSteps;

  // Why the group is inert, in the order that matters: a blocking prompt outranks
  // everything (it abandons what the runtime is waiting on), then a turn in flight,
  // then a start that has not finished. `booting` counts because `attachRuntime`
  // may already be running: a second attach would put two children in one
  // workspace.
  const blocked: 'modal' | 'turn' | 'booting' | null =
    modal !== null ? 'modal' : phase === 'running' ? 'turn' : !phase || phase === 'booting' ? 'booting' : null;

  const disabled = blocked !== null || invalid;

  function apply() {
    setConfirming(false);
    void applyLaunch({ ericai, maxSteps: parsed.value });
  }

  return (
    <PanelShell title={t('panel.settings.title')} note={t('panel.settings.note')}>
      <PanelBody>
        <div className="etb-label">{t('panel.settings.launch')}</div>
        <p className="set-hint">{t('panel.settings.launchHint')}</p>

        {/* ---- EricAI ---- */}
        <div className="set-row">
          <div className="set-main">
            <div className="set-title">
              <span>{t('panel.settings.ericai')}</span>
              {/* The side effect is stated, not implied — but in the icon, not
                  the row: the row says what the switch does, the `?` says what
                  it is allowed to do to the person's machine. */}
              <Info label={t('panel.settings.ericaiDetail')} side="top" />
              {launch.ericai ? (
                <Badge tone="success" dot={false}>
                  {t('panel.settings.inForce')}
                </Badge>
              ) : null}
            </div>
            <div className="set-desc">{t('panel.settings.ericaiDesc')}</div>
          </div>
          <Tip label={ericai ? t('common.none') : t('panel.settings.apply')}>
            <button
              type="button"
              // **Not `st-toggle`.** That shape is defined as
              // `.statusbar .st-toggle`, so reusing the name here would render an
              // unstyled button — and the class audit would not catch it, because
              // the name *is* defined somewhere. It is the exact failure the audit
              // cannot see, which is why the name is different and has its own rule.
              className={`set-toggle${ericai ? ' is-on' : ''}`}
              aria-pressed={ericai}
              disabled={disabled}
              onClick={() => {
                setEricai(!ericai);
                setConfirming(false);
              }}
            >
              <Zap size={11} />
              <span>{t('panel.settings.ericai')}</span>
            </button>
          </Tip>
        </div>

        {/* ---- step cap ---- */}
        <div className="set-row">
          <div className="set-main">
            <div className="set-title">
              <span>{t('panel.settings.maxSteps')}</span>
              {launch.maxSteps !== null ? (
                <Badge tone="success" dot={false}>
                  {t('panel.settings.inForce')}
                </Badge>
              ) : null}
            </div>
            <div className="set-desc">{t('panel.settings.maxStepsDesc')}</div>
          </div>
          <div className="set-control">
            <input
              type="text"
              inputMode="numeric"
              className={`set-input${invalid ? ' is-invalid' : ''}`}
              value={maxSteps}
              disabled={blocked !== null}
              placeholder={t('panel.settings.maxStepsDefault')}
              aria-label={t('panel.settings.maxSteps')}
              aria-invalid={invalid}
              onChange={(e) => {
                setMaxSteps(e.target.value);
                setConfirming(false);
              }}
            />
            {invalid ? <div className="set-error">{t('panel.settings.maxStepsInvalid')}</div> : null}
          </div>
        </div>

        {/* ---- what is running ---- */}
        <dl className="set-running">
          <dt>{t('panel.settings.running')}</dt>
          <dd className="mono">
            {launch.ericai ? '--ericai' : '—'}
            {launch.maxSteps !== null ? ` --max-steps ${launch.maxSteps}` : ''}
          </dd>
        </dl>

        {/* ---- the confirmation, inline ---- */}
        {confirming ? (
          <div className="set-confirm" role="alertdialog" aria-label={t('panel.settings.restart')}>
            <div className="set-confirm-text">
              <strong>{t('panel.settings.restart')}</strong>
              <div className="caption muted">{t('panel.settings.restartWhy')}</div>
            </div>
            <div className="set-confirm-actions">
              <button type="button" className="btn btn-secondary btn-compact" onClick={() => setConfirming(false)}>
                {t('panel.settings.restartNo')}
              </button>
              <button type="button" className="btn btn-primary btn-compact" onClick={apply}>
                {t('panel.settings.restartYes')}
              </button>
            </div>
          </div>
        ) : (
          <div className="set-actions">
            <button
              type="button"
              className="btn btn-primary btn-compact"
              disabled={disabled || !changed}
              onClick={() => setConfirming(true)}
            >
              {t('panel.settings.apply')}
            </button>
            {blocked !== null ? (
              <span className="set-blocked">
                <Pause size={11} />
                {blocked === 'modal'
                  ? t('panel.settings.blockedModal')
                  : blocked === 'turn'
                    ? t('panel.settings.blockedTurn')
                    : t('panel.settings.blockedBooting')}
              </span>
            ) : null}
          </div>
        )}
      </PanelBody>
    </PanelShell>
  );
}

/**
 * Read the step cap out of the text field.
 *
 * Empty is a real answer — it means "no `--max-steps` on the command line", which
 * is how the runtime's own default applies. A number that is not a positive whole
 * one is refused here rather than sent: the Rust side only forwards `> 0` (see
 * `spawn`), so anything else would be accepted by this screen and quietly dropped
 * by the bridge.
 */
function parseMaxSteps(text: string): { ok: true; value: number | null } | { ok: false; value: null } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false, value: null };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return { ok: false, value: null };
  return { ok: true, value };
}
