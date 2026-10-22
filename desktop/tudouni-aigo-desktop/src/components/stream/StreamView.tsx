import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowDown, Loader, Sparkles } from 'lucide-react';
import { NO_ENTRIES, useApp, useSessionField } from '@/state/store';
import { DeliverableCards } from './DeliverableCards';
import { useT } from '@/i18n/useT';
import { useFindInStream } from '@/find/useFindInStream';
import { EntryView } from './EntryView';
import { FindBar } from './FindBar';
import { QuietGroup } from './QuietGroup';
import { TurnRail } from './TurnRail';
import { MIN_RAIL_TURNS, turnRail, LANDING_PX } from '@/turnRail';
import {
  blockKey,
  streamBlocks,
  streamSections,
  type StreamBlock,
  type StreamRow,
  type StreamSection,
} from '@/streamBlocks';
import { formatDuration, formatTokens, tokPerSecond } from '@/utils/format';
import type { Deliverable, Entry } from '@/state/entries';

/**
 * §1·3 Main area / §2 the session stream.
 *
 * The height budget belongs to the outer flex column: this is always a
 * `min-height: 0` scroll region, so a panel sized to its content can never push
 * the status bar or the composer out of the viewport (§9.1).
 *
 * Scrolling: while pinned to the bottom, new entries are followed; once the
 * reader scrolls up, the position is not stolen back — a "jump to latest"
 * button appears instead, so reading history is not interrupted by streaming
 * output.
 *
 * The transcript and the turn rail share a row (`.stream-body`). Reserving the
 * rail's lane here rather than floating it over the transcript is what makes it
 * impossible for a mark to land on the text — see `TurnRail.tsx`. The lane is
 * only taken once there is a conversation worth navigating (`MIN_RAIL_TURNS`),
 * so a session with one turn keeps every pixel of width it had.
 */

type Row = StreamRow;

/** Quiet mode collapses tool rows; everything else keeps its own shape. */
const QUIETABLE = new Set(['tool', 'batch', 'denied']);

function buildRows(entries: Entry[], quiet: boolean): Row[] {
  if (!quiet) {
    return entries.map((e) => ({ kind: 'entry', key: e.id, entry: e }));
  }

  const rows: Row[] = [];
  let buffer: Entry[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    rows.push({ kind: 'quiet', key: `quiet-${buffer[0].id}`, entries: buffer });
    buffer = [];
  };

  for (const entry of entries) {
    if (QUIETABLE.has(entry.kind)) {
      buffer.push(entry);
    } else {
      flush();
      rows.push({ kind: 'entry', key: entry.id, entry });
    }
  }
  flush();
  return rows;
}

/**
 * The stream's drawn list: rows partitioned into step blocks.
 *
 * **`streamBlocks` runs on the drawn rows, not on `entries`.** Quiet mode and
 * the block partition answer the same question — "how is this step's work
 * shown" — at two levels, and running the partition under quiet would put a
 * rollup inside a panel whose own head says "model call", both naming the
 * same calls. The row list is the one surface both shapes agree on, so the
 * partition reads rows and treats a quiet group as one row of tool work.
 */

