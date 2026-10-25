/**
 * The store's vocabulary.
 *
 * Every runtime fact, preference and derived shape the front end names. These
 * were declared in `store.ts` itself, which made the module 1,000 lines of
 * types before its first line of behaviour; they are moved verbatim here and
 * re-exported by `store.ts`, so every `import ... from '@/state/store'` keeps
 * working.
 */
import { type CodeIntelSnapshot, type FileEntry, type MemoryConfig, type MemorySnapshot, type ModelAlias, type PermissionRequestMsg, type PermissionScope, type QuestionRequestMsg, type SkillCatalogRow, type SshRow, type TerminalRow, type UiContextMsg, type UiFileReadMsg } from '@/protocol/types';
import { type CallUsage, type Entry, type NoteEntry } from '@/state/entries';
import type { TerminalState } from '@/runtime/terminalOutput';
import { type VmCompaction, type VmContext, type VmInitTool, type VmMcp, type VmModel, type VmSessionListItem, type VmSkill, type VmState, type VmStatus, type VmTool } from '@/runtime/adapt';
import { type AttachedFile, type PastedImage } from '@/runtime/paste';
import { type InstallStage, type RemoteConfigStatus } from '@/runtime/tauri';


export type TerminalTail = TerminalState;

/* ============================================================
   Constants that belong to the presentation layer
   ============================================================ */

/** How much of the child's stderr to keep for the start-up diagnostics panel.
 *  A tail: the last lines are what explain a refusal, and the first ones are
 *  usually the banner. */
export const STDERR_TAIL = 60;

/**
 * The task-history cap. One Run appends one link; past this the oldest fall
 * off. localStorage is not a database and the history is a recency list — a
 * person reading it wants the last dozen runs, not every run ever.
 */
export const TASK_RUNS_MAX = 100;

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
  | 'context'
  /* The last turn's wall-time breakdown, reached from the status bar's turn
   *  chip. A panel rather than a tooltip: the chip's number is a total, and
   *  what a person wants from it is the split beneath it (model / tools /
   *  approval / human / backoff), which is more than one hover can carry. */
  | 'timing'
  | 'settings'
  /* The configuration files themselves. A panel of its own rather than a third
   * group inside Settings, because it is a different kind of decision from
   * everything there: Settings holds **this session's start-up arguments**, and
   * changing one restarts a child; this edits the files that are read when a
   * child starts, and what it writes outlives every session. */
  | 'config'
  /* The workspace's two capabilities. They are panels rather than windows
   * because they share the app's one interaction model (§5), and because
   * neither is a destination: a person opens one, looks, and goes back. */
  | 'files'
  | 'terminal'
  /* The workspace-learning configuration. It is a form whose submit becomes
   * a new session's first message — the panel holds no runtime state of its
   * own, and nothing is sent until the person presses Start. */
  | 'learn'
  /* Task templates: the desktop's own repeatable session launchers. A panel
   * rather than a view for the same reason Config is: the templates and their
   * history are facts about the desktop, not about any one conversation, and
   * a person opens the panel with no session running at all. */
  | 'tasks'
  /* Workspace memory: what this workspace has learned, plus the proposals
   * waiting to be reviewed. A panel rather than a view because its subject is
   * the workspace, not the conversation — it opens from the same drawer as
   * Config and Tasks, and what it edits outlives every session. */
  | 'memory'
  /* The code index: whether the model may use it, whether one exists, and the
   * two buttons that make one. A panel for the same reason Memory is — its
   * subject is the workspace rather than the conversation, and what it configures
   * outlives every session. */
  | 'codeintel'
  /* The cross-workspace usage ledger: cumulative tokens, the busiest day, the
   * active-day streaks and the per-day heatmap. A panel for the same reason the
   * others are, but the only one whose subject is **the user of this machine**
   * rather than a session or a workspace — the ledger lives beside config.json
   * in the home directory, so switching workspaces must not reset it. It reads
   * through the runtime (the ledger's only writer and reader), which is why it
   * gates on a live session like Memory and Code intelligence do. */
  | 'usage';

/* `ssh` sits with the workspace-capability blocks (jobs, mcp): it is about
 * things running in the workspace, not about this turn's conversation. */
