/**
 * Global state.
 *
 * The split (§6.1) is still the whole design here, and multi-session adds a
 * third axis to it:
 *
 *   - **Runtime facts** are written only by `applyRuntimeMessage`. The front end
 *     stores them, it never invents them.
 *   - **Front-end preferences** (sidebar and block folding, the workspace list)
 *     are presentation choices and not runtime state.
 *   - **Each fact belongs to a session.** A runtime fact is never "the model" —
 *     it is "the model *in this conversation*". So the facts live in
 *     `sessions[key]` and `activeKey` decides only which bucket is **drawn**.
 *     That separation is what makes two conversations able to run at once: a
 *     message arriving for a session nobody is looking at still lands in its own
 *     bucket, and switching the display changes no fact at all.
 *
 * And two prohibitions, both unchanged:
 *   - **no optimistic updates.** Pressing "always allow" sends an outbound
 *     message and nothing else; the display changes when `ui(state)` comes back.
 *   - **nothing is inferred from `activeKey`** except what to draw. If a value
 *     can be computed from the message, it is stored when the message arrives,
 *     not when the session becomes visible — otherwise a background session's
 *     history depends on when somebody happened to look at it.
 */

import { create } from 'zustand';
import type {
  FileEntry,
  FrontendMsg,
  ModelAlias,
  PermissionDecision,
  PermissionRequestMsg,
  PermissionScope,
  QuestionRequestMsg,
  QuestionStatus,
  RuntimeMsg,
  SkillCatalogRow,
  TerminalRow,
} from '@/protocol/types';
import {
  applyDelta,
  applyFinalAnswer,
  clearStream,
  hasRunningTurn,
  lastStopReason,
  nextId,
  pushBlock,
  reduceEvent,
  settleAbandonedTurn,
  type BlockKind,
  type Entry,
  type LooseEvent,
  type NoteEntry,
  type ToolFacts,
} from '@/state/entries';
import {
  cacheHitRate,
  phaseFromStopReason,
  projectContext,
  projectInit,
  projectSessionList,
  projectSkillsMsg,
  projectState,
  mergeSkills,
  projectStatus,
  projectToolsMsg,
  projectMcpMsg,
  projectCompacted,
  projectHistory,
  type Phase,
  type VmContext,
  type VmCompaction,
  type VmInitTool,
  type VmJob,
  type VmMcp,
  type VmModel,
  type VmRiskScope,
  type VmSessionListItem,
  type VmSkill,
  type VmState,
  type VmStatus,
  type VmSubagent,
  type VmTool,
} from '@/runtime/adapt';
import {
  registerRuntime,
  sendTo,
  unregisterRuntime,
} from '@/runtime/bus';
import { insertPathAtCaret, type PastedImage } from '@/runtime/paste';
import { baseName, samePath } from '@/utils/format';
import {
  attachRuntime,
  chooseWorkspaceDirectory,
  createTauriRuntime,
  quitApp,
  readRuntimeStderr,
  shutdownRuntime,
  stashImage,
  type BridgeOptions,
} from '@/runtime/tauri';

/* ============================================================
   Constants that belong to the presentation layer
   ============================================================ */

/** The throttle floor for polling the runtime (decision 5). `status` reads the
 *  audit log, so it must not become a heartbeat. */
export const POLL_FLOOR_MS = 2000;

/** How much of the child's stderr to keep for the start-up diagnostics panel.
 *  A tail: the last lines are what explain a refusal, and the first ones are
 *  usually the banner. */
export const STDERR_TAIL = 60;

export type PanelKind =
  | 'commands'
  | 'model'
  | 'effort'
  | 'resume'
  | 'mcp'
  | 'skills'
  | 'help'
  | 'subagents'
  | 'audit'
  | 'settings'
  /* The workspace's two capabilities. They are panels rather than windows
   * because they share the app's one interaction model (§5), and because
   * neither is a destination: a person opens one, looks, and goes back. */
  | 'files'
  | 'terminal';

export type SidebarBlockKey = 'goal' | 'tasks' | 'skills' | 'jobs' | 'mcp';

export const SIDEBAR_BLOCKS: SidebarBlockKey[] = ['goal', 'tasks', 'skills', 'jobs', 'mcp'];

/**
 * A blocking request, with the session it came from.
 *
 * The key is not decoration and cannot be recovered later: `permission_request`
 * and `question_request` carry no `session_id`
 * (`protocol/schema/outbound.schema.json`), so the only thing that says whose
 * question this is, is the connection it arrived on. Answering the wrong one
 * hangs the session that actually asked — the runtime waits on that id forever —
 * and lets the other one run on an answer nobody gave.
 */
export type ModalEntry =
  | { kind: 'permission'; key: string; req: PermissionRequestMsg }
  | { kind: 'question'; key: string; req: QuestionRequestMsg };

export type ModalState = ModalEntry | null;

/**
 * What the composer's control row is currently saying, as a **code plus its
 * parameters** rather than a finished sentence.
 *
 * Codes rather than text because the sentence is `i18n`'s job and the store has
 * no business holding English; parameters rather than pre-joined strings because
 * a list of file names is punctuation the translation owns. The renderer turns
 * one of these into one line.
 *
 * `warn` versus `info` is carried here because it is a property of the *fact*,
 * not of the rendering: a refused drop and "a drag is over the window" are
 * different kinds of statement, and deciding that in CSS would make the styling
 * the source of truth.
 */
export type ComposerNotice =
  /** Paths dropped from outside the workspace, or with no workspace at all. */
  | { code: 'drop-outside'; names: string[]; tone: 'warn' }
  | { code: 'drop-no-workspace'; names: string[]; tone: 'warn' }
  /** A paste refused before anything was written. */
  | { code: 'paste-no-workspace'; tone: 'warn' }
  | { code: 'paste-at-capacity'; limit: number; tone: 'warn' }
  | { code: 'paste-too-large'; size: string; limit: string; tone: 'warn' }
  | { code: 'paste-not-an-image'; tone: 'warn' }
  /** The picture was written, but the model cannot be shown one. Not a refusal:
   *  the turn still runs, exactly as the runtime's own `refused` row says. */
  | { code: 'paste-no-vision'; model: string; tone: 'info' }
  /** The bridge refused or failed to write it. The runtime's sentence, verbatim. */
  | { code: 'paste-failed'; reason: string; tone: 'warn' };

/**
 * Why the window came up with nothing open.
 *
 * A code rather than a sentence, for the same reason `ComposerNotice` is: the
 * words belong to `i18n`. It exists because "nothing opened" now has a cause
 * that is a *decision* rather than a failure — the workspace last worked in is
 * gone, or the runtime refused it — and the first screen is where a person is
 * standing when they need to be told. It is drawn there instead of covering the
 * window, because unlike `startupProblem` it is not a reason the application
 * cannot run: the workspace list beside it works.
 */
export type StartupNotice =
  /** The remembered workspace is gone, or the runtime refuses it. `path` is the
   *  one remembered, so the sentence can name it. */
  | { code: 'last-workspace-gone'; path: string; reason: string }
  /** Something asked for a session and there was no workspace to put it in —
   *  no active session, and nothing remembered. The refusal is deliberate (see
   *  `attachSession`), so it has to be visible: a button that does nothing at
   *  all is the failure mode this whole change exists to remove. */
  | { code: 'no-workspace' };

/**
 * What a child was actually started with.
 *
 * **A record of this front end's own act, not a claim about the runtime.** It says
 * "this is the argv I passed", which is a fact this window really has — the runtime
 * sends nothing back about it, and `init` has no field for it. That is exactly why
 * it is safe to draw: it is not a second source for anything the runtime states.
 *
 * It is what the settings panel shows. A remembered preference is *not*: a value
 * remembered for next time must never read as "this is on now".
 */
export interface LaunchArgs {
  /** `--ericai` was on the command line. */
  ericai: boolean;
  /** `--max-steps <n>`, or null when the flag was left off. */
  maxSteps: number | null;
}

/** The session as the handshake describes it. Flat on the wire, kept flat here. */
export interface SessionInfo {
  id: string;
  resumed: boolean;
  model: string;
  provider: string;
  thinking: boolean;
  effort: string;
  effortLevels: string[];
  /** Cumulative steps for this session. It comes from `ui(state).steps`; the
   *  handshake does not carry it. */
  steps: number;
  /** The session as the handshake describes it. Flat on the wire, kept flat here. */
  maxSteps: number;
  stream: boolean;
  workspace: string;
  /** The denominator for the usage percentage. Null means: report the amount
   *  only, never a percentage. */
  contextTokens: number | null;
  auditPath: string;
  /** Only the non-default entries. An ordinary run sends none. */
  permissions: PermissionScope;
  protocol: number;
}

/**
 * One session's runtime facts, and its own input state.
 *
 * Every field here is per session, including the ones that used to be window
 * preferences. `quiet` and the composer's draft are the two that look like
 * preferences and are not: quiet mode says how *this conversation's* stream is
 * drawn, and the draft is what somebody was about to say *in this
 * conversation*. Sharing either across sessions means two conversations
 * interrupting each other.
 */
export interface SessionRuntime {
  /** The bridge's key for this child. The handle for everything below. */
  key: string;
  /**
   * The runtime's own session id, from `init`.
   *
   * Null until the handshake lands, and that is not a gap to paper over: a new
   * session's id is minted by the runtime (`store.NewSessionID`), so before
   * `init` there is genuinely no id to know. `sessionId → key` is built from
   * this, which is how "open the saved session S" finds a child that already has
   * it open.
   */
  sessionId: string | null;
  /** The workspace this child was started in. A property of the process. */
  workspace: string;
  /** The handshake has landed. */
  ready: boolean;
  /**
   * Why **this** session would not start, as a sentence.
   *
   * Per session because the refusals are: a workspace the runtime will not take,
   * an invalid `--session`, a binary that is present but will not execute. None
   * of those is a reason to take over a screen where another session is happily
   * running, which is what the single window-wide field used to do.
   */
  problem: string | null;
  /** This child's stderr, verbatim, bounded. Diagnostics, never protocol data. */
  stderrTail: string[];
  /** Set when this child ends without being asked to. */
  runtimeExit: { code: number; requested: boolean } | null;
  /** What this child was started with. See `LaunchArgs`. */
  launch: LaunchArgs;

  session: SessionInfo | null;
  sessionList: VmSessionListItem[];
  listedSessions: boolean;
  /** A local fact: has this session been spoken to. "Never spoken" and "idle"
   *  are two different labels in the status bar. */
  hasSpoken: boolean;
  /** Wall time of the last finished turn. Local: `run_finished` carries
   *  `duration_ms` and that is what this is set from. */
  lastTurnMs: number | null;

  entries: Entry[];
  /**
   * The handshake's own sentences (`init.notices`).
   *
   * They live **outside** `entries` because of the ordering: `init` is always
   * followed immediately by `session_load`, which rebuilds the whole transcript
   * from the stored session and would otherwise wipe the runtime's diagnostics —
   * "no ripgrep", "no model configured", "this MCP server did not attach" —
   * before a single frame was drawn. They are merged back at the head of the
   * stream when `session_load` arrives.
   */
  handshakeNotices: NoteEntry[];
  activeRunId: string | null;
  lastRunId: string | null;
  /**
   * Lines the decoder refused, for this session.
   *
   * Kept apart from `lateDropped` because the two answer different questions and
   * the panel's label said "late messages" over their sum. A half-written line
   * (the writer was killed) is a fact about the transport; a message attributed
   * to another turn is a fact about ordering. Adding them together made a
   * delegation — whose records carry the child's id — look like an ordering
   * problem that never happened.
   */
  dropped: number;
  /** Messages that really were late or out of order, counted separately. */
  lateDropped: number;
  /**
   * The turn ended while this session was **not** on screen.
   *
   * This is what the left rail's blue dot says, and it is the one thing a
   * three-colour scheme cannot express: a background session that finished a
   * long task is not running, is not asking for anything and has not failed —
   * so with only green/amber/red it would show **nothing**, at exactly the
   * moment when "it is done, come and look" is the most useful thing to know.
   *
   * Cleared when the session becomes `activeKey`. **Never persisted**: "you have
   * not looked at this yet" is not a fact that survives a restart.
   */
  unseen: boolean;

  uiState: VmState | null;
  status: VmStatus | null;
  context: VmContext | null;
  compaction: VmCompaction | null;
  tools: VmTool[];
  /**
   * The registry as the handshake carries it (`init.tools`).
   *
   * A `tool_call` event carries no risk of its own — it is looked up. Keeping
   * this is what lets a tool row be drawn with its risk badge **before**
   * `ui(tools)` has ever been asked for, which used to be the only source.
   */
  toolRegistry: VmInitTool[];
  grantedPrefixes: string[];
  mcp: VmMcp[];
  mcpNotes: string[];
  /**
   * Servers with a load/unload request in flight.
   *
   * Mounting is a real round trip: the runtime waits the running turn out and
   * then connects, which can take seconds. A row that looked untouched for that
   * long invites a second press on a server that is already coming up.
   *
   * This is not an optimistic update: it claims nothing about the server's
   * state — the badge still comes only from `ui(state)`. It states one fact
   * this front end really has, which is that it just sent the request.
   */
  mcpPending: string[];
  skills: VmSkill[];
  /** Everything this session can load (`ui(skills).skills`) — the catalogue.
   *  Distinct from `skills`, which is what is *loaded*. */
  skillAvailable: VmSkill[];
  /** The loaded names, in load order (`ui(skills).active`). Kept so a later
   *  `ui(state)` can re-merge without losing them. */
  skillActive: string[];
  skillCatalog: SkillCatalogRow[];
  skillProblems: string[];
  skillShadowed: string[];
  models: VmModel[];
  modelAliases: ModelAlias[];

