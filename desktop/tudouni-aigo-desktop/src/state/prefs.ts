/**
 * Preferences: read once at module load, persisted on change.
 *
 * This was the first block of `store.ts` that never needed the store: it reads
 * `localStorage`, validates what it finds against the shapes this build knows,
 * and writes the whole record back. The one store-shaped function here is
 * `persistPrefs`, which reads the fields off the state — and it takes that state
 * as an argument, so this file imports the store's **type** only.
 *
 * The validators are deliberately defensive: localStorage outlives every build,
 * and a record from an older version must not take the sidebar down with it.
 */
import type { ClosePolicy } from '@/runtime/windowClose';
import { readClosePolicy } from '@/runtime/windowClose';
import { readNotifyEnabled } from '@/runtime/notify';
import {
  isValidTask,
  isValidTaskRun,
  type Task,
  type TaskRunLink,
} from '@/task/tasks';
import type {
  AppStore,
  QuietMode,
  RemoteWorkspaceEntry,
  SshHostConfig,
  SidebarBlockKey,
} from './store';


/**
 * The rail opens **folded**: five headings are a table of contents, and a list
 * that springs open on every start spends its pixels on blocks that usually
 * have nothing to say about this conversation yet. The first snapshot that
 * gives a block content unfolds it — once (`blockAutoExpanded`), and never
 * again after a person has folded it themselves (`blockTouched`).
 */
const EMPTY_BLOCKS: Record<SidebarBlockKey, boolean> = {
  goal: true,
  tasks: true,
  skills: true,
  jobs: true,
  mcp: true,
  ssh: true,
};

/**
 * The range a dragged rail width is allowed to land in — **one range for both
 * rails**, so the two cannot disagree about what "reset" and "as wide as it
 * goes" mean, and so a future change has one place to land.
 *
 * The floor keeps every row's own minimum readable (the right rail's MCP row
 * was measured to overflow below 201px — see `McpRow`; the left rail's own
 * narrow-window fallback is 216px, just above it), and the ceiling keeps a
 * maximally wide rail from eating the transcript: the composer's comfortable
 * floor is around 700px, and even both rails dragged to the ceiling together
 * still leave it on a window of the size this app is meant to run in. Both ends
 * are read back through this function on load, so a range change re-clamps what
 * an older build persisted rather than trusting it.
 */
export const RAIL_MIN = 208;
export const RAIL_MAX = 420;

export function clampRailWidth(px: number): number {
  if (!Number.isFinite(px)) return RAIL_MIN;
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(px)));
}

/* ============================================================
   Preferences: read once, persisted on change
   ============================================================ */

