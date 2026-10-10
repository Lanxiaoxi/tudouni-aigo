import type { Entry } from '@/state/entries';

/**
 * The transcript's **blocks**: the pure partition that turns the flow rows
 * into "one panel per model step" (`components/stream/StreamView` renders it;
 * `EntryView` draws what a panel holds).
 *
 * Why any of this exists: a step arrives as several loose one-line rows — a
 * metrics line, a thinking line, a tools line, a permission line — and drawing
 * each on its own is what made the transcript read as scatter. The redesign
 * (`desktop/tudouni-aigo-desktop-design/main-interface-redesign.html`) draws
 * each step as one card: a head that names the call and carries its figures
 * ("model call · 56s · in 67,337 · cached 66,368"), the step's tools,
 * permission records and reasoning as rows inside the card, and everything
 * that is prose — the streamed body and the final answer — outside, as body
 * text.
 *
 * ### The rule the partition follows, and the wire it assumes
 *
 * **A non-retry `model` row opens a step block; the next boundary closes it.**
 * This is safe because of where the runtime puts its numbers
 * (`internal/agent/agent.go`): a step's tool events are emitted after that
 * step's `model_call` record (`runBatch` runs between two `completeWithRetry`
 * calls), and a retry keeps the loop's counter and is a backoff row, never new
 * work. So the rows that ride inside a block are exactly that call's own work
 * — and the boundary kinds that close each block are the ones the audit
 * attributes elsewhere or that are prose by nature.
 */

/**
 * One flow row: what `StreamView` builds before this partition runs. Quiet
 * mode has already folded consecutive tool rows into its rollup group, and
 * this module treats a group as one row that rides inside whichever step is
 * open — the rollup is *the group's* brief, and it belongs where those calls
 * happened.
 */
export type StreamRow =
  | { kind: 'entry'; key: string; entry: Entry }
  | { kind: 'quiet'; key: string; entries: Entry[] };

/** One partition of the rows, as the renderer reads it. */
export type StreamBlock =
  /** A row drawn on its own, exactly as before: turn heads, user prompts, the
   *  body, answers, notes, in-stream blocks, retries, orphans. */
  | { kind: 'entry'; row: StreamRow }
  /** One model call's panel: the call's rows, pulled tight. */
  | {
      kind: 'step';
      /** Stable across renders — derived from the head row's own key. */
      key: string;
      /** The rows in arrival order, the head first. */
      rows: StreamRow[];
      /** The first settled call's figures. Null stays null: "no measurement"
       *  is a fact, and the head shows what it has. */
      metrics: StepMetrics;
      /** No row in the block has settled figures yet: the head instead says
       *  "in progress". Read off the duration — the same slackness test the
       *  old loose row drew its "in progress" with — so the two shapes cannot
       *  disagree about when a step is over. */
      running: boolean;
    };

/** The figures a settled call reports, as the audit names them. */
export interface StepMetrics {
  durationMs: number | null;
  inputTokens: number | null;
  cachedTokens: number | null;
}

const NO_METRICS: StepMetrics = { durationMs: null, inputTokens: null, cachedTokens: null };

/** Kinds drawn inside a step panel when one is open.
 *
 *  Reasoning is deliberately **not** here: the redesign draws it as its own
 *  card — a live thinking block deserves a panel of its own, with its head
 *  ("reasoning · N chars · live") where a reader glances for it, not folded
 *  into the call that produced it. `ReasonEntry` keeps drawing it, and only
 *  its shape changes. */
const STEP_KINDS: ReadonlySet<string> = new Set(['tool', 'batch', 'denied', 'perm']);

/**
 * Partition the flow rows into blocks, in arrival order.
 *
 * One pass over `rows`, one `slice` per emitted block. Runs on every change to
 * `entries` — including every chunk of every answer — so it allocates per
 * block, never per row, and the streamed path stays linear in the transcript.
 *
 * A step row with no open block is an **orphan** and drawn as its own row again:
 * a tool result the front end attached mid-turn without ever seeing its record,
 * or a reasoning block whose call record is still in flight (deltas land
 * first). Both are honest on their own line; forcing them under a head that
 * has not arrived would invent a call the audit has not confirmed.
 */
export function streamBlocks(rows: StreamRow[]): StreamBlock[] {
  const out: StreamBlock[] = [];
  // -1 = nothing open; otherwise an index into `rows` where the block began.
  let start = -1;

  const flush = (end: number) => {
    if (start < 0) return;
    const slice = rows.slice(start, end);
    const head = slice[0];
    // A call whose panel drew **no work** — the final answer step's record has
    // the answer (or the live body) directly behind it — has no panel to be:
    // a card of a bare head is a stray bar, and the record's own figures read
    // better on the loose line the transcript has always drawn for it.
    if (slice.length === 1) {
      out.push({ kind: 'entry', row: head });
      start = -1;
      return;
    }
    // First settled call wins. The scan is exhaustive rather than
    // `slice[0]`-only so it cannot be fooled by a wire revision this build has
    // not seen: a block whose record has landed shows settled figures,
    // whoever supplied them. `NO_METRICS` — no settled row at all — is the
    // "in flight" state the head renders as.
    let metrics: StepMetrics = NO_METRICS;
    for (const row of slice) {
      if (row.kind !== 'entry' || row.entry.kind !== 'model') continue;
      if (row.entry.durationMs !== null) {
        metrics = {
          durationMs: row.entry.durationMs,
          inputTokens: row.entry.inputTokens,
          cachedTokens: row.entry.cachedTokens,
        };
        break;
      }
    }
    out.push({
      kind: 'step',
      key: `step-${head.key}`,
      // The head row **is** the call record, and its facts are restated on the
      // head bar — drawing it again through the row view would repeat the
      // loose metrics line under the bar that already carries it. The block's
      // rows are its work, and the record is not work.
      rows: slice.slice(1),
      metrics,
      running: metrics.durationMs === null,
    });
    start = -1;
  };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.kind === 'quiet') {
      // A group under an open block rides inside it — the rollup is those
      // calls' brief. With none open it is an orphan and drawn as itself (a
      // result whose record never arrived draws, not disappears).
      if (start < 0) out.push({ kind: 'entry', row });
      continue;
    }
    const entry = row.entry;
    switch (entry.kind) {
      case 'model': {
        if (entry.retry !== null) {
          // A retry is the loop's backoff record, not a call: its own line,
          // exactly as before, and the block it interrupted closes there.
          flush(i);
          out.push({ kind: 'entry', row });
          continue;
        }
        // The next call closes what is open and opens its own panel. Two
        // non-retry records in a row are adjacent panels — the second's work
        // has not arrived yet, so its panel starts at the record.
        flush(i);
        start = i;
        continue;
      }
      case 'reason': {
        // Its own card, always (see `STEP_KINDS`): the thinking block is a
        // first-class panel with its own head, and it closes whatever call
        // block is open above it exactly like prose does.
        flush(i);
        out.push({ kind: 'entry', row });
        continue;
      }
      case 'turn':
      case 'user':
      case 'note':
      case 'block':
      case 'stream':
      case 'answer':
        flush(i);
        out.push({ kind: 'entry', row });
        continue;
      default:
        break;
    }
    if (STEP_KINDS.has(entry.kind) && start < 0) {
      out.push({ kind: 'entry', row });
      continue;
    }
    // A step row under an open block, and anything unknown: rides the span.
  }
  flush(rows.length);
  return out;
}