export type SidebarBlockKey = 'goal' | 'tasks' | 'skills' | 'jobs' | 'mcp' | 'ssh';

/**
 * Quiet mode for the transcript.
 *
 * Three states rather than a toggle, because the status bar's chip opens a
 * menu rather than flipping: `normal` compresses every tool call into a
 * one-line brief, `simple` goes further — the model call card is its own
 * head line, one sentence naming the tools it ran, no figures — and `off`
 * is the full detail the mode exists to switch away from.
 */
export type QuietMode = 'off' | 'normal' | 'simple';

export const SIDEBAR_BLOCKS: SidebarBlockKey[] = ['goal', 'tasks', 'jobs', 'skills', 'mcp', 'ssh'];

/**
 * One `ask_user` call, accumulated from its `question_request`s.
 *
 * The runtime sends a batch's requests back to back and only then waits, so
 * they land in `pendingModals` one by one; the first request of a batch opens
 * the entry and the rest fill in `questions` (by `question_index`). `ready`
 * says the whole batch is in — the modal draws a batch in one panel, and a
 * half-arrived one must not open the panel with a missing page. A request
 * whose sender predates batches (no `batch_id`) is a batch of one that is
 * ready immediately.
 */
export interface QuestionBatch {
  batch_id: string;
  /**
   * The batch's questions, in order. A `null` slot is a member that has not
   * landed yet — `ready` holds only when every slot is filled.
   */
  questions: (QuestionRequestMsg | null)[];
  ready: boolean;
}

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
  | { kind: 'question'; key: string; batch: QuestionBatch };

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
  /** Paths that were inserted but sit outside the workspace: the file tools
   *  will not read them directly, so the model has to go through shell. */
  | { code: 'drop-outside'; names: string[]; tone: 'warn' }
  /** Paths that were inserted with no workspace open: nothing can be checked. */
  | { code: 'drop-no-workspace'; names: string[]; tone: 'warn' }
  /**
   * A **remote** session could not take the file.
   *
   * There is no `drop-outside` on a remote screen, and that is the point: an
   * outside path is a statement about *this* machine's workspace boundary, and a
   * path on this machine is not outside the remote workspace — it is not in it at
   * all, and the far shell cannot see it either. So the only two outcomes are
   * "uploaded" and this: the upload was refused, with the bridge's own sentence
   * as `reason` (`names` says which files, because one drop can carry several).
   */
  | { code: 'attach-remote-failed'; names: string[]; reason: string; tone: 'warn' }
  /** A paste refused before anything was written. */
  | { code: 'paste-no-workspace'; tone: 'warn' }
  | { code: 'paste-at-capacity'; limit: number; tone: 'warn' }
  | { code: 'paste-too-large'; size: string; limit: string; tone: 'warn' }
  | { code: 'paste-not-an-image'; tone: 'warn' }
  /** The picture was written, but the model cannot be shown one. Not a refusal:
   *  the turn still runs, exactly as the runtime's own `refused` row says. */
  | { code: 'paste-no-vision'; model: string; tone: 'info' }
  /** The bridge refused or failed to write it. The runtime's sentence, verbatim. */
  | { code: 'paste-failed'; reason: string; tone: 'warn' }
  /** `/quiet` was given a word that is not one of the three states. */
  | { code: 'quiet-unknown'; reason: string; tone: 'warn' };

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
 * One file, as the browser's own viewer draws it.
 *
 * It is the `ui(file_read)` payload plus which file was asked for, held **per
 * session** because that is what answered — the child holds the workspace
 * boundary the path is relative to.
 *
 * The payload itself is kept rather than copied field by field on purpose: it is
 * the runtime's answer, and a struct built here would be a second description of
 * it that drifts the first time a field is added. `UiFileReadMsg` is the shape
 * `FileBlock` already knows how to draw, so the panel and the transcript draw the
 * same answer through the same component instead of two that agree today.
 */