type Prefs = {
  /** Quiet mode as remembered. Reads a legacy `true`/`false` record from the
   *  boolean era: `true` meant the mode was on, which is `normal`. */
  quiet: QuietMode;
  sidebarVisible: boolean;
  leftbarVisible: boolean;
  /** The right rail's dragged width; `null` = the stylesheet's own default. */
  sidebarWidth: number | null;
  /** The left rail's dragged width; `null` = the stylesheet's own default. */
  leftbarWidth: number | null;
  blockCollapsed: Record<SidebarBlockKey, boolean>;
  blockTouched: Partial<Record<SidebarBlockKey, boolean>>;
  /** The left rail's session list, folded on its own. */
  sessionsCollapsed: boolean;
  /** The left rail's workspace list (local + remote), folded on its own. */
  workspacesCollapsed: boolean;
  /** The left rail's foot (the seven workbench buttons), folded on its own. */
  footCollapsed: boolean;
  workspaces: string[];
  sshHosts: SshHostConfig[];
  remoteWorkspaces: RemoteWorkspaceEntry[];
  /**
   * The workspace the **next** start should open, i.e. the one last worked in.
   *
   * Kept apart from `workspaces`, which is the list of places a person can go.
   * The two answer different questions and may hold different things: this one
   * is a *default*, it is allowed to name a directory that was never
   * bookmarked, and it is cleared when the directory stops being usable rather
   * than lingering as a row that would refuse to open.
   *
   * It is written from `init.workspace` — the runtime's own answer about where
   * it is — and never from a path this front end assembled. That is the whole
   * point: a value remembered from a request that was never carried out would
   * pin the next launch to a directory no runtime ever opened, which is the bug
   * this is fixing rather than a new instance of it.
   *
   * `null` means "nothing remembered", which is what a first launch has. The
   * first launch then shows the first screen instead of a workspace: there is
   * no honest directory to guess, and the app's own working directory — its
   * install folder — is the one guess that is always wrong.
   */
  lastWorkspace: string | null;
  /**
   * Which saved remote workspace was last worked in, by its entry id.
   *
   * **The remote counterpart of `lastWorkspace`, and it exists because a path
   * cannot be the answer.** A remote workspace's directory is on another
   * machine, so `lastWorkspace` — which `openFirstSession` opens **here** — can
   * never name it; the local path of a remote session would send the next
   * launch looking for a directory that is not on this computer. The entry's id
   * is the only thing that says "that one, over there".
   *
   * `null` means no remote workspace was the last one worked in, which is the
   * ordinary case for somebody who only ever uses local directories. The two
   * fields are **not** exclusive: they answer "where was the work", and the
   * answer may be either. Which one wins is decided by which session was
   * focused last, and the start-up reads the pair together.
   */
  lastRemoteWorkspaceId: string | null;
  /**
   * Start-up arguments, as remembered *defaults for the next start*.
   *
   * These are preferences in the only sense that is honest here: they decide what
   * the next child is started with. They are **not** what is running — that comes
   * from each session's `launch`, which records the arguments that session's child
   * was actually given.
   */
  ericaiDefault: boolean;
  maxStepsDefault: number | null;
  /**
   * Whether session notifications are switched on.
   *
   * A preference like the rest of this record, and read back through
   * `readNotifyEnabled` — which is where the "absent means on" rule lives and is
   * the one preference whose malformed-value fallback is to work rather than to
   * do nothing. See that function.
   */
  notifyEnabled: boolean;
  /**
   * What the window's X button does: ask, minimize, or close.
   *
   * Written only when somebody asks for it to be remembered (the prompt's own
   * checkbox, or the settings row). The default is `ask`, and so is the fallback
   * for a value that is not one of the three — see `readClosePolicy`.
   */
  closePolicy: ClosePolicy;
  /**
   * Task templates and their run links, in the same record as the workspace
   * bookmarks and the remote entries — the desktop's own persistence layer,
   * which is exactly where the Task design says they belong. The runtime has
   * no Task entity and the protocol gains nothing; these are front-end facts.
   *
   * `taskRuns` is capped: each new Run appends one row and the oldest rows fall
   * off past `TASK_RUNS_MAX`, so the record cannot grow without bound over a
   * long life of the app. Deleting a task keeps its links (the design: history
   * must stay traceable), which is why the rows carry their own copies of the
   * task's name and model rather than a live reference.
   */
  tasks: Task[];
  taskRuns: TaskRunLink[];
};

/** Guards one parsed `sshHosts` entry before it is trusted. localStorage
 *  outlives every build, so a record missing a field a newer version added
 *  (or corrupted by hand) is dropped whole rather than let through with a
 *  field silently `undefined` where a string was expected. */
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

/** Same defensive shape as `isValidSshHost`, for `remoteWorkspaces`. */
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

