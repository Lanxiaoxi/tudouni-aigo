import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, FileText, FlaskConical, Plus, Trash2, X } from 'lucide-react';
import { activeWorkspaceOf, useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey, Translate } from '@/i18n';
import { Tip } from '@/components/ui/kit';
import { Select, selectMenuIsOpen } from '@/components/ui/Select';
import { SwitchRow } from '@/components/ui/SwitchRow';
import { ModelPicker, WorkspacePicker } from '@/components/panels/TaskPanel';
import {
  probeSource,
  readSourcesFile,
  readSourcesPath,
  readSourcesStatus,
  writeSourcesFile,
} from '@/runtime/tauri';
import type { TaskWorkspaceRef } from '@/task/tasks';
import {
  DEFAULT_LIMIT,
  DEFAULT_ON,
  DEFAULT_THREAD_TEMPLATE,
  LIMIT_MAX,
  LIMIT_MIN,
  PROBE_KINDS,
  PROBE_SPECS,
  SOURCE_EVENTS,
  emptySource,
  emptySourcesFile,
  filterToRows,
  isProbeKind,
  jsonParamText,
  kindHintKey,
  kindLabelKey,
  listText,
  numberText,
  parseJsonParam,
  parseNumberInput,
  parseSourcesFile,
  rowsToFilter,
  serializeSourcesFile,
  setEmitField,
  setProbeParam,
  setSourceField,
  validateSource,
  type FilterRow,
  type LastScan,
  type ParamSpec,
  type ProbeKind,
  type ProbeResult,
  type SourceConfig,
  type SourceErrorCode,
  type SourceErrors,
  type SourceEvent,
  type SourcesFile,
  type SourcesProblem,
} from '@/ticket/sources';

/**
 * The Ticket Sources panel (docs/design/ticket-sources.md §6).
 *
 * **It edits a copy and writes the whole file.** `sources.json` is also edited
 * by hand, so the panel reads it, changes only what the person touched, and
 * writes it back with every field it did not understand still in place
 * (`sources.ts` never rebuilds an object it only needs to edit).
 *
 * **Rust has the last word.** The checks here put a reason beside the box
 * before the round trip; `sources_write` runs the real ones, and its refusal is
 * shown as it arrived and does not close the panel, because the typing is what
 * the refusal is about.
 *
 * **A file that cannot be read is not an empty one.** If it does not parse the
 * panel shows why, offers "Open file", and refuses to save: writing the empty
 * list over a file somebody is half-way through fixing would destroy it.
 */

const MAX_PROBE_ROWS = 20;
const ERROR_CLIP = 200;

type Phase = 'loading' | 'ready' | 'failed';

/** What the footer says about the last act. */
interface Note {
  tone: 'error' | 'info';
  text: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clip(text: string): string {
  return text.length > ERROR_CLIP ? `${text.slice(0, ERROR_CLIP)}…` : text;
}

function kindOf(src: SourceConfig): ProbeKind | null {
  const kind = src.probe?.kind;
  return isProbeKind(kind) ? kind : null;
}

function errorMessage(t: Translate, field: string, code: SourceErrorCode, spec?: ParamSpec): string {
  if (field === 'id' && code === 'format') return t('ticket.sources.err.idFormat');
  if (code === 'range') {
    const [min, max] =
      field === 'limit'
        ? [LIMIT_MIN, LIMIT_MAX]
        : spec !== undefined
          ? [spec.min, spec.max]
          : [undefined, undefined];
    if (min !== undefined && max !== undefined) return t('ticket.sources.err.rangeBetween', { min, max });
  }
  return t(`ticket.sources.err.${code}` as TKey);
}

function statusLine(t: Translate, src: SourceConfig, last: LastScan | undefined): { text: string; bad: boolean } {
  if (src.enabled === false) return { text: t('ticket.sources.status.off'), bad: false };
  if (last === undefined) return { text: t('ticket.sources.status.never'), bad: false };
  const when = new Date(last.atMs).toLocaleString();
  if (!last.ok) {
    return { text: t('ticket.sources.status.error', { when, error: clip(last.error ?? '') }), bad: true };
  }
  if (last.baseline) {
    return { text: t('ticket.sources.status.baseline', { when, total: last.total }), bad: false };
  }
  return { text: t('ticket.sources.status.ok', { when, emitted: last.emitted }), bad: false };
}

/* ============================================================
   The panel
   ============================================================ */

export function SourcesPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const workspaces = useApp((s) => s.workspaces);
  const remoteWorkspaces = useApp((s) => s.remoteWorkspaces);
  const activeWorkspace = useApp(activeWorkspaceOf);

  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState('');
  const [file, setFile] = useState<SourcesFile>(emptySourcesFile);
  const [problem, setProblem] = useState<SourcesProblem | null>(null);
  const [exists, setExists] = useState(false);
  const [draft, setDraft] = useState<SourceConfig[]>([]);
  /** The text on disk (as this panel would write it): what "unsaved" is measured against. */
  const [baseline, setBaseline] = useState('');
  const [status, setStatus] = useState<Record<string, LastScan>>({});

