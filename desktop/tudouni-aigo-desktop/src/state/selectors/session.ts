/**
 * Session selectors.
 *
 * Every one takes the session it is about (or the key of one) and returns a
 * derived fact. They are pure reads: no `set`, no bridge, no side effects.
 *
 * Moved verbatim out of `store.ts`; `store.ts` re-exports them, so call sites
 * still import from `@/state/store`.
 */
import { conversationView } from '@/conversationView';
import {
  cacheHitRate,
  phaseFromStopReason,
  type Phase,
  type VmJob,
  type VmModel,
  type VmRiskScope,
  type VmSubagent,
  type VmSubagentDone,
  type VmTool,
} from '@/runtime/adapt';
import {
  hasRunningTurn,
  lastStopReason,
  type CallUsage,
} from '@/state/entries';
import { encodeNotifySnapshot, type NotifyRow } from '@/runtime/notify';
import { baseName, samePath, tokPerSecond } from '@/utils/format';
import { activeWorkspaceOf, runtimeOf } from '../appView';
import { NO_SAVED_SESSIONS } from '../empty';
import { savedSessionsKey } from '../savedSessionsKey';
import type { AppStore, SavedSessions, SessionRuntime } from '../store';


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
export const NO_SUBAGENTS_DONE: VmSubagentDone[] = [];
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
 * **Where they come from changed, and why.** They used to come only from
 * `ui(status)`, which is requested when a turn ends (decision 5) — so on a long
 * turn the bar sat on the previous turn's figures and then jumped, and a turn
 * that grew from nothing to 300k tokens showed the whole jump at once. The
 * `model_call` event carries the same four fields and is already arriving (the
 * reducer draws the model row from it), so the **last successful call of this
 * session** is taken from the event stream as it lands and the bar moves per
 * step. `ui(status)` is still the source for the session totals and remains the
 * fallback for a session whose calls this window never saw — a `/resume`d
 * conversation, whose transcript is rebuilt from the session file rather than
 * replayed as events.
 *
 * The `status` message is **not** requested any more often: it reads the audit
 * log and must not become a heartbeat. Nothing here polls.
 *
 * **Two different facts, two different fields.** `used` is the input of the last
 * *successful* request — what the provider actually received. `context.used` is
 * the context layer's own **local estimate** of what it would send. The reference
 * front end keeps them apart on purpose ("a wrong one is worse than none"): one is
 * a measurement, the other is arithmetic, and swapping one in for the other labels
 * an estimate as a measurement.
 */
export interface UsageView {
  /** The provider's own count for the last successful call, or null. */
  used: number | null;
  window: number | null;
  percent: number | null;
  cacheHitRate: number | null;
  /**
   * What `cacheHitRate` is a ratio **of**.
   *
   * The two are different questions and the numbers can differ: `call` is the
   * last successful request's own cached share (the live path), `session` is the
   * totals summed over every call so far (`ui(status).usage`, the fallback for a
   * session whose calls this window never saw). The label says which, because a
   * figure that silently changes meaning between two sessions is worse than one
   * that says less.
   *
   * `null` when there is no rate at all.
   */
  cacheScope: 'call' | 'session' | null;
  /** The context layer's local estimate. Never a substitute for `used`. */
  estimated: number | null;
  /** The estimate's own percentage, against the same window. */
  estimatedPercent: number | null;
  /**
   * The last successful call's average output rate (tokens per second), or
   * null. Computed from that call's own completion count and duration — the
   * same two halves `liveCall` holds — so a step that produced no output (a
   * tool-only call) reports no rate rather than claiming one. The bar has no
   * session-total rate to fall back to: `ui(status)` carries totals, and an
   * average built from them here would be a figure the ledger does not state.
   */
  outputRate: string | null;
}

/**
 * How much of a prompt came from the provider's cache — **one call's** ratio.
 *
 * The reference front end's bar reads this way on purpose: the two fields are
 * that call's prompt and the cached subset of it, so they cannot mix two calls.
 * `internal/frontends/tui/view.go` (`cacheHitText`) is the same division over the
 * same pair, and with no prompt it is an em dash rather than 0% — "no lookup has
 * happened yet" and "the cache is broken" are different statements.
 */
function callHitRate(call: CallUsage | null): number | null {
  const prompt = call?.promptTokens ?? null;
  const cached = call?.cachedTokens ?? null;
  if (prompt === null || cached === null || prompt <= 0) return null;
  return cached / prompt;
}

