import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowDown, Sparkles } from 'lucide-react';
import { NO_ENTRIES, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import { EntryView } from './EntryView';
import { QuietGroup } from './QuietGroup';
import { TurnRail } from './TurnRail';
import { MIN_RAIL_TURNS, turnRail, LANDING_PX } from '@/turnRail';
import { streamBlocks, type StreamBlock, type StreamRow } from '@/streamBlocks';
import { formatDuration, formatTokens } from '@/utils/format';
import type { Entry } from '@/state/entries';

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
  const quiet = useSessionField((rt) => rt.quiet, false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  const rows = useMemo(() => buildRows(entries, quiet), [entries, quiet]);
  // The drawn rows, pulled tight into step panels. Same cadence as `rows`
  // above — one pass per change to `entries`, including every streamed chunk —
  // and the same saving rule applies: earlier blocks keep the same row objects,
  // so a memo'd block re-renders only when its own rows moved.
  const blocks = useMemo(() => streamBlocks(rows), [rows]);
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
        className="stream-scroll scroll"
        ref={scrollRef}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="log"
        aria-live="polite"
        aria-label={t('stream.label')}
      >
        <div className="stream-inner">
          {blocks.map((block) =>
            block.kind === 'step' ? (
              <StepBlock key={block.key} block={block} />
            ) : (
              <StreamRowView key={block.row.key} row={block.row} />
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

  return (
    <section
      className={`e-step${block.running ? ' is-running' : ''}${
        elevated !== '' ? ` is-elevated ${elevated}` : ''
      }`}
    >
      <header className="e-step-head">
        <Sparkles size={13} className="e-step-icon" />
        <span className="e-step-title">{t('entry.model')}</span>
        <span className="e-step-metrics">
          {m.durationMs !== null ? formatDuration(m.durationMs) : t('entry.modelNoMetrics')}
          {m.inputTokens !== null ? ` · ${t('entry.modelIn', { n: formatTokens(m.inputTokens) })}` : ''}
          {m.cachedTokens !== null ? ` · ${t('entry.modelCached', { n: formatTokens(m.cachedTokens) })}` : ''}
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
