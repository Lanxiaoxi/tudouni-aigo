/**
 * Session stream entries and their reduction.
 *
 * Covers the 12 entry types of §2 (plus quiet mode's second shape) and the
 * in-stream large-text blocks of §5.
 *
 * Four rules, each of which has a way of going wrong that is invisible on
 * screen:
 *   - Late and out-of-order messages are attributed by `run_id` + `step`, never
 *     by arrival order (§9.3).
 *   - This turn's body has two exits (`delta` while streaming, then
 *     `ui(run_finished).answer`). Only the answer is the final one (§9.2).
 *   - A denial is its own row: "did not run" and "ran and failed" are handled
 *     completely differently, so they must not share one.
 *   - The thinking block folds by default and reports its character count.
 *
 * The field names come from the real `event` payloads
 * (`internal/agent/agent.go`), not from the prototype: `tool_index` not
 * `index`, `arguments` not `params_preview`, and `tool_call` carries **no**
 * risk — that fact lives in the tool registry and is looked up.
 */

import type { DeltaChannel, RiskLevel } from '@/protocol/types';

/**
 * An event as the wire actually delivers it.
 *
 * `event` is the audit record forwarded verbatim — the runtime adds and removes
 * nothing — so the shape is loose by design. Unknown kinds and extra fields must
 * be tolerated, never rejected, so every field is read through a narrowing
 * check rather than trusted.
 */
export interface LooseEvent {
  kind: string;
  run_id: string;
  step: number;
  v?: number;
  t?: string;
  session_id?: string;
  ts?: string;
  [key: string]: unknown;
}

/* ============================================================
   Entry definitions
   ============================================================ */

export interface ToolResultState {
  /** `ok` / `invalid_args` / `error` / `denied` / `interrupted`. */
  status: string;
  chars: number;
  durationMs: number;
  exitCode: number | null;
  parallel: boolean;
  /** One flattened line from the result's head, sent by the runtime since the
   *  `preview` field was added. Null on events that predate it, on entries
   *  rebuilt from an old session, and where the runtime sent nothing — all
   *  three render as "no preview", never as an empty string pretending to be
   *  one. */
  preview: string | null;
  /** Files a `present` call declared, in the order it declared them. Absent on
   *  every other tool, and on a `present` that failed — the runtime only writes
   *  the field on a call that succeeded, so "is it here" **is** "did the
   *  declaration land". */
  deliverables?: Deliverable[];
}

/**
 * One file a `present` call declared as this turn's result.
 *
 * **A path and nothing else.** There is no size, no line count and no media type
 * here, because the tool that produces this deliberately never reads the file —
 * what travels is a reference, and every fact about the bytes is filled in by the
 * read the card makes when somebody actually opens it. A size copied in at
 * declaration time would also be a number that goes stale the moment the file is
 * edited.
 */
export interface Deliverable {
  /** Workspace-relative, and the **runtime's** spelling: it is what a
   *  `file_read` is issued against, so this window never rewrites it. */
  path: string;
  /** The model's one-line note, or `''`. The runtime omits the field rather
   *  than sending an empty string, and the card falls back to the file type —
   *  an empty string here means "no description", never "the file has no type". */
  description: string;
}

/**
 * What the registry knows about a tool. `tool_call` events carry none of it, so
 * it is looked up — and every field stays nullable, because "the registry has
 * not told us yet" is a real state that must not render as "low risk".
 */
export interface ToolFacts {
  risk: RiskLevel | null;
  parallelSafe: boolean | null;
  interactive: boolean | null;
  external: boolean | null;
}

export type ToolLookup = (name: string) => ToolFacts | null;

/** `run_finished.stop_reason`, or `running` while the turn is in flight. */
export type TurnStatus = string;

export type NoteTone = 'info' | 'warn' | 'degraded' | 'compacted' | 'image' | 'error';

/**
 * A sentence **this front end** composes, kept as a code plus its parameters.
 *
 * The store holds facts; the words live in `i18n`. That is the rule the other
 * notice types already follow (`ComposerNotice`, `StartupNotice`), and a note
 * built here broke it — `terminalExitText` assembled `Terminal term-01 exited
 * with code 0.` inside the reducer, which is English in the store and a string
 * no translation can reach.
 *
 * A note has two possible sources and they are different in kind:
 *
 *   - the **runtime's own sentence**, displayed verbatim (see `NoteEntry.text`)
 *     — the UI must never reword what the runtime said;
 *   - a sentence **this window** is saying (this type), which is ours to word.
 *
 * Keeping them apart is what stops the second from being smuggled in as the
 * first: `text` is either the runtime's or `''`, and `message` is only ever set
 * by a handler in this file.
 */
export type FrontMessage =
  /** A terminal has ended — killed, exited with a code, or exited without one. */
  | { code: 'terminalEnded'; id: string; reason: 'exited' | 'killed'; exitCode: number | null }
  /** The person went back to the conversation while the shell kept running.
   *
   *  Said **only for a running shell**, because that is the case where "it is
   *  still running" is news. Leaving an ended one needs no sentence: the row in
   *  the panel still reports how it ended. */
  | { code: 'terminalDetached'; id: string }
  /** A refine candidate was applied to its task.
   *
   *  `applied` is the number of candidates written; the sentence is this
   *  window's own report of what the front end did with the person's choice —
   *  the agent never touches the desktop's persistence (`~/.tudouni/desktop.json`),
   *  so without this line the transcript would say the person picked and
   *  nothing would ever say it landed. */
  | { code: 'refineApplied'; taskId: string; applied: number }
  /** The context was squeezed before this turn (`internal/agent/context.go`).
   *
   *  The figures are the runtime's own; `null` is "the field was absent" and
   *  must stay absent in the sentence rather than becoming a zero. `changes`
   *  says *what* was squeezed — a bare count leaves the reader unable to tell
   *  whether it was history or artifacts. */
  | {
      code: 'contextDegraded';
      items: number | null;
      estimated: number | null;
      limit: number | null;
      changes: string[];
    }
  /** Older turns were folded into a summary. Same null rule as above. */
  | {
      code: 'contextCompacted';
      folded: number | null;
      before: number | null;
      after: number | null;
    }
  /** One goal-loop decision (`internal/runtime/goal_driver.go`).
   *
   *  "Queued" and "skipped" both become a row: the driver's record says a round
   *  was *queued*, `recordGoalRound` says one actually *started*, and the two
   *  disagreeing is itself the signal. */
  | {
      code: 'goalRound';
      decision: string;
      round: number | null;
      rounds: number | null;
      maxRounds: number | null;
      reason: string;
    }
  /** One picture was attached. `width`/`height` are the runtime's measurement. */
  | { code: 'imageAttached'; name: string; width: number | null; height: number | null }
  /** One named picture could not be read or attached. `reason` is the
   *  runtime's own sentence for the file (`internal/runtime/images.go`). */
  | { code: 'imageSkipped'; path: string; reason: string }
  /** The selected model cannot be shown pictures at all. */
  | { code: 'imageRefused'; names: string[]; model: string }
  /** More pictures were named than one message may carry. */
  | { code: 'imageOverLimit'; rest: number | null; limit: number | null; paths: string[] }
  /** A task's first prompt never left this window: the handshake did not land
   *  inside the wait, so there was nowhere safe to send it. `task` is the
   *  template's title when the caller has one. */
  | { code: 'handshakeTimeout'; seconds: number; task: string | null };