export function selectUsage(s: AppStore, key: string | null): UsageView {
  const bucket = runtimeOf(s, key);
  const status = bucket?.status;
  const snap = bucket?.uiState;
  const context = bucket?.context;
  const live = bucket?.liveCall ?? null;

  // The live record first, then the session totals. A **present but empty** live
  // record is not a reason to fall back: it is this session's last successful
  // call saying it reported no usage, and showing the previous turn's totals
  // under this step's name would be the mixture the record exists to prevent.
  const used = live ? live.promptTokens : (status?.lastPromptTokens ?? null);
  const estimated = context?.used ?? null;
  // The window travels with the status screen; the snapshot's `model_window` is
  // the same fact from the other message, and either will do.
  const window = status?.window ?? snap?.modelWindow ?? null;
  const percent = used !== null && window !== null && window > 0 ? used / window : null;
  const estimatedPercent =
    estimated !== null && window !== null && window > 0 ? estimated / window : null;
  const hit = live ? callHitRate(live) : status ? cacheHitRate(status.usage) : null;
  // Which question the rate answers. Reported rather than assumed, so the chip's
  // label cannot claim "last call" over a session average.
  const cacheScope: UsageView['cacheScope'] = live
    ? live.promptTokens !== null && live.promptTokens > 0
      ? 'call'
      : null
    : status
      ? 'session'
      : null;

  return {
    used,
    window,
    percent,
    cacheHitRate: hit,
    cacheScope,
    estimated,
    estimatedPercent,
    outputRate: live ? tokPerSecond(live.completionTokens, live.durationMs) : null,
  };
}

/**
 * How long the turn on screen has been running, in milliseconds.
 *
 * Three answers, in order:
 *
 *   1. **A finished turn's own measurement** — `run_finished.duration_ms`. This
 *      is the runtime's number and the only one that may be shown as a final
 *      figure; `lastTurnMs` carries it.
 *   2. **A turn still in flight** — `Date.now() - startedAt`, the local stamp the
 *      reducer took when `run_started` landed. The runtime sends no duration
 *      until the turn ends, so this is the only way the figure can move while it
 *      runs. The reference front end does exactly this (`internal/frontends/tui/
 *      view.go`, `spanText`: `time.Since(m.current.startedAt)`).
 *   3. **Nothing** — `null`, drawn as an em dash. A session between turns has no
 *      duration to report, and `0ms` would claim one was measured.
 *
 * `now` is a parameter so the caller can drive it from one clock read per frame
 * and so this stays a pure function of its arguments.
 */
