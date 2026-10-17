import { useEffect, useMemo, useState } from 'react';
import { Brain, Check, RefreshCw, RotateCw, ShieldQuestion, Trash2, X } from 'lucide-react';
import { useT } from '@/i18n/useT';
import type {
  MemoryCandidateRow,
  MemoryConfig,
  MemoryEntryRow,
  MemoryIndexStatus,
} from '@/protocol/types';
import { useApp, useSessionField } from '@/state/store';
import { Badge, EmptyState, Info } from '@/components/ui/kit';
import { PanelBody, PanelShell } from './PanelShell';

/**
 * Workspace memory: what this workspace has learned, and the queue of things it has
 * been asked to remember.
 *
 * **Two different kinds of row, and the difference is the whole design.** A
 * *candidate* is a proposal — inert, unsearchable, worth nothing until somebody
 * publishes it. An *entry* is a memory — it is in the index, it can be injected into
 * a request, and retiring it changes what future sessions believe. They are drawn as
 * two lists with two vocabularies for exactly that reason: a screen that presented
 * them as one list of "memories" would make publishing look like a formality and
 * deprecating look harmless.
 *
 * **The settings are here rather than in the config editor.** `~/.tudouni/config.json`
 * is about the person (keys, routes); this file is `.tudouni/memory/config.json`,
 * it is about one workspace, and it is read by the memory subsystem alone. Putting it
 * two panels away from the corpus it governs would mean changing a setting, closing a
 * dialog, and re-opening another to see whether it did what it said.
 *
 * **Nothing is patched here.** Every action answers with a fresh snapshot, and this
 * component redraws from it. A front end that removed a published row itself would be
 * guessing at what publishing does — which is how a deprecation ends up drawn as a
 * deletion.
 */