/** A system line. Used as a named type by callers that hold notes outside the
 *  stream (the handshake's own notices, which outlive a `session_load`). */
export type NoteEntry = Extract<Entry, { kind: 'note' }>;

export type Entry =
  /** 1. Turn head */
  | {
      kind: 'turn';
      id: string;
      runId: string;
      /** The turn's position in the **conversation**, for the "Turn N" badge.
       *
       *  Not a runtime fact — the protocol has no turn number — and not a plain
       *  count of heads either: `session_load` rebuilds the transcript from the
       *  stored `{role, content}` message list, which has no turn boundaries, so
       *  the turns a person already had carry no head to count. `restoredTurns`
       *  (see `ReduceOptions`) supplies them, which is what keeps the badge
       *  reading "Turn 11" on the first message of a reopened 10-turn
       *  conversation instead of starting over at 1. It is also the number the
       *  turn rail's matching mark carries — the rail counts by position, so the
       *  two are the same count by construction. */
      ordinal: number;
      step: number;
      maxSteps: number;
      status: TurnStatus;
      /**
       * When this turn started, on **this window's** clock.
       *
       * It exists so the status bar can report how long a turn has been running
       * *while it runs*, which the runtime cannot supply: the only duration it
       * sends is `run_finished.duration_ms`, and that arrives after the fact.
       * The reference front end keeps the same local stamp for the same reason
       * (`internal/frontends/tui/transcript.go`, `turnData.startedAt`).
       *
       * Deliberately local rather than read off the event's `ts`: that field is
       * the audit's own local-time string with no zone offset, so parsing it
       * would be a second clock the interface has to trust.
       */
      startedAt: number;
      /**
       * How long the turn took, from `run_finished.duration_ms` — the runtime's
       * own measurement, and the only figure that may be shown as this turn's
       * final time.
       *
       * It is captured **on the head**, which is what makes it per-turn rather
       * than per-session: `SessionRuntime.lastTurnMs` holds only the newest
       * one, so a transcript full of folded turns would otherwise have every
       * head but the last reading an em dash. Null until the turn ends, and
       * null for a turn closed by the runtime going away — that turn has no
       * measurement, and `0ms` would claim it took none.
       */
      durationMs: number | null;
    }
  /** 2. User input (local echo) */
  | { kind: 'user'; id: string; text: string; atMs: number }
  /** 3. Model step */
  | {
      kind: 'model';
      id: string;
      runId: string;
      step: number;
      durationMs: number | null;
      inputTokens: number | null;
      cachedTokens: number | null;
      /** The call's own completion count — the other half of the output rate.
       *  Null when the audit reported no usage: "no measurement", never 0. */
      completionTokens: number | null;
      /** Set when this call is being retried: the audit's `backoff_ms`. */
      retry: { attempt: number; waitMs: number } | null;
    }
  /** 4. Tool call, carrying its result once there is one */
  | {
      kind: 'tool';
      id: string;
      runId: string;
      step: number;
      index: number;
      callId: string;
      tool: string;
      /** The audit's own truncation of the arguments. */
      arguments: string;
      risk: RiskLevel | null;
      parallelSafe: boolean | null;
      interactive: boolean | null;
      external: boolean | null;
      result: ToolResultState | null;
    }
  /** 6. Denial — its own row, never merged with a failure */
  | {
      kind: 'denied';
      id: string;
      runId: string;
      step: number;
      index: number;
      tool: string;
      /** The audit carries no reason text on a denial; the outcome is the fact. */
      outcome: string | null;
    }
  /** 7. Parallel batch */
  | { kind: 'batch'; id: string; runId: string; step: number; calls: number; wallMs: number }
  /** 8. Permission record */
  | {
      kind: 'perm';
      id: string;
      runId: string;
      step: number;
      tool: string;
      risk: RiskLevel | null;
      /** `allow` / `deny` — what the gate decided. */
      decision: string;
      /** `auto_allowed` / `autopilot` / `approved` / `user_denied` / … — why. */
      outcome: string;
      /** Only present when a person was actually asked. */
      waitedMs: number | null;
      rule: string | null;
      remembered: string[];
    }
  /** 9. Thinking block (folded by default) */
  | {
      kind: 'reason';
      id: string;
      runId: string;
      step: number;
      text: string;
      streaming: boolean;
    }
  /** 10. Answer block — the final body.
   *  `userBefore` is how many user rows the transcript drew above this one,
   *  counted once at creation: it is the runtime's `Fork` tiebreak for a reply
   *  the model produced more than once, and counting it per render would scan
   *  the whole transcript on every streamed chunk. */
  | { kind: 'answer'; id: string; runId: string; text: string; userBefore: number }
  /** 11. Streaming body — presentation only, not the final answer */
  | {
      kind: 'stream';
      id: string;
      runId: string;
      step: number;
      text: string;
      streaming: boolean;
    }
  /** 12. Attached / system rows */
  | {
      kind: 'note';
      id: string;
      tone: NoteTone;
      /** Machine-readable category, carried through for filtering. */
      code: string;
      /** The runtime's own sentence, displayed verbatim. `''` when this window
       *  is the one speaking — see `message`. */
      text: string;
      /** The sentence **this window** composed, as a code plus parameters. Set
       *  only by a handler in the store; never for a runtime notice, whose exact
       *  words are the runtime's. Exactly one of the two is non-empty. */
      message?: FrontMessage;
    }
  /** §5 large-text blocks: /status /tools /context /compact, plus one file
   *  opened in the workspace browser.
   *
   *  `file` is here rather than in a viewer of its own because a file read is
   *  the same shape as the other four: a large, self-contained payload that
   *  belongs in the stream in arrival order, and whose whole is drawn by a
   *  component that understands it. A second, parallel list for files would be
   *  a second transcript to keep in step with this one. */
  | { kind: 'block'; id: string; block: BlockKind; payload: unknown };