export function selectTurnMs(s: AppStore, key: string | null, now: number): number | null {
  const bucket = runtimeOf(s, key);
  if (!bucket) return null;
  // `lastStopReason` reads the turn heads, so "is one running" is answered by the
  // transcript rather than by a second flag that could disagree with it.
  const running = hasRunningTurn(bucket.entries);
  if (running) {
    for (let i = bucket.entries.length - 1; i >= 0; i -= 1) {
      const entry = bucket.entries[i];
      if (entry.kind === 'turn' && entry.status === 'running') {
        return Math.max(0, now - entry.startedAt);
      }
    }
    // A running turn with no head to time: the transcript and the flag disagree,
    // and inventing a duration from a turn that is not there would be worse than
    // showing none.
    return null;
  }
  return bucket.lastTurnMs;
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

  // **A turn in flight outranks a failure that is already history**, and the
  // order of these two blocks is the whole of one reported bug: a red dot that
  // would not go away. `lastStopReason` reads the most recent **finished** turn,
  // so after a `model_error` it keeps answering `broken` — including while the
  // *next* turn is running, which is the one moment the session is demonstrably
  // working. The retry that recovered from that failure was watched for its whole
  // four minutes under a red dot while the status bar beside it read "running":
  // two surfaces of one window disagreeing about one session, and the dot is the
  // one with no action attached to it.
  //
  // A turn that ends badly brings the red back the instant it ends, because
  // `lastStopReason` then names *that* turn — the failure is reported for as long
  // as it is the latest thing that happened, never for ever.
  if (hasRunningTurn(bucket.entries)) return 'running';

  // **Red is only for "you did not stop it, and it broke."** `interrupted`,
  // `step_limit` and `empty` are deliberately *not* here: pressing Esc three
  // times must not earn three red dots, or red stops meaning anything.
  //
  // A child that died unasked is the other half of the same judgement, and it is
  // read off `runtimeExit` rather than the transcript: `settleAbandonedTurn`
  // closes the turn such a child was in, so there is no running turn for it to
  // have been outranked by above.
  const stop = lastStopReason(bucket.entries);
  const failed =
    stop === 'model_error' ||
    stop === 'model_fatal' ||
    (bucket.runtimeExit !== null && !bucket.runtimeExit.requested);
  if (failed) return 'broken';

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
 * The sessions that have a live child and **no file on disk yet**, as one
 * compact string.
 *
 * **This is why "New session" looked like a dead button.** The rail draws
 * `sessions.items`, which the runtime builds by reading this workspace's session
 * files — and a session that has not run a turn has no file. So a brand-new
 * session appeared in **no list at all**. Measured on the release build, pressing
 * the button from the first screen left the transcript, the four "recent
 * sessions" slots and every rail row byte-identical; the only thing that moved
 * was the id in the session bar. That is a screen with no feedback on it, and the
 * people who hit it press again — four children in sixteen seconds on the machine
 * this was diagnosed on.
 *
 * It is a **front-end** fact, deliberately: "which conversations do I have open"
 * is something this end owns, while the runtime's list stays the authority on
 * what is *saved*. The two are drawn as two groups so neither is read as the
 * other, and a conversation that is in both is drawn once, from the saved list,
 * because that row carries its messages and preview.
 *
 * Format: `key\u0000sessionId\u0000status` per row, joined by `\u0001`. Control
 * characters for the same reason `selectWorkspaceAttentionKey` uses them: none of
 * a child key, a session id or a status name can contain one.
 */
/**
 * One workspace's saved-session list, or the shared empty one.
 *
 * The lookup is by `savedSessionsKey(workspace, remoteWorkspaceId)`, the same
 * function the write is keyed with, so the two cannot disagree about which
 * directory a list belongs to.
 *
 * **The third parameter names the machine, and it is not optional by accident.**
 * `hostA:/srv/app`, `hostB:/srv/app` and a local `/srv/app` are three places that
 * compare equal as strings; keying by the path alone made them one bucket, so one
 * machine's answer overwrote another's. Callers that hold a bucket pass
 * `remoteWorkspaceIdOf`; the ones that hold only a path (the last parameter's
 * `undefined` case) are asking the question about a **local** directory, which is
 * the only thing a bare path means.
 *
 * A workspace that has never been asked about answers `listed: false` — "no
 * runtime has told me yet" — rather than an empty list that would read as "this
 * workspace has nothing in it".
 */
export function selectSavedSessions(
  s: AppStore,
  workspace: string,
  remoteWorkspaceId: string | null = null,
): SavedSessions {
  if (workspace.trim() === '' && remoteWorkspaceId === null) return NO_SAVED_SESSIONS;
  return s.savedSessions[savedSessionsKey(workspace, remoteWorkspaceId)] ?? NO_SAVED_SESSIONS;
}

/**
 * The same list, for a caller that has the **screen** rather than a workspace
 * pair.
 *
 * This is the one the rail, the first screen and the panels use: they draw "the
 * conversations of the place I am in", and the bucket on screen is the authority
 * on which place that is — including which machine.
 */
export function selectSavedSessionsOf(s: AppStore, key: string | null): SavedSessions {
  const bucket = runtimeOf(s, key);
  if (bucket === null) return NO_SAVED_SESSIONS;
  return selectSavedSessions(
    s,
    bucket.session?.workspace ?? bucket.workspace,
    bucket.remoteWorkspaceId,
  );
}

/**
 * Which place a **saved session id** belongs to, as far as this window knows.
 *
 * The question a reopened session asks — "the notification (or a task's run
 * history) named session `S`; which workspace and which machine is that?" — and
 * it has to be answered from the lists rather than from the conversation on
 * screen, because the click routinely happens with something else on display.
 *
 * **Why the answer cannot come from the screen.** `openSession(id)` used to
 * decide remote-vs-local from the *active* bucket and then pass the id through.
 * Clicking a notification about a remote session while a local one was on
 * screen therefore spawned a **local** child with `--session <remote id>`, and
 * the runtime reads an id with no file as *a new session with that name*: the
 * person got an empty local conversation and the report of a session that never
 * opened. The id has to be resolved to its place first — that is this function.
 *
 * `null` means no list this window holds contains that id, which is not an
 * error: a session can be described by a notification from an earlier run, or
 * its workspace's list may never have been fetched. Callers fall back to the
 * screen's own answer, which is the old behaviour and is right whenever the
 * screen *is* the place.
 */
export function selectSessionHome(
  s: AppStore,
  sessionId: string,
): { workspace: string; remoteWorkspaceId: string | null } | null {
  if (sessionId === '') return null;
  for (const list of Object.values(s.savedSessions)) {
    // `items`, not `active`: an archived conversation is still a place, and
    // reopening one (a notification about it can outlive the archive) must go to
    // its own machine rather than being answered from wherever the screen is.
    if (!list.items.some((row) => row.id === sessionId)) continue;
    return { workspace: list.workspace, remoteWorkspaceId: list.remoteWorkspaceId };
  }
  return null;
}

/**
 * The session ids a live child of **this end** holds, as a lookup.
 *
 * "Do not archive a session something is still writing" is a fact the runtime
 * cannot check — it sees no other process — so the desktop is where it becomes
 * enforceable, and both the button's disabled state and `archiveSession`'s
 * backstop read it from here so the claim and the check cannot drift.
 *
 * Takes the whole store because a child's id is not in the workspace list: it is
 * whatever that child's `init` named, which is exactly the case (`Ctrl+1..9` and
 * the rail both draw a row for a session whose file may not be written yet).
 */
/**
 * **The compact key, and the only form a component may subscribe to.**
 * The same ids as `selectLiveSessionIds`, as `id\u0001` per row in `s.order`
 * order. Control separator: a session id is a runtime-minted
 * `YYYYMMDD-HHMMSS`-ish token and cannot contain one.
 *
 * **This split is a fix, not a style choice.** `selectLiveSessionIds` builds a
 * fresh `Set` on every call, and a zustand selector is compared by reference:
 * a new `Set` on every read is an unstable selection, so `useSyncExternalStore`
 * concluded the store changed on every render and the panel looped into
 * "Maximum update depth exceeded". `useShallow` would not have saved it either
 * (its equality walks `Object.keys`, which is empty for a Set). A compact
 * string is a stable primitive — the same escape hatch `selectRowStatusKey`
 * and `selectWorkspaceAttentionKey` use for their collections.
 */
export function selectLiveSessionIdsKey(s: AppStore): string {
  const parts: string[] = [];
  for (const key of s.order) {
    const id = s.sessions[key]?.sessionId;
    if (id !== null && id !== undefined && id !== '') parts.push(id);
  }
  return parts.join('\u0001');
}

/** The ids a live child of this end holds, as a lookup.
 *  **Not for `useApp`** — see `selectLiveSessionIdsKey`. Derive it there with
 *  `useMemo` and rebuild it only when the key changes. */
export function selectLiveSessionIds(s: AppStore): Set<string> {
  const ids = new Set<string>();
  for (const key of s.order) {
    const id = s.sessions[key]?.sessionId;
    if (id !== null && id !== undefined && id !== '') ids.add(id);
  }
  return ids;
}

/**
 * The last finished turn's stop reason for a live session, or the live turn's
 * own status while one is in flight.
 *
 * `null` when the bucket is gone. **This is the one-stop read for "how did
 * this session's turn end"**: `lastStopReason` alone cannot answer it for a
 * session that is running right now — it skips the in-flight turn and returns
 * the *previous* one's status — so a caller that asked it directly would read a
 * run in progress as already finished with its predecessor's verdict.
 *
 * `hasRunningTurn` first, then `lastStopReason`, is exactly the order
 * `selectRowStatus` uses, and for the same reason.
 */
export function lastStopReasonOf(bucket: SessionRuntime | undefined): string | null {
  if (bucket === undefined) return null;
  if (hasRunningTurn(bucket.entries)) return 'running';
  return lastStopReason(bucket.entries);
}

/**
 * Whether one of a task's own runs has a turn in flight, **as a stable
 * boolean**.
 *
 * A task's shelf row needs this to choose between its action slot's two
 * shapes — a progress bar or a Run button — and the obvious implementation
 * subscribes to `s.sessions` and loops the task's links in the component body,
 * which re-renders every row on every token of every session. A boolean
 * compares by value under zustand's identity check even though the loop behind
 * it does not, so this is the whole fix.
 *
 * `keys` is the run links to consider, not `taskId`: the caller already holds
 * them, and passing the ids keeps this from having to re-derive which link
 * belongs to which task — the same list the row is drawing.
 */
export function selectRunInFlight(s: AppStore, runKeys: string[]): boolean {
  for (const key of runKeys) {
    const bucket = s.sessions[key];
    if (bucket !== undefined && hasRunningTurn(bucket.entries)) return true;
  }
  return false;
}

/**
 * The stop reasons and last-turn durations of the **task-started** sessions,
 * as one compact string.
 *
 * **A task-started session, not every session**, because that is the whole
 * point of the key: the history is a handful of rows and this subscription has
 * to be stable while the rest of the window streams. Including every child
 * would re-render the history panel on every token of every unrelated
 * conversation.
 *
 * Both facts in one key rather than two subscriptions, because History draws
 * them in one row — a status and the elapsed time beside it — and two keys
 * would mean two chances to re-render for one visual change.
 *
 * A compact string for the same reason as `selectLiveSessionIdsKey`: a fresh
 * array or `Map` per read never compares equal under zustand's identity check,
 * so a component subscribing to one would re-render forever. Format is
 * `sessionKey\u0000status\u0000durationMs` per row, joined by `\u0001` —
 * control characters because a bridge key and a status name can both contain
 * anything except a control character.
 */
export function selectTaskRunStatusKey(s: AppStore): string {
  if (s.taskRuns.length === 0) return '';
  const parts: string[] = [];
  for (const link of s.taskRuns) {
    // A pre-handshake link has no key yet; nothing to report until it does.
    if (link.sessionKey === '') continue;
    const bucket = s.sessions[link.sessionKey];
    const stop = lastStopReasonOf(bucket) ?? '';
    const ms = bucket?.lastTurnMs;
    parts.push(`${link.sessionKey}\u0000${stop}\u0000${ms === null || ms === undefined ? '' : ms}`);
  }
  return parts.join('\u0001');
}

export function selectLiveOnlyKey(
  s: AppStore,
  workspace: string,
  remoteWorkspaceId: string | null = null,
): string {
  // What the saved list already holds, so one conversation is never two rows.
  //
  // **The list of the workspace being drawn, not of whichever child is
  // focused.** This read `activeRuntime(s)?.sessionList`, which is the same
  // mistake one layer over: a conversation that the *focused* child's copy had
  // not caught up with yet was drawn in the "open now" group, and which group it
  // landed in changed when the person clicked another row — one session shown as
  // "open now / Nothing has run in it yet" in one screenshot and as a normal
  // saved row in the next.
  const saved = new Set(
    selectSavedSessions(s, workspace, remoteWorkspaceId).items.map((row) => row.id),
  );
  const parts: string[] = [];
  for (const key of s.order) {
    const bucket = s.sessions[key];
    if (!bucket) continue;
    if (bucket.sessionId !== null && saved.has(bucket.sessionId)) continue;
    // **Scoped to the same place, machine included.** A conversation somewhere
    // else is not this list's business — and "elsewhere" has to mean "another
    // machine" as well as "another directory": a local `/srv/app` and a remote
    // `/srv/app` are two places, and comparing the paths alone drew each one's
    // open conversations into the other's "open now" group.
    if (bucket.remoteWorkspaceId !== remoteWorkspaceId) continue;
    // `bucket.workspace` is set when the child is started, so this works before
    // `init` has landed — which is exactly the moment a new session exists.
    const own = bucket.session?.workspace ?? bucket.workspace;
    if (workspace !== '' && own !== '' && !samePath(own, workspace)) continue;
    parts.push(`${key}\u0000${bucket.sessionId ?? ''}\u0000${selectRowStatus(s, key)}`);
  }
  return parts.join('\u0001');
}

/**
 * Whether the left rail's actions are inert right now.
 *
 * **The prompt part of this is asked of *visibility*, not of existence.** Every
 * panel is a Radix dialog, and Radix puts `pointer-events: none` on `body`
 * while one is open — an **inherited** property, so the rail inherits it and
 * the browser never delivers the click at all. A *drawn* prompt is the same
 * kind of overlay, so the two together are what the rail had to say inert to
 * stop lying about being clickable.
 *
 * A request **held because its session is not on screen**, by contrast, has
 * drawn nothing — no overlay, no mask, no RADIX — and the rail must stay live
 * for the opposite reason: switching to that session is now exactly how its
 * prompt is reached, and `focusSession` sends the runtime nothing a held
 * request could be disturbed by. Blocking the rail under a held request would
 * re-create the old "a button that does nothing" and strand the prompt one
 * layer deeper.
 *
 * The panel is not being made reachable through — clicking outside still
 * dismisses it, which is what a modal means, and the person's next press lands on
 * a live button. What changes is that the rail now **says** it is inert instead
 * of looking available. A control the browser has disabled and the styling has
 * not is a lie about the state of the application, and this one was expensive:
 * it reads as a broken button, so it gets pressed repeatedly.
 */
export function railBlocked(s: AppStore): boolean {
  return selectModalVisible(s) || s.panel !== null;
}

/**
 * Whether the session board's door should be usable: **some live child in the
 * workspace on screen** to answer `session_list` for it.
 *
 * **Not `hasSession`**, which is what Files and Terminal ask. Those two act on
 * the conversation you are looking at, so they key off "the session on screen is
 * ready". The board reports on the whole workspace, so it must open in the one
 * case they cannot: the session on screen is the one whose child failed to
 * start, and the others are running fine.
 *
 * A child whose own workspace is not known yet (`init` has not landed) counts as
 * live: it is in the store because this end just started it, and refusing the
 * board until the handshake arrives would be a button dead for the first second
 * of every session.
 *
 * **Exported because two doors read it.** The board is reached both from the
 * left rail's foot and from the session bar's leading edge, and a gate written
 * twice would eventually be written twice *differently* — one door open and the
 * other dead on the same screen. One question, one answer.
 */
export function selectBoardAvailable(s: AppStore): boolean {
  const current = activeWorkspaceOf(s);
  return s.order.some((key) => {
    const bucket = s.sessions[key];
    if (!bucket) return false;
    const own = bucket.session?.workspace ?? bucket.workspace;
    if (current === '' || own === '') return true;
    return samePath(own, current);
  });
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
 * How many of the **session on screen's own** requests are waiting behind the
 * one drawn.
 *
 * The queue has always held them (a second blocking request used to overwrite
 * the first, losing an id the runtime waits on forever), but until now it was
 * invisible. A count is what says "there is another one after this" instead of
 * leaving it to be discovered.
 *
 * It counts **this session's** entries and not the whole queue, because only
 * this session's can be drawn at all (`selectModalVisible`): a background
 * conversation's requests are not "behind" this prompt, they are waiting for
 * their own conversation to be on screen, and the rail's amber dot is what says
 * so. Counting them here would read as a queue nobody can advance.
 */
export function selectQueuedModals(s: AppStore): number {
  const mine = s.pendingModals.filter((entry) => entry.key === s.activeKey).length;
  return Math.max(0, mine - 1);
}

/**
 * Whether the held blocking request is **rendered**.
 *
 * `modal` says a request is being held; this says whether the person can see
 * it. Two states hold a request unrendered, and both have a named surface the
 * person is expected to reach for:
 *
 *   - **The request belongs to a session that is not on screen.** With several
 *     conversations open, a question arriving in the background used to cover
 *     the conversation the person was typing into. Now the asker's own row
 *     says what its dot always said (`selectRowStatus` → `asking`), the
 *     watcher sends the notification (it read this same visibility, so held
 *     now reads as "not watched"), and **switching to that session surfaces
 *     the prompt**. Nothing answers it and nothing drops it; the queue only
 *     loses an entry by having it answered.
 *
 *   - **The session board holds the conversation column.** The board is the
 *     one surface that already names the waiting session — its card has moved
 *     into Needs you — so a request arriving there stays unrendered instead of
 *     covering the overview with the prompt; the click on that card focuses
 *     the session, which also makes the request the visible one.
 *
 * **Held, not hidden.** The queue and the fail-closed answer path all still
 * hold; what is suppressed is only the prompt's own render. A board-held
 * request is reachable: Esc closes the board first (the chain in
 * `useGlobalKeys` asks about visibility too), and every click on the board's
 * cards closes it. A session-held request is reached by focusing that
 * session — Ctrl+1..9, its rail row, or a board card.
 *
 * The board condition is deliberately **the view, not the flag**: `boardOpen`
 * true but a terminal or a start-up problem outranking the board would hold a
 * request with nothing on screen carrying the nudge — and, alone among the
 * several surfaces, no way to surface it on the spot, because focusing the
 * session cannot change which view the terminal case draws. That is why the
 * board's hold is still the exact state where the board holds the column.
 *
 * Both conditions are evaluated against the session the request came from and
 * against what the column would draw — the same inputs `App` feeds
 * `conversationView`.
 */
export function selectModalVisible(s: AppStore): boolean {
  if (s.modal === null) return false;
  // Whose request this is decides the first hold: another session's prompt
  // waits for its own turn on the screen, however healthy the view is.
  if (s.activeKey !== s.modal.key) return false;
  const rt = s.sessions[s.activeKey ?? ''];
  const view = conversationView({
    startupProblem: s.startupProblem !== null,
    sessionProblem: rt?.problem != null,
    attachedTerminalId: rt?.activeTerminalId ?? null,
    boardOpen: s.boardOpen,
    hasSession: s.activeKey !== null,
    ready: rt?.ready ?? false,
    hasConversation: (rt?.entries ?? []).some((entry) => entry.kind !== 'note'),
  });
  return view !== 'board';
}

/**
 * Whether the question modal in the drawn slot is currently **put aside by
 * its own minimize** — the third state, on top of `selectModalVisible`.
 *
 * It asks of two things, and both have to hold: the mark is set, and the
 * marked request is still the one in the drawn slot **and still drawn**.
 * The second half is what keeps the restore pill honest — the mark is keyed
 * to a request id, and a request can leave the drawn slot by being answered,
 * by the session switching, or by the child dying. Any of those means the
 * pill would name a question nobody can see, and clicking it would restore
 * nothing.
 *
 * **`selectModalVisible` is not changed on purpose** (see the field's
 * comment): while a question is up, its own turn is mid-flight, so the
 * composer and the other surfaces stay blocked. The minimize hides the
 * overlay only — the transcript underneath is the whole point of it.
 */
export function selectQuestionMinimized(s: AppStore): boolean {
  if (s.questionMinimizedId === null) return false;
  if (s.modal === null || s.modal.kind !== 'question') return false;
  if (s.modal.batch.batch_id !== s.questionMinimizedId) return false;
  return selectModalVisible(s);
}

/** How many sessions are running a turn right now. A window-level summary. */
export function selectRunningCount(s: AppStore): number {
  return s.order.filter((key) => hasRunningTurn(s.sessions[key]?.entries ?? [])).length;
}

/**
 * Every live session's notification-relevant facts, as one compact string.
 *
 * **Subscribed to as a string, not as buckets**, and for the reason the other
 * `...Key` selectors document: zustand compares by identity, so a selector that
 * built a fresh array on every call would re-render forever without committing,
 * and subscribing to `sessions` directly would re-render on every streamed token
 * — dragging the notifier through every chunk of a long answer.
 *
 * Two things are deliberately left out of it, and both would make the string
 * change for no reason a notification cares about:
 *
 *   - the **preview**, which is `sessions.items`' text and changes as a session
 *     is written; it is read at send time instead, from the store, not from here;
 *   - the **status of a session without an id**, which cannot be reported about
 *     anyway (there is nothing to name it by) — see `selectRowStatusKey`, which
 *     makes the same exclusion for the same reason.
 *
 * The prefix is the **active key and whether a prompt is drawn**, so a change in
 * what is being watched also changes this string. Without that, focusing a
 * session — which is a local act that sends nothing — would leave the notifier
 * holding a stale idea of which session is watched, and the first transition
 * after it would be judged against the wrong one.
 */
export function selectNotifyKey(s: AppStore): string {
  const rows: NotifyRow[] = [];
  for (const key of s.order) {
    const rt = s.sessions[key];
    // A session whose handshake has not landed has no workspace to name it by
    // and no id to be reported, so it cannot produce a notification yet.
    if (!rt?.sessionId) continue;
    rows.push({
      key,
      sessionId: rt.sessionId,
      status: selectRowStatus(s, key),
      workspace: rt.session?.workspace ?? rt.workspace,
    });
  }
  const visible = selectModalVisible(s);
  return encodeNotifySnapshot({
    activeKey: s.activeKey ?? '',
    modalVisible: visible,
    modalKey: visible && s.modal !== null ? s.modal.key : '',
    rows,
  });
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
