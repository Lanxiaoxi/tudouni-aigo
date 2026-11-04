import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, Plus, Trash2, Webhook } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { TKey } from '@/i18n';
import { useT } from '@/i18n/useT';
import type {
  HookActivity,
  HookEventInfo,
  HookRunClass,
  HookScript,
  HookState,
  HooksSnapshot,
  WorkspaceHookRow,
} from '@/protocol/types';
import { remoteConnectionOf, useApp, useSessionField } from '@/state/store';
import {
  HOOKS_MIN_PROTOCOL,
  blankRow,
  canMove,
  firstWord,
  isDirty,
  moveRow,
  parseWhole,
  problemsOf,
  rowEdited,
  sameCommand,
  savedFacts,
  seedDraft,
  shouldReseed,
  toDocument,
  withPatch,
  type Draft,
  type DraftProblem,
  type DraftRow,
} from '@/state/hooksDraft';
import { Badge, EmptyState, PanelInfo, Tip, type BadgeTone } from '@/components/ui/kit';
import { Select } from '@/components/ui/Select';
import { formatDuration, formatRelative } from '@/utils/format';
import { PanelBody, PanelShell } from './PanelShell';

/**
 * Hooks: the scripts this machine runs at fixed points in a turn, edited as a form.
 *
 * **One card per hook, folded to one line.** The list is scanned for three things — which
 * hooks exist, which of them are actually running, and whether the last run went well —
 * and all three are on the folded line. The form is one press away, because a hook is
 * edited rarely and read often.
 *
 * **Three facts about three different times, kept apart on the card.** The badge in the
 * head is how the *file* relates to the *running session* (hooks are read once when a
 * session opens, so a saved edit is not running yet and the panel never says it is). The
 * run line is what the script *did* in this session, in the runtime's own words — success,
 * refused, failed, crashed — and it is shown only beside the command that produced it. The
 * form is what the person is *typing now*.
 *
 * **The runtime is the validator.** Save writes the whole form; the runtime runs the same
 * check start-up runs over the bytes it would write and refuses what start-up would
 * refuse. The panel checks only what makes a row meaningless on its face, so a Save that
 * cannot possibly be accepted is not offered. A refusal arrives as `problem` beside the
 * snapshot and **does not clear the form**: the typing is the only copy of what the person
 * was doing.
 *
 * **Nothing is patched here.** Every answer is a fresh snapshot and the panel redraws from
 * it. The form is the one exception, and it is not state — it is unsaved typing, seeded
 * from the snapshot (see `shouldReseed` for when a new snapshot replaces it).
 */
