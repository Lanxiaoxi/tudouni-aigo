/**
 * The polling throttle — one state per session.
 *
 * `refresh_state` is not a heartbeat: it is sent only while something of ours
 * is outstanding, never faster than the floor, and it stops once the answer
 * stops changing.
 *
 * **The send is booked, not checked.** The only thing that ever sends is a
 * timer, armed at the first moment the floor permits. Checking the floor where
 * the snapshot lands cannot work: the landing that answers a poll arrives a few
 * dozen milliseconds after the send, so the floor is always unexpired there —
 * the check failed every time, nothing else ever called again, and the loop
 * died after one iteration. A job or a delegation running in a quiet session
 * (no tool results, no turn boundary) then sat on a frozen `seconds` for its
 * whole life, which is the report this fixes. Booking the send for when the
 * floor expires is what turns the floor from a blocker into a schedule.
 */

/** The throttle floor for polling the runtime (decision 5). `status` reads the
 *  audit log, so it must not become a heartbeat. */
export const POLL_FLOOR_MS = 2000;

/**
 * How many identical answers in a row before the polling gives up.
 *
 * `refresh_state` is a lightweight read, but "poll every 2s until the session
 * ends" is a heartbeat in all but name, and the design says `status` reads the
 * audit log and must not become one. A job that stays `uncollected` is the case
 * that never resolves on its own: it only clears when a person collects it with
 * `job_output`, and until then the front end would poll forever. After this many
 * unchanged answers the polling stops; the next real change (a finished turn, a
 * tool result, an edited key) restarts it.
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
  /** The send booked for when the floor next permits, if any. At most one:
   *  a pending booking is kept, never duplicated or re-armed. */
  timer: ReturnType<typeof setTimeout> | null;
  /** The one send this session polls with, refreshed by every landing. The
   *  closures are equivalent (they name this key and one message type), so
   *  which landing's copy fires does not matter — that there is one does. */
  send: (() => void) | null;
}
const pollStates = new Map<string, PollState>();

function pollState(key: string): PollState {
  let state = pollStates.get(key);
  if (!state) {
    state = { lastPollAt: 0, streak: 0, outstandingKey: '', timer: null, send: null };
    pollStates.set(key, state);
  }
  return state;
}

/**
 * Note what the outstanding set looks like now, and make sure a send is booked
 * for when the floor next permits.
 *
 * Called on every `ui(state)` landing. An unchanged set deepens the streak (at
 * fire time); a changed one resets it, so the backoff only ever applies to a
 * genuinely static situation — and a running job's or delegation's `seconds`,
 * which advance on every answer, are what keep the poll alive. An empty set
 * cancels the booking: nothing left to keep fresh.
 */
export function noteOutstanding(key: string, outstanding: string, send: () => void): void {
  const state = pollState(key);
  state.send = send;
  if (outstanding !== state.outstandingKey) {
    state.outstandingKey = outstanding;
    state.streak = 0;
  }
  if (outstanding === '') {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    return;
  }
  if (state.timer === null) {
    const wait = Math.max(0, state.lastPollAt + POLL_FLOOR_MS - Date.now());
    state.timer = setTimeout(() => {
      state.timer = null;
      fire(key);
    }, wait);
  }
}

/**
 * The booked send firing. The wait may have changed the answer to "nothing
 * outstanding" or spent the give-up budget — both are re-checked here rather
 * than trusted from booking time, because booking is made at landing time and
 * the fire is what acts.
 */
function fire(key: string): void {
  const state = pollState(key);
  if (state.send === null || state.outstandingKey === '') return;
  if (state.streak >= POLL_GIVE_UP_AFTER) return;
  state.lastPollAt = Date.now();
  state.streak += 1;
  state.send();
}

/**
 * A caller's own nudge: send now if the floor permits.
 *
 * The manual path — a turn just ended and the usage figures are worth one
 * request, or an explicit ask from a surface. The floor still applies, so a
 * burst of calls cannot become a burst of requests. The give-up does not: an
 * explicit ask is not the heartbeat the backoff exists to stop.
 */
export function pollNow(key: string, send: () => void): void {
  const state = pollState(key);
  const now = Date.now();
  if (now - state.lastPollAt < POLL_FLOOR_MS) return;
  state.lastPollAt = now;
  send();
}

/**
 * Lift the backoff — something that can change the outcome happened (a finished
 * turn, a tool result). Zeroing `lastPollAt` books the next landing's send for
 * immediately, which is the wake's point: one fresh answer right behind the
 * snapshot that announced the change is cheap. Without the reset a give-up
 * reached mid-turn would outlive the turn that caused it.
 */
export function wakePolling(key: string): void {
  const state = pollState(key);
  state.streak = 0;
  state.lastPollAt = 0;
}

/** Drop a session's throttle state when the session goes away — the booked
 *  timer with it, or the loop would keep firing at a key nothing answers. */
export function forgetPolling(key: string): void {
  const state = pollStates.get(key);
  if (state !== undefined && state.timer !== null) clearTimeout(state.timer);
  pollStates.delete(key);
}