export interface FileView {
  /** The path that was asked for. Not read back off the payload: the runtime's
   *  reply is the authority on what it read, and this is what the panel names
   *  while the answer is still in flight. */
  path: string;
  /** `null` while the read is in flight. */
  answer: UiFileReadMsg | null;
  /** Why it failed, verbatim from the runtime. `null` when it did not. */
  problem: string | null;
  /**
   * A `data:` URL, when the file is a picture rather than text.
   *
   * **A second channel beside `answer`, not a variant of it.** `file_read` is the
   * runtime's text protocol and it refuses anything that is not UTF-8 — a PNG sent
   * down it comes back as "not UTF-8 text, so it cannot be shown here", which is a
   * true sentence about a question that should never have been asked. Pictures
   * come from the desktop's own `inline_image` command instead (the same one
   * `MarkdownImage` uses), so the runtime is not asked to decode what it never
   * offered to.
   *
   * `undefined` is "not a picture"; `null` is "a picture, still being read". */
  image?: string | null;
}

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
/* ============================================================
   Workspace Manager (§6, §3.4 of the remote-runtime design)
   ============================================================ */

/**
 * One saved SSH destination, shared by every remote workspace that points at
 * it.
 *
 * Per §6.4/§6.5 of the design, a host configuration is **not** itself a
 * workspace and is not "a connection" either: `b-prod` and two different
 * project directories on it are two different `RemoteWorkspaceEntry` rows
 * that both carry `hostId` pointing at this one record. Editing the host here
 * (a changed port, a rotated key) is therefore one edit that reaches every
 * workspace built on it, rather than one edit per workspace that can drift
 * apart from the others.
 */
export interface SshHostConfig {
  /** Opaque local id. Never sent to the runtime or the remote host; it exists
   *  only so a `RemoteWorkspaceEntry` can reference this record without
   *  copying it. */
  id: string;
  /** A name for this host, chosen by the person — shown in the sidebar and in
   *  the host picker when adding a new remote workspace. */
  label: string;
  host: string;
  port: number;
  user: string;
  /** Paths to private key files, tried in order. Empty means key auth is not
   *  configured for this host, which is only a valid state when `password`
   *  is set. */
  identityFiles: string[];
  /**
   * A password for this host, if one is configured.
   *
   * **Stored locally, in the same place `aigo.prefs` already lives**, and
   * that is a real property to be honest about rather than a detail: this is
   * `localStorage`, not an OS keychain. It is accepted here, in Phase 2,
   * because the design's own Phase 1/2 scope is "assume an already-configured
   * remote runtime" — a proper secret store is not yet part of this layer.
   * `undefined` means no password is configured, which is the ordinary case
   * for a host using key auth.
   */
  password?: string;
  /**
   * How a conflict between the local and remote `config.json` is resolved
   * (§9.4) — `'ask'` (the default for a newly-saved host, per the design),
   * `'sync-local'` (the local file always wins), or `'use-remote'` (a
   * one-way lock: the remote file is trusted and never overwritten from
   * here without an explicit later action — see the design's own "use-remote
   * is a one-way lock" rule).
   */
  configPolicy?: 'ask' | 'sync-local' | 'use-remote';
  /**
   * The content fingerprint (SHA256) recorded the last time this host's
   * config.json was successfully synced — the baseline §9.5's conflict
   * detection compares the current local and remote fingerprints against.
   * `undefined` means no sync has happened yet, which `DetectConflict`
   * treats as an unconditional conflict rather than a reason to guess.
   */
  configBaselineFingerprint?: string;
  /**
   * What the **local** file's fingerprint was at that same moment.
   *
   * The remote baseline above is not enough to describe a decision: answering
   * "use remote" leaves the local file different from it on purpose, and a
   * comparison against the single baseline then reports a local change on every
   * later open — the same question, from an answer already given. `undefined`
   * means the host was saved before this field existed, and the comparison falls
   * back to the single baseline (`state/configSync.ts`).
   */
  configBaselineLocalFingerprint?: string;
}

/**
 * One saved workspace that lives on a remote host, reached through an
 * `SshHostConfig`.
 *
 * This is the remote half of what §6.3 calls the unified Workspace model —
 * `WorkspaceSidebar`'s existing `workspaces: string[]` is kept exactly as it
 * is for the local half, and this is its sibling rather than its replacement:
 * merging the two into one shape would have meant touching
 * `resolveAttachWorkspace`/`attachSession`'s local-only assumptions (a bare
 * directory string) throughout, for a benefit Phase 2 does not need yet. The
 * two lists are drawn as one in the sidebar instead (`combinedWorkspaceRows`),
 * which is where the unification actually matters to a person using it.
 */