export function StreamView() {
  const t = useT();
  // The transcript and its shape both come from the session being shown. Quiet
  // mode is per session now: it says how *this conversation's* tool calls are
  // drawn, so switching conversations switching it is the point.
  const entries = useSessionField((rt) => rt.entries, NO_ENTRIES);
  const quiet = useSessionField((rt) => rt.quiet, 'off');

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  // The transcript's own find (`Ctrl+F`). It is run here rather than in the bar
  // because this component owns both the scroller a jump lands in and the row
  // list the hits are drawn over.
  const find = useFindInStream(scrollRef, entries);

  /**
   * Searching releases the bottom-follow.
   *
   * While pinned, every chunk writes `scrollTop = scrollHeight` — so a reader who
   * is walking hits down a long answer would be dragged back to the last line of
   * the conversation several times a second, and the hit they just went to would
   * scroll away underneath them. Unpinning is one-way here: coming back to the
   * bottom is the jump-to-latest button's job, as it is for any other reader who
   * scrolled up.
   */
  useEffect(() => {
    if (find.open) setPinned(false);
  }, [find.open]);

  const rows = useMemo(() => buildRows(entries, quiet !== 'off'), [entries, quiet]);
  // The drawn rows, pulled tight into step panels. Same cadence as `rows`
  // above — one pass per change to `entries`, including every streamed chunk —
  // and the same saving rule applies: earlier blocks keep the same row objects,
  // so a memo'd block re-renders only when its own rows moved.
  const blocks = useMemo(() => streamBlocks(rows), [rows]);
  // And the turns they belong to: every head with the blocks drawn under it, and
  // the phase its body is in. One more pass on the same cadence, which never
  // redraws a row — a section is a grouping, and the head and its body are still
  // drawn by the components that already drew them.
  const sections = useMemo(() => streamSections(blocks), [blocks]);
  // One pass over the transcript, in its own order. Called on every change to
  // `entries` — including every chunk of every answer — so it walks the entries
  // once rather than scanning each turn's span independently: the spans
  // partition the transcript, so the total work is linear, not quadratic.
  const turns = useMemo(() => turnRail(entries), [entries]);
  const rail = turns.length >= MIN_RAIL_TURNS;

  // Follow only while pinned, and land directly — no positional animation.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinned) return;
    el.scrollTop = el.scrollHeight;
  }, [rows, pinned]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(gap < 48);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPinned(true);
  }, []);

  /**
   * PageUp / PageDown / Home / End.
   *
   * The help panel has advertised `PgUp`/`PgDn` since the beginning and nothing
   * implemented them, so the only way through a long history was the mouse — and
   * the region was not focusable, so even the arrow keys could not reach it.
   * Scrolling by a page rather than one row is what the key name promises.
   */
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const page = Math.max(40, el.clientHeight - 48);
    let delta: number | null = null;
    if (e.key === 'PageDown') delta = page;
    else if (e.key === 'PageUp') delta = -page;
    else if (e.key === 'Home') el.scrollTop = 0;
    else if (e.key === 'End') el.scrollTop = el.scrollHeight;
    else return;

    e.preventDefault();
    if (delta !== null) el.scrollTop += delta;
    // Scrolling to the very bottom re-pins; anywhere else releases the follow so
    // streaming output does not drag the reader back down.
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(gap < 48);
  }, []);

  return (
    <>
      {/* Above `.stream-body` rather than inside it: `.stream-body` is the
          horizontal row that holds the transcript and the rail's lane, and a bar
          inside it would either take a lane of its own or overlap the text. One
          row of the column above it costs the transcript 32px and covers
          nothing. */}
      {find.open ? (
        <FindBar
          query={find.query}
          count={find.count}
          index={find.index}
          focusToken={find.focusToken}
          onQuery={find.setQuery}
          onNext={find.next}
          onPrev={find.prev}
          onClose={find.close}
        />
      ) : null}

      <div
        className="stream-body"
        // Where a jumped-to turn head lands, published for the stylesheet's
        // `scroll-margin-top`. It is written here rather than in `stream.css`
        // because `HEADING_BAND_PX` — the rule that decides which mark is active —
        // is derived from it in `turnRail.ts`, and a jump that lands outside its own
        // band makes the rail highlight the turn *before* the one that was clicked.
        style={{ '--rail-landing': `${LANDING_PX}px` } as CSSProperties}
      >
        <div
          className="stream-scroll scroll-fade"
          ref={scrollRef}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          tabIndex={0}
          role="log"
          aria-live="polite"
          aria-label={t('stream.label')}
        >
          <div className="stream-inner">
            {sections.map((section) =>
              section.kind === 'turn' ? (
                <TurnFold key={section.key} section={section} />
              ) : (
                <Fragment key={section.key}>
                  {section.blocks.map((block) => (
                    <StreamBlockView key={blockKey(block)} block={block} />
                  ))}
                </Fragment>
              ),
            )}
          </div>

          {!pinned ? (
            <button
              type="button"
              className="btn btn-secondary btn-compact jump-latest"
              onClick={jumpToLatest}
            >
              <ArrowDown size={12} />
              {t('common.jumpLatest')}
            </button>
          ) : null}
        </div>

        {rail ? <TurnRail turns={turns} scrollRef={scrollRef} /> : null}
      </div>
    </>
  );
}

/**
 * One stream row, on its own, exactly as `EntryView` drew it before the block
 * partition existed. Prose, turn heads, user prompts, notes, retries and
 * orphans all pass through here unchanged — the partition only ever *groups*
 * rows, never redraws them, which is what keeps the twelve entry kinds' own
 * tests true of the layout around them too.
 */
