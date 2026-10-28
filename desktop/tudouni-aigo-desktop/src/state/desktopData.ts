/**
 * The desktop's user data: `~/.tudouni/desktop.json`.
 *
 * The window's old localStorage record (`aigo.prefs`) mixed two kinds of state
 * in one opaque leveldb entry: the window's presentation (rail widths, folded
 * blocks — which follow *this window* and stay in localStorage) and the
 * person's data (task templates, run history, saved hosts, remote workspaces,
 * the remembered workspace — which follow the *person*). This module is the
 * second half of that split: an in-memory copy of the user data, backed by the
 * file the Rust side reads and writes (`desktop_data_read` /
 * `desktop_data_write`), and a one-way migration off the old record.
 *
 * The rules this file owns:
 *
 *   - **The store reads and writes only the in-memory copy.** The file is a
 *     round trip; a write on every change would put an IPC call behind a
 *     synchronous store action, and these slices never were async. The write
 *     is debounced and, like `persistPrefs`, fire-and-forget: a refused write
 *     is reported to the console, never thrown into a click handler.
 *   - **`syncFromStore` is the only writer, and it is idempotent.** It
 *     extracts the user-data fields off the state, deep-compares them against
 *     the copy, and touches the file only when something moved — the same
 *     "no write when nothing changed" rule `rememberWorkspace` follows for
 *     the ordinary case.
 *   - **`hydrate` runs once, before the first session.** The file wins over
 *     the legacy localStorage copy (it is the newer home); a file that is
 *     missing or unreadable falls back to the legacy record, and only when
 *     that too is empty does a first launch get an empty shelf. The legacy
 *     copy is cleared from localStorage *after* the merged record is safely
 *     written to the file — a write that refused must leave the old record
 *     where it was, or the migration would be a deletion.
 *
 * The validators are the same ones the old record used (the host and
 * workspace guards moved here with the data they guard; the task ones live in
 * `task/tasks`): a record outlives every build, and a malformed entry is
 * dropped whole wherever it is stored.
 */
import { isHosted, readDesktopData, writeDesktopData } from '@/runtime/tauri';
import { readClosePolicy, type ClosePolicy } from '@/runtime/windowClose';
import { readNotifyEnabled } from '@/runtime/notify';
import {
  clampBaseCps,
  clampMaxCps,
  REVEAL_BASE_CPS,
  REVEAL_MAX_CPS,
} from '@/streamReveal';
import {
  isValidTask,
  isValidTaskRun,
  type Task,
  type TaskRunLink,
} from '@/task/tasks';
import type {
  AppStore,
  ModelMemoryEntry,
  RemoteWorkspaceEntry,
  SshHostConfig,
} from './store';

/** The user-data half of the old `aigo.prefs` record, now `desktop.json`. */
export interface DesktopData {
  workspaces: string[];
  sshHosts: SshHostConfig[];
  remoteWorkspaces: RemoteWorkspaceEntry[];
  /**
   * The workspace the next start should open — the one last worked in. `null`
   * means nothing remembered, which is what a first launch has: the first
   * screen is the honest answer, and the app's own install directory is the
   * guess that is always wrong.
   */
  lastWorkspace: string | null;
  /**
   * Which saved remote workspace was last worked in, by its entry id. The
   * remote counterpart of `lastWorkspace`: a remote workspace's directory is
   * on another machine, so a local path can never name it.
   */
  lastRemoteWorkspaceId: string | null;
  /**
   * Start-up arguments, as remembered defaults for the next child — what the
   * next start is *given*, not what is running.
   */
  ericaiDefault: boolean;
  maxStepsDefault: number | null;
  notifyEnabled: boolean;
  /**
   * Whether a streamed reply is revealed at a paced cadence (`streamReveal.ts`).
   *
   * A reading preference, so it follows the person rather than the window: the
   * same answer should hold in every window and after every update. On is the
   * default — off is a revert, and a revert nobody knows about is not a
   * default.
   */
  streamSmoothing: boolean;
  /**
   * The two ends of the pacing curve (`streamReveal.ts`), in characters/second:
   * the steady reading pace and the catch-up cap. A person's taste in how a
   * reply should *look*, stored with the switch it tunes.
   *
   * **They take effect when a reply starts, not mid-reply.** The engine that
   * paces a mounted row was constructed with the values that were in force
   * then; a value written here reaches the curve through the next engine, and
   * the one on screen finishes with the pace it began at. The alternative —
   * swapping the limits under a running cursor — would change the speed while
   * a sentence is on screen, which is the kind of jump the pacing exists to
   * prevent.
   */
  streamBaseCps: number;
  streamMaxCps: number;
  closePolicy: ClosePolicy;
  /**
   * Task templates and their run links. The runtime has no Task entity and
   * the protocol gains nothing; these are front-end facts, now in a place
   * that can be read, diffed and backed up instead of an opaque leveldb.
   */
  tasks: Task[];
  taskRuns: TaskRunLink[];
  /**
   * The model and effort last in use, by workspace. A local directory path
   * names a local workspace; `rw:<id>` names a saved remote one (the same
   * convention `savedSessionsKey` uses for the saved lists).
   *
   * A **fallback for the next session**, not a record of a running one: the
   * runtime validates the name against its own catalogue at open and falls
   * back to the configured default when the person has since removed it —
   * the same rule the remembered workspace follows for a deleted directory.
   */
  modelMemory: Record<string, ModelMemoryEntry>;
}