export type BlockKind = 'status' | 'tools' | 'context' | 'compact' | 'file';

/** Locate a tool call: `run_id` + `step` + `tool_index` is the triple the audit
 *  writes, so it is the triple that identifies the row. */
function sameCall(entry: Entry, runId: string, step: number, index: number): boolean {
  return (
    entry.kind === 'tool' &&
    entry.runId === runId &&
    entry.step === step &&
    entry.index === index
  );
}

/**
 * Read the declaration off a `tool_result`, or `null` when there is none.
 *
 * **The runtime is the only source for this list, and this function is where
 * that is enforced.** Two tempting shortcuts are refused here on purpose:
 *
 *   - parsing the paths back out of `arguments` — that field is the audit's own
 *     truncation, so a call with six files and long descriptions would silently
 *     lose the tail, and the card would be short a file with nothing on screen
 *     to say so;
 *   - scraping them out of `preview` — one flattened line, capped, reworded
 *     whenever the tool's result text changes.
 *
 * A malformed record produces no card rather than a broken one: a declaration is
 * an offer to open a file, and a row built from a half-read event would offer a
 * path this window cannot name. The event itself stays in the transcript — the
 * tool row draws regardless.
 */
function deliveredFiles(event: LooseEvent): Deliverable[] | null {
  const raw = event.deliverables;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const files: Deliverable[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const record = item as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path.trim() : '';
    // A path is the whole point of the record. `description` is genuinely
    // optional and the runtime omits it, so it is the one field allowed to be
    // missing — but a present-but-wrong type means this event is not the shape
    // this window understands, and guessing at it would be inventing data.
    if (path === '') return null;
    if (record.description !== undefined && typeof record.description !== 'string') return null;
    files.push({
      path,
      description: typeof record.description === 'string' ? record.description : '',
    });
  }
  return files;
}

/**
 * Where the finalized reasoning of one **recorded** call sits in the transcript.
 *
 * The wire numbers a stream and its record one apart, and the runtime states
 * that twice: deltas carry the user-facing step (`a.step + 1`, captured per call
 * in `completeWithRetry`), while the `model_call` audit record carries the
 * loop's own 0-based counter (`reportAttempt`). So the block the deltas opened —
 * the one this record's full copy must **replace**, not duplicate — sits at
 * `recordStep + 1`. Matching on the record's own number found nothing on the
 * wire, so the full copy was appended beside the streamed one: the same thinking
 * drawn twice, once live and once settled.
 *
 * The equal-step fallback exists for numbering that has not drifted apart, and
 * it only accepts a block that is still **streaming**: a settled block at the
 * equal step is the *previous* call's (already replaced, step kept), and
 * overwriting it would paste this call's thinking over the last one's — the
 * exact collision the +1 rule avoids, because a call never matches a block
 * below its own number there.
 *
 * `reason` and `stream` share the rule: both channels' deltas land on the
 * same step of the same call, and both belong to the record, not to
 * `run_finished` — the body used to wait for the latter, and its caret (drawn
 * from `streaming` in `EntryView`) kept blinking over settled text for the
 * rest of a turn that was still calling tools.
 */
function finalizedBlockIndex(
  entries: Entry[],
  kind: 'reason' | 'stream',
  runId: string,
  step: number,
): number {
  let at = entries.findIndex(
    (e) => e.kind === kind && e.runId === runId && e.step === step + 1,
  );
  if (at >= 0) return at;
  return entries.findIndex(
    (e) => e.kind === kind && e.runId === runId && e.step === step && e.streaming,
  );
}

/* ============================================================
   Identifiers
   ============================================================ */

let seq = 0;
export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/* ============================================================
   event reduction
   ============================================================ */

export interface ReduceOptions {
  activeRunId: string | null;
  /** The run that most recently finished. Needed because `ui(run_finished)` and
   *  `event(run_finished)` arrive in an unspecified order: by the time the
   *  answer lands, `activeRunId` may already be null, and the answer still
   *  belongs to this session. */
  lastRunId: string | null;
  lookup: ToolLookup;
  maxSteps: number;
  /**
   * Turns the restored transcript already held when `session_load` rebuilt it.
   *
   * The rebuilt stream is `user`/`answer` rows only — the stored message list
   * carries no turn boundary (`internal/runtime/composition.go`, `Messages()`) —
   * so there is no head whose ordinal could say "this conversation is ten turns
   * deep". Without this count the first turn opened after reopening a session was
   * numbered 1: the badge said "Turn 1" while the turn rail, which numbers marks
   * by position, said 11.
   *
   * The store reads it off the rebuilt transcript, one per `user` row — the same
   * rule `turnRail` applies to a stored turn, so the head's number and the rail's
   * mark stay the same number. Not a runtime fact, and reset by every
   * `session_load` because that is the message that replaces the stream.
   */
  restoredTurns?: number;
}

/**
 * The four figures of one **successful** model call.
 *
 * They travel as one record because they describe one call, and a mixture of two
 * is a number nothing measured: a prompt size from this step beside a duration
 * from the last would be a rate that never happened. That is why every field is
 * written on every successful call — to a value or to `null` — so a call that
 * reports no usage block *clears* the record rather than leaving the previous
 * call's figures standing. The reference front end states the same rule for the
 * same four fields (`internal/frontends/tui/model.go`, and
 * `TestASuccessfulCallMissingAFieldClearsThatHalf`).
 *
 * The names are the audit's own (`prompt_tokens`, `cached_tokens`,
 * `completion_tokens`, `duration_ms`), because that is where they come from:
 * `model_call` is the audit record forwarded verbatim.
 */
