/**
 * The shape of the application store.
 *
 * One interface, and it is the contract every action, selector and component
 * shares. It lives apart from the actions so a slice can be read — or tested —
 * without importing the store that assembles them.
 */
import { type CodeIntelActionKind, type FrontendMsg, type MemoryActionKind, type PermissionDecision, type RuntimeMsg, type UsageSnapshot } from '@/protocol/types';
import { type BlockKind, type ToolFacts } from '@/state/entries';
import { type Deliverable, type LearnScope } from '@/learn/template';
import { type RunScope, type Task, type TaskRunLink, type TaskRunOutcome } from '@/task/tasks';
import { type ClosePolicy } from '@/runtime/windowClose';
import { type BridgeOptions } from '@/runtime/tauri';
import { type ConfigSyncChoice } from '@/state/configSync';
import { type ComposerNotice, type ConfigSyncPrompt, type InstallStatus, type LaunchArgs, type MemoryActionArgs, type ModalEntry, type ModelMemoryEntry, type ModalState, type PanelKind, type QuietMode, type RemoteWorkspaceEntry, type SavedSessions, type SessionRuntime, type SidebarBlockKey, type SshHostConfig, type StartupNotice } from './types';
import type { RemoteConfigTarget } from '@/runtime/tauri';


export interface AppStore {
  /* ---------------- the runtime link ---------------- */
  /**
   * Every session with a live child, by key.
   *
   * Membership is "this session has a process right now". A session that exists
   * only as a file on disk is in `savedSessions` (keyed by workspace), not here —
   * and that distinction is what the left rail's status dots are built on: **no
   * process, no state**.
   */
  sessions: Record<string, SessionRuntime>;
  /** Display order for the left rail. Appended when a session is started. */
  order: string[];
  /** Which session is drawn. **It decides nothing else.** */
  activeKey: string | null;

  /**
   * The saved sessions of each workspace this window has heard about, keyed by
   * `savedSessionsKey(workspace, remoteWorkspaceId)` — `normPath(workspace)` for
   * a local directory, `rw:<id>` for a saved remote one. **Window-level because
   * the fact is the workspace's**, not any one child's — see `SavedSessions` for
   * the report this fixed, and `savedSessionsKey` for why the machine has to be
   * part of the key: two hosts can each have a `/srv/app`.
   *
   * A record rather than one entry: several sessions in several workspaces can
   * each answer `session_list`, and a single slot would let a background
   * workspace's reply overwrite the list on screen.
   *
   * No selector builds a fresh object from this — the rail and the picker read
   * **one row** out of it — so it does not have the identity problem the
   * fallback constants exist for.
   */
  savedSessions: Record<string, SavedSessions>;

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
   * A counter bumped when the start-up chain reaches an end, so the splash
   * hand-over check re-runs even when nothing else on screen changed.
   *
   * `src/splash.ts` owns the latch; this is only the signal that carries it into
   * a render. A counter rather than a boolean, because the interesting event is
   * the *transition* and a boolean cannot express "it happened again" — the same
   * reason `findFocus` is a counter.
   */
  splashTick: number;
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
  /**
   * The request that is **drawn right now** — the on-screen session's own first
   * entry in `pendingModals`, or `null`.
   *
   * It is a derived answer rather than simply the queue's head, and
   * `headForActive` is the one place that derivation lives. The reason is in
   * `selectModalVisible`: with several conversations open, a prompt belongs to
   * the conversation it came from, so a background session's request is held
   * for its own row in the rail instead of covering the work in progress.
   */
  modal: ModalState;
  /**
   * Every request the runtime is blocked on, in arrival order.
   *
   * `modal` used to be the only slot, and both request kinds wrote straight into
   * it. A second blocking request therefore replaced the first, and since the
   * runtime waits forever on the id it asked about, the replaced one was lost
   * *and* hung. The queue holds them so one can be answered and the next one
   * taken up.
   *
   * With several sessions this is not an edge case any more: two conversations
   * can both be waiting, and the queue is what keeps the second one alive
   * instead of silently stacked behind the first. Which one is **drawn** is
   * `selectModalVisible`'s call: the on-screen session's own first request
   * renders, and every other session's is held for its own row in the rail.
   */
  pendingModals: ModalEntry[];
  /** One panel at a time, and that is a window fact rather than a session one. */
  panel: PanelKind | null;
  /**
   * Whether the files panel is open **as a picker** (the plus menu's
   * "workspace file" entry) rather than as the plain browser.
   *
   * Window-level, like `panel`: the question is about why the panel is open,
   * not about any conversation. `openPanel`/`closePanel` keep it in step, so a
   * panel opened any other way can never inherit a stale pick mode.
   */
  filePick: boolean;
  /**
   * Whether the files panel is open **to show one file** rather than to browse.
   *
   * Set by a deliverable card, which is a direct request for one file: the person
   * pressed a card that named it, so drawing the workspace's directory listing
   * above it answers a question nobody asked and pushes the picture they wanted
   * off the bottom of the panel. In this mode the browser is not drawn at all and
   * the viewer takes the panel.
   *
   * Window-level like `filePick`, and cleared the same way, so browsing can never
   * inherit it: an entry that shows one file and forgets to say so would be a
   * panel that silently refuses to list anything.
   */
  fileFocus: boolean;
  /**
   * Whether the minimize-or-close prompt is up.
   *
   * Window-level, like `panel`, and not per session: it is a question about the
   * whole window, asked once. It is deliberately **not** a Radix `modal` entry —
   * `ModalState` is the runtime's blocking requests, which the runtime waits on
   * forever and which therefore have their own fail-closed rules. Nothing is
   * waiting on this one, and conflating them would put a local question into the
   * queue that decides whether an approval is answerable.
   */
  closePrompt: boolean;
  /**
   * The id of the question modal that was put aside by its own minimize
   * button, or `null` when none is.
   *
   * The third state a drawn request can be in, besides the two holds
   * `selectModalVisible` already knows (another session's, or the board's).
   * The difference is who chose it: this one is the person's own act, so it
   * gets its own named way back (the minimized pill) rather than a session
   * switch or a card click.
   *
   * **Hiding the render only; nothing else changes.** The queue still holds
   * the request, and `selectModalVisible` deliberately keeps reading it as
   * visible: the composer stays blocked, and that is a guard rather than a
   * gap. While the question is up its own turn is mid-flight (the model is
   * waiting on `ask_user`'s answer), so a message sent over it would sit
   * behind `joinTurn` forever — a deadlock the runtime cannot time out.
   * What the person actually wants here is the reply above the prompt, and
   * the transcript is readable the moment the overlay is gone, input or not.
   *
   * **The id rather than a flag, on purpose.** A request leaves the drawn
   * slot by being answered, by the session switching, or by the child dying —
   * none of those go through the actions that would remember to clear a
   * boolean. Keying the minimize to the request's own id means the flag
   * clears itself: the next question has a different id and therefore draws
   * normally, and there is nothing to remember to reset.
   *
   * **Not persisted**, like `closePrompt` and `boardOpen`: "I looked away
   * from this prompt" is a moment, not a setting.
   */
  questionMinimizedId: string | null;
  /**
   * Whether the session board is the conversation column's occupant.
   *
   * The board answers "what is every session in this workspace doing right
   * now", which is a fact about the workspace rather than about one
   * conversation, so it does not live in a bucket. It is a **view** rather than
   * a dialog because every property a dialog has works against the one thing the
   * board is for: a Radix dialog inherits `pointer-events: none` from `body` (so
   * the left rail goes dead — `railBlocked`), `focusSession` clears `panel` (so
   * clicking a card would close the board), and `enqueueModal` clears `panel`
   * when a request reaches the head of the queue (so an approval arriving would
   * close the one surface that says other sessions are waiting too). See
   * `conversationView`.
   *
   * **Not persisted.** "I am looking at the board" is a moment, not a setting;
   * remembering it would land the next launch on a screen with no transcript on
   * it for no reason the person gave.
   */
  boardOpen: boolean;
  /**
   * The usage panel's snapshot, and the refusal the last request ended with.
   *
   * **Window-level, not a bucket field, on purpose.** The ledger counts this
   * user's spend across every workspace, so the numbers mean the same thing no
   * matter which conversation is mounted, and resetting them on a session
   * switch would make the panel lie about what it had just shown. `null` is
   * "never fetched", which the panel draws as its loading state; a refusal is a
   * separate `usageProblem` so an error cannot be mistaken for an empty ledger.
   *
   * Requested once per panel open, never polled — the same on-demand rule every
   * other panel's snapshot follows.
   */
  usage: UsageSnapshot | null;
  usageProblem: string | null;
  /**
   * Which sessions this end is asking the runtime to report.
   *
   * **The desktop always sends this explicitly.** The protocol's own default is
   * `all`, deliberately: the CLI and the TUI have no way to un-archive, so
   * hiding rows from them would hide conversations they cannot get back. This
   * front end does archive, so leaving the default in place would let archived
   * sessions keep consuming the runtime's fifty-row cap — and the whole reason
   * the filter lives in the runtime is that archiving must free a slot (see
   * `SessionSummaries`). So the steady state here is `active`.
   *
   * **It is not a user preference and it is not persisted.** It describes what
   * this connection is currently asking for: the library flips it to `all` while
   * it is open (its Archived tab needs the rows), and `closePanel` puts it back.
   * Persisting it would mean a restart remembered a question nobody asked again.
   */
  sessionFilter: 'active' | 'all';

