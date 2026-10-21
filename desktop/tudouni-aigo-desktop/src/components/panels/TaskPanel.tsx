import { useEffect, useMemo, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Folder,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Sparkles,
  SquareTerminal,
  Trash2,
  Wand2,
  X,
  Zap,
} from 'lucide-react';
import {
  activeRuntime,
  activeWorkspaceOf,
  NO_MODEL_ROWS,
  selectLiveSessionIdsKey,
  selectRunInFlight,
  selectTaskRunStatusKey,
  useApp,
  useSessionField,
} from '@/state/store';
import { useT } from '@/i18n/useT';
import { baseName, formatClock, formatDuration } from '@/utils/format';
import {
  canRunTask,
  emptyTask,
  refineAvailability,
  refineRunScope,
  REFINE_LAST_N,
  runDay,
  taskProblems,
  taskRunOutcome,
  workspaceRefLabel,
  type RunDay,
  type RunScope,
  type Task,
  type TaskRunLink,
  type TaskWorkspaceRef,
} from '@/task/tasks';
import { Info, PanelInfo, Tip } from '@/components/ui/kit';
import { PanelBody } from './PanelShell';

/**
 * Task templates: the desktop's repeatable session launchers.
 *
 * **Three surfaces, one dialog.** The shelf (every template), the history
 * (every run they produced) and the editor (one template's fields) are three
 * states of one panel rather than three screens — the same reason the library
 * is two tabs in one panel: they are views of one fact, and a second dialog
 * would make "which one is on top" a question the person has to answer.
 *
 * **The layout is the design's; the parts are the app's.** A row's shape
 * (leading mark, name, description, workspace · model, a fixed action slot at
 * the right edge) comes from the task design; the tokens it is built from —
 * `--bg-card`, `--border-subtle`, `--radius-lg`, `.btn`, `.badge` — come from
 * the design system every other panel already wears. Inventing a second
 * vocabulary for "a row" or "a field" is how a panel starts reading as a
 * different application.
 *
 * **Actions sit in a fixed position.** Per the design's states sheet, the
 * right-hand slot does not move: Run surfaces on hover **in the space the
 * overflow button already occupies**, so nothing in the row shifts and the eye
 * never has to hunt for it. A running task puts its progress bar in that same
 * slot rather than replacing the row's contents; a disabled one leaves the slot
 * to the overflow button alone.
 *
 * **Run is not a new protocol.** It is the store's `runTask`, which opens a
 * session the ordinary way and sends the prompt as its first message — the same
 * two steps `startLearning` established.
 *
 * **History never re-derives state.** Each link froze the task's name and model
 * at start time (the design: history reflects what *was*), its outcome was
 * written down once by the reducer while the transcript that decided it still
 * existed (`noteTaskRunOutcome` — see `TaskRunLink.outcome` for why that is
 * recorded rather than recomputed), and its live status reads the session's own
 * bucket. Opening prefers the live child (a `focus`, which sends nothing) and
 * falls back to the saved id, the way the rail itself opens a session.
 */
export function TaskPanel() {
  const t = useT();
  const tasks = useApp((s) => s.tasks);
  const taskRuns = useApp((s) => s.taskRuns);
  const upsertTask = useApp((s) => s.upsertTask);
  const deleteTask = useApp((s) => s.deleteTask);
  const clearTaskRuns = useApp((s) => s.clearTaskRuns);
  const runTask = useApp((s) => s.runTask);
  const workspaces = useApp((s) => s.workspaces);
  const remoteWorkspaces = useApp((s) => s.remoteWorkspaces);

  const workspace = useApp(activeWorkspaceOf);
  const rt = useApp(activeRuntime);
  const remoteWorkspaceId = rt?.remoteWorkspaceId ?? null;

  /**
   * Which surface is up, and which template the editor holds.
   *
   * History carries no task id on purpose: the design's history is a list of
   * **runs across every template**, with its own title and back button. It is
   * not one task's log — deleting a template keeps its runs (see `deleteTask`),
   * and a log reachable only through a template would make those runs
   * unreachable the moment the template went away.
   */
  const [surface, setSurface] = useState<'list' | 'history'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  // The refine form's own surface, like the editor's: it holds the scope
  // choice and the focus, and its Start is the only door into `refineTask`.
  const [refineId, setRefineId] = useState<string | null>(null);

  const editing = editingId !== null ? (tasks.find((row) => row.id === editingId) ?? null) : null;
  const refining = refineId !== null ? (tasks.find((row) => row.id === refineId) ?? null) : null;

  const localPaths = useMemo(() => {
    const set = new Set(workspaces);
    if (workspace !== '') set.add(workspace);
    return [...set];
  }, [workspaces, workspace]);

  const remoteLabels = useMemo(
    () => new Map(remoteWorkspaces.map((entry) => [entry.id, entry.label])),
    [remoteWorkspaces],
  );

  /** Resolve a ref the way Run will, and say what it names. `null` is
   *  "names something this window no longer knows" — shown, and refused. */
  const labelOf = (ref: TaskWorkspaceRef): string | null =>
    workspaceRefLabel(ref, workspace, localPaths, remoteLabels);

  function startNew() {
    // The workspace field pre-selects the screen's own workspace when there is
    // one, and a remote screen pre-selects **its** ref: a Run from a remote
    // screen should default to running there, exactly like "New session" does.
    const task = emptyTask(Date.now());
    if (remoteWorkspaceId !== null) task.workspace = { kind: 'remote', id: remoteWorkspaceId };
    upsertTask(task);
    setEditingId(task.id);
  }

  function duplicate(task: Task) {
    const copy = emptyTask(Date.now());
    upsertTask({
      ...task,
      id: copy.id,
      name: t('panel.task.copyName', { name: task.name }),
      createdAtMs: copy.createdAtMs,
      updatedAtMs: copy.updatedAtMs,
    });
    setEditingId(copy.id);
  }

  if (editing !== null) {
    return (
      <TaskEditor
        key={editing.id}
        task={editing}
        localPaths={localPaths}
        remoteLabels={remoteLabels}
        onDone={(next) => {
          upsertTask(next);
          setEditingId(null);
        }}
        onCancel={() => {
          // A brand-new, untouched template is not worth leaving behind: "New
          // task" writes the row before the editor opens, so cancelling out of
          // one that was never typed into would leave blank shelf litter. Only
          // a row with nothing in it at all is discarded — anything typed keeps
          // it, which is what makes Esc safe to press.
          const untouched =
            editing.description.trim() === '' && editing.prompt.trim() === '';
          if (untouched) deleteTask(editing.id);
          setEditingId(null);
        }}
      />
    );
  }

  if (refining !== null) {
    return (
      <RefineDialog
        key={refining.id}
        task={refining}
        links={taskRuns.filter((row) => row.taskId === refining.id)}
        onBack={() => setRefineId(null)}
      />
    );
  }

  if (surface === 'history') {
    return <TaskHistory links={taskRuns} onBack={() => setSurface('list')} onClear={clearTaskRuns} />;
  }

  return (
    <TaskShelf
      tasks={tasks}
      links={taskRuns}
      labelOf={labelOf}
      onNew={startNew}
      onEdit={(id) => setEditingId(id)}
      onDuplicate={duplicate}
      onHistory={() => setSurface('history')}
      onRun={runTask}
      onRefine={(id) => setRefineId(id)}
    />
  );
}