export interface RemoteWorkspaceEntry {
  /** Opaque local id. Stable across renames of `label` or `remotePath`, so a
   *  running session's `remoteWorkspaceId` reference never goes stale while
   *  the entry it points at is merely edited. */
  id: string;
  hostId: string;
  /** The directory on the remote host this workspace is rooted at. */
  remotePath: string;
  /** Absolute path to the runtime binary on the remote host. Phase 1/2 both
   *  assume this is already installed and verified — see
   *  `RemoteAttachOptions.remote_binary` on the Rust side, and §8 for the
   *  automatic-install phase this will eventually be filled in by. */
  remoteBinary: string;
  /** A name for this workspace, chosen by the person. Falls back to
   *  `remotePath` in the sidebar when left blank. */
  label: string;
}

/**
 * The connection's own state machine (§5.1), independent of the session's
 * turn/approval state.
 *
 * `phase` is a closed set rather than a free-form string so a component that
 * switches on it is exhaustive-checked by the compiler — the same reason
 * `TurnOrigin`-shaped unions are used elsewhere in this file. Every phase
 * beyond `'local'` and `'ready'` is Phase 1/2 territory; `'installing'` is
 * listed for Phase 3 and is not yet reachable from this code (there is no
 * remote-install path to put it on).
 */
export type ConnectionPhase =
  | 'local'
  | 'disconnected'
  | 'connecting'
  | 'installing'
  | 'starting'
  | 'handshaking'
  | 'ready'
  | 'interrupted'
  | 'closing'
  | 'closed'
  | 'failed';

export interface ConnectionState {
  phase: ConnectionPhase;
  /** Why `phase` is `'failed'` or `'interrupted'`, as a sentence. `null`
   *  otherwise — this is not a log, it is the one reason the badge's tooltip
   *  shows. */
  problem: string | null;
}

/** The connection state every local session carries. A constant rather than a
 *  literal written at each call site, so every local bucket points at the
 *  same frozen object instead of allocating one that can never actually
 *  change. */
export const LOCAL_CONNECTION_STATE: ConnectionState = { phase: 'local', problem: null };

/**
 * The state of one remote workspace's install attempt (§8 of the design),
 * tracked separately from `ConnectionState` because an install happens
 * **before** there is a connection to have a state at all — see
 * `AppStore.installStatus`'s own doc.
 */
export interface InstallStatus {
  stage: InstallStage;
  /** Set only while `stage === 'uploading'`. Both `0` otherwise. */
  uploadedEntries: number;
  totalEntries: number;
  /** Set only once the attempt has settled, one way or the other. */
  error: string | null;
  /** The installed binary's absolute path, once `stage === 'done'` with no
   *  error. */
  installedBinary: string | null;
}

/**
 * One config-sync decision point for a saved SSH host (§9.4/§9.5 of the
 * design) — what `checkConfigSync` found, and what a person still needs to
 * decide when the host's `configPolicy` is `'ask'` and both sides have
 * actually changed.
 */
export interface ConfigSyncPrompt {
  hostId: string;
  conflict: 'none' | 'remote_changed' | 'local_changed' | 'both_changed';
  /**
   * `true` when the host has no baseline at all, which `conflict` reports as
   * `both_changed` — the two read very differently on screen ("this host has
   * never been synced" vs. "both files changed since the last sync"), and only
   * the store knows which one it is, because only the store has the baseline.
   */
  firstSync: boolean;
  remoteStatus: RemoteConfigStatus;
  /** `null` when there is no local config.json yet. */
  localText: string | null;
  /** The local file's fingerprint at the moment of the check — what the answer
   *  records as the local side's last-seen value. `null` when there is no local
   *  file (and then it is recorded as "none", never as an empty fingerprint). */
  localFingerprint: string | null;
  /** `null` when the remote status is `'missing'`. */
  remoteFingerprint: string | null;
}

