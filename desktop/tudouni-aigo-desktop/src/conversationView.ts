/**
 * What the conversation column is showing, as one decision in one place.
 *
 * The column has six mutually exclusive occupants — a start-up failure, one
 * session's own failure, the session board (or the ticket board), the first
 * screen, "starting the runtime…", and the transcript — and which one wins is a
 * **priority order**, not a set of independent conditions. Written inline as a
 * chain of ternaries in `App` it was easy to read and hard to see.
 *
 * (There used to be a seventh, an attached terminal that took over the column
 * and the keyboard. Terminals now live in the Workspace Dock's terminal area, so
 * nothing here can strand the person over a shell any more.)
 *
 * Ordering, and the reasons, top down:
 *
 *   1. **A start-up failure.** With no runtime there is no session either, so
 *      this outranks everything — the reason and the way out are the only
 *      useful thing on screen.
 *   2. **One session's refusal to start.** A child that would not start belongs
 *      to the conversation somebody asked for, and the window may be running
 *      others happily; it must be said before "starting…" is printed over a
 *      process that already gave up.
 *   3. **The session board.** Above the first screen: the board exists for
 *      "three or four sessions are running, let me look at all of them", and
 *      that is precisely the state in which the session on screen has *just*
 *      spoken or has *not* spoken yet — so a board placed under the first
 *      screen would be covered by it in the case it was built for. The board
 *      keeps its own exits (Esc, its close control, and clicking a card).
 *   4. **The first screen.** No session at all, or one with nothing said in it
 *      yet. A fresh session reaches `ready` with only notices in its stream, so
 *      "no conversation" is the right test rather than "not ready".
 *   5. **"Starting the runtime…".** Reached only with a session that is not
 *      ready and has not failed.
 *   6. **The transcript.**
 *
 * Pure, and exported, so the order can be asserted without a window: the
 * mistake is a wrong branch, it throws nothing, and the screen it produces looks
 * plausible.
 */
import type { BoardKind } from '@/state/storeShape';

export type ConversationView =
  | 'startup-problem'
  | 'session-problem'
  | 'board'
  // The ticket board: same slot and same reasons as the session board (4).
  | 'tickets'
  | 'welcome'
  | 'booting'
  | 'stream';

export interface ConversationViewInput {
  /** `AppStore.startupProblem` — the window has no runtime at all. */
  startupProblem: boolean;
  /** `SessionRuntime.problem` — this session's child would not start. */
  sessionProblem: boolean;
  /**
   * `AppStore.board` — which board is showing, if any.
   *
   * Window-level, deliberately not read off the session on screen: a board
   * answers a question about every session (or every ticket), which is not a
   * fact about one conversation. It is still *ordered* here, because the column
   * can only draw one thing at a time.
   */
  board: BoardKind | null;
  /** `AppStore.activeKey !== null`. */
  hasSession: boolean;
  /** `SessionRuntime.ready`. */
  ready: boolean;
  /** Anything in the stream that is not a runtime notice. */
  hasConversation: boolean;
}

export function conversationView(input: ConversationViewInput): ConversationView {
  if (input.startupProblem) return 'startup-problem';
  if (input.sessionProblem) return 'session-problem';
  // Above the first screen — see the header. It has no `hasSession`/`ready` condition on purpose: those describe the session
  // on screen, and the board is about all of them. A workspace whose session
  // just spoke, one that has not spoken yet, and one that is still booting are
  // all states the board must be reachable from.
  if (input.board === 'sessions') return 'board';
  if (input.board === 'tickets') return 'tickets';
  if (!input.hasSession || (input.ready && !input.hasConversation)) return 'welcome';
  if (!input.ready) return 'booting';
  return 'stream';
}

/**
 * The same decision, read straight off the store.
 *
 * **Not a second definition**: it is `conversationView` applied to the fields
 * `App` would have read, so a caller with a store rather than a render can ask
 * the same question. Two callers need it without a component — the modal
 * visibility rule, and the splash hand-over, which runs from a store
 * subscription precisely because React's effects do not run in a hidden
 * window (see `src/splash.ts`).
 */
export function conversationViewOf(s: {
  startupProblem: string | null;
  activeKey: string | null;
  board: BoardKind | null;
  sessions: Record<string, { problem: string | null; ready: boolean; entries: { kind: string }[] } | undefined>;
}): ConversationView {
  const rt = s.activeKey === null ? undefined : s.sessions[s.activeKey];
  return conversationView({
    startupProblem: s.startupProblem !== null,
    sessionProblem: rt?.problem != null,
    board: s.board,
    hasSession: s.activeKey !== null,
    ready: rt?.ready ?? false,
    hasConversation: (rt?.entries ?? []).some((entry) => entry.kind !== 'note'),
  });
}

/**
 * Whether the composer is drawn under the column.
 *
 * It is derived from the view rather than from scattered conditions, so the
 * view and the input box cannot disagree about one decision.
 *
 * The boards withdraw it: the composer sends into "the conversation on screen",
 * and while a board is up there **is** no conversation on screen — only a list
 * of them (or of work). A text box there would be a message with no addressee,
 * and clicking a card is the gesture that gives it one again.
 */
export function showsComposer(view: ConversationView): boolean {
  return view !== 'board' && view !== 'tickets';
}

/**
 * Whether the transcript is the column's occupant.
 *
 * The find bar lives inside the transcript (`StreamView` draws it and runs the
 * scan), so "can anything be searched right now" is exactly this question — not
 * "is a session open". On a board there is no conversation text on
 * screen, and a search control there would be a button whose press produces
 * nothing; that is why the bar is not drawn.
 *
 * It is the composer's rule read from the other end: the composer is withheld
 * from two occupants, the find bar is offered in only one.
 */
export function showsTranscript(view: ConversationView): boolean {
  return view === 'stream';
}