export interface CallUsage {
  /** What the provider received. `null` when this call reported no usage. */
  promptTokens: number | null;
  /** The subset a cache served — never the miss, so the two cannot be swapped. */
  cachedTokens: number | null;
  completionTokens: number | null;
  durationMs: number | null;
}

export interface ReduceResult {
  entries: Entry[];
  /** Drop the message and count it. */
  stale?: boolean;
  /** The turn ended, so the caller clears `activeRunId`. */
  runEnded?: boolean;
  /** The stop reason, when the turn ended — the status bar's phase reads it. */
  stopReason?: string;
  /** The run this turn belongs to, for `run_started`. */
  startedRunId?: string;
  /**
   * Set when this event was a successful `model_call`: the call's own figures,
   * for the status bar.
   *
   * It is here rather than read back out of `entries` because a call that
   * produced **no** row — a retry's failed attempt, or a call whose step the
   * transcript has since replaced — must not be mistaken for "no measurement".
   * The absent field and the present-but-empty one are different statements.
   */
  lastCall?: CallUsage;
}

/**
 * How many turn heads the transcript holds.
 *
 * A head is opened only by `run_started`, and `session_load` replaces the whole
 * stream before any of them can exist, so this is "turns numbered in this window
 * since the restore" — the half of the conversation's count that `restoredTurns`
 * does not supply. Counted rather than read off the last head's ordinal because
 * the ordinals already carry `restoredTurns`: `lastOrdinal + 1` would add the
 * restored turns a second time on the second turn of a reopened session.
 */
function turnHeads(entries: Entry[]): number {
  let heads = 0;
  for (const entry of entries) {
    if (entry.kind === 'turn') heads += 1;
  }
  return heads;
}

/**
 * The kinds whose `run_id` + `step` actually identify the turn they belong to.
 *
 * Everything else is session-level, and its `run_id` says nothing about which
 * turn is active: `image_attached` and `context_compacted` send `""`
 * (`internal/runtime/images.go`, `internal/agent/context.go`), `goal_round`
 * sends `""` (`internal/runtime/goal_driver.go`), and the delegation records
 * send the **child's** id, being the parent's account of having delegated
 * (`internal/subagent/spawn.go`).
 *
 * A whitelist rather than a blacklist, on purpose: for a kind this build has
 * never seen, "accept and ignore" loses nothing, while "drop" would make a
 * future protocol version's rows invisible.
 */
const TURN_SCOPED_KINDS: ReadonlySet<string> = new Set([
  'model_call',
  'tool_call',
  'tool_result',
  'permission',
  'tool_batch',
  'delta_reset',
  'run_finished',
  'context_degraded',
]);

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

