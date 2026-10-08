import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowDown } from 'lucide-react';
import { NO_ENTRIES, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import { EntryView } from './EntryView';
import { QuietGroup } from './QuietGroup';
import { TurnRail } from './TurnRail';
import { MIN_RAIL_TURNS, turnRail, LANDING_PX } from '@/turnRail';
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

type Row =
  | { kind: 'entry'; key: string; entry: Entry }
  | { kind: 'quiet'; key: string; entries: Entry[] };

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
          {rows.map((row) =>
            row.kind === 'quiet' ? (
              <QuietGroup key={row.key} entries={row.entries} />
            ) : (
              <EntryView key={row.key} entry={row.entry} />
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