  /**
   * The workspace's terminals, from `ui(terminals)` **and** every `ui(state)`.
   *
   * Two sources for one fact on purpose (see the runtime's `terminalsPanel`):
   * the snapshot is sent on every tool result and at the end of every turn, so a
   * front end that started after a shell was created — or that lost a message —
   * learns about it from the next snapshot rather than never.
   *
   * Per **session** bucket although terminals belong to the workspace, and the
   * distinction matters: this is "what this child told me", which is the only
   * thing a bucket can hold. Two sessions in one workspace each hear the same
   * list from their own child, and neither is wrong.
   */
  terminals: TerminalRow[];
  /**
   * Which terminal this session's terminal view is attached to.
   *
   * A **front-end** preference, like `draft`: the design says a client may keep
   * `active_terminal_id` and nothing else about a terminal. The process, the cwd
   * and the status all remain the runtime's, and this never guesses at any of
   * them.
   */
  activeTerminalId: string | null;
  /**
   * What this session's front end has seen of each attached terminal's output.
   *
   * A **bounded** tail, newest last. The runtime keeps no scrollback — the design
   * is explicit that a terminal's output must not become a second terminal — so
   * showing more than the last screenful is necessarily this end's job.
   *
   * Keyed by terminal id rather than held for one: switching between two shells
   * and back should not lose the first one's screen.
   */
  terminalOutput: Record<string, string[]>;
  /**
   * Terminals with a create or kill request in flight.
   *
   * Not an optimistic update: it claims nothing about a terminal's state — the
   * badge still comes only from the runtime. It states one fact this front end
   * really has, which is that it just sent the request.
   */
  terminalPending: string[];

  /**
   * The browser's listing, and whether its answer has arrived.
   *
   * `filesLoading` is separate from an empty `filesEntries` on purpose: "this
   * directory is empty" and "the answer has not come back yet" are different
   * statements, and a panel that drew the first while the second was true would
   * send somebody looking for files that are there.
   */
  filesPath: string;
  filesEntries: FileEntry[];
  filesLoading: boolean;

  /* ---------------- this session's own input state ---------------- */
  draft: string;
  history: string[];
  historyCursor: number | null;
  /** See `ComposerNotice`. */
  composerNotice: ComposerNotice | null;
  /**
   * Pictures pasted into the current draft.
   *
   * A **front-end preference**, not a runtime fact: the runtime never hears about
   * a chip. The chips are drawn from these, but *which* are drawn is decided by
   * the draft text (`referencedImages`), because the text is the only thing that
   * gets sent — so deleting a path from the sentence drops its chip, and there is
   * no second source of truth to fall out of step.
   *
   * Per session because the path in the sentence is **workspace-relative**, and
   * two sessions may be in different workspaces: the same string names a
   * different place, or nothing at all.
   */
  pastedImages: PastedImage[];
  /**
   * Quiet mode for this session's stream.
   *
   * Per session, and that is a change from when it was one window preference. It
   * says how *this conversation's* tool calls are drawn (collapsed to one line
   * each), so it is a statement about the conversation rather than about the
   * window — and it sits next to the autopilot toggle in the status bar, which is
   * per session. Two identical-looking controls on one row, one of which changed
   * with the session and one of which did not, was a trap.
   */
  quiet: boolean;
}

/**
 * A fresh bucket for a session whose child has just been started.
 *
 * Exported because a bucket is a real thing to need outside this module: the
 * tests build one to exercise the reducer without a process, and that is a
 * better answer than a test-only back door into the store. It is exactly the
 * shape `attachSession` installs once the bridge accepts a child — no field is
 * filled in differently for a test.
 */
export function createSessionBucket(
  key: string,
  workspace: string,
  launch: LaunchArgs,
): SessionRuntime {
  return {
    key,
    sessionId: null,
    workspace,
    ready: false,
    problem: null,
    stderrTail: [],
    runtimeExit: null,
    launch,
    session: null,
    sessionList: [],
    listedSessions: false,
    hasSpoken: false,
    lastTurnMs: null,
    entries: [],
    handshakeNotices: [],
    activeRunId: null,
    lastRunId: null,
    dropped: 0,
    lateDropped: 0,
    unseen: false,
    uiState: null,
    status: null,
    context: null,
    compaction: null,
    tools: [],
    toolRegistry: [],
    grantedPrefixes: [],
    mcp: [],
    mcpNotes: [],
    mcpPending: [],
    skills: [],
    skillAvailable: [],
    skillActive: [],
    skillCatalog: [],
    skillProblems: [],
    skillShadowed: [],
    models: [],
    modelAliases: [],
    // Terminals belong to the workspace, but "what this child told me" is the
    // only thing a bucket can hold — see the field's own comment.
    terminals: [],
    activeTerminalId: null,
    terminalOutput: {},
    terminalPending: [],
    filesPath: '',
    filesEntries: [],
    filesLoading: false,
    draft: '',
    history: [],
    historyCursor: null,
    composerNotice: null,
    pastedImages: [],
    quiet: prefsQuietDefault(),
  };
}

/** Quiet mode's starting value for a fresh session. A preference, read once. */
function prefsQuietDefault(): boolean {
  try {
    const raw = localStorage.getItem('aigo.prefs');
    if (!raw) return false;
    return (JSON.parse(raw) as { quiet?: unknown }).quiet === true;
  } catch {
    return false;
  }
}

export interface AppStore {
  /* ---------------- the runtime link ---------------- */
  /**
   * Every session with a live child, by key.
   *
   * Membership is "this session has a process right now". A session that exists
   * only as a file on disk is in `sessions[x].sessionList`, not here — and that
   * distinction is what the left rail's status dots are built on: **no process,
   * no state**.
   */
  sessions: Record<string, SessionRuntime>;
  /** Display order for the left rail. Appended when a session is started. */
  order: string[];
  /** Which session is drawn. **It decides nothing else.** */
  activeKey: string | null;

  /** The runtime's own version, read once via `--version` at start-up. `dev`
   *  when it was not a release build — shown as-is, not prettified. */
  runtimeVersion: string | null;
  /** This application's version. Its own, independent of the runtime's. */
  desktopVersion: string;
  /** From the OS, so the greeting can use a name. Empty when unavailable. */
  userName: string;
  /**
   * Why the runtime could not be started at all, as a sentence.
   *
   * **Window-level, unlike `SessionRuntime.problem`.** These are the refusals
   * that are true of every session: no binary next to the application, a
   * protocol envelope this build cannot speak, listeners that would not
   * register. `resolve_binary` hands every child the same path, so those either
   * fail for all sessions or for none — and when they do, a full-screen
   * explanation is the honest thing rather than a note on one row.
   */
  startupProblem: string | null;
  /**
   * Why nothing was opened at start-up, when that is worth saying.
   *
   * Separate from `startupProblem` because the two are read differently. A
   * `startupProblem` covers the window — there is no runtime, so there is
   * nothing else to show. This one rides on the **first screen**, beside a
   * workspace list that works: see `StartupNotice`.
   */
  startupNotice: StartupNotice | null;

  /* ---------------- modals / panels ---------------- */
  /** The request being answered right now — the head of `pendingModals`. */
  modal: ModalState;
  /**
   * Requests that arrived while another was already up.
   *
   * `modal` used to be the only slot, and both request kinds wrote straight into
   * it. A second blocking request therefore replaced the first, and since the
   * runtime waits forever on the id it asked about, the replaced one was lost
   * *and* hung. The queue holds them so the head can be answered and the next
   * one promoted, in arrival order.
   *
   * With several sessions this is not an edge case any more: two conversations
   * can both be waiting, and the queue is what keeps the second one visible
   * instead of silently stacked behind the first.
   */
  pendingModals: ModalEntry[];
  /** One panel at a time, and that is a window fact rather than a session one. */
  panel: PanelKind | null;

  /* ---------------- front-end preferences (window-level) ---------------- */
  sidebarVisible: boolean;
  /**
   * The **left** sidebar (workspaces and sessions).
   *
   * Kept separate from `sidebarVisible`, which is the right-hand one (goal,
   * tasks, skills, jobs, MCP). They answer different questions — "where am I
   * working and in which conversation" versus "what is this turn doing" — and
   * folding one is not a request to fold the other. Sharing a flag meant hiding
   * the workspace list also hid the permission scope and the task list.
   */
  leftbarVisible: boolean;
  blockCollapsed: Record<SidebarBlockKey, boolean>;
  blockTouched: Partial<Record<SidebarBlockKey, boolean>>;
  blockAutoExpanded: Partial<Record<SidebarBlockKey, boolean>>;
  /**
   * Which reasoning blocks and tool rows are open, by entry id.
   *
   * Window-level, and it does not need to be otherwise: `nextId` in `entries.ts`
   * is a module-level counter, so entry ids are unique across sessions and one
   * map cannot collide with itself.
   */
  reasoningOpen: Record<string, boolean>;
  toolOpen: Record<string, boolean>;
  /**
   * The left rail's session list, folded on its own. A front-end preference:
   * the protocol has no opinion on how a rail is arranged. The workspace list
   * above it never folds with it — the two answer different questions, and
   * "where am I" has to survive folding the conversation list.
   */
  sessionsCollapsed: boolean;
  /**
   * Bookmarked workspaces.
   *
   * **A front-end preference, and it has to be.** The protocol carries no
   * workspace list, and it could not usefully carry one: a workspace is the
   * child's working directory, so changing it means a different process rather
   * than a message (§3.2 of the design). What the runtime *does* state is which
   * workspace a session is **in** — `init.workspace` — and that is a runtime
   * fact, read from the session rather than from this list.
   *
   * So this is a list of places a person can go, not a claim about where any
   * runtime is. The two are drawn together (a row is marked current when the
   * active session is in it) but they are never conflated.
   */
  workspaces: string[];
  /**
   * The workspace the **next** launch should open: the one last worked in.
   *
   * Also a front-end preference, and also kept apart from `workspaces` — this
   * one is a *default*, and it may name a directory that was never bookmarked.
   * It is written from `init.workspace` (the runtime's own answer about where a
   * session is) rather than from a path this front end assembled, so what is
   * remembered is somewhere a runtime has actually opened. `null` on a first
   * launch, which is what makes the first screen the right thing to show.
   *
   * See `Prefs.lastWorkspace` for why it is never cleared when its directory
   * disappears.
   */
  lastWorkspace: string | null;

  /* ---------------- remembered start-up arguments ---------------- */
  /**
   * The remembered defaults the *next* child is started with.
   *
   * Kept apart from each session's `launch` deliberately, and the two are never
   * merged in the display: a value remembered for next time must not read as
   * "this is on now", the same way a bookmarked workspace must not read as the
   * current one.
   */
  ericaiDefault: boolean;
  maxStepsDefault: number | null;

  /* ---------------- composer ---------------- */
  /** An OS drag is currently over the window. Purely local, purely visual. */
  dragging: boolean;

  /* ---------------- actions ---------------- */

  /**
   * Record the workspace the next launch should open, and persist it.
   *
   * Called with the runtime's own `init.workspace` for the session in front —
   * never with a path this front end assembled — so what is remembered is a
   * directory a runtime has actually opened, not a request that may never have
   * been carried out.
   */
  rememberWorkspace(path: string): void;
  /**
   * Say why the window came up empty, when that needs saying.
   *
   * Distinct from `startupProblem`: that one is a failure that covers the
   * screen, because without a runtime there is nothing to show. This is a
   * *note* that belongs on the first screen — nothing opened, and here is why —
   * while the workspace list stays perfectly usable.
   */
  setStartupNotice(notice: StartupNotice | null): void;

  /**
   * Start a new session's child.
   *
   * The workspace is, in order: the caller's, the active session's (from
   * `init.workspace` — the runtime's own answer), the remembered one. **There is
   * no fourth fallback.** A session with no workspace is not started at all:
   * handing the bridge nothing makes it use the *process's* working directory,
   * which for a packaged application is its own install folder.
   *
   * **It adds a session; it does not replace one.** That is the change that makes
   * the first target scenario work: opening a second conversation while the
   * first is mid-turn leaves the first alone, because nothing here reaches for
   * any other child.
   *
   * Resolves with the new key, or null when there is no bridge (a plain browser)
   * or when the start was refused — the refusal having been put on the new
   * session's own `problem`, not on the window.
   */
  attachSession(options?: Partial<BridgeOptions>): Promise<string | null>;
  /** Focus a live session. **Sends nothing**: switching the display is local. */
  focusSession(key: string): void;
  /**
   * Stop one session's child and forget its bucket.
   *
   * Deliberately not part of `focusSession`: closing a conversation is a
   * different act from looking at another one, and with several open the two
   * must not be reachable by the same gesture.
   */
  detachSession(key: string): Promise<void>;
  /**
   * Open a saved session: focus the child that already has it open, or start
   * one on it.
   *
   * `sessionId` is the runtime's id from `sessions.items`. A null id means "a
   * new conversation", which is a session with no id at all — the missing id
   * *is* the new-session request, and the runtime mints one.
   */
  openSession(sessionId: string | null, workspace?: string): Promise<void>;

  /** Send one message to the active session. */
  send(msg: FrontendMsg): void;
  /**
   * Take one runtime message, tagged with the session whose child sent it.
   *
   * The key is a parameter rather than something read off `msg` because most
   * messages do not carry one: `session_load`, every `ui` kind, `notice`,
   * `sessions` and both blocking requests are missing `session_id`. Attribution
   * comes from the connection, which is the only place it exists.
   */
  applyRuntimeMessage(key: string, msg: RuntimeMsg): void;
  /** Read once at start-up; not part of the protocol. `version` is the
   *  runtime's own (`--version`), null when it could not be read. */
  setRuntimeInfo(info: { version: string | null; userName: string | null }): void;

