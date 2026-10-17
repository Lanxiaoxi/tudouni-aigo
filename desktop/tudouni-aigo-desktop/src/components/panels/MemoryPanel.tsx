import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ChevronDown, Inbox, Minus, Plus, RotateCw, ShieldQuestion, Trash2 } from 'lucide-react';
import type { TKey } from '@/i18n';
import { useT } from '@/i18n/useT';
import type {
  MemoryCandidateRow,
  MemoryConfig,
  MemoryConfidence,
  MemoryEntryRow,
  MemoryIndexStatus,
} from '@/protocol/types';
import { useApp, useSessionField } from '@/state/store';
import { EmptyState } from '@/components/ui/kit';
import { formatRelative } from '@/utils/format';
import { PanelBody, PanelShell } from './PanelShell';

/**
 * Workspace memory: how this workspace's recall behaves, and what it knows.
 *
 * **Two columns, because they are two halves of one subject.** The left column is
 * the behaviour — four switches and five numbers — and the right column is the
 * corpus: the proposals waiting for a decision and the memories on record. They
 * belong on one surface and not in two panels, which is where they used to be:
 * read together, the right column is the *effect* of the left one, and a person
 * changing "relevance floor" while the review queue is nowhere in sight has to
 * remember what they are tuning.
 *
 * **Two different kinds of row, and the difference is still the whole design.** A
 * *candidate* is a proposal — inert, unsearchable, worth nothing until somebody
 * approves it. An *entry* is a memory: it is in the index, it can be injected into
 * a request, and retiring it changes what future sessions believe. They are drawn
 * as two lists with two vocabularies for exactly that reason; this panel used to
 * say so in a paragraph of prose, and now says it structurally — the queue sits
 * above the record, wears the pale card, and its rows carry the two decisions,
 * while a record row carries none.
 *
 * **A candidate's body is one press away, not always on screen.** The queue is
 * scanned by title — that is what a title is for — and a card that printed every
 * full body would push the second proposal off the surface, which is the failure
 * the old stacked cards had. But approving *is* the act that makes the body a
 * memory, so it cannot be unreachable: `Read` expands it in place, and the
 * confidence and trigger words come with it, because they are the reason to
 * believe or distrust that body.
 *
 * **The settings are here rather than in the config editor.**
 * `~/.tudouni/config.json` is about the person (keys, routes); this file is
 * `.tudouni/memory/config.json`, it is about one workspace, and it is read by the
 * memory subsystem alone. Putting it two panels away from the corpus it governs
 * would mean changing a setting, closing a dialog, and re-opening another to see
 * whether it did what it said.
 *
 * **Nothing is patched here.** Every action answers with a fresh snapshot, and this
 * component redraws from it. A front end that removed a published row itself would
 * be guessing at what publishing does — which is how a deprecation ends up drawn as
 * a deletion. The draft is the one exception, and it is not state: it is unsaved
 * typing, seeded from the snapshot and thrown away when the snapshot changes.
 */