export function emptyDesktopData(): DesktopData {
  return {
    workspaces: [],
    sshHosts: [],
    remoteWorkspaces: [],
    lastWorkspace: null,
    lastRemoteWorkspaceId: null,
    ericaiDefault: false,
    // Null is "no `--max-steps` on the command line", which is how the
    // runtime's own default applies. A remembered number would silently
    // outrank it.
    maxStepsDefault: null,
    // On, and the reasoning is in `readNotifyEnabled`: a notifier that starts
    // switched off is a feature nobody finds.
    notifyEnabled: true,
    // On, for the same reason as the line above and one of its own: pacing is
    // what the reply looks like, so a build that shipped it off would be
    // indistinguishable from the build before it.
    streamSmoothing: true,
    // The curve's own defaults: "nothing chosen" is the values the pacing was
    // tuned around, so a record that predates these fields runs exactly as it
    // always has.
    streamBaseCps: REVEAL_BASE_CPS,
    streamMaxCps: REVEAL_MAX_CPS,
    // Ask. Neither of the other two is safe to apply without being asked for.
    closePolicy: 'ask',
    tasks: [],
    taskRuns: [],
    modelMemory: {},
  };
}

/** Guards one `sshHosts` entry before it is trusted. The data outlives every
 *  build, so a record missing a field a newer version added (or corrupted by
 *  hand) is dropped whole rather than let through with a field silently
 *  `undefined` where a string was expected. One definition of a valid host,
 *  wherever it is stored — the old home was the window's localStorage record,
 *  the current one is this file. */
function isValidSshHost(value: unknown): value is SshHostConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.label === 'string' &&
    typeof v.host === 'string' &&
    typeof v.port === 'number' &&
    typeof v.user === 'string' &&
    Array.isArray(v.identityFiles) &&
    v.identityFiles.every((item) => typeof item === 'string') &&
    (v.password === undefined || typeof v.password === 'string')
  );
}

/** Same defensive shape, for `remoteWorkspaces`. */
function isValidRemoteWorkspace(value: unknown): value is RemoteWorkspaceEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.hostId === 'string' &&
    typeof v.remotePath === 'string' &&
    typeof v.remoteBinary === 'string' &&
    typeof v.label === 'string'
  );
}

/** The copy the store reads from and `syncFromStore` compares against. */
let current: DesktopData = emptyDesktopData();
/** What is already on the file, as text — `null` until the first write. */
let dirtyText: string | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Whether `hydrate` has run. `syncFromStore` refuses to write before it: the
 * in-memory copy at that moment is the empty shelf, and a store change that
 * lands in the gap would make the empty shelf the file's content — the one
 * write that overwrites the file with nothing.
 */
let hydrated = false;

/** The copy in memory — what the store drew from. */
export function desktopDataSnapshot(): DesktopData {
  return current;
}

/** A test seam: the module state outlives one suite, and each test wants a
 *  clean shelf. Resets everything the module remembers. */
export function resetDesktopDataForTests(): void {
  current = emptyDesktopData();
  dirtyText = null;
  hydrated = false;
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}

/** The user-data fields, read off the state — one place that decides the
 *  split, so a field moved into or out of the file is a one-line change. */
function extract(s: AppStore): DesktopData {
  return {
    workspaces: s.workspaces,
    sshHosts: s.sshHosts,
    remoteWorkspaces: s.remoteWorkspaces,
    lastWorkspace: s.lastWorkspace,
    lastRemoteWorkspaceId: s.lastRemoteWorkspaceId,
    ericaiDefault: s.ericaiDefault,
    maxStepsDefault: s.maxStepsDefault,
    notifyEnabled: s.notifyEnabled,
    streamSmoothing: s.streamSmoothing,
    streamBaseCps: s.streamBaseCps,
    streamMaxCps: s.streamMaxCps,
    closePolicy: s.closePolicy,
    tasks: s.tasks,
    taskRuns: s.taskRuns,
    modelMemory: s.modelMemory,
  };
}