  /** Record why the runtime could not be started at all, or clear it. */
  setStartupProblem(problem: string | null): void;
  /** Append one stderr line to a session's tail. Bounded: a tail, not a log. */
  pushStderr(key: string, line: string): void;
  /**
   * Count one line the decoder refused, for the session that sent it.
   *
   * Per session because the count is a statement about that child's stream — a
   * half-written line means that writer was killed — while the *fatal* case
   * (an envelope version mismatch) is a statement about the window and goes to
   * `startupProblem` instead.
   */
  countDrop(key: string): void;
  /** Record a session's own start-up refusal. */
  setSessionProblem(key: string, problem: string | null): void;
  /** Retry a session that failed to start, in the same workspace. */
  retrySession(key: string): Promise<void>;
  /**
   * Retry whatever the full-screen start-up screen is about.
   *
   * Two cases, and both reach that screen. A **window-level** refusal (no binary,
   * a protocol envelope this build cannot speak) is preceded by no session at
   * all, so the retry is "try to open a first one". A session-level one is
   * retried on its own row instead — this action exists for the screen that
   * covers the whole window, which is the window-level case.
   */
  retryStartup(): Promise<void>;
  /**
   * Quit the application: finish every runtime, then close the window.
   *
   * One path for `Ctrl+C`, `/exit` and any future quit affordance. It goes
   * through the **bridge's** shutdown rather than a bare `shutdown` protocol
   * message, because only the bridge sets `requested = true` on the exit event —
   * which is the whole difference between "the session ended" and a red "Runtime
   * exited (code 0)" shown to somebody who deliberately asked it to stop.
   */
  quit(): Promise<void>;

  setDraft(v: string): void;
  historyNav(dir: -1 | 1): void;
  submitDraft(): void;
  interrupt(): void;
  /** A file drag entered or left the window. */
  setDragging(on: boolean): void;
  /** Record (or clear) what the composer is saying about this input. */
  setComposerNotice(notice: ComposerNotice | null): void;
  /**
   * Write one pasted picture into the active session's workspace and put its
   * path in that session's draft.
   *
   * `bytes` are the clipboard's, already checked by the caller against the three
   * gates in `runtime/paste.ts` — the checks live there because they must produce
   * a sentence, and a store action has no way to render one.
   *
   * `at` is the caret the insertion goes to. It is passed in rather than read from
   * the DOM here because this module never touches the DOM, and because the caller
   * (the paste handler) is the one that knows where the caret was at the moment
   * the paste happened.
   *
   * **Returns where the caret should go**, or `null` when nothing was inserted
   * (a refusal, or the bridge failing). The caller owns the textarea, so it is the
   * caller that moves the caret; handing the number back is how the two stay in
   * step without this module reaching into a DOM node it does not own.
   */
  stashPastedImage(bytes: Uint8Array, at: number): Promise<number | null>;
  /** Forget one stashed picture. Called when its chip is dismissed. */
  forgetPastedImage(path: string): void;
  /** Drop every stashed picture of the active session, releasing their URLs. */
  clearPastedImages(): void;

  openPanel(p: PanelKind | null): void;
  setQuiet(q: boolean): void;
  toggleQuiet(): void;
  toggleSidebar(): void;
  setSidebarVisible(v: boolean): void;
  toggleLeftbar(): void;
  setLeftbarVisible(v: boolean): void;
  toggleBlock(k: SidebarBlockKey): void;
  /** Fold or unfold the left rail's session list. Persisted like the rails. */
  toggleSessionsCollapsed(): void;
  toggleReasoning(id: string): void;
  toggleTool(id: string): void;
  /** Remove one in-stream block from the active session. No data involved. */
  removeBlock(id: string): void;

  answerPermission(decision: PermissionDecision): void;
  answerQuestion(status: QuestionStatus, text: string): void;

  requestSessionList(): void;
  /** Delete one saved session. The list updates when the runtime's next
   *  `sessions` arrives — never on send (no optimistic removal). */
  deleteSession(id: string): void;
  setAutopilot(on: boolean): void;
  chooseModel(model: string): void;
  chooseEffort(effort: string): void;
  setThinking(on: boolean): void;
  requestBlock(which: BlockKind): void;
  requestMcp(action: 'list' | 'load' | 'unload', servers: string[]): void;
  requestSkills(): void;
  goalAction(action?: 'pause' | 'resume' | 'clear'): void;
  refreshState(): void;

  /* ---------------- the workspace: files ---------------- */

  /**
   * List one directory level of the active session's workspace.
   *
   * An empty path is the workspace root. The answer replaces the browser's
   * entries and — importantly — its **path**: the runtime normalises what it was
   * given, and the reply's spelling is what makes "where am I" answerable after
   * a `/./src/../src`.
   */
  listFiles(path: string): void;
  /** Read one file. The reply's head goes in the viewer and its `artifact_id`
   *  names the body on disk; the whole file is never sent. */
  readFile(path: string): void;

  /* ---------------- the workspace: terminals ---------------- */

  /** Ask for the workspace's terminal list. */
  listTerminals(): void;
  /**
   * Open a shell.
   *
   * `cwd` is workspace-relative and optional; so is the size, which the runtime
   * turns into the conventional 80x24. A refusal produces a notice and an
   * **unchanged list**, never a `terminal_created` — a front end given a row
   * would remember an id for a shell that does not exist.
   */
  createTerminal(options?: { cwd?: string; cols?: number; rows?: number }): void;
  /**
   * Write raw bytes to a shell.
   *
   * **No reply.** The output arrives asynchronously, which is the whole shape of
   * a terminal: `command → PTY → stream`. Nothing is buffered or interpreted
   * here — `Ctrl+C`, arrows and Tab are just bytes.
   */
  terminalInput(id: string, data: string): void;
  /** Tell the runtime the shell's new window size. Required for `vim`, `top`,
   *  `htop` and `less`, which lay themselves out from it. */
  resizeTerminal(id: string, cols: number, rows: number): void;
  /** End a terminal and everything it started. The transcript's line comes from
   *  the runtime's exit event, never from this request. */
  killTerminal(id: string): void;
  /** Point this front end's terminal view at one terminal. A **local** act:
   *  nothing is sent, and the shell is unaffected either way. */
  attachTerminal(id: string | null): void;
  /** Ask the OS for a directory, then open a session in it. A different
   *  workspace is a different process, so this cannot be done to an existing
   *  one. */
  pickWorkspace(): Promise<void>;
  /** Go to a workspace already in the list: focus a live session there, or
   *  start one. */
  enterWorkspace(path: string): Promise<void>;
  /** Bookmark a workspace. A local act: nothing is started and nothing moves. */
  addWorkspace(path: string): void;
  /** Forget a bookmark. It does not touch the directory, and it does not stop
   *  any session running in it — a workspace being *listed* and being *in use*
   *  are two different things. */
  removeWorkspace(path: string): void;
  /** Look up a tool's facts for the active session's stream rows. */
  toolFacts(name: string): ToolFacts | null;

  /**
   * Start a session with the given start-up arguments, and remember them.
   *
   * **A new child rather than a message**, and that is forced by the runtime
   * rather than chosen here: `--ericai` decides at open which route the session
   * manages (`internal/runtime/composition.go`, `Options.EricAI`), and
   * `--max-steps` is read into the agent at assembly. Neither can be honoured by
   * a running child.
   *
   * The caller is responsible for having asked first — this is the act, not the
   * confirmation. It is not allowed while a blocking prompt is up: a new child
   * is a new session, and opening one under a prompt is a way to lose track of
   * what is waiting. (It no longer risks anybody's turn: nothing here touches
   * another session's process.)
   *
   * Resolves once the bridge has accepted the new child. A failure lands in that
   * session's `problem`, which is one place, and not on the window.
   */
  applyLaunch(next: LaunchArgs): Promise<void>;
}

const EMPTY_BLOCKS: Record<SidebarBlockKey, boolean> = {
  goal: false,
  tasks: false,
  skills: false,
  jobs: false,
  mcp: false,
};

/* ============================================================
   Preferences: read once, persisted on change
   ============================================================ */

type Prefs = {
  quiet: boolean;
  sidebarVisible: boolean;
  leftbarVisible: boolean;
  blockCollapsed: Record<SidebarBlockKey, boolean>;
  blockTouched: Partial<Record<SidebarBlockKey, boolean>>;
  /** The left rail's session list, folded on its own. The workspace list above
   *  it stays — "where am I" must survive folding the conversation list. */
  sessionsCollapsed: boolean;
  workspaces: string[];
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
   * Start-up arguments, as remembered *defaults for the next start*.
   *
   * These are preferences in the only sense that is honest here: they decide what
   * the next child is started with. They are **not** what is running — that comes
   * from each session's `launch`, which records the arguments that session's child
   * was actually given.
   */
  ericaiDefault: boolean;
  maxStepsDefault: number | null;
};

function loadPrefs(): Prefs {
  const fallback: Prefs = {
    quiet: false,
    sidebarVisible: true,
    leftbarVisible: true,
    blockCollapsed: { ...EMPTY_BLOCKS },
    blockTouched: {},
    sessionsCollapsed: false,
    workspaces: [],
    // A first launch has nowhere to go back to, and inventing a directory for
    // it would be worse than opening nothing: the honest answer is the first
    // screen, where a person picks a place.
    lastWorkspace: null,
    // Off, and not because of a coin toss: this flag lets the runtime rewrite
    // `providers.ericai.api_key` in the person's own configuration file and keep a
    // refresh token under `~/.tudouni/`. That is not something to switch on for
    // somebody who has never heard of it.
    ericaiDefault: false,
    // Null is "no `--max-steps` on the command line", which is how the runtime's
    // own default applies. A remembered number would silently outrank it.
    maxStepsDefault: null,
  };
  try {
    const raw = localStorage.getItem('aigo.prefs');
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      quiet: parsed.quiet === true,
      sidebarVisible: parsed.sidebarVisible ?? fallback.sidebarVisible,
      leftbarVisible: parsed.leftbarVisible ?? fallback.leftbarVisible,
      blockCollapsed: { ...EMPTY_BLOCKS, ...(parsed.blockCollapsed ?? {}) },
      blockTouched: parsed.blockTouched ?? {},
      sessionsCollapsed: parsed.sessionsCollapsed ?? fallback.sessionsCollapsed,
      // Filtered rather than trusted: this is localStorage, it outlives every
      // build, and a stray non-string in it would reach `path.split` and take
      // the sidebar down with it.
      workspaces: (parsed.workspaces ?? []).filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
      ),
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
    };
  } catch {
    return fallback;
  }
}

/* ============================================================
   The blocking-request queue
   ============================================================ */

/**
 * Add a request: the head is shown, the rest wait.
 *
 * The runtime blocks on the id it asked about and has no timeout, so a request
 * that is never rendered is a call that never returns. That is why nothing here
 * discards an entry — the queue only ever loses one by having it answered.
 */
function enqueueModal(s: AppStore, entry: ModalEntry): Partial<AppStore> {
  const next = [...s.pendingModals, entry];
  return {
    pendingModals: next,
    // A blocking request clears any panel, but only when it becomes the head:
    // a queued one must not close a panel the person opened after answering the
    // current prompt.
    ...(s.modal === null ? { modal: entry, panel: null } : {}),
  };
}

/** Drop the answered head and promote the next one, if there is one. */
function drainModal(s: AppStore): Partial<AppStore> {
  const rest = s.pendingModals.slice(1);
  return { pendingModals: rest, modal: rest[0] ?? null };
}

function persistPrefs(s: AppStore, quiet?: { key: string; value: boolean }): void {
  try {
    localStorage.setItem(
      'aigo.prefs',
      JSON.stringify({
        // Quiet is per session now, so the remembered value is the active
        // session's — it is the one a person just changed, and it is what a
        // fresh session should start from.
        quiet: quiet ? quiet.value : s.sessions[s.activeKey ?? '']?.quiet === true,
        sidebarVisible: s.sidebarVisible,
        leftbarVisible: s.leftbarVisible,
        blockCollapsed: s.blockCollapsed,
        blockTouched: s.blockTouched,
        sessionsCollapsed: s.sessionsCollapsed,
        workspaces: s.workspaces,
        lastWorkspace: s.lastWorkspace,
        ericaiDefault: s.ericaiDefault,
        maxStepsDefault: s.maxStepsDefault,
      }),
    );
  } catch {
    /* Private mode: preferences simply do not persist. */
  }
}

const prefs = loadPrefs();

/* ============================================================
   Polling throttle — per session
   ============================================================ */

/**
 * How many identical answers in a row before the polling gives up.
 *
 * `refresh_state` is a lightweight read, but "poll every 2s until the session
 * ends" is a heartbeat in all but name, and the design says `status` reads the
 * audit log and must not become one. A job that stays `uncollected` is the case
 * that never resolves on its own: it only clears when a person collects it with
 * `job_output`, and until then the front end would poll forever. After this many
 * unchanged answers the polling stops; the next real change (a finished turn, a
 * tool result) restarts it.
 */
const POLL_GIVE_UP_AFTER = 5;

/**
 * The throttle's state, **one per session**.
 *
 * One shared throttle would mean a busy session starving a quiet one: the two
 * sessions' polls would draw from the same two-second budget and the same
 * give-up counter, so a job left outstanding in B could be silenced by A's
 * traffic — and B's panel would then sit on stale numbers with nothing to
 * explain why.
 */
interface PollState {
  lastPollAt: number;
  streak: number;
  outstandingKey: string;
}
const pollStates = new Map<string, PollState>();

function pollState(key: string): PollState {
  let state = pollStates.get(key);
  if (!state) {
    state = { lastPollAt: 0, streak: 0, outstandingKey: '' };
    pollStates.set(key, state);
  }
  return state;
}

/** `refresh_state` is not a heartbeat: it is only ever sent when something of
 *  ours is known to be outstanding, never faster than the floor, and it stops
 *  once the answer stops changing. */
function throttled(key: string, fn: () => void): void {
  const state = pollState(key);
  const now = Date.now();
  if (now - state.lastPollAt < POLL_FLOOR_MS) return;
  if (state.streak >= POLL_GIVE_UP_AFTER) return;
  state.lastPollAt = now;
  state.streak += 1;
  fn();
}