/* ============================================================
   Launch arguments and session info
   ============================================================ */

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
  /**
   * Which remote workspace this session belongs to, when it is one — `null`
   * for a local session. This is a reference into `remoteWorkspaces`, kept as
   * an id rather than a copy so renaming or editing the saved entry does not
   * leave a stale duplicate sitting in a running session's bucket.
   *
   * It exists so `connection` below can be rendered without the UI having to
   * guess "is this workspace remote" from the shape of `workspace` itself —
   * see §6 of the design: SSH is a transport property of the workspace, not
   * a separate concept the UI re-derives per screen.
   */
  remoteWorkspaceId: string | null;
  /**
   * The connection's own state machine, independent of `ready`/`problem`.
   *
   * Per §5.1 of the design, connection state and task state are tracked
   * separately on purpose: an SSH disconnect does not mean a tool failed, and
   * a tool failing does not mean the connection is down. For a local session
   * this is always `{ phase: 'local' }` — there is no connection to report on,
   * and giving it its own phase (rather than reusing `'ready'`) keeps the UI
   * from having to ask "is this remote" before it can read this field.
   */
  connection: ConnectionState;
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
  /**
   * The build running **on this session's machine**, when this end has asked.
   *
   * `null` until asked, and that is not a gap: `init` carries no product version
   * (`v` is the envelope, `protocol` is the conversation's semantic version), so
   * the only way to learn it is to run the binary once. A local session can read
   * it from the window-level `runtimeVersion`; a **remote** one has to ask the
   * host, and this is where the answer is kept.
   *
   * It exists because the window-level value is the wrong answer on a remote
   * screen: Audit drew this machine's version beside a `protocol` that came from
   * the host, and the two lines contradicted each other — which is exactly what
   * somebody reading Audit is trying to resolve.
   */
  runtimeBuild: string | null;

  session: SessionInfo | null;
  /**
   * This session was started as a workspace-learning run.
   *
   * A local fact, like `hasSpoken`: a learning run is an ordinary session,
   * and the only thing that tells it apart from a conversation is what its
   * first message was. The flag exists so the UI can say which of the open
   * sessions is the one that is studying the workspace, not to change how
   * the session is treated.
   */
  learning: boolean;
  /**
   * This session was started as a task-refine run, and which task it refines.
   *
   * The same local fact as `learning`: a refine run is an ordinary session,
   * and the only thing that tells it apart is what its first message was. The
   * task id goes with the flag because the candidate is applied by the front
   * end on the question's answer — and that application is only valid for
   * **this** session and **this** task, so both halves of the rule live on
   * the bucket rather than being re-derived at answer time.
   */
  refineTaskId: string | null;
  /**
   * The candidate prompts this session's last finished turn delivered,
   * extracted from the report the model wrote — `null` until the refine run
   * has produced one, `[]` when it produced none.
   *
   * Held on the bucket rather than re-read from the transcript at answer
   * time: the transcript is rebuilt by every `session_load` (which rewrites
   * the entries wholesale), and the question's answer can land long after a
   * later turn has moved the stream on. The extraction runs once, when the
   * turn that carries the report finishes.
   */
  refineCandidates: string[] | null;
  /** A local fact: has this session been spoken to. "Never spoken" and "idle"
   *  are two different labels in the status bar. */
  hasSpoken: boolean;
  /** Wall time of the last finished turn. Local: `run_finished` carries
   *  `duration_ms` and that is what this is set from. */
  lastTurnMs: number | null;
  /**
   * The last **successful** model call's own four figures, as they arrive.
   *
   * This is what lets the status bar move during a turn. Usage is otherwise only
   * in `ui(status)` (`last_prompt_tokens` and `status.usage`), and that message is
   * requested when a turn ends — so on a long turn the bar sat on the previous
   * turn's numbers and then jumped. The `model_call` event carries the same four
   * fields, and it is already arriving: the reducer reads it to draw the model
   * row. `status` still supplies the session totals, and remains the fallback
   * before any call in this session has succeeded.
   *
   * `null` is "no successful call has been reported to this window" — a fact
   * about what has been *seen*, never a zero.
   */
  liveCall: CallUsage | null;

  entries: Entry[];
  /**
   * Turns the transcript already held when `session_load` last rebuilt it.
   *
   * `session_load` rebuilds `entries` from the stored `{role, content}` message
   * list, which has no turn boundaries — so the restored stream has no `turn`
   * heads, and a head numbered by "how many heads are in `entries`" would start
   * the count over at 1. That was the report: a conversation ten turns deep
   * yesterday, and today's first message badged "Turn 1" while the turn rail,
   * which numbers marks by position, still said 11.
   *
   * Read off the rebuilt rows, one per `user` row — the same rule `turnRail`
   * applies to a stored turn — and handed to the reducer (`ReduceOptions.restoredTurns`)
   * so a new head is numbered after them. Reset by every `session_load`, which is
   * the message that replaces the stream.
   */
  restoredTurns: number;
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
  /**
   * How many of the note entries in `entries` the notice center has shown.
   *
   * The unread count is `notes − notesReadCount`, and it has to live here rather
   * than in the component because notes land in the store while the popover is
   * closed — and while another view (the board, a terminal) covers the stream
   * entirely. Rebuilt to the full count by every `session_load`, so a restored
   * session does not open with a stale badge; moved to the current count by
   * `markNotesRead` when the popover opens.
   */
  notesReadCount: number;
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
  /** The raw `ui(context)` payload. The context panel renders this; the
   *  transcript block is the same message's other home. */
  contextMsg: UiContextMsg | null;
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
   * The workspace's SSH remote sessions, from every `ui(state)` (`snap.ssh` —
   * the full list, replaced rather than merged, exactly like `terminals`).
   *
   * Display only: the `ssh_*` tools own the operations, so nothing here acts on
   * a row — the rail answers "what is this workspace connected to", nothing
   * more. Per **session** bucket for the same reason `terminals` is: this is
   * "what this child told me", and two sessions in one workspace each hear the
   * same list from their own child, neither wrong.
   */
  ssh: SshRow[];
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
  /**
   * What this session's front end has seen of each attached terminal's output.
   *
   * A **bounded** tail, newest last. The runtime keeps no scrollback — the design
   * is explicit that a terminal's output must not become a second terminal — so
   * showing more than the last screenful is necessarily this end's job.
   *
   * Keyed by terminal id rather than held for one: switching between two shells
   * and back should not lose the first one's screen.
   *
   * Each value is both halves of one tail — the lines **and** an escape sequence
   * the batch boundary cut in half — because they are two parts of one parsing
   * state. Held as two records keyed by the same id they could drift, and the
   * symptom would be one shell's pending sequence appearing in another's output.
   */
  terminalTails: Record<string, TerminalTail>;
  /**
   * Terminals with a create or kill request in flight.
   *
   * Not an optimistic update: it claims nothing about a terminal's state — the
   * badge still comes only from the runtime. It states one fact this front end
   * really has, which is that it just sent the request.
   */
  terminalPending: string[];
  /**
   * Terminals the person asked to dismiss, whose shell was still running.
   *
   * Closing is a **two-part act** for a running shell — end it, then forget it —
   * and the two parts happen at different times because the runtime refuses to
   * forget something that is alive. So the intention has to survive the gap
   * between the click and the exit, which is what this list is.
   *
   * It is a front-end fact and nothing more, the same category as
   * `activeTerminalId`: it records what somebody asked for, never what a terminal
   * is doing. The `terminal_exit` it is waiting for comes from the runtime.
   */
  terminalClosing: string[];

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
  /**
   * Why the last `file_list` did **not** answer, verbatim from the runtime.
   *
   * A third state, and it had no representation at all. A refusal arrives as a
   * `notice`, not as a `ui(files)`, so the only thing that could clear
   * `filesLoading` was a success — and a refused listing therefore left the panel
   * reading "Reading the directory…" for ever. Worse, the sentence that explained
   * it went into the transcript, which is exactly what the panel was covering.
   *
   * The runtime's own words, unaltered: it is the authority on why it refused a
   * path, and rewording it here would be a second copy of that rule.
   */
  filesProblem: string | null;
  /**
   * The file most recently read from the browser, and whether it is still in
   * flight.
   *
   * The panel draws this in its own lower half. That is not decoration: a
   * `file_read` answer lands in the **transcript**, and the files panel is a
   * modal layer on top of it, so "press Enter on a file" used to change nothing
   * on screen. A person could not tell a slow read from a broken button.
   *
   * `null` means nothing has been opened yet — which is why it is not just an
   * empty payload: "no file opened" and "a file opened and it was empty" are
   * different statements, exactly like the three listing states above.
   */
  fileView: FileView | null;

  /* ---------------- workspace memory ----------------
   *
   * The panel's whole subject, in one snapshot. It is **per session** because the
   * runtime that answered is per session: two conversations in two workspaces have
   * two unrelated memory corpora, and one slot would let the second overwrite the
   * first's list.
   *
   * `null` means "not asked yet", which is a different statement from an empty
   * corpus — the panel draws "loading" for the first and "nothing recorded" for the
   * second.
   */
  memory: MemorySnapshot | null;
  /**
   * Why the last `memory_action` did **not** take effect, verbatim from the runtime.
   *
   * A third state, and it is here rather than left to the notice stream for the same
   * reason `filesProblem` exists: the panel is a modal layer over the transcript, so a
   * notice about a failed publish is printed behind the panel that asked. It is
   * cleared by the next successful snapshot, because at that point it describes a
   * request that has been superseded.
   */
  memoryProblem: string | null;

  /* ---------------- the code index ----------------
   *
   * The panel's whole subject, in one snapshot, per session for the same reason
   * `memory` is: the runtime that answered is per session, and two conversations
   * in two workspaces have two unrelated indexes.
   *
   * `null` means "not asked yet" — the panel draws its loading state — which is a
   * different statement from a snapshot whose `indexed` is false.
   */
  codeintel: CodeIntelSnapshot | null;
  /**
   * Why the last `codeintel_action` did **not** take effect, verbatim.
   *
   * Here rather than left to the notice stream for the reason `memoryProblem`
   * exists: the panel is a modal layer over the transcript, so a failed init would
   * be printed behind the panel that asked for it. Cleared by the next successful
   * snapshot, because by then it describes a request that has been superseded.
   */
  codeintelProblem: string | null;

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
   * the draft text (`referencedImages`) — a picture counts while its placeholder
   * is still in the sentence — because the text is the only surface the person
   * reads, so deleting the marker drops its chip and there is no second source of
   * truth to fall out of step. The paths themselves are put back only at submit
   * time (`restorePastedPaths`); the draft carries placeholders.
   *
   * Per session because the path each entry holds is **workspace-relative**, and
   * two sessions may be in different workspaces: the same string names a
   * different place, or nothing at all.
   */
  pastedImages: PastedImage[];
  /**
   * Files attached from the plus menu (workspace browser or native dialog).
   *
   * The pasted picture's mechanism without the bytes: the draft carries the
   * placeholder and the path is restored at submit (`restorePastedPaths`).
   * Per session for the same reason `pastedImages` is — the path each entry
   * holds means "relative to *this* workspace", and a chip from another
   * conversation would name a different place or nothing at all.
   */
  attachedFiles: AttachedFile[];
  /**
   * Quiet mode for this session's stream.
   *
   * Per session, and that is a change from when it was one window preference. It
   * says how *this conversation's* work is drawn, so it is a statement about the
   * conversation rather than about the window — and it sits next to the
   * autopilot toggle in the status bar, which is per session. Two
   * identical-looking controls on one row, one of which changed with the
   * session and one of which did not, was a trap.
   *
   * `off` used to be the `false` half of a boolean; the chip is a menu now,
   * not a toggle, so the two on-states are values of their own — see
   * `QuietMode`.
   */
  quiet: QuietMode;
}

