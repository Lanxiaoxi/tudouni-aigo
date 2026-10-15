/**
 * The Task feature: types, validation, and the small pure helpers.
 *
 * **Task is a template, not an engine.** Everything here is front-end data: a
 * task names a prompt, a workspace and an optional model, and "Run" is the
 * ordinary session-open path (`openSession` → `attachSession` or
 * `connectRemoteWorkspace`) followed by the prompt as the first `user_message`
 * — the same two steps `startLearning` takes, and no protocol of its own.
 * Nothing in the runtime knows the word "task".
 *
 * **Persistence is `aigo.prefs`** (localStorage, like the workspace bookmarks
 * and the remote-workspace entries). The design's requirement — "task templates
 * and their association with sessions are saved by the desktop's own
 * persistence layer" — is answered there, and nowhere else.
 */

/** Where a task runs: the workspace on screen, a bookmarked local directory,
 *  or a saved remote workspace. */
export type TaskWorkspaceRef =
  | { kind: 'active' }
  | { kind: 'local'; path: string }
  | { kind: 'remote'; id: string };

export interface Task {
  id: string;
  name: string;
  /** Optional; a task without one is a task without marketing copy. */
  description: string;
  /** The prompt sent as the new session's first message. The task's payload. */
  prompt: string;
  workspace: TaskWorkspaceRef;
  /** `provider/model` or `model`, exactly what `set_model` takes; empty means
   *  "whatever the workspace's current model is" — the default, because the
   *  config file is the authority on what that is. */
  model: string;
  /** Whether the template accepts runs at all. A disabled task stays editable
   *  and keeps its history; it only refuses new runs. */
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

/** One association between a task and the session a Run produced. */
export interface TaskRunLink {
  taskId: string;
  /** The runtime's session id (`YYYYMMDD-HHMMSS`), back-filled from `init`.
   *  Empty while the handshake is still in flight. */
  sessionId: string;
  /** The bridge's child key, which is how a row reaches its live bucket. */
  sessionKey: string;
  startedAtMs: number;
  /** A frozen summary of the task at start time — the task is editable, and
   *  the design is explicit that history reflects what *was*, not what is. */
  taskName: string;
  model: string;
  workspaceLabel: string;
}

/** Fields a fresh task gets, in one place. */
export function emptyTask(nowMs: number): Task {
  return {
    id: `task-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    description: '',
    prompt: '',
    workspace: { kind: 'active' },
    model: '',
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

/** Guard one parsed task record from `aigo.prefs` before it is trusted.
 *  localStorage outlives every build, so a malformed record is dropped whole
 *  rather than let through with `undefined` fields. */
export function isValidTask(value: unknown): value is Task {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id === '') return false;
  if (typeof v.name !== 'string' || typeof v.description !== 'string') return false;
  if (typeof v.prompt !== 'string') return false;
  const ws = v.workspace;
  if (typeof ws !== 'object' || ws === null) return false;
  const w = ws as Record<string, unknown>;
  if (w.kind === 'active') {
    if (typeof v.enabled !== 'boolean') return false;
  } else if (w.kind === 'local') {
    if (typeof w.path !== 'string' || w.path === '') return false;
  } else if (w.kind === 'remote') {
    if (typeof w.id !== 'string' || w.id === '') return false;
  } else {
    return false;
  }
  return typeof v.model === 'string' && typeof v.createdAtMs === 'number' && typeof v.updatedAtMs === 'number';
}

/** Same guard for a run link. */
export function isValidTaskRun(value: unknown): value is TaskRunLink {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.taskId === 'string' &&
    typeof v.sessionId === 'string' &&
    typeof v.sessionKey === 'string' &&
    typeof v.startedAtMs === 'number' &&
    typeof v.taskName === 'string' &&
    typeof v.model === 'string' &&
    typeof v.workspaceLabel === 'string'
  );
}

/** The fields Run needs, and what is missing. `[]` means it may run. */
export function taskProblems(task: Task): string[] {
  const problems: string[] = [];
  if (task.name.trim() === '') problems.push('name');
  if (task.prompt.trim() === '') problems.push('prompt');
  return problems;
}

/** Whether a task can be run: enabled and without missing required fields. */
export function canRunTask(task: Task): boolean {
  return task.enabled && taskProblems(task).length === 0;
}

/**
 * The label a workspace ref answers with, from the store's own lists.
 *
 * Pure so the panel and the history can be asserted without a window: the
 * lookup is a plain function over names. `null` means the ref names nothing
 * the store knows — a bookmark that was forgotten, a host that was deleted —
 * which the panel must show rather than quietly running somewhere else.
 */
export function workspaceRefLabel(
  ref: TaskWorkspaceRef,
  activeWorkspace: string,
  localPaths: string[],
  remoteLabels: Map<string, string>,
): string | null {
  if (ref.kind === 'active') return activeWorkspace === '' ? null : activeWorkspace;
  if (ref.kind === 'local') return localPaths.some((p) => p === ref.path) ? ref.path : null;
  return remoteLabels.get(ref.id) ?? null;
}

/** The missing-fields sentence for one task, or null. */
export function taskProblemText(task: Task, missingName: string, missingPrompt: string): string | null {
  const missing = taskProblems(task);
  if (missing.includes('name')) return missingName;
  if (missing.includes('prompt')) return missingPrompt;
  return null;
}