/**
 * Note what the outstanding set looks like now.
 *
 * Called on every `ui(state)` landing. An unchanged set deepens the streak; a
 * changed one (a job finished, a new job appeared) resets it, so the backoff
 * only ever applies to a genuinely static situation.
 */
function noteOutstanding(key: string, outstanding: string): void {
  const state = pollState(key);
  if (outstanding === state.outstandingKey) return;
  state.outstandingKey = outstanding;
  state.streak = 0;
}

/** Restart polling after something that can change the outcome — a finished
 *  turn, a tool result. Without this the give-up above would be permanent. */
function wakePolling(key: string): void {
  const state = pollState(key);
  state.streak = 0;
  state.lastPollAt = 0;
}

/* ============================================================
   The store
   ============================================================ */

/** The active session's bucket, or null when nothing is open. */
export function activeRuntime(s: AppStore): SessionRuntime | null {
  return s.activeKey === null ? null : (s.sessions[s.activeKey] ?? null);
}

/**
 * Which workspace a child about to be started should be given.
 *
 * Three answers, in order of how directly a person said them:
 *
 *   1. **The caller's** — pressing a workspace row, or `/resume` naming one.
 *   2. **The active session's**, from `init.workspace`. "New conversation"
 *      almost always means "here", and the runtime's own answer about where a
 *      session is open is the only thing entitled to say where here is.
 *   3. **The remembered one** — the workspace last worked in.
 *
 * And then **nothing**: the empty string, which callers must treat as "do not
 * start a child at all" rather than as a value to pass on. That last part is
 * not a detail. An absent workspace reaches the bridge as `None`, whose
 * documented meaning is "the directory the application was started in" — for a
 * packaged app, its own install folder. That is how a launch with nothing
 * recalled ended up opening a workspace nobody chose, and it is the one
 * fallback that can never be right.
 *
 * Pure, and exported, so the precedence can be asserted without a bridge.
 */