export function MemoryPanel() {
  const t = useT();
  const snapshot = useSessionField((rt) => rt.memory, null);
  const problem = useSessionField((rt) => rt.memoryProblem, null);
  const requestMemory = useApp((s) => s.requestMemory);
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

  return (
    <PanelShell
      title={t('panel.memory.title')}
      count={snapshot === null ? undefined : entries.length}
      note={snapshot?.root ?? t('panel.memory.note')}
      actions={
        <>
          {/* Two buttons, and they answer different questions: refresh re-reads what
            * is on disk (somebody may have edited a memory in an editor), rebuild
            * throws the derived index away and re-derives it. The second is the repair
            * the design promises; the first is the ordinary "did my edit land". */}
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t('panel.memory.refresh')}
            title={t('panel.memory.refresh')}
            onClick={() => requestMemory()}
          >
            <RefreshCw size={13} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t('panel.memory.rebuild')}
            title={t('panel.memory.rebuild')}
            onClick={() => memoryAction('rebuild')}
          >
            <RotateCw size={13} />
          </button>
        </>
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

        {snapshot === null ? (
          <EmptyState title={t('panel.memory.loading')} />
        ) : (
          <>
            <MemorySettings
              draft={draft ?? snapshot.config}
              dirty={dirty}
              onChange={patchDraft}
              onSave={() => {
                if (draft === null) return;
                // The whole known set travels, as a patch: the runtime keeps anything
                // it knows that this build does not send, and clamps what is out of
                // range. The clamps come back in the next snapshot, which is why the
                // draft re-seeds from it rather than from what was typed.
                memoryAction('config', { config: draft });
              }}
            />

            <div className="panel-group-head">
              <span>{t('panel.memory.review')}</span>
              <Info label={t('panel.memory.reviewHint')} />
              {candidates.length > 0 ? <span className="count">{candidates.length}</span> : null}
            </div>
            {candidates.length === 0 ? (
              <EmptyState compact title={t('panel.memory.reviewEmpty')} />
            ) : (
              candidates.map((candidate) => (
                <CandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  onPublish={() => memoryAction('publish', { proposal_id: candidate.id })}
                  onReject={() => memoryAction('reject', { proposal_id: candidate.id })}
                />
              ))
            )}

            <div className="panel-group-head">
              <span>{t('panel.memory.recorded')}</span>
              <Info label={t('panel.memory.confidenceHint')} />
              <span className="count">{entries.length}</span>
            </div>
            {entries.length === 0 ? (
              <EmptyState title={t('panel.memory.empty')} hint={t('panel.memory.emptyHint')} />
            ) : (
              entries.map((entry) => (
                <EntryCard
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

            {snapshot.unreadable.length > 0 ? (
              <>
                <div className="cmdk-group">{t('panel.memory.unreadable')}</div>
                {snapshot.unreadable.map((line, index) => (
                  <div key={`u-${index}`} className="caption" style={{ color: 'var(--warning)', padding: '2px var(--space-3)' }}>
                    {line}
                  </div>
                ))}
              </>
            ) : null}
          </>
        )}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   Settings: four switches and five numbers.
   ============================================================ */
function MemorySettings({
  draft,
  dirty,
  onChange,
  onSave,
}: {
  draft: MemoryConfig;
  dirty: boolean;
  onChange: (patch: Partial<MemoryConfig>) => void;
  onSave: () => void;
}) {
  const t = useT();
  return (
    <div>
      <div className="panel-group-head">
        <span>{t('panel.memory.settings')}</span>
        <Info label={t('panel.memory.settingsHint')} />
      </div>

      <div className="cfg-grid">
        <Switch
          label={t('panel.memory.enabled')}
          hint={t('panel.memory.enabledHint')}
          checked={draft.enabled}
          onChange={(enabled) => onChange({ enabled })}
        />
        <Switch
          label={t('panel.memory.autoInject')}
          hint={t('panel.memory.autoInjectHint')}
          checked={draft.auto_inject}
          onChange={(auto_inject) => onChange({ auto_inject })}
        />
        <Switch
          label={t('panel.memory.turnStart')}
          hint={t('panel.memory.turnStartHint')}
          checked={draft.recall_on_turn_start}
          onChange={(recall_on_turn_start) => onChange({ recall_on_turn_start })}
        />
        <Switch
          label={t('panel.memory.toolFailure')}
          hint={t('panel.memory.toolFailureHint')}
          checked={draft.recall_on_tool_failure}
          onChange={(recall_on_tool_failure) => onChange({ recall_on_tool_failure })}
        />
        <NumberField
          label={t('panel.memory.maxRecall')}
          value={draft.max_recall}
          min={1}
          max={10}
          onChange={(max_recall) => onChange({ max_recall })}
        />
        <NumberField
          label={t('panel.memory.maxResults')}
          value={draft.max_results}
          min={1}
          max={20}
          onChange={(max_results) => onChange({ max_results })}
        />
        <NumberField
          label={t('panel.memory.minScore')}
          value={draft.min_score}
          min={1}
          max={20}
          step={0.5}
          onChange={(min_score) => onChange({ min_score })}
        />
        <NumberField
          label={t('panel.memory.entryChars')}
          value={draft.entry_chars}
          min={120}
          max={4000}
          step={40}
          onChange={(entry_chars) => onChange({ entry_chars })}
        />
        <NumberField
          label={t('panel.memory.noteChars')}
          value={draft.note_chars}
          min={200}
          max={12000}
          step={100}
          onChange={(note_chars) => onChange({ note_chars })}
        />
      </div>

      <div className="row" style={{ gap: 'var(--space-2)', padding: 'var(--space-2) var(--space-3)' }}>
        <button type="button" className="btn btn-outline btn-compact" disabled={!dirty} onClick={onSave}>
          {t('panel.memory.save')}
        </button>
        {/* A disabled Save with no explanation reads as a broken button; the sentence
          * that explains it is the difference between "saved" and "nothing to save". */}
        <span className="caption faint">{dirty ? t('panel.memory.dirty') : t('panel.memory.saved')}</span>
      </div>
    </div>
  );
}

function Switch({
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
  // The checkbox row **is** the field label, rather than sitting under a second copy of
  // the same sentence: on a form this dense, a label and its control repeating the same
  // words reads as two settings.
  return (
    <div className="cfg-field">
      <label className="cfg-check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      <span className="cfg-hint">{hint}</span>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="cfg-field">
      <span className="cfg-label">{label}</span>
      <input
        className="cfg-input"
        type="number"
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(e) => {
          const next = Number(e.target.value);
          // A cleared field reads as 0, and 0 is not a value the runtime accepts for
          // any of these. Sending it would be clamped to the floor, which looks like
          // the field ignoring what was typed — so an empty box keeps the old number.
          if (Number.isFinite(next) && e.target.value !== '') onChange(next);
        }}
      />
    </label>
  );
}

/* ============================================================
   One proposal.
   ============================================================ */
function CandidateCard({
  candidate,
  onPublish,
  onReject,
}: {
  candidate: MemoryCandidateRow;
  onPublish: () => void;
  onReject: () => void;
}) {
  const t = useT();
  // The op is the first thing after the title, because it is the difference between
  // adding a memory, rewriting one, and retiring one — and publishing is one click
  // away from all three.
  const opLabel =
    candidate.op === 'update'
      ? t('panel.memory.op.update', { id: candidate.target_id })
      : candidate.op === 'deprecate'
        ? t('panel.memory.op.deprecate', { id: candidate.target_id })
        : t('panel.memory.op.create');
  const tone = candidate.op === 'deprecate' ? 'warning' : candidate.op === 'update' ? 'info' : 'success';

  return (
    <div className="wm-card">
      <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'baseline' }}>
        <span className="strong grow">{candidate.title}</span>
        <Badge tone={tone} dot={false}>
          {opLabel}
        </Badge>
        <ConfidenceBadge confidence={candidate.confidence} />
      </div>
      <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <span className="mono faint">{candidate.id}</span>
        {candidate.triggers.length === 0 ? (
          <span className="caption faint">{t('panel.memory.noTriggers')}</span>
        ) : (
          candidate.triggers.map((trigger) => (
            <span key={trigger} className="caption muted mono">
              {trigger}
            </span>
          ))
        )}
      </div>
      {candidate.reason ? <div className="caption muted">{candidate.reason}</div> : null}
      {/* The body is the thing being approved, so it is shown — not hidden behind a
        * click. A reviewer who cannot read what they are publishing is not
        * reviewing. */}
      <pre className="wm-body">{candidate.body}</pre>
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <button type="button" className="btn btn-outline btn-compact" onClick={onPublish}>
          <Check size={12} />
          {t('panel.memory.publish')}
        </button>
        <button type="button" className="btn btn-ghost btn-compact" onClick={onReject}>
          <X size={12} />
          {t('panel.memory.reject')}
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   One memory on record.
   ============================================================ */
function EntryCard({
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
    <div className="wm-card">
      <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'baseline' }}>
        <span className="strong grow">{entry.title}</span>
        <ConfidenceBadge confidence={entry.confidence} />
      </div>
      <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <span className="mono faint">
          {entry.id} r{entry.revision}
        </span>
        <span className="caption faint">{entry.updated_at}</span>
        {entry.scope_paths.map((path) => (
          <span key={path} className="caption faint mono">
            {path}
          </span>
        ))}
        {entry.tags.map((tag) => (
          <Badge key={tag} tone="neutral" dot={false}>
            {tag}
          </Badge>
        ))}
      </div>
      {entry.triggers.length > 0 ? (
        <div className="caption muted mono clamp-2">{entry.triggers.join(' | ')}</div>
      ) : (
        <div className="caption faint">{t('panel.memory.noTriggers')}</div>
      )}

      {armed === null ? (
        <div className="row">
          <button type="button" className="btn btn-ghost btn-compact" onClick={onArm}>
            <Trash2 size={12} />
            {t('panel.memory.deprecate')}
          </button>
        </div>
      ) : (
        <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {/* Retiring is a proposal, not a deletion: the note moves to `archive/`
            * once it is published, and it can be read there afterwards. The button
            * says "Deprecate" because that is what it does. */}
          <input
            className="cfg-input grow"
            placeholder={t('panel.memory.deprecateReason')}
            value={armed.reason}
            onChange={(e) => onReason(e.target.value)}
            spellCheck={false}
          />
          <button type="button" className="btn btn-outline btn-compact" onClick={() => onConfirm(armed.reason)}>
            <ShieldQuestion size={12} />
            {t('panel.memory.deprecateConfirm')}
          </button>
          <button type="button" className="btn btn-ghost btn-compact" onClick={onCancel}>
            {t('panel.memory.deprecateCancel')}
          </button>
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
    <div className="caption faint" style={{ padding: 'var(--space-3)' }}>
      {t('panel.memory.indexLine', {
        n: index.entries,
        when: shortStamp(index.built_at),
      })}
      {index.rebuilt ? ` · ${t('panel.memory.rebuilt')}` : ''}
      {index.problem ? ` · ${index.problem}` : ''}
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const t = useT();
  const tone = confidence === 'verified' ? 'success' : confidence === 'inferred' ? 'warning' : 'neutral';
  const label =
    confidence === 'verified'
      ? t('panel.memory.confidence.verified')
      : confidence === 'inferred'
        ? t('panel.memory.confidence.inferred')
        : t('panel.memory.confidence.observed');
  return (
    <Badge tone={tone} dot={false}>
      <Brain size={10} /> {label}
    </Badge>
  );
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