function StreamRowView({ row }: { row: StreamRow }) {
  if (row.kind === 'quiet') return <QuietGroup key={row.key} entries={row.entries} />;
  return <EntryView key={row.key} entry={row.entry} />;
}

/** One block, whichever half of the partition it came from. */
function StreamBlockView({ block }: { block: StreamBlock }) {
  if (block.kind === 'step') return <StepBlock block={block} />;
  return <StreamRowView row={block.row} />;
}

/**
 * One turn, drawn the way a chat draws it: what it said, and — folded — nothing of
 * how it got there.
 *
 * **The fold takes the middle out, never the answer.** The body is split into runs
 * by role (`streamBlocks.ts`'s `TurnRun`): the work — thinking, model call cards,
 * tools, notes — goes inside the fold, and the turn's own words stay outside it.
 * Folded, a turn is therefore its head line plus the answer; the head still says
 * what the turn is doing (or how it ended) and for how long, which is the one line
 * the earlier "collapse the whole turn" shape left and the answer now sits under.
 *
 * Two consequences worth stating, because both are choices:
 *
 *   - **The declared files stay on screen.** A `present` call's cards live inside a
 *     tool row, which is process, so folding would bury the only thing that call
 *     made — exactly what `EntryView`'s note on that card refuses. They are
 *     collected per turn and drawn after the answer while folded.
 *   - **Everything stays mounted.** The process is folded with `.collapse`, not
 *     removed, for the same reason the reasoning body is: `Ctrl+F` counts what is
 *     in the document, and a hit inside a shut fold is opened by the jump
 *     (`find/engine.ts`). Removing it would make a word searchable only in some
 *     part of the transcript.
 *
 * The fold state comes from the store rather than a prop for the same reason the
 * tool and reasoning folds do: the head *is* the control, and it is drawn by
 * `EntryView` — a `memo`'d row that must not start re-rendering because a
 * sibling's body changed. Both halves read `turnFolded[headId]`, so they cannot
 * disagree about whether the work is showing.
 */
function TurnFold({ section }: { section: Extract<StreamSection, { kind: 'turn' }> }) {
  const headId = section.head.entry.id;
  const folded = useApp((s) => s.turnFolded[headId] === true);

  return (
    <>
      <EntryView entry={section.head.entry} phase={section.phase} />
      {section.runs.map((run) => {
        if (run.kind === 'reply') {
          // Loose in `.stream-inner`, so the answer keeps the transcript's own row
          // rhythm and never sits inside a fold it would be hidden by.
          return (
            <Fragment key={runKey(run)}>
              {run.blocks.map((block) => (
                <StreamBlockView key={blockKey(block)} block={block} />
              ))}
            </Fragment>
          );
        }
        return (
          <div
            key={runKey(run)}
            className={`collapse turn-run${folded ? ' is-collapsed' : ''}`}
            data-turn={headId}
            inert={folded}
          >
            {/* The grid child — the element whose height the fold animates, and
                the one that carries the stream's row rhythm, because its rows no
                longer sit in `.stream-inner`'s flex column. */}
            <div className="turn-rows">
              {run.blocks.map((block) => (
                <StreamBlockView key={blockKey(block)} block={block} />
              ))}
            </div>
          </div>
        );
      })}
      {folded && section.deliverables.length > 0 ? (
        <DeliverableCards files={section.deliverables} />
      ) : null}
    </>
  );
}

/** A run's key: its first block's, which is stable while the run grows. */
function runKey(run: { kind: string; blocks: StreamBlock[] }): string {
  const first = run.blocks[0];
  return `${run.kind}-${first === undefined ? '' : blockKey(first)}`;
}

/**
 * One step block: the redesign's card form of "this call and its work".
 *
 * **The head is the old `model` row's facts, restated on a bar.** The loose row
 * drew one metrics line ("56s · in 67,337 · cached 66,368") as a paragraph
 * between the tool lines above and below it — which is exactly why the
 * transcript read as scatter. The head carries the same three figures, from
 * the same entry, at the same place in the order; a call in flight says "in
 * progress" the row said it with.
 *
 * The tools, permissions, batch and denial rows render **inside** the card,
 * through `EntryView` — same components, same folding, same toggles. A body
 * row (streamed text, the answer) is never in here: the partition holds them
 * out, and the head should never gain a `max-height`, because the answer is
 * the one thing this panel is not.
 */