/**
 * The saved sessions of **one workspace**, as the runtime last reported them.
 *
 * **Window-level, not per bucket, and that is the whole of one reported bug.**
 * This used to live on `SessionRuntime` — `sessionList` / `listedSessions`, one
 * copy per child — while the fact it holds is the workspace's: `session_list` is
 * answered by reading the session *files* in one directory, so every child in
 * that workspace would answer identically. Storing it per child gave the left
 * rail a different list depending on which conversation happened to be focused
 * ("switching sessions seems to change the list itself"), because `focusSession`
 * sends nothing and the rail simply switched to another child's frozen snapshot.
 * The fingerprints were in the numbers: a session still growing showed 240 · 99
 * in one child's copy and 141 · 55 in another's, while the file on disk held 240
 * messages and 99 steps.
 *
 * Keyed by workspace **and machine**, because that is the scope the runtime
 * answers in — the rail draws the conversation list of the workspace on screen,
 * and a list belonging to another directory is not this list's business. **A map
 * rather than a single slot**, and that is not symmetry for its own sake: two
 * sessions in two workspaces can both answer `session_list`, and one slot would
 * let a background workspace's reply overwrite the list the person is looking
 * at — the same "the list changed under me" symptom, one layer down. The key is
 * `savedSessionsKey(workspace, remoteWorkspaceId)`, so it is built the same way
 * it is looked up.
 *
 * **The machine is part of the key, and that is a second instance of the same
 * bug.** Keying by `normPath(workspace)` made `hostA:/srv/app`,
 * `hostB:/srv/app` and a local `/srv/app` one bucket: whichever answered last
 * overwrote the other, both rails drew one list, and a row clicked in it carried
 * the *other* host's session id. See `state/savedSessionsKey.ts`.
 */
