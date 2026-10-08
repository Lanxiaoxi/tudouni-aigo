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
  | { code: 'terminalDetached'; id: string };

/** A system line. Used as a named type by callers that hold notes outside the
 *  stream (the handshake's own notices, which outlive a `session_load`). */
export type NoteEntry = Extract<Entry, { kind: 'note' }>;

export type Entry =
  /** 1. Turn head */
  | {
      kind: 'turn';
      id: string;
      runId: string;
      /** A local ordinal over turns received — a display index, not a runtime
       *  fact (the protocol has no turn number). */
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
  /** 10. Answer block — the final body */
  | { kind: 'answer'; id: string; runId: string; text: string }
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

function lastTurnOrdinal(entries: Entry[]): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.kind === 'turn') return entry.ordinal;
  }
  return 0;
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
  const { activeRunId, lastRunId, lookup, maxSteps } = options;

  // `run_started` is always accepted and becomes the current turn. It carries no
  // turn number and no `max_steps`, so the ordinal is local and the cap comes
  // from the handshake.
  if (ev.kind === 'run_started') {
    return {
      entries: [
        ...entries,
        {
          kind: 'turn',
          id: nextId('turn'),
          runId: ev.run_id,
          ordinal: lastTurnOrdinal(entries) + 1,
          step: 0,
          maxSteps,
          status: 'running',
          startedAt: Date.now(),
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
          retry:
            failed && typeof ev.backoff_ms === 'number'
              ? { attempt: 0, waitMs: ev.backoff_ms }
              : null,
        },
      ];
      const called = (result: { entries: Entry[] }): ReduceResult =>
        failed ? result : { ...result, lastCall };

      // The complete thinking text arrives here, untruncated. If a streamed
      // block already exists for this step, the full copy replaces it — that is
      // what makes folding-by-default honest.
      const reasoning = typeof ev.reasoning === 'string' ? ev.reasoning : '';
      if (reasoning === '') {
        return called(bumpStep(withModel, ev.run_id, ev.step));
      }

      const index = withModel.findIndex(
        (e) => e.kind === 'reason' && e.runId === ev.run_id && e.step === ev.step,
      );
      if (index >= 0) {
        const next = withModel.slice();
        const target = next[index];
        if (target.kind === 'reason') {
          next[index] = { ...target, text: reasoning, streaming: false };
        }
        return called(bumpStep(next, ev.run_id, ev.step));
      }

      const withReason: Entry[] = [
        ...withModel,
        {
          kind: 'reason',
          id: nextId('reason'),
          runId: ev.run_id,
          step: ev.step,
          text: reasoning,
          streaming: false,
        },
      ];
      return called(bumpStep(withReason, ev.run_id, ev.step));
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
      const patched = entries.map((entry) => {
        if (entry.kind === 'turn' && entry.runId === ev.run_id) {
          return { ...entry, status: stopReason, step: ev.step } satisfies Entry;
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
      const changes = stringList(ev.changes);
      const detail = [
        items !== null ? `${items} items` : '',
        estimated !== null && limit !== null ? `${estimated} → ${limit} tok` : '',
        changes.length > 0 ? changes.join(', ') : '',
      ]
        .filter((part) => part !== '')
        .join(' · ');
      return {
        entries: [
          ...entries,
          {
            kind: 'note',
            id: nextId('note'),
            tone: 'degraded',
            code: 'context_degraded',
            text: detail === '' ? 'context degraded' : `context degraded (${detail})`,
          },
        ],
      };
    }

    case 'context_compacted': {
      const folded = typeof ev.folded === 'number' ? ev.folded : 0;
      const before = typeof ev.before === 'number' ? ev.before : null;
      const after = typeof ev.after === 'number' ? ev.after : null;
      const detail = [
        `${folded} folded`,
        before !== null && after !== null ? `${before} → ${after} tok` : '',
      ]
        .filter((part) => part !== '')
        .join(' · ');
      return {
        entries: [
          ...entries,
          {
            kind: 'note',
            id: nextId('note'),
            tone: 'compacted',
            code: 'context_compacted',
            text: `history compacted (${detail})`,
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

      const detail = [
        decision === '' ? 'goal round' : `goal round ${decision}`,
        round !== null ? `#${round}` : '',
        rounds !== null && maxRounds !== null ? `${rounds}/${maxRounds}` : '',
        reason !== '' ? reason : '',
      ]
        .filter((part) => part !== '')
        .join(' · ');

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
            text: detail,
          },
        ],
      };
    }

    case 'subagent_started':
    case 'subagent_problem':
    case 'delegation_started':
    case 'delegation_finished': {
      // The runtime's own account of a delegation. These are *reported* rather
      // than inferred from the subagent block, which only ever shows the ones in
      // flight — a delegation that started and finished between two snapshots
      // left no trace at all.
      // `delegation_*` names the child as `child_id`; the subagent's own records
      // use `id`. Both are read so one row shape covers all four kinds.
      const id =
        typeof ev.child_id === 'string'
          ? ev.child_id
          : typeof ev.id === 'string'
            ? ev.id
            : '';
      const problem = typeof ev.problem === 'string' ? ev.problem : '';
      const label = typeof ev.label === 'string' && ev.label !== '' ? ev.label : id;
      const what: Record<string, string> = {
        subagent_started: `subagent started${label ? `: ${label}` : ''}`,
        subagent_problem: `subagent problem${label ? ` (${label})` : ''}${problem ? `: ${problem}` : ''}`,
        delegation_started: `delegation started${label ? `: ${label}` : ''}`,
        delegation_finished: `delegation finished${label ? `: ${label}` : ''}`,
      };
      return {
        entries: [
          ...entries,
          {
            kind: 'note',
            id: nextId('note'),
            tone: ev.kind === 'subagent_problem' ? 'error' : 'info',
            code: ev.kind,
            text: what[ev.kind] ?? ev.kind,
          },
        ],
      };
    }

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
 * `reportImagesRefused`, and stderr is deliberately not protocol content, so the
 * front end composes that one from the facts that *are* on the event.
 */
function imageNote(ev: LooseEvent): Entry {
  const status = typeof ev.status === 'string' ? ev.status : '';
  const path = typeof ev.path === 'string' ? ev.path : '';

  if (status === 'over_limit') {
    const rest = typeof ev.rest === 'number' ? ev.rest : 0;
    const limit = typeof ev.limit === 'number' ? ev.limit : 0;
    // The runtime names the pictures that did not fit on purpose: "4 of 9
    // attached" leaves the reader to work out which four.
    const paths = stringList(ev.paths);
    const detail = paths.length > 0 ? `: ${paths.join(', ')}` : '';
    return {
      kind: 'note',
      id: nextId('note'),
      tone: 'error',
      code: 'image_over_limit',
      text: `${rest} more picture(s) did not fit (limit ${limit} per message)${detail}`,
    };
  }

  if (status === 'refused') {
    // Said as a fact about the **model**, not the files: nothing is wrong with
    // the picture, and the fix is a different model.
    const names = stringList(ev.names);
    const model = typeof ev.model === 'string' && ev.model !== '' ? ev.model : '';
    const who = model === '' ? 'the model in use' : `the model in use (${model})`;
    const detail = names.length > 0 ? `: ${names.join(', ')}` : '';
    return {
      kind: 'note',
      id: nextId('note'),
      tone: 'error',
      code: 'image_refused',
      text: `${who} cannot be shown pictures, so ${names.length} named picture(s) were not attached${detail}`,
    };
  }

  if (status === 'skipped') {
    const reason = typeof ev.reason === 'string' ? ev.reason : '';
    return {
      kind: 'note',
      id: nextId('note'),
      tone: 'error',
      code: 'image_skipped',
      text: reason === '' ? `${path} was not attached` : `${path} was not attached: ${reason}`,
    };
  }

  const name = typeof ev.name === 'string' && ev.name !== '' ? ev.name : path;
  const width = typeof ev.width === 'number' ? ev.width : null;
  const height = typeof ev.height === 'number' ? ev.height : null;
  const size = width !== null && height !== null ? ` (${width}×${height})` : '';
  return {
    kind: 'note',
    id: nextId('note'),
    tone: 'image',
    code: 'image_attached',
    text: `attached ${name}${size}`,
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
  return [...settled, { kind: 'answer', id: nextId('answer'), runId, text: answer }];
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