/** Guards one `modelMemory` entry before it is trusted: the record outlives
 *  every build, so a malformed entry is dropped whole, the same rule the
 *  host and workspace guards follow. `effort` may be empty (a runtime that
 *  reports no level) and is dropped from the command line at launch. */
function isValidModelMemory(value: unknown): value is ModelMemoryEntry {
  if (typeof value !== null && typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.model === 'string' && v.model.trim() !== '' && typeof v.effort === 'string';
}


/** Called from `persistPrefs` on every store change that persisted before.
 *  Cheap when nothing moved: the compare is the common case.
 *
 *  **Refused before `hydrate` has run.** At that moment `current` is the
 *  empty shelf and the file still holds the person's data; a change that
 *  lands in the gap would make the empty shelf win over the file. The store's
 *  in-memory copy is refreshed by `hydrate` itself, so nothing a store change
 *  would have saved is lost by skipping it. */
export function syncFromStore(s: AppStore): void {
  if (!hydrated) return;
  const next = extract(s);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  dirtyText = JSON.stringify(current);
  scheduleWrite();
}

/** The debounce: store actions can fire several times a second, and the file
 *  is the slow half of the pair. The data is never at risk in the window's
 *  lifetime — it is in memory — this only decides how often the file catches
 *  up. */
const WRITE_DEBOUNCE_MS = 400;

function scheduleWrite(): void {
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, WRITE_DEBOUNCE_MS);
}

/**
 * Write what is pending. Resolves to whether the write landed: the migration
 * clears the legacy record **only** on true, and a refusal left the old copy
 * where it was. `hydrate` awaits a flush too, so its "the file holds it now"
 * is a fact before the legacy copy goes.
 *
 * **Refused before `hydrate` as well** — a `setTimeout` from the pre-hydrate
 * window could otherwise fire after the latch, and the debounce was started
 * from a `syncFromStore` that should have been skipped.
 */
export function flush(): Promise<boolean> {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (dirtyText === null) return Promise.resolve(false);
  if (!hydrated) return Promise.resolve(false);
  const text = dirtyText;
  dirtyText = null;
  if (!isHosted()) return Promise.resolve(false);
  return writeDesktopData(text)
    .then(() => true)
    .catch((err) => {
      console.error('desktop data could not be written:', err);
      return false;
    });
}

/** The legacy record's user-data fields, or `null` when the record is absent
 *  or unparseable. Reads only the fields that belong to the file; the rest of
 *  the record (the window's presentation) is `loadPrefs`' business. */
function legacyFromLocalStorage(): Partial<Record<keyof DesktopData, unknown>> | null {
  try {
    const raw = localStorage.getItem('aigo.prefs');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(emptyDesktopData()) as (keyof DesktopData)[]) {
      if (key in parsed) out[key] = parsed[key];
    }
    return out;
  } catch {
    return null;
  }
}

/** Parse and validate one record (the file's, or the legacy's). */
function validate(raw: Record<string, unknown> | null | undefined): DesktopData {
  const empty = emptyDesktopData();
  if (raw === null || typeof raw !== 'object') return empty;
  return {
    workspaces: Array.isArray(raw.workspaces)
      ? raw.workspaces.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      : empty.workspaces,
    sshHosts: Array.isArray(raw.sshHosts) ? raw.sshHosts.filter(isValidSshHost) : empty.sshHosts,
    remoteWorkspaces: Array.isArray(raw.remoteWorkspaces)
      ? raw.remoteWorkspaces.filter(isValidRemoteWorkspace)
      : empty.remoteWorkspaces,
    // Same boundary as the old `loadPrefs`: this value decides which child is
    // started at launch, so a non-string is not a cosmetic problem. It is not
    // checked against the filesystem — that is `workspace_check`'s job.
    lastWorkspace:
      typeof raw.lastWorkspace === 'string' && raw.lastWorkspace.trim() !== ''
        ? raw.lastWorkspace
        : null,
    lastRemoteWorkspaceId:
      typeof raw.lastRemoteWorkspaceId === 'string' && raw.lastRemoteWorkspaceId.trim() !== ''
        ? raw.lastRemoteWorkspaceId
        : null,
    ericaiDefault: raw.ericaiDefault === true,
    maxStepsDefault:
      typeof raw.maxStepsDefault === 'number' &&
      Number.isInteger(raw.maxStepsDefault) &&
      raw.maxStepsDefault > 0
        ? raw.maxStepsDefault
        : null,
    // Through the readers, not inline: both have a fallback that is a
    // deliberate decision, and restating either would put a second copy of
    // the rule where only one of them would be updated.
    notifyEnabled: readNotifyEnabled(raw.notifyEnabled),
    // The mirror image of `readNotifyEnabled`'s rule, and the opposite default:
    // a record from a build that predates this field has no answer, and "on" is
    // the answer this window would have given. Only a stored `false` — an
    // explicit choice — survives; a non-boolean (a hand-edited `"false"`, which
    // is truthy) is dropped rather than honoured, the same boundary the two
    // rail widths use.
    streamSmoothing: raw.streamSmoothing !== false,
    // Clamped, not dropped: a record a person edited by hand may hold a pace
    // outside the range, and the honest answer is the nearest value the curve
    // will actually run, not the default. The base is clamped first because
    // the cap's own clamp needs it (a cap below the base is meaningless).
    streamBaseCps: clampBaseCps(raw.streamBaseCps),
    streamMaxCps: clampMaxCps(raw.streamMaxCps, clampBaseCps(raw.streamBaseCps)),
    closePolicy: readClosePolicy(raw.closePolicy),
    tasks: Array.isArray(raw.tasks) ? raw.tasks.filter(isValidTask) : empty.tasks,
    taskRuns: Array.isArray(raw.taskRuns) ? raw.taskRuns.filter(isValidTaskRun) : empty.taskRuns,
    // A whole map or nothing: a half-valid record is worse than an empty one
    // (a missing model is a claim "this workspace last used nothing").
    modelMemory:
      raw.modelMemory !== null && typeof raw.modelMemory === 'object' && !Array.isArray(raw.modelMemory)
        ? Object.fromEntries(
            Object.entries(raw.modelMemory as Record<string, unknown>).filter(
              (entry): entry is [string, ModelMemoryEntry] =>
                entry[0].trim() !== '' && isValidModelMemory(entry[1]),
            ),
          )
        : empty.modelMemory,
  };
}