export function MemoryPanel() {
  const t = useT();
  const snapshot = useSessionField((rt) => rt.memory, null);
  const problem = useSessionField((rt) => rt.memoryProblem, null);
  const memoryAction = useApp((s) => s.memoryAction);
  const hasSession = useApp((s) => s.activeKey !== null);

  // The draft is a copy of the runtime's config, seeded once per snapshot. It is
  // local state rather than a store field because it is unsaved typing: it must not
  // survive closing the panel, and it must not be readable as "the settings".
  const [draft, setDraft] = useState<MemoryConfig | null>(null);
  useEffect(() => {
    setDraft(snapshot?.config ?? null);
  }, [snapshot?.config]);

  // The entry whose deprecation is armed, plus the reason typed so far. Retiring a
  // memory is not undoable from this screen — it moves to `archive/` — so it takes a
  // second press, the same rule session deletion and terminal kill follow.
  const [armed, setArmed] = useState<{ id: string; reason: string } | null>(null);

  // The candidate whose body is expanded. One at a time: the point of the fold is
  // that the queue stays readable as a queue.
  const [reading, setReading] = useState<string | null>(null);

  const entries = snapshot?.entries ?? [];
  const candidates = snapshot?.candidates ?? [];
  const dirty = useMemo(() => draft !== null && snapshot !== null && !sameConfig(draft, snapshot.config), [draft, snapshot]);

  function patchDraft(patch: Partial<MemoryConfig>) {
    setDraft((current) => (current === null ? current : { ...current, ...patch }));
  }

  if (!hasSession) {
    return (
      <PanelShell title={t('panel.memory.title')} note={t('panel.memory.note')}>
        <PanelBody>
          <EmptyState title={t('panel.memory.noSession')} />
        </PanelBody>
      </PanelShell>
    );
  }

  const settings = draft ?? snapshot?.config ?? null;

  return (
    <PanelShell
      title={t('panel.memory.title')}
      note={snapshot?.root ?? t('panel.memory.note')}
      actions={
        // One button, and it is the repair. It used to be two — "reload from disk"
        // and "rebuild index" — but rebuilding re-reads the Markdown as well, so the
        // cheaper verb only ever redrew the same rows; the design keeps the one that
        // can fix something.
        <button
          type="button"
          className="btn btn-outline"
          disabled={snapshot === null}
          onClick={() => memoryAction('rebuild')}
        >
          <RotateCw size={13} />
          {t('panel.memory.rebuild')}
        </button>
      }
    >
      <PanelBody>
        {/* **The refusal banner.** It is drawn from `memoryProblem`, not from a
          * notice, because the panel is a modal layer: a notice explaining a failed
          * publish is printed behind this dialog. The runtime's own sentence is shown
          * unaltered — it is the authority on why. */}
        {problem !== null ? (
          <div className="cfg-problems" role="alert">
            <div className="cfg-problem is-blocking">
              {t('panel.memory.problem')}: {problem}
            </div>
          </div>
        ) : null}

        {snapshot === null || settings === null ? (
          <EmptyState title={t('panel.memory.loading')} />
        ) : (
          <div className="wm">
            <div className="wm-main">
              <div className="wm-legend">{t('panel.memory.behavior')}</div>
              <div className="wm-group">
                <SwitchRow
                  label={t('panel.memory.enabled')}
                  hint={t('panel.memory.enabledHint')}
                  checked={settings.enabled}
                  onChange={(enabled) => patchDraft({ enabled })}
                />
                <SwitchRow
                  label={t('panel.memory.autoInject')}
                  hint={t('panel.memory.autoInjectHint')}
                  checked={settings.auto_inject}
                  onChange={(auto_inject) => patchDraft({ auto_inject })}
                />
                <SwitchRow
                  label={t('panel.memory.turnStart')}
                  hint={t('panel.memory.turnStartHint')}
                  checked={settings.recall_on_turn_start}
                  onChange={(recall_on_turn_start) => patchDraft({ recall_on_turn_start })}
                />
                <SwitchRow
                  label={t('panel.memory.toolFailure')}
                  hint={t('panel.memory.toolFailureHint')}
                  checked={settings.recall_on_tool_failure}
                  onChange={(recall_on_tool_failure) => patchDraft({ recall_on_tool_failure })}
                />
              </div>

              <div className="wm-legend wm-legend-gap">{t('panel.memory.tuning')}</div>
              <div className="wm-group">
                <NumberRow
                  label={t('panel.memory.maxRecall')}
                  limit={LIMITS.max_recall}
                  value={settings.max_recall}
                  onChange={(max_recall) => patchDraft({ max_recall })}
                />
                <NumberRow
                  label={t('panel.memory.maxResults')}
                  limit={LIMITS.max_results}
                  value={settings.max_results}
                  onChange={(max_results) => patchDraft({ max_results })}
                />
                <SliderRow
                  label={t('panel.memory.minScore')}
                  limit={LIMITS.min_score}
                  value={settings.min_score}
                  onChange={(min_score) => patchDraft({ min_score })}
                />
                <NumberRow
                  label={t('panel.memory.entryChars')}
                  limit={LIMITS.entry_chars}
                  value={settings.entry_chars}
                  onChange={(entry_chars) => patchDraft({ entry_chars })}
                />
                <NumberRow
                  label={t('panel.memory.noteChars')}
                  limit={LIMITS.note_chars}
                  value={settings.note_chars}
                  onChange={(note_chars) => patchDraft({ note_chars })}
                />
              </div>

              {snapshot.unreadable.length > 0 ? (
                <div className="wm-unreadable">
                  <div className="wm-legend">{t('panel.memory.unreadable')}</div>
                  {snapshot.unreadable.map((line, index) => (
                    <div key={`u-${index}`} className="wm-unreadable-line">
                      {line}
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="wm-save">
                {/* A disabled Save with no explanation reads as a broken button; the
                  * sentence that explains it is the difference between "saved" and
                  * "nothing to save". The design's caption says what the change will
                  * do, and that is the sentence when there is nothing pending. */}
                <span className={`wm-save-note${dirty ? ' is-dirty' : ''}`}>
                  {dirty ? t('panel.memory.dirty') : t('panel.memory.saveNote')}
                </span>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={sameConfig(settings, DEFAULTS)}
                  onClick={() => setDraft({ ...DEFAULTS })}
                >
                  {t('panel.memory.reset')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!dirty}
                  onClick={() => {
                    // The whole known set travels, as a patch: the runtime keeps
                    // anything it knows that this build does not send, and clamps what
                    // is out of range. The clamps come back in the next snapshot, which
                    // is why the draft re-seeds from it rather than from what was typed.
                    memoryAction('config', { config: settings });
                  }}
                >
                  {t('panel.memory.save')}
                </button>
              </div>
            </div>

            <aside className="wm-side">
              <div className="wm-side-head">
                <span className="wm-side-title">{t('panel.memory.review')}</span>
                <span className="wm-pill">{candidates.length}</span>
              </div>
              {candidates.length === 0 ? (
                <div className="wm-side-empty">{t('panel.memory.reviewEmpty')}</div>
              ) : (
                candidates.map((candidate) => (
                  <CandidateItem
                    key={candidate.id}
                    candidate={candidate}
                    open={reading === candidate.id}
                    onToggle={() => setReading(reading === candidate.id ? null : candidate.id)}
                    onApprove={() => memoryAction('publish', { proposal_id: candidate.id })}
                    onDiscard={() => memoryAction('reject', { proposal_id: candidate.id })}
                  />
                ))
              )}

              <div className="wm-side-head wm-side-head-gap">
                <span className="wm-side-title">{t('panel.memory.recorded')}</span>
                <span className="wm-pill">{entries.length}</span>
              </div>
              {entries.length === 0 ? (
                <div className="wm-on-empty">
                  <Inbox size={26} className="wm-on-icon" aria-hidden />
                  <div className="wm-on-title">{t('panel.memory.empty')}</div>
                  <div className="wm-on-hint">{t('panel.memory.emptyHint')}</div>
                </div>
              ) : (
                entries.map((entry) => (
                  <EntryItem
                    key={entry.id}
                    entry={entry}
                    armed={armed?.id === entry.id ? armed : null}
                    onArm={() => setArmed({ id: entry.id, reason: '' })}
                    onConfirm={(reason) => {
                      memoryAction('deprecate', { entry_id: entry.id, reason });
                      setArmed(null);
                    }}
                    onCancel={() => setArmed(null)}
                    onReason={(reason) => setArmed({ id: entry.id, reason })}
                  />
                ))
              )}

              <IndexLine index={snapshot.index} />
            </aside>
          </div>
        )}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   The knobs, and the numbers they are allowed to take.
   ============================================================ */

/** A numeric knob's range, and how far one press moves it.
 *
 *  **These mirror `internal/memory/config.go`** — `Normalise`'s ceilings and the
 *  defaults below are a copy of `DefaultConfig`. The duplication is deliberate and
 *  it is the same one the panel has always had: the runtime reports the *current*
 *  config, never the defaults, so "Reset to defaults" has no other source. The
 *  runtime normalises everything it is sent, so a copy that drifts is a wrong
 *  suggestion rather than a config it refuses — but it is still a copy to keep in
 *  step, and the Go constants are the ones named here. */
const LIMITS = {
  max_recall: { min: 1, max: 10, step: 1 },
  max_results: { min: 1, max: 20, step: 1 },
  min_score: { min: 0.5, max: 20, step: 0.5 },
  entry_chars: { min: 120, max: 4000, step: 40 },
  note_chars: { min: 200, max: 12000, step: 100 },
} as const;

type Limit = { readonly min: number; readonly max: number; readonly step: number };

/** `memory.DefaultConfig()`, for the reset button. See `LIMITS` for why it is here. */
const DEFAULTS: MemoryConfig = {
  version: 1,
  enabled: true,
  auto_inject: true,
  recall_on_turn_start: true,
  recall_on_tool_failure: true,
  max_recall: 3,
  max_results: 5,
  min_score: 2,
  entry_chars: 600,
  note_chars: 2400,
};

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  // A `role="switch"` button rather than a styled checkbox: the two states are one
  // element's own attribute, and nothing has to keep a hidden input in sync with a
  // drawn knob. It is the same control the task editor uses, at the same size.
  return (
    <div className="wm-switch">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`tk-switch${checked ? ' is-on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="tk-switch-knob" />
      </button>
      <span className="wm-switch-text">
        <span className="wm-switch-label">{label}</span>
        <span className="wm-switch-hint">{hint}</span>
      </span>
    </div>
  );
}

function NumberRow({
  label,
  limit,
  value,
  onChange,
}: {
  label: string;
  limit: Limit;
  value: number;
  onChange: (value: number) => void;
}) {
  const t = useT();
  return (
    <div className="wm-num">
      <span className="wm-num-label">{label}</span>
      <span className="wm-num-range">
        {numberText(limit.min)}–{numberText(limit.max)}
      </span>
      <span className="wm-stepper">
        <button
          type="button"
          className="wm-step"
          aria-label={t('panel.memory.decrease', { label })}
          disabled={value <= limit.min}
          onClick={() => onChange(stepBy(value, -limit.step, limit))}
        >
          <Minus size={13} />
        </button>
        {/* **Editable, in a box that reads as a stepper.** The buttons are the
            * ordinary way to change a number here, but `note_chars` spans 200–12000 in
            * steps of 100: reaching 3000 by pressing "+" is 28 presses for a value
            * somebody already knows. So the value is a field with the spinners
            * removed — it looks like the design's number and types like a field. */}
        <input
          className="wm-step-value"
          type="number"
          inputMode="numeric"
          aria-label={label}
          value={value}
          min={limit.min}
          max={limit.max}
          step={limit.step}
          onChange={(e) => {
            // A cleared box reads as 0, and 0 is below every floor here; sending it
            // would be clamped and then re-seeded, which looks like the field
            // rejecting what was typed. An empty box therefore keeps the old number.
            if (e.target.value === '') return;
            const next = Number(e.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
          onBlur={() => {
            // Left out of range, the number is pulled to the bound: the stepper's own
            // disabled states are built from the same bounds, and a field reading 500
            // next to a "+" that does nothing is two answers to one question. The
            // runtime clamps as well, and its note is the authority on what was saved.
            const next = Math.min(limit.max, Math.max(limit.min, value));
            if (next !== value) onChange(next);
          }}
        />
        <button
          type="button"
          className="wm-step"
          aria-label={t('panel.memory.increase', { label })}
          disabled={value >= limit.max}
          onClick={() => onChange(stepBy(value, limit.step, limit))}
        >
          <Plus size={13} />
        </button>
      </span>
    </div>
  );
}

function SliderRow({
  label,
  limit,
  value,
  onChange,
}: {
  label: string;
  limit: Limit;
  value: number;
  onChange: (value: number) => void;
}) {
  // The filled half of the track is a gradient stop computed here rather than a
  // second element: a range input's track is a pseudo-element, and there is nothing
  // to nest a fill inside it. It is one custom property, and the track reads it.
  const fill = limit.max === limit.min ? 0 : ((value - limit.min) / (limit.max - limit.min)) * 100;
  return (
    <div className="wm-num wm-slider-row">
      <span className="wm-num-label">{label}</span>
      <span className="wm-num-range">
        {numberText(limit.min)}–{numberText(limit.max)}
      </span>
      <input
        className="wm-slider"
        type="range"
        aria-label={label}
        min={limit.min}
        max={limit.max}
        step={limit.step}
        value={value}
        style={{ '--wm-fill': `${fill}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="wm-slider-value" aria-hidden>
        {numberText(value)}
      </span>
    </div>
  );
}

/* ============================================================
   One proposal.
   ============================================================ */
function CandidateItem({
  candidate,
  open,
  onToggle,
  onApprove,
  onDiscard,
}: {
  candidate: MemoryCandidateRow;
  open: boolean;
  onToggle: () => void;
  onApprove: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  // The op is in the queue at all, because it is the difference between adding a
  // memory, rewriting one, and retiring one — and approving is one click away from
  // all three. It rides the meta line rather than a badge: this row has two
  // decisions in it already, and a third chip would out-shout them.
  const opLabel =
    candidate.op === 'update'
      ? t('panel.memory.op.update', { id: candidate.target_id })
      : candidate.op === 'deprecate'
        ? t('panel.memory.op.deprecate', { id: candidate.target_id })
        : t('panel.memory.op.create');

  return (
    <div className="wm-cand">
      <div className="wm-cand-title">{candidate.title}</div>
      <div className="wm-cand-meta">
        <span className="wm-cand-time">{t('panel.memory.proposed', { when: relativeStamp(candidate.created_at) })}</span>
        <span className="wm-cand-op">{opLabel}</span>
        <button type="button" className="wm-read" aria-expanded={open} onClick={onToggle}>
          {open ? t('panel.memory.hide') : t('panel.memory.read')}
          <ChevronDown size={12} className={`wm-read-caret${open ? ' is-open' : ''}`} />
        </button>
      </div>

      {open ? (
        <>
          <pre className="wm-body">{candidate.body}</pre>
          <div className="wm-cand-detail">
            <span
              className={`wm-conf wm-conf-${candidate.confidence}`}
              title={t('panel.memory.confidenceHint')}
            >
              {t(confidenceKey(candidate.confidence))}
            </span>
            {candidate.triggers.length === 0 ? (
              <span className="wm-trigger">{t('panel.memory.noTriggers')}</span>
            ) : (
              candidate.triggers.map((trigger) => (
                <span key={trigger} className="wm-trigger">
                  {trigger}
                </span>
              ))
            )}
          </div>
          {candidate.reason ? <div className="wm-cand-detail">{candidate.reason}</div> : null}
        </>
      ) : null}

      <div className="wm-cand-actions">
        <button type="button" className="btn btn-primary" onClick={onApprove}>
          {t('panel.memory.approve')}
        </button>
        <button type="button" className="btn wm-btn-soft" onClick={onDiscard}>
          {t('panel.memory.discard')}
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   One memory on record.
   ============================================================ */
function EntryItem({
  entry,
  armed,
  onArm,
  onCancel,
  onConfirm,
  onReason,
}: {
  entry: MemoryEntryRow;
  armed: { id: string; reason: string } | null;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  onReason: (reason: string) => void;
}) {
  const t = useT();
  return (
    <div className="wm-entry">
      <div className="wm-entry-head">
        <span className="wm-entry-title">{entry.title}</span>
        {/* The evidence state, in the corner and in a colour, because it is the one
          * thing that changes how much a reader should trust the row. The sentence
          * explaining the three words is on hover — the queue is not the place for a
          * paragraph about epistemics. */}
        <span
          className={`wm-conf wm-conf-${entry.confidence}`}
          title={t('panel.memory.confidenceHint')}
        >
          {t(confidenceKey(entry.confidence))}
        </span>
      </div>
      <div className="wm-entry-meta">
        <span className="mono">
          {entry.id} r{entry.revision}
        </span>
        <span>{t('panel.memory.updated', { when: relativeStamp(entry.updated_at) })}</span>
        <span>{t('panel.memory.chars', { n: entry.chars.toLocaleString('en-US') })}</span>
      </div>
      {entry.scope_paths.length > 0 || entry.tags.length > 0 ? (
        <div className="wm-entry-facts">
          {entry.scope_paths.map((path) => (
            <span key={path} className="mono">
              {path}
            </span>
          ))}
          {entry.tags.map((tag) => (
            <span key={tag} className="wm-tag">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      {entry.triggers.length === 0 ? (
        <div className="wm-entry-triggers">{t('panel.memory.noTriggers')}</div>
      ) : (
        <div className="wm-entry-triggers">{entry.triggers.join(' · ')}</div>
      )}

      {armed === null ? (
        <button type="button" className="wm-action" onClick={onArm}>
          <Trash2 size={11} />
          {t('panel.memory.deprecate')}
        </button>
      ) : (
        <div className="wm-arm">
          {/* Retiring is a proposal, not a deletion: the note moves to `archive/`
            * once it is published, and it can be read there afterwards. The button
            * says "Deprecate" because that is what it does. */}
          <input
            className="cfg-input wm-arm-reason"
            placeholder={t('panel.memory.deprecateReason')}
            value={armed.reason}
            onChange={(e) => onReason(e.target.value)}
            spellCheck={false}
          />
          <div className="wm-arm-actions">
            <button type="button" className="btn btn-outline btn-compact" onClick={() => onConfirm(armed.reason)}>
              <ShieldQuestion size={11} />
              {t('panel.memory.deprecateConfirm')}
            </button>
            <button type="button" className="btn btn-ghost btn-compact" onClick={onCancel}>
              {t('panel.memory.deprecateCancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   The index line: one sentence about the derived data.
   ============================================================ */
function IndexLine({ index }: { index: MemoryIndexStatus }) {
  const t = useT();
  return (
    <div className="wm-index">
      {t('panel.memory.indexLine', {
        n: index.entries,
        when: shortStamp(index.built_at),
      })}
      {index.rebuilt ? ` · ${t('panel.memory.rebuilt')}` : ''}
      {index.problem ? ` · ${index.problem}` : ''}
    </div>
  );
}

/**
 * The word for an evidence state.
 *
 * A switch rather than a template literal, because the key has to be one of
 * `TKey`: a builder that returns `${prefix}${confidence}` type-checks as `string`,
 * and a renamed key would then be a runtime lookup miss instead of a compile error.
 */
function confidenceKey(confidence: MemoryConfidence): TKey {
  switch (confidence) {
    case 'verified':
      return 'panel.memory.confidence.verified';
    case 'inferred':
      return 'panel.memory.confidence.inferred';
    default:
      return 'panel.memory.confidence.observed';
  }
}

/** One press of a stepper, bounded and rounded.
 *
 *  Rounded because `min_score` moves in halves: `2.3 + 0.5` is
 *  `2.8000000000000003` in binary floating point, and a number field showing that
 *  is a number field nobody believes. */
function stepBy(value: number, delta: number, limit: Limit): number {
  const next = Math.min(limit.max, Math.max(limit.min, value + delta));
  return Math.round(next * 100) / 100;
}

/** `2` → `2`, `0.5` → `0.5`. The config's own granularity is a tenth. */
function numberText(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

/**
 * A timestamp as "how long ago", for the queue's own clock.
 *
 * A candidate's age is the fact that decides whether it is still worth reviewing,
 * and an absolute stamp would make the reader do the subtraction. Anything that
 * does not parse falls back to the short form rather than to "NaN ago": a proposal
 * whose file was hand-edited must still render.
 */
function relativeStamp(value: string): string {
  const at = Date.parse(value);
  return Number.isNaN(at) ? shortStamp(value) : formatRelative(at);
}

/**
 * `2026-10-17T23:37:44.34+08:00` → `2026-10-17 23:37`.
 *
 * The runtime writes a full RFC3339 timestamp with nanoseconds, which is right for a
 * file and unreadable in a caption: the seconds fraction and the offset are never what
 * a person is asking about. Anything that does not look like that shape is shown as it
 * came — guessing at a format is how a timestamp turns into "Invalid Date".
 */
function shortStamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return match === null ? value || '—' : `${match[1]} ${match[2]}`;
}

/** Whether two configs say the same thing.
 *  Structurally, one field at a time, rather than `JSON.stringify`: the panel only
 *  ever builds configs from the runtime's own object, so the field order is stable
 *  today — but a comparison whose correctness depends on key order is a comparison
 *  that breaks the first time one is rebuilt in another order. */
function sameConfig(a: MemoryConfig, b: MemoryConfig): boolean {
  return (
    a.enabled === b.enabled &&
    a.auto_inject === b.auto_inject &&
    a.recall_on_turn_start === b.recall_on_turn_start &&
    a.recall_on_tool_failure === b.recall_on_tool_failure &&
    a.max_recall === b.max_recall &&
    a.max_results === b.max_results &&
    a.min_score === b.min_score &&
    a.entry_chars === b.entry_chars &&
    a.note_chars === b.note_chars
  );
}
