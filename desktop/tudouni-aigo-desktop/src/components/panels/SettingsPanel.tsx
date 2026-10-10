import { useState } from 'react';
import { Bell, Pause, Zap } from 'lucide-react';
import { selectPhase, useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { CLOSE_POLICIES, type ClosePolicy } from '@/runtime/windowClose';
import { Badge, Info, Tip } from '@/components/ui/kit';
import { PanelBody, PanelShell } from './PanelShell';

/**
 * Settings.
 *
 * **Two groups, and the split between them is the point.**
 *
 * The first is *start-up arguments*: `--ericai` and `--max-steps`. The runtime
 * reads both while it is being assembled and neither can be changed by a later
 * message — `Options.EricAI` says so in as many words ("a start-up decision
 * rather than a per-turn one"), and `--max-steps` goes into the agent at open. So
 * "apply" there means "start another child", which is why every change is
 * confirmed and why that group is inert while restarting would be unsafe.
 *
 * The second is *this window's own behaviour*: session notifications, and what
 * the X button does. Neither reaches the runtime at all — they are front-end
 * preferences in `aigo.prefs`, applied the moment they are changed — so they
 * carry no confirmation, no "in force" badge and no restart. Putting them in the
 * first group would have borrowed its whole apparatus ("Restart the runtime?" for
 * a checkbox about toasts) and taught people to distrust both.
 *
 * Three rules shape the rest of this file:
 *
 *   1. **It shows what is in force, not what is remembered.** `launch` records the
 *      argv this session's child was actually given, which is a fact this window
 *      has. A remembered default is not, and the two are never merged — a value
 *      kept for next time must not read as "this is on now". The second group is
 *      the exception that proves it: those *are* remembered values and they are
 *      drawn as such, with no claim about any process.
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

  // The window's own preferences. Read here rather than through
  // `useSessionField`: they are not about a session, and one of them
  // (`closePolicy`) is not about any process at all.
  const notifyEnabled = useApp((s) => s.notifyEnabled);
  const setNotifyEnabled = useApp((s) => s.setNotifyEnabled);
  const closePolicy = useApp((s) => s.closePolicy);
  const setClosePolicy = useApp((s) => s.setClosePolicy);

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

        {/* ============================================================
            This window's own behaviour
            ============================================================

            A separate group because it is a separate kind of decision. Nothing
            here reaches the runtime, nothing here needs a restart, and so none
            of it borrows the confirmation above. Mixing the two would mean the
            panel said "Restart the runtime?" for a checkbox about toasts —
            which teaches people to stop reading the question. */}
        <div className="etb-label" style={{ marginTop: 'var(--space-5)' }}>
          {t('panel.settings.window')}
        </div>
        <p className="set-hint">{t('panel.settings.windowHint')}</p>

        {/* ---- sessions finished, failed, or waiting ---- */}
        <div className="set-row">
          <div className="set-main">
            <div className="set-title">
              <span>{t('panel.settings.notify')}</span>
            </div>
            <div className="set-desc">{t('panel.settings.notifyDesc')}</div>
          </div>
          <Tip label={notifyEnabled ? t('common.none') : t('panel.settings.notify')}>
            <button
              type="button"
              className={`set-toggle${notifyEnabled ? ' is-on' : ''}`}
              aria-pressed={notifyEnabled}
              onClick={() => setNotifyEnabled(!notifyEnabled)}
            >
              <Bell size={11} />
              <span>{t('panel.settings.notify')}</span>
            </button>
          </Tip>
        </div>

        {/* ---- what the X button does ---- */}
        <div className="set-row">
          <div className="set-main">
            <div className="set-title">
              <span>{t('panel.settings.close')}</span>
            </div>
            <div className="set-desc">{t('panel.settings.closeDesc')}</div>

            {/* Three options, in a vertical list because each carries a sentence
                and three sentences do not fit on one line. A radio group in
                plain DOM rather than Radix: the only Radix radio in this codebase
                is the question modal's, and that one is genuinely a question the
                runtime is blocked on. */}
            <div className="set-choice" role="radiogroup" aria-label={t('panel.settings.close')}>
              {CLOSE_POLICIES.map((policy) => (
                <label
                  key={policy}
                  className="set-choice-item"
                  data-state={closePolicy === policy ? 'checked' : 'unchecked'}
                >
                  <input
                    type="radio"
                    name="close-policy"
                    checked={closePolicy === policy}
                    onChange={() => setClosePolicy(policy)}
                  />
                  <span className="set-choice-text">
                    <span className="strong">{t(CLOSE_POLICY_LABEL[policy])}</span>
                    <span className="caption muted">{t(CLOSE_POLICY_SUMMARY[policy])}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </PanelBody>
    </PanelShell>
  );
}

/**
 * The three values, and their two sentences each.
 *
 * Two tables rather than one lookup of two keys, because `t` takes one key at a
 * time and a `Lookup`-style indirection here would be a third way of spelling
 * "which sentence goes with which value" — the thing that already went wrong in
 * the settings panel's predecessor, where a remembered value was drawn as "in
 * force". Both tables are `TKey`-typed, so a renamed key is a compile error
 * rather than an empty sentence.
 */
const CLOSE_POLICY_LABEL: Record<ClosePolicy, TKey> = {
  ask: 'close.policy.ask',
  minimize: 'close.policy.minimize',
  close: 'close.policy.close',
};

const CLOSE_POLICY_SUMMARY: Record<ClosePolicy, TKey> = {
  ask: 'close.policy.summaryAsk',
  minimize: 'close.policy.summaryMinimize',
  close: 'close.policy.summaryClose',
};

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