/**
 * Read the file once, before the first session.
 *
 * Resolution order: the file (the current home), then — **only when the file
 * is absent** — the legacy localStorage record (the migration), then an empty
 * shelf. A file that will not parse is an *empty* record, not an absent one:
 * a file a person edited by hand must not be re-read as the stale copy the
 * migration left behind. The record that results is written to the file, and
 * the legacy copy is removed from the record **only when that write landed** —
 * a migration whose write was refused leaves the old copy where it was, or
 * the data it held would be deleted.
 *
 * Returns what the store should apply to its in-memory copy.
 */
export async function hydrateDesktopData(): Promise<DesktopData> {
  if (hydrated) return current;

  const fileText = await readDesktopData();

  let fileUsable = false;
  let fileData: DesktopData | null = null;
  if (fileText !== null) {
    try {
      fileData = validate(JSON.parse(fileText) as Record<string, unknown>);
      fileUsable = true;
    } catch {
      // A file that does not parse holds nothing usable. The only writer of
      // this file is this program, and it always writes valid JSON, so a
      // broken one is damage from outside — a legacy record that still exists
      // (a migration that never completed) is real data and wins over an
      // empty shelf.
      fileData = null;
    }
  }

  // The legacy copy is consulted when the file has **no usable content**. A
  // valid file wins over the legacy copy even when that copy still holds
  // fields: a valid file is what a previous launch already put there, and
  // re-reading the stale localStorage copy over it would run the migration
  // backwards.
  const legacy = fileUsable ? null : legacyFromLocalStorage();
  const data = fileUsable
    ? (fileData as DesktopData)
    : legacy !== null
      ? validate(legacy)
      : emptyDesktopData();

  // The in-memory copy takes the file's content first, and **only then** does
  // the latch flip: while the read is in flight `current` is still the empty
  // shelf, and a store change in that gap must not be let through
  // `syncFromStore` — the extract it would carry is the empty shelf, and the
  // 400 ms debounce would deliver it over the person's data. The cost of the
  // delay is one user change made while the splash is still up being dropped
  // by the start-up's `setState` — a much smaller loss than the file.
  current = data;
  hydrated = true;
  const migrate = legacy !== null;
  if (!fileUsable || migrate) {
    dirtyText = JSON.stringify(data);
    const written = await flush();
    if (migrate && written) {
      // The legacy fields are on the file now, so the record stops carrying
      // them. **Only after the write landed** — a migration whose write was
      // refused leaves the old copy where it was, or the data it held would
      // be deleted.
      removeLegacyFields();
    }
  }

  return current;
}

/** Drop the user-data fields from the legacy record. The window's
 *  presentation fields stay: they are `loadPrefs`' record to keep. */
function removeLegacyFields(): void {
  try {
    const raw = localStorage.getItem('aigo.prefs');
    if (raw === null) return;
    const record = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(emptyDesktopData()) as (keyof DesktopData)[];
    let changed = false;
    for (const key of keys) {
      if (key in record) {
        delete record[key];
        changed = true;
      }
    }
    if (changed) localStorage.setItem('aigo.prefs', JSON.stringify(record));
  } catch {
    /* Private mode or a gone record: nothing to clean. */
  }
}