  const [sel, setSel] = useState(-1);
  /** Bumped whenever the editor must start fresh (another source, a new one, a
   *  deletion): its local state — the half-typed JSON, the filter rows, the
   *  armed delete, the dry-run result — belongs to one source only. */
  const [epoch, setEpoch] = useState(0);
  const [picking, setPicking] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const refreshStatus = useCallback(async () => {
    setStatus(await readSourcesStatus());
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const text = await readSourcesFile();
        const parsed = parseSourcesFile(text);
        if (!alive) return;
        setFile(parsed.file);
        setProblem(parsed.problem);
        setExists(text !== null);
        setDraft(parsed.file.sources);
        setBaseline(serializeSourcesFile(parsed.file));
        setSel(parsed.file.sources.length > 0 ? 0 : -1);
        setPhase('ready');
        const last = await readSourcesStatus();
        if (alive) setStatus(last);
      } catch (err) {
        if (!alive) return;
        setLoadError(messageOf(err));
        setPhase('failed');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const text = useMemo(() => serializeSourcesFile({ ...file, sources: draft }), [file, draft]);
  const dirty = phase === 'ready' && text !== baseline;

  const errors = useMemo(
    () => draft.map((src, i) => validateSource(src, draft.filter((_, j) => j !== i))),
    [draft],
  );
  const firstBad = errors.findIndex((e) => Object.keys(e).length > 0);

  const localPaths = useMemo(() => {
    const set = new Set(workspaces);
    if (activeWorkspace !== '') set.add(activeWorkspace);
    // A source may point at a directory the app no longer lists; the picker
    // would show it as "the workspace on screen" and the file would say
    // otherwise.
    for (const src of draft) {
      const ws = src.emit?.workspace;
      if (ws?.kind === 'local') set.add(ws.path);
    }
    return [...set];
  }, [workspaces, activeWorkspace, draft]);
  const remoteLabels = useMemo(
    () => new Map(remoteWorkspaces.map((entry) => [entry.id, entry.label])),
    [remoteWorkspaces],
  );

  function select(index: number): void {
    setSel(index);
    setPicking(false);
    setEpoch((n) => n + 1);
  }

  function addSource(kind: ProbeKind): void {
    const next = emptySource(kind, draft.map((s) => s.id));
    setDraft([...draft, next]);
    setSaved(false);
    select(draft.length);
  }

  function editSelected(fn: (src: SourceConfig) => SourceConfig): void {
    setDraft((list) => list.map((src, i) => (i === sel ? fn(src) : src)));
    setSaved(false);
    setNote(null);
  }

  function removeSelected(): void {
    const next = draft.filter((_, i) => i !== sel);
    setDraft(next);
    setSaved(false);
    select(Math.min(sel, next.length - 1));
  }

  function toggleEnabled(index: number): void {
    setDraft((list) =>
      list.map((src, i) => (i === index ? setSourceField(src, 'enabled', src.enabled === false) : src)),
    );
    setSaved(false);
  }

  async function save(): Promise<void> {
    if (problem !== null || saving) return;
    if (firstBad >= 0) {
      setShowErrors(true);
      if (firstBad !== sel) select(firstBad);
      setNote({ tone: 'error', text: t('ticket.sources.fixFirst') });
      return;
    }
    setSaving(true);
    setNote(null);
    try {
      await writeSourcesFile(text);
      setBaseline(text);
      setExists(true);
      setSaved(true);
      void refreshStatus();
    } catch (err) {
      setNote({ tone: 'error', text: t('ticket.sources.saveFailed', { reason: messageOf(err) }) });
    } finally {
      setSaving(false);
    }
  }

  async function openFile(): Promise<void> {
    try {
      const path = await readSourcesPath();
      if (path === null) return;
      // The plugin directly: the file is this app's own configuration, not a
      // path a model wrote, so the workspace-boundary check that
      // `deliverable_open` adds has nothing to guard here.
      const mod = await import('@tauri-apps/plugin-opener');
      await mod.openPath(path);
    } catch (err) {
      setNote({ tone: 'error', text: t('ticket.sources.openFailed', { error: messageOf(err) }) });
    }
  }

  function requestClose(): void {
    if (dirty && !saving) setConfirmDiscard(true);
    else onClose();
  }

  const editable = phase === 'ready' && problem === null;
  const current = sel >= 0 && sel < draft.length ? draft[sel] : null;

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content
          className="dialog dialog-wide tkb-src-dialog"
          onEscapeKeyDown={(event) => {
            // Esc belongs to an open dropdown first, the way `PanelHost` does it.
            if (selectMenuIsOpen()) event.preventDefault();
          }}
        >
          <div className="dialog-head">
            <div className="grow">
              <DialogPrimitive.Title className="dialog-title">{t('ticket.sources.title')}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="dialog-desc">
                {t('ticket.sources.desc')}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <button type="button" className="btn btn-ghost btn-compact" aria-label={t('common.close')}>
                <X size={14} />
              </button>
            </DialogPrimitive.Close>
          </div>

          <div className="dialog-body tkb-src-body">
            {phase === 'loading' ? <p className="tkb-src-empty">{t('ticket.sources.loading')}</p> : null}
            {phase === 'failed' ? (
              <p className="tkb-form-rule" role="alert">
                {t('ticket.sources.loadFailed', { error: loadError })}
              </p>
            ) : null}
            {phase === 'ready' ? (
              <>
                <nav className="tkb-src-side" aria-label={t('ticket.sources.list')}>
                  <div className="tkb-src-side-head">
                    <span className="tkb-src-side-title">{t('ticket.sources.list')}</span>
                    <button
                      type="button"
                      className="btn btn-outline btn-compact"
                      disabled={!editable}
                      onClick={() => {
                        setPicking(true);
                        setSel(-1);
                      }}
                    >
                      <Plus size={13} />
                      {t('ticket.sources.new')}
                    </button>
                  </div>
                  {draft.length === 0 ? <p className="tkb-src-empty">{t('ticket.sources.empty')}</p> : null}
                  <ul className="tkb-src-list">
                    {draft.map((src, i) => {
                      const kind = kindOf(src);
                      const line = statusLine(t, src, status[src.id]);
                      const name = src.name !== undefined && src.name !== '' ? src.name : src.id;
                      const bad = showErrors && Object.keys(errors[i] ?? {}).length > 0;
                      return (
                        <li key={i} className={`tkb-src-item${i === sel ? ' is-selected' : ''}`}>
                          <button
                            type="button"
                            className="tkb-src-item-main"
                            aria-current={i === sel ? 'true' : undefined}
                            disabled={!editable}
                            onClick={() => select(i)}
                          >
                            <span className="tkb-src-item-name">
                              {bad ? (
                                <AlertTriangle size={12} aria-label={t('ticket.sources.needsAttention')} />
                              ) : null}
                              {name === '' ? t('ticket.sources.field.id') : name}
                            </span>
                            <span className="tkb-src-item-kind">
                              {kind !== null ? t(kindLabelKey(kind)) : String(src.probe?.kind ?? '')}
                            </span>
                            <span className={`tkb-src-item-status${line.bad ? ' is-bad' : ''}`} title={line.text}>
                              {line.text}
                            </span>
                          </button>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={src.enabled !== false}
                            aria-label={t('ticket.sources.enable', { name })}
                            disabled={!editable}
                            className={`tk-switch${src.enabled !== false ? ' is-on' : ''}`}
                            onClick={() => toggleEnabled(i)}
                          >
                            <span className="tk-switch-knob" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </nav>

                <div className="tkb-src-pane">
                  {problem !== null ? (
                    <p className="tkb-form-rule" role="alert">
                      {t(`ticket.sources.problem.${problem.code}` as TKey, { detail: problem.detail })}
                    </p>
                  ) : null}
                  {picking && editable ? (
                    <KindPicker onPick={addSource} />
                  ) : current !== null && editable ? (
                    <SourceEditor
                      key={epoch}
                      src={current}
                      errors={errors[sel] ?? {}}
                      showErrors={showErrors}
                      localPaths={localPaths}
                      remoteLabels={remoteLabels}
                      onEdit={editSelected}
                      onShowErrors={() => setShowErrors(true)}
                      onDelete={removeSelected}
                    />
                  ) : problem === null ? (
                    <p className="tkb-src-empty">{t('ticket.sources.newHint')}</p>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>

          <div className="dialog-foot">
            {confirmDiscard ? (
              <>
                <span className="cfg-status cfg-status-pending" role="alert">
                  {t('ticket.sources.discard.ask')}
                </span>
                <span className="grow" />
                <button type="button" className="btn btn-outline" onClick={() => setConfirmDiscard(false)}>
                  {t('ticket.sources.discard.keep')}
                </button>
                <button type="button" className="btn btn-destructive" onClick={onClose}>
                  {t('ticket.sources.discard.confirm')}
                </button>
              </>
            ) : (
              <>
                <Tip label={exists ? t('ticket.sources.openFileHint') : t('ticket.sources.openFileUnsaved')}>
                  <span className="tkb-src-open">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={!exists}
                      onClick={() => void openFile()}
                    >
                      <FileText size={13} />
                      {t('ticket.sources.openFile')}
                    </button>
                  </span>
                </Tip>
                <span className="cfg-status">
                  {note !== null ? (
                    <span
                      className={note.tone === 'error' ? 'cfg-status-error' : undefined}
                      role={note.tone === 'error' ? 'alert' : 'status'}
                    >
                      {note.text}
                    </span>
                  ) : dirty ? (
                    <span className="cfg-status-pending">{t('ticket.sources.unsaved')}</span>
                  ) : saved ? (
                    <span className="cfg-status-ok" role="status">
                      {t('ticket.sources.saved')}
                    </span>
                  ) : null}
                </span>
                <span className="grow" />
                <button type="button" className="btn btn-outline" onClick={requestClose}>
                  {t('common.close')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!editable || !dirty || saving}
                  onClick={() => void save()}
                >
                  {saving ? t('ticket.sources.saving') : t('ticket.sources.save')}
                </button>
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* ============================================================
   Choosing a kind
   ============================================================ */

function KindPicker({ onPick }: { onPick: (kind: ProbeKind) => void }) {
  const t = useT();
  return (
    <section className="tkb-fgroup" aria-labelledby="tkb-src-kinds">
      <div className="tkb-fgroup-head">
        <h3 className="tkb-fgroup-title" id="tkb-src-kinds">
          {t('ticket.sources.newTitle')}
        </h3>
        <span className="tkb-fgroup-hint">{t('ticket.sources.newHint')}</span>
      </div>
      <ul className="tkb-src-kinds">
        {PROBE_KINDS.map((kind) => (
          <li key={kind}>
            <button type="button" className="tkb-src-kind" onClick={() => onPick(kind)}>
              <span className="tkb-src-kind-name">{t(kindLabelKey(kind))}</span>
              <span className="tkb-src-kind-hint">{t(kindHintKey(kind))}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ============================================================
   One field: label, control, hint, and the reason it is wrong
   ============================================================ */

function describedBy(id: string, error: string | null): string {
  return error !== null ? `${id}-hint ${id}-err` : `${id}-hint`;
}

function Field({
  id,
  label,
  required = false,
  hint,
  error,
  wide = false,
  group = false,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  error: string | null;
  wide?: boolean;
  /** For a control that is not one input (the pickers): the label names a group. */
  group?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const mark = required ? (
    <>
      <span className="cfg-required" aria-hidden>
        *
      </span>
      <span className="sr-only">{t('ticket.required')}</span>
    </>
  ) : null;
  return (
    <div
      className={`cfg-field${wide ? ' tkb-src-wide' : ''}`}
      role={group ? 'group' : undefined}
      aria-labelledby={group ? `${id}-label` : undefined}
    >
      {group ? (
        <span className="cfg-label" id={`${id}-label`}>
          {label}
          {mark}
        </span>
      ) : (
        <label className="cfg-label" id={`${id}-label`} htmlFor={id}>
          {label}
          {mark}
        </label>
      )}
      {children}
      {hint !== undefined ? (
        <span className="cfg-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error !== null ? (
        <p className="tkb-form-rule" id={`${id}-err`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A textarea that keeps what was typed. The stored value is the parsed JSON,
 *  and printing it back on every keystroke would reflow the box under the
 *  caret, so the text lives here and only the parse goes up. */
function JsonBox({
  id,
  value,
  placeholder,
  invalid,
  describedById,
  onChange,
}: {
  id: string;
  value: unknown;
  placeholder?: string;
  invalid: boolean;
  describedById: string;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(() => jsonParamText(value));
  return (
    <textarea
      id={id}
      className="cfg-textarea mono"
      rows={3}
      value={text}
      spellCheck={false}
      placeholder={placeholder}
      aria-invalid={invalid}
      aria-describedby={describedById}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseJsonParam(e.target.value));
      }}
    />
  );
}

function displayText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function ParamControl({
  spec,
  value,
  error,
  onChange,
}: {
  spec: ParamSpec;
  value: unknown;
  error: string | null;
  onChange: (value: unknown) => void;
}) {
  const t = useT();
  const id = `tkb-src-p-${spec.key}`;
  const label = t(spec.labelKey);
  const hint = t(spec.hintKey);
  const common = {
    id,
    'aria-invalid': error !== null,
    'aria-describedby': describedBy(id, error),
  } as const;
  const defaultText = typeof spec.default === 'string' ? spec.default : undefined;

  switch (spec.type) {
    case 'bool':
      return (
        <div className="cfg-field">
          <label className="cfg-check">
            <input
              type="checkbox"
              checked={typeof value === 'boolean' ? value : spec.default === true}
              aria-describedby={describedBy(id, error)}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span>{label}</span>
          </label>
          <span className="cfg-hint" id={`${id}-hint`}>
            {hint}
          </span>
          {error !== null ? (
            <p className="tkb-form-rule" id={`${id}-err`} role="alert">
              {error}
            </p>
          ) : null}
        </div>
      );
    case 'select': {
      const options = (spec.options ?? []).map((v) => ({
        value: v,
        label: t(`ticket.sources.opt.${v}` as TKey),
      }));
      return (
        <Field id={id} label={label} required={spec.required} hint={hint} error={error}>
          <Select
            id={id}
            value={typeof value === 'string' ? value : (defaultText ?? null)}
            options={options}
            onChange={onChange}
          />
        </Field>
      );
    }
    case 'number':
      return (
        <Field id={id} label={label} required={spec.required} hint={hint} error={error}>
          <input
            {...common}
            className="cfg-input"
            inputMode="numeric"
            value={numberText(value)}
            placeholder={spec.default !== undefined ? String(spec.default) : spec.placeholder}
            onChange={(e) => onChange(parseNumberInput(e.target.value))}
          />
        </Field>
      );
    case 'json':
      return (
        <Field id={id} label={label} required={spec.required} hint={hint} error={error} wide>
          <JsonBox
            id={id}
            value={value}
            placeholder={spec.placeholder}
            invalid={error !== null}
            describedById={describedBy(id, error)}
            onChange={onChange}
          />
        </Field>
      );
    case 'list':
    case 'text':
      if (spec.multiline) {
        return (
          <Field id={id} label={label} required={spec.required} hint={hint} error={error} wide>
            <textarea
              {...common}
              className="cfg-textarea mono"
              rows={3}
              spellCheck={false}
              value={displayText(value)}
              placeholder={spec.placeholder}
              onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
            />
          </Field>
        );
      }
      return (
        <Field id={id} label={label} required={spec.required} hint={hint} error={error}>
          <input
            {...common}
            className="cfg-input"
            spellCheck={false}
            value={spec.type === 'list' ? listText(value) : displayText(value)}
            placeholder={spec.placeholder ?? defaultText}
            onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          />
        </Field>
      );
  }
}

/** The filter as `path = glob` rows. The rows are local state because a blank
 *  row is not part of the object it produces. */
function FilterRows({
  filter,
  onChange,
}: {
  filter: unknown;
  onChange: (filter: Record<string, string> | undefined) => void;
}) {
  const t = useT();
  const [rows, setRows] = useState<FilterRow[]>(() => filterToRows(filter));
  function commit(next: FilterRow[]): void {
    setRows(next);
    onChange(rowsToFilter(next));
  }
  return (
    <div className="tkb-src-filter">
      {rows.map((row, i) => (
        <div className="tkb-src-filter-row" key={i}>
          <input
            className="cfg-input mono"
            value={row.path}
            spellCheck={false}
            placeholder="fields.title"
            aria-label={t('ticket.sources.filter.path')}
            onChange={(e) => commit(rows.map((r, j) => (j === i ? { ...r, path: e.target.value } : r)))}
          />
          <input
            className="cfg-input mono"
            value={row.glob}
            spellCheck={false}
            placeholder="*fix*"
            aria-label={t('ticket.sources.filter.glob')}
            onChange={(e) => commit(rows.map((r, j) => (j === i ? { ...r, glob: e.target.value } : r)))}
          />
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-compact"
            aria-label={t('ticket.sources.filter.remove')}
            onClick={() => commit(rows.filter((_, j) => j !== i))}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="btn btn-ghost btn-compact"
          onClick={() => setRows([...rows, { path: '', glob: '' }])}
        >
          <Plus size={13} />
          {t('ticket.sources.filter.add')}
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   The editor
   ============================================================ */

type ProbeRun =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'done'; result: ProbeResult }
  | { state: 'error'; message: string };

function SourceEditor({
  src,
  errors,
  showErrors,
  localPaths,
  remoteLabels,
  onEdit,
  onShowErrors,
  onDelete,
}: {
  src: SourceConfig;
  errors: SourceErrors;
  showErrors: boolean;
  localPaths: string[];
  remoteLabels: Map<string, string>;
  onEdit: (fn: (src: SourceConfig) => SourceConfig) => void;
  onShowErrors: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const kind = kindOf(src);
  const spec = kind !== null ? PROBE_SPECS[kind] : null;
  const [armed, setArmed] = useState(false);
  const [run, setRun] = useState<ProbeRun>({ state: 'idle' });

  // The id is shown wrong at once (it is what the person just typed); the other
  // fields wait for the first Save or Dry run, so a new source is not drawn as a
  // wall of red before anyone has had a chance to fill it in.
  const errorOf = (field: string, paramSpec?: ParamSpec): string | null => {
    const code = errors[field];
    if (code === undefined || (!showErrors && field !== 'id')) return null;
    return errorMessage(t, field, code, paramSpec);
  };

  const emit = src.emit ?? {};
  const on: readonly SourceEvent[] = Array.isArray(src.on) ? src.on : DEFAULT_ON;
  const ws: TaskWorkspaceRef = emit.workspace ?? { kind: 'active' };
  const probeBlocked = Object.keys(errors).some((k) => k === 'kind' || k.startsWith('probe.'));

  async function dryRun(): Promise<void> {
    if (probeBlocked) {
      onShowErrors();
      return;
    }
    setRun({ state: 'running' });
    try {
      setRun({ state: 'done', result: await probeSource(JSON.stringify(src)) });
    } catch (err) {
      setRun({ state: 'error', message: messageOf(err) });
    }
  }

  function toggleEvent(event: SourceEvent, checked: boolean): void {
    const next = SOURCE_EVENTS.filter((e) => (e === event ? checked : on.includes(e)));
    onEdit((s) => setSourceField(s, 'on', next));
  }

  const normal = spec?.fields.filter((f) => f.advanced !== true) ?? [];
  const advanced = spec?.fields.filter((f) => f.advanced === true) ?? [];
  const advancedSet = advanced.some((f) => src.probe[f.key] !== undefined);

  const text = (field: 'thread' | 'title' | 'url', placeholder?: string) => {
    const id = `tkb-src-e-${field}`;
    return (
      <Field
        id={id}
        label={t(`ticket.sources.field.${field}` as TKey)}
        hint={t(`ticket.sources.field.${field}.hint` as TKey)}
        error={null}
        wide
      >
        <input
          id={id}
          className="cfg-input mono"
          spellCheck={false}
          value={typeof emit[field] === 'string' ? emit[field] : ''}
          placeholder={placeholder}
          aria-describedby={`${id}-hint`}
          onChange={(e) => onEdit((s) => setEmitField(s, field, e.target.value === '' ? undefined : e.target.value))}
        />
      </Field>
    );
  };

  return (
    <div className="tkb-src-editor">
      <section className="tkb-fgroup" aria-labelledby="tkb-src-basic">
        <div className="tkb-fgroup-head">
          <h3 className="tkb-fgroup-title" id="tkb-src-basic">
            {t('ticket.sources.section.basic')}
          </h3>
          <span className="tkb-fgroup-hint">{t('ticket.sources.section.basicHint')}</span>
        </div>
        <div className="tkb-src-grid">
          <Field
            id="tkb-src-id"
            label={t('ticket.sources.field.id')}
            required
            hint={t('ticket.sources.field.id.hint')}
            error={errorOf('id')}
          >
            <input
              id="tkb-src-id"
              className="cfg-input mono"
              spellCheck={false}
              value={src.id}
              aria-invalid={errorOf('id') !== null}
              aria-describedby={describedBy('tkb-src-id', errorOf('id'))}
              onChange={(e) => onEdit((s) => setSourceField(s, 'id', e.target.value))}
            />
          </Field>
          <Field
            id="tkb-src-name"
            label={t('ticket.sources.field.name')}
            hint={t('ticket.sources.field.name.hint')}
            error={null}
          >
            <input
              id="tkb-src-name"
              className="cfg-input"
              value={typeof src.name === 'string' ? src.name : ''}
              placeholder={src.id}
              aria-describedby="tkb-src-name-hint"
              onChange={(e) => onEdit((s) => setSourceField(s, 'name', e.target.value === '' ? undefined : e.target.value))}
            />
          </Field>
          <Field
            id="tkb-src-kind"
            label={t('ticket.sources.field.kind')}
            error={null}
          >
            <input
              id="tkb-src-kind"
              className="cfg-input"
              readOnly
              value={kind !== null ? t(kindLabelKey(kind)) : String(src.probe?.kind ?? '')}
            />
          </Field>
        </div>
        <SwitchRow
          label={t('ticket.sources.field.enabled')}
          hint={t('ticket.sources.field.enabled.hint')}
          checked={src.enabled !== false}
          onChange={(value) => onEdit((s) => setSourceField(s, 'enabled', value))}
        />
      </section>

      {spec === null ? (
        <p className="tkb-form-rule" role="alert">
          {t('ticket.sources.unknownKind', { kind: String(src.probe?.kind ?? '') })}
        </p>
      ) : (
        <section className="tkb-fgroup" aria-labelledby="tkb-src-probe">
          <div className="tkb-fgroup-head">
            <h3 className="tkb-fgroup-title" id="tkb-src-probe">
              {t('ticket.sources.section.probe')}
            </h3>
            <span className="tkb-fgroup-hint">{t(kindHintKey(kind as ProbeKind))}</span>
          </div>
          <div className="tkb-src-grid">
            {normal.map((field) => (
              <ParamControl
                key={field.key}
                spec={field}
                value={src.probe[field.key]}
                error={errorOf(`probe.${field.key}`, field)}
                onChange={(value) => onEdit((s) => setProbeParam(s, field.key, value))}
              />
            ))}
          </div>
          {advanced.length > 0 ? (
            <details className="tkb-src-adv" open={advancedSet || undefined}>
              <summary>{t('ticket.sources.advanced')}</summary>
              <div className="tkb-src-grid">
                {advanced.map((field) => (
                  <ParamControl
                    key={field.key}
                    spec={field}
                    value={src.probe[field.key]}
                    error={errorOf(`probe.${field.key}`, field)}
                    onChange={(value) => onEdit((s) => setProbeParam(s, field.key, value))}
                  />
                ))}
              </div>
            </details>
          ) : null}
        </section>
      )}

      <section className="tkb-fgroup" aria-labelledby="tkb-src-detect">
        <div className="tkb-fgroup-head">
          <h3 className="tkb-fgroup-title" id="tkb-src-detect">
            {t('ticket.sources.section.detect')}
          </h3>
          <span className="tkb-fgroup-hint">{t('ticket.sources.section.detectHint')}</span>
        </div>
        <div className="tkb-src-grid">
          <Field
            id="tkb-src-on"
            label={t('ticket.sources.field.on')}
            hint={t('ticket.sources.field.on.hint')}
            error={errorOf('on')}
            group
            wide
          >
            <div className="tkb-src-events">
              {SOURCE_EVENTS.map((event) => (
                <label className="cfg-check" key={event}>
                  <input
                    type="checkbox"
                    checked={on.includes(event)}
                    aria-describedby="tkb-src-on-hint"
                    onChange={(e) => toggleEvent(event, e.target.checked)}
                  />
                  <span>{t(`ticket.sources.event.${event}` as TKey)}</span>
                </label>
              ))}
            </div>
          </Field>
          <Field
            id="tkb-src-filter"
            label={t('ticket.sources.field.filter')}
            hint={t('ticket.sources.field.filter.hint')}
            error={errorOf('filter')}
            group
            wide
          >
            <FilterRows filter={src.filter} onChange={(filter) => onEdit((s) => setSourceField(s, 'filter', filter))} />
          </Field>
          <Field
            id="tkb-src-initial"
            label={t('ticket.sources.field.initial')}
            hint={t('ticket.sources.field.initial.hint')}
            error={errorOf('initial')}
          >
            <Select
              id="tkb-src-initial"
              value={src.initial ?? 'baseline'}
              options={[
                { value: 'baseline', label: t('ticket.sources.opt.baseline') },
                { value: 'emit', label: t('ticket.sources.opt.emit') },
              ]}
              onChange={(value) => onEdit((s) => setSourceField(s, 'initial', value))}
            />
          </Field>
          <Field
            id="tkb-src-limit"
            label={t('ticket.sources.field.limit')}
            hint={t('ticket.sources.field.limit.hint')}
            error={errorOf('limit')}
          >
            <input
              id="tkb-src-limit"
              className="cfg-input"
              inputMode="numeric"
              value={numberText(src.limit)}
              placeholder={String(DEFAULT_LIMIT)}
              aria-invalid={errorOf('limit') !== null}
              aria-describedby={describedBy('tkb-src-limit', errorOf('limit'))}
              onChange={(e) => onEdit((s) => setSourceField(s, 'limit', parseNumberInput(e.target.value)))}
            />
          </Field>
        </div>
      </section>

      <section className="tkb-fgroup" aria-labelledby="tkb-src-emit">
        <div className="tkb-fgroup-head">
          <h3 className="tkb-fgroup-title" id="tkb-src-emit">
            {t('ticket.sources.section.emit')}
          </h3>
        </div>
        <div className="tkb-src-grid">
          {text('thread', DEFAULT_THREAD_TEMPLATE)}
          {text('title')}
          <Field
            id="tkb-src-e-brief"
            label={t('ticket.sources.field.brief')}
            required
            hint={t('ticket.sources.field.brief.hint')}
            error={errorOf('brief')}
            wide
          >
            <textarea
              id="tkb-src-e-brief"
              className="cfg-textarea mono"
              rows={4}
              spellCheck={false}
              value={typeof emit.brief === 'string' ? emit.brief : ''}
              aria-invalid={errorOf('brief') !== null}
              aria-describedby={describedBy('tkb-src-e-brief', errorOf('brief'))}
              onChange={(e) => onEdit((s) => setEmitField(s, 'brief', e.target.value))}
            />
          </Field>
          {text('url')}
          <Field id="tkb-src-e-ws" label={t('panel.task.field.workspace')} error={null} group>
            <WorkspacePicker
              value={ws}
              localPaths={localPaths}
              remoteLabels={remoteLabels}
              onChange={(next) => onEdit((s) => setEmitField(s, 'workspace', next))}
            />
          </Field>
          <Field id="tkb-src-e-model" label={t('panel.task.field.model')} error={null} group>
            <ModelPicker
              value={typeof emit.model === 'string' ? emit.model : ''}
              onChange={(model) => onEdit((s) => setEmitField(s, 'model', model))}
            />
          </Field>
        </div>
        <p className="cfg-hint">{t('ticket.sources.templateHint')}</p>
      </section>

      <div className="tkb-src-actions">
        <Tip label={t('ticket.sources.dryRunHint')}>
          <button
            type="button"
            className="btn btn-outline btn-compact"
            disabled={spec === null || run.state === 'running'}
            onClick={() => void dryRun()}
          >
            <FlaskConical size={13} />
            {run.state === 'running' ? t('ticket.sources.dryRunning') : t('ticket.sources.dryRun')}
          </button>
        </Tip>
        <span className="grow" />
        <button
          type="button"
          className={`btn btn-ghost btn-compact cfg-danger${armed ? ' is-armed' : ''}`}
          onClick={() => {
            if (armed) onDelete();
            else setArmed(true);
          }}
          onBlur={() => setArmed(false)}
        >
          <Trash2 size={13} />
          {armed ? t('ticket.sources.deleteConfirm') : t('ticket.sources.delete')}
        </button>
      </div>

      <ProbeOutput run={run} />
    </div>
  );
}

function ProbeOutput({ run }: { run: ProbeRun }) {
  const t = useT();
  if (run.state === 'error') {
    return (
      <p className="tkb-form-rule" role="alert">
        {t('ticket.sources.probe.failed', { error: run.message })}
      </p>
    );
  }
  if (run.state !== 'done') return null;
  const { result } = run;
  if (!result.ok) {
    return (
      <p className="tkb-form-rule" role="alert">
        {t('ticket.sources.probe.failed', { error: result.error ?? '' })}
      </p>
    );
  }
  const shown = result.items.slice(0, MAX_PROBE_ROWS);
  const names = shown[0]?.fields !== undefined ? Object.keys(shown[0].fields) : [];
  return (
    <div className="tkb-src-probe" role="status">
      <p className="tkb-src-probe-sum">
        {result.total === 0
          ? t('ticket.sources.probe.none')
          : result.total > shown.length
            ? t('ticket.sources.probe.foundFirst', { total: result.total, n: shown.length })
            : t('ticket.sources.probe.found', { total: result.total })}
      </p>
      {result.error !== null && result.error !== '' ? (
        <p className="tkb-form-rule">{result.error}</p>
      ) : null}
      {shown.length > 0 ? (
        <table className="tkb-src-probe-table">
          <caption className="sr-only">{t('ticket.sources.probe.list')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('ticket.sources.probe.key')}</th>
              <th scope="col">{t('ticket.sources.probe.version')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((item, i) => (
              <tr key={`${item.key}-${i}`}>
                <td className="mono">{item.key}</td>
                <td className="mono">{item.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {names.length > 0 ? (
        <p className="cfg-hint">{t('ticket.sources.probe.fields', { names: names.join(', ') })}</p>
      ) : null}
    </div>
  );
}