/* ============================================================
   The shelf: every template, in the design's row shape.
   ============================================================ */

type ShelfFilter = 'all' | 'enabled' | 'disabled';

function TaskShelf({
  tasks,
  links,
  labelOf,
  onNew,
  onEdit,
  onDuplicate,
  onHistory,
  onRun,
  onRefine,
}: {
  tasks: Task[];
  links: TaskRunLink[];
  labelOf: (ref: TaskWorkspaceRef) => string | null;
  onNew: () => void;
  onEdit: (id: string) => void;
  onDuplicate: (task: Task) => void;
  onHistory: () => void;
  /** Resolves to the child key the run landed in, or `null` when nothing was
   *  started — the store's own contract, which the row's error line reads. */
  onRun: (id: string) => Promise<string | null>;
  onRefine: (id: string) => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState<ShelfFilter>('all');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const workspace = useApp(activeWorkspaceOf);
  const screenIsRemote = useApp((s) => s.activeKey !== null && s.sessions[s.activeKey]?.remoteWorkspaceId !== null);

  // Whether this window has anywhere at all to run a template. Used only to
  // disable Run with a reason: the store refuses an unresolvable ref silently,
  // and a button that looks available and does nothing is the worse failure.
  const noWorkspace = useApp(
    (s) => s.order.every((key) => (s.sessions[key]?.session?.workspace ?? s.sessions[key]?.workspace ?? '') === ''),
  );

  const counts = useMemo(
    () => ({
      all: tasks.length,
      enabled: tasks.filter((row) => row.enabled).length,
      disabled: tasks.filter((row) => !row.enabled).length,
    }),
    [tasks],
  );

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tasks.filter((row) => {
      if (filter === 'enabled' && !row.enabled) return false;
      if (filter === 'disabled' && row.enabled) return false;
      if (needle === '') return true;
      return (
        row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle)
      );
    });
  }, [tasks, filter, query]);

  return (
    <>
      <div className="dialog-head tk-head">
        <div className="grow">
          <DialogPrimitive.Title className="dialog-title tk-title">
            {t('panel.task.title')}
            <TaskInfo />
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="dialog-desc">
            {t('panel.task.note')}
          </DialogPrimitive.Description>
        </div>
        <button type="button" className="btn btn-outline" onClick={onHistory}>
          <Clock size={13} />
          {t('panel.task.history')}
        </button>
        <div className="tk-search">
          <Search size={13} className="tk-search-icon" />
          <input
            className="tk-search-input"
            value={query}
            spellCheck={false}
            placeholder={t('panel.task.search')}
            aria-label={t('panel.task.search')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button type="button" className="btn btn-primary" onClick={onNew}>
          <Plus size={13} />
          {t('panel.task.new')}
        </button>
      </div>

      <div className="tk-filters">
        <div className="tk-chips" role="tablist" aria-label={t('panel.task.title')}>
          {(['all', 'enabled', 'disabled'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={`tk-chip${filter === key ? ' is-on' : ''}`}
              onClick={() => setFilter(key)}
            >
              {t(`panel.task.filter.${key}`)}
              <span className="tk-chip-count">{counts[key]}</span>
            </button>
          ))}
        </div>
      </div>

      <PanelBody>
        {problem !== null ? (
          <p className="tk-problem" role="alert">
            {problem}
          </p>
        ) : null}

        {tasks.length === 0 ? (
          <div className="tk-blank">
            <SquareTerminal size={20} className="tk-blank-icon" />
            <div className="tk-blank-title">{t('panel.task.empty')}</div>
            <div className="tk-blank-hint">{t('panel.task.emptyHint')}</div>
          </div>
        ) : shown.length === 0 ? (
          <div className="tk-blank">
            <div className="tk-blank-title">{t('panel.task.noMatch')}</div>
            <div className="tk-blank-hint">{t('panel.task.noMatchHint')}</div>
          </div>
        ) : (
          <div className="tk-list">
            {shown.map((task) => {
              const label = labelOf(task.workspace);
              const available = label !== null;
              const missing = taskProblems(task);
              const runnable = canRunTask(task) && available && !noWorkspace;
              const blocked =
                missing.length > 0
                  ? missing.includes('name')
                    ? t('panel.task.problem.name')
                    : t('panel.task.problem.prompt')
                  : !available
                    ? t('panel.task.workspaceMissing')
                    : noWorkspace
                      ? t('panel.task.emptyHint')
                      : null;
              const runs = links.filter((row) => row.taskId === task.id);
              const busy = busyId === task.id;
              // Refine's gate, resolved the same way the store resolves it:
              // one function, so the tooltip the person reads and the refusal
              // the action would make cannot disagree about why.
              const refine = refineAvailability(task, runs, workspace, screenIsRemote);
              return (
                <TaskRow
                  key={task.id}
                  task={task}
                  label={label}
                  runs={runs}
                  busy={busy}
                  runnable={runnable}
                  blocked={blocked}
                  refineReason={refine.ok ? null : refine.reason}
                  onRun={() => {
                    setProblem(null);
                    setBusyId(task.id);
                    void onRun(task.id).then((key) => {
                      setBusyId((current) => (current === task.id ? null : current));
                      // `null` is the store's own "nothing was started": an
                      // unresolvable workspace, or an open the bridge refused.
                      // The panel says so rather than leaving a button that
                      // appeared to work.
                      if (key === null) setProblem(t('panel.task.workspaceMissing'));
                    });
                  }}
                  onEdit={() => onEdit(task.id)}
                  onDuplicate={() => onDuplicate(task)}
                  onRefine={() => onRefine(task.id)}
                />
              );
            })}
          </div>
        )}
      </PanelBody>
    </>
  );
}

