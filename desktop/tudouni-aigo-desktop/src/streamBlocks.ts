import type { Deliverable, Entry } from '@/state/entries';

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
  /** The call's own completion count: with `durationMs` it is the output rate
   *  the head bar draws. Null when the audit reported no usage. */
  completionTokens: number | null;
}

const NO_METRICS: StepMetrics = {
  durationMs: null,
  inputTokens: null,
  cachedTokens: null,
  completionTokens: null,
};

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
          completionTokens: row.entry.completionTokens,
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

/** The key a block is drawn with — its own, or the loose row's. Both are stable
 *  across renders, which is what keeps a step card from replaying its entrance
 *  animation on every chunk. */
export function blockKey(block: StreamBlock): string {
  return block.kind === 'step' ? block.key : block.row.key;
}

/* ============================================================
   Turn sections — a turn head and the body it folds
   ============================================================ */

/**
 * What a folded turn says it is doing, in one word.
 *
 * Only the four phases a reader can see happen, and each one is **observed**
 * rather than inferred: `thinking` while reasoning deltas are live, `tool`
 * while a call has no result yet, `reply` while body text is arriving. `model`
 * is the remaining one — the call itself — and it is also the fallback, because
 * a turn that has shown nothing else is on its first call. Nothing else the
 * loop does can produce a row before that call's record arrives.
 */
export type TurnPhase = 'thinking' | 'model' | 'tool' | 'reply';

/** A turn head together with every block drawn under it. */
export interface TurnSection {
  kind: 'turn';
  /** Stable across renders — the head row's own key. */
  key: string;
  /** The head, always an `entry` row: `streamBlocks` draws a `step` block's head
   *  itself and this partition must not be fooled by a model record. */
  head: Extract<StreamRow, { kind: 'entry' }>;
  /** Everything from the head to the next head, in arrival order. Empty for a
   *  turn that has not drawn anything yet. */
  body: StreamBlock[];
  /** The same blocks, split into **what the turn did** and **what it said** —
   *  the shape a folded turn is drawn in. See `turnRuns`. */
  runs: TurnRun[];
  /** Files a `present` call declared in this turn. Results, not process: they
   *  stay on screen when the turn is folded, which is what `present` exists for
   *  (see `EntryView`'s note on the one result drawn outside its own fold). */
  deliverables: Deliverable[];
  /** The phase the head states while the turn runs; see `TurnPhase`. */
  phase: TurnPhase;
}

/** One stretch of a turn's body that is drawn either folded or plainly.
 *
 *  `process` is the work — the thinking, the model call cards, the tools, the
 *  notes — and it is what a folded turn folds. `reply` is the turn's own words,
 *  and it is never folded: a folded turn is the transcript with the middle taken
 *  out, not with the answer taken out.
 *
 *  The body is split into **runs rather than two piles** so that the arrival
 *  order survives: a `/status` block or a "history compacted" note appended after
 *  the answer stays *below* the answer instead of being hoisted above it by the
 *  fold. */
export interface TurnRun {
  kind: 'process' | 'reply';
  blocks: StreamBlock[];
}

/** Shared so a turn with no declarations allocates nothing per pass. */
const NO_DELIVERABLES: Deliverable[] = [];

/**
 * One horizontal slice of the transcript: rows that belong to no turn, and turns.
 *
 * The leading slice is the loose one — a restored session's `user`/`answer`
 * rows, the handshake's notices, `/status` blocks, and a prompt whose
 * `run_started` has not landed yet all sit above the first head.
 */
export type StreamSection =
  | { kind: 'loose'; key: string; blocks: StreamBlock[] }
  | TurnSection;

/** The entries one block draws, in the order it draws them. */
function blockEntries(block: StreamBlock): Entry[] {
  if (block.kind === 'step') {
    const out: Entry[] = [];
    for (const row of block.rows) {
      if (row.kind === 'entry') out.push(row.entry);
      else out.push(...row.entries);
    }
    return out;
  }
  return block.row.kind === 'entry' ? [block.row.entry] : block.row.entries;
}

/**
 * The phase of one turn, from the blocks drawn under its head.
 *
 * A walk forwards, so the **last** live signal wins: a turn streams thinking,
 * then calls a tool, then streams its answer, and at each moment the head should
 * name the thing that is happening now rather than the thing that started it.
 *
 * Two shapes are deliberately not signals:
 *
 *   - a `step` block whose call has settled — the call is over, and what follows
 *     it (a tool, then another call) supplies the next word;
 *   - a reasoning block that stopped streaming — its record landed, so the
 *     thinking is done even though the text is still on screen.
 *
 * Neither clears the phase: the word stays on the last thing that was actually
 * seen happening. That is a beat behind reality on a settled step, and it is the
 * only honest option — the next call has not been written yet, so anything else
 * would be a guess about what the loop is about to do.
 */
export function turnPhase(body: readonly StreamBlock[]): TurnPhase {
  let phase: TurnPhase = 'model';

  const see = (entry: Entry): void => {
    if (entry.kind === 'stream' || entry.kind === 'answer') phase = 'reply';
    else if (entry.kind === 'reason') {
      if (entry.streaming) phase = 'thinking';
    } else if (entry.kind === 'tool') {
      if (entry.result === null) phase = 'tool';
    } else if (entry.kind === 'model' && entry.retry !== null) {
      // A retry row is the same call, being tried again: the head should not go
      // on saying "reply" through a backoff.
      phase = 'model';
    }
  };

  for (const block of body) {
    // A card's own head is not in `block.rows` (it is the record the bar
    // restates), so the "call is in flight" fact comes from the block, not from
    // an entry. It is read **before** the block's rows for the same reason the
    // rows come after it: the call happens first.
    if (block.kind === 'step' && block.running) phase = 'model';
    for (const entry of blockEntries(block)) see(entry);
  }
  return phase;
}