  /**
   * Whether the transcript's find bar is up.
   *
   * Window-level, like `panel`: it is a question about the transcript **on
   * screen**, asked with `Ctrl+F`, and there is exactly one of it. It lives here
   * rather than inside `StreamView` for one reason — the keyboard reaches it from
   * `useGlobalKeys`, which is a window listener with no part of the tree to hold
   * the state.
   */
  findOpen: boolean;
  /**
   * What has been typed into it.
   *
   * Kept while the bar is up, and **dropped when the conversation on screen is
   * replaced** (`FIND_IDLE`, used by the two paths that switch sessions): a needle
   * is a question about one transcript, and carrying it into another one would
   * answer a question nobody asked, with a count that looks like an answer.
   */
  findQuery: string;
  /**
   * Which hit is the current one, 0-based.
   *
   * **Clamped by whoever knows how many there are** — the scanning happens in
   * `StreamView`'s own effect, which is the only place that has both the hits and
   * the DOM. The store holds the number and nothing else, so there is no second
   * copy of "how many matches" to fall out of step with the transcript.
   */
  findIndex: number;
  /**
   * How many times the keyboard has been asked for.
   *
   * A counter rather than a flag, and it is not the same fact as `findOpen`: the
   * bar can already be up when `Ctrl+F` is pressed again — the reader clicked into
   * the transcript and wants the box back — and "open, and put the cursor in it"
   * has to be a **request** the bar can observe, not a state it already satisfies.
   * With only `findOpen` the second press changed nothing, React re-rendered
   * nothing, and the key read as having failed.
   *
   * It is deliberately **not** part of `FIND_IDLE`: closing the bar does not
   * un-ask, and a counter that went back to zero would make the second open of a
   * session's search indistinguishable from the first.
   */
  findFocus: number;

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
   * The right rail's width in px, as dragged by its own handle; `null` means
   * "no width of the person's choosing", which lets the stylesheet keep owning
   * the default — including its narrow-window fallback. A front-end preference:
   * a rail's width is layout, and the protocol has no opinion on it.
   */
  sidebarWidth: number | null;
  /**
   * The **left** rail's width in px, dragged by its own handle.
   *
   * The same contract as `sidebarWidth` on the other side: `null` means "no
   * width of the person's choosing", which lets the stylesheet keep owning the
   * default — including its narrow-window fallback — and a number is clamped
   * into the shared `RAIL_MIN`–`RAIL_MAX` range. Kept apart from the right
   * rail's because the two are dragged independently: folding or resizing one
   * is not a statement about the other.
   */
  leftbarWidth: number | null;
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
   * Which turns are folded away, by turn-head entry id.
   *
   * Window-level for the same reason as the two above, and **default open**:
   * the fold exists to tidy a transcript the person has already read, so a turn
   * that has never been folded is drawn in full. Unlike those two, this one
   * hides a whole turn's body — the model calls, the tools, the answer — behind
   * its head, which then states what the turn is doing and how long it took.
   */
  turnFolded: Record<string, boolean>;
  /**
   * The left rail's session list, folded on its own. A front-end preference:
   * the protocol has no opinion on how a rail is arranged. It folds
   * independently of the workspace list — the two answer different questions,
   * and folding one must not hide the other's head.
   */
  sessionsCollapsed: boolean;
  /**
   * The left rail's workspace list (local + remote), folded on its own —
   * the same independent, persisted preference as `sessionsCollapsed`.
   */
  workspacesCollapsed: boolean;
  /**
   * The left rail's foot (the workbench drawer), folded on its own — the same
   * independent, persisted preference as `sessionsCollapsed`.
   *
   * **Closed on a first launch.** The redesign makes the foot a floating card
   * whose open body is ~360px tall; left open by default it halves the number of
   * sessions the rail can show, which is the one thing this list exists for. A
   * person who wants the drawer opens it once and the preference keeps it.
   */
  footCollapsed: boolean;
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
   * Saved SSH hosts, the shared resource remote workspaces are built on
   * (§6.5 of the design: "SSH host configuration becomes a shared resource
   * that can be referenced by multiple workspaces").
   */
  sshHosts: SshHostConfig[];
  /**
   * Saved remote workspaces — the remote sibling of `workspaces` above. Kept
   * as a parallel list rather than merged into it; see `RemoteWorkspaceEntry`'s
   * own doc for why.
   */
  remoteWorkspaces: RemoteWorkspaceEntry[];
  /**
   * In-progress or finished install attempts, keyed by `RemoteWorkspaceEntry.id`.
   *
   * **Not persisted.** An install's progress is a fact about this run of
   * the application, not a preference — restoring a stale "verifying and
   * switching" status after a restart would describe a Rust command that
   * is not actually running any more. Window-level rather than a session
   * field because an install, unlike a connection, has no session to
   * belong to: it can run (and fail, and be retried) before any
   * `enterRemoteWorkspace` call for that workspace ever succeeds.
   */
  installStatus: Record<string, InstallStatus>;
  /**
   * The config-sync question currently on screen (§9.4), or `null` when
   * there is none. At most one at a time — like the close prompt, this is
   * a local decision the window asks, not a queued runtime request, so it
   * does not go through `pendingModals`.
   */
  configSyncPrompt: ConfigSyncPrompt | null;
  /**
   * The answer currently being carried out, or `null` when none is.
   *
   * **Answering is not instant, and the prompt used to look frozen while it
   * happened.** Every resolution opens a *fresh* SSH connection and speaks SFTP
   * over it — `check_remote_config`/`write_remote_config` in `remote_config.rs`
   * each dial from scratch — so "use local (overwrite remote)" is a one-to-two
   * second wait on a real network. With no state to draw, the dialog sat there
   * unchanged and the second press started a second upload against the same
   * file. This is what the prompt reads to disable its buttons, name what it is
   * waiting for, and refuse to be dismissed mid-write.
   */
  configSyncBusy: ConfigSyncChoice | null;
  /**
   * Why the last answer to `configSyncPrompt` failed, or `null`.
   *
   * The upload is the slow, failure-prone half of this dialog — a dropped
   * connection, a read-only home, a full disk — and a refusal that only went to
   * the console was indistinguishable from "the dialog vanished and nothing
   * happened". The prompt therefore stays up with this sentence when an answer
   * fails, so the same buttons can be pressed again.
   */
  configSyncError: string | null;
  /**
   * The remote workspace a config-sync answer is currently blocking, or `null`
   * when none is.
   *
   * `enterRemoteWorkspace` parks the id here when it raises `configSyncPrompt`,
   * and `resolveConfigSync`/`dismissConfigSync` resume through
   * `connectRemoteWorkspace` with it. It is a *parking slot* rather than a
   * queue: the prompt is a local decision the window asks about one host at a
   * time, so a second open arriving while one is pending replaces the first —
   * which is right, because the second is the row the person actually just
   * pressed.
   */
  pendingRemoteOpen: string | null;
  /**
   * The remote workspace an **open is in flight** for, or `null` when none is.
   *
   * `enterRemoteWorkspace` sets it before the config-sync check — the whole
   * pre-bucket stretch (the check over SSH, the automatic install, the gap
   * until the session's bucket is installed) has no session to read
   * `connection.phase` off, and this is what the connecting toast reads in
   * that stretch. `connectRemoteWorkspace` clears it the moment the bucket
   * exists (the bucket's own phase takes over from then on), and on every
   * failure path. Window-level and never persisted: a "connecting" that
   * survived a restart would describe a dial that is not happening any more,
   * the same reason `pendingRemoteOpen` is not persisted.
   */
  openingRemote: string | null;
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
  /**
   * Which saved remote workspace was last worked in, by entry id.
   *
   * **The remote counterpart of `lastWorkspace`.** A remote workspace's
   * directory is on another machine, so `lastWorkspace` — which the start-up
   * opens **here** — cannot name it, and a local path standing in for it would
   * send the next launch looking for a directory that is not on this computer.
   *
   * The two fields are not exclusive: they answer "where was the work", and the
   * answer may be either. The start-up reads the pair together and opens
   * whichever the last session was.
   */
  lastRemoteWorkspaceId: string | null;

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

  /**
   * Whether session notifications are switched on.
   *
   * Read by `useNotifications`, which is the only consumer. It is state rather
   * than a hook-local flag so the settings row can flip it and the watcher picks
   * the change up without a restart — and so a test can set it without a window.
   */
  notifyEnabled: boolean;
  /**
   * What the window's X button does.
   *
   * `ask` → the prompt; `minimize` / `close` → applied directly, with no prompt.
   * The choice is remembered from two places (the prompt's own checkbox and the
   * settings row), and both write this one field.
   */
  closePolicy: ClosePolicy;

  /* ---------------- tasks (the desktop's own templates) ---------------- */
  /**
   * Task templates, newest edit first is *not* guaranteed here — the panel
   * orders by what it reads; this is the shelf in insertion order.
   *
   * Front-end data end to end: created, edited and deleted by the actions
   * below, persisted with the rest of the user data in
   * `~/.tudouni/desktop.json` (`desktopData.ts`). The runtime never sees
   * these; only the prompt, the workspace and (on run) a `set_model` do.
   */
  tasks: Task[];
  /**
   * Which sessions each task has started, oldest first, capped at
   * `TASK_RUNS_MAX`. A link's `sessionId` is back-filled from `init`; until
   * then `sessionKey` is what a row is reachable by.
   */
  taskRuns: TaskRunLink[];
  /**
   * The model and effort last in use, by workspace (`desktop.json` holds it).
   *
   * The key follows `savedSessionsKey`: a local directory as `normPath`, a
   * remote workspace as `rw:<id>` — the same convention the saved lists use,
   * so "this place" is one identity in the file and in the lists alike.
   *
   * A **fallback for the next session in that workspace**: the start paths
   * pass it to the child as `--model`/`--effort`, and the runtime applies it
   * to a fresh session only — a session that stored its own choice keeps it,
   * and a name the catalogue no longer holds falls back to the configured
   * default. It is written from `ui(state)` (the runtime's own report of the
   * model in force), never from a path this front end assembled.
   */
  modelMemory: Record<string, ModelMemoryEntry>;

  /* ---------------- composer ---------------- */
  /** An OS drag is currently over the window. Purely local, purely visual. */
  dragging: boolean;
  /**
   * A rail-width drag is live, and **which rail** it is on. Purely local,
   * purely visual: the dragged rail drops its width transition while the
   * pointer moves, so it tracks the pointer instead of easing behind it — and
   * naming the rail is what keeps the class off the *other* one, whose handle
   * would otherwise light up for a gesture it is not part of.
   */
  resizing: 'left' | 'right' | null;

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
   * Record the saved remote workspace the next launch should open, and persist
   * it.
   *
   * The remote counterpart of `rememberWorkspace`, and a **separate field** for
   * the reason that field is separate: a remote workspace's directory is on
   * another machine, so `lastWorkspace` — which the start-up opens *here* —
   * cannot name it.
   *
   * The id is checked against the saved entries before it is written, so a
   * forgotten workspace leaves no dangling answer behind.
   */
  rememberRemoteWorkspace(remoteWorkspaceId: string): void;
  /**
   * Remember the model and effort in force in one workspace, and persist it.
   *
   * Written from `ui(state)` (the runtime's own report of the model in force),
   * keyed by the workspace the way `savedSessionsKey` keys the saved lists:
   * a local directory as `normPath`, a remote one as `rw:<id>`. It is a
   * **fallback for the workspace's next session** — the start paths pass it
   * to the child as `--model`/`--effort`, and the runtime applies it to a
   * fresh session only (a stored choice wins, and a name the catalogue no
   * longer holds falls back to the configured default). A no-op when the
   * entry already holds the same pair, so a stream of snapshots costs a
   * comparison and nothing else.
   */
  rememberModel(workspace: string, remoteWorkspaceId: string | null, model: string, effort: string): void;
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
   *
   * **A new conversation whose on-screen session is a remote one is not a
   * local child.** The active session's `workspace` is a directory on the
   * *remote* host, and starting a local runtime there refuses with "not a
   * directory" against this machine's filesystem. "New conversation" on a
   * remote session means "here" — *there* — so this routes to
   * `connectRemoteWorkspace` with `forceNew` instead. An explicit `workspace`
   * argument still wins, because it is a local directory the caller named.
   */
  openSession(sessionId: string | null, workspace?: string): Promise<void>;

  /** Send one message to the active session. */
  send(msg: FrontendMsg): void;
  /**
   * Start a workspace-learning run.
   *
   * A learning run is an **ordinary new session whose first message is the
   * configured task prompt** (see `src/learn/template.ts`) — no new protocol,
   * no special session type. This action assembles the message from the
   * workspace's saved-session list (the runtime's own answer to
   * `session_list`, already in the store), opens the session in the workspace
   * on screen, and sends the message once the child's handshake has landed.
   *
   * `scope` empty is the form's own gate; a run with no sessions in scope is
   * not started here — the panel says so instead.
   */
  startLearning(scope: LearnScope, deliverables: Deliverable[], objectives: string): Promise<void>;

  /**
   * Start a task-refine run for one task.
   *
   * A refine run is **an ordinary new session whose first message is the
   * refine prompt** (see `src/learn/refineTemplate.ts`) built from the
   * task's own run history — no new protocol, the same two-step `startLearning`
   * established. The session's workspace must be the task's (its
   * `.tudouni/sessions/` is the evidence), which the panel's availability
   * gate (`refineAvailability`) has already checked; this re-checks only the
   * half the store owns, and a `remote` target is refused here too, because
   * the first version's session files live on another machine.
   *
   * The session's bucket carries `refineTaskId` — the front end's half of the
   * delivery, since the candidate is applied by `upsertTask` on the question's
   * answer, not by the agent.
   */
  refineTask(taskId: string, scope: RunScope, failedOnly: boolean, objectives: string): Promise<string | null>;

  /* ---------------- task templates ---------------- */
  /** Create a task with the given fields and persist it. Returns the new id. */
  upsertTask(task: Task): void;
  /** Delete a template. Its run links are **kept** — the design is explicit
   *  that removing a template must not erase the trace of past runs. */
  deleteTask(taskId: string): void;
  /**
   * Forget the whole run list.
   *
   * The one destructive act History offers, and it is deliberately narrower
   * than it looks: it drops the **links**, not the sessions. Every run it
   * forgets is still a session on disk, reachable from the rail and the
   * library; all that goes is this panel's index of which template started
   * which one. Nothing else in the app reads `taskRuns`, so nothing else can
   * be surprised by this.
   */
  clearTaskRuns(): void;
  /**
   * Run a task: open a new session per the template, then deliver the prompt
   * as its first message. Resolves to the child key the run landed in, or
   * `null` when nothing was started (no workspace, or the open refused).
   */
  runTask(taskId: string): Promise<string | null>;
  /**
   * Back-fill a run link's session id once the child's `init` names one.
   * Called from `applyRuntimeMessage`; a no-op when nothing is waiting.
   */
  noteTaskRunInit(key: string, sessionId: string): void;
  /**
   * Record how a task-started run ended, onto its link.
   *
   * Called from `applyRuntimeMessage` at the two moments a turn settles — the
   * `event` that ends one, and a child that died mid-turn. A no-op for a key no
   * task started, and a no-op when the verdict is already on the link, so the
   * ordinary case costs no write and no `localStorage` round trip.
   *
   * **Why the store writes this down at all**, rather than History deriving it
   * at render time: the transcript a verdict comes from belongs to a child
   * process, and once that session is closed and reopened from disk the only
   * facts left are a `VmSessionListItem`'s counts and timestamps. A `Failed`
   * filter that emptied itself as sessions aged out would be worse than no
   * filter, so the one moment the answer is knowable is the moment it is
   * written.
   */
  noteTaskRunOutcome(key: string, outcome: TaskRunOutcome, durationMs: number | null): void;
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

  /**
   * Switch session notifications on or off, and remember it.
   *
   * An ordinary preference write — nothing is sent to the runtime and no session
   * is touched. The hook that watches for transitions reads this field, so
   * turning it off takes effect on the next change rather than needing anything
   * to be unwound.
   */
  setNotifyEnabled(on: boolean): void;
  /**
   * Set what the window's X button does, and remember it.
   *
   * Written from two places, and they are the same act: the close prompt's
   * "remember this" checkbox, and the settings row. `ask` is a real value here
   * rather than a way of clearing the preference — a person who has been
   * prompted, remembered a choice, and then wants the question back has to be
   * able to say so, and there is no separate "unset".
   */
  setClosePolicy(policy: ClosePolicy): void;

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
  /**
   * Mark every note the active session holds as seen by the notice center.
   *
   * Called when the capsule's popover opens. Only the ledger moves — the notes
   * themselves stay in `entries`, where the popover reads them.
   */
  markNotesRead(): void;
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
   * One path for `/exit` and any future quit affordance. It goes
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
  /**
   * Attach one file by path and put its placeholder into the active session's
   * draft. The counterpart of `stashPastedImage` for a file that already has a
   * path — no bridge write, no preview — so the same contract holds: `at` is the
   * caret, and the **return is where the caret should go**, or `null` when
   * nothing was inserted.
   */
  attachFilePath(path: string, at: number): number | null;

  /**
   * Attach paths that came from the **operating system** (a drop, or the native
   * file dialog), which is a different act from `attachFilePath`.
   *
   * A local session inserts them as they stand. A **remote** session uploads
   * each one into its workspace and inserts the workspace-relative path instead,
   * because the path the OS handed over is on this machine and the workspace is
   * on the other one. See the implementation for why the two branches cannot be
   * one, and for why the old "the model would go through shell" sentence was
   * false there.
   *
   * `at` is the caret for the local branch; the remote branch appends, because
   * the draft can change while an upload is in flight. Answers how many paths
   * were attached.
   */
  attachFiles(paths: string[], at?: number): Promise<number>;
  /** Forget one attached file. Called when its chip is dismissed. */
  forgetAttachedFile(path: string): void;

  /**
   * Open one panel.
   *
   * `focus` is **asked for, never inherited**: it opens the files panel onto a
   * single file instead of the browser, and only the deliverable-card preview
   * passes it (the picture door via `previewImage`, the text door right before
   * its `file_read`). Every other caller gets the browser, including a second
   * `openPanel('files')` — inheriting the flag made the directory listing
   * silently unavailable for the rest of the window's life.
   */
  openPanel(p: PanelKind | null, focus?: boolean): void;
  /**
   * Open the files panel **as a picker**: picking a row attaches the file to
   * the draft instead of reading it. The plain `/files` command goes through
   * `openPanel`, which clears this — the two entries never leak into each other.
   */
  openFilePicker(): void;
  /**
   * Close whatever panel is open, restoring the steady session filter.
   *
   * Closing goes through the store rather than a bare `setState({ panel: null })`
   * for one reason: the library borrows the connection's filter while it is open
   * (see `sessionFilter`), and every way out of a panel — Esc, the close button,
   * the overlay, picking a row — has to give it back. Six call sites each
   * remembering to do that is six chances for one of them not to, and the symptom
   * would be a rail that keeps reporting archived sessions until the next
   * restart.
   */
  closePanel(): void;
  /** Show or hide the session board in the conversation column. */
  setBoardOpen(open: boolean): void;
  toggleBoard(): void;
  /** Raise or dismiss the minimize-or-close prompt. Raised by `useWindowClose`. */
  setClosePrompt(open: boolean): void;
  /**
   * Change which sessions the runtime is asked to report, and ask again.
   *
   * The library's archive tabs call this; so does `openPanel`/`closePanel`, so
   * the filter always matches which of them is on screen. It is a store action
   * rather than a message argument because the runtime remembers it per
   * connection — a list re-sent after a delete or an archive carries the same
   * view, which is what keeps a just-hidden row from reappearing.
   */
  setSessionFilter(filter: 'active' | 'all'): void;
  /**
   * Set the transcript's quiet mode for the session on screen, and remember it
   * so a fresh session starts from it. The status bar's menu calls this with
   * the picked value.
   */
  setQuiet(q: QuietMode): void;
  /**
   * The keyboard path (`Ctrl+\`) and `/quiet`: the mode has no toggle — the
   * chip is a menu now — so a bare press **cycles** off → normal → simple →
   * off. A key that flipped a boolean is now a key that walks a list.
   */
  toggleQuiet(): void;
  /** Raise the transcript's find bar (`Ctrl+F`) and put the keyboard in it. */
  openFind(): void;
  /**
   * Take it down, and hand the keyboard back to the transcript.
   *
   * Reached from three places — `Esc`, the bar's close button, and every session
   * switch — which is why it is an action rather than a `setState` at each of
   * them.
   */
  closeFind(): void;
  setFindQuery(q: string): void;
  setFindIndex(i: number): void;
  toggleSidebar(): void;
  setSidebarVisible(v: boolean): void;
  /**
   * Set the right rail's dragged width (clamped), or `null` to hand the width
   * back to the stylesheet. Persisted like the other window-level preferences.
   */
  setSidebarWidth(px: number | null): void;
  /**
   * The left rail's own dragged width, under the same contract as
   * `setSidebarWidth`: clamped through `clampRailWidth`, `null` hands the width
   * back to the stylesheet, persisted with the other window-level preferences.
   */
  setLeftbarWidth(px: number | null): void;
  toggleLeftbar(): void;
  setLeftbarVisible(v: boolean): void;
  toggleBlock(k: SidebarBlockKey): void;
  /**
   * Bring the right rail back and unfold one of its blocks — the entry point
   * for the collapsed-summary chips, which stand in for a folded rail. Unlike
   * `toggleBlock` this is one-directional: a press always opens, never folds,
   * and it persists like the rail preferences do.
   */
  openSidebarBlock(k: SidebarBlockKey): void;
  /** Fold or unfold the left rail's session list. Persisted like the rails. */
  toggleSessionsCollapsed(): void;
  /** Fold or unfold the left rail's workspace list. Persisted like the rails. */
  toggleWorkspacesCollapsed(): void;
  /** Fold or unfold the left rail's foot (the workbench buttons). Persisted. */
  toggleFootCollapsed(): void;
  toggleReasoning(id: string): void;
  toggleTool(id: string): void;
  /** Fold a turn's whole body behind its head, or unfold it. Not persisted: it
   *  describes this window's reading, like the two above. */
  toggleTurnFold(id: string): void;
  /** Remove one in-stream block from the active session. No data involved. */
  removeBlock(id: string): void;

  answerPermission(decision: PermissionDecision): void;
  /**
   * Answer the drawn question batch. One entry per question of the batch, in
   * the batch's order. A `null` entry skips that one question; `null` itself
   * (no array at all) skips the whole batch — one independent action, never an
   * empty submit. Every question gets its own `question_response`, because the
   * runtime opened one waiter per id.
   */
  answerQuestion(answers: (string | null)[] | null): void;
  /**
   * Put the drawn question modal aside without answering it.
   *
   * Only a question can be minimized, and only when it is actually drawn:
   * a held request is already not on screen, and the approval modal is a
   * decision the person made to read in full — see its own header.
   */
  minimizeQuestion(): void;
  /** Bring the minimized question modal back. No-op when it is not minimized. */
  restoreQuestion(): void;

  requestSessionList(): void;
  /** Delete one saved session. The list updates when the runtime's next
   *  `sessions` arrives — never on send (no optimistic removal). `via` names
   *  the connection to send on, for a caller acting on a specific child (the
   *  board's card menu) rather than on whichever conversation is focused. */
  deleteSession(id: string, via?: string): void;
  /**
   * Archive or un-archive one saved session.
   *
   * **This is where "not while it is running" is enforced.** A live child holding
   * the id means a writer appending to the file while the runtime rewrites its
   * metadata — a race the runtime cannot see, because it does not know about the
   * other connections. The action checks the `sessionId → key` index (this
   * end's own fact) and refuses; the caller is expected to have disabled the
   * control so the refusal is never the thing a person discovers by pressing.
   *
   * **The route is the exemption.** `via` names a connection to send through —
   * the board's card menu sends through the holder itself, which is safe the
   * other way: the runtime waits the *mounted* session's own turn out before
   * rewriting (`Server.archiveSession` joins the turn), so that holder's writes
   * are quiesced. Any *other* writer is still refused here.
   */
  archiveSession(id: string, archived: boolean, via?: string): void;
  /**
   * Fork the active session at one of its replies: the runtime copies the
   * conversation up to the end of that reply's turn, under a fresh id, and
   * mounts the copy (the opening triple lands like a fresh session).
   *
   * The reply is named by its exact text plus `userBefore`, the number of
   * user rows the transcript draws above it. The runtime's `Fork` owns the
   * matching and the turn-boundary cut; no optimistic UI — the screen changes
   * when the runtime's `init`/`session_load` arrive, so a refused fork (a
   * reply the on-disk history does not carry) leaves the transcript exactly
   * as it was.
   */
  forkSession(reply: string, userBefore: number): void;
  setAutopilot(on: boolean): void;
  chooseModel(model: string): void;
  chooseEffort(effort: string): void;
  setThinking(on: boolean): void;
  requestBlock(which: BlockKind): void;
  /** Ask for `ui(context)` **without** leaving the panel that asked. */
  refreshContext(): void;
  /**
   * Ask the active session's child for a fresh `ui(status)`. The breakdown
   * is one turn's, and the turn that just ended is the one a person opens the
   * timing panel about — so `TimingPanel` asks for it on mount rather than
   * trusting the cached copy, the same pattern `ContextPanel` uses for its
   * ledger (`refreshContext`).
   */
  refreshStatus(): void;
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
  /**
   * Show one **picture** in the viewer.
   *
   * Separate from {@link readFile} because the two cannot share a path: that one
   * speaks `file_read`, which refuses anything that is not UTF-8. A picture is
   * read by the desktop's own command and arrives as a `data:` URL.
   */
  previewImage(path: string): void;

  /* ---------------- workspace memory ---------------- */

  /**
   * Ask for the panel's whole snapshot.
   *
   * One request for everything, the way `terminal_list` is: the panel has four
   * sections that describe one corpus, and assembling them from several replies
   * would give it a window in which the candidate list disagrees with the entry list
   * drawn beside it.
   */
  requestMemory(): void;
  /**
   * Perform one review decision.
   *
   * The verbs are the runtime's (`publish`, `reject`, `deprecate`, `rebuild`,
   * `config`) and they are the **person's**: the model can only propose. Every one of
   * them answers with a fresh snapshot, so this store never patches the panel's view
   * itself — it redraws from the runtime's answer.
   */
  memoryAction(action: MemoryActionKind, args?: MemoryActionArgs): void;

  /* ---------------- the code index ---------------- */

  /**
   * Ask for the panel's whole snapshot (`ui(codeintel)`).
   *
   * One request for everything — the switch, whether an index exists, the counts,
   * how far behind it is and any build in flight — because they all describe one
   * index and a panel assembled from several replies could draw a file count from a
   * build that had already been replaced.
   */
  requestCodeIntel(): void;
  /**
   * Perform one verb on the index.
   *
   * `status` and `config` answer with a fresh snapshot; `init` and `sync`
   * **acknowledge immediately** and the build narrates itself through pushed
   * `ui(codeintel)` messages. That is why nothing here sets an optimistic
   * "building" flag: the runtime's own snapshot is the only source for it, and a
   * guessed one would show a progress bar for a pass that had already failed to
   * start.
   */
  codeIntelAction(action: CodeIntelActionKind, args?: { enabled?: boolean }): void;

  /* ---------------- the usage ledger ---------------- */

  /**
   * Ask for the usage panel's whole snapshot (`ui(usage)`).
   *
   * One request per panel open, never polled: the ledger only grows on finished
   * turns, and a person reading totals does not need them to tick. The answer
   * lands in the window-level `usage` slot, so it survives a session switch.
   */
  requestUsage(): void;

  /**
   * Ask the runtime to probe the current model's reasoning levels.
   *
   * The asks cost real tokens, so the **confirmation is the panel's**: this
   * action sends the message, and only the panel decides the moment that is
   * allowed — after the person has read what a probe will send. The answer
   * lands in the session bucket's `probeEffort`; nothing here pre-draws a
   * result, because a probe that takes seconds must not look finished.
   */
  requestProbeEffort(): void;

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
  /**
   * Stop one running **background** subagent.
   *
   * Like `killTerminal` there is no reply payload: the child settles with the
   * ordinary `cancelled` reason, the board moves the row to the done panel, and
   * the next `ui(state)` re-draws everything — the runtime stays the only source
   * of truth for what is running. A refused stop arrives as a notice naming why
   * (unknown id, already finished), which the transcript shows.
   */
  stopSubagent(id: string): void;
  /**
   * Forget a terminal that has **already ended**, so its tab goes away.
   *
   * Not a synonym for `killTerminal`, and the runtime enforces the difference: a
   * record whose process is still alive would be a shell nobody can see and
   * nobody can end. So this refuses a running terminal, and the caller's job is
   * to end it first and close it once the `terminal_exit` has arrived.
   *
   * The reply is a fresh full list, so a tab dropped too eagerly is restored from
   * the same message that carries the reason.
   */
  closeTerminal(id: string): void;
  /** Point this front end's terminal view at one terminal. A **local** act:
   *  nothing is sent, and the shell is unaffected either way. `null` goes back to
   *  the conversation. */
  attachTerminal(id: string | null): void;
  /**
   * The status bar's terminals badge: into the terminal view, or back out of it.
   *
   * A **toggle**, and the second half is what makes it worth having: before it,
   * leaving the terminal view was three controls that all live *inside* it (the
   * tab strip's button, the pane's footer, and `Ctrl+Shift+\` when the pane has
   * the focus), so once somebody's attention had moved to the bottom of the
   * window there was no way back to the conversation without going in first.
   * That is the same shape as the tab strip's own `onPick`, which also treats
   * "press the thing you are already on" as "go back".
   *
   * It picks its target with `nextTerminalId` rather than remembering one,
   * because the id it would remember is exactly the one that gets closed.
   */
  toggleTerminalView(): void;
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
  /**
   * Save an SSH host configuration for later remote workspaces to reference.
   * A local act: nothing connects. Returns the new host's id.
   */
  addSshHost(host: Omit<SshHostConfig, 'id'>): string;
  /**
   * Update a saved SSH host's fields in place. Every remote workspace that
   * references it (by `hostId`) picks up the change on its next connection —
   * there is nothing to migrate, since they only ever hold the id.
   */
  updateSshHost(id: string, patch: Partial<Omit<SshHostConfig, 'id'>>): void;
  /**
   * Forget a saved SSH host. Refused (returns `false`) while any saved remote
   * workspace still references it — removing the host out from under a
   * workspace that still names it would leave that workspace unable to say
   * what `connect` should reach, and silently deleting the workspace along
   * with it is a bigger act than the person asked for. Remove the dependent
   * workspaces first.
   */
  removeSshHost(id: string): boolean;
  /**
   * Save a remote workspace. A local act, like `addWorkspace`: nothing
   * connects, nothing is validated against the live host. Returns the new
   * entry's id.
   */
  addRemoteWorkspace(entry: Omit<RemoteWorkspaceEntry, 'id'>): string;
  updateRemoteWorkspace(id: string, patch: Partial<Omit<RemoteWorkspaceEntry, 'id'>>): void;
  /** Forget a saved remote workspace. Does not touch any session already
   *  running against it — being *listed* and being *in use* are different
   *  things here too, same as `removeWorkspace`. */
  removeRemoteWorkspace(id: string): void;
  /**
   * Go to a saved remote workspace: focus a live session there, or connect
   * and start one.
   *
   * This is `enterWorkspace`'s remote sibling. It is a separate method
   * rather than a second branch inside `enterWorkspace` because the two take
   * different arguments (a path vs. an entry id) and connect through
   * different Tauri commands (`runtime_attach` vs. `runtime_attach_remote`);
   * folding them into one signature would need a discriminated argument that
   * every existing local call site would have to be updated to pass.
   *
   * **It waits for a config-sync decision rather than racing it.** When the
   * saved host's `configPolicy` is `'ask'` and both sides have changed, this
   * raises `configSyncPrompt` and returns *without connecting* — the workspace
   * id is parked in `pendingRemoteOpen` and `connectRemoteWorkspace` is called
   * once the answer arrives. Connecting first and asking afterwards meant the
   * session ran against the remote file the person had not decided about, and
   * on a fresh remote account (no usable route in its `config.json`, which is
   * the ordinary first case) it died with exit code 2 while the question was
   * still on screen.
   */
  enterRemoteWorkspace(remoteWorkspaceId: string): Promise<void>;
  /**
   * Connect to a saved remote workspace and open a session there — the half of
   * `enterRemoteWorkspace` that runs once no config decision is outstanding.
   *
   * Separate and public because the config-sync prompt's own answer is what
   * calls it: `resolveConfigSync` finishes by resuming whatever
   * `enterRemoteWorkspace` parked in `pendingRemoteOpen`, and that resume has to
   * go through a method rather than through the prompt-handling path it came
   * from (which would re-check the sync it has just resolved, forever).
   *
   * Calling it directly for a workspace whose config has not been checked skips
   * §9.4's check — so the sidebar row and the wizard both go through
   * `enterRemoteWorkspace`, and this is the continuation rather than a second
   * entrance.
   *
   * The `forceNew` option skips the "a live session already exists for this
   * workspace" no-op guard. One caller wants it: "New session" on a screen whose
   * session is remote. Pressing the row again is a duplicate, pressing the
   * button is a request for **another** conversation there — a second child,
   * beside the first.
   *
   * `sessionId` is how a *saved* session gets reopened on the remote host: the
   * child is started in the remote workspace **with that session id**
   * (`--session <id>`), the same id the local path passes on. Without it the
   * remote child would start a *new* session rather than resume the one the
   * person clicked.
   *
   * `retried` is internal, and it exists to make the automatic repair **once**:
   * a dial refused because the recorded binary no longer runs is retried after
   * clearing `remoteBinary` (which makes the install path do its work), and the
   * retry carries this flag so a host that cannot run the uploaded binary at all
   * fails with a sentence instead of installing in a loop.
   */
  connectRemoteWorkspace(
    remoteWorkspaceId: string,
    options?: { forceNew?: boolean; sessionId?: string; retried?: boolean },
  ): Promise<void>;
  /**
   * Installs or upgrades the Runtime on a remote workspace's host (§8 of
   * the design), without connecting afterwards. A separate act from
   * `enterRemoteWorkspace` on purpose: the design's own install flow is
   * "detect, upload, verify, switch" as one self-contained operation that
   * a person explicitly asks for (typically because a connection attempt
   * reported no Runtime at the configured path), not a step folded
   * silently into every connect — see §8.4's requirement that an install
   * failure must not look like a connection failure, which conflating the
   * two methods would risk.
   *
   * On success, the workspace's own `remoteBinary` is updated to the
   * installed path (through `CurrentLink`) so the very next
   * `enterRemoteWorkspace` call uses it. Progress is tracked in
   * `installStatus`, keyed by `remoteWorkspaceId`.
   */
  installRemoteWorkspace(remoteWorkspaceId: string): Promise<void>;
  /**
   * Checks a saved SSH host's config.json against the local one (§9.3–9.5)
   * and, depending on the host's `configPolicy`, either resolves it
   * automatically (`'sync-local'` uploads the local file; `'use-remote'`
   * only ever records the remote's own fingerprint as the baseline and
   * never uploads) or sets `configSyncPrompt` for the UI to draw a choice
   * from.
   *
   * **The rules for whether `'ask'` asks at all live in `state/configSync.ts`,
   * not here.** They are the half of this that cannot be seen in a rendered
   * dialog, and the first version asked on comparisons that were not decisions:
   * a host with no local file re-flagged itself on every single open, and a host
   * whose answer was "use remote" was asked again on every later open because
   * the kept local file can never match the synced baseline. Both are asserted
   * in `tests/config-sync.test.ts`; this method does the I/O and applies the
   * answer.
   *
   * Call before `enterRemoteWorkspace`/`installRemoteWorkspace` for a
   * host whose config might matter to what runs there; this method does
   * not call either of them itself, since config sync and connecting are
   * two separate acts.
   */
  checkConfigSync(hostId: string): Promise<void>;
  /**
   * Answers an `ask` prompt (`configSyncPrompt`): `'use-local'` uploads the
   * local file (backing up the remote one first, server-side);
   * `'use-remote'` only records the remote's fingerprint as the new
   * baseline. Clears `configSyncPrompt` on success.
   *
   * Either answer records **both** sides' last-seen fingerprints — the remote's
   * and the local's — which is what makes the decision stay decided: "use remote"
   * leaves the local file different on purpose, and a single baseline would read
   * that as a local change on every later open.
   *
   * A failed write keeps the prompt up with `configSyncError` and the open still
   * parked, so the same button retries it. The rejection is re-raised for
   * programmatic callers (the dialog consumes it — the sentence is on screen).
   *
   * `remember` writes the answer into the host's `configPolicy` — `'sync-local'`
   * for "use local", `'use-remote'` for "use remote" — so the same host is not
   * asked again. That is the whole point of the policy field existing: §9.4
   * gives each host one of three policies, and until this option there was no
   * way for a person to leave `'ask'` at all, however many times they gave the
   * same answer. An in-flight answer is refused here rather than doubled:
   * `configSyncBusy` is set for the duration (`configSyncBusy`'s own doc says
   * why answering takes a second or two).
   */
  resolveConfigSync(choice: ConfigSyncChoice, options?: { remember?: boolean }): Promise<void>;
  /**
   * Dismisses `configSyncPrompt` without changing either file. A no-op while an
   * answer is being written — see `configSyncBusy`.
   */
  dismissConfigSync(): void;
  /** Look up a tool's facts for the active session's stream rows. */
  toolFacts(name: string): ToolFacts | null;

  /**
   * Ask the host which build one remote session is running, once, and keep it.
   *
   * `init` carries no product version, so a remote session's build has to be
   * read by running its binary over SSH. Lazy rather than at connect because it
   * costs a dial and one panel wants it; cached on the bucket because a running
   * process cannot change its build.
   *
   * A local session is a no-op: the window-level `runtimeVersion` is already the
   * right answer for it.
   */
  resolveRuntimeBuild(key: string): Promise<void>;

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

  /**
   * Which machine the config panel should edit right now: the **screen's**, or
   * `null` for this one.
   *
   * **The panel cannot answer this itself.** It needs the SSH destination, and
   * `remoteConnectionOf` deliberately carries no credentials — the password
   * lives on the saved host, which is the store's business. So the store builds
   * the target, and the panel only asks "is this a remote screen and, if so,
   * which host".
   *
   * `null` means a **local** screen, which includes "no session open": there is
   * then nothing remote to edit, and the local file is the honest subject.
   */
  configTarget(): { remoteWorkspaceId: string; hostId: string; target: RemoteConfigTarget } | null;

  /**
   * Record the fingerprint of a remote `config.json` this window just wrote.
   *
   * **§9.5's baseline is what stops the panel's own edit from being reported as
   * somebody else's change.** `checkConfigSync` compares each side against the
   * value it was last *seen* at, so a save that leaves the host's file different
   * from the recorded baseline makes the next open ask "the remote file changed —
   * which wins?" about an edit the person made a minute ago, in this window.
   * Writing both baselines to the bytes just stored is what the sync flow itself
   * does after an upload.
   *
   * The local baseline is only moved when the local file was not the subject —
   * editing the host's file does not touch this machine's, so claiming it did
   * would hide a real local change from the next comparison.
   */
  noteRemoteConfigWritten(hostId: string, remoteFingerprint: string): void;
}