export function resolveAttachWorkspace(
  requested: string | undefined,
  active: string | undefined,
  remembered: string | null,
): string {
  for (const candidate of [requested, active, remembered ?? undefined]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return '';
}

/* ------------------------------------------------------------
   Reading the active session from a component
   ------------------------------------------------------------

   Every component that draws "the conversation on screen" has to say which
   conversation it means, and with several open that is `activeKey` rather than
   the store itself. `useSessionField` is that answer in one place: it is a hook
   rather than a `select*(s, key)` because the *caller* almost never has a key —
   the component is drawing whatever is focused — and threading `activeKey` into
   forty call sites is forty chances to pass the wrong one.

   The fallbacks are shared constants rather than fresh literals, and that is not
   tidiness: zustand compares selector output by identity, so `rt.entries ??
   []` allocates a new array on every call and re-renders forever without ever
   committing — which shows up as a blank component rather than as an error.
*/

export const NO_ENTRIES: Entry[] = [];
export const NO_NOTES: NoteEntry[] = [];
export const NO_STRINGS: string[] = [];
export const NO_SESSION_LIST: VmSessionListItem[] = [];
/** The empty terminal list, for the same reason: a selector's fallback must be
 *  a stable reference or every render of an empty workspace is a new frame. */
export const NO_TERMINALS: TerminalRow[] = [];
/** No file listing yet. Same rule as above. */
export const NO_FILE_ENTRIES: FileEntry[] = [];
/** No terminal output yet. Same rule as above. */
export const NO_OUTPUT: string[] = [];
export const NO_SKILLS: VmSkill[] = [];
export const NO_MCP_ROWS: VmMcp[] = [];
export const NO_PASTED: PastedImage[] = [];
export const NO_INIT_TOOLS: VmInitTool[] = [];
export const NO_MODEL_ROWS: VmModel[] = [];
export const NO_ALIASES: ModelAlias[] = [];

/** The key of the session being drawn, or null when nothing is open. */
export function useActiveKey(): string | null {
  return useApp((s) => s.activeKey);
}

/**
 * One field of the active session's bucket.
 *
 * `pick` must return a stored value or a shared constant — never a fresh object
 * or array literal — for the identity reason above.
 */
export function useSessionField<T>(pick: (rt: SessionRuntime) => T, fallback: T): T {
  return useApp((s) => {
    const rt = activeRuntime(s);
    return rt ? pick(rt) : fallback;
  });
}

function runtimeOf(s: AppStore, key: string | null): SessionRuntime | null {
  return key === null ? null : (s.sessions[key] ?? null);
}

/**
 * How many lines of one terminal's output this front end keeps.
 *
 * The runtime keeps **none** by design — a terminal's output must not become a
 * second terminal — so showing more than the last screenful is necessarily this
 * end's job. 4000 lines is about fifty screens; a build log is megabytes, and an
 * unbounded buffer would make this window's memory grow with the length of a
 * command somebody ran.
 */
export const TERMINAL_SCROLLBACK = 4000;

/**
 * Append one output batch to a terminal's bounded tail.
 *
 * Two details, both of them the difference between readable and not:
 *
 *   - the batch boundary is **not** a line boundary. A fragment that continues
 *     the last line already held is joined to it rather than becoming a row of
 *     its own, or a sentence would be broken in the middle of a word every time
 *     the PTY happened to flush there.
 *   - `\r\n` is normalised to `\n`. The PTY sends CRLF, and a browser rendering
 *     a raw `\r` inside a `<div>` shows it as nothing at all — so without this a
 *     terminal's output collapses onto one line.
 */
export function appendTerminalOutput(
  store: Record<string, string[]>,
  id: string,
  data: string,
): Record<string, string[]> {
  const existing = store[id] ?? [];
  const lines = data.replace(/\r\n/g, '\n').split('\n');
  let next: string[];
  if (existing.length > 0) {
    // The first fragment continues the line already held.
    next = [...existing.slice(0, -1), existing[existing.length - 1] + lines[0], ...lines.slice(1)];
  } else {
    next = lines;
  }
  if (next.length > TERMINAL_SCROLLBACK) {
    // The **newest** lines survive: dropping the recent output would leave the
    // pane showing the start of a build with no sign of the end.
    next = next.slice(next.length - TERMINAL_SCROLLBACK);
  }
  return { ...store, [id]: next };
}

/**
 * Replace one terminal's row, or append it when it was never seen.
 *
 * The exit event carries the whole row, so it is **replaced** rather than patched
 * field by field. Merging two fields by hand is how a row and the runtime end up
 * describing different terminals — and the append case is real: a shell can end
 * before this window ever received a snapshot that mentioned it.
 */
export function replaceTerminal(rows: TerminalRow[], row: TerminalRow): TerminalRow[] {
  const at = rows.findIndex((candidate) => candidate.id === row.id);
  if (at < 0) return [...rows, row];
  const next = [...rows];
  next[at] = row;
  return next;
}

/**
 * What one terminal's ending says in the transcript.
 *
 * Three endings read three ways, and the third is why this cannot be a lookup:
 * `killed`, `exited` with a code, and `exited` without one (killed by a signal on
 * POSIX, or a console this program had to close) are different facts. Printing a
 * number for the last case would invent one.
 */
export function terminalExitText(
  id: string,
  reason: 'exited' | 'killed',
  code: number | null,
): string {
  if (reason === 'killed') return `Terminal ${id} was killed.`;
  if (code === null) return `Terminal ${id} exited.`;
  return `Terminal ${id} exited with code ${code}.`;
}

export const useApp = create<AppStore>((set, get) => {
  /**
   * Write into one session's bucket.
   *
   * Every per-session write goes through here, which is what keeps
   * `sessions[key]` the single source and makes "who is this fact about" a
   * required argument rather than something a caller can forget. A write for a
   * session that is gone is dropped: the child it belonged to no longer exists,
   * and inventing a bucket for it would resurrect a session nothing owns.
   */
  function patch(key: string, changes: Partial<SessionRuntime>): void {
    set((s) => {
      const current = s.sessions[key];
      if (!current) return {};
      return { sessions: { ...s.sessions, [key]: { ...current, ...changes } } };
    });
  }

  /** The same, applied by a function of the current bucket. */
  function patchWith(
    key: string,
    build: (current: SessionRuntime) => Partial<SessionRuntime>,
  ): void {
    set((s) => {
      const current = s.sessions[key];
      if (!current) return {};
      return { sessions: { ...s.sessions, [key]: { ...current, ...build(current) } } };
    });
  }

  /** Patch the active session, when there is one. */
  function patchActive(changes: Partial<SessionRuntime>): void {
    const key = get().activeKey;
    if (key === null) return;
    patch(key, changes);
  }

  /** The key a message should be sent to: the active session, or nothing. */
  function activeKeyForSend(): string | null {
    return get().activeKey;
  }

  return {
    sessions: {},
    order: [],
    activeKey: null,

    runtimeVersion: null,
    desktopVersion: __DESKTOP_VERSION__,
    userName: '',
    startupProblem: null,
    startupNotice: null,

    modal: null,
    pendingModals: [],
    panel: null,

    sidebarVisible: prefs.sidebarVisible,
    leftbarVisible: prefs.leftbarVisible,
    blockCollapsed: prefs.blockCollapsed,
    blockTouched: prefs.blockTouched,
    blockAutoExpanded: {},
    reasoningOpen: {},
    toolOpen: {},
    sessionsCollapsed: prefs.sessionsCollapsed,
    workspaces: prefs.workspaces,
    lastWorkspace: prefs.lastWorkspace,

    ericaiDefault: prefs.ericaiDefault,
    maxStepsDefault: prefs.maxStepsDefault,

    dragging: false,

    /* ==========================================================
       Sessions: the lifecycle
       ========================================================== */
    async attachSession(options = {}) {
      const s = get();
      // Where the child goes. The precedence — caller, then the active session's
      // own answer, then the remembered one — is `resolveAttachWorkspace`, and it
      // is pure so that it can be asserted without a bridge.
      const workspace = resolveAttachWorkspace(
        options.workspace,
        activeRuntime(s)?.workspace,
        s.lastWorkspace,
      );

      // **Nothing to go on means nothing is started.** Not a fallback to
      // something plausible: the only thing left is the bridge's `None`, whose
      // documented meaning is "the directory the application was started in" —
      // for a packaged application, its own install folder. That is how a launch
      // with no workspace open came up in a directory nobody chose, with the
      // session file nowhere in it. `ResolveSession` then reads an id with no
      // file as *a new session with that name*, so nothing failed loudly either;
      // the screen simply moved somewhere else. A refusal is visible and this
      // was not, which is the whole difference.
      //
      // The caller is told by the empty return, so nothing is left looking like
      // it worked. But a caller is not a person — `/new` and the rail's "new
      // session" button both land here when no workspace is remembered, and a
      // button that silently does nothing is exactly the failure this change is
      // meant to remove. So the reason is said on the first screen, which is
      // where the workspace list is.
      if (workspace === '') {
        set({ startupNotice: { code: 'no-workspace' } });
        return null;
      }

      const launch: LaunchArgs = {
        ericai: options.ericai === true,
        maxSteps: options.maxSteps ?? null,
      };

      // **The default is passed on, not only recorded.** Computing it above and
      // then handing the caller's `options` straight through made the two
      // disagree in exactly the case the default exists for — opening a saved
      // session from the list, which names no workspace. The bridge then fell
      // back to the *process's* working directory, which for a packaged
      // application is its own install directory, and started the child there.
      // Nothing failed loudly: the session file is not in that directory, and
      // `ResolveSession` reads an id with no file as *a new session with that
      // name* (`internal/runtime/composition.go`). So the screen moved to a
      // different, empty conversation, in a workspace nobody asked for, while
      // the row that was clicked stayed where it was. Written down but never
      // spawned in, the default was decoration.
      const attach: Partial<BridgeOptions> = { ...options, workspace };

      let key: string | null;
      try {
        key = await attachRuntime(attach);
      } catch (err) {
        // A refusal here belongs to the session that was being opened rather
        // than to the window: with one open already, taking over the screen
        // would hide a perfectly healthy conversation behind a message about a
        // process that does not exist.
        //
        // There is no key yet, so a short-lived bucket is made for the sentence
        // to live in — it is the row the person just asked for.
        const failed = `failed-${Date.now().toString(36)}`;
        const bucket = createSessionBucket(failed, workspace, launch);
        bucket.problem = describeFailure(err);
        set((state) => ({
          sessions: { ...state.sessions, [failed]: bucket },
          order: [...state.order, failed],
          activeKey: failed,
        }));
        return null;
      }

      if (key === null) {
        // No bridge at all (a plain browser). Nothing to record: there is no
        // process, so there is no session to show a problem for.
        return null;
      }

      const bucket = createSessionBucket(key, workspace, launch);

      // The handle is built before the first line can be routed to it, and it
      // holds anything that arrives before a subscriber exists.
      const runtime = createTauriRuntime(key, (line) => {
        get().pushStderr(key, line);
      });
      registerRuntime(runtime);

      // **The bucket is installed before anything is subscribed, and that order
      // is load-bearing.** A line the child sent before the handle existed is
      // held — by the host's `pendingLines`, and then by the handle's own queue
      // — and `subscribe` is what flushes it, straight into
      // `applyRuntimeMessage`. That function drops a message for a key with no
      // bucket, and it has to: from a key alone, "this session is gone" and
      // "this session has not been installed yet" are the same statement.
      //
      // So subscribing first and installing the bucket afterwards threw away
      // exactly the lines the queue exists to protect: the opening
      // `init` -> `session_load` -> `ui(state)` triple. The child is perfectly
      // healthy and every *later* reply lands normally (`session_list` is sent
      // below, after the bucket exists, so `sessions` populates the rail) —
      // which is what makes this so quiet. With `init` gone there is no
      // `session_id`, so the rail cannot mark the row current; with `ui(state)`
      // gone the right rail has no snapshot; and because `ready` never becomes
      // true the screen shows "Starting the runtime…" forever over a process
      // that is running and answering. Nothing reports a failure, because
      // nothing failed.
      set((state) => ({
        sessions: { ...state.sessions, [key as string]: bucket },
        order: [...state.order, key as string],
        activeKey: key,
        // A new session is being shown, so any window-level refusal it was
        // preceded by is no longer what the screen is about.
        startupProblem: null,
        // And so is the note about nothing having been opened, if there was one.
        startupNotice: null,
      }));

      // Only now, with somewhere for them to land.
      runtime.subscribe((msg) => {
        get().applyRuntimeMessage(key, msg);
      });

      // Anything the child printed before it gave up is already in the bridge's
      // ring; read it once so a start-up failure has something to show even if
      // it died faster than the event subscription.
      void readRuntimeStderr(key).then((early) => {
        for (const line of early) get().pushStderr(key, line);
      });

      // A child is running in this directory — the bridge does not hand back a
      // key otherwise — and it is now the one on screen. That is the plainest
      // available statement that this is where work is happening, so it is what
      // the next launch should open. `init.workspace` refines it a moment later
      // with the runtime's own canonical answer.
      get().rememberWorkspace(workspace);

      // The session list is what the left rail draws saved conversations from,
      // and a fresh child is the only thing that can answer for this workspace.
      sendTo(key, { v: 1, t: 'session_list' });

      return key;
    },

    focusSession(key) {
      const s = get();
      if (!s.sessions[key]) return;
      if (s.activeKey === key) return;
      patchWith(key, () => ({ unseen: false }));
      // **Nothing is sent.** Switching which conversation is drawn is a local
      // act; the child keeps running and keeps its transcript. This is the
      // difference between this and `session_switch`, which made the runtime
      // rebuild itself and abandon whatever it was waiting on.
      set({ activeKey: key, panel: null });
      // The session being looked at is the one this window is working in, so its
      // workspace is what the next launch should open. Without this, "last used"
      // would mean "last opened", and focusing a session in another workspace is
      // precisely how somebody changes which one that is.
      const workspace = s.sessions[key]?.workspace ?? '';
      if (workspace !== '') get().rememberWorkspace(workspace);
    },

    async detachSession(key) {
      const s = get();
      if (!s.sessions[key]) return;

      // The pictures of the session being closed are nobody's any more, and
      // their blob URLs would otherwise live until the window did.
      releaseImages(s.sessions[key].pastedImages);
      unregisterRuntime(key);
      pollStates.delete(key);

      set((state) => {
        const { [key]: _gone, ...rest } = state.sessions;
        const order = state.order.filter((entry) => entry !== key);
        // Focus moves to a neighbour rather than nowhere: with several sessions
        // open, closing one should not blank the screen.
        const activeKey =
          state.activeKey === key ? (order[order.length - 1] ?? null) : state.activeKey;
        return {
          sessions: rest,
          order,
          activeKey,
          // A queued request from the session that is going away can never be
          // answered — its child is the one that was waiting — so it leaves the
          // queue rather than sitting at the head of it forever.
          pendingModals: state.pendingModals.filter((entry) => entry.key !== key),
          ...(state.modal && state.modal.key === key
            ? { modal: state.pendingModals.find((entry) => entry.key !== key) ?? null }
            : {}),
        };
      });

      try {
        await shutdownRuntime(key);
      } catch {
        /* The child is already gone; the exit event is what says so. */
      }
    },

    async openSession(sessionId, workspace) {
      const s = get();
      if (sessionId !== null) {
        // A child that already has this session open is focused rather than
        // duplicated. Two processes on one session id would write the same
        // session file, and the store's watermark (`SessionStore.Save`) is
        // per-process — so this is a data-safety rule, not an optimisation.
        const existing = s.order.find(
          (key) => s.sessions[key]?.sessionId === sessionId,
        );
        if (existing) {
          get().focusSession(existing);
          return;
        }
      }
      await get().attachSession({
        ...(workspace === undefined ? {} : { workspace }),
        ...(sessionId === null ? {} : { sessionId }),
      });
    },

    /* ==========================================================
       Outbound
       ========================================================== */
    send(msg) {
      const key = activeKeyForSend();
      if (key === null) return;
      sendTo(key, msg);
    },

    setRuntimeInfo(info) {
      set({ runtimeVersion: info.version, userName: info.userName ?? '' });
    },

    setStartupProblem(problem) {
      set({ startupProblem: problem });
    },

    setStartupNotice(notice) {
      set({ startupNotice: notice });
    },

    rememberWorkspace(path) {
      const trimmed = path.trim();
      // Nothing to remember. An empty string here is a caller passing through a
      // value it did not have, which is not a statement that the remembered
      // workspace should be forgotten — so it is ignored rather than honoured.
      //
      // There is deliberately no "forget" action either. A remembered workspace
      // that has since been deleted is **reported** at start-up (`workspace_check`
      // answers about it) rather than erased, because a directory can come back:
      // an unplugged drive, an unmounted share, a folder mid-rename. It also
      // heals itself the moment somebody picks a workspace, since `init.workspace`
      // then overwrites it.
      if (trimmed === '') return;
      // `samePath` rather than `!==`: the runtime echoes the directory back with
      // its own casing and separators, so a strict comparison would make every
      // ordinary `init` look like a change and write localStorage each time.
      const remembered = get().lastWorkspace;
      if (remembered !== null && samePath(remembered, trimmed)) return;
      set({ lastWorkspace: trimmed });
      persistPrefs(get());
    },

    pushStderr(key, line) {
      patchWith(key, (current) => {
        const next = [...current.stderrTail, line];
        // A tail, not a log: the last N lines are what explain a refusal, and an
        // unbounded array would grow for the life of a long session.
        return {
          stderrTail: next.length > STDERR_TAIL ? next.slice(next.length - STDERR_TAIL) : next,
        };
      });
    },

    countDrop(key) {
      patchWith(key, (current) => ({ dropped: current.dropped + 1 }));
    },

    setSessionProblem(key, problem) {
      patch(key, { problem });
    },

    async retrySession(key) {
      const current = runtimeOf(get(), key);
      if (!current) return;
      patch(key, { problem: null, stderrTail: [] });
      // A retry is a new process, because the old one is gone by definition —
      // there would be nothing to retry inside a live child. The failed bucket
      // is retired once the new one exists, so a retry never leaves the row
      // that failed sitting beside the row that worked.
      const workspace = current.workspace;
      const launch = current.launch;
      await get().detachSession(key);
      await get().attachSession({
        ...(workspace === '' ? {} : { workspace }),
        ericai: launch.ericai,
        ...(launch.maxSteps === null ? {} : { maxSteps: launch.maxSteps }),
      });
    },

    async retryStartup() {
      set({ startupProblem: null });
      // The active session's child is gone (that is why the screen is up), so
      // this is a fresh session rather than a retry inside a live one.
      await get().attachSession({});
    },

    async quit() {
      await quitApp();
    },

    /* ==========================================================
       Inbound: the only door for runtime facts
       ========================================================== */
    applyRuntimeMessage(key, msg) {
      const s = get();
      const bucket = s.sessions[key];
      // A message for a session that is gone (its child was shut down while a
      // line was in flight) has nowhere to go and is dropped rather than
      // resurrecting a bucket nothing would ever reap.
      if (!bucket) return;

      switch (msg.t) {
        case 'init': {
          const init = projectInit(msg);
          // The handshake's notices are the runtime's own sentences, written for
          // a person. They are kept in their own field, because `session_load`
          // arrives right behind this message and rebuilds the whole transcript —
          // putting them in `entries` here is what made every start-up diagnostic
          // ("no ripgrep", "no model configured") invisible.
          const notices: NoteEntry[] = init.notices.map((notice) => ({
            kind: 'note' as const,
            id: nextId('note'),
            tone: notice.level === 'warn' ? ('warn' as const) : ('info' as const),
            code: notice.code,
            text: notice.text,
          }));
          patch(key, {
            ready: true,
            // The runtime's own id, which is what makes "open the saved session
            // S" able to find this child later.
            sessionId: init.sessionId,
            workspace: init.workspace,
            session: {
              id: init.sessionId,
              resumed: init.resumed,
              model: init.model,
              provider: init.provider,
              thinking: init.thinking,
              effort: init.effort,
              effortLevels: init.effortLevels,
              maxSteps: init.maxSteps,
              steps: 0,
              stream: init.stream,
              workspace: init.workspace,
              contextTokens: init.contextTokens,
              auditPath: init.auditPath,
              permissions: init.permissions,
              protocol: init.protocol,
            },
            models: init.models,
            modelAliases: init.modelAliases,
            // The registry the tool rows look their risk up in. Without this the
            // badge is permanently unknown, because `toolFacts` would only ever
            // have `ui(tools)` to answer from.
            toolRegistry: init.tools,
            handshakeNotices: notices,
            entries: [...bucket.entries, ...notices],
            listedSessions: false,
            // The handshake means this child is up, so a previous refusal is no
            // longer true.
            problem: null,
          });
          // The runtime's own answer about where this session is, which is what
          // the next launch should open — **when this is the session on screen.**
          // A background session's `init` must not move the remembered workspace
          // out from under the person, who is working in the one they can see.
          // Compared with `samePath` so that the ordinary case (the bridge's
          // string, echoed back) is not a write at all.
          if (get().activeKey === key && init.workspace.trim() !== '') {
            get().rememberWorkspace(init.workspace);
          }
          // The first screen shows the four most recent sessions, and only this
          // message ever asks for them. Without it those slots stay empty until
          // somebody opens `/resume`, and `Ctrl+1..9` has nothing to switch to.
          sendTo(key, { v: 1, t: 'session_list' });
          break;
        }

        case 'session_load': {
          const history = projectHistory(msg.messages);
          // Rebuild the transcript from the stored messages. Only the two roles a
          // transcript row can draw are rendered.
          const rebuilt: Entry[] = history.map((row) =>
            row.role === 'user'
              ? { kind: 'user', id: nextId('user'), text: row.text, atMs: 0 }
              : { kind: 'answer', id: nextId('answer'), runId: 'history', text: row.text },
          );
          // The handshake's diagnostics go back at the head of the rebuilt
          // stream. They belong to the session, not to the moment they were said,
          // and the design is explicit that they are not pushed out by session
          // content.
          patch(key, {
            entries: [...bucket.handshakeNotices, ...rebuilt],
            activeRunId: null,
            lastRunId: null,
            hasSpoken: history.length > 0,
          });
          break;
        }

        case 'event': {
          const result = reduceEvent(
            bucket.entries,
            // `event` is the audit record forwarded verbatim: loose by design, and
            // unknown kinds and extra fields must be tolerated rather than rejected.
            msg as unknown as LooseEvent,
            {
              activeRunId: bucket.activeRunId,
              lastRunId: bucket.lastRunId,
              // The lookup is bound to **this** session: risk comes from that
              // child's tool registry, and two sessions can have different tools
              // (different workspaces, different loaded skills).
              lookup: (name) => lookupToolFacts(bucket, name),
              maxSteps: bucket.session?.maxSteps ?? 0,
            },
          );
          if (result.stale) {
            patch(key, { lateDropped: bucket.lateDropped + 1 });
            break;
          }
          patch(key, {
            entries: result.entries,
            activeRunId: result.startedRunId ?? (result.runEnded ? null : bucket.activeRunId),
            lastRunId:
              result.startedRunId ?? (result.runEnded ? msg.run_id : bucket.lastRunId),
            // The turn's wall time is on `run_finished` itself, so the status bar
            // does not have to wait for the `status` round trip to show it.
            ...(result.runEnded && typeof msg.duration_ms === 'number'
              ? { lastTurnMs: msg.duration_ms }
              : {}),
          });

          // A finished turn is the one moment the usage/cache/elapsed numbers are
          // worth fetching (decision 5) — and it is also what lifts the poll
          // backoff, since a turn that just ended can change what is outstanding.
          if (result.runEnded) {
            wakePolling(key);
            throttled(key, () => sendTo(key, { v: 1, t: 'status' }));
          }
          break;
        }

        case 'ui': {
          switch (msg.kind) {
            case 'state': {
              applyStateSnapshot(set, get, key, projectState(msg));
              break;
            }
            case 'status': {
              patch(key, { status: projectStatus(msg) });
              break;
            }
            case 'tools': {
              const projected = projectToolsMsg(msg);
              patchWith(key, (current) => ({
                tools: projected.tools,
                grantedPrefixes: projected.grantedPrefixes,
                entries: pushBlock(current.entries, 'tools', msg),
              }));
              break;
            }
            case 'mcp': {
              const projected = projectMcpMsg(msg);
              // This is the runtime answering an `mcp` message, so whatever this
              // front end had in flight has been answered. The reply carries no
              // request id, so the marks are released as a batch rather than one
              // by one; a person pressing two rows before the first answers would
              // see the first reply clear both. That is a cosmetic early release
              // and never a claim about a server — the state on the row still
              // comes from this payload alone.
              patchWith(key, (current) => ({
                mcp: projected.servers,
                mcpNotes: projected.notes,
                mcpPending: [],
                // The runtime's own notes go into the stream, verbatim.
                ...(projected.notes.length > 0
                  ? {
                      entries: [
                        ...current.entries,
                        ...projected.notes.map((text) => ({
                          kind: 'note' as const,
                          id: nextId('note'),
                          tone: 'info' as const,
                          code: 'mcp',
                          text,
                        })),
                      ],
                    }
                  : {}),
              }));
              break;
            }
            case 'context': {
              const context = projectContext(msg);
              patchWith(key, (current) => ({
                context,
                entries: pushBlock(current.entries, 'context', msg),
              }));
              break;
            }
            case 'compacted': {
              const projected = projectCompacted(msg);
              patchWith(key, (current) => ({
                compaction: projected.compaction,
                ...(projected.context ? { context: projected.context } : {}),
                entries: pushBlock(current.entries, 'compact', msg),
              }));
              break;
            }
            case 'skills': {
              // `ui(skills)` is the real source for "what is loaded": `skills` is
              // the catalogue this session *can* load and `active` is the names
              // actually loaded. `ui(state).skills` is pointers for the loaded
              // ones, which is why the digest and description are merged in from
              // there rather than taken from this message.
              const projected = projectSkillsMsg(msg);
              const merged = mergeSkills(
                bucket.uiState?.skills ?? [],
                bucket.skillCatalog,
                projected.available,
                projected.active,
              );
              patch(key, {
                skills: merged.loaded,
                skillAvailable: merged.available,
                skillActive: projected.active,
                skillProblems: projected.problems,
                skillShadowed: projected.shadowed,
              });
              break;
            }
            case 'files': {
              // The **runtime's** path, not the one that was asked for: the two
              // differ after a `/./src/../src`, and the reply's spelling is what
              // makes "where am I" answerable and the parent-directory step
              // correct.
              patch(key, {
                filesPath: typeof msg.path === 'string' ? msg.path : '',
                filesEntries: Array.isArray(msg.entries) ? msg.entries : [],
                filesLoading: false,
              });
              break;
            }
            case 'file_read': {
              // The body goes in the browser's viewer as a block, in arrival
              // order like every other panel payload — the alternative is a
              // second, parallel transcript that has to be kept in step with
              // this one.
              patchWith(key, (current) => ({
                filesLoading: false,
                entries: pushBlock(current.entries, 'file', msg),
              }));
              break;
            }
            case 'terminals': {
              patch(key, {
                terminals: Array.isArray(msg.terminals) ? msg.terminals : [],
              });
              break;
            }
            case 'terminal_created': {
              // The new row goes into the list straight away so the panel can
              // show it without waiting for a snapshot, and the answer also
              // **attaches** to it: the reply to "open a terminal" is a shell to
              // type into, not a list to read.
              const row = msg.terminal;
              patchWith(key, (current) => ({
                terminals: row ? [...current.terminals, row] : current.terminals,
                activeTerminalId: row && row.id ? row.id : current.activeTerminalId,
                terminalPending: current.terminalPending.filter((id) => id !== 'new'),
              }));
              break;
            }
            case 'terminal_output': {
              // The one high-frequency message. It carries no row, no snapshot
              // and no status — only which terminal and which bytes — so this
              // handler does one thing: append to that terminal's bounded tail.
              const id = msg.terminal_id;
              const data = typeof msg.data === 'string' ? msg.data : '';
              if (id === '' || data === '') break;
              patchWith(key, (current) => ({
                terminalOutput: appendTerminalOutput(current.terminalOutput, id, data),
              }));
              break;
            }
            case 'terminal_exit': {
              const exited = msg.terminal;
              patchWith(key, (current) => ({
                // The row is **replaced whole** rather than patched: it carries
                // the status and the exit code the runtime decided, and merging
                // two fields by hand is how the row and the runtime end up
                // describing different terminals.
                terminals: exited
                  ? replaceTerminal(current.terminals, exited)
                  : current.terminals,
                terminalPending: current.terminalPending.filter(
                  (id) => id !== msg.terminal_id,
                ),
                entries: [
                  ...current.entries,
                  {
                    kind: 'note' as const,
                    id: nextId('note'),
                    tone: msg.reason === 'killed' ? ('warn' as const) : ('info' as const),
                    code: 'terminal',
                    text: terminalExitText(msg.terminal_id, msg.reason, msg.exit_code),
                  },
                ],
              }));
              break;
            }
            case 'run_finished': {
              const runId = msg.run_id;
              // The two `run_finished` messages are not ordered, so pairing is by
              // run id alone. A mismatch against a *different* finished run is
              // dropped; anything else is this session's answer.
              if (
                bucket.activeRunId !== null &&
                runId !== bucket.activeRunId &&
                runId !== bucket.lastRunId
              ) {
                patch(key, { lateDropped: bucket.lateDropped + 1 });
                break;
              }
              patch(key, {
                // `answer` is read through a type guard rather than passed
                // straight on. It reaches `Markdown`, which calls `text.replace`,
                // and there is no error boundary above it — so one message with a
                // missing or non-string `answer` would blank the whole window
                // instead of dropping a line. A missing answer is simply absent:
                // `applyFinalAnswer` keeps the streamed body in that case.
                entries: applyFinalAnswer(
                  bucket.entries,
                  runId,
                  typeof msg.answer === 'string' ? msg.answer : '',
                ),
                activeRunId: null,
                lastRunId: runId,
                // The turn is over. If nobody is looking at this session, that
                // is the fact the blue dot exists to report — a background
                // session that finished is not running, not asking and not
                // broken, so without this it would show nothing at all.
                ...(s.activeKey === key ? {} : { unseen: true }),
              });
              break;
            }
            default:
              break;
          }
          break;
        }

        case 'delta': {
          const result = applyDelta(
            bucket.entries,
            msg.run_id,
            msg.step,
            msg.channel,
            msg.text,
            bucket.activeRunId,
            bucket.lastRunId,
          );
          if (result.stale) {
            patch(key, { lateDropped: bucket.lateDropped + 1 });
            break;
          }
          patch(key, { entries: result.entries });
          break;
        }

        case 'delta_reset': {
          if (
            (bucket.activeRunId !== null && msg.run_id !== bucket.activeRunId) ||
            (bucket.activeRunId === null &&
              bucket.lastRunId !== null &&
              msg.run_id !== bucket.lastRunId)
          ) {
            patch(key, { lateDropped: bucket.lateDropped + 1 });
            break;
          }
          // Both channels are cleared for that step: the message carries no
          // channel, and a reset invalidates whatever was drawn for the step.
          patch(key, {
            entries: clearStream(
              clearStream(bucket.entries, msg.run_id, msg.step, 'text'),
              msg.run_id,
              msg.step,
              'reasoning',
            ),
          });
          break;
        }

        case 'notice': {
          patch(key, {
            entries: [
              ...bucket.entries,
              {
                kind: 'note',
                id: nextId('note'),
                tone: msg.level === 'warn' ? 'warn' : 'info',
                code: msg.code,
                // Written by the runtime for a person. Displayed verbatim.
                text: msg.text,
              },
            ],
          });
          break;
        }

        case 'sessions': {
          patch(key, { sessionList: projectSessionList(msg.items), listedSessions: true });
          break;
        }

        case 'permission_request': {
          // A blocking modal outranks everything (priority: approval > question >
          // panel > stream).
          //
          // **Queued, never overwritten.** The runtime waits forever on the id it
          // asked about, so replacing an unanswered request with a second one
          // loses the first id permanently and hangs that call. Only the head is
          // rendered; the rest wait their turn.
          set(enqueueModal(get(), { kind: 'permission', key, req: msg }));
          break;
        }

        case 'question_request': {
          set(enqueueModal(get(), { kind: 'question', key, req: msg }));
          break;
        }

        case 'runtime_exited': {
          // The runtime is gone, so this turn cannot end any other way. Without
          // this the phase stays "Running" forever: the composer sits behind its
          // Stop button, Enter and Esc both do nothing, and the "Stop" message
          // goes into a `.catch(() => {})` because there is no child to receive
          // it. The turn is settled with a reason the reader can act on.
          patch(key, {
            runtimeExit: { code: msg.code, requested: msg.requested },
            entries: settleAbandonedTurn(bucket.entries),
            activeRunId: null,
            // Cleared so the next turn is not attributed against a dead run.
            lastRunId: null,
            // Nothing will answer an MCP request now, so the marks must go: a
            // button left disabled by a reply that can never arrive is worse than
            // one that lets the person press again after the runtime is back.
            mcpPending: [],
          });
          break;
        }

        default:
          break;
      }
    },

    /* ==========================================================
       Composer — all of it scoped to the active session
       ========================================================== */
    setDraft(v) {
      patchActive({ draft: v, historyCursor: null });
    },

    setDragging(on) {
      set({ dragging: on });
    },

    setComposerNotice(notice) {
      patchActive({ composerNotice: notice });
    },

    async stashPastedImage(bytes, at) {
      const s = get();
      const key = s.activeKey;
      const current = activeRuntime(s);
      if (key === null || !current) return null;

      // No optimistic chip: the picture does not exist until the bridge has
      // written it, and a chip drawn before that would name a path the runtime
      // cannot resolve. So the order is write, then insert, then remember.
      let stashed;
      try {
        // The key travels with the bytes: the picture has to land in *this*
        // session's workspace, and the bridge refuses rather than guessing.
        stashed = await stashImage(key, bytes);
      } catch (err) {
        // The bridge's own sentence, verbatim. It is already written for a person
        // ("the clipboard's image data is not a PNG, JPEG or GIF…"), and inventing
        // a second wording here would be a second fact.
        patch(key, { composerNotice: { code: 'paste-failed', reason: String(err), tone: 'warn' } });
        return null;
      }

      const image: PastedImage = {
        path: stashed.path,
        name: stashed.name,
        bytes: stashed.bytes,
        mime: stashed.mime,
        // A preview the WebView can render without the asset protocol: the bytes
        // are already here, and `blob:` is in the CSP's `img-src`. The URL is
        // owned by this store, so `forgetPastedImage`/`clearPastedImages` revoke
        // it — a pasted picture that is never sent would otherwise be pinned in
        // memory for the life of the window.
        url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: stashed.mime })),
      };

      // The draft is re-read here rather than taken from `current`: awaiting the
      // bridge gave the person time to keep typing, and inserting into the text
      // as it was would silently drop what they wrote.
      const { text, caret } = insertPathAtCaret(get().sessions[key]?.draft ?? '', at, image.path);
      patchWith(key, (bucket) => ({
        draft: text,
        historyCursor: null,
        pastedImages: [...bucket.pastedImages, image],
      }));
      return caret;
    },

    forgetPastedImage(path) {
      patchWith(get().activeKey ?? '', (current) => {
        const doomed = current.pastedImages.find((image) => image.path === path);
        if (doomed) URL.revokeObjectURL(doomed.url);
        return { pastedImages: current.pastedImages.filter((image) => image.path !== path) };
      });
    },

    clearPastedImages() {
      const key = get().activeKey;
      if (key === null) return;
      releaseImages(get().sessions[key]?.pastedImages ?? []);
      patch(key, { pastedImages: [] });
    },

    historyNav(dir) {
      const current = activeRuntime(get());
      if (!current) return;
      const { history, historyCursor } = current;
      if (history.length === 0) return;
      let cursor: number | null;
      if (historyCursor === null) {
        if (dir === 1) return; // Already at the newest end.
        cursor = history.length - 1;
      } else {
        cursor = historyCursor + dir;
      }
      if (cursor < 0) {
        patchActive({ historyCursor: 0, draft: history[0] });
        return;
      }
      if (cursor >= history.length) {
        patchActive({ historyCursor: null, draft: '' });
        return;
      }
      patchActive({ historyCursor: cursor, draft: history[cursor] });
    },

    submitDraft() {
      const s = get();
      const key = s.activeKey;
      const current = activeRuntime(s);
      if (key === null || !current) return;
      const text = current.draft.trim();
      if (text === '') return;
      // A modal is blocking: nothing may be sent over the top of one.
      if (s.modal !== null) return;
      // The pictures have done their job the moment the sentence goes out: what
      // travels is the **path**, and the runtime reads the file itself. So the
      // stash and its preview URLs are released here rather than held — a chip for
      // a message that has already been sent would be a claim about the draft, and
      // the draft is now empty.
      releaseImages(current.pastedImages);
      patchWith(key, (bucket) => ({
        entries: [...bucket.entries, { kind: 'user', id: nextId('user'), text, atMs: Date.now() }],
        draft: '',
        history: [...bucket.history, text].slice(-100),
        historyCursor: null,
        hasSpoken: true,
        pastedImages: [],
        // Whatever was said about this input has been answered by sending it.
        composerNotice: null,
      }));
      sendTo(key, { v: 1, t: 'user_message', text });
    },

    interrupt() {
      const key = get().activeKey;
      if (key === null) return;
      sendTo(key, { v: 1, t: 'interrupt' });
    },

    /* ==========================================================
       Panels and preferences
       ========================================================== */
    openPanel(p) {
      set({ panel: p });
      const key = get().activeKey;
      // Every request a panel makes is about the session being shown, and with
      // several open that is the only one whose answer this panel could mean.
      if (key === null) return;
      if (p === 'resume') {
        patch(key, { listedSessions: false });
        sendTo(key, { v: 1, t: 'session_list' });
      }
      if (p === 'skills') {
        sendTo(key, { v: 1, t: 'skills' });
      }
      if (p === 'mcp') {
        // `mcp` is only ever sent because a person asked for it. The front end
        // never sends it on its own initiative — that would make "the config
        // widens itself" possible.
        sendTo(key, { v: 1, t: 'mcp', action: 'list', servers: [] });
      }
      if (p === 'files') {
        // Opens at the workspace root and asks for it in the same breath. The
        // panel draws its loading state immediately, so this never looks like a
        // dead keypress while the runtime reads the directory.
        patch(key, { filesLoading: true });
        sendTo(key, { v: 1, t: 'file_list', path: '' });
      }
      if (p === 'terminal') {
        // The list is already carried on every `ui(state)`, so this is a
        // refresh rather than the only source of it — a front end that never
        // sent this would still show terminals, one snapshot later.
        sendTo(key, { v: 1, t: 'terminal_list' });
      }
    },

    setQuiet(q) {
      const key = get().activeKey;
      if (key === null) return;
      patch(key, { quiet: q });
      // Remembered so a fresh session starts the way the last one was left. The
      // value is passed explicitly rather than read back off the store, because
      // `persistPrefs` is also called from paths where the active session is not
      // what changed.
      persistPrefs(get(), { key, value: q });
    },

    toggleQuiet() {
      const current = activeRuntime(get());
      if (!current) return;
      get().setQuiet(!current.quiet);
    },

    toggleSidebar() {
      set({ sidebarVisible: !get().sidebarVisible });
      persistPrefs(get());
    },

    setSidebarVisible(v) {
      set({ sidebarVisible: v });
      persistPrefs(get());
    },

    toggleLeftbar() {
      set({ leftbarVisible: !get().leftbarVisible });
      persistPrefs(get());
    },

    setLeftbarVisible(v) {
      set({ leftbarVisible: v });
      persistPrefs(get());
    },

    toggleBlock(k) {
      // Once a person has touched it, the auto-expand rule never fires again.
      set({
        blockCollapsed: { ...get().blockCollapsed, [k]: !get().blockCollapsed[k] },
        blockTouched: { ...get().blockTouched, [k]: true },
      });
      persistPrefs(get());
    },

    toggleSessionsCollapsed() {
      set({ sessionsCollapsed: !get().sessionsCollapsed });
      persistPrefs(get());
    },

    toggleReasoning(id) {
      const cur = get().reasoningOpen;
      set({ reasoningOpen: { ...cur, [id]: !cur[id] } });
    },

    toggleTool(id) {
      const cur = get().toolOpen;
      set({ toolOpen: { ...cur, [id]: !cur[id] } });
    },

    removeBlock(id) {
      const key = get().activeKey;
      if (key === null) return;
      patchWith(key, (current) => ({
        entries: current.entries.filter((e) => !(e.kind === 'block' && e.id === id)),
      }));
    },

    /* ==========================================================
       The two blocking modals
       ========================================================== */
    answerPermission(decision) {
      const m = get().modal;
      if (!m || m.kind !== 'permission') return;
      // Closing the modal is only visual; the permission record row waits for the
      // runtime's own `permission` event.
      set(drainModal(get()));
      // **Back to the session that asked.** This is the one send in this file
      // whose target is not `activeKey`, and it has to be: the answer belongs to
      // the id the runtime is blocked on, and a response delivered to another
      // child both hangs the asker (it waits on that id forever) and consumes
      // the other one's attention on a question nobody asked it.
      sendTo(m.key, { v: 1, t: 'permission_response', id: m.req.id, decision });
    },

    answerQuestion(status, text) {
      const m = get().modal;
      if (!m || m.kind !== 'question') return;
      set(drainModal(get()));
      // `skipped` is an independent action, never an empty submit.
      sendTo(m.key, {
        v: 1,
        t: 'question_response',
        id: m.req.id,
        status,
        text: status === 'skipped' ? '' : text,
      });
    },

    /* ==========================================================
       Session list and per-session settings
       ========================================================== */
    requestSessionList() {
      const key = get().activeKey;
      if (key === null) return;
      patch(key, { listedSessions: false });
      sendTo(key, { v: 1, t: 'session_list' });
    },

    deleteSession(id) {
      const s = get();
      const key = s.activeKey;
      if (key === null) return;

      // **Any other child holding this session is stopped first.** The runtime
      // waits its *own* turn out before deleting (see `Server.deleteSession`),
      // but it cannot see another process's writer — and deleting a file out
      // from under an appender is how a half line happens. With one session per
      // conversation that other process is now possible, so it is checked.
      for (const other of s.order) {
        if (other === key) continue;
        if (s.sessions[other]?.sessionId === id) void get().detachSession(other);
      }

      // No optimistic removal: the row leaves the list when the runtime's next
      // `sessions` arrives, because the delete can fail (a locked file, a
      // `sub-` id) and a row that vanished on send would be a lie.
      sendTo(key, { v: 1, t: 'session_delete', session_id: id });
    },

    setAutopilot(on) {
      const key = get().activeKey;
      if (key === null) return;
      // Absolute state, not a toggle. The display waits for `ui(state)`.
      sendTo(key, { v: 1, t: 'set_autopilot', on });
    },

    chooseModel(model) {
      const key = get().activeKey;
      set({ panel: null });
      if (key === null) return;
      sendTo(key, { v: 1, t: 'set_model', model });
    },

    chooseEffort(effort) {
      const key = get().activeKey;
      set({ panel: null });
      if (key === null) return;
      sendTo(key, { v: 1, t: 'set_effort', effort });
    },

    setThinking(on) {
      const key = get().activeKey;
      if (key === null) return;
      sendTo(key, { v: 1, t: 'set_thinking', on });
    },

    requestBlock(which) {
      const key = get().activeKey;
      set({ panel: null });
      if (key === null) return;
      if (which === 'status') sendTo(key, { v: 1, t: 'status' });
      if (which === 'tools') sendTo(key, { v: 1, t: 'tools' });
      if (which === 'context') sendTo(key, { v: 1, t: 'context' });
      if (which === 'compact') sendTo(key, { v: 1, t: 'compact' });
    },

    requestMcp(action, servers) {
      const key = get().activeKey;
      if (key === null) return;
      // A load/unload is a real round trip — the runtime waits the running turn
      // out and then connects, which is seconds — so the row marks it as in
      // flight. `list` changes nothing and answers immediately, so it is not worth
      // marking.
      //
      // This is **not** an optimistic update: it claims nothing about the server's
      // state, only that this front end has just sent the request. The state still
      // comes from `ui(state)` and from nowhere else.
      if (action !== 'list') {
        const current = get().sessions[key];
        const pending = new Set(current?.mcpPending ?? []);
        for (const name of servers) pending.add(name);
        patch(key, { mcpPending: [...pending] });
      }
      sendTo(key, { v: 1, t: 'mcp', action, servers });
    },

    requestSkills() {
      const key = get().activeKey;
      if (key === null) return;
      sendTo(key, { v: 1, t: 'skills' });
    },

    goalAction(action) {
      const key = get().activeKey;
      if (key === null) return;
      sendTo(key, action === undefined ? { v: 1, t: 'goal' } : { v: 1, t: 'goal', action });
    },

    refreshState() {
      const key = get().activeKey;
      if (key === null) return;
      throttled(key, () => sendTo(key, { v: 1, t: 'refresh_state' }));
    },

    /* ==========================================================
       The workspace: files
       ========================================================== */

    listFiles(path) {
      const key = get().activeKey;
      if (key === null) return;
      patch(key, { filesLoading: true });
      // The path is sent verbatim. Whether it exists, is a directory, or stays
      // inside the workspace is the **runtime's** judgement — it holds the
      // boundary — and a second check here would be a second answer that
      // eventually disagrees with it.
      sendTo(key, { v: 1, t: 'file_list', path });
    },

    readFile(path) {
      const key = get().activeKey;
      if (key === null) return;
      sendTo(key, { v: 1, t: 'file_read', path });
    },

    /* ==========================================================
       The workspace: terminals
       ========================================================== */

    listTerminals() {
      const key = get().activeKey;
      if (key === null) return;
      sendTo(key, { v: 1, t: 'terminal_list' });
    },

    createTerminal(options) {
      const key = get().activeKey;
      if (key === null) return;
      // The size is sent only when the caller has one: the runtime's own default
      // is the right answer here, and this layer has no idea how big the pane
      // will be when the shell's first output arrives.
      const message: {
        v: 1;
        t: 'terminal_create';
        cwd?: string;
        cols?: number;
        rows?: number;
      } = { v: 1, t: 'terminal_create' };
      if (options?.cwd !== undefined && options.cwd !== '') message.cwd = options.cwd;
      if (options?.cols !== undefined) message.cols = options.cols;
      if (options?.rows !== undefined) message.rows = options.rows;
      sendTo(key, message);
    },

    terminalInput(id, data) {
      const key = get().activeKey;
      if (key === null) return;
      // Fire and forget, and that is the shape of a terminal rather than a
      // shortcut: the reply is `ui(terminal_output)` on its own schedule, and
      // most input (a keystroke in a shell that is waiting) produces none at all.
      sendTo(key, { v: 1, t: 'terminal_input', terminal_id: id, data });
    },

    resizeTerminal(id, cols, rows) {
      const key = get().activeKey;
      if (key === null) return;
      // A size nobody asked for is worse than none: `vim` and `top` redraw at the
      // wrong width, which on screen is indistinguishable from a rendering bug
      // in this window. So a nonsensical size is dropped here as well as in the
      // runtime.
      if (cols <= 0 || rows <= 0) return;
      sendTo(key, { v: 1, t: 'terminal_resize', terminal_id: id, cols, rows });
    },

    killTerminal(id) {
      const key = get().activeKey;
      if (key === null) return;
      patchWith(key, (current) => ({
        terminalPending: current.terminalPending.includes(id)
          ? current.terminalPending
          : [...current.terminalPending, id],
      }));
      // **No optimistic status change.** The row still reads whatever the
      // runtime last said, and it changes when `ui(terminal_exit)` arrives —
      // which is the design's rule that the runtime is the only source of truth
      // for whether a terminal is running. A kill that was refused must not look
      // like a kill that worked.
      sendTo(key, { v: 1, t: 'terminal_kill', terminal_id: id });
    },

    attachTerminal(id) {
      const key = get().activeKey;
      if (key === null) return;
      patch(key, { activeTerminalId: id });
    },

    async pickWorkspace() {
      // A different workspace means a different child process: the runtime takes
      // its working directory as the workspace, and the file tools' boundary is
      // exactly that. Opening a session there is a new process, not a move.
      const picked = await chooseWorkspaceDirectory();
      if (picked === null) return;
      // Picking a directory is also a decision to keep it: a place somebody just
      // navigated to is a place they will want again, and asking them to bookmark
      // it separately would be asking twice for one intention.
      get().addWorkspace(picked);
      await get().enterWorkspace(picked);
    },

    async enterWorkspace(path) {
      const s = get();
      // Already there: a live session in that directory is focused rather than
      // duplicated, and — the part that changed — no other session is touched.
      // Opening a conversation in another workspace used to kill the one that
      // was running, which is precisely what the second target scenario needs to
      // stop happening.
      const existing = s.order.find((key) => {
        const bucket = s.sessions[key];
        return bucket && bucket.workspace !== '' && samePath(bucket.workspace, path);
      });
      if (existing) {
        get().focusSession(existing);
        return;
      }
      await get().attachSession({ workspace: path });
    },

    addWorkspace(path) {
      const trimmed = path.trim();
      if (trimmed === '') return;
      const list = get().workspaces;
      if (list.some((entry) => samePath(entry, trimmed))) return;
      set({ workspaces: [...list, trimmed] });
      persistPrefs(get());
    },

    removeWorkspace(path) {
      const list = get().workspaces.filter((entry) => !samePath(entry, path));
      if (list.length === get().workspaces.length) return;
      set({ workspaces: list });
      persistPrefs(get());
    },

    async applyLaunch(next) {
      // The two arguments this panel owns are start-up arguments, so applying
      // them means a new child. The workspace comes from the active session's
      // `init.workspace` — the runtime's own answer about where it is — rather
      // than from a remembered value.
      const current = activeRuntime(get());
      set({
        // Remembered first, and unconditionally: these are the defaults the *next*
        // open uses, and a launch that fails must not silently drop the choice the
        // person just made.
        ericaiDefault: next.ericai,
        maxStepsDefault: next.maxSteps,
      });
      persistPrefs(get());
      const workspace = current?.workspace ?? '';
      await get().attachSession({
        ...(workspace === '' ? {} : { workspace }),
        ericai: next.ericai,
        maxSteps: next.maxSteps ?? undefined,
      });
    },

    toolFacts(name) {
      return lookupToolFacts(activeRuntime(get()), name);
    },
  };
});