export function reduceEvent(
  entries: Entry[],
  ev: LooseEvent,
  options: ReduceOptions,
): ReduceResult {
  const { activeRunId, lastRunId, lookup, maxSteps, restoredTurns = 0 } = options;

  // A delegated agent's turn boundary is not this session's.
  //
  // The runtime forwards the child's own `run_started` and `run_finished`
  // with a `child` marker (`internal/protocol/server.go` `forwardChild`),
  // because the subagents panel wants them. They used to be reduced here like
  // the parent's own: the child's `run_started` took over `activeRunId`, its
  // `run_finished` retired the turn, and from then on **every** one of the
  // parent's own turn-scoped events — model call, tool call, tool result,
  // permission, delta — was attributed to a run that no longer matched and
  // dropped as "late". The transcript went silent for the rest of the turn
  // while the `ui(state)` snapshots (which carry no such guard) kept the
  // sidebar moving: a conversation that visibly did nothing while its task
  // list kept checking boxes.
  //
  // The other child-marked kinds (`model_call`, `tool_call`, …) have no
  // rendering path here and fall into the default below; guarding at the top
  // makes that explicit instead of accidental.
  if (ev.child === true) {
    return { entries };
  }

  // `run_started` is always accepted and becomes the current turn. It carries no
  // turn number and no `max_steps`, so the number is this window's own count,
  // and the cap comes from the handshake.
  if (ev.kind === 'run_started') {
    // The head that is opening now follows every turn already in the
    // conversation — including the ones a `session_load` restored, which have
    // `user`/`answer` rows but no heads to count (see `restoredTurns`).
    const ordinal = restoredTurns + turnHeads(entries) + 1;
    return {
      entries: [
        ...entries,
        {
          kind: 'turn',
          id: nextId('turn'),
          runId: ev.run_id,
          ordinal,
          step: 0,
          maxSteps,
          status: 'running',
          startedAt: Date.now(),
          durationMs: null,
        },
      ],
      startedRunId: ev.run_id,
    };
  }

  // Late or out-of-order: anything not belonging to the current (or just
  // finished) run is dropped and counted, never drawn as a new row.
  //
  // Only for the kinds whose `run_id` identifies a turn. A session-level record
  // carries `""` or the child's id, so applying this rule to it throws away
  // every one of them from the second turn onwards — which is what used to
  // happen to the picture, compaction, goal and delegation rows.
  if (TURN_SCOPED_KINDS.has(ev.kind)) {
    if (activeRunId !== null && ev.run_id !== activeRunId) return { entries, stale: true };
    if (activeRunId === null && lastRunId !== null && ev.run_id !== lastRunId) {
      return { entries, stale: true };
    }
  }

  switch (ev.kind) {
    case 'model_call': {
      const failed = ev.status !== 'ok';
      // Every field is read on every successful call, and the record is returned
      // **only** for one: a failed attempt carries no usage block, and treating
      // its absence as a measurement would blank a real reading at every backoff.
      const lastCall: CallUsage = {
        promptTokens: typeof ev.prompt_tokens === 'number' ? ev.prompt_tokens : null,
        cachedTokens: typeof ev.cached_tokens === 'number' ? ev.cached_tokens : null,
        completionTokens: typeof ev.completion_tokens === 'number' ? ev.completion_tokens : null,
        durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : null,
      };
      const withModel: Entry[] = [
        ...entries,
        {
          kind: 'model',
          id: nextId('model'),
          runId: ev.run_id,
          step: ev.step,
          durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : null,
          inputTokens: typeof ev.prompt_tokens === 'number' ? ev.prompt_tokens : null,
          cachedTokens: typeof ev.cached_tokens === 'number' ? ev.cached_tokens : null,
          completionTokens:
            typeof ev.completion_tokens === 'number' ? ev.completion_tokens : null,
          retry:
            failed && typeof ev.backoff_ms === 'number'
              ? { attempt: 0, waitMs: ev.backoff_ms }
              : null,
        },
      ];
      const called = (result: { entries: Entry[] }): ReduceResult =>
        failed ? result : { ...result, lastCall };

      // The reply body is settled by **this record**, not by `run_finished`:
      // the call's own stream is over the moment its audit lands, and the
      // caret (drawn from `streaming` in `EntryView`) must stop with it. The
      // text stays — a non-empty final answer still supersedes it later, and
      // an empty one keeps it on screen, exactly as before.
      const settleBody = (list: Entry[]): Entry[] => {
        const at = finalizedBlockIndex(list, 'stream', ev.run_id, ev.step);
        if (at < 0) return list;
        const target = list[at];
        if (target.kind !== 'stream' || !target.streaming) return list;
        const next = list.slice();
        next[at] = { ...target, streaming: false } satisfies Entry;
        return next;
      };

      // The complete thinking text arrives here, untruncated. If a streamed
      // block already exists for this step, the full copy replaces it — that is
      // what makes folding-by-default honest.
      const reasoning = typeof ev.reasoning === 'string' ? ev.reasoning : '';
      if (reasoning === '') {
        return called(bumpStep(settleBody(withModel), ev.run_id, ev.step));
      }

      const index = finalizedBlockIndex(withModel, 'reason', ev.run_id, ev.step);
      if (index >= 0) {
        const next = withModel.slice();
        const target = next[index];
        if (target.kind === 'reason') {
          next[index] = { ...target, text: reasoning, streaming: false };
        }
        // In-place, not re-appended: the streamed block already sits **before**
        // the record row (deltas land first), and replacing it there keeps the
        // transcript in arrival order. Appending the full copy would be the
        // duplicated thinking this edit exists to remove.
        return called(bumpStep(settleBody(next), ev.run_id, ev.step));
      }

      const withReason: Entry[] = [
        ...withModel,
        {
          kind: 'reason',
          id: nextId('reason'),
          runId: ev.run_id,
          step: ev.step + 1,
          text: reasoning,
          streaming: false,
        },
      ];
      return called(bumpStep(settleBody(withReason), ev.run_id, ev.step));
    }

    case 'tool_call': {
      const toolName = typeof ev.tool === 'string' ? ev.tool : '';
      const facts = lookup(toolName);
      const index = typeof ev.tool_index === 'number' ? ev.tool_index : 0;
      const next: Entry[] = [
        ...entries,
        {
          kind: 'tool',
          id: nextId('tool'),
          runId: ev.run_id,
          step: ev.step,
          index,
          callId: typeof ev.call_id === 'string' ? ev.call_id : '',
          tool: toolName,
          arguments: typeof ev.arguments === 'string' ? ev.arguments : '',
          // No risk on the event: it is a registry fact, and the registry may not
          // have answered yet. Null renders as "unknown", not as "low".
          risk: facts?.risk ?? null,
          parallelSafe: facts?.parallelSafe ?? null,
          interactive: facts?.interactive ?? null,
          external: facts?.external ?? null,
          result: null,
        },
      ];
      return bumpStep(next, ev.run_id, ev.step);
    }

    case 'tool_result': {
      const index = typeof ev.tool_index === 'number' ? ev.tool_index : 0;
      const status = typeof ev.status === 'string' ? ev.status : 'error';
      const result: ToolResultState = {
        status,
        chars: typeof ev.chars === 'number' ? ev.chars : 0,
        durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : 0,
        exitCode: typeof ev.exit_code === 'number' ? ev.exit_code : null,
        parallel: ev.parallel === true,
        preview: typeof ev.preview === 'string' && ev.preview !== '' ? ev.preview : null,
      };
      // The declaration rides on the result rather than becoming an entry of its
      // own. A second entry kind would have to be threaded through the block
      // partition, quiet mode and the row switches to say one thing — "these
      // files were the result" — and it would arrive *beside* the call that made
      // it, which is where a reader is already looking.
      const deliverables = status === 'ok' ? deliveredFiles(ev) : null;
      if (deliverables !== null) result.deliverables = deliverables;

      let attached = false;
      const patched = entries.map((entry) => {
        if (!attached && sameCall(entry, ev.run_id, ev.step, index)) {
          attached = true;
          return { ...(entry as Extract<Entry, { kind: 'tool' }>), result } satisfies Entry;
        }
        return entry;
      });

      // A denial is its own row. It still attaches to the call so the call row
      // can show that nothing ran, and then a separate line says so plainly.
      if (status === 'denied') {
        const withDenial: Entry[] = [
          ...patched,
          {
            kind: 'denied',
            id: nextId('denied'),
            runId: ev.run_id,
            step: ev.step,
            index,
            tool: typeof ev.tool === 'string' ? ev.tool : '',
            outcome: null,
          },
        ];
        return bumpStep(withDenial, ev.run_id, ev.step);
      }

      if (attached) {
        return bumpStep(patched, ev.run_id, ev.step);
      }

      // No matching call: the front end attached mid-turn, or the call row was
      // never seen. A result-only row is still better than losing the fact.
      const facts = lookup(typeof ev.tool === 'string' ? ev.tool : '');
      const orphan: Entry[] = [
        ...patched,
        {
          kind: 'tool',
          id: nextId('tool'),
          runId: ev.run_id,
          step: ev.step,
          index,
          callId: typeof ev.call_id === 'string' ? ev.call_id : '',
          tool: typeof ev.tool === 'string' ? ev.tool : '',
          arguments: '',
          risk: facts?.risk ?? null,
          parallelSafe: facts?.parallelSafe ?? null,
          interactive: facts?.interactive ?? null,
          external: facts?.external ?? null,
          result,
        },
      ];
      return bumpStep(orphan, ev.run_id, ev.step);
    }

    case 'permission': {
      const next: Entry[] = [
        ...entries,
        {
          kind: 'perm',
          id: nextId('perm'),
          runId: ev.run_id,
          step: ev.step,
          tool: typeof ev.tool === 'string' ? ev.tool : '',
          risk: typeof ev.risk === 'string' ? (ev.risk as RiskLevel) : null,
          decision: typeof ev.decision === 'string' ? ev.decision : '',
          outcome: typeof ev.outcome === 'string' ? ev.outcome : '',
          // `waited_ms` is present only when a person was actually asked. A
          // verdict is written for every call, so its absence is the signal.
          waitedMs: typeof ev.waited_ms === 'number' ? ev.waited_ms : null,
          rule: typeof ev.rule === 'string' && ev.rule !== '' ? ev.rule : null,
          remembered: Array.isArray(ev.remembered)
            ? ev.remembered.filter((x): x is string => typeof x === 'string')
            : [],
        },
      ];
      return bumpStep(next, ev.run_id, ev.step);
    }

    case 'tool_batch': {
      const next: Entry[] = [
        ...entries,
        {
          kind: 'batch',
          id: nextId('batch'),
          runId: ev.run_id,
          step: ev.step,
          calls: typeof ev.calls === 'number' ? ev.calls : 0,
          wallMs: typeof ev.wall_ms === 'number' ? ev.wall_ms : 0,
        },
      ];
      return bumpStep(next, ev.run_id, ev.step);
    }

    case 'run_finished': {
      const stopReason = typeof ev.stop_reason === 'string' ? ev.stop_reason : '';
      // The turn's own wall time rides this record and nowhere else: the head
      // keeps it, so a folded turn can state its final time long after the run
      // that produced it is gone (`SessionRuntime.lastTurnMs` holds only the
      // newest). Read as "present or absent", never defaulted — a
      // `run_finished` written without one is a turn nobody measured.
      const durationMs = typeof ev.duration_ms === 'number' ? ev.duration_ms : null;
      const patched = entries.map((entry) => {
        if (entry.kind === 'turn' && entry.runId === ev.run_id) {
          return { ...entry, status: stopReason, step: ev.step, durationMs } satisfies Entry;
        }
        // The turn is over, so every streaming caret stops.
        if ((entry.kind === 'stream' || entry.kind === 'reason') && entry.runId === ev.run_id) {
          return { ...entry, streaming: false } satisfies Entry;
        }
        return entry;
      });
      return { entries: patched, runEnded: true, stopReason };
    }

    case 'delta_reset': {
      // **Both channels**, the same as the top-level `delta_reset` message.
      // The record carries no channel and voids whatever was drawn for the
      // step, so clearing only `text` left a stale reasoning block behind —
      // the two paths disagreed on what "the same message" means.
      return {
        entries: clearStream(
          clearStream(entries, ev.run_id, ev.step, 'text'),
          ev.run_id,
          ev.step,
          'reasoning',
        ),
      };
    }

    case 'context_degraded': {
      // The runtime sends more than a count: `items`, `estimated`, `limit` and
      // `changes` (`internal/agent/context.go`). `changes` is the one that says
      // *what* was squeezed — a bare count leaves the reader unable to tell
      // whether it was history or artifacts.
      const items = typeof ev.items === 'number' ? ev.items : null;
      const estimated = typeof ev.estimated === 'number' ? ev.estimated : null;
      const limit = typeof ev.limit === 'number' ? ev.limit : null;
      return {
        entries: [
          ...entries,
          {
            kind: 'note',
            id: nextId('note'),
            tone: 'degraded',
            code: 'context_degraded',
            text: '',
            message: {
              code: 'contextDegraded',
              items,
              estimated,
              limit,
              changes: stringList(ev.changes),
            },
          },
        ],
      };
    }

    case 'context_compacted': {
      const folded = typeof ev.folded === 'number' ? ev.folded : null;
      const before = typeof ev.before === 'number' ? ev.before : null;
      const after = typeof ev.after === 'number' ? ev.after : null;
      return {
        entries: [
          ...entries,
          {
            kind: 'note',
            id: nextId('note'),
            tone: 'compacted',
            code: 'context_compacted',
            text: '',
            message: { code: 'contextCompacted', folded, before, after },
          },
        ],
      };
    }

    case 'image_attached': {
      return { entries: [...entries, imageNote(ev)] };
    }

    case 'goal_round': {
      // The driver's record says a round was *queued*; `recordGoalRound` says one
      // actually *started*. The two disagreeing is itself the signal — so both
      // decisions become a row rather than being collapsed into one "a round ran".
      //
      // Session-level: `run_id` is `""` here, which is why this kind had to be
      // exempted from the turn guard above before its rows could appear at all.
      const decision = typeof ev.decision === 'string' ? ev.decision : '';
      const reason = typeof ev.reason === 'string' ? ev.reason : '';
      const round = typeof ev.round === 'number' ? ev.round : null;
      const rounds = typeof ev.goal_rounds === 'number' ? ev.goal_rounds : null;
      const maxRounds = typeof ev.goal_max_rounds === 'number' ? ev.goal_max_rounds : null;

      return {
        entries: [
          ...entries,
          {
            kind: 'note',
            id: nextId('note'),
            // "Queued" is information; "skipped" is why the loop stopped, which
            // a reader needs to see rather than infer from the goal block.
            tone: decision === 'started' ? 'info' : 'degraded',
            code: 'goal_round',
            text: '',
            message: { code: 'goalRound', decision, round, rounds, maxRounds, reason },
          },
        ],
      };
    }

    // The four delegation records draw **no row here**, and that is deliberate.
    //
    // Each one's sentence is written by the runtime and arrives as a `notice`: the
    // start (`notice.subagent.started`, carrying the resolved route and the depth),
    // the end (`notice.delegation.finished`, carrying how it ended and where the
    // answer went) and a child session that could not be saved
    // (`notice.subagent.save_failed`). Composing a second sentence here from the
    // same record put **three** rows in the transcript for one dispatch — two of
    // them restatements, and both nameless, because the field they read for a name
    // (`child_id`) is written by nothing in the runtime: these records carry
    // `subagent_id`, and the label a person recognises only reached them later.
    //
    // A notice is one row, worded in one place, and reaches every front end the
    // same way, which is also why the TUI never had the duplicate rows.
    // `delegation_started` belongs on this list even though no notice covers it: it
    // fires microseconds after `subagent_started` with less to say, and its real job
    // is the `ui(state)` snapshot the runtime sends with it.
    case 'subagent_started':
    case 'subagent_problem':
    case 'delegation_started':
    case 'delegation_finished':
      return { entries };

    default:
      // An unknown kind is ignored. Both ends upgrade independently, and the
      // rule is "ignore what you do not know, keep going".
      return { entries };
  }
}