function StepBlock({ block }: { block: Extract<StreamBlock, { kind: 'step' }> }) {
  const t = useT();
  const m = block.metrics;
  // Quiet mode is per session; the card is drawn from the transcript it
  // belongs to, and this window draws one, so the active session's reading is
  // the one the head must take.
  const quiet = useSessionField((rt) => rt.quiet, 'off');

  // The card's edge follows its riskiest row: a MEDIUM or HIGH call is one a
  // person is meant to notice from across the transcript, and the row's own
  // badge still says which call it was. `high` wins over `medium`, and neither
  // is present on the ordinary call — the edge stays neutral there.
  let elevated = '';
  for (const row of block.rows) {
    if (row.kind !== 'entry' || row.entry.kind !== 'tool') continue;
    if (row.entry.risk === 'high') {
      elevated = 'has-high';
      break;
    }
    if (row.entry.risk === 'medium') elevated = 'has-medium';
  }

  /* Simple quiet mode: the card is **its head line and nothing else** — no
      figures, no rows. What the head says is what the person asked for:
      "Executing grep, shell, edit_file" while the work is in flight,
      "Done: grep, shell, edit_file" once it is over, and never the token
      counts the normal head carries. The tools are walked from the rows in
      arrival order, a name at most once each (a retried call names its tool
      twice), and a call that declared a deliverable keeps its cards — a
      declaration is the turn's result, and simple mode must not be the place
      it goes missing. */
  if (quiet === 'simple') {
    const names: string[] = [];
    const seen = new Set<string>();
    const deliverables: Deliverable[] = [];
    let unfinished = false;
    for (const row of block.rows) {
      if (row.kind !== 'entry') continue;
      if (row.entry.kind !== 'tool') continue;
      if (!seen.has(row.entry.tool)) {
        seen.add(row.entry.tool);
        names.push(row.entry.tool);
      }
      if (row.entry.result === null) unfinished = true;
      const declared = row.entry.result?.deliverables;
      if (declared) deliverables.push(...declared);
    }
    const executing = block.running || unfinished;
    return (
      <section
        className={`e-step${block.running ? ' is-running' : ''}${
          elevated !== '' ? ` is-elevated ${elevated}` : ''
        }`}
      >
        <header className="e-step-head">
          {executing ? (
            <Loader size={11} className="e-step-icon e-step-spinner" aria-hidden />
          ) : (
            <Sparkles size={11} className="e-step-icon" />
          )}
          <span className="e-step-title">{t('entry.model')}</span>
          <span className="e-step-metrics">
            {executing
              ? t('entry.simpleStepExecuting', { tools: names.length > 0 ? names.join(', ') : '…' })
              : names.length > 0
                ? t('entry.simpleStepDone', { tools: names.join(', ') })
                : t('entry.simpleStepDonePlain')}
          </span>
        </header>
        {deliverables.length > 0 ? <DeliverableCards files={deliverables} /> : null}
      </section>
    );
  }

  return (
    <section
      className={`e-step${block.running ? ' is-running' : ''}${
        elevated !== '' ? ` is-elevated ${elevated}` : ''
      }`}
    >
      <header className="e-step-head">
        {block.running ? (
          <Loader size={11} className="e-step-icon e-step-spinner" aria-hidden />
        ) : (
          <Sparkles size={11} className="e-step-icon" />
        )}
        <span className="e-step-title">{t('entry.model')}</span>
        <span className="e-step-metrics">
          {m.durationMs !== null ? formatDuration(m.durationMs) : t('entry.modelNoMetrics')}
          {m.inputTokens !== null ? ` · ${t('entry.modelIn', { n: formatTokens(m.inputTokens) })}` : ''}
          {m.cachedTokens !== null ? ` · ${t('entry.modelCached', { n: formatTokens(m.cachedTokens) })}` : ''}
          {(() => {
            // No completion count and no duration are "no measurement", not a
            // slow call: the rate is omitted rather than printed as 0.0.
            const rate = tokPerSecond(m.completionTokens, m.durationMs);
            return rate !== null ? ` · ${t('entry.modelOut', { n: rate })}` : '';
          })()}
        </span>
      </header>
      <div className="e-step-rows">
        {block.rows.map((row) =>
          row.kind === 'quiet' ? (
            <QuietGroup key={row.key} entries={row.entries} />
          ) : (
            <EntryView key={row.key} entry={row.entry} />
          ),
        )}
      </div>
    </section>
  );
}