/**
 * The block that is **the turn's reply**: the last answer it produced, or — while
 * no final answer has arrived — the last stretch of text it streamed.
 *
 * One block, not all of them, and that is the difference between a chat and a
 * log. A turn usually streams text before each of its tool calls ("let me look at
 * the file list first"), and those lines are narration, part of the work: a folded
 * turn that kept them would read as a chat where the assistant says six unrelated
 * things before its answer. What it settled on is the `answer` row;
 * `applyFinalAnswer` removes the streamed copy beside it, so in practice exactly
 * one of the two is present.
 */
function replyAt(body: readonly StreamBlock[]): number {
  let answer = -1;
  let stream = -1;
  body.forEach((block, at) => {
    for (const entry of blockEntries(block)) {
      if (entry.kind === 'answer') answer = at;
      else if (entry.kind === 'stream') stream = at;
    }
  });
  return answer >= 0 ? answer : stream;
}

/** One turn's body, cut into the runs the fold draws. */
function turnRuns(body: readonly StreamBlock[]): TurnRun[] {
  const reply = replyAt(body);
  const runs: TurnRun[] = [];

  body.forEach((block, index) => {
    const kind: TurnRun['kind'] = index === reply ? 'reply' : 'process';
    const open = runs[runs.length - 1];
    // A reply always stands alone among process; consecutive process blocks are
    // one run, so a turn's whole body is normally **two** runs and one fold.
    if (open !== undefined && open.kind === kind && kind === 'process') {
      open.blocks.push(block);
      return;
    }
    runs.push({ kind, blocks: [block] });
  });

  return runs;
}

/** The files a `present` call declared anywhere inside this turn. */
function turnDeliverables(body: readonly StreamBlock[]): Deliverable[] {
  let files: Deliverable[] | null = null;
  for (const block of body) {
    for (const entry of blockEntries(block)) {
      if (entry.kind !== 'tool' || entry.result === null) continue;
      const declared = entry.result.deliverables;
      if (declared === undefined || declared.length === 0) continue;
      if (files === null) files = [];
      files.push(...declared);
    }
  }
  return files ?? NO_DELIVERABLES;
}

/**
 * Partition the blocks into loose rows and turns.
 *
 * **A turn runs from its head to the next head**, and that span is the whole
 * definition — no second rule, no closing row. It is what a person means by
 * "this turn" when they fold one, and it is safe because nothing but a head
 * concludes a turn: the `answer` row can arrive before the `run_finished` record
 * that closes it, and a note written between turns (a compaction, an attached
 * picture) has no head of its own to belong to.
 *
 * The cost of that definition is worth stating: a session-level note appended
 * after a turn finished lands **inside** that turn's span, so folding the turn
 * takes the note off screen with the rest of the work. That is what the fold is
 * for. The alternative — closing the span at the `answer` — would leave the rows
 * that arrive between the answer and the next prompt belonging to no section at
 * all, which is a worse lie: they would have to be drawn in an order that is not
 * the arrival order.
 *
 * **One kind of trailing row is handed back, and it is the prompt.** An echo is
 * appended by this window when the person presses Enter, and the head it opens
 * only lands when the runtime answers `run_started` — so for a moment the next
 * turn's question is the last row under the previous turn. Folding that turn
 * would then hide the question the reader just asked, which is the one row a
 * folded transcript must never swallow. So trailing `user` rows are pulled out of
 * the span and drawn loose, between the two sections. That is the same rule
 * `turnRail.ts` states from the other side: a head's prompt sits *above* the head,
 * not inside it.
 *
 * Runs on every change to `entries`, including every chunk, so it does one pass
 * and one `push` per block.
 */
export function streamSections(blocks: StreamBlock[]): StreamSection[] {
  const out: StreamSection[] = [];
  let loose: StreamBlock[] = [];
  let turn: TurnSection | null = null;

  const flushLoose = (): void => {
    if (loose.length === 0) return;
    const head = loose[0];
    out.push({
      kind: 'loose',
      key: `loose-${head === undefined ? '' : blockKey(head)}`,
      blocks: loose,
    });
    loose = [];
  };

  /** Close the open turn, if any, and hand its trailing prompts back to `loose`. */
  const closeTurn = (): void => {
    if (turn === null) return;
    const open = turn;
    turn = null;

    let at = open.body.length;
    while (at > 0) {
      const block = open.body[at - 1];
      if (block === undefined || block.kind !== 'entry') break;
      if (block.row.kind !== 'entry' || block.row.entry.kind !== 'user') break;
      at -= 1;
    }

    const prompts = open.body.splice(at);
    open.phase = turnPhase(open.body);
    open.runs = turnRuns(open.body);
    open.deliverables = turnDeliverables(open.body);
    out.push(open);
    loose.push(...prompts);
  };

  for (const block of blocks) {
    const head =
      block.kind === 'entry' && block.row.kind === 'entry' && block.row.entry.kind === 'turn'
        ? block.row
        : null;

    if (head === null) {
      if (turn === null) loose.push(block);
      else turn.body.push(block);
      continue;
    }

    // The head that opens a section also closes the one above it — including an
    // open turn with no body (two heads in a row is two turns, one of which drew
    // nothing). The prompts it hands back are drawn between the two, which is
    // where the echo already sits in the transcript's own order.
    closeTurn();
    flushLoose();
    turn = {
      kind: 'turn',
      key: `turn-${head.key}`,
      head,
      body: [],
      runs: [],
      deliverables: NO_DELIVERABLES,
      phase: 'model',
    };
  }

  closeTurn();
  flushLoose();
  return out;
}