/** Keep the turn head's step in step with the events arriving for it. */
function bumpStep(after: Entry[], runId: string, step: number): { entries: Entry[] } {
  if (step <= 0) return { entries: after };
  let changed = false;
  const next = after.map((entry) => {
    if (entry.kind === 'turn' && entry.runId === runId && entry.step < step) {
      changed = true;
      return { ...entry, step } satisfies Entry;
    }
    return entry;
  });
  return { entries: changed ? next : after };
}

/**
 * One `image_attached` event, in its four shapes.
 *
 * The four outcomes are discriminated by `status` (`internal/runtime/images.go`),
 * and each carries a **different set of keys** — reading the wrong ones is how
 * the refusal row used to render as " was not attached" with no name and no
 * reason:
 *
 *   - `attached`   → `name`, `path`, `width`, `height`
 *   - `skipped`    → `path`, `reason` (a sentence the runtime wrote for the file)
 *   - `over_limit` → `limit`, `rest`, `paths[]`
 *   - `refused`    → `names[]`, `model` — **no `path`, no `reason`**
 *
 * The refusal's human-readable sentence is written to stderr by
 * `reportImagesRefused`, and stderr is deliberately not protocol content. The
 * front end therefore words that row from the facts that *are* on the event —
 * but as a `FrontMessage`, not as a sentence assembled in the store: these four
 * rows are this window speaking, and `text` stays `''`.
 */