function loadPrefs(): Prefs {
  const fallback: Prefs = {
    quiet: 'off',
    sidebarVisible: true,
    leftbarVisible: true,
    sidebarWidth: null,
    leftbarWidth: null,
    blockCollapsed: { ...EMPTY_BLOCKS },
    blockTouched: {},
    sessionsCollapsed: false,
    workspacesCollapsed: false,
    footCollapsed: true,
    workspaces: [],
    sshHosts: [],
    remoteWorkspaces: [],
    // A first launch has nowhere to go back to, and inventing a directory for
    // it would be worse than opening nothing: the honest answer is the first
    // screen, where a person picks a place.
    lastWorkspace: null,
    lastRemoteWorkspaceId: null,
    // Off, and not because of a coin toss: this flag lets the runtime rewrite
    // `providers.ericai.api_key` in the person's own configuration file and keep a
    // refresh token under `~/.tudouni/`. That is not something to switch on for
    // somebody who has never heard of it.
    ericaiDefault: false,
    // Null is "no `--max-steps` on the command line", which is how the runtime's
    // own default applies. A remembered number would silently outrank it.
    maxStepsDefault: null,
    // On, and the reasoning is in `readNotifyEnabled`: a notifier that starts
    // switched off is a feature nobody finds.
    notifyEnabled: true,
    // Ask. Neither of the other two is safe to apply without being asked for —
    // one ends every session, the other leaves a window the person thinks they
    // closed.
    closePolicy: 'ask',
    // An empty task shelf on a first launch: nothing to run, nothing to show.
    tasks: [],
    taskRuns: [],
  };
  try {
    const raw = localStorage.getItem('aigo.prefs');
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    // Read off the raw record: a legacy build persisted a **boolean** from
    // when the mode was a toggle, and `Partial<Prefs>` would type the field
    // as `QuietMode` and hide that the old value is not one of the three.
    const quietRaw: unknown = (parsed as Record<string, unknown>).quiet;
    return {
      // `true` means the mode was on, which is `normal`. Anything else is `off`.
      quiet:
        quietRaw === 'normal' || quietRaw === 'simple' ? quietRaw : quietRaw === true ? 'normal' : 'off',
      sidebarVisible: parsed.sidebarVisible ?? fallback.sidebarVisible,
      leftbarVisible: parsed.leftbarVisible ?? fallback.leftbarVisible,
      // A number, or nothing. A non-number is not `NaN`-coerced and hoped for:
      // `clampRailWidth` would turn it into a real width and a corrupted record
      // would silently win over a stylesheet default, so the boundary is kept
      // at the parse.
      sidebarWidth:
        typeof parsed.sidebarWidth === 'number' && Number.isFinite(parsed.sidebarWidth)
          ? clampRailWidth(parsed.sidebarWidth)
          : fallback.sidebarWidth,
      // The left rail's, read back under exactly the same boundary — an older
      // build has no `leftbarWidth` at all, which is the `fallback` branch and
      // therefore the stylesheet's own default.
      leftbarWidth:
        typeof parsed.leftbarWidth === 'number' && Number.isFinite(parsed.leftbarWidth)
          ? clampRailWidth(parsed.leftbarWidth)
          : fallback.leftbarWidth,
      blockCollapsed: { ...EMPTY_BLOCKS, ...(parsed.blockCollapsed ?? {}) },
      blockTouched: parsed.blockTouched ?? {},
      // The same boundary as the two around it. A stored `false` is an answer
      // and must survive the launch; anything that is not a boolean is a
      // corrupted record, and `"false"` (truthy) would fold the side rail over
      // a preference the person never set.
      sessionsCollapsed:
        typeof parsed.sessionsCollapsed === 'boolean'
          ? parsed.sessionsCollapsed
          : fallback.sessionsCollapsed,
      workspacesCollapsed:
        parsed.workspacesCollapsed === true || parsed.workspacesCollapsed === false
          ? parsed.workspacesCollapsed
          : fallback.workspacesCollapsed,
      // A stored `false` is an answer ("leave it open") and must survive the
      // launch; the fallback is what a profile that never chose gets, and it is
      // now `true` (the drawer starts folded — see `footCollapsed`'s doc).
      footCollapsed:
        typeof parsed.footCollapsed === 'boolean' ? parsed.footCollapsed : fallback.footCollapsed,
      // Filtered rather than trusted: this is localStorage, it outlives every
      // build, and a stray non-string in it would reach `path.split` and take
      // the sidebar down with it.
      workspaces: (parsed.workspaces ?? []).filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
      ),
      // Validated the same defensive way: localStorage outlives every build,
      // and a malformed record here must not take the sidebar down with it —
      // a host or workspace missing a required string field is dropped
      // whole rather than kept half-formed.
      sshHosts: Array.isArray(parsed.sshHosts)
        ? parsed.sshHosts.filter(isValidSshHost)
        : fallback.sshHosts,
      remoteWorkspaces: Array.isArray(parsed.remoteWorkspaces)
        ? parsed.remoteWorkspaces.filter(isValidRemoteWorkspace)
        : fallback.remoteWorkspaces,
      // Same filter, same reason, and one more: this value decides which child
      // gets started at launch, so a non-string here is not a cosmetic problem.
      // **Not checked against the filesystem**, though — that is `workspace_check`
      // at start-up, which is where a directory that has since been deleted can
      // be answered about. Reading a directory from here would make module load
      // do I/O, and this whole function has to work in a plain browser.
      lastWorkspace:
        typeof parsed.lastWorkspace === 'string' && parsed.lastWorkspace.trim() !== ''
          ? parsed.lastWorkspace
          : null,
      // The remote counterpart. An id that names no saved workspace is not
      // restored — the entry may have been forgotten while the field was still
      // written, and offering a workspace that no longer exists would send the
      // start-up to a place that cannot be opened. The start-up checks the
      // entry itself before using this, so a stale id is simply ignored.
      lastRemoteWorkspaceId:
        typeof parsed.lastRemoteWorkspaceId === 'string' &&
        parsed.lastRemoteWorkspaceId.trim() !== ''
          ? parsed.lastRemoteWorkspaceId
          : null,
      // Same rule as `workspaces`, and for the same reason: this is localStorage,
      // it outlives every build, and a string where a boolean belongs would reach
      // a `?` branch that treats any truthy value as "on".
      ericaiDefault: parsed.ericaiDefault === true,
      // A positive whole number, or nothing. Zero and negatives are refused here
      // rather than passed on: the Rust side only forwards `> 0` (see `spawn`), so
      // remembering one would display a value that is silently not in force.
      maxStepsDefault:
        typeof parsed.maxStepsDefault === 'number' &&
        Number.isInteger(parsed.maxStepsDefault) &&
        parsed.maxStepsDefault > 0
          ? parsed.maxStepsDefault
          : null,
      // Through the readers, not inline: both have a fallback that is a
      // deliberate decision rather than a default (`absent means on`, and
      // `anything unrecognised means ask`), and restating either here would put
      // a second copy of the rule where only one of them would be updated.
      notifyEnabled: readNotifyEnabled(parsed.notifyEnabled),
      /** @see readClosePolicy for why an unrecognised value means `ask`. */
      closePolicy: readClosePolicy(parsed.closePolicy),
      // Each record guarded on its own shape; a malformed one is dropped whole
      // rather than let through with an `undefined` field. localStorage
      // outlives every build, and these are records a person came to trust.
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter(isValidTask) : [],
      taskRuns: Array.isArray(parsed.taskRuns) ? parsed.taskRuns.filter(isValidTaskRun) : [],
    };
  } catch {
    return fallback;
  }
}


