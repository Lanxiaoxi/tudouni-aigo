import { useEffect, useState } from 'react';

/**
 * A clock that ticks **only while a turn is running**.
 *
 * The status bar reports how long the turn on screen has been going, and the
 * runtime sends no duration until the turn ends — so the figure can only move if
 * this window re-renders on a timer. The reference front end runs the same
 * arrangement for the same number (`internal/frontends/tui/view.go`, `spanText`:
 * `time.Since(m.current.startedAt)`, redrawn every spinner frame).
 *
 * **Only while a turn is running**, and that is the whole point of the argument:
 * an idle window has nothing to recount — the finished turn's duration is frozen
 * at `run_finished.duration_ms` — so a clock left running would repaint the
 * status bar once a second for the rest of the session to redraw a number that
 * cannot change. `active` is what the caller derives from the phase, so the
 * timer follows the same fact the label does.
 *
 * The interval is a second rather than a frame: the figure is drawn with
 * `formatDuration`, whose finest step is a tenth of a second below 10s, so a
 * faster clock would repaint for nothing. One second is the smallest interval at
 * which every repaint can change the text.
 *
 * The returned value is `Date.now()`, and callers must treat it as a clock
 * reading, not as a duration: `selectTurnMs` subtracts the turn's own stamp.
 */
export function useTurnClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // Read once immediately, so the first frame after a turn starts is not drawn
    // with a stamp taken before it started.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  return now;
}