/** One template. The whole row shape from the design, in one place. */
function TaskRow({
  task,
  label,
  runs,
  busy,
  runnable,
  blocked,
  refineReason,
  onRun,
  onEdit,
  onDuplicate,
  onRefine,
}: {
  task: Task;
  label: string | null;
  runs: TaskRunLink[];
  busy: boolean;
  runnable: boolean;
  blocked: string | null;
  /** Why Refine is refused for this row, or `null` when it is offered. */
  refineReason: 'no-runs' | 'remote' | 'other-workspace' | null;
  onRun: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onRefine: () => void;
}) {
  const t = useT();
  const deleteTask = useApp((s) => s.deleteTask);
  const upsertTask = useApp((s) => s.upsertTask);

  // The design's "Row · Running": a progress bar in the action slot, because a
  // run's own length is unknowable and a spinner in a row of other rows reads
  // as "this page is loading" rather than "this one task is working".
  //
  // Through a selector returning a **stable boolean**, not a `sessions`
  // subscription: a row is drawn for every template, and the naive version
  // re-renders all of them on every token of every session in the window.
  const runKeys = runs.map((link) => link.sessionKey);
  const running = useApp((s) => selectRunInFlight(s, runKeys));

  const newest = runs.length > 0 ? runs[runs.length - 1] : null;
  const failed = newest !== null && newest.outcome === 'failed';

  return (
    <div className={`tk-row${task.enabled ? '' : ' is-disabled'}`}>
      <span className="tk-mark" aria-hidden>
        <SquareTerminal size={15} />
      </span>

      <div className="tk-row-main">
        <div className="tk-row-title">
          <button type="button" className="tk-row-name" onClick={onEdit}>
            {task.name.trim() === '' ? t('panel.task.unnamed') : task.name}
          </button>
          {!task.enabled ? <span className="badge badge-neutral">{t('panel.task.disabled')}</span> : null}
          {task.autopilot === true ? (
            <span className="badge badge-neutral" title={t('panel.task.field.autopilotHint')}>
              {t('panel.task.autopilotBadge')}
            </span>
          ) : null}
          {label === null ? (
            <span className="badge badge-warning">{t('panel.task.workspaceMissing')}</span>
          ) : null}
        </div>

        {task.description.trim() !== '' ? (
          <div className="tk-row-desc">{task.description}</div>
        ) : null}

        <div className="tk-row-meta">
          <span className="tk-meta-item" title={label ?? undefined}>
            <Folder size={12} />
            {label === null ? t('panel.task.workspaceMissing') : baseName(label) || label}
          </span>
          <span className="tk-meta-item">
            <Sparkles size={12} />
            {task.model.trim() === '' ? t('panel.task.modelDefault') : task.model}
          </span>
          {/* The last run's verdict, when it was a failure. A caption rather
              than a badge, and it sits in the meta line with the workspace and
              model: those three answer "what is this task now", while the
              verdict is a fact about what *was*. A second badge beside the
              name would read as a property of the template — which it is
              not, and which is why the full ledger lives in History. */}
          {failed && !running ? (
            <span className="tk-meta-item tk-meta-failed">{t('panel.task.lastRunFailed')}</span>
          ) : null}
        </div>
      </div>

      <div className="tk-row-actions">
        {running ? (
          <span className="tk-running">
            <span className="tk-bar" aria-hidden>
              <span className="tk-bar-fill" />
            </span>
            <span className="tk-running-label">{t('panel.task.running')}</span>
          </span>
        ) : task.enabled ? (
          <Tip label={blocked ?? t('panel.task.runHint')}>
            {/* The wrapper keeps the design's fixed slot: a disabled button is
                still a button, and removing it would move the overflow menu. */}
            <button
              type="button"
              className="btn btn-primary tk-row-cta"
              disabled={!runnable || busy}
              onClick={onRun}
            >
              <Play size={12} />
              {t('panel.task.run')}
            </button>
          </Tip>
        ) : null}

        <TaskMenu
          enabled={task.enabled}
          refineReason={refineReason}
          onEdit={onEdit}
          onDuplicate={onDuplicate}
          onRefine={onRefine}
          onToggleEnabled={() => upsertTask({ ...task, enabled: !task.enabled })}
          onToggleAutopilot={() => upsertTask({ ...task, autopilot: task.autopilot !== true })}
          onDelete={() => deleteTask(task.id)}
        />
      </div>
    </div>
  );
}

/* ============================================================
   The overflow menu: edit, duplicate, enable/disable, delete.
   ============================================================ */

