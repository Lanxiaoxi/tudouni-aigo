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
 * **Persistence is `~/.tudouni/desktop.json`** (via `state/desktopData.ts`,
 * with the workspace bookmarks and the remote-workspace entries). The design's
 * requirement — "task templates and their association with sessions are saved
 * by the desktop's own persistence layer" — is answered there, and nowhere
 * else.
 */

import { samePath } from '@/utils/format';

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
  /** Whether a run opens its session in autopilot (auto-approve, no questions).
   *  A task is an automated run by design, so this is the point: without it a
   *  run stops at the first approval nobody is sitting at to answer.
   *
   *  Optional, not required: a template persisted before this field existed
   *  reads as "not set" and a run behaves exactly as it did then — the
   *  session's default (off). A freshly created one is on. The editor always
   *  writes it back, so the field converges after the first save. */
  autopilot?: boolean;
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
  /** Whether the run's session was opened in autopilot. The same frozen fact as
   *  `taskName` and `model`: the template is editable, and History reflects
   *  what *was*. Absent on a link saved before the field existed. */
  autopilot?: boolean;
  /**
   * How the run ended, written once by `noteTaskRunOutcome`.
   *
   * Absent on every link persisted before this field existed, and on a link
   * whose turn has not settled — both of which read as "no verdict recorded",
   * never as a success. A stored record is not rewritten just to add the key:
   * `isValidTaskRun` accepts its absence, so history saved by an older build
   * survives the upgrade instead of being dropped whole.
   */
  outcome?: TaskRunOutcome;
  /**
   * The finished turn's own wall time, from `run_finished.duration_ms`.
   *
   * The same fact `SessionRuntime.lastTurnMs` holds for a live session, copied
   * onto the link for the same reason the name and model are: it is readable
   * only while the child exists, and History outlives the child.
   */
  durationMs?: number;
  /** A frozen copy of the task's prompt at Run time. The task is editable;
   *  history reflects what *was*, the same reason as `taskName` and `model`.
   *
   *  Optional for the same reason `outcome` and `durationMs` are: a link
   *  persisted before this field existed is a perfectly good link, and a
   *  refine prompt labels those runs `prompt: (not recorded)` rather than the
   *  panel dropping them. A *present* value that is not a string is malformed
   *  and drops the record. */
  prompt?: string;
  /**
   * Which saved remote workspace the run happened in, or `null`/absent for a
   * local one.
   *
   * **The run's evidence lives on that machine**, and the label alone cannot say
   * which machine that is: a local `/srv/app` and a remote `/srv/app` are two
   * places that compare equal as strings. Refine reads the session files of the
   * runs it studies, so "which host are these transcripts on" has to be a
   * recorded fact rather than something inferred from a path — otherwise a task
   * refined on a remote screen would be pointed at a local directory of the same
   * name.
   *
   * Optional for the same compatibility reason `outcome` and `prompt` are: a
   * link persisted before this field existed describes a run whose home is
   * unknown, and the honest reading is "local", which is what every such link
   * was.
   */
  remoteWorkspaceId?: string | null;
}

/**
 * How a run ended.
 *
 * **Recorded, not derived — and that is the whole point.** A run's outcome is
 * knowable exactly once, from the transcript of the child it produced, and that
 * child is gone the moment the session is closed and reopened from disk: a
 * `VmSessionListItem` carries counts and timestamps, never a stop reason. So the
 * reducer writes the verdict onto the link while the transcript still exists
 * (`noteTaskRunOutcome`), and History reads it back for ever after. Re-deriving
 * it at render time would mean the Failed filter quietly emptying itself as
 * sessions aged out, which is worse than not offering the filter at all.
 *
 * `null` is "still in flight, or a run whose turn never started" — never a
 * third state to draw. See `taskRunOutcome` for the mapping.
 */
export type TaskRunOutcome = 'ok' | 'failed';

/* ============================================================
   Run outcome
   ============================================================ */

/**
 * The turn statuses that mean **the engine failed**, as opposed to the person
 * stopping it.
 *
 * Deliberately the same list `selectRowStatus` uses for the rail's red dot, and
 * for the same reason: pressing Stop three times must not earn three red marks,
 * or red stops meaning anything. `cancelled` is a person's decision, `max_steps`
 * is a budget, and `empty_response` is neither failure nor success — none of
 * them is "your run broke", so none of them is a Failed row with a Retry on it.
 */