export interface SavedSessions {
  /** The workspace this list describes, as the runtime named it. */
  workspace: string;
  /**
   * Which saved remote workspace this list belongs to, or `null` for a local
   * directory.
   *
   * Carried on the value as well as in the key, because the two answer different
   * questions: the key says where to find the list, and this says **what the
   * list is about** — which is what lets a reader (the session board, the
   * "which place does this id live in" lookup) match a list to a machine without
   * parsing the key.
   */
  remoteWorkspaceId: string | null;
  /**
   * Every row the runtime reported, **as it reported them**.
   *
   * This is the library's input: while `/resume` is open the connection asks for
   * everything (see `AppStore.sessionFilter`), and its archive tabs then filter
   * this list themselves.
   */
  items: VmSessionListItem[];
  /**
   * The rows with archived sessions removed — what the rail, the first screen
   * and `Ctrl+1..9` draw.
   *
   * **Filtered by the flag, not by the request.** The two are not the same
   * question: the request decides what the *runtime* sends, and it says `all`
   * whenever the library is open. Nothing outside the library may show an
   * archived session — "archived" means "out of the list", and the rail going
   * blank for a moment and then showing archived rows again would be exactly the
   * "the list changed under me" symptom `SavedSessions` is about.
   *
   * Computed **once, on write**, rather than by a selector that filters: a
   * selector returning a fresh array never compares equal under zustand's
   * identity comparison, so the rail would re-render forever and never commit.
   */
  active: VmSessionListItem[];
  /** Whether the runtime has answered for this workspace yet. */
  listed: boolean;
}

/**
 * A fresh bucket for a session whose child has just been started.
 *
 * Exported because a bucket is a real thing to need outside this module: the
 * tests build one to exercise the reducer without a process, and that is a
 * better answer than a test-only back door into the store. It is exactly the
 * shape `attachSession` installs once the bridge accepts a child — no field is
 * filled in differently for a test.
 *
 * `remoteWorkspaceId` defaults to `null` (an ordinary local session); callers
 * opening a remote one pass it explicitly, which is also what selects the
 * initial `connection` phase — `'connecting'` rather than `'local'`.
 */

/**
 * The arguments one memory action may carry.
 *
 * All optional, because the verbs differ: `publish` and `reject` take `proposal_id`,
 * `deprecate` takes `entry_id` and an optional `reason`, `config` takes a patch of the
 * settings. Which one a verb needs is the **runtime's** judgement — it is the side that
 * knows what publishing takes, and a second check here would be a second answer that
 * eventually disagrees with it.
 *
 * `config` is a **patch**, not a whole struct: keys left out keep their current value,
 * so a panel built against an older build can still save the knobs it knows.
 */
export interface MemoryActionArgs {
  proposal_id?: string;
  entry_id?: string;
  reason?: string;
  config?: Partial<MemoryConfig>;
}