export function HooksPanel() {
  const t = useT();
  const hasSession = useApp((s) => s.activeKey !== null);
  const protocol = useSessionField((rt) => rt.session?.protocol ?? 0, 0);
  const snapshot = useSessionField((rt) => rt.hooks, null);
  const problem = useSessionField((rt) => rt.hooksProblem, null);
  const saveHooks = useApp((s) => s.saveHooks);
  // Whose file this is: the runtime edits **its own** machine's `~/.tudouni/hooks.json`,
  // which for a remote workspace is the host's, not this computer's.
  const remote = useApp(useShallow((s) => remoteConnectionOf(s, s.activeKey)));

  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<string[]>([]);
  const [armed, setArmed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [added, setAdded] = useState<string | null>(null);

  // Refs, not state, for what the snapshot effect reads: it must see the values from the
  // render that carried the snapshot, and must not re-run when they change on their own.
  // (`saveHooks` clears the old refusal before the answer arrives, so keying the effect on
  // `problem` would mistake that clearing for an answer.)
  const problemRef = useRef(problem);
  problemRef.current = problem;
  const savingRef = useRef(false);
  const seededRef = useRef<string | null>(null);

  useEffect(() => {
    if (snapshot === null) return;
    if (savingRef.current) {
      savingRef.current = false;
      setSaving(false);
      setSaved(problemRef.current === null);
    }
    if (shouldReseed(seededRef.current, snapshot, problemRef.current)) {
      setDraft(seedDraft(snapshot));
      seededRef.current = snapshot.file.revision;
      setArmed(null);
    }
  }, [snapshot]);

  // A new card is opened and scrolled to: it is added at the foot of the list, which may
  // be below the fold.
  useEffect(() => {
    if (added === null) return;
    document.getElementById(`hk-${added}`)?.scrollIntoView({ block: 'nearest' });
  }, [added]);

  const dirty = useMemo(
    () => draft !== null && snapshot !== null && isDirty(draft, snapshot),
    [draft, snapshot],
  );

  if (!hasSession) {
    return (
      <PanelShell title={t('panel.hooks.title')} note={t('panel.hooks.note')}>
        <PanelBody>
          <EmptyState title={t('panel.hooks.noSession')} />
        </PanelBody>
      </PanelShell>
    );
  }
  if (protocol < HOOKS_MIN_PROTOCOL) {
    return (
      <PanelShell title={t('panel.hooks.title')} note={t('panel.hooks.note')}>
        <PanelBody>
          <EmptyState title={t('panel.hooks.needsRuntime')} />
        </PanelBody>
      </PanelShell>
    );
  }
  if (snapshot === null || draft === null) {
    return (
      <PanelShell title={t('panel.hooks.title')} note={t('panel.hooks.note')}>
        <PanelBody>
          {problem !== null ? (
            <div className="cfg-problems" role="alert">
              <div className="cfg-problem is-blocking">
                {t('panel.hooks.problem')}: {problem}
              </div>
            </div>
          ) : (
            <EmptyState title={t('panel.hooks.loading')} />
          )}
        </PanelBody>
      </PanelShell>
    );
  }

  const fileBroken = snapshot.file.problem !== '';
  const problems = problemsOf(draft, snapshot.limits.max_per_event);
  const atCap = false;
  const canSave = !fileBroken && dirty && problems.length === 0 && !saving;
  const events = snapshot.events;

  function edit(change: (current: Draft) => Draft) {
    setDraft((current) => (current === null ? current : change(current)));
    setSaved(false);
    setArmed(null);
  }

  function patchRow(uid: string, patch: Partial<DraftRow>) {
    edit((current) => ({
      ...current,
      rows: current.rows.map((row) => (row.uid === uid ? withPatch(row, patch, events) : row)),
    }));
  }

  function addHook() {
    if (draft === null) return;
    const row = blankRow(draft);
    setDraft({ ...draft, rows: [...draft.rows, row] });
    setOpen((current) => [...current, row.uid]);
    setAdded(row.uid);
    setSaved(false);
    setArmed(null);
  }

  function removeRow(uid: string) {
    edit((current) => ({ ...current, rows: current.rows.filter((row) => row.uid !== uid) }));
  }

  function toggle(uid: string) {
    setOpen((current) => (current.includes(uid) ? current.filter((id) => id !== uid) : [...current, uid]));
  }

  function save() {
    if (draft === null || snapshot === null) return;
    savingRef.current = true;
    setSaving(true);
    setSaved(false);
    saveHooks(snapshot.file.revision, toDocument(draft));
  }

  const footer = (
    <>
      <span className="cfg-status">
        {problem !== null ? (
          <span className="cfg-status-error" role="alert">
            {problem}
          </span>
        ) : saved ? (
          <span className="cfg-status-ok">
            <Check size={12} /> {t('panel.hooks.saved')}
          </span>
        ) : fileBroken ? (
          <span className="cfg-status-error">{t('panel.config.readOnly')}</span>
        ) : problems.length > 0 ? (
          <span className="cfg-status-error">{t('panel.config.blocked', { n: problems.length })}</span>
        ) : dirty ? (
          <span className="cfg-status-pending">{t('panel.config.unsaved')}</span>
        ) : null}
      </span>
      <span className="grow" />
      <button
        type="button"
        className="btn btn-ghost btn-compact"
        disabled={!dirty || saving}
        onClick={() => {
          setDraft(seedDraft(snapshot));
          setSaved(false);
          setArmed(null);
        }}
      >
        {t('panel.config.revert')}
      </button>
      <button type="button" className="btn btn-primary btn-compact" disabled={!canSave} onClick={save}>
        {saving ? t('panel.config.saving') : t('panel.config.save')}
      </button>
    </>
  );

  return (
    <PanelShell
      title={t('panel.hooks.title')}
      info={<PanelInfo label={t('panel.hooks.about')} />}
      note={t('panel.hooks.note')}
      count={draft.rows.length}
      actions={
        <button type="button" className="btn btn-primary" disabled={fileBroken || atCap} onClick={addHook}>
          <Plus size={13} />
          {t('panel.hooks.add')}
        </button>
      }
      footer={footer}
    >
      <PanelBody>
        {/* **The refusal banner** is drawn from `hooksProblem`, not from a notice, because
          * the panel is a modal layer: a notice explaining a failed save is printed behind
          * this dialog. The runtime's own sentence is shown unaltered — it is the authority
          * on why. */}
        {problem !== null || fileBroken || problems.length > 0 || snapshot.disabled ? (
          <div className="cfg-problems" role="alert">
            {problem !== null ? (
              <div className="cfg-problem is-blocking">
                {t('panel.hooks.problem')}: {problem}
              </div>
            ) : null}
            {fileBroken ? (
              <div className="cfg-problem is-blocking">
                {t('panel.hooks.fileBroken', { path: snapshot.path, problem: snapshot.file.problem })}
              </div>
            ) : null}
            {problems.map((item, index) => (
              <div key={`p-${index}`} className="cfg-problem is-blocking">
                {draftProblemText(t, item, snapshot.limits.max_per_event)}
              </div>
            ))}
            {snapshot.disabled ? (
              <div className="cfg-problem">{t('panel.hooks.disabledBanner')}</div>
            ) : null}
          </div>
        ) : null}

        <div className="cfg-path-row">
          {remote !== null ? (
            <Badge tone="neutral">
              {remote.user}@{remote.host}
            </Badge>
          ) : null}
          <span className="cfg-path mono" title={snapshot.path}>
            {snapshot.path}
          </span>
        </div>

        {snapshot.defaults.timeout_ms !== null || snapshot.defaults.max_output_bytes !== null ? (
          <p className="set-hint">
            {t('panel.hooks.defaults', {
              timeout: snapshot.defaults.timeout_ms ?? snapshot.limits.default_timeout,
              output: snapshot.defaults.max_output_bytes ?? snapshot.limits.default_output,
            })}
          </p>
        ) : null}

        {draft.rows.length === 0 ? (
          <div className="tk-blank">
            <span className="tk-blank-icon">
              <Webhook size={20} />
            </span>
            <div className="tk-blank-title">{t('panel.hooks.empty')}</div>
            <div className="tk-blank-hint">{t('panel.hooks.emptyHint')}</div>
          </div>
        ) : (
          <div className="hk-list">
            {draft.rows.map((row, index) => (
              <HookCard
                key={row.uid}
                row={row}
                index={index}
                snapshot={snapshot}
                draft={draft}
                isOpen={open.includes(row.uid)}
                isArmed={armed === row.uid}
                onToggle={() => toggle(row.uid)}
                onPatch={(patch) => patchRow(row.uid, patch)}
                onMove={(direction) => edit((current) => moveRow(current, index, direction))}
                onArm={() => setArmed(row.uid)}
                onDisarm={() => setArmed((current) => (current === row.uid ? null : current))}
                onRemove={() => removeRow(row.uid)}
              />
            ))}
          </div>
        )}

        <p className="set-hint cfg-takes-effect">{t('panel.hooks.effect')}</p>

        {snapshot.workspace.exists ? (
          <WorkspaceHooks workspace={snapshot.workspace} sessionDisabled={snapshot.disabled} />
        ) : null}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   One hook.
   ============================================================ */

const STATE_VIEW: Record<HookState, { label: TKey; hint: TKey; tone: BadgeTone }> = {
  active: { label: 'panel.hooks.state.active', hint: 'panel.hooks.stateHint.active', tone: 'success' },
  pending: { label: 'panel.hooks.state.pending', hint: 'panel.hooks.stateHint.pending', tone: 'info' },
  off: { label: 'panel.hooks.state.off', hint: 'panel.hooks.stateHint.off', tone: 'neutral' },
  bypassed: { label: 'panel.hooks.state.bypassed', hint: 'panel.hooks.stateHint.bypassed', tone: 'warning' },
};

const RUN_VIEW: Record<HookRunClass, { label: TKey; tone: BadgeTone }> = {
  success: { label: 'panel.hooks.run.success', tone: 'success' },
  refused: { label: 'panel.hooks.run.refused', tone: 'info' },
  failed: { label: 'panel.hooks.run.failed', tone: 'destructive' },
  crashed: { label: 'panel.hooks.run.crashed', tone: 'destructive' },
  cancelled: { label: 'panel.hooks.run.cancelled', tone: 'neutral' },
};

const EVENT_HINT: Record<string, TKey> = {
  session_start: 'panel.hooks.event.session_start',
  user_prompt_submit: 'panel.hooks.event.user_prompt_submit',
  pre_tool_use: 'panel.hooks.event.pre_tool_use',
  post_tool_use: 'panel.hooks.event.post_tool_use',
  permission_request: 'panel.hooks.event.permission_request',
  stop: 'panel.hooks.event.stop',
  session_end: 'panel.hooks.event.session_end',
  subagent_start: 'panel.hooks.event.subagent_start',
  subagent_stop: 'panel.hooks.event.subagent_stop',
  pre_compact: 'panel.hooks.event.pre_compact',
};

function HookCard({
  row,
  index,
  snapshot,
  draft,
  isOpen,
  isArmed,
  onToggle,
  onPatch,
  onMove,
  onArm,
  onDisarm,
  onRemove,
}: {
  row: DraftRow;
  index: number;
  snapshot: HooksSnapshot;
  draft: Draft;
  isOpen: boolean;
  isArmed: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<DraftRow>) => void;
  onMove: (direction: -1 | 1) => void;
  onArm: () => void;
  onDisarm: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const info: HookEventInfo | undefined = snapshot.events.find((event) => event.name === row.event);
  const facts = savedFacts(row);
  const edited = rowEdited(row);
  // A result belongs to the command that produced it. Once the command on screen differs
  // from the saved one, the result describes a script that is no longer what is typed.
  const sameAsSaved = sameCommand(row);
  const activity = facts !== null && sameAsSaved ? facts.activity : null;
  const program = firstWord(row.command);
  const programMissing = facts !== null && sameAsSaved && !row.shell && facts.executable_found === false;
  const id = (field: string) => `hk-${row.uid}-${field}`;

  // The badge says one thing: how this row relates to what is running. A row that has
  // never been saved, or has been changed since, has no relation to the session yet.
  const badge =
    facts === null
      ? { label: 'panel.hooks.state.unsaved' as TKey, hint: 'panel.hooks.stateHint.unsaved' as TKey, tone: 'warning' as BadgeTone }
      : edited
        ? { label: 'panel.hooks.state.edited' as TKey, hint: 'panel.hooks.stateHint.edited' as TKey, tone: 'warning' as BadgeTone }
        : STATE_VIEW[facts.state];

  return (
    <section id={`hk-${row.uid}`} className={`hk-card${isOpen ? ' is-open' : ''}${row.enabled ? '' : ' is-off'}`}>
      <div className="hk-head">
        <button type="button" className="hk-fold" aria-expanded={isOpen} onClick={onToggle}>
          <ChevronDown size={14} className={`hk-caret${isOpen ? ' is-open' : ''}`} aria-hidden />
          <span className="hk-text">
            <span className="hk-title">
              <span className="hk-name">{row.name.trim() === '' ? t('panel.config.untitled') : row.name}</span>
              <span className="hk-event">{row.event}</span>
            </span>
            <span className="hk-summary" title={row.command}>
              {row.command.trim() === '' ? t('panel.hooks.noCommand') : row.command}
            </span>
          </span>
        </button>
        <span className="hk-badges">
          <span title={t(badge.hint)}>
            <Badge tone={badge.tone}>{t(badge.label)}</Badge>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={row.enabled}
            aria-label={t('panel.hooks.f.enabled', { name: row.name.trim() === '' ? `#${index + 1}` : row.name })}
            className={`tk-switch${row.enabled ? ' is-on' : ''}`}
            onClick={() => onPatch({ enabled: !row.enabled })}
          >
            <span className="tk-switch-knob" />
          </button>
        </span>
      </div>

      {activity !== null && activity.last !== null ? <RunLine activity={activity} /> : null}

      {isOpen ? (
        <div className="hk-body">
          {activity !== null && activity.last === null ? (
            <p className="hk-run-note">{t('panel.hooks.run.none')}</p>
          ) : null}

          <Field id={id('event')} label={t('panel.hooks.f.event')} hint={EVENT_HINT[row.event] ? t(EVENT_HINT[row.event] as TKey) : undefined}>
            <Select
              id={id('event')}
              size="short"
              mono
              value={row.event}
              options={snapshot.events.map((event) => ({ value: event.name, label: event.name }))}
              onChange={(event) => onPatch({ event })}
            />
          </Field>

          <Field id={id('name')} label={t('panel.hooks.f.name')} hint={t('panel.hooks.f.nameHint')}>
            <input
              id={id('name')}
              type="text"
              className="cfg-input mono is-short"
              value={row.name}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => onPatch({ name: e.target.value })}
            />
          </Field>

          {info?.tool_event ? (
            <Field id={id('matcher')} label={t('panel.hooks.f.matcher')} hint={t('panel.hooks.f.matcherHint')}>
              <input
                id={id('matcher')}
                type="text"
                className="cfg-input mono"
                value={row.matcher}
                placeholder={t('panel.hooks.f.matcherAny')}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => onPatch({ matcher: e.target.value })}
              />
            </Field>
          ) : null}

          <Field id={id('command')} label={t('panel.hooks.f.command')} hint={t('panel.hooks.f.commandHint')}>
            <input
              id={id('command')}
              type="text"
              className="cfg-input mono"
              value={row.command}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => onPatch({ command: e.target.value })}
            />
            {snapshot.scripts.length > 0 ? (
              <ScriptPicker
                scripts={snapshot.scripts}
                dir={snapshot.scripts_dir}
                onPick={(script) => onPatch({ command: script.command, shell: false })}
              />
            ) : null}
            <label className="cfg-check">
              <input type="checkbox" checked={row.shell} onChange={(e) => onPatch({ shell: e.target.checked })} />
              {t('panel.hooks.f.shell')}
            </label>
            <span className="cfg-hint">{t('panel.hooks.f.shellHint')}</span>
            {programMissing ? <p className="hk-warn">{t('panel.hooks.notFound', { program })}</p> : null}
          </Field>

          <Field
            id={id('timeout')}
            label={t('panel.hooks.f.timeout')}
            hint={t('panel.hooks.f.timeoutHint', {
              ms: info?.default_timeout_ms ?? snapshot.limits.default_timeout,
              max: snapshot.limits.max_timeout_ms,
            })}
          >
            <input
              id={id('timeout')}
              type="number"
              min={1}
              max={snapshot.limits.max_timeout_ms}
              className="cfg-input is-short"
              value={row.timeout_ms ?? ''}
              placeholder={String(info?.default_timeout_ms ?? snapshot.limits.default_timeout)}
              onChange={(e) => onPatch({ timeout_ms: parseWhole(e.target.value) })}
            />
          </Field>

          {info?.can_decide ? (
            <Field id={id('fail')} label={t('panel.hooks.f.failClosed')} hint={t('panel.hooks.f.failClosedHint')}>
              <Select
                id={id('fail')}
                value={row.fail_closed === null ? '' : row.fail_closed ? 'closed' : 'open'}
                options={[
                  {
                    value: '',
                    label: t('panel.hooks.f.fail.default', {
                      value: info.gate ? t('panel.hooks.f.fail.closed') : t('panel.hooks.f.fail.open'),
                    }),
                  },
                  { value: 'closed', label: t('panel.hooks.f.fail.closed') },
                  { value: 'open', label: t('panel.hooks.f.fail.open') },
                ]}
                onChange={(next) => onPatch({ fail_closed: next === '' ? null : next === 'closed' })}
              />
            </Field>
          ) : null}

          <Field
            id={id('output')}
            label={t('panel.hooks.f.output')}
            hint={t('panel.hooks.f.outputHint', { n: snapshot.limits.default_output.toLocaleString('en-US') })}
          >
            <input
              id={id('output')}
              type="number"
              min={1}
              max={snapshot.limits.max_output_bytes}
              className="cfg-input is-short"
              value={row.max_output_bytes ?? ''}
              placeholder={String(snapshot.limits.default_output)}
              onChange={(e) => onPatch({ max_output_bytes: parseWhole(e.target.value) })}
            />
          </Field>

          <Field id={id('status')} label={t('panel.hooks.f.status')} hint={t('panel.hooks.f.statusHint')}>
            <input
              id={id('status')}
              type="text"
              className="cfg-input"
              value={row.status_message}
              autoComplete="off"
              onChange={(e) => onPatch({ status_message: e.target.value })}
            />
          </Field>

          <div className="hk-actions">
            <Tip label={t('panel.hooks.moveUp')}>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-compact"
                aria-label={t('panel.hooks.moveUp')}
                disabled={!canMove(draft, index, -1)}
                onClick={() => onMove(-1)}
              >
                <ArrowUp size={13} />
              </button>
            </Tip>
            <Tip label={t('panel.hooks.moveDown')}>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-compact"
                aria-label={t('panel.hooks.moveDown')}
                disabled={!canMove(draft, index, 1)}
                onClick={() => onMove(1)}
              >
                <ArrowDown size={13} />
              </button>
            </Tip>
            <span className="cfg-hint grow">{t('panel.hooks.order')}</span>
            {/* The app's two-press rule: the first press only arms the button, so a stray
              * click cannot delete a hook. Leaving the button disarms it. */}
            <button
              type="button"
              className={`btn btn-ghost btn-compact cfg-danger${isArmed ? ' is-armed' : ''}`}
              onClick={isArmed ? onRemove : onArm}
              onBlur={onDisarm}
            >
              <Trash2 size={13} />
              {isArmed ? t('panel.hooks.removeConfirm') : t('panel.hooks.remove')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** The labelled row `.pc-row` draws. A `label` bound by `htmlFor` rather than wrapping the
 *  control, because a row can hold several controls and a wrapping label would send a click
 *  on its text to the first of them. */
function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="pc-row">
      <label className="pc-label" htmlFor={id}>
        {label}
      </label>
      <span className="pc-control">
        {children}
        {hint ? <span className="cfg-hint">{hint}</span> : null}
      </span>
    </div>
  );
}

function ScriptPicker({
  scripts,
  dir,
  onPick,
}: {
  scripts: HookScript[];
  dir: string;
  onPick: (script: HookScript) => void;
}) {
  const t = useT();
  return (
    // `value={null}`: this is a picker, not a field. It acts on the click and
    // keeps showing the prompt, like the native select with `value=""` did.
    <Select
      ariaLabel={t('panel.hooks.f.script')}
      value={null}
      placeholder={t('panel.hooks.f.scriptPick', { dir })}
      options={scripts.map((script) => ({ value: script.path, label: script.name }))}
      onChange={(path) => {
        const script = scripts.find((item) => item.path === path);
        if (script !== undefined) onPick(script);
      }}
    />
  );
}

/* ============================================================
   How the last run ended.
   ============================================================ */

/**
 * The runtime's own report on a script's most recent run in this session.
 *
 * The verdict is a badge; the executor's own word for it is printed beside it untranslated,
 * because it is what the audit log says and what the person will search for. A refusal is
 * not drawn as a failure — it is the guardrail doing its job — and an interruption is not
 * drawn as one either, because pressing stop is not the script being slow.
 */
function RunLine({ activity }: { activity: HookActivity }) {
  const t = useT();
  const last = activity.last;
  if (last === null) return null;
  const view = RUN_VIEW[last.class];
  const at = Date.parse(last.at);
  return (
    <div className={`hk-run is-${last.class}`}>
      <span>
        <Badge tone={view.tone}>{t(view.label)}</Badge>
      </span>
      <span className="hk-run-status">{last.status}</span>
      {Number.isNaN(at) ? null : <span>{formatRelative(at)}</span>}
      <span>{formatDuration(last.duration_ms)}</span>
      <span>
        {last.exit_code === null ? t('panel.hooks.run.noExit') : t('panel.hooks.run.exit', { code: last.exit_code })}
      </span>
      {last.tool !== '' ? <span>{t('panel.hooks.run.tool', { tool: last.tool })}</span> : null}
      <span>{t('panel.hooks.run.counts', { runs: activity.runs, failures: activity.failures })}</span>
      {last.reason !== '' && last.class !== 'success' ? <pre className="hk-run-reason">{last.reason}</pre> : null}
    </div>
  );
}

/* ============================================================
   The repository's own file, read-only.
   ============================================================ */

function WorkspaceHooks({
  workspace,
  sessionDisabled,
}: {
  workspace: HooksSnapshot['workspace'];
  sessionDisabled: boolean;
}) {
  const t = useT();
  return (
    <section className="hk-ws">
      <div className="hk-ws-head">
        <Webhook size={14} aria-hidden />
        <span className="hk-ws-title">{t('panel.hooks.ws.title')}</span>
        <Badge tone={workspace.trusted ? 'success' : 'warning'}>
          {workspace.trusted ? t('panel.hooks.ws.trusted') : t('panel.hooks.ws.untrusted')}
        </Badge>
      </div>
      <p className="hk-ws-note">{t('panel.hooks.ws.note')}</p>
      <span className="hk-ws-path" title={workspace.path}>
        {workspace.path}
      </span>
      {workspace.problem !== '' ? (
        <p className="hk-warn">{t('panel.hooks.ws.problem', { problem: workspace.problem })}</p>
      ) : null}
      {!workspace.trusted ? (
        <p className="hk-ws-note">
          {t('panel.hooks.ws.trustHow')} <code className="hk-code">{workspace.trust_command}</code>
        </p>
      ) : null}
      {workspace.entries.map((entry) => (
        <WorkspaceRow
          key={`${entry.event}/${entry.name}`}
          entry={entry}
          trusted={workspace.trusted}
          sessionDisabled={sessionDisabled}
        />
      ))}
    </section>
  );
}

function WorkspaceRow({
  entry,
  trusted,
  sessionDisabled,
}: {
  entry: WorkspaceHookRow;
  trusted: boolean;
  sessionDisabled: boolean;
}) {
  const t = useT();
  // Why a row is not running, in the order a person can act on it: a switch the session
  // was started with, then what the file says, then whether it was approved, and last the
  // timing — approved after this session started.
  const why: TKey | null = entry.effective
    ? null
    : sessionDisabled
      ? 'panel.hooks.ws.why.noHooks'
      : !entry.allowed
        ? 'panel.hooks.ws.why.event'
        : !entry.enabled
          ? 'panel.hooks.ws.why.off'
          : !trusted
            ? 'panel.hooks.ws.why.untrusted'
            : 'panel.hooks.ws.why.afterStart';
  return (
    <div className="hk-ws-row">
      <div className="hk-ws-line">
        <span className="hk-name">{entry.name}</span>
        <span className="hk-event">{entry.event}</span>
        {entry.matcher !== '*' ? <span className="hk-event">{entry.matcher}</span> : null}
        {entry.effective ? <Badge tone="success">{t('panel.hooks.state.active')}</Badge> : null}
      </div>
      <span className="hk-summary" title={entry.command}>
        {entry.command}
      </span>
      {why !== null ? <span className="hk-ws-why">{t(why)}</span> : null}
      {entry.activity !== null && entry.activity.last !== null ? <RunLine activity={entry.activity} /> : null}
    </div>
  );
}

/* ============================================================
   Words.
   ============================================================ */

function draftProblemText(
  t: ReturnType<typeof useT>,
  problem: DraftProblem,
  maxPerEvent: number,
): string {
  const label = problem.name === '' ? `#${problem.row}` : `“${problem.name}”`;
  switch (problem.code) {
    case 'noName':
      return t('panel.hooks.p.noName', { row: problem.row });
    case 'noCommand':
      return t('panel.hooks.p.noCommand', { label });
    case 'duplicate':
      return t('panel.hooks.p.duplicate', { label, event: problem.event });
    case 'tooMany':
      return t('panel.hooks.p.tooMany', { max: maxPerEvent, event: problem.event });
  }
}
