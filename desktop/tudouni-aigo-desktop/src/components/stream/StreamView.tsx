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
  simpleStepStatus,
  streamBlocks,
  streamSections,
  type StreamBlock,
  type StreamRow,
  type StreamSection,
} from '@/streamBlocks';
import { formatDuration, formatTokens, tokPerSecond } from '@/utils/format';
import type { Entry } from '@/state/entries';

/**
 * §1·3 Main area / §2 the session stream.
 *
 * The height budget belongs to the outer flex column: this is always a
 * `min-height: 0` scroll region, so a panel sized to its content can never push
 * the status bar or the composer out of the viewport (§9.1).
 *
 * Scrolling: bottom-follow is a mode the reader owns. While it holds, every
 * kind of growth is followed — new entries, and a row's height arriving after
 * its entry does — and the follow never releases itself: the scroll events its
 * own writes produce are flagged and ignored, because a tall card growing
 * between a write and its event used to read as "the reader scrolled up" and
 * drop the pin mid-stream. Only the reader releases it — an upward scroll, or
 * a press anywhere in the transcript — and released, the position is not
 * stolen back: a "jump to latest" button appears instead, so reading history
 * is not interrupted by streaming output.
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
  const innerRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  // True from a programmatic stick until its scroll event has been delivered;
  // `onScroll` skips and clears those. See `stickToBottom`.
  const followWrite = useRef(false);
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

  /**
   * The one way anything sticks to the bottom: write, flag, release next frame.
   *
   * The flag is what keeps the follow from releasing itself. A `scrollTop`
   * write fires its scroll event from a later rendering update, and if the
   * document grew in between — a tall card landing, an estimate being replaced
   * by layout — the event reports a gap past the pin threshold and reads as a
   * reader who scrolled up. The flag drops once the write's own event has been
   * delivered (cleared by `onScroll` when it arrives, by the frame callback
   * when it never does), so a reader's wheel or scrollbar is still read.
   */
  const stickToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    followWrite.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      followWrite.current = false;
    });
  }, []);

  // Follow only while pinned, and land directly — no positional animation.
  useEffect(() => {
    if (!pinned) return;
    stickToBottom();
  }, [rows, pinned, stickToBottom]);

  /**
   * Follow the transcript's height, not just its row list.
   *
   * The effect above runs when `rows` changes, but a row's real height can
   * arrive after its entry does: images decode, markdown settles, and a row
   * under `content-visibility: auto` stands at a 120px estimate until it is
   * laid out (`app.css`). That is the tall card that used to leave the
   * transcript above a bottom that had since moved, with nothing left to
   * correct it. Subscribed only while pinned — a reader who released the
   * follow is never moved by it — and the initial callback that comes with
   * every subscription re-lands a pin whose document was still settling.
   */
  useEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!pinned || !el || !inner) return;
    const ro = new ResizeObserver(() => {
      // At the bottom already — or clamped there by a shrink — the write
      // would be a no-op; leave it and its flag alone.
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= 1) return;
      stickToBottom();
    });
    // The transcript for growth; the scroller for the viewport around it, so
    // a window resize corrects the gap without waiting for the next chunk.
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pinned, stickToBottom]);

  const onScroll = useCallback(() => {
    // A flagged event is the follow's own write arriving; it says nothing
    // about where the reader wants to be. Unflagged events decide the pin,
    // and nearing the bottom re-pins — how wheeling back down rejoins.
    if (followWrite.current) {
      followWrite.current = false;
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(gap < 48);
  }, []);

  const jumpToLatest = useCallback(() => {
    stickToBottom();
    setPinned(true);
  }, [stickToBottom]);

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

  /**
   * A press anywhere in the transcript is the reader taking over: a fold to
   * open, text to select, a copy button — whatever the press turns into, the
   * next chunk must not drag them off it. The jump-to-latest button is left
   * alone so its press does not fight the click that re-pins.
   */
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.jump-latest')) return;
    setPinned(false);
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
          onPointerDown={onPointerDown}
          tabIndex={0}
          role="log"
          aria-live="polite"
          aria-label={t('stream.label')}
        >
          <div className="stream-inner" ref={innerRef}>
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
      counts the normal head carries. */
  if (quiet === 'simple') {
    const status = simpleStepStatus(block);
    let statusText: string;
    if (status.state === 'executing') {
      statusText = t('entry.simpleStepExecuting', {
        tools: status.names.length > 0 ? status.names.join(', ') : '…',
      });
    } else if (status.state === 'denied') {
      // Tools arrived but none of them ran: every call was refused. "Done"
      // would claim work that the runtime decided against.
      statusText = t('entry.toolResultDenied');
    } else if (status.names.length > 0) {
      statusText = t('entry.simpleStepDone', { tools: status.names.join(', ') });
    } else {
      statusText = t('entry.simpleStepDonePlain');
    }
    const executing = status.state === 'executing';
    const deliverables = status.deliverables;
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
          <span className="e-step-metrics">{statusText}</span>
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
