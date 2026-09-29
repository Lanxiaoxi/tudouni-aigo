/**
 * Global state.
 *
 * The split (§6.1) is the whole design here:
 *   - **Runtime facts** are written only by `applyRuntimeMessage`. The front end
 *     stores them, it never invents them.
 *   - **Front-end preferences** (quiet mode, sidebar and block folding, the
 *     draft, input history) live here too, because they are presentation
 *     choices and not runtime state.
 *
 * And one prohibition: **no optimistic updates**. Pressing "always allow" sends
 * an outbound message and nothing else; the display changes when `ui(state)`
 * comes back. Anything else makes "the screen says on, it is actually off"
 * possible.
 */

import { create } from 'zustand';
import type {
  FrontendMsg,
  ModelAlias,
  PermissionDecision,
  PermissionRequestMsg,
  PermissionScope,
  QuestionRequestMsg,
  QuestionStatus,
  RuntimeMsg,
  SkillCatalogRow,
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
import { send as busSend } from '@/runtime/bus';
import { insertPathAtCaret, type PastedImage } from '@/runtime/paste';
import { samePath } from '@/utils/format';
import {
  attachRuntime,
  chooseWorkspaceDirectory,
  quitApp,
  stashImage,
  type BridgeOptions,
} from '@/runtime/tauri';

/* ============================================================
   Constants that belong to the presentation layer
   ============================================================ */

/**
 * Content caps per sidebar block.
 *
 * Decision 6: the protocol has no `caps` — it is a presentation choice, so it
 * lives here as a constant rather than being asked of the runtime. Overflow is
 * dropped from the bottom and labelled `(+N more)`; it is never silently cut.
 */
export const BLOCK_CAP = 5;

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
  | 'settings';

export type SidebarBlockKey = 'goal' | 'tasks' | 'skills' | 'jobs' | 'mcp';

export const SIDEBAR_BLOCKS: SidebarBlockKey[] = ['goal', 'tasks', 'skills', 'jobs', 'mcp'];

export type ModalEntry =
  | { kind: 'permission'; req: PermissionRequestMsg }
  | { kind: 'question'; req: QuestionRequestMsg };

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
 * What the running child was actually started with.
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

export interface AppStore {
  /* ---------------- the runtime link ---------------- */
  ready: boolean;
  /** The runtime's own version, read once via `--version` at start-up. `dev`
   *  when it was not a release build — shown as-is, not prettified. */
  runtimeVersion: string | null;
  /** This application's version. Its own, independent of the runtime's. */
  desktopVersion: string;
  /** From the OS, so the greeting can use a name. Empty when unavailable. */
  userName: string;
  /** Set when the child process ends without being asked to. */
  runtimeExit: { code: number; requested: boolean } | null;
  /**
   * Why the runtime could not be started, as a sentence.
   *
   * The Rust side returns genuinely useful text here — "the runtime binary was
   * not found next to the application", "the workspace C:\\Users\\x cannot be
   * used (home): the runtime refuses it" — and until this existed the promise
   * was dropped on the floor, leaving "Starting the runtime…" on screen forever
   * with no way out.
   */
  startupProblem: string | null;
  /**
   * The child's stderr, verbatim, bounded.
   *
   * Diagnostics, never protocol content: the runtime's own sentences for a
   * person arrive as `notice` messages. This is for the case where the runtime
   * died before it could say anything — a flag it did not understand, a missing
   * shared library — and the only explanation is what it printed on the way out.
   */
  stderrTail: string[];

  /* ---------------- session ---------------- */
  session: SessionInfo | null;
  sessionList: VmSessionListItem[];
  listedSessions: boolean;
  /** A local fact: has this session been spoken to. "Never spoken" and "idle"
   *  are two different labels in the status bar. */
  hasSpoken: boolean;
  /** Wall time of the last finished turn. Local: `run_finished` carries
   *  `duration_ms` and that is what this is set from. */
  lastTurnMs: number | null;

  /* ---------------- stream ---------------- */
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
   * Lines the decoder refused.
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

  /* ---------------- snapshots ---------------- */
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
   */
  pendingModals: ModalEntry[];
  panel: PanelKind | null;

  /* ---------------- front-end preferences ---------------- */
  quiet: boolean;
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
   * workspace is **current** — `init.workspace` — and that is a runtime fact,
   * read from the session rather than from this list.
   *
   * So this is a list of places a person can go, not a claim about where the
   * runtime is. The two are drawn together (a row is marked current when it
   * matches `init.workspace`) but they are never conflated: a bookmark that the
   * runtime is not in is simply not current.
   */
  workspaces: string[];

  /* ---------------- start-up arguments ---------------- */
  /**
   * What the child that is running now was started with.
   *
   * The settings panel draws **this**, not the remembered default, because this is
   * the one that is true right now. See `LaunchArgs`.
   */
  launch: LaunchArgs;
  /**
   * The remembered defaults the *next* child is started with.
   *
   * Kept apart from `launch` deliberately, and the two are never merged in the
   * display: a value remembered for next time must not read as "this is on now",
   * the same way a bookmarked workspace must not read as the current one.
   */
  ericaiDefault: boolean;
  maxStepsDefault: number | null;

  /* ---------------- composer ---------------- */
  draft: string;
  history: string[];
  historyCursor: number | null;
  /** An OS drag is currently over the window. Purely local, purely visual. */
  dragging: boolean;
  /**
   * The one thing the composer has to say about the current input.
   *
   * Local, not a runtime fact: the runtime never saw the drop or the paste. It is
   * kept so a refusal can be *said*, because a path the runtime cannot resolve
   * sits in the sentence looking exactly like one that worked.
   *
   * A single slot rather than one field per source, because these are all answers
   * to the same question ("what just happened to this input?") and the control row
   * has room for one. Two fields would mean two statements competing for the same
   * space, and the loser would be silently invisible.
   */
  composerNotice: ComposerNotice | null;
  /**
   * Pictures pasted into the current draft.
   *
   * A **front-end preference**, not a runtime fact: the runtime never hears about
   * a chip. The chips are drawn from these, but *which* are drawn is decided by
   * the draft text (`referencedImages`), because the text is the only thing that
   * gets sent — so deleting a path from the sentence drops its chip, and there is
   * no second source of truth to fall out of step.
   */
  pastedImages: PastedImage[];

  /* ---------------- actions ---------------- */
  send(msg: FrontendMsg): void;
  applyRuntimeMessage(msg: RuntimeMsg): void;
  /** Read once at start-up; not part of the protocol. `version` is the
   *  runtime's own (`--version`), null when it could not be read. */
  setRuntimeInfo(info: { version: string | null; userName: string | null }): void;

  /** Record why the runtime would not start, or clear it when one does. */
  setStartupProblem(problem: string | null): void;
  /** Append one stderr line. Bounded: this is a tail, not a log file. */
  pushStderr(line: string): void;
  /** Start the runtime again in the same workspace. The escape hatch for a
   *  start-up that failed for a transient reason. */
  retryRuntime(): Promise<void>;
  /**
   * Quit the application: finish the runtime, then close the window.
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
   * Write one pasted picture into the workspace and put its path in the draft.
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
  /** Drop every stashed picture and release their preview URLs. */
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
  /** Remove one in-stream block. It touches the stream, no data. */
  removeBlock(id: string): void;

  answerPermission(decision: PermissionDecision): void;
  answerQuestion(status: QuestionStatus, text: string): void;

  switchSession(id: string | null): void;
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
  /** Ask the OS for a directory, then restart the runtime in it. A different
   *  workspace is a different process, so this cannot be done in place. */
  pickWorkspace(): Promise<void>;
  /** Go to a workspace already in the list. Same restart, no dialog. */
  enterWorkspace(path: string): Promise<void>;
  /** Bookmark a workspace. A local act: nothing is started and nothing moves. */
  addWorkspace(path: string): void;
  /** Forget a bookmark. It does not touch the directory, and it does not move
   *  the runtime out of it — a workspace being *listed* and being *current* are
   *  two different things. */
  removeWorkspace(path: string): void;
  /** Look up a tool's facts for stream rows. Returns null when unknown. */
  toolFacts(name: string): ToolFacts | null;

  /**
   * Restart the child with the given start-up arguments, and remember them.
   *
   * **A restart rather than a message**, and that is forced by the runtime rather
   * than chosen here: `--ericai` decides at open which route the session manages
   * (`internal/runtime/composition.go`, `Options.EricAI`), and `--max-steps` is
   * read into the agent at assembly. Neither can be honoured by a running child, so
   * "apply" means "start another one".
   *
   * The caller is responsible for having asked first — this is the act, not the
   * confirmation. It is not allowed to run while a turn is in flight or while a
   * blocking prompt is up (see the settings panel), because the bridge's restart
   * path **kills** the previous child rather than waiting for it, and a kill
   * mid-turn can leave an assistant message whose tool results never arrived —
   * a session that can never be sent to again.
   *
   * Resolves once the bridge has accepted the new child. A failure lands in
   * `startupProblem`, which is already the one place a start-up refusal is shown.
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
   * Start-up arguments, as remembered *defaults for the next start*.
   *
   * These are preferences in the only sense that is honest here: they decide what
   * the next child is started with. They are **not** what is running — that comes
   * from `launch`, which records the arguments this session's child was actually
   * given. The two are drawn together in the settings panel and are never
   * conflated, for the same reason the workspace list and `init.workspace` are
   * not: a remembered value that nothing is using must not read as "this is on".
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
      quiet: parsed.quiet ?? fallback.quiet,
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

function persistPrefs(s: AppStore): void {
  try {
    localStorage.setItem(
      'aigo.prefs',
      JSON.stringify({
        quiet: s.quiet,
        sidebarVisible: s.sidebarVisible,
        leftbarVisible: s.leftbarVisible,
        blockCollapsed: s.blockCollapsed,
        blockTouched: s.blockTouched,
        sessionsCollapsed: s.sessionsCollapsed,
        workspaces: s.workspaces,
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
   Polling throttle
   ============================================================ */

let lastPollAt = 0;
/** Consecutive polls that came back with the same outstanding set. */
let pollStreak = 0;
/** The outstanding set the last poll was answered with, as a comparable key. */
let lastOutstandingKey = '';

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

/** `refresh_state` is not a heartbeat: it is only ever sent when something of
 *  ours is known to be outstanding, never faster than the floor, and it stops
 *  once the answer stops changing. */
function throttled(fn: () => void): void {
  const now = Date.now();
  if (now - lastPollAt < POLL_FLOOR_MS) return;
  if (pollStreak >= POLL_GIVE_UP_AFTER) return;
  lastPollAt = now;
  pollStreak += 1;
  fn();
}

/**
 * Note what the outstanding set looks like now.
 *
 * Called on every `ui(state)` landing. An unchanged set deepens the streak; a
 * changed one (a job finished, a new job appeared) resets it, so the backoff
 * only ever applies to a genuinely static situation.
 */
function noteOutstanding(key: string): void {
  if (key === lastOutstandingKey) return;
  lastOutstandingKey = key;
  pollStreak = 0;
}

/** Restart polling after something that can change the outcome — a finished
 *  turn, a tool result. Without this the give-up above would be permanent. */
function wakePolling(): void {
  pollStreak = 0;
  lastPollAt = 0;
}

/* ============================================================
   The store
   ============================================================ */

export const useApp = create<AppStore>((set, get) => ({
  ready: false,
  runtimeVersion: null,
  desktopVersion: __DESKTOP_VERSION__,
  userName: '',
  runtimeExit: null,
  startupProblem: null,
  stderrTail: [],

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

  modal: null,
  pendingModals: [],
  panel: null,

  quiet: prefs.quiet,
  sidebarVisible: prefs.sidebarVisible,
  leftbarVisible: prefs.leftbarVisible,
  blockCollapsed: prefs.blockCollapsed,
  blockTouched: prefs.blockTouched,
  blockAutoExpanded: {},
  reasoningOpen: {},
  toolOpen: {},
  sessionsCollapsed: prefs.sessionsCollapsed,
  workspaces: prefs.workspaces,

  // Nothing has been started yet, so "no flags" is the honest initial value
  // rather than a guess at what the first start will pass. `startRuntime` writes
  // the real one the moment the bridge accepts it.
  launch: { ericai: false, maxSteps: null },
  ericaiDefault: prefs.ericaiDefault,
  maxStepsDefault: prefs.maxStepsDefault,

  draft: '',
  history: [],
  historyCursor: null,
  dragging: false,
  composerNotice: null,
  pastedImages: [],

  /* ==========================================================
     Outbound
     ========================================================== */
  send(msg) {
    busSend(msg);
  },

  setRuntimeInfo(info) {
    set({ runtimeVersion: info.version, userName: info.userName ?? '' });
  },

  setStartupProblem(problem) {
    set({ startupProblem: problem });
  },

  pushStderr(line) {
    const tail = get().stderrTail;
    // A tail, not a log: the last N lines are what explain a refusal, and an
    // unbounded array would grow for the life of a long session.
    const next = [...tail, line];
    set({ stderrTail: next.length > STDERR_TAIL ? next.slice(next.length - STDERR_TAIL) : next });
  },

  async retryRuntime() {
    set({ startupProblem: null, stderrTail: [] });
    await startRuntime({});
  },

  async quit() {
    await quitApp();
  },

  /* ==========================================================
     Inbound: the only door for runtime facts
     ========================================================== */
  applyRuntimeMessage(msg) {
    const s = get();

    switch (msg.t) {
      case 'init': {
        const init = projectInit(msg);
        // The handshake's notices are the runtime's own sentences, written for a
        // person. They are kept in their own field, because `session_load`
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
        set({
          ready: true,
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
          entries: [...s.entries, ...notices],
        });
        // The first screen shows the four most recent sessions, and only this
        // message ever asks for them. Without it those slots stay empty until
        // somebody opens `/resume`, and `Ctrl+1..9` has nothing to switch to.
        set({ listedSessions: false });
        busSend({ v: 1, t: 'session_list' });
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
        // The handshake's diagnostics go back at the head of the rebuilt stream.
        // They belong to the session, not to the moment they were said, and the
        // design is explicit that they are not pushed out by session content.
        set({
          entries: [...s.handshakeNotices, ...rebuilt],
          activeRunId: null,
          lastRunId: null,
          hasSpoken: history.length > 0,
        });
        break;
      }

      case 'event': {
        const result = reduceEvent(
          s.entries,
          // `event` is the audit record forwarded verbatim: loose by design, and
          // unknown kinds and extra fields must be tolerated rather than rejected.
          msg as unknown as LooseEvent,
          {
            activeRunId: s.activeRunId,
            lastRunId: s.lastRunId,
            lookup: (name) => get().toolFacts(name),
            maxSteps: s.session?.maxSteps ?? 0,
          },
        );
        if (result.stale) {
          set({ lateDropped: s.lateDropped + 1 });
          break;
        }
        set({
          entries: result.entries,
          activeRunId: result.startedRunId ?? (result.runEnded ? null : s.activeRunId),
          lastRunId: result.startedRunId ?? (result.runEnded ? msg.run_id : s.lastRunId),
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
          wakePolling();
          throttled(() => busSend({ v: 1, t: 'status' }));
        }
        break;
      }

      case 'ui': {
        switch (msg.kind) {
          case 'state': {
            const next = projectState(msg);
            applyStateSnapshot(set, get, next);
            break;
          }
          case 'status': {
            set({ status: projectStatus(msg) });
            break;
          }
          case 'tools': {
            const projected = projectToolsMsg(msg);
            set({ tools: projected.tools, grantedPrefixes: projected.grantedPrefixes });
            set({ entries: pushBlock(get().entries, 'tools', msg) });
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
            set({ mcp: projected.servers, mcpNotes: projected.notes, mcpPending: [] });
            // The runtime's own notes go into the stream, verbatim.
            if (projected.notes.length > 0) {
              set({
                entries: [
                  ...get().entries,
                  ...projected.notes.map((text) => ({
                    kind: 'note' as const,
                    id: nextId('note'),
                    tone: 'info' as const,
                    code: 'mcp',
                    text,
                  })),
                ],
              });
            }
            break;
          }
          case 'context': {
            const context = projectContext(msg);
            set({ context });
            set({ entries: pushBlock(get().entries, 'context', msg) });
            break;
          }
          case 'compacted': {
            const projected = projectCompacted(msg);
            set({ compaction: projected.compaction });
            if (projected.context) set({ context: projected.context });
            set({ entries: pushBlock(get().entries, 'compact', msg) });
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
              s.uiState?.skills ?? [],
              s.skillCatalog,
              projected.available,
              projected.active,
            );
            set({
              skills: merged.loaded,
              skillAvailable: merged.available,
              skillActive: projected.active,
              skillProblems: projected.problems,
              skillShadowed: projected.shadowed,
            });
            break;
          }
          case 'run_finished': {
            const runId = msg.run_id;
            // The two `run_finished` messages are not ordered, so pairing is by
            // run id alone. A mismatch against a *different* finished run is
            // dropped; anything else is this session's answer.
            if (
              s.activeRunId !== null &&
              runId !== s.activeRunId &&
              runId !== s.lastRunId
            ) {
              set({ lateDropped: get().lateDropped + 1 });
              break;
            }
            set({
              // `answer` is read through a type guard rather than passed
              // straight on. It reaches `Markdown`, which calls `text.replace`,
              // and there is no error boundary above it — so one message with a
              // missing or non-string `answer` would blank the whole window
              // instead of dropping a line. A missing answer is simply absent:
              // `applyFinalAnswer` keeps the streamed body in that case.
              entries: applyFinalAnswer(
                get().entries,
                runId,
                typeof msg.answer === 'string' ? msg.answer : '',
              ),
              activeRunId: null,
              lastRunId: runId,
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
          s.entries,
          msg.run_id,
          msg.step,
          msg.channel,
          msg.text,
          s.activeRunId,
          s.lastRunId,
        );
        if (result.stale) {
          set({ lateDropped: s.lateDropped + 1 });
          break;
        }
        set({ entries: result.entries });
        break;
      }

      case 'delta_reset': {
        if (
          (s.activeRunId !== null && msg.run_id !== s.activeRunId) ||
          (s.activeRunId === null && s.lastRunId !== null && msg.run_id !== s.lastRunId)
        ) {
          set({ lateDropped: s.lateDropped + 1 });
          break;
        }
        // Both channels are cleared for that step: the message carries no
        // channel, and a reset invalidates whatever was drawn for the step.
        set({
          entries: clearStream(
            clearStream(s.entries, msg.run_id, msg.step, 'text'),
            msg.run_id,
            msg.step,
            'reasoning',
          ),
        });
        break;
      }

      case 'notice': {
        set({
          entries: [
            ...s.entries,
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
        set({ sessionList: projectSessionList(msg.items), listedSessions: true });
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
        set(enqueueModal(s, { kind: 'permission', req: msg }));
        break;
      }

      case 'question_request': {
        set(enqueueModal(s, { kind: 'question', req: msg }));
        break;
      }

      case 'runtime_exited': {
        // The runtime is gone, so this turn cannot end any other way. Without
        // this the phase stays "Running" forever: the composer sits behind its
        // Stop button, Enter and Esc both do nothing, and the "Stop" message
        // goes into a `.catch(() => {})` because there is no child to receive
        // it. The turn is settled with a reason the reader can act on.
        const settled = settleAbandonedTurn(s.entries);
        set({
          runtimeExit: { code: msg.code, requested: msg.requested },
          entries: settled,
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
     Composer
     ========================================================== */
  setDraft(v) {
    set({ draft: v, historyCursor: null });
  },

  setDragging(on) {
    set({ dragging: on });
  },

  setComposerNotice(notice) {
    set({ composerNotice: notice });
  },

  async stashPastedImage(bytes, at) {
    // No optimistic chip: the picture does not exist until the bridge has written
    // it, and a chip drawn before that would name a path the runtime cannot
    // resolve. So the order is write, then insert, then remember.
    let stashed;
    try {
      stashed = await stashImage(bytes);
    } catch (err) {
      // The bridge's own sentence, verbatim. It is already written for a person
      // ("the clipboard's image data is not a PNG, JPEG or GIF…"), and inventing
      // a second wording here would be a second fact.
      set({ composerNotice: { code: 'paste-failed', reason: String(err), tone: 'warn' } });
      return null;
    }

    const image: PastedImage = {
      path: stashed.path,
      name: stashed.name,
      bytes: stashed.bytes,
      mime: stashed.mime,
      // A preview the WebView can render without the asset protocol: the bytes are
      // already here, and `blob:` is in the CSP's `img-src`. The URL is owned by
      // this store, so `forgetPastedImage`/`clearPastedImages` revoke it — a
      // pasted picture that is never sent would otherwise be pinned in memory for
      // the life of the window.
      url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: stashed.mime })),
    };

    const current = get();
    const { text, caret } = insertPathAtCaret(current.draft, at, image.path);
    set({
      draft: text,
      historyCursor: null,
      pastedImages: [...current.pastedImages, image],
    });
    return caret;
  },

  forgetPastedImage(path) {
    const images = get().pastedImages;
    const doomed = images.find((image) => image.path === path);
    if (doomed) URL.revokeObjectURL(doomed.url);
    set({ pastedImages: images.filter((image) => image.path !== path) });
  },

  clearPastedImages() {
    for (const image of get().pastedImages) URL.revokeObjectURL(image.url);
    set({ pastedImages: [] });
  },

  historyNav(dir) {
    const { history, historyCursor } = get();
    if (history.length === 0) return;
    let cursor: number | null;
    if (historyCursor === null) {
      if (dir === 1) return; // Already at the newest end.
      cursor = history.length - 1;
    } else {
      cursor = historyCursor + dir;
    }
    if (cursor < 0) {
      set({ historyCursor: 0, draft: history[0] });
      return;
    }
    if (cursor >= history.length) {
      set({ historyCursor: null, draft: '' });
      return;
    }
    set({ historyCursor: cursor, draft: history[cursor] });
  },

  submitDraft() {
    const text = get().draft.trim();
    if (text === '') return;
    // A modal is blocking: nothing may be sent over the top of one.
    if (get().modal !== null) return;
    // The pictures have done their job the moment the sentence goes out: what
    // travels is the **path**, and the runtime reads the file itself. So the
    // stash and its preview URLs are released here rather than held — a chip for
    // a message that has already been sent would be a claim about the draft, and
    // the draft is now empty.
    for (const image of get().pastedImages) URL.revokeObjectURL(image.url);
    set({
      entries: [...get().entries, { kind: 'user', id: nextId('user'), text, atMs: Date.now() }],
      draft: '',
      history: [...get().history, text].slice(-100),
      historyCursor: null,
      hasSpoken: true,
      pastedImages: [],
      // Whatever was said about this input has been answered by sending it.
      composerNotice: null,
    });
    busSend({ v: 1, t: 'user_message', text });
  },

  interrupt() {
    busSend({ v: 1, t: 'interrupt' });
  },

  /* ==========================================================
     Panels and preferences
     ========================================================== */
  openPanel(p) {
    set({ panel: p });
    if (p === 'resume') {
      set({ listedSessions: false });
      busSend({ v: 1, t: 'session_list' });
    }
    if (p === 'skills') {
      busSend({ v: 1, t: 'skills' });
    }
    if (p === 'mcp') {
      // `mcp` is only ever sent because a person asked for it. The front end
      // never sends it on its own initiative — that would make "the config
      // widens itself" possible.
      busSend({ v: 1, t: 'mcp', action: 'list', servers: [] });
    }
  },

  setQuiet(q) {
    set({ quiet: q });
    persistPrefs(get());
  },

  toggleQuiet() {
    get().setQuiet(!get().quiet);
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
    set({ entries: get().entries.filter((e) => !(e.kind === 'block' && e.id === id)) });
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
    busSend({ v: 1, t: 'permission_response', id: m.req.id, decision });
  },

  answerQuestion(status, text) {
    const m = get().modal;
    if (!m || m.kind !== 'question') return;
    set(drainModal(get()));
    // `skipped` is an independent action, never an empty submit.
    busSend({
      v: 1,
      t: 'question_response',
      id: m.req.id,
      status,
      text: status === 'skipped' ? '' : text,
    });
  },

  /* ==========================================================
     Session and settings
     ========================================================== */
  switchSession(id) {
    // No sentinel for "new": a missing id *is* a new session. An id whose file
    // does not exist is a new session too.
    //
    // **The screen is not cleared here.** `internal/protocol/server.go` spells
    // this out: the old session survives a failed switch untouched, and a front
    // end is *not allowed* to clear its screen when it sends this request —
    // "precisely so that a failure here does not look like 'my session is
    // gone'". A switch that fails (unreadable session file, no factory) leaves
    // the runtime holding the old session and sends nothing that would put it
    // back, so clearing optimistically is unrecoverable.
    //
    // The moment to clear is when the new `session_load` arrives: that message
    // rebuilds the stream from the runtime's own copy, which is the only thing
    // entitled to replace it. The panel closes now because that is local.
    set({ panel: null });
    busSend(id === null ? { v: 1, t: 'session_switch' } : { v: 1, t: 'session_switch', session_id: id });
  },

  requestSessionList() {
    set({ listedSessions: false });
    busSend({ v: 1, t: 'session_list' });
  },

  deleteSession(id) {
    // No optimistic removal: the row leaves the list when the runtime's next
    // `sessions` arrives, because the delete can fail (a locked file, a
    // `sub-` id) and a row that vanished on send would be a lie. Deleting the
    // mounted session makes the runtime replace it and re-send the opening
    // triple, which `applyRuntimeMessage` already handles as a fresh session.
    busSend({ v: 1, t: 'session_delete', session_id: id });
  },

  setAutopilot(on) {
    // Absolute state, not a toggle. The display waits for `ui(state)`.
    busSend({ v: 1, t: 'set_autopilot', on });
  },

  chooseModel(model) {
    set({ panel: null });
    busSend({ v: 1, t: 'set_model', model });
  },

  chooseEffort(effort) {
    set({ panel: null });
    busSend({ v: 1, t: 'set_effort', effort });
  },

  setThinking(on) {
    busSend({ v: 1, t: 'set_thinking', on });
  },

  requestBlock(which) {
    set({ panel: null });
    if (which === 'status') busSend({ v: 1, t: 'status' });
    if (which === 'tools') busSend({ v: 1, t: 'tools' });
    if (which === 'context') busSend({ v: 1, t: 'context' });
    if (which === 'compact') busSend({ v: 1, t: 'compact' });
  },

  requestMcp(action, servers) {
    // A load/unload is a real round trip — the runtime waits the running turn
    // out and then connects, which is seconds — so the row marks it as in
    // flight. `list` changes nothing and answers immediately, so it is not worth
    // marking.
    //
    // This is **not** an optimistic update: it claims nothing about the server's
    // state, only that this front end has just sent the request. The state still
    // comes from `ui(state)` and from nowhere else.
    if (action !== 'list') {
      const pending = new Set(get().mcpPending);
      for (const name of servers) pending.add(name);
      set({ mcpPending: [...pending] });
    }
    busSend({ v: 1, t: 'mcp', action, servers });
  },

  requestSkills() {
    busSend({ v: 1, t: 'skills' });
  },

  goalAction(action) {
    busSend(action === undefined ? { v: 1, t: 'goal' } : { v: 1, t: 'goal', action });
  },

  refreshState() {
    throttled(() => busSend({ v: 1, t: 'refresh_state' }));
  },

  async pickWorkspace() {
    // A different workspace means a different child process: the runtime takes
    // its working directory as the workspace, and the file tools' boundary is
    // exactly that. So the bridge restarts the child rather than repointing it.
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
    // Already there: restarting would throw away a live session to arrive at the
    // same directory. `samePath` rather than `===` because the bookmark and the
    // runtime's `init.workspace` can differ in casing or separator while naming
    // one directory.
    if (s.session && samePath(s.session.workspace, path)) return;
    set({
      ready: false,
      session: null,
      entries: [],
      handshakeNotices: [],
      activeRunId: null,
      lastRunId: null,
      hasSpoken: false,
      lastTurnMs: null,
      uiState: null,
      status: null,
      context: null,
      compaction: null,
      runtimeExit: null,
      startupProblem: null,
      stderrTail: [],
      // A request in flight belonged to the child being replaced, so its mark
      // goes with it — the new runtime has never heard of it.
      mcpPending: [],
      // The session list belongs to the workspace we are leaving, so it is
      // dropped rather than carried over and shown against the new one.
      sessionList: [],
      listedSessions: false,
    });
    // Pasted pictures belong to the workspace we are leaving, and the reason is
    // structural rather than tidy: the path in the sentence is
    // **workspace-relative** (`.tudouni/paste/...`), so in the new directory the
    // very same string names a different place or nothing at all. Keeping the
    // chips would draw a preview of a file the runtime can no longer resolve.
    //
    // The **draft text is left alone**, deliberately: it is the person's own
    // typing, and clearing it is not this action's business. The path in it now
    // resolves to nothing, which is exactly how the runtime treats any path that
    // was deleted since — a word in a sentence.
    get().clearPastedImages();
    await startRuntime({ workspace: path });
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
    // The restart reuses the two arguments this session is already running with
    // — the workspace and, implicitly, everything else — and changes only the two
    // this panel owns. Reading the workspace from `session` rather than from a
    // remembered value is deliberate: `init.workspace` is the runtime's own answer
    // about where it is, and it is the only thing entitled to say so.
    const workspace = get().session?.workspace ?? '';
    set({
      // Remembered first, and unconditionally: these are the defaults the *next*
      // open uses, and a restart that fails must not silently drop the choice the
      // person just made.
      ericaiDefault: next.ericai,
      maxStepsDefault: next.maxSteps,
    });
    persistPrefs(get());
    // `launch` is written by `startRuntime` and not here, because it records what
    // the bridge actually accepted. Writing it now would claim a child that may
    // never have started.
    await startRuntime({
      ...(workspace === '' ? {} : { workspace }),
      ericai: next.ericai,
      maxSteps: next.maxSteps ?? undefined,
    });
  },

  toolFacts(name) {
    // `ui(tools)` is the richer source — it also carries the disposition and
    // the command argument — but it is only ever sent because somebody asked
    // for the `/tools` screen. The handshake's registry is the one that is
    // always there, so it is what a tool row's risk badge is actually drawn
    // from. `external` is only in the richer source, and stays unknown until
    // then rather than being guessed as false.
    const live = get().tools.find((tool) => tool.name === name);
    const registry = get().toolRegistry.find((tool) => tool.name === name);
    if (!live && !registry) return null;
    return {
      risk: live?.risk ?? registry?.risk ?? null,
      parallelSafe: live?.parallelSafe ?? registry?.parallelSafe ?? null,
      interactive: live?.interactive ?? registry?.interactive ?? null,
      external: live ? live.external : null,
    };
  },
}));

/* ============================================================
   Starting the runtime
   ============================================================ */

/** Turn whatever a failed IPC call threw into a sentence for a person. The
 *  Rust side already writes these for a reader ("the runtime binary …
 *  was not found next to the application"), so they are passed through. */
function describeFailure(err: unknown): string {
  if (typeof err === 'string' && err.trim() !== '') return err;
  if (err instanceof Error && err.message.trim() !== '') return err.message;
  return String(err);
}

/**
 * Start the runtime, and put any refusal on screen.
 *
 * Every way this fails is something the person can act on — the binary is not
 * packaged, the workspace is one the runtime refuses, the protocol versions do
 * not match — and each used to be an unhandled rejection behind a screen that
 * said "Starting the runtime…" forever, with no way to retry or to pick another
 * workspace.
 */
export async function startRuntime(options: Partial<BridgeOptions> = {}): Promise<void> {
  useApp.setState({ startupProblem: null });
  try {
    await attachRuntime(options);
    // Recorded **after** the bridge accepted it, and only then: this is what the
    // settings panel draws as "this session's start-up arguments", and a refusal
    // (a missing binary, a workspace the runtime will not take) means there is no
    // child for those arguments to belong to. Writing them first would have the
    // panel describe a process that does not exist.
    useApp.setState({
      launch: {
        ericai: options.ericai === true,
        maxSteps: options.maxSteps ?? null,
      },
    });
  } catch (err) {
    useApp.setState({ startupProblem: describeFailure(err) });
  }
}

/* ============================================================
   ui(state) landing, plus the auto-expand rule
   ============================================================ */

function applyStateSnapshot(
  set: (partial: Partial<AppStore>) => void,
  get: () => AppStore,
  snap: VmState,
): void {
  const s = get();

  const hasContent: Record<SidebarBlockKey, boolean> = {
    goal: snap.goal.present,
    tasks: snap.todos.length > 0,
    skills: snap.skills.length > 0,
    jobs: snap.jobs.length > 0,
    mcp: snap.mcp.some((server) => server.state === 'loaded'),
  };

  const collapsed = { ...s.blockCollapsed };
  const autoExpanded = { ...s.blockAutoExpanded };
  let changed = false;

  // First appearance of a block expands it once. After that the person's own
  // choice wins, and a later refresh must not pop it back open.
  for (const key of SIDEBAR_BLOCKS) {
    const touched = s.blockTouched[key] === true;
    if (!touched && hasContent[key] && !autoExpanded[key]) {
      collapsed[key] = false;
      autoExpanded[key] = true;
      changed = true;
    }
  }

  // The catalogue only travels on the **first** snapshot, so a later one must
  // not wipe it: the panel would lose every description the session ever had.
  // `null` is what "absent" looks like after projection, and an empty array is
  // a real answer ("this runtime has no catalogue").
  const catalog = snap.skillCatalog.length > 0 ? snap.skillCatalog : s.skillCatalog;
  // Re-merges the loaded set against the descriptions and digests that only
  // this message carries. Without it the panel shows `N / 0` and every row's
  // description is missing, because the catalogue it reads is never written.
  const merged = mergeSkills(snap.skills, catalog, s.skillAvailable, s.skillActive);

  const session = s.session;
  set({
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
            effortLevels: snap.effortLevels.length > 0 ? snap.effortLevels : session.effortLevels,
            contextTokens: snap.modelWindow,
            steps: snap.steps,
          },
        }
      : {}),
    ...(changed ? { blockCollapsed: collapsed, blockAutoExpanded: autoExpanded } : {}),
  });

  // The auto-expand rule changes a **persisted** preference (`blockCollapsed`),
  // and a preference that changed without being written is one that silently
  // reverts on the next launch — the sidebar would come back in a shape the
  // person did not leave it in. Only written when it actually changed, so a
  // snapshot refresh is not a disk write.
  if (changed) persistPrefs(get());

  // Something is still outstanding: ask once, throttled. This is the only
  // reason the front end ever polls — and it gives up after a few identical
  // answers, so a job nobody collects cannot turn this into a heartbeat.
  const outstandingKey = snap.jobs
    .filter((job) => job.outstanding)
    .map((job) => `${job.id}:${job.state}:${job.seconds}`)
    .sort()
    .join(',');
  noteOutstanding(outstandingKey);
  if (outstandingKey !== '') {
    throttled(() => busSend({ v: 1, t: 'refresh_state' }));
  }
}

/* ============================================================
   Selectors
   ============================================================ */

/** The status bar's coarse phase. */
export function selectPhase(s: AppStore): Phase {
  if (!s.ready) return 'booting';
  if (hasRunningTurn(s.entries)) return 'running';
  const stop = lastStopReason(s.entries);
  if (stop === null) return 'idle';
  return phaseFromStopReason(stop);
}

/** Effort levels come from the runtime and change with the model.
 *  Same caveat as `selectAskOn`: subscribe with `useShallow`. */
export function selectEffortLevels(s: AppStore): string[] {
  return s.uiState?.effortLevels ?? s.session?.effortLevels ?? NO_EFFORT_LEVELS;
}

/**
 * Which risks the runtime will ask about. Read-only; never re-derived here.
 *
 * **This returns a fresh array, so it must be subscribed with `useShallow`.**
 * zustand compares snapshots by identity, and a selector that builds a new array
 * on every call never compares equal — the store then re-renders forever and the
 * component never commits, which shows up as an empty screen rather than as an
 * error. Every call site wraps it:
 *
 *     const askOn = useApp(useShallow(selectAskOn));
 */
export function selectAskOn(s: AppStore): string[] {
  const scope = s.uiState?.riskScope ?? [];
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

export function selectAutopilot(s: AppStore): boolean {
  return s.uiState?.autopilot ?? false;
}

/** The cache hit rate, or null when no lookup has happened yet. */
export function selectCacheHitRate(s: AppStore): number | null {
  if (!s.status) return null;
  return cacheHitRate(s.status.usage);
}

/**
 * The status bar's right-hand usage numbers.
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

export function useUsage(): UsageView {
  const status = useApp((s) => s.status);
  const snap = useApp((s) => s.uiState);
  const context = useApp((s) => s.context);

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
