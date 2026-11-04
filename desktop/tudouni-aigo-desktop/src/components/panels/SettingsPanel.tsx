import { useState, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Pause } from 'lucide-react';
import { selectModalVisible, selectPhase, useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { CLOSE_POLICIES, type ClosePolicy } from '@/runtime/windowClose';
import {
  clampBaseCps,
  clampMaxCps,
  REVEAL_BASE_CPS,
  REVEAL_MAX_CPS,
} from '@/streamReveal';
import { Info, Tip } from '@/components/ui/kit';
import { PanelShell } from './PanelShell';

/**
 * Settings.
 *
 * **Two kinds of decision, and the split between them is the point.**
 *
 * The first is *start-up arguments*: `--ericai` and `--max-steps`. The runtime
 * reads both while it is being assembled and neither can be changed by a later
 * message — `Options.EricAI` says so in as many words ("a start-up decision
 * rather than a per-turn one"), and `--max-steps` goes into the agent at open. So
 * "apply" there means "start another child", which is why every change waits in
 * a pending card and why that group is inert while restarting would be unsafe.
 *
 * The second is *this window's own behaviour*: session notifications, reply
 * pacing, and what the X button does. None of it reaches the runtime at all —
 * they are front-end preferences in the desktop's user data
 * (`~/.tudouni/desktop.json`), applied the moment they are changed — so they
 * carry no confirmation, no pending card, and no restart. Putting them in the
 * first group would have borrowed its whole apparatus ("Apply and restart" for
 * a checkbox about toasts) and taught people to distrust both.
 *
 * The page draws that split twice: the body says what each setting does, and the
 * rail says what is **in force** and what an apply will change. Three rules shape
 * the rest of this file:
 *
 *   1. **It shows what is in force, not what is remembered.** `launch` records the
 *      argv this session's child was actually given, which is a fact this window
 *      has. A remembered default is not, and the two are never merged — a value
 *      kept for next time must not read as "this is on now". The rail's
 *      RUNNING card is that fact; the PENDING card is the difference.
 *   2. **Nothing is applied optimistically.** The controls move when the person
 *      chooses, and the RUNNING card moves only when a new child has been
 *      accepted — the same rule the approval modal follows.
 *   3. **A confirmation is inline, not a modal.** The PENDING card *is* the
 *      confirmation: it names the argument, shows the old and new values, and
 *      says that applying restarts the child. The two blocking modals exist for
 *      questions *the runtime* is waiting on; borrowing one here would freeze
 *      the global keys and the sidebar for an ordinary local decision.
 *
 * **The foot has one button, and it closes.** Nothing on this page is submitted:
 * the start-up arguments apply through the PENDING card's own Apply, and a
 * window preference is already saved by the time its switch settles. A Save in
 * the footer would be a third way of saying those two things, and a Cancel would
 * be a way of losing them that nothing needs. So the foot carries the sentence
 * that says what the page above it *is* — a record of how the runtime was
 * started — and the one action it has, which is to leave.
 */
export function SettingsPanel() {
  const t = useT();

  // What the **session on screen** was started with. Each session has its own
  // argv, so this panel describes that one rather than "the runtime".
  const key = useApp((s) => s.activeKey);
  const launch = useSessionField((rt) => rt.launch, { ericai: false, maxSteps: null });
  const openedAt = useSessionField((rt) => rt.openedAt, 0);
  const ready = useSessionField((rt) => rt.ready, false);
  const problem = useSessionField<string | null>((rt) => rt.problem, null);
  const exited = useSessionField((rt) => rt.runtimeExit !== null, false);
  const phase = useApp((s) => selectPhase(s, key));
  const promptUp = useApp(selectModalVisible);
  const applyLaunch = useApp((s) => s.applyLaunch);

  // The window's own preferences. Read here rather than through
  // `useSessionField`: they are not about a session, and one of them
  // (`closePolicy`) is not about any process at all.
  const notifyEnabled = useApp((s) => s.notifyEnabled);
  const setNotifyEnabled = useApp((s) => s.setNotifyEnabled);
  const suggestionsEnabled = useApp((s) => s.suggestionsEnabled);
  const setSuggestionsEnabled = useApp((s) => s.setSuggestionsEnabled);
  const streamSmoothing = useApp((s) => s.streamSmoothing);
  const setStreamSmoothing = useApp((s) => s.setStreamSmoothing);
  const streamBaseCps = useApp((s) => s.streamBaseCps);
  const streamMaxCps = useApp((s) => s.streamMaxCps);
  const setStreamPaces = useApp((s) => s.setStreamPaces);

  // The pace rows are **semi-controlled**: a number mid-edit ("5" on the way
  // to "50") must not reach the store, because the setter clamps and "5" would
  // land as the range floor, eating the rest of the value. While a row is
  // focused it shows its own draft; unfocused it shows the store directly, so
  // the value the start-up's `hydrate` applies (the store loads these fields
  // asynchronously, after this panel's first render) is what the rows draw
  // without a draft that has gone stale.
  const [paceDraft, setPaceDraft] = useState<{ field: 'base' | 'max' | null; raw: string }>({ field: null, raw: '' });

  const paceBaseValue =
    paceDraft.field === 'base' ? paceDraft.raw : String(streamBaseCps);
  const paceMaxValue =
    paceDraft.field === 'max' ? paceDraft.raw : String(streamMaxCps);

  /** Commit one row's draft. Empty or non-numeric discards the edit (the
   *  row falls back to the store value on blur); a number is clamped into
   *  the curve's range, and the cap's floor at the base keeps the two ends
   *  from fighting. Both drafts settle on what the store now holds. */
  function commitPace(field: 'base' | 'max') {
    const raw = paceDraft.raw;
    const parsed = raw.trim() === '' ? null : Number(raw);
    if (parsed !== null && Number.isFinite(parsed) && parsed > 0) {
      const base = field === 'base' ? clampBaseCps(parsed) : streamBaseCps;
      const cap = field === 'max' ? clampMaxCps(parsed, base) : streamMaxCps;
      if (base !== streamBaseCps || cap !== streamMaxCps) setStreamPaces(base, cap);
      setPaceDraft({ field: null, raw: '' });
      // The store write lands on the next render; the input's own blur has
      // already happened, so the drawn value follows the store from there.
      return;
    }
    // Discarded: the row falls back to the store value on blur, so an edit
    // that wrote nothing leaves the number unchanged.
    setPaceDraft({ field: null, raw: '' });
  }
  const closePolicy = useApp((s) => s.closePolicy);
  const setClosePolicy = useApp((s) => s.setClosePolicy);
  // The OS's answer, shown beside the switch rather than acted on silently: when
  // it is on, the switch below does nothing, and a control that appears on while
  // nothing changes is the one thing this panel must not do. See rule 1 in the
  // module note — this row reports what is in force, so it says so.
  const reducedMotion = usePrefersReducedMotion();

  // The draft starts from what is **in force**, so the panel opens showing the
  // truth rather than a remembered value that nothing is using.
  const [ericai, setEricai] = useState(launch.ericai);
  const [maxSteps, setMaxSteps] = useState(launch.maxSteps === null ? '' : String(launch.maxSteps));

  const parsed = parseMaxSteps(maxSteps);
  const invalid = !parsed.ok;

  const ericaiChanged = ericai !== launch.ericai;
  // An invalid field is not a pending value: it has not been read yet, and
  // showing "150 → runtime default" for the text "abc" would be a lie about
  // what Apply is about to send (it sends nothing at all).
  const maxStepsChanged = parsed.ok && parsed.value !== launch.maxSteps;
  const changed = ericaiChanged || maxStepsChanged;

  // Why the group is inert, in the order that matters: a **drawn** prompt
  // outranks everything (applying restarts the child the runtime is waiting
  // on), then a turn in flight, then a start that has not finished. `booting`
  // counts because `attachRuntime` may already be running: a second attach would
  // put two children in one workspace.
  //
  // The prompt is tested by visibility: a request held for another session has
  // drawn nothing, and this panel describes the session on screen.
  const blocked: 'modal' | 'turn' | 'booting' | null =
    promptUp ? 'modal' : phase === 'running' ? 'turn' : !phase || phase === 'booting' ? 'booting' : null;

  const blockedText =
    blocked === 'modal'
      ? t('panel.settings.blockedModal')
      : blocked === 'turn'
        ? t('panel.settings.blockedTurn')
        : blocked === 'booting'
          ? t('panel.settings.blockedBooting')
          : null;

  const disabled = blocked !== null || invalid;

  // What the child is doing, from facts this window has. "Running" means the
  // handshake landed and the process has not ended; it is not the turn phase,
  // which the status bar already draws.
  const statusText =
    problem !== null
      ? t('panel.settings.statusFailed')
      : exited
        ? t('panel.settings.statusStopped')
        : ready
          ? t('panel.settings.statusRunning')
          : t('panel.settings.statusStarting');
  const statusTone =
    problem !== null ? 'is-bad' : exited ? 'is-warning' : ready ? 'is-ok' : 'is-muted';

  const startedText = (() => {
    if (!openedAt) return t('panel.settings.startedUnknown');
    const minutes = Math.floor((Date.now() - openedAt) / 60_000);
    if (minutes < 1) return t('panel.settings.startedJustNow');
    if (minutes < 60) return t('panel.settings.startedMinutes', { n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('panel.settings.startedHours', { n: hours });
    return t('panel.settings.startedDays', { n: Math.floor(hours / 24) });
  })();

  const stepText =
    launch.maxSteps === null ? t('panel.settings.maxStepsDefault') : String(launch.maxSteps);
  const argv =
    [launch.ericai ? '--ericai' : '', launch.maxSteps !== null ? `--max-steps ${launch.maxSteps}` : '']
      .filter(Boolean)
      .join(' ') || '—';

  const oldStep =
    launch.maxSteps === null ? t('panel.settings.maxStepsDefault') : String(launch.maxSteps);
  const newStep =
    parsed.value === null ? t('panel.settings.maxStepsDefault') : String(parsed.value);

  function apply() {
    if (disabled) return;
    void applyLaunch({ ericai, maxSteps: parsed.value });
  }

  function discard() {
    setEricai(launch.ericai);
    setMaxSteps(launch.maxSteps === null ? '' : String(launch.maxSteps));
  }

  const smoothingActive = streamSmoothing && !reducedMotion;

  /* One row of a card: the title (and its `?`) over the sentence that explains
     it, the control at the card's right edge. It is a function rather than four
     copies of the same six elements because the row is the sheet's unit and the
     four groups below must not drift apart from each other. */
  const row = (title: ReactNode, hint: ReactNode, control: ReactNode) => (
    <div className="wb-row">
      <div className="wb-row-main">
        <div className="wb-row-title">{title}</div>
        <div className="wb-row-hint">{hint}</div>
      </div>
      <div className="wb-row-control">{control}</div>
    </div>
  );

  const pendingChip = <span className="sp-pending">{t('panel.settings.pending')}</span>;

  return (
    <PanelShell
      title={t('panel.settings.title')}
      note={t('panel.settings.note')}
      // The read-out's own rule, in the foot: the page above it is a record of
      // the argv the child was given, and the foot is where a panel says what
      // it is rather than offering to submit it.
      footHint={t('panel.settings.runningHint')}
      footer={
        <DialogPrimitive.Close asChild>
          <button type="button" className="btn btn-outline">
            {t('panel.close')}
          </button>
        </DialogPrimitive.Close>
      }
      rail={
        <>
          <div className="wb-card-above">
            <div className="wb-label">{t('panel.settings.running')}</div>
            <div className="wb-card sp-rail-card">
              <div className="wb-kv">
                <div className="wb-kv-row">
                  <span className="wb-kv-label">{t('panel.settings.status')}</span>
                  <span className={`wb-value ${statusTone}`}>{statusText}</span>
                </div>
                <div className="wb-kv-row">
                  <span className="wb-kv-label">{t('panel.settings.started')}</span>
                  <span className="wb-value">{startedText}</span>
                </div>
                <div className="wb-kv-row">
                  <span className="wb-kv-label">{t('panel.settings.maxSteps')}</span>
                  {/* The runtime's own default is a sentence, not a number, so
                      it keeps the mono rung but takes the muted tone — the two
                      circumstances must not look like the same fact. */}
                  <span className={`wb-value${launch.maxSteps === null ? ' is-muted' : ''}`}>
                    {stepText}
                  </span>
                </div>
              </div>
              {/* The argv itself, in the sunken rung the design gives a path or a
                  command: the facts above say what it comes to, this says what
                  was actually typed. */}
              <div className="sp-argv" title={argv}>
                {argv}
              </div>
            </div>
          </div>

          {changed ? (
            <div className="wb-card-above">
              <div className="wb-label">{t('panel.settings.pending')}</div>
              <div className="wb-card sp-pending-card">
                {ericaiChanged ? (
                  <div className="sp-diff">
                    <div className="sp-diff-arg">--ericai</div>
                    <div className="sp-diff-values">
                      <span className="sp-diff-old">
                        {launch.ericai ? t('panel.settings.on') : t('panel.settings.off')}
                      </span>
                      <span className="sp-diff-arrow" aria-hidden="true">
                        →
                      </span>
                      <span className="sp-diff-new">
                        {ericai ? t('panel.settings.on') : t('panel.settings.off')}
                      </span>
                    </div>
                  </div>
                ) : null}
                {maxStepsChanged ? (
                  <div className="sp-diff">
                    <div className="sp-diff-arg">--max-steps</div>
                    <div className="sp-diff-values">
                      <span className="sp-diff-old">{oldStep}</span>
                      <span className="sp-diff-arrow" aria-hidden="true">
                        →
                      </span>
                      <span className="sp-diff-new">{newStep}</span>
                    </div>
                  </div>
                ) : null}
                <div className="sp-pending-actions">
                  <button
                    type="button"
                    className="btn btn-primary sp-apply"
                    disabled={disabled}
                    onClick={apply}
                  >
                    {t('panel.settings.apply')}
                  </button>
                  <button type="button" className="btn btn-ghost sp-discard" onClick={discard}>
                    {t('panel.settings.discard')}
                  </button>
                  {blocked !== null ? (
                    <div className="sp-blocked">
                      <Pause size={11} />
                      <span>{blockedText}</span>
                    </div>
                  ) : null}
                </div>
              </div>
              <p className="cfg-hint">{t('panel.settings.pendingHint')}</p>
            </div>
          ) : null}

          <div className="wb-card-above">
            <div className="wb-label">{t('panel.settings.appliesWhen')}</div>
            <div className="wb-card sp-rail-card">
              <div className="wb-kv-row">
                <span className="wb-kv-label">{t('panel.settings.startupArgs')}</span>
                <span className="wb-value is-warning">{t('panel.settings.restart')}</span>
              </div>
              <div className="wb-kv-row">
                <span className="wb-kv-label">{t('panel.settings.windowPrefs')}</span>
                <span className="wb-value is-ok">{t('panel.settings.instantly')}</span>
              </div>
            </div>
          </div>
        </>
      }
    >
      {/* ============================================================
          Runtime
          ============================================================
          The start-up group. Its two values are the ones the PENDING card can
          carry, and its label row is the sentence that explains why changing
          either one starts another child. */}
      <section className="wb-section">
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.settings.launch')}</span>
          <span className="wb-rule" />
        </div>
        <p className="cfg-hint">{t('panel.settings.launchHint')}</p>

        <div className="wb-card wb-card-flush">
          {row(
            <>
              <span>{t('panel.settings.ericai')}</span>
              {/* The side effect is stated, not implied — but in the icon, not
                  the row: the row says what the switch does, the `?` says what
                  it is allowed to do to the person's machine. */}
              <Info label={t('panel.settings.ericaiDetail')} side="top" />
              {ericaiChanged ? pendingChip : null}
            </>,
            t('panel.settings.ericaiDesc'),
            <button
              type="button"
              role="switch"
              aria-checked={ericai}
              aria-label={t('panel.settings.ericai')}
              className={`tk-switch${ericai ? ' is-on' : ''}`}
              disabled={blocked !== null}
              onClick={() => setEricai(!ericai)}
            >
              <span className="tk-switch-knob" />
            </button>,
          )}

          {/* The step cap's control is a column: the field is one boxed number
              with its unit outside it, and the value in force is a line under
              the box rather than beside it — it is a fact about the running
              child, not the draft in the field. */}
          <div className="wb-row">
            <div className="wb-row-main">
              <div className="wb-row-title">
                <span>{t('panel.settings.maxSteps')}</span>
                {maxStepsChanged ? pendingChip : null}
              </div>
              <div className="wb-row-hint">{t('panel.settings.maxStepsDesc')}</div>
            </div>
            <div className="sp-step">
              <div className="sp-step-line">
                <input
                  type="text"
                  inputMode="numeric"
                  className={`cfg-input sp-number${invalid ? ' is-invalid' : ''}`}
                  value={maxSteps}
                  disabled={blocked !== null}
                  placeholder={t('panel.settings.maxStepsDefault')}
                  aria-label={t('panel.settings.maxSteps')}
                  aria-invalid={invalid}
                  onChange={(e) => setMaxSteps(e.target.value)}
                />
                <span className="sp-unit">{t('panel.settings.calls')}</span>
              </div>
              {invalid ? (
                <div className="set-error">{t('panel.settings.maxStepsInvalid')}</div>
              ) : (
                <div className="sp-running-inline">
                  {t('panel.settings.runningValue', { value: stepText })}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ============================================================
          This window
          ============================================================
          A separate group because it is a separate kind of decision. Nothing
          here reaches the runtime, nothing here needs a restart, and so none of
          it borrows the PENDING card above. */}
      <section className="wb-section">
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.settings.window')}</span>
          <span className="wb-rule" />
        </div>
        <p className="cfg-hint">{t('panel.settings.windowHint')}</p>

        <div className="wb-card wb-card-flush">
          {row(
            t('panel.settings.notify'),
            t('panel.settings.notifyDesc'),
            <button
              type="button"
              role="switch"
              aria-checked={notifyEnabled}
              aria-label={t('panel.settings.notify')}
              className={`tk-switch${notifyEnabled ? ' is-on' : ''}`}
              onClick={() => setNotifyEnabled(!notifyEnabled)}
            >
              <span className="tk-switch-knob" />
            </button>,
          )}
          {row(
            t('panel.settings.suggestions'),
            t('panel.settings.suggestionsDesc'),
            <button
              type="button"
              role="switch"
              aria-checked={suggestionsEnabled}
              aria-label={t('panel.settings.suggestions')}
              className={`tk-switch${suggestionsEnabled ? ' is-on' : ''}`}
              onClick={() => setSuggestionsEnabled(!suggestionsEnabled)}
            >
              <span className="tk-switch-knob" />
            </button>,
          )}
        </div>
      </section>

      {/* ============================================================
          Reply pacing
          ============================================================
          A group of its own now that it is three rows: the switch and the two
          ends of the curve it tunes. The paces are inert with the switch (a pace
          on a reply drawn immediately is a number describing nothing), and
          effective from the **next** reply, which the descriptions say. */}
      <section className="wb-section">
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.settings.pacing')}</span>
          <span className="wb-rule" />
        </div>

        <div className="wb-card wb-card-flush">
          {row(
            t('panel.settings.smoothing'),
            <>
              {t('panel.settings.smoothingDesc')}
              {reducedMotion ? (
                <div className="sp-note">{t('panel.settings.smoothingReduced')}</div>
              ) : null}
            </>,
            <button
              type="button"
              role="switch"
              aria-checked={smoothingActive}
              aria-label={t('panel.settings.smoothing')}
              className={`tk-switch${smoothingActive ? ' is-on' : ''}`}
              disabled={reducedMotion}
              onClick={() => setStreamSmoothing(!streamSmoothing)}
            >
              <span className="tk-switch-knob" />
            </button>,
          )}

          {row(
            t('panel.settings.paceBase'),
            t('panel.settings.paceBaseDesc'),
            <div className="sp-step-line">
              <input
                type="text"
                inputMode="numeric"
                className="cfg-input sp-number"
                value={paceBaseValue}
                disabled={!smoothingActive}
                placeholder={String(REVEAL_BASE_CPS)}
                aria-label={t('panel.settings.paceBase')}
                onFocus={() => setPaceDraft({ field: 'base', raw: String(streamBaseCps) })}
                onChange={(e) => setPaceDraft({ field: 'base', raw: e.target.value })}
                onBlur={() => commitPace('base')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitPace('base');
                }}
              />
              <span className="sp-unit">{t('panel.settings.charsPerSecond')}</span>
            </div>,
          )}

          {row(
            t('panel.settings.paceMax'),
            t('panel.settings.paceMaxDesc'),
            <div className="sp-step-line">
              <input
                type="text"
                inputMode="numeric"
                className="cfg-input sp-number"
                value={paceMaxValue}
                disabled={!smoothingActive}
                placeholder={String(REVEAL_MAX_CPS)}
                aria-label={t('panel.settings.paceMax')}
                onFocus={() => setPaceDraft({ field: 'max', raw: String(streamMaxCps) })}
                onChange={(e) => setPaceDraft({ field: 'max', raw: e.target.value })}
                onBlur={() => commitPace('max')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitPace('max');
                }}
              />
              <span className="sp-unit">{t('panel.settings.charsPerSecond')}</span>
            </div>,
          )}
        </div>
      </section>

      {/* ============================================================
          Closing
          ============================================================
          The design's visible page ends with the pacing rows; this row is kept
          below them rather than folded into "This window", so the top of the
          page reads as the design does. It is still a window preference: saved
          for the whole application, applied at once. */}
      <section className="wb-section">
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.settings.closing')}</span>
          <span className="wb-rule" />
        </div>

        <div className="wb-card wb-card-flush">
          <div className="wb-row">
            <div className="wb-row-main">
              <div className="wb-row-title">
                <span>{t('panel.settings.close')}</span>
              </div>
              <div className="wb-row-hint">{t('panel.settings.closeDesc')}</div>
            </div>
            <div className="wb-row-control">
              <div className="set-choice" role="radiogroup" aria-label={t('panel.settings.close')}>
                {CLOSE_POLICIES.map((policy) => (
                  <Tip key={policy} label={t(CLOSE_POLICY_SUMMARY[policy])} side="top">
                    <label
                      className="set-choice-item"
                      role="radio"
                      aria-checked={closePolicy === policy}
                      data-state={closePolicy === policy ? 'checked' : 'unchecked'}
                    >
                      <input
                        type="radio"
                        name="close-policy"
                        checked={closePolicy === policy}
                        onChange={() => setClosePolicy(policy)}
                      />
                      <span className="set-choice-text">{t(CLOSE_POLICY_LABEL[policy])}</span>
                    </label>
                  </Tip>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
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