/* ============================================================
   Helpers
   ============================================================ */

/** Release the preview URLs of a set of stashed pictures. */
function releaseImages(images: PastedImage[]): void {
  for (const image of images) URL.revokeObjectURL(image.url);
}

/**
 * A tool's facts for one session's stream rows.
 *
 * `ui(tools)` is the richer source — it also carries the disposition and the
 * command argument — but it is only ever sent because somebody asked for the
 * `/tools` screen. The handshake's registry is the one that is always there, so
 * it is what a tool row's risk badge is actually drawn from. `external` is only
 * in the richer source, and stays unknown until then rather than being guessed
 * as false.
 *
 * It takes the bucket rather than the key because the reducer calls it once per
 * event and re-reading the store each time would be a lookup per tool call for a
 * fact that cannot change inside one message.
 */
function lookupToolFacts(bucket: SessionRuntime | null, name: string): ToolFacts | null {
  if (!bucket) return null;
  const live = bucket.tools.find((tool) => tool.name === name);
  const registry = bucket.toolRegistry.find((tool) => tool.name === name);
  if (!live && !registry) return null;
  return {
    risk: live?.risk ?? registry?.risk ?? null,
    parallelSafe: live?.parallelSafe ?? registry?.parallelSafe ?? null,
    interactive: live?.interactive ?? registry?.interactive ?? null,
    external: live ? live.external : null,
  };
}

