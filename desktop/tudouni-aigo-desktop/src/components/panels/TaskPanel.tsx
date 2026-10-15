import { useMemo, useState } from 'react';
import { Check, ChevronRight, Copy, Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import {
  activeRuntime,
  activeWorkspaceOf,
  selectLiveSessionIdsKey,
  useApp,
} from '@/state/store';
import { useT } from '@/i18n/useT';
import { baseName, formatRelative } from '@/utils/format';
import {
  canRunTask,
  emptyTask,
  taskProblemText,
  workspaceRefLabel,
  type Task,
  type TaskRunLink,
  type TaskWorkspaceRef,
} from '@/task/tasks';
import { Badge, EmptyState, Tip } from '@/components/ui/kit';
import { PanelBody, PanelShell } from './PanelShell';

/**
 * Task templates: the desktop's repeatable session launchers.
 *
 * **Three surfaces, one dialog.** The shelf (every template), the editor (one
 * template's fields) and the history (the sessions a Run produced) are three
 * states of the same panel rather than three screens, for the same reason the
 * library is two tabs in one panel: they are views of one fact.
 *
 * **The workspace picker mirrors the sidebar's vocabulary.** "Here" (the
 * workspace on screen, local or remote — the ordinary open paths answer both),
 * a bookmarked local directory, or a saved remote workspace. A ref that names
 * something the store no longer knows (a forgotten bookmark, a deleted host)
 * is shown as unavailable and refuses to run, rather than silently running
 * somewhere else.
 *
 * **Run is not a new protocol.** It is the store's `runTask`, which opens a
 * session the ordinary way and sends the prompt as its first message — the
 * same two steps `startLearning` established. The model, when the template
 * names one, is the same `set_model` the model panel sends.
 *
 * **History never re-derives state.** Each link froze the task's name and
 * model at start time (the design: history reflects what *was*), and its live
 * status reads the session's own bucket — the same facts the rail's dots read,
 * not a second state machine. Opening prefers the live child (a `focus`,
 * which sends nothing) and falls back to the saved id, the way the rail
 * itself opens a session.
 */
export function TaskPanel() {
  const t = useT();
  const tasks = useApp((s) => s.tasks);
  const taskRuns = useApp((s) => s.taskRuns);
  const upsertTask = useApp((s) => s.upsertTask);
  const deleteTask = useApp((s) => s.deleteTask);
  const runTask = useApp((s) => s.runTask);
  const workspaces = useApp((s) => s.workspaces);
  const remoteWorkspaces = useApp((s) => s.remoteWorkspaces);
  const activeKey = useApp((s) => s.activeKey);
  const liveIdsKey = useApp(selectLiveSessionIdsKey);
  const focusSession = useApp((s) => s.focusSession);

  // Which template the editor holds; `null` is the shelf. One dialog, three
  // surfaces — the editor is a state of this panel, not a second dialog.
  const [editingId, setEditingId] = useState<string | null>(null);
  // The task's own id whose history is expanded on the shelf.
  const [historyId, setHistoryId] = useState<string | null>(null);
  // Delete needs the same two-press arm every other destructive control uses.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  const workspace = useApp(activeWorkspaceOf);
  const rt = useApp(activeRuntime);
  const remoteWorkspaceId = rt?.remoteWorkspaceId ?? null;
  // The compact key, not a Set built per render: zustand compares selector
  // output by identity, and this is the same string the rail subscribes to.
  const liveKeysKey = useApp((s) =>
    s.order.filter((key) => s.sessions[key]?.sessionId !== null).join('\u0001'),
  );

  const editing = editingId !== null ? (tasks.find((row) => row.id === editingId) ?? null) : null;

  const localPaths = useMemo(() => {
    const set = new Set(workspaces);
    if (workspace !== '') set.add(workspace);
    return [...set];
  }, [workspaces, workspace]);

  const remoteLabels = useMemo(
    () => new Map(remoteWorkspaces.map((entry) => [entry.id, entry.label])),
    [remoteWorkspaces],
  );

  const runsByTask = useMemo(() => {
    const map = new Map<string, TaskRunLink[]>();
    for (const link of taskRuns) {
      const list = map.get(link.taskId) ?? [];
      list.push(link);
      map.set(link.taskId, list);
    }
    return map;
  }, [taskRuns]);

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
        onCancel={() => setEditingId(null)}
      />
    );
  }

  return (
    <PanelShell
      title={t('panel.task.title')}
      count={tasks.length}
      note={t('panel.task.note')}
    >
      <PanelBody>
        <button
          type="button"
          className="btn btn-outline btn-block"
          style={{ margin: '0 var(--space-3) var(--space-2)' }}
          onClick={startNew}
        >
          <Plus size={13} />
          {t('panel.task.new')}
        </button>

        {tasks.length === 0 ? (
          <EmptyState title={t('panel.task.empty')} hint={t('panel.task.emptyHint')} />
        ) : (
          <div className="task-list">
            {tasks.map((task) => {
              const label = labelOf(task.workspace);
              const available = label !== null;
              const problems = taskProblemText(
                task,
                t('panel.task.problem.name'),
                t('panel.task.problem.prompt'),
              );
              const runnable = canRunTask(task) && available;
              const runs = runsByTask.get(task.id) ?? [];
              const openRuns = runs.filter(
                (row) => row.sessionKey !== '' && liveKeysKey.split('\u0001').includes(row.sessionKey),
              ).length;
              const expanded = historyId === task.id;
              return (
                <div key={task.id} className="task-card">
                  <div className="task-card-head">
                    <span className="task-card-name">
                      {task.name.trim() === '' ? t('panel.task.unnamed') : task.name}
                    </span>
                    {!task.enabled ? <Badge tone="neutral">{t('panel.task.disabled')}</Badge> : null}
                    {!available ? <Badge tone="warning">{t('panel.task.workspaceMissing')}</Badge> : null}
                    <span className="grow" />
                    <Tip label={t('panel.task.run')}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        aria-label={t('panel.task.run')}
                        disabled={!runnable}
                        title={problems ?? undefined}
                        onClick={() => void runTask(task.id)}
                      >
                        <Play size={13} />
                      </button>
                    </Tip>
                    <Tip label={t('panel.task.edit')}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        aria-label={t('panel.task.edit')}
                        onClick={() => setEditingId(task.id)}
                      >
                        <Pencil size={13} />
                      </button>
                    </Tip>
                    <Tip label={t('panel.task.copy')}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        aria-label={t('panel.task.copy')}
                        onClick={() => duplicate(task)}
                      >
                        <Copy size={13} />
                      </button>
                    </Tip>
                    <Tip label={armedDelete === task.id ? t('panel.task.deleteConfirm') : t('panel.task.delete')}>
                      <button
                        type="button"
                        className={`btn btn-ghost btn-icon${armedDelete === task.id ? ' is-armed' : ''}`}
                        aria-label={armedDelete === task.id ? t('panel.task.deleteConfirm') : t('panel.task.delete')}
                        onClick={() => {
                          if (armedDelete === task.id) {
                            setArmedDelete(null);
                            deleteTask(task.id);
                          } else {
                            setArmedDelete(task.id);
                          }
                        }}
                        onMouseLeave={() => {
                          if (armedDelete === task.id) setArmedDelete(null);
                        }}
                      >
                        {armedDelete === task.id ? <X size={13} /> : <Trash2 size={13} />}
                      </button>
                    </Tip>
                  </div>
                  {task.description.trim() !== '' ? (
                    <div className="task-card-desc">{task.description}</div>
                  ) : null}
                  <div className="task-card-meta">
                    <span className="caption faint mono truncate" title={label ?? undefined}>
                      {available ? (label ?? '') : t('panel.task.workspaceMissing')}
                    </span>
                    {task.model.trim() !== '' ? (
                      <span className="caption faint mono">{task.model}</span>
                    ) : (
                      <span className="caption faint">{t('panel.task.modelDefault')}</span>
                    )}
                    {runs.length > 0 ? (
                      <button
                        type="button"
                        className="task-history-toggle caption faint"
                        aria-expanded={expanded}
                        onClick={() => setHistoryId(expanded ? null : task.id)}
                      >
                        <ChevronRight size={12} className={`caret${expanded ? ' caret-open' : ''}`} />
                        {t('panel.task.history', { n: runs.length })}
                        {openRuns > 0 ? <span className="task-open-count">{openRuns}</span> : null}
                      </button>
                    ) : null}
                  </div>
                  {expanded ? (
                    <TaskHistory
                      links={runs}
                      liveIdsKey={liveIdsKey}
                      liveKeys={new Set(liveKeysKey === '' ? [] : liveKeysKey.split('\u0001'))}
                      activeKey={activeKey}
                      onOpenLive={(key) => focusSession(key)}
                      onOpenSaved={(sessionId) => void useApp.getState().openSession(sessionId)}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   One task's history: its links, newest first.
   ============================================================ */
function TaskHistory({
  links,
  liveIdsKey,
  liveKeys,
  activeKey,
  onOpenLive,
  onOpenSaved,
}: {
  links: TaskRunLink[];
  liveIdsKey: string;
  liveKeys: Set<string>;
  activeKey: string | null;
  onOpenLive: (key: string) => void;
  onOpenSaved: (sessionId: string) => void;
}) {
  const t = useT();
  const liveIds = useMemo(
    () => new Set(liveIdsKey === '' ? [] : liveIdsKey.split('\u0001')),
    [liveIdsKey],
  );

  return (
    <div className="task-history">
      {[...links].reverse().map((link) => {
        // Read off the bucket the row names. The parent re-renders when the
        // live-key string changes, so a run finishing or a child dying is
        // picked up without this component subscribing to anything wider.
        const live = liveKeys.has(link.sessionKey);
        const saved = link.sessionId !== '';
        // Opening prefers the live child; without one the saved id is what
        // opens — the same two names the rail's own rows are reachable by.
        // A saved id a live child holds is the focus path, never a second
        // process on the same file.
        const canOpen = live || (saved && !liveIds.has(link.sessionId));
        return (
          <button
            key={`${link.startedAtMs}-${link.sessionKey}`}
            type="button"
            className="task-history-row"
            disabled={!canOpen}
            title={canOpen ? t('panel.task.historyOpen') : t('panel.task.historyGone')}
            onClick={() => {
              if (live) onOpenLive(link.sessionKey);
              else if (saved) onOpenSaved(link.sessionId);
            }}
          >
            <span
              className={`task-dot${live ? ' is-live' : saved ? ' is-idle' : ' is-gone'}`}
              title={
                live
                  ? t('panel.task.historyLive')
                  : saved
                    ? t('panel.task.historySaved')
                    : t('panel.task.historyPending')
              }
            />
            <span className="task-history-label">{link.taskName}</span>
            <span className="caption faint mono">
              {saved ? link.sessionId : t('panel.task.starting')}
            </span>
            <span className="grow" />
            {link.model.trim() !== '' ? <span className="caption faint mono">{link.model}</span> : null}
            <span className="caption faint">{formatRelative(link.startedAtMs)}</span>
            {live && activeKey === link.sessionKey ? (
              <Badge tone="success" dot={false}>
                {t('panel.task.onScreen')}
              </Badge>
            ) : null}
          </button>
        );
      })}
    </div>
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

  const problems = taskProblemText(draft, t('panel.task.problem.name'), t('panel.task.problem.prompt'));
  const canSave = problems === null;

  return (
    <PanelShell title={t('panel.task.editTitle')} note={t('panel.task.editNote')}>
      <PanelBody>
        <div className="cfg-grid">
          <label className="cfg-field">
            <span className="cfg-label">
              {t('panel.task.field.name')} <span className="cfg-required">*</span>
            </span>
            <input
              className="cfg-input"
              value={draft.name}
              autoFocus
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
        </div>

        <label className="cfg-field">
          <span className="cfg-label">{t('panel.task.field.desc')}</span>
          <input
            className="cfg-input"
            value={draft.description}
            spellCheck={false}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>

        <label className="cfg-field">
          <span className="cfg-label">
            {t('panel.task.field.prompt')} <span className="cfg-required">*</span>
          </span>
          <textarea
            className="cfg-textarea"
            rows={6}
            value={draft.prompt}
            spellCheck={false}
            placeholder={t('panel.task.field.promptPlaceholder')}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          />
        </label>

        <div className="cfg-field">
          <span className="cfg-label">{t('panel.task.field.workspace')}</span>
          <div className="task-ws" role="radiogroup" aria-label={t('panel.task.field.workspace')}>
            <label className="cfg-check">
              <input
                type="radio"
                name="task-ws"
                checked={draft.workspace.kind === 'active'}
                onChange={() => setDraft({ ...draft, workspace: { kind: 'active' } })}
              />
              <span>{t('panel.task.wsActive')}</span>
            </label>
            <label className="task-ws-row">
              <input
                type="radio"
                name="task-ws"
                checked={draft.workspace.kind === 'local'}
                onChange={() =>
                  setDraft({ ...draft, workspace: { kind: 'local', path: localPaths[0] ?? '' } })
                }
              />
              <select
                className="cfg-input task-ws-select"
                value={draft.workspace.kind === 'local' ? draft.workspace.path : ''}
                disabled={draft.workspace.kind !== 'local'}
                onChange={(e) => setDraft({ ...draft, workspace: { kind: 'local', path: e.target.value } })}
              >
                {localPaths.map((path) => (
                  <option key={path} value={path}>
                    {baseName(path)} — {path}
                  </option>
                ))}
              </select>
            </label>
            {remoteLabels.size > 0 ? (
              <label className="task-ws-row">
                <input
                  type="radio"
                  name="task-ws"
                  checked={draft.workspace.kind === 'remote'}
                  onChange={() =>
                    setDraft({ ...draft, workspace: { kind: 'remote', id: [...remoteLabels.keys()][0] ?? '' } })
                  }
                />
                <select
                  className="cfg-input task-ws-select"
                  value={draft.workspace.kind === 'remote' ? draft.workspace.id : ''}
                  disabled={draft.workspace.kind !== 'remote'}
                  onChange={(e) => setDraft({ ...draft, workspace: { kind: 'remote', id: e.target.value } })}
                >
                  {[...remoteLabels.entries()].map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </div>

        <label className="cfg-field">
          <span className="cfg-label">{t('panel.task.field.model')}</span>
          <p className="set-hint">{t('panel.task.field.modelHint')}</p>
          <input
            className="cfg-input mono"
            value={draft.model}
            spellCheck={false}
            placeholder={t('panel.task.field.modelPlaceholder')}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          />
        </label>

        <label className="cfg-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          <span>{t('panel.task.field.enabled')}</span>
        </label>
      </PanelBody>

      <div className="dialog-foot">
        <span className="cfg-status">
          {problems !== null ? (
            <span className="cfg-status-error">{problems}</span>
          ) : (
            <Check size={14} className="cfg-status-ok" />
          )}
        </span>
        <span className="grow" />
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-primary" disabled={!canSave} onClick={() => onDone(draft)}>
          {t('common.save')}
        </button>
      </div>
    </PanelShell>
  );
}