function TaskMenu({
  enabled,
  refineReason,
  onEdit,
  onDuplicate,
  onRefine,
  onToggleEnabled,
  onToggleAutopilot,
  onDelete,
}: {
  enabled: boolean;
  /** Why Refine is refused for this row, or `null` when it is offered. */
  refineReason: 'no-runs' | 'remote' | 'other-workspace' | null;
  onEdit: () => void;
  onDuplicate: () => void;
  onRefine: () => void;
  onToggleEnabled: () => void;
  onToggleAutopilot: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Delete keeps the two-press arm every other destructive control in this app
  // uses: the first press only arms, and the menu stays up to say so. Anything
  // else — the scrim, Escape, another row — closes the menu and disarms with
  // it, so a stray first press costs nothing.
  const [armed, setArmed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) setArmed(false);
  }, [open]);

  function close(): void {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  /** The sentence a disabled Refine stands behind: the reason for the
   *  refusal is the tooltip's job, next to the control it explains. */
  const refineBlocked =
    refineReason === 'no-runs'
      ? t('panel.task.refine.noRuns')
      : refineReason === 'remote'
        ? t('panel.task.refine.remote')
        : refineReason === 'other-workspace'
          ? t('panel.task.refine.otherWorkspace')
          : null;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="btn btn-ghost btn-icon tk-more"
          aria-label={t('panel.task.more')}
          aria-haspopup="menu"
        >
          <MoreHorizontal size={15} />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="tk-menu"
          align="end"
          sideOffset={6}
          aria-label={t('panel.task.more')}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <button type="button" role="menuitem" className="tk-menu-item" onClick={() => { onEdit(); close(); }}>
            <Pencil size={13} />
            {t('panel.task.edit')}
          </button>
          <button type="button" role="menuitem" className="tk-menu-item" onClick={() => { onDuplicate(); close(); }}>
            <Copy size={13} />
            {t('panel.task.copy')}
          </button>
          {/* Refine sits with the template's own actions, before the
              enable/autopilot toggles: it acts on the task, not on the run.
              Disabled with its own tooltip when its gate says so. */}
          <Tip label={refineBlocked ?? t('panel.task.refineHint')}>
            <button
              type="button"
              role="menuitem"
              className="tk-menu-item"
              disabled={refineReason !== null}
              onClick={() => { onRefine(); close(); }}
            >
              <Wand2 size={13} />
              {t('panel.task.refine')}
            </button>
          </Tip>
          <button type="button" role="menuitem" className="tk-menu-item" onClick={() => { onToggleEnabled(); close(); }}>
            {enabled ? <X size={13} /> : <Check size={13} />}
            {enabled ? t('panel.task.disable') : t('panel.task.enable')}
          </button>
          <button type="button" role="menuitem" className="tk-menu-item" onClick={() => { onToggleAutopilot(); close(); }}>
            <Zap size={13} />
            {t('panel.task.autopilotMenu')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={`tk-menu-item is-destructive${armed ? ' is-armed' : ''}`}
            onClick={() => {
              if (armed) {
                onDelete();
                close();
              } else {
                setArmed(true);
              }
            }}
          >
            <Trash2 size={13} />
            {armed ? t('panel.task.deleteConfirm') : t('panel.task.delete')}
          </button>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/* ============================================================
   History: every run, newest first, grouped by day.
   ============================================================ */

type HistoryFilter = 'all' | 'succeeded' | 'failed';

/** One run as History draws it: the link plus the facts read off its session. */
interface RunView {
  link: TaskRunLink;
  /** The child is up right now. */
  live: boolean;
  /** A turn is in flight in it. */
  running: boolean;
  /** The live bucket's own last-turn figure, for a run whose link has none. */
  liveTurnMs: number | null;
  outcome: 'running' | 'ok' | 'failed';
  /** Whether its session can be opened at all — a live child, or an id this
   *  window may still load. */
  openable: boolean;
}

function TaskHistory({
  links,
  onBack,
  onClear,
}: {
  links: TaskRunLink[];
  onBack: () => void;
  onClear: () => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [query, setQuery] = useState('');
  const activeKey = useApp((s) => s.activeKey);
  const liveIdsKey = useApp(selectLiveSessionIdsKey);
  const focusSession = useApp((s) => s.focusSession);

  /**
   * The verdicts, as **one stable primitive**.
   *
   * The obvious version of this subscribes to `s.sessions` and rebuilds a map
   * of key → status in the component body — and that is the version that
   * re-renders this list on *every token of every session*, because a bucket's
   * identity changes on every appended entry. zustand compares selector output
   * by reference, so a compact string is the same escape hatch
   * `selectLiveSessionIdsKey` uses: it changes only when a turn's status
   * actually does.
   */
  const statusKey = useApp(selectTaskRunStatusKey);

  /** `sessionKey → status`, from the compact key. */
  const statusOf = useMemo(() => {
    const map = new Map<string, { stop: string | null; ms: number | null }>();
    if (statusKey === '') return map;
    for (const part of statusKey.split('\u0001')) {
      const [key, stop, ms] = part.split('\u0000');
      if (key === undefined) continue;
      map.set(key, {
        stop: stop === undefined || stop === '' ? null : stop,
        ms: ms === undefined || ms === '' ? null : Number(ms),
      });
    }
    return map;
  }, [statusKey]);

  const liveKeys = useMemo(() => new Set(statusOf.keys()), [statusOf]);

  const liveIds = useMemo(
    () => new Set(liveIdsKey === '' ? [] : liveIdsKey.split('\u0001')),
    [liveIdsKey],
  );

  /** Every run, newest first, with its verdict resolved exactly once. */
  const runs = useMemo<RunView[]>(() => {
    const rows: RunView[] = [];
    for (let i = links.length - 1; i >= 0; i -= 1) {
      const link = links[i];
      const live = liveKeys.has(link.sessionKey);
      const read = statusOf.get(link.sessionKey);
      const stop = read?.stop ?? null;
      const running = stop === 'running';
      rows.push({
        link,
        live,
        running,
        liveTurnMs: read?.ms ?? null,
        outcome: taskRunOutcome({
          live,
          running,
          stopReason: stop,
          recorded: link.outcome ?? null,
        }),
        // The rail's own two reachability rules: a live child is focused, and
        // a saved id is offered only while no live child already holds it —
        // opening both would be two processes on one session file.
        openable: live || (link.sessionId !== '' && !liveIds.has(link.sessionId)),
      });
    }
    return rows;
  }, [links, statusOf, liveKeys, liveIds]);

  const counts = useMemo(
    () => ({
      all: runs.length,
      succeeded: runs.filter((row) => row.outcome === 'ok').length,
      failed: runs.filter((row) => row.outcome === 'failed').length,
    }),
    [runs],
  );

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return runs.filter((row) => {
      if (filter === 'succeeded' && row.outcome !== 'ok') return false;
      if (filter === 'failed' && row.outcome !== 'failed') return false;
      if (needle === '') return true;
      return (
        row.link.taskName.toLowerCase().includes(needle) ||
        row.link.workspaceLabel.toLowerCase().includes(needle) ||
        row.link.model.toLowerCase().includes(needle)
      );
    });
  }, [runs, filter, query]);

  // Grouped in one pass over the already-sorted list, so the day boundaries
  // can never disagree with the order the rows are drawn in.
  const groups = useMemo(() => {
    const now = Date.now();
    const out: { day: RunDay; rows: RunView[] }[] = [];
    for (const row of shown) {
      const day = runDay(row.link.startedAtMs, now);
      const last = out[out.length - 1];
      if (last !== undefined && last.day === day) last.rows.push(row);
      else out.push({ day, rows: [row] });
    }
    return out;
  }, [shown]);

  function open(row: RunView): void {
    if (row.live) focusSession(row.link.sessionKey);
    else if (row.link.sessionId !== '') void useApp.getState().openSession(row.link.sessionId);
  }

  return (
    <>
      <div className="dialog-head tk-head">
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={t('panel.task.historyBack')}
          title={t('panel.task.historyBack')}
          onClick={onBack}
        >
          <ArrowLeft size={15} />
        </button>
        <div className="grow">
          <DialogPrimitive.Title className="dialog-title tk-title">
            {t('panel.task.historyTitle')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="dialog-desc">
            {t('panel.task.historyNote')}
          </DialogPrimitive.Description>
        </div>
        <div className="tk-search">
          <Search size={13} className="tk-search-icon" />
          <input
            className="tk-search-input"
            value={query}
            spellCheck={false}
            placeholder={t('panel.task.historySearch')}
            aria-label={t('panel.task.historySearch')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <HistoryMenu onClear={onClear} />
      </div>

      <div className="tk-filters">
        <div className="tk-chips" role="tablist" aria-label={t('panel.task.historyTitle')}>
          {(['all', 'succeeded', 'failed'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={`tk-chip${filter === key ? ' is-on' : ''}`}
              onClick={() => setFilter(key)}
            >
              {t(`panel.task.history${key === 'all' ? 'All' : key === 'succeeded' ? 'Succeeded' : 'Failed'}`)}
              <span className="tk-chip-count">{counts[key]}</span>
            </button>
          ))}
        </div>
      </div>

      <PanelBody>
        {runs.length === 0 ? (
          <div className="tk-blank">
            <SquareTerminal size={20} className="tk-blank-icon" />
            <div className="tk-blank-title">{t('panel.task.historyEmpty')}</div>
            <div className="tk-blank-hint">{t('panel.task.historyEmptyHint')}</div>
          </div>
        ) : shown.length === 0 ? (
          <div className="tk-blank">
            <div className="tk-blank-title">{t('panel.task.historyNoMatch')}</div>
            <div className="tk-blank-hint">{t('panel.task.noMatchHint')}</div>
          </div>
        ) : (
          <div className="tk-list">
            {groups.map((group) => (
              <div key={group.day}>
                <div className="tk-day">
                  <span className="tk-day-label">{t(`panel.task.day.${group.day}`)}</span>
                  <span className="tk-day-count">
                    {group.rows.length === 1
                      ? t('panel.task.day.countOne')
                      : t('panel.task.day.count', { n: group.rows.length })}
                  </span>
                </div>
                {group.rows.map((row) => (
                  <HistoryRow
                    key={`${row.link.startedAtMs}-${row.link.sessionKey}`}
                    row={row}
                    onScreen={row.live && activeKey === row.link.sessionKey}
                    onOpen={() => open(row)}
                    onRetry={() => void useApp.getState().runTask(row.link.taskId)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </PanelBody>
    </>
  );
}

function HistoryRow({
  row,
  onScreen,
  onOpen,
  onRetry,
}: {
  row: RunView;
  onScreen: boolean;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const { link } = row;
  // The recorded figure first — it is the one the runtime itself measured and
  // the only one that survives the child. The live bucket's own number is the
  // fallback for a run whose verdict was written before its duration was, and
  // for one still in flight.
  const durationMs = link.durationMs ?? row.liveTurnMs;
  const failed = row.outcome === 'failed';

  const meta = [
    formatClock(link.startedAtMs),
    link.workspaceLabel,
    link.model.trim() === '' ? t('panel.task.modelDefault') : link.model,
    durationMs === null ? null : formatDuration(durationMs),
  ].filter((part): part is string => part !== null && part !== '');

  return (
    <div className="tk-row tk-run-row">
      <span
        className={`tk-run-dot is-${row.outcome}`}
        title={
          row.running
            ? t('panel.task.historyLive')
            : failed
              ? t('panel.task.failed')
              : t('panel.task.succeeded')
        }
      >
        {row.running ? null : failed ? <X size={11} /> : <Check size={11} />}
      </span>

      <div className="tk-row-main">
        <div className="tk-row-title">
          <span className="tk-row-name is-static">{link.taskName}</span>
          {failed ? <span className="badge badge-destructive">{t('panel.task.failed')}</span> : null}
          {onScreen ? <span className="badge badge-neutral">{t('panel.task.onScreen')}</span> : null}
        </div>
        <div className="tk-row-meta">
          <span className="tk-meta-item">{meta.join(' · ')}</span>
        </div>
      </div>

      <div className="tk-row-actions">
        {failed ? (
          <Tip label={t('panel.task.retryHint')}>
            <button type="button" className="btn tk-retry" onClick={onRetry}>
              {t('panel.task.retry')}
            </button>
          </Tip>
        ) : (
          <Tip label={row.openable ? t('panel.task.openHint') : t('panel.task.openGone')}>
            <button type="button" className="btn btn-outline" disabled={!row.openable} onClick={onOpen}>
              {t('panel.task.open')}
            </button>
          </Tip>
        )}
      </div>
    </div>
  );
}

function HistoryMenu({ onClear }: { onClear: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) setArmed(false);
  }, [open]);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={t('panel.task.more')}
          aria-haspopup="menu"
        >
          <MoreHorizontal size={15} />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="tk-menu"
          align="end"
          sideOffset={6}
          aria-label={t('panel.task.more')}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            className={`tk-menu-item is-destructive${armed ? ' is-armed' : ''}`}
            title={t('panel.task.clearHistoryHint')}
            onClick={() => {
              if (armed) {
                onClear();
                setOpen(false);
                requestAnimationFrame(() => triggerRef.current?.focus());
              } else {
                setArmed(true);
              }
            }}
          >
            <Trash2 size={13} />
            {armed ? t('panel.task.clearHistoryConfirm') : t('panel.task.clearHistory')}
          </button>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/* ============================================================
   The editor: one template's fields, saved whole.
   ============================================================ */

function TaskEditor({
  task,
  localPaths,
  remoteLabels,
  onDone,
  onCancel,
}: {
  task: Task;
  localPaths: string[];
  remoteLabels: Map<string, string>;
  onDone: (task: Task) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<Task>(task);
  // A required field is shown as an error only once it has been left empty *and*
  // the person has been in it: marking "Name" red before anything has been typed
  // is the form scolding somebody for not having started.
  const [touched, setTouched] = useState(false);

  const missing = taskProblems(draft);
  const canSave = missing.length === 0;
  // "New" is read off the task's own name rather than passed in as a flag: the
  // editor's `key` is the task id, so for the whole life of one editor this is
  // a constant, and a constant that cannot drift from the field it describes is
  // worth more than a prop that can.
  const isNew = task.name.trim() === '';

  // Esc discards, which the footer says. `PanelShell` is not used here, so the
  // key is bound where the state that has to be discarded lives — and the
  // handler yields to an open popover or a select, whose own Esc is theirs.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      if (target !== null && (target.closest('select') !== null || target.closest('[role="listbox"]') !== null)) {
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      onCancel();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <>
      <div className="dialog-head tk-head">
        <div className="grow">
          <DialogPrimitive.Title className="dialog-title">
            {isNew ? t('panel.task.newTitle') : t('panel.task.editTitle')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="dialog-desc">
            {t('panel.task.editNote')}
          </DialogPrimitive.Description>
        </div>
        <DialogPrimitive.Close asChild>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={t('panel.close')}>
            <X size={14} />
          </button>
        </DialogPrimitive.Close>
      </div>

      <PanelBody>
        <div className="tk-editor">
          <div className="tk-editor-main">
            <label className="cfg-field">
              <span className="cfg-label">
                {t('panel.task.field.name')} <span className="cfg-required">*</span>
              </span>
              <input
                className={`cfg-input${touched && missing.includes('name') ? ' is-error' : ''}`}
                value={draft.name}
                autoFocus
                spellCheck={false}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                onBlur={() => setTouched(true)}
              />
              {touched && missing.includes('name') ? (
                <span className="tk-field-error">{t('panel.task.error.name')}</span>
              ) : null}
            </label>

            <label className="cfg-field">
              <span className="cfg-label">
                {t('panel.task.field.desc')} <span className="cfg-optional">{t('panel.task.optional')}</span>
              </span>
              <input
                className="cfg-input"
                value={draft.description}
                spellCheck={false}
                placeholder={t('panel.task.field.descPlaceholder')}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>

            <label className="cfg-field">
              <span className="cfg-label">
                {t('panel.task.field.prompt')} <span className="cfg-required">*</span>
              </span>
              <textarea
                className={`cfg-textarea tk-prompt${touched && missing.includes('prompt') ? ' is-error' : ''}`}
                rows={9}
                value={draft.prompt}
                spellCheck={false}
                placeholder={t('panel.task.field.promptPlaceholder')}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                onBlur={() => setTouched(true)}
              />
              {touched && missing.includes('prompt') ? (
                <span className="tk-field-error">{t('panel.task.error.prompt')}</span>
              ) : (
                <span className="tk-field-hint">{t('panel.task.promptHint')}</span>
              )}
            </label>
          </div>

          {/* The environment column. Grouped and tinted because these three
              fields are not part of the prompt: they decide *where* the session
              opens and *whether* Run is offered, and the design sets them apart
              for exactly that reason. */}
          <aside className="tk-editor-side">
            <div className="tk-side-title">{t('panel.task.field.environment')}</div>

            <label className="cfg-field">
              <span className="cfg-label">{t('panel.task.field.workspace')}</span>
              <WorkspacePicker
                value={draft.workspace}
                localPaths={localPaths}
                remoteLabels={remoteLabels}
                onChange={(workspace) => setDraft({ ...draft, workspace })}
              />
            </label>

            <label className="cfg-field">
              <span className="cfg-label">
                {t('panel.task.field.model')} <span className="cfg-optional">{t('panel.task.optional')}</span>
              </span>
              <ModelPicker value={draft.model} onChange={(model) => setDraft({ ...draft, model })} />
              <span className="tk-field-hint">{t('panel.task.field.modelHint')}</span>
            </label>

            <div className="tk-toggle-row">
              <button
                type="button"
                role="switch"
                aria-checked={draft.autopilot === true}
                aria-label={t('panel.task.field.autopilot')}
                className={`tk-switch${draft.autopilot === true ? ' is-on' : ''}`}
                onClick={() => setDraft({ ...draft, autopilot: draft.autopilot !== true })}
              >
                <span className="tk-switch-knob" />
              </button>
              <span className="tk-toggle-text">
                <span className="tk-toggle-label">{t('panel.task.field.autopilot')}</span>
                <span className="tk-field-hint">{t('panel.task.field.autopilotHint')}</span>
              </span>
            </div>

            <div className="tk-toggle-row">
              <button
                type="button"
                role="switch"
                aria-checked={draft.enabled}
                aria-label={t('panel.task.field.enabled')}
                className={`tk-switch${draft.enabled ? ' is-on' : ''}`}
                onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
              >
                <span className="tk-switch-knob" />
              </button>
              <span className="tk-toggle-text">
                <span className="tk-toggle-label">{t('panel.task.field.enabled')}</span>
                <span className="tk-field-hint">{t('panel.task.field.enabledHint')}</span>
              </span>
            </div>
          </aside>
        </div>
      </PanelBody>

      <div className="dialog-foot">
        <span className="tk-discard">{t('panel.task.discard')}</span>
        <span className="grow" />
        <button type="button" className="btn btn-outline" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-primary" disabled={!canSave} onClick={() => onDone(draft)}>
          {t('panel.task.save')}
        </button>
      </div>
    </>
  );
}

/**
 * Where a run opens: the workspace on screen, a bookmarked local folder, or a
 * saved remote workspace.
 *
 * One collapsed control rather than the three radios this panel used to draw.
 * The design shows a single workspace field with the resolved path underneath
 * it, and the three-way choice lives inside its menu — the closed label always
 * names the *resolved* place, which is what a person is choosing between, while
 * the three refs are still three refs in the data (`TaskWorkspaceRef`).
 *
 * The resolved path is **not** rendered when there is none to show: a remote
 * workspace's `label` is already the human name of a place this window cannot
 * address locally, and echoing it underneath itself would be noise.
 */
function WorkspacePicker({
  value,
  localPaths,
  remoteLabels,
  onChange,
}: {
  value: TaskWorkspaceRef;
  localPaths: string[];
  remoteLabels: Map<string, string>;
  onChange: (ref: TaskWorkspaceRef) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const remoteEntries = [...remoteLabels.entries()];

  // A ref the store no longer knows falls back to "the workspace on screen"
  // rather than being shown as a selected value that cannot be run. The store
  // refuses such a ref at Run time (`workspaceRefLabel` → `null`), so leaving
  // it displayed would be a field claiming to point somewhere it cannot.
  const current: TaskWorkspaceRef =
    value.kind === 'local' && !localPaths.includes(value.path)
      ? { kind: 'active' }
      : value.kind === 'remote' && !remoteLabels.has(value.id)
        ? { kind: 'active' }
        : value;

  const label =
    current.kind === 'active'
      ? t('panel.task.wsActive')
      : current.kind === 'local'
        ? baseName(current.path)
        : (remoteLabels.get(current.id) ?? current.id);
  const detail = current.kind === 'local' ? current.path : '';

  function pick(next: TaskWorkspaceRef): void {
    onChange(next);
    setOpen(false);
  }

  /** One option row. `on` draws the tick *in the tick's own column*, so every
   *  label starts at the same x whether or not it is the chosen one — the
   *  reason for the empty gap span rather than a conditional. */
  function option(
    on: boolean,
    name: string,
    onClick: () => void,
  ) {
    return (
      <button
        type="button"
        role="option"
        aria-selected={on}
        className={`tk-menu-item${on ? ' is-on' : ''}`}
        onClick={onClick}
      >
        {on ? <Check size={13} /> : <span className="tk-menu-gap" />}
        {name}
      </button>
    );
  }

  return (
    <div className="tk-ws">
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        <PopoverPrimitive.Trigger asChild>
          <button type="button" className="tk-select" aria-haspopup="listbox" aria-expanded={open}>
            <Folder size={13} className="tk-select-icon" />
            <span className="tk-select-label">{label}</span>
            <ChevronDown size={13} className="tk-select-caret" />
          </button>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            className="tk-menu"
            align="start"
            sideOffset={4}
            aria-label={t('panel.task.field.workspace')}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            {option(current.kind === 'active', t('panel.task.wsActive'), () => pick({ kind: 'active' }))}
            {localPaths.length > 0 ? (
              <div className="tk-menu-label">{t('panel.task.wsLocal')}</div>
            ) : null}
            {localPaths.map((path) =>
              option(current.kind === 'local' && current.path === path, baseName(path), () =>
                pick({ kind: 'local', path }),
              ),
            )}
            {remoteEntries.length > 0 ? (
              <div className="tk-menu-label">{t('panel.task.wsRemote')}</div>
            ) : null}
            {remoteEntries.map(([id, remoteLabel]) =>
              option(current.kind === 'remote' && current.id === id, remoteLabel, () =>
                pick({ kind: 'remote', id }),
              ),
            )}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      {detail !== '' ? <span className="tk-field-hint">{detail}</span> : null}
    </div>
  );
}

/**
 * Which model the run's session is switched to — or "inherit", which is the
 * default and means "whatever the workspace's own configuration says".
 *
 * **The catalogue is the open session's own**, not a task's: a model is a fact
 * about the runtime's configuration at open time, and the only child this panel
 * can read one from is the session on screen. That is honest rather than
 * limiting — a task that names a model it cannot offer here can still be typed
 * in, because the picker is a *menu over a text field*: the chosen value is a
 * plain string and the field stays editable. An empty catalogue therefore
 * degrades to exactly what this control used to be, which is the point.
 *
 * `provider/model` is what the run sends (`set_model` does no fuzzy matching),
 * so the qualified form is the value — the same rule `ModelPanel` follows.
 */
function ModelPicker({ value, onChange }: { value: string; onChange: (model: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(false);
  const models = useSessionField((rt) => rt.models, NO_MODEL_ROWS);

  const qualify = (row: { provider: string; id: string }) =>
    row.provider ? `${row.provider}/${row.id}` : row.id;
  const label = value.trim() === '' ? t('panel.task.modelInherit') : value;

  return (
    <div className="tk-ws">
      <PopoverPrimitive.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setTyped(false); }}>
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            className="tk-select"
            aria-haspopup="listbox"
            aria-expanded={open}
            title={value.trim() === '' ? t('panel.task.field.modelHint') : value}
          >
            <Sparkles size={13} className="tk-select-icon" />
            <span className="tk-select-label">{label}</span>
            <ChevronDown size={13} className="tk-select-caret" />
          </button>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            className="tk-menu"
            align="start"
            sideOffset={4}
            aria-label={t('panel.task.field.model')}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            {typed ? (
              // Free text: the catalogue is one child's configuration, and a
              // task may legitimately name a model this window cannot see.
              <div className="tk-menu-typed">
                <input
                  className="cfg-input mono"
                  autoFocus
                  defaultValue={value}
                  spellCheck={false}
                  placeholder={t('panel.task.field.modelPlaceholder')}
                  aria-label={t('panel.task.field.model')}
                  onChange={(e) => onChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setOpen(false);
                  }}
                />
              </div>
            ) : null}
            <button
              type="button"
              role="option"
              aria-selected={value.trim() === ''}
              className={`tk-menu-item${value.trim() === '' ? ' is-on' : ''}`}
              onClick={() => { onChange(''); setOpen(false); }}
            >
              {value.trim() === '' ? <Check size={13} /> : <span className="tk-menu-gap" />}
              {t('panel.task.modelInherit')}
            </button>
            <button
              type="button"
              role="option"
              aria-selected={typed}
              className={`tk-menu-item${typed ? ' is-on' : ''}`}
              onClick={() => setTyped(true)}
            >
              {typed ? <Check size={13} /> : <span className="tk-menu-gap" />}
              {t('panel.task.modelCustom')}
            </button>
            {models.length > 0 ? (
              <div className="tk-menu-label">{t('panel.task.modelAvailable')}</div>
            ) : null}
            {models.map((row) => {
              const name = qualify(row);
              return (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={value === name}
                  className={`tk-menu-item${value === name ? ' is-on' : ''}`}
                  title={row.summary || row.note || undefined}
                  onClick={() => { onChange(name); setOpen(false); }}
                >
                  {value === name ? <Check size={13} /> : <span className="tk-menu-gap" />}
                  <span className="tk-menu-item-label">{row.label || row.id}</span>
                  {row.provider ? <span className="tk-menu-item-hint">{row.provider}</span> : null}
                </button>
              );
            })}
            {models.length === 0 ? (
              <div className="tk-menu-empty">{t('panel.task.modelNoCatalogue')}</div>
            ) : null}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </div>
  );
}

/** The title's `?`: what a task *is*, kept out of the one-line subtitle.
 *
 * The glyph itself is `PanelInfo` in the kit, because Configuration and Learn
 * this workspace now put the same mark in the same place — one control, one
 * behaviour (a native `title`, and the reason for that is on `PanelInfo`).
 */
function TaskInfo() {
  const t = useT();
  return <PanelInfo label={t('panel.task.about')} />;
}

/* ============================================================
   Refine: the one task's runs, compared, into a candidate prompt.
   ============================================================ */

/**
 * The refine form for one task.
 *
 * The same kind of screen as `LearnPanel` — a form whose submit becomes a
 * new session's first message — but shorter, because the run's facts are
 * fixed by the task itself: the workspace is the one on screen (checked by
 * `refineAvailability` before this surface is even offered), the model is
 * inherited, and there is exactly one kind of candidate. What the person
 * decides is only the **evidence scope**: which of the task's finished runs
 * the agent compares, and where to look.
 *
 * The counts beside the options come from `refineRunScope` applied to this
 * task's links — the same arithmetic the store runs when it builds the
 * message — so the number a person reads and the list the agent is given
 * cannot disagree.
 *
 * **Start closes the whole panel.** The new session is what the person
 * wants to watch next, and a form left open over the screen that is about
 * to change is a form that hides the change — the same order LearnPanel's
 * submit uses (close first, then start).
 */
function RefineDialog({
  task,
  links,
  onBack,
}: {
  task: Task;
  links: TaskRunLink[];
  onBack: () => void;
}) {
  const t = useT();
  const refineTask = useApp((s) => s.refineTask);
  const closePanel = useApp((s) => s.closePanel);

  // The first version offers two ranges and pins N = 10, the design's own:
  // "all" (grouped by prompt version by the agent) and "the recent 10".
  const [scopeMode, setScopeMode] = useState<'all' | 'last'>('last');
  const [failedOnly, setFailedOnly] = useState(false);
  const [objectives, setObjectives] = useState('');
  const [busy, setBusy] = useState(false);

  const scope: RunScope = scopeMode === 'all' ? { kind: 'all' } : { kind: 'last', n: REFINE_LAST_N };

  /** How many finished runs the current settings would put in scope — the
   *  same arithmetic the message is built with, over the same links. */
  const inScope = useMemo(
    () => refineRunScope(links, scope, failedOnly).length,
    [links, scopeMode, failedOnly],
  );
  const settled = useMemo(() => links.filter((row) => row.outcome !== undefined).length, [links]);

  const canStart = inScope > 0 && !busy;

  const blocker: string | null =
    settled === 0
      ? t('panel.task.refine.noRuns')
      : inScope === 0
        ? t('panel.task.refine.noneInScope')
        : null;

  function start() {
    if (!canStart) return;
    // The order is the point: the form closes first, so the screen that
    // appears when the new session starts is not covered by the form that
    // produced it.
    closePanel();
    setBusy(true);
    void refineTask(task.id, scope, failedOnly, objectives).finally(() => setBusy(false));
  }

  return (
    <>
      <div className="dialog-head tk-head">
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={t('panel.task.historyBack')}
          title={t('panel.task.historyBack')}
          onClick={onBack}
        >
          <ArrowLeft size={15} />
        </button>
        <div className="grow">
          <DialogPrimitive.Title className="dialog-title tk-title">
            {t('panel.task.refine.title', { name: task.name })}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="dialog-desc">
            {t('panel.task.refine.note')}
          </DialogPrimitive.Description>
        </div>
      </div>

      <PanelBody>
        <div className="tk-section">
          <div className="tk-section-head">
            <span className="tk-section-label">{t('panel.task.refine.scope')}</span>
            <Info label={t('panel.task.refine.scope.hint')} />
          </div>
          {/* One row per option, full width: the label names the choice and the
              count on the right is the preview — "this scope compares N runs".
              `.tk-choice` is the same radio list LearnPanel's scope uses. */}
          <div className="tk-choice" role="radiogroup" aria-label={t('panel.task.refine.scope')}>
            <label className="tk-choice-row">
              <input
                type="radio"
                name="refine-scope"
                checked={scopeMode === 'all'}
                onChange={() => setScopeMode('all')}
              />
              <span className="tk-choice-text">{t('panel.task.refine.scope.all')}</span>
              <span className="tk-choice-count">{inScope}</span>
            </label>
            <label className="tk-choice-row">
              <input
                type="radio"
                name="refine-scope"
                checked={scopeMode === 'last'}
                onChange={() => setScopeMode('last')}
              />
              <span className="tk-choice-text">{t('panel.task.refine.scope.last')}</span>
              <input
                className="tk-choice-num"
                inputMode="numeric"
                readOnly
                value={REFINE_LAST_N}
                aria-label={t('panel.task.refine.scope.last')}
              />
              <span className="tk-choice-count">
                {scopeMode === 'last' ? inScope : '—'}
              </span>
            </label>
          </div>

          <label className="cfg-check">
            <input
              type="checkbox"
              checked={failedOnly}
              onChange={() => setFailedOnly(!failedOnly)}
              aria-label={t('panel.task.refine.scope.failedOnly')}
            />
            <span>{t('panel.task.refine.scope.failedOnly')}</span>
          </label>
        </div>

        <div className="tk-section">
          <div className="tk-section-head">
            <span className="tk-section-label">{t('panel.task.refine.objectives')}</span>
          </div>
          <textarea
            className="cfg-textarea"
            rows={3}
            value={objectives}
            onChange={(e) => setObjectives(e.target.value)}
            placeholder={t('panel.task.refine.objectives.placeholder')}
          />
        </div>
      </PanelBody>

      <div className="dialog-foot">
        <span className="cfg-status">
          {blocker !== null ? (
            <span className="cfg-status-error" role="alert">
              {blocker}
            </span>
          ) : null}
        </span>
        <span className="grow" />
        <button type="button" className="btn btn-outline" onClick={onBack}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-primary" disabled={!canStart} onClick={start}>
          {t('panel.task.refine.start')}
        </button>
      </div>
    </>
  );
}