const FAILED_TURN_STATUSES = new Set(['model_error', 'model_fatal', 'runtime_exited']);

/** One turn's own verdict, shared by the live bucket and the recorded link so
 *  the two can never disagree about what "failed" means. */
export function outcomeOfTurnStatus(status: string): TaskRunOutcome {
  return FAILED_TURN_STATUSES.has(status) ? 'failed' : 'ok';
}

/**
 * What a **child that exited** says about a run, or `null` for "nothing to
 * record".
 *
 * A turn that the exit interrupted is already `runtime_exited` in the
 * transcript, so `outcomeOfTurnStatus` has a verdict for it and this is only
 * asked about the other case: the child went away *between* turns. Then there
 * is no turn to read, and the exit itself is the whole statement —
 *
 *   - **`requested`** — the front end asked the child to stop, which is a
 *     person closing a session, not a run failing. `null`: leave the verdict
 *     the run already earned. Writing `ok` here would upgrade a run that had
 *     failed on its turn into a success, which is the one direction that must
 *     never happen.
 *   - **not `requested`** — the runtime died under a run that was not
 *     finished. That is a failure however the last turn happened to end.
 */
export function outcomeOfChildExit(requested: boolean): TaskRunOutcome | null {
  return requested ? null : 'failed';
}

/**
 * A run's outcome as the panel draws it, from the facts available right now:
 * the link's recorded verdict, the live turn if there is one, and the runtime's
 * last stop reason once it has one.
 *
 * Precedence is "what is happening" over "what was written down":
 *
 *   1. **A turn in flight** — `running`, and the recorded verdict is not
 *      consulted: a Retry on a link that is running again would be a second
 *      run wearing the first one's row.
 *   2. **A settled turn, live** — the transcript's own stop reason, which is
 *      strictly newer than anything persisted before it and is what catches a
 *      failure that happened since the last write.
 *   3. **The recorded verdict** — for a session that is closed, or one whose
 *      child is up but has not run anything yet.
 *   4. **Nothing** — `running`. A link is appended before the child has even
 *      handshaken, so this is the ordinary state of a run in its first second,
 *      and "Open" is the only honest control on it.
 */
export function taskRunOutcome(input: {
  live: boolean;
  running: boolean;
  stopReason: string | null;
  recorded: TaskRunOutcome | null;
}): 'running' | TaskRunOutcome {
  if (input.running) return 'running';
  if (input.live && input.stopReason !== null) return outcomeOfTurnStatus(input.stopReason);
  return input.recorded ?? 'running';
}

/* ============================================================
   History grouping
   ============================================================ */

/** Which bucket a run's start time falls in, for the History headers. */
export type RunDay = 'today' | 'yesterday' | 'earlier';

/**
 * The day bucket of a run, **by calendar day** rather than by elapsed hours.
 *
 * `formatRelative` answers "how long ago", which is the wrong question for a
 * header sitting above a group of rows: at 00:30 a run from four hours ago is
 * labelled "4h ago" and a run from 23:00 yesterday is "yesterday", so the two
 * would land in the same group under an hours-based rule and in different ones
 * under this. The headers say which day it was, so the days are what is
 * compared.
 */
export function runDay(startedAtMs: number, nowMs: number): RunDay {
  const start = dayIndex(startedAtMs);
  const now = dayIndex(nowMs);
  if (start === now) return 'today';
  if (start === now - 1) return 'yesterday';
  return 'earlier';
}

/** A local calendar day, as a number that differs by exactly 1 between
 *  consecutive days.
 *
 *  Anchored at **noon** rather than midnight: the epoch-day division truncates
 *  toward zero, so a date that is a few hours off UTC midnight lands in the
 *  wrong day — and `runDay` compares these by subtracting, which is exactly
 *  where one day of drift turns "today" into "yesterday". Noon is far enough
 *  from both midnights to absorb any offset a time zone can apply. */
