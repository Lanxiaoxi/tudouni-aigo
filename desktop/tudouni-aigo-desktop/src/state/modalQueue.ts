/**
 * The blocking-request queue.
 *
 * Each conversation is its own child process, so the runtime never sees a
 * cross-session order: every child blocks on its own id. What has to be kept is
 * arrival order **within** one session, and the fact that only the request of
 * the session on screen is drawn.
 *
 * Pure functions over `AppStore`: they return the patch, they do not call
 * `set`. Moved verbatim out of `store.ts`.
 */
import type { AppStore, ModalEntry, ModalState } from './store';


/* ============================================================
   The blocking-request queue
   ============================================================ */

/**
 * The request to render, as a function of the session on screen.
 *
 * Each conversation is its own child process, so there is no cross-session
 * answer order the runtime could recognise: every child blocks on its own id
 * independently. What has to be respected is arrival order **within** one
 * session — its second approval waits behind its first — and the fact that a
 * person can only judge the request of the conversation they are looking at.
 * So the rendered slot is the on-screen session's own first request, or
 * nothing; every other session's waits for its turn, announced by its rail
 * dot (`selectRowStatus` → `asking`) and a notification.
 */
export function headForActive(pending: ModalEntry[], activeKey: string | null): ModalState {
  return pending.find((entry) => entry.key === activeKey) ?? null;
}

/**
 * Add a request.
 *
 * The runtime blocks on the id it asked about and has no timeout, so a request
 * that is never rendered is a call that never returns. That is why nothing here
 * discards an entry — the queue only ever loses one by having it answered.
 */
export function enqueueModal(s: AppStore, entry: ModalEntry): Partial<AppStore> {
  const pendingModals = [...s.pendingModals, entry];
  return {
    pendingModals,
    // **Recomputed, not "the first that landed".** A request from the session
    // the person is looking at always draws, even when a request from a
    // background conversation already sits at the queue's head: the runtime
    // waits per child, so promoting the visible one reorders nothing it could
    // answer in, and it is what keeps a background question from burying a
    // foreground one. Conversely a foreign request lands in the queue and
    // stays there: nothing draws for it until that session is focused.
    modal: headForActive(pendingModals, s.activeKey),
    // A request from the session on screen clears the panel — one drawn over
    // the panel the person is using really is uppermost. One from a session
    // they are not looking at must not close a panel for them; `focusSession`
    // is the act that surfaces the held prompt, and it clears the panel there.
    //
    // **It clears no board.** `boardOpen` is not a panel and is not touched
    // here; the modal components hold a request whose session is on screen
    // while the board is (`selectModalVisible` — the card in Needs you is the
    // surface that says who is asking, and the click that focuses it is the
    // click that surfaces the prompt).
    ...(entry.key === s.activeKey ? { panel: null } : {}),
  };
}

/** Drop the answered request and re-aim the rendered slot. */
export function drainModal(s: AppStore): Partial<AppStore> {
  if (s.modal === null) return {};
  const rest = s.pendingModals.filter((entry) => entry !== s.modal);
  return {
    pendingModals: rest,
    modal: headForActive(rest, s.activeKey),
    // The request that was minimized has left the drawn slot (answered, the
    // child died, the session closed), so its minimize mark goes with it.
    // The id-keying makes this a belt rather than the braces — a fresh
    // question has a different id and would draw normally anyway — but it
    // keeps the field honest: it never names a request that no longer exists.
    ...(s.modal.kind === 'question' && s.modal.req.id === s.questionMinimizedId
      ? { questionMinimizedId: null }
      : {}),
  };
}

/**
 * Drop every request of one session and re-aim the rendered slot.
 *
 * Used when its child can never answer again — the session was closed, or the
 * child died. A request left behind would keep the session's dot amber for
 * ever with nothing capable of clearing it, and one sitting in the rendered
 * slot would govern what is drawn, answered and inert long after it became
 * unanswerable.
 *
 * The focus to re-aim at is given, not read off `s`: `detachSession` moves
 * focus to a neighbour in the same write, and reading it off the state would
 * aim the slot at the session being closed.
 */
export function releaseModalsOf(
  s: AppStore,
  key: string,
  activeKey: string | null,
): Partial<AppStore> {
  if (!s.pendingModals.some((entry) => entry.key === key)) return {};
  const rest = s.pendingModals.filter((entry) => entry.key !== key);
  return { pendingModals: rest, modal: headForActive(rest, activeKey) };
}