/** Turn whatever a failed IPC call threw into a sentence for a person. The
 *  Rust side already writes these for a reader ("the runtime binary … was not
 *  found next to the application"), so they are passed through. */
function describeFailure(err: unknown): string {
  if (typeof err === 'string' && err.trim() !== '') return err;
  if (err instanceof Error && err.message.trim() !== '') return err.message;
  return String(err);
}

/* ============================================================
   ui(state) landing, plus the auto-expand rule
   ============================================================ */

function applyStateSnapshot(
  set: (partial: Partial<AppStore> | ((s: AppStore) => Partial<AppStore>)) => void,
  get: () => AppStore,
  key: string,
  snap: VmState,
): void {
  const s = get();
  const bucket = s.sessions[key];
  if (!bucket) return;

  const hasContent: Record<SidebarBlockKey, boolean> = {
    goal: snap.goal.present,
    tasks: snap.todos.length > 0,
    skills: snap.skills.length > 0,
    jobs: snap.jobs.length > 0,
    mcp: snap.mcp.some((server) => server.state === 'loaded'),
  };

  // The block-fold preferences are **window-level**, and they stay that way: a
  // folded rail is where a person put it, and having it spring open because a
  // background session acquired a task would be a layout that moves on its own.
  // The "expand once on first appearance" rule is therefore shared, which at
  // worst means the second session to acquire a block does not get the one-time
  // expansion — the block is still there, with its count, one click away.
  const collapsed = { ...s.blockCollapsed };
  const autoExpanded = { ...s.blockAutoExpanded };
  let changedPrefs = false;

  for (const blockKey of SIDEBAR_BLOCKS) {
    const touched = s.blockTouched[blockKey] === true;
    if (!touched && hasContent[blockKey] && !autoExpanded[blockKey]) {
      collapsed[blockKey] = false;
      autoExpanded[blockKey] = true;
      changedPrefs = true;
    }
  }

  // The catalogue only travels on the **first** snapshot, so a later one must
  // not wipe it: the panel would lose every description the session ever had.
  // `null` is what "absent" looks like after projection, and an empty array is
  // a real answer ("this runtime has no catalogue").
  const catalog = snap.skillCatalog.length > 0 ? snap.skillCatalog : bucket.skillCatalog;
  // Re-merges the loaded set against the descriptions and digests that only
  // this message carries. Without it the panel shows `N / 0` and every row's
  // description is missing, because the catalogue it reads is never written.
  const merged = mergeSkills(snap.skills, catalog, bucket.skillAvailable, bucket.skillActive);

  const session = bucket.session;
  set((state) => {
    const live = state.sessions[key];
    if (!live) return {};
    return {
      sessions: {
        ...state.sessions,
        [key]: {
          ...live,
          uiState: snap,
          skillCatalog: catalog,
          skills: merged.loaded,
          skillAvailable: merged.available,
          ...(session
            ? {
                session: {
                  ...session,
                  // These follow the runtime, not the request that asked for them.
                  //
                  // `''` is the projection's "the key was absent or not a string", so
                  // it is tested explicitly rather than left to `||`. The two agree
                  // today because the runtime always sends the current model — but
                  // `||` would also swallow a *deliberately* empty value, and there is
                  // no way to tell the two apart after the fact.
                  model: snap.model === '' ? session.model : snap.model,
                  provider: snap.modelProvider === '' ? session.provider : snap.modelProvider,
                  thinking: snap.thinking,
                  effort: snap.effort,
                  effortLevels:
                    snap.effortLevels.length > 0 ? snap.effortLevels : session.effortLevels,
                  contextTokens: snap.modelWindow,
                  steps: snap.steps,
                },
              }
            : {}),
        },
      },
      ...(changedPrefs ? { blockCollapsed: collapsed, blockAutoExpanded: autoExpanded } : {}),
    };
  });

  // The auto-expand rule changes a **persisted** preference (`blockCollapsed`),
  // and a preference that changed without being written is one that silently
  // reverts on the next launch — the sidebar would come back in a shape the
  // person did not leave it in. Only written when it actually changed, so a
  // snapshot refresh is not a disk write.
  if (changedPrefs) persistPrefs(get());

  // Something is still outstanding: ask once, throttled **for this session**.
  // This is the only reason the front end ever polls — and it gives up after a
  // few identical answers, so a job nobody collects cannot turn this into a
  // heartbeat.
  const outstandingKey = snap.jobs
    .filter((job) => job.outstanding)
    .map((job) => `${job.id}:${job.state}:${job.seconds}`)
    .sort()
    .join(',');
  noteOutstanding(key, outstandingKey);
  if (outstandingKey !== '') {
    throttled(key, () => sendTo(key, { v: 1, t: 'refresh_state' }));
  }
}