export function persistPrefs(s: AppStore, quiet?: { key: string; value: QuietMode }): void {
  try {
    localStorage.setItem(
      'aigo.prefs',
      JSON.stringify({
        // Quiet is per session now, so the remembered value is the active
        // session's — it is the one a person just changed, and it is what a
        // fresh session should start from.
        quiet: quiet ? quiet.value : s.sessions[s.activeKey ?? '']?.quiet ?? 'off',
        sidebarVisible: s.sidebarVisible,
        leftbarVisible: s.leftbarVisible,
        sidebarWidth: s.sidebarWidth,
        leftbarWidth: s.leftbarWidth,
        blockCollapsed: s.blockCollapsed,
        blockTouched: s.blockTouched,
        sessionsCollapsed: s.sessionsCollapsed,
        workspacesCollapsed: s.workspacesCollapsed,
        footCollapsed: s.footCollapsed,
        workspaces: s.workspaces,
        sshHosts: s.sshHosts,
        remoteWorkspaces: s.remoteWorkspaces,
        lastWorkspace: s.lastWorkspace,
        lastRemoteWorkspaceId: s.lastRemoteWorkspaceId,
        ericaiDefault: s.ericaiDefault,
        maxStepsDefault: s.maxStepsDefault,
        notifyEnabled: s.notifyEnabled,
        closePolicy: s.closePolicy,
        tasks: s.tasks,
        taskRuns: s.taskRuns,
      }),
    );
  } catch {
    /* Private mode: preferences simply do not persist. */
  }
}

export const prefs = loadPrefs();
