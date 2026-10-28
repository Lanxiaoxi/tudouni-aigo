/**
 * The effort probe's rules, as pure functions.
 *
 * They live here rather than inside `EffortPanel` because each one decides
 * something that **writes a file**: which levels a save puts into `config.json`,
 * and whether the result on screen is still about the endpoint on screen. A rule
 * that can delete a working level is worth asserting directly, and a component's
 * body is the one place a test cannot reach without a renderer.
 *
 * The runtime owns the probe itself (one real request per level, the three-way
 * `ok` / `rejected` / `uncertain` reading). This module owns only what the panel
 * does with the answer.
 */
import type { ProbeEffortSnapshot } from '@/protocol/types';

/**
 * How long a probe may stay unanswered before the panel stops claiming it is
 * running.
 *
 * The runtime's own worst case is one ask per offered level, each capped at a
 * minute (`model.probeTimeout`), and the levels come from the catalogue — six
 * today, so six minutes with no margin. This deadline is that bound plus a
 * minute of slack. It exists because "probing" is derived from **the store**
 * (`startedAt` set, no answer yet): if the runtime dies, the connection drops,
 * or the child is replaced mid-pass, no message will ever arrive to clear it and
 * the panel would spin for ever.
 */
export const PROBE_DEADLINE_SECONDS = 7 * 60;

/**
 * How long a **result** stays usable for a save.
 *
 * A probe describes the endpoint at one moment. A list read a week ago is not
 * evidence about what the endpoint takes now, and writing it into the
 * configuration file would replace a working list with a stale one. Half an hour
 * is long enough to probe, read the result and press save; short enough that
 * "the endpoint as it was at that moment" is still true.
 */
export const PROBE_RESULT_TTL_SECONDS = 30 * 60;

/** Whether an ask that started at `startedAt` should still be drawn as running. */
export function stillProbing(startedAt: number | null, answered: boolean, now: number): boolean {
  if (startedAt === null || answered) return false;
  return now / 1000 - startedAt < PROBE_DEADLINE_SECONDS;
}

/** Whether a result older than the TTL can no longer be written. */
export function probeResultExpired(answeredAt: number | null, now: number): boolean {
  if (answeredAt === null) return false;
  return now / 1000 - answeredAt > PROBE_RESULT_TTL_SECONDS;
}

/**
 * Whether this result is about the endpoint currently on screen.
 *
 * **The pair, not the model id.** One model id can be listed on two routes (two
 * gateways serving the same model, say), and a save writes into
 * `probe.provider`'s entry: comparing the model alone would let a switch to the
 * other route keep drawing this result as a match while the write landed on the
 * route that is no longer on screen.
 */
export function probeApplies(
  probe: ProbeEffortSnapshot | null,
  endpoint: { model: string; provider: string },
): boolean {
  if (probe === null) return false;
  return probe.model === endpoint.model && probe.provider === endpoint.provider;
}

/**
 * The levels a save writes: everything the endpoint did **not** refuse.
 *
 * `ok` and `uncertain`, in that sense of "not refused". `uncertain` means the
 * probe learned nothing — a rate limit, a dead key, a timeout — and writing only
 * `ok` would delete those levels from the configuration. That deletion is the
 * exact outcome the runtime's three-way reading exists to prevent, so the panel
 * must not produce it either.
 */
export function writableLevels(probe: ProbeEffortSnapshot | null): string[] {
  if (probe === null) return [];
  return probe.levels.filter((row) => row.result !== 'rejected').map((row) => row.level);
}

/**
 * The levels an **actual save** writes: every `ok` level, plus the `uncertain`
 * ones the person did not uncheck, in the probe's own order.
 *
 * The panel draws a checkbox on each `uncertain` row — "unclear" is not a
 * refusal, so the old default kept them all, but the person may know their
 * endpoint (a rate-limited key is not the same as a refused level), and the
 * decision is theirs to make rather than a fixed rule. Refusals have no box:
 * there is nothing to decide about a level the endpoint turned down.
 */
export function saveLevels(
  probe: ProbeEffortSnapshot | null,
  excludedUncertain: ReadonlySet<string>,
): string[] {
  if (probe === null) return [];
  return probe.levels
    .filter((row) => {
      if (row.result === 'ok') return true;
      if (row.result === 'uncertain') return !excludedUncertain.has(row.level);
      return false;
    })
    .map((row) => row.level);
}

/** The three columns, counted once so no two surfaces can disagree. */
export function probeTally(probe: ProbeEffortSnapshot | null): {
  ok: number;
  rejected: number;
  uncertain: number;
  total: number;
} {
  if (probe === null) return { ok: 0, rejected: 0, uncertain: 0, total: 0 };
  const ok = probe.levels.filter((row) => row.result === 'ok').length;
  const rejected = probe.levels.filter((row) => row.result === 'rejected').length;
  const uncertain = probe.levels.filter((row) => row.result === 'uncertain').length;
  return { ok, rejected, uncertain, total: probe.levels.length };
}

/**
 * Whether this result can be written at all.
 *
 * Two conditions, and the second is the one that is easy to forget: something
 * has to be **writable** (a result of nothing but refusals would empty the
 * level list, which is a deletion), and something has to have been **confirmed**
 * (`ok`). A pass that came back entirely `uncertain` learned nothing — saving it
 * would write back a list no probe vouched for and call it a result, and every
 * row of it would carry the same "we do not know" into the panel's success
 * message.
 */
export function probeSaveable(probe: ProbeEffortSnapshot | null): boolean {
  if (probe === null) return false;
  return probeTally(probe).ok > 0 && writableLevels(probe).length > 0;
}

/**
 * Why nothing can be saved, when nothing can — the sentence that has to be true.
 *
 * "The endpoint refused every level" is only the right sentence when it did.
 * Six `uncertain` rows are the opposite case (the probe got no readable answer),
 * and saying the endpoint refused them would be the precise lie the three-way
 * reading was built to avoid. Null means "there is something to save", or "there
 * is no result at all" — the caller decides which sentence an empty panel needs.
 */
export function nothingToSaveReason(
  probe: ProbeEffortSnapshot | null,
): 'all-refused' | 'no-answer' | null {
  if (probe === null) return null;
  const tally = probeTally(probe);
  if (tally.total === 0) return null;
  if (tally.rejected === tally.total) return 'all-refused';
  // Nothing was refused, and nothing was confirmed either: the probe never got
  // an answer it could read. This is the case the old wording described as a
  // refusal.
  if (tally.ok === 0) return 'no-answer';
  return null;
}