function imageNote(ev: LooseEvent): Entry {
  const status = typeof ev.status === 'string' ? ev.status : '';
  const path = typeof ev.path === 'string' ? ev.path : '';

  if (status === 'over_limit') {
    // The runtime names the pictures that did not fit on purpose: "4 of 9
    // attached" leaves the reader to work out which four. A missing figure is
    // null, never 0 — the sentence then omits it.
    const rest = typeof ev.rest === 'number' ? ev.rest : null;
    const limit = typeof ev.limit === 'number' ? ev.limit : null;
    return {
      kind: 'note',
      id: nextId('note'),
      tone: 'error',
      code: 'image_over_limit',
      text: '',
      message: { code: 'imageOverLimit', rest, limit, paths: stringList(ev.paths) },
    };
  }

  if (status === 'refused') {
    // Said as a fact about the **model**, not the files: nothing is wrong with
    // the picture, and the fix is a different model.
    return {
      kind: 'note',
      id: nextId('note'),
      tone: 'error',
      code: 'image_refused',
      text: '',
      message: {
        code: 'imageRefused',
        names: stringList(ev.names),
        model: typeof ev.model === 'string' ? ev.model : '',
      },
    };
  }

  if (status === 'skipped') {
    return {
      kind: 'note',
      id: nextId('note'),
      tone: 'error',
      code: 'image_skipped',
      text: '',
      message: {
        code: 'imageSkipped',
        path,
        reason: typeof ev.reason === 'string' ? ev.reason : '',
      },
    };
  }

  return {
    kind: 'note',
    id: nextId('note'),
    tone: 'image',
    code: 'image_attached',
    text: '',
    message: {
      code: 'imageAttached',
      name: typeof ev.name === 'string' && ev.name !== '' ? ev.name : path,
      width: typeof ev.width === 'number' ? ev.width : null,
      height: typeof ev.height === 'number' ? ev.height : null,
    },
  };
}

/* ============================================================
   delta reduction (presentation layer)
   ============================================================ */

export function applyDelta(
  entries: Entry[],
  runId: string,
  step: number,
  channel: DeltaChannel,
  text: string,
  activeRunId: string | null,
  lastRunId: string | null,
): { entries: Entry[]; stale?: boolean } {
  if (activeRunId !== null && runId !== activeRunId) return { entries, stale: true };
  if (activeRunId === null && lastRunId !== null && runId !== lastRunId) {
    return { entries, stale: true };
  }

  // Routed by the field, never guessed: both channels carry strings, and
  // crossing them puts a stretch of the model thinking out loud into the answer.
  const wantKind: Entry['kind'] = channel === 'reasoning' ? 'reason' : 'stream';

  const index = entries.findIndex(
    (e) => e.kind === wantKind && e.runId === runId && e.step === step,
  );

  if (index >= 0) {
    const next = entries.slice();
    const target = next[index];
    if (target.kind === 'reason') {
      next[index] = { ...target, text: target.text + text, streaming: true };
    } else if (target.kind === 'stream') {
      next[index] = { ...target, text: target.text + text, streaming: true };
    }
    return { entries: next };
  }

  const fresh: Entry =
    channel === 'reasoning'
      ? { kind: 'reason', id: nextId('reason'), runId, step, text, streaming: true }
      : { kind: 'stream', id: nextId('stream'), runId, step, text, streaming: true };

  return { entries: [...entries, fresh] };
}

/** Drop one step's streamed text so it can be redrawn. Earlier steps are left
 *  alone: content a retry did not touch must not be erased by it. */
export function clearStream(
  entries: Entry[],
  runId: string,
  step: number,
  channel: DeltaChannel,
): Entry[] {
  const wantKind: Entry['kind'] = channel === 'reasoning' ? 'reason' : 'stream';
  return entries.filter(
    (e) => !(e.kind === wantKind && e.runId === runId && e.step === step),
  );
}

/* ============================================================
   ui reduction
   ============================================================ */

/**
 * `ui(run_finished).answer` is this turn's only final exit.
 *
 * When it arrives with text, the run's streamed rows are removed so the same
 * body is not rendered twice. Any streamed thinking is kept as a folded block —
 * the full copy has usually already replaced it via `model_call.reasoning`.
 *
 * **When it arrives empty, the streamed rows stay.** An empty answer is not
 * "there was no answer": every abnormal exit produces one — Esc, the step limit,
 * a model error, an empty response — and the runtime forwards the empty string
 * unchanged (`internal/agent/agent.go` returns `"", RunCancelled{}` /
 * `"", &StepLimitExceeded{}` / …). Deleting the rows there erased half a written
 * answer off the screen at exactly the moment the reader wanted to keep it. They
 * are settled instead: the caret stops, the text remains, and the *event* side
 * names the reason.
 *
 * The turn head is also closed here **if it is still open**. The two
 * `run_finished` messages are not ordered, and this one carries no stop reason —
 * so it only ever fills in a generic ending, and `event(run_finished)` overwrites
 * it with the real reason whenever it lands. Without this, a lost event would
 * leave the status bar reading "Running" over a finished answer, which is a
 * visible lie rather than a missing detail.
 */