/* ============================================================
   Selectors — every one of them takes the session it is about
   ============================================================ */

/** The status bar's coarse phase, for one session. */
export function selectPhase(s: AppStore, key: string | null): Phase {
  const bucket = runtimeOf(s, key);
  if (!bucket) return 'booting';
  if (!bucket.ready) return 'booting';
  if (hasRunningTurn(bucket.entries)) return 'running';
  const stop = lastStopReason(bucket.entries);
  if (stop === null) return 'idle';
  return phaseFromStopReason(stop);
}

/** Effort levels come from the runtime and change with the model.
 *  Same caveat as `selectAskOn`: subscribe with `useShallow`. */
export function selectEffortLevels(s: AppStore, key: string | null): string[] {
  const bucket = runtimeOf(s, key);
  return bucket?.uiState?.effortLevels ?? bucket?.session?.effortLevels ?? NO_EFFORT_LEVELS;
}

/**
 * Which risks the runtime will ask about, for one session. Read-only; never
 * re-derived here.
 *
 * **This returns a fresh array, so it must be subscribed with `useShallow`.**
 * zustand compares snapshots by identity, and a selector that builds a new array
 * on every call never compares equal — the store then re-renders forever and the
 * component never commits, which shows up as an empty screen rather than as an
 * error. Every call site wraps it:
 *
 *     const askOn = useApp(useShallow((s) => selectAskOn(s, key)));
 */
export function selectAskOn(s: AppStore, key: string | null): string[] {
  const scope = runtimeOf(s, key)?.uiState?.riskScope ?? [];
  return scope.filter((row) => row.disposition === 'ask').map((row) => row.risk);
}

/**
 * Stable empty values for the same reason.
 *
 * `x ?? []` inside a selector allocates a new array whenever `x` is absent, so
 * it loops for exactly the same reason as above. These constants are shared, so
 * the snapshot keeps its identity while the underlying data is missing.
 *
 * They are typed as the view models, because that is what `uiState` holds.
 */
export const NO_RISK_SCOPE: VmRiskScope[] = [];
export const NO_EFFORT_LEVELS: string[] = [];
export const NO_SUBAGENTS: VmSubagent[] = [];
export const NO_JOBS: VmJob[] = [];
export const NO_TOOLS: VmTool[] = [];
export const NO_MODELS: VmModel[] = [];

export function selectAutopilot(s: AppStore, key: string | null): boolean {
  return runtimeOf(s, key)?.uiState?.autopilot ?? false;
}

/** The cache hit rate, or null when no lookup has happened yet. */
export function selectCacheHitRate(s: AppStore, key: string | null): number | null {
  const status = runtimeOf(s, key)?.status;
  if (!status) return null;
  return cacheHitRate(status.usage);
}

/**
 * The status bar's right-hand usage numbers, for one session.
 *
 * They come from `ui(status)`, not `ui(state)`: the snapshot has no usage, no
 * cache rate and no elapsed time (§5.3). With no window known, `percent` is
 * null and the bar reports the amount alone.
 *
 * **Two different facts, two different fields.** `last_prompt_tokens` is the
 * input of the last *successful* request — what the provider actually received.
 * `context.used` is the context layer's own **local estimate** of what it would
 * send. The reference front end keeps them apart on purpose ("a wrong one is
 * worse than none"): one is a measurement, the other is arithmetic, and
 * swapping one in for the other labels an estimate as a measurement.
 */
export interface UsageView {
  /** The provider's own count for the last successful call, or null. */
  used: number | null;
  window: number | null;
  percent: number | null;
  cacheHitRate: number | null;
  /** The context layer's local estimate. Never a substitute for `used`. */
  estimated: number | null;
  /** The estimate's own percentage, against the same window. */
  estimatedPercent: number | null;
}

export function selectUsage(s: AppStore, key: string | null): UsageView {
  const bucket = runtimeOf(s, key);
  const status = bucket?.status;
  const snap = bucket?.uiState;
  const context = bucket?.context;

  // No `??` between these two: a missing provider count is "unknown", not an
  // invitation to show the estimate under the provider's name.
  const used = status?.lastPromptTokens ?? null;
  const estimated = context?.used ?? null;
  // The window travels with the status screen; the snapshot's `model_window` is
  // the same fact from the other message, and either will do.
  const window = status?.window ?? snap?.modelWindow ?? null;
  const percent = used !== null && window !== null && window > 0 ? used / window : null;
  const estimatedPercent =
    estimated !== null && window !== null && window > 0 ? estimated / window : null;
  const hit = status ? cacheHitRate(status.usage) : null;

  return {
    used,
    window,
    percent,
    cacheHitRate: hit,
    estimated,
    estimatedPercent,
  };
}

/**
 * What a session's status dot says.
 *
 * The order is the order of **who needs the person most**, and it decides which
 * single dot is drawn when several conditions hold at once. It is not a sort
 * order for the list: rows keep their place, because one that moves under the
 * cursor is worse than one that needs looking at twice.
 */
export type RowStatus = 'asking' | 'broken' | 'running' | 'unseen' | 'idle';

export function selectRowStatus(s: AppStore, key: string): RowStatus {
  const bucket = s.sessions[key];
  if (!bucket) return 'idle';

  // Waiting on a person outranks everything: it is the only state where nothing
  // at all will happen until somebody acts.
  if (s.pendingModals.some((entry) => entry.key === key)) return 'asking';

  // **Red is only for "you did not stop it, and it broke."** `interrupted`,
  // `step_limit` and `empty` are deliberately *not* here: pressing Esc three
  // times must not earn three red dots, or red stops meaning anything.
  const stop = lastStopReason(bucket.entries);
  const failed =
    stop === 'model_error' ||
    stop === 'model_fatal' ||
    (bucket.runtimeExit !== null && !bucket.runtimeExit.requested);
  if (failed) return 'broken';

  if (hasRunningTurn(bucket.entries)) return 'running';

  // Finished, and nobody has looked. This is the state a three-colour scheme
  // would render as nothing, at exactly the moment it matters most.
  if (bucket.unseen) return 'unseen';

  return 'idle';
}

/**
 * Every live session's status, as one compact string.
 *
 * A string rather than a `Map`, and that is what keeps the left rail from
 * re-rendering on every token: zustand compares selector output by identity, and
 * a fresh `Map` per call never compares equal — while subscribing to `sessions`
 * directly *would* compare equal only when a bucket's identity changed, which
 * streaming `delta`s do on every chunk. This string changes only when a status
 * actually changes, so a session streaming a long answer does not repaint the
 * rail sixty times a second.
 *
 * Format: `sessionId:status` per live session, comma-separated, order-stable.
 * Only sessions whose `init` has landed appear: a new session's id is minted by
 * the runtime, so before the handshake there is no id to attach a row to.
 */
export function selectRowStatusKey(s: AppStore): string {
  const parts: string[] = [];
  for (const key of s.order) {
    const rt = s.sessions[key];
    if (!rt?.sessionId) continue;
    parts.push(`${rt.sessionId}:${selectRowStatus(s, key)}`);
  }
  return parts.join(',');
}

/**
 * How many sessions in each workspace want attention, as one compact string.
 *
 * The workspace row's badge, and it answers the question the session dots cannot
 * when the answer is in a workspace somebody is not looking at: "is anything
 * waiting for me over there". Same string trick as `selectRowStatusKey`, and for
 * the same reason — this is drawn above a list that streams.
 *
 * Format: `workspace\u0000count`, joined by `\u0001`. The separators are control
 * characters because a Windows path cannot contain them, so no path can be
 * confused for a separator.
 *
 * Only the states that mean "a person has to do something": a session that is
 * merely running is not asking for anything.
 */
export function selectWorkspaceAttentionKey(s: AppStore): string {
  const counts = new Map<string, number>();
  for (const key of s.order) {
    const rt = s.sessions[key];
    if (!rt) continue;
    const status = selectRowStatus(s, key);
    if (status !== 'asking' && status !== 'broken' && status !== 'unseen') continue;
    const workspace = rt.session?.workspace ?? rt.workspace;
    if (workspace === '') continue;
    counts.set(workspace, (counts.get(workspace) ?? 0) + 1);
  }
  return [...counts.entries()].map(([ws, n]) => `${ws}\u0000${n}`).join('\u0001');
}

/**
 * Which session a blocking request came from, as one short label.
 *
 * The two requests carry no `session_id` (`protocol/schema/outbound.schema.json`),
 * so the key is the only thing that knows — and `ModalEntry.key` holds it. What
 * a reader needs is not the key: it is **which conversation**, and with several
 * open that is the session's own id plus the workspace it is in.
 *
 * Falls back to the workspace's base name, and then to nothing at all rather
 * than to an invented label: a session whose `init` has not landed yet genuinely
 * has no id, and "unknown" would be a worse answer than the workspace alone.
 */
export function selectModalOrigin(s: AppStore, key: string): string {
  const rt = s.sessions[key];
  if (!rt) return '';
  const workspace = rt.session?.workspace ?? rt.workspace;
  const name = workspace === '' ? '' : baseName(workspace);
  const id = rt.sessionId ?? rt.session?.id ?? '';
  if (id !== '' && name !== '') return `${name} · ${id}`;
  if (id !== '') return id;
  return name;
}

/**
 * How many requests are waiting behind the one on screen.
 *
 * The queue has always held them (a second blocking request used to overwrite
 * the first, losing an id the runtime waits on forever), but until now it was
 * invisible: with one session there was rarely more than one, and with several
 * two conversations can be waiting at once. A count is what says "there is
 * another one after this" instead of leaving it to be discovered.
 */
export function selectQueuedModals(s: AppStore): number {
  return Math.max(0, s.pendingModals.length - 1);
}

/** How many sessions are running a turn right now. A window-level summary. */
export function selectRunningCount(s: AppStore): number {
  return s.order.filter((key) => hasRunningTurn(s.sessions[key]?.entries ?? [])).length;
}

/** How many sessions in a workspace want attention (asking, broken, unseen). */
export function selectWorkspaceAttention(s: AppStore, workspace: string): number {
  return s.order.filter((key) => {
    const bucket = s.sessions[key];
    if (!bucket) return false;
    if (bucket.workspace === '' || !samePath(bucket.workspace, workspace)) return false;
    const status = selectRowStatus(s, key);
    return status === 'asking' || status === 'broken' || status === 'unseen';
  }).length;
}