function dayIndex(atMs: number): number {
  const d = new Date(atMs);
  const noon = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  return Math.round(noon.getTime() / 86_400_000);
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
    // On by default: a task is an automated run, and a run that stops at the
    // first approval is not one. (An old template without the field is a
    // different thing — that one keeps its old behaviour.)
    autopilot: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

/** Guard one parsed task record from `desktop.json` before it is trusted.
 *  The record outlives every build, so a malformed record is dropped whole
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
  // `autopilot` is optional (pre-field records keep their old behaviour), but a
  // *present* value that is not a boolean is malformed and drops the record.
  if (v.autopilot !== undefined && typeof v.autopilot !== 'boolean') return false;
  return typeof v.model === 'string' && typeof v.createdAtMs === 'number' && typeof v.updatedAtMs === 'number';
}

/**
 * Same guard for a run link.
 *
 * **`outcome` and `durationMs` are optional, and that is a compatibility
 * requirement rather than laxity.** A link persisted before those fields
 * existed is a perfectly good link — a name, a model, a workspace and a time —
 * and rejecting it would delete a person's run history on upgrade. A *present*
 * value is still checked: a record carrying `outcome: "maybe"` is malformed,
 * and the honest thing to do with a malformed record is drop it.
 */
export function isValidTaskRun(value: unknown): value is TaskRunLink {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.outcome !== undefined && v.outcome !== 'ok' && v.outcome !== 'failed') return false;
  if (v.durationMs !== undefined && typeof v.durationMs !== 'number') return false;
  if (v.autopilot !== undefined && typeof v.autopilot !== 'boolean') return false;
  if (v.prompt !== undefined && typeof v.prompt !== 'string') return false;
  // `null` is the explicit "local", and absent is the older record that had no
  // way to say anything else — both are fine. A *present* value that is not a
  // string (or null) is malformed.
  if (v.remoteWorkspaceId !== undefined && v.remoteWorkspaceId !== null && typeof v.remoteWorkspaceId !== 'string') {
    return false;
  }
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

/* ============================================================
   Refine: the run scope, and what makes it available
   ============================================================ */

/**
 * Which of a task's runs a refine run may study.
 *
 * `firstVersion` pins N = 10 for the first version, exactly as the design
 * does: "all" is the only other range offered, and a number field would be
 * a knob nobody asked for.
 */
export type RunScope = { kind: 'all' } | { kind: 'last'; n: number };

export const REFINE_LAST_N = 10;

/**
 * A run, as the refine prompt lists it.
 *
 * Everything here is read off the link — the frozen snapshot, the recorded
 * verdict, the session file's path — so the prompt and the panel cannot
 * describe one run two ways.
 */
export interface RefineRunRef {
  taskName: string;
  model: string;
  workspaceLabel: string;
  startedAtMs: number;
  /** The recorded verdict — a refine run only sees settled runs, so this is
   *  never null. */
  outcome: TaskRunOutcome;
  durationMs: number | null;
  /** The frozen prompt at run time, or null when the link predates the
   *  field — rendered as `prompt: (not recorded)`, never as a guess. */
  prompt: string | null;
  /** The session's JSONL, workspace-relative, or null while no id is known. */
  sessionFile: string | null;
}

/**
 * Apply the chosen scope to a task's run links.
 *
 * **Only settled runs are eligible.** A run without a verdict has nothing to
 * compare — "still running" is a state, not an outcome, and the panel's
 * availability gate says so before the scope is ever chosen.
 *
 * **The failed-only scope keeps one ok run as the reference.** "What broke"
 * is only visible against "how it went right": failed runs alone cannot tell
 * a detour from the usual route, so the newest successful run stays in
 * scope as the contrast (the design's own rule).
 */
export function refineRunScope(
  links: TaskRunLink[],
  scope: RunScope,
  failedOnly: boolean,
): RefineRunRef[] {
  // Newest first, in every scope: the prompt lists runs in the order the
  // person's history draws them, and "last N" is a trim of that same order
  // rather than a second sort that could disagree with it.
  const settled = links
    .filter((link) => link.outcome === 'ok' || link.outcome === 'failed')
    .sort((a, b) => b.startedAtMs - a.startedAtMs);
  let picked = scope.kind === 'all' ? settled : settled.slice(0, scope.n);
  if (failedOnly) {
    const failed = picked.filter((link) => link.outcome === 'failed');
    // The list is newest first, so the first ok is the reference run —
    // "how it went right", the contrast "what broke" is only visible against.
    const reference = picked.find((link) => link.outcome === 'ok') ?? null;
    picked = reference !== null ? [reference, ...failed] : failed;
  }
  return picked.map((link) => ({
    taskName: link.taskName,
    model: link.model,
    workspaceLabel: link.workspaceLabel,
    startedAtMs: link.startedAtMs,
    outcome: link.outcome as TaskRunOutcome,
    durationMs: link.durationMs ?? null,
    prompt: link.prompt ?? null,
    sessionFile: link.sessionId === '' ? null : `.tudouni/sessions/${link.sessionId}.jsonl`,
  }));
}

/**
 * Where the window is, as the refine rules see it.
 *
 * A pair rather than a path, for the reason the `savedSessions` key is a pair:
 * `/srv/app` on this machine and `/srv/app` on a host are two places that
 * compare equal as strings, and a refine run studies exactly one of them. The
 * `remoteWorkspaceId` is `null` for a local screen.
 */
export interface RefineScreen {
  workspace: string;
  remoteWorkspaceId: string | null;
}

/** Which saved remote workspace a task names, or `null` for a local/active one.
 *  The one fold the availability rule and the run path both need. */
export function taskRemoteId(task: Task): string | null {
  return task.workspace.kind === 'remote' ? task.workspace.id : null;
}

/**
 * Whether Refine may be offered for a task, and if not, which rule stopped it.
 *
 * The reasons are ordered so the first one drawn is the one that must be fixed
 * first: no finished run is a fact about the task's own history, and a task
 * bound to a place that is not on screen would make `.tudouni/sessions/`
 * someone else's — so the comparison would study the wrong transcripts.
 */
export function refineAvailability(
  task: Task,
  links: TaskRunLink[],
  screen: RefineScreen,
): { ok: boolean; reason: 'no-runs' | 'other-workspace' | null } {
  const settled = links.some((link) => link.outcome === 'ok' || link.outcome === 'failed');
  if (!settled) return { ok: false, reason: 'no-runs' };
  // **"The right place" is now a pair, not a path.** A refine run reads the
  // session files of the workspace it studies, and the reading is done by the
  // child of *that* place — so the machine has to match as well as the
  // directory: a local `/srv/app` and a remote `/srv/app` hold different
  // `.tudouni/sessions/`, and a refine pointed at the wrong one would study
  // someone else's transcripts.
  //
  // There is no separate "remote is unsupported" refusal any more, and that was
  // the earlier version's real defect: a remote *screen* is a perfectly good
  // place to run a refine, because the remote child reads its own session files.
  // What is genuinely impossible is refining a task whose place is *not* the one
  // on screen — the same rule a local task always had.
  //
  // The split is by the task's ref, and each answer is a single fact:
  //   - `remote` — the saved entry's id must be the screen's, and ids are unique
  //     per (host, path), so that alone says "same place";
  //   - `local` — no machine at all, and the directory must match;
  //   - `active` — "wherever I am", which is true by construction.
  if (screen.workspace === '') return { ok: false, reason: 'other-workspace' };
  // `active` first, and **before** the machine check below: "wherever I am" is
  // true by construction, on a local screen and on a host alike. Testing it after
  // the local-only guard refused every `active` task on a remote screen — which
  // is the common case, since `active` is what a fresh task gets.
  if (task.workspace.kind === 'active') return { ok: true, reason: null };
  if (task.workspace.kind === 'remote') {
    return screen.remoteWorkspaceId === task.workspace.id
      ? { ok: true, reason: null }
      : { ok: false, reason: 'other-workspace' };
  }
  // A local ref names a directory **on this machine**, so a remote screen is
  // somewhere else even when the two paths are spelled the same.
  if (screen.remoteWorkspaceId !== null) return { ok: false, reason: 'other-workspace' };
  return samePath(task.workspace.path, screen.workspace)
    ? { ok: true, reason: null }
    : { ok: false, reason: 'other-workspace' };
}