export function applyFinalAnswer(entries: Entry[], runId: string, answer: string): Entry[] {
  const hasAnswer = answer !== '';
  // Only a non-empty answer supersedes what was streamed.
  const cleaned = hasAnswer
    ? entries.filter((e) => !(e.kind === 'stream' && e.runId === runId))
    : entries;
  const settled = cleaned.map((entry) => {
    if ((entry.kind === 'stream' || entry.kind === 'reason') && entry.runId === runId && entry.streaming) {
      return { ...entry, streaming: false } satisfies Entry;
    }
    if (entry.kind === 'turn' && entry.runId === runId && entry.status === 'running') {
      return { ...entry, status: 'answered' } satisfies Entry;
    }
    return entry;
  });
  if (!hasAnswer) return settled;
  // The user rows above this reply, in the transcript as drawn: the fork's
  // tiebreak. `cleaned` already excludes this run's streamed body, and a
  // `user` row is a prompt by construction, so the count is the row list.
  const userBefore = settled.reduce((n, e) => (e.kind === 'user' ? n + 1 : n), 0);
  return [
    ...settled,
    { kind: 'answer', id: nextId('answer'), runId, text: answer, userBefore },
  ];
}

/**
 * Close the turn that was in flight when the runtime went away.
 *
 * The child is gone, so nothing else will ever close it: no `run_finished`
 * event and no `ui(run_finished)`. Left alone the turn head stays `running`,
 * which makes `hasRunningTurn` true forever — the phase reads "Running", the
 * composer sits behind its Stop button, and Enter and Esc both do nothing.
 *
 * The rows keep their text. Only the caret stops and the head is settled, and
 * the reason is the runtime's disappearance rather than a stop reason it never
 * got to send.
 */
export function settleAbandonedTurn(entries: Entry[]): Entry[] {
  return entries.map((entry) => {
    if ((entry.kind === 'stream' || entry.kind === 'reason') && entry.streaming) {
      return { ...entry, streaming: false } satisfies Entry;
    }
    if (entry.kind === 'turn' && entry.status === 'running') {
      return { ...entry, status: 'runtime_exited' } satisfies Entry;
    }
    return entry;
  });
}

/** Keep only the newest block of each kind, so a repeated `/status` does not
 *  pile up rows. */
export function pushBlock(entries: Entry[], block: BlockKind, payload: unknown): Entry[] {
  const filtered = entries.filter((e) => !(e.kind === 'block' && e.block === block));
  return [...filtered, { kind: 'block', id: nextId('block'), block, payload }];
}

/**
 * Append a block **without** removing the earlier ones of its kind.
 *
 * `pushBlock` replaces, which is right for `/status`, `/tools`, `/context` and
 * `/compact`: each answers "what is the state now", so two of them on screen
 * would be one stale copy contradicting a fresh one.
 *
 * A file is not that shape. "I read A, now I want to read B" is two readings,
 * not a newer state of the same thing — and replacing meant opening the second
 * file **silently deleted the first one** and moved the survivor to the end of
 * the stream. So the one block kind whose answers are a sequence rather than a
 * state gets its own function, and the difference is stated here rather than
 * left to whoever notices a file disappearing.
 */
export function appendBlock(entries: Entry[], block: BlockKind, payload: unknown): Entry[] {
  return [...entries, { kind: 'block', id: nextId('block'), block, payload }];
}

/**
 * Character count for the folded thinking block.
 *
 * **Code points, not code units, and not `Array.from`.** `Array.from(text)`
 * materialises an array of every code point, which is the whole text allocated
 * again — and this is called from the reasoning block's head, so it ran on
 * every render of a block that grows a chunk at a time while it streams. Over
 * a block that arrives in n deltas that is O(n²) of pure allocation, with n
 * up to the length of the model's thinking. The walk below counts the same
 * thing in place: a surrogate pair advances the index twice and counts once, so
 * an emoji is one character exactly as `Array.from` said it was.
 *
 * Same answer, verified against `Array.from(...).length` on lone surrogates,
 * ZWJ sequences, flags, keycaps and astral text, not assumed: a counter that
 * disagrees here would change the number in a row a reader is watching.
 */
export function charCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // A high surrogate followed by a low one is one character; a lone one is no
    // longer a character than any other single unit, which is what `Array.from`
    // does with it too.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

/* ============================================================
   Derived display state
   ============================================================ */

/** The stop reason of the most recently finished turn, or null. */
export function lastStopReason(entries: Entry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.kind === 'turn' && entry.status !== 'running') return entry.status;
  }
  return null;
}

/** True while a turn is in flight. */
export function hasRunningTurn(entries: Entry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.kind === 'turn') return entry.status === 'running';
  }
  return false;
}

/** The most recent turn head, or null before the first one.
 *
 *  The last head is **the turn above** the one about to open, which is the turn a
 *  new one takes its fold state from — see `newTurnStartsFolded`. */
export function lastTurnHead(entries: Entry[]): Extract<Entry, { kind: 'turn' }> | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.kind === 'turn') return entry;
  }
  return null;
}

/**
 * Does a turn that is opening now start folded?
 *
 * **It starts the way the turn above it is** — folded if that one is folded, open
 * if it is open. This is a reading shape rather than a fact, and inheriting it is
 * the whole point of the fold: a person who folds the work away to read a
 * transcript like a chat should not have to fold every new turn by hand for the
 * rest of the session. The other direction matters just as much — whoever has
 * *opened* the turn above is reading its work, so the next one keeps its work on
 * screen.
 *
 * `before` is the transcript **as it stood before the new head was appended**, so
 * its last head is the turn above. `fold` is the window's own `turnFolded` map: a
 * head with no entry has never been toggled, which is "open".
 */
export function newTurnStartsFolded(
  before: Entry[],
  fold: Readonly<Record<string, boolean>>,
): boolean {
  const above = lastTurnHead(before);
  return above !== null && fold[above.id] === true;
}
