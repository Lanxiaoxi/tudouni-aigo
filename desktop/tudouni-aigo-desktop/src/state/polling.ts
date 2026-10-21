/**
 * The polling throttle — one state per session.
 *
 * `refresh_state` is not a heartbeat: it is sent only while something of ours
 * is outstanding, never faster than the floor, and it stops once the answer
 * stops changing. Moved verbatim out of `store.ts`.
 */


/** The throttle floor for polling the runtime (decision 5). `status` reads the
 *  audit log, so it must not become a heartbeat. */
export const POLL_FLOOR_MS = 2000;

/* ============================================================
   Polling throttle — per session
   ============================================================ */

/**
 * How many identical answers in a row before the polling gives up.
 *
 * `refresh_state` is a lightweight read, but "poll every 2s until the session
 * ends" is a heartbeat in all but name, and the design says `status` reads the
 * audit log and must not become one. A job that stays `uncollected` is the case
 * that never resolves on its own: it only clears when a person collects it with
 * `job_output`, and until then the front end would poll forever. After this many
 * unchanged answers the polling stops; the next real change (a finished turn, a
 * tool result) restarts it.
 */
const POLL_GIVE_UP_AFTER = 5;

/**
 * The throttle's state, **one per session**.
 *
 * One shared throttle would mean a busy session starving a quiet one: the two
 * sessions' polls would draw from the same two-second budget and the same
 * give-up counter, so a job left outstanding in B could be silenced by A's
 * traffic — and B's panel would then sit on stale numbers with nothing to
 * explain why.
 */
interface PollState {
  lastPollAt: number;
  streak: number;
  outstandingKey: string;
}
const pollStates = new Map<string, PollState>();

function pollState(key: string): PollState {
  let state = pollStates.get(key);
  if (!state) {
    state = { lastPollAt: 0, streak: 0, outstandingKey: '' };
    pollStates.set(key, state);
  }
  return state;
}

/** `refresh_state` is not a heartbeat: it is only ever sent when something of
 *  ours is known to be outstanding, never faster than the floor, and it stops
 *  once the answer stops changing. */
export function throttled(key: string, fn: () => void): void {
  const state = pollState(key);
  const now = Date.now();
  if (now - state.lastPollAt < POLL_FLOOR_MS) return;
  if (state.streak >= POLL_GIVE_UP_AFTER) return;
  state.lastPollAt = now;
  state.streak += 1;
  fn();
}

/**
 * Note what the outstanding set looks like now.
 *
 * Called on every `ui(state)` landing. An unchanged set deepens the streak; a
 * changed one (a job finished, a new job appeared) resets it, so the backoff
 * only ever applies to a genuinely static situation.
 */
export function noteOutstanding(key: string, outstanding: string): void {
  const state = pollState(key);
  if (outstanding === state.outstandingKey) return;
  state.outstandingKey = outstanding;
  state.streak = 0;
}

/** Restart polling after something that can change the outcome — a finished
 *  turn, a tool result. Without this the give-up above would be permanent. */
export function wakePolling(key: string): void {
  const state = pollState(key);
  state.streak = 0;
  state.lastPollAt = 0;
}

/** Drop a session's throttle state when the session goes away. */
export function forgetPolling(key: string): void {
  pollStates.delete(key);
}
