/**
 * What the conversation column is showing, as one decision in one place.
 *
 * The column has six mutually exclusive occupants — a start-up failure, one
 * session's own failure, an attached terminal, the first screen, "starting the
 * runtime…", and the transcript — and which one wins is a **priority order**,
 * not a set of independent conditions. Written inline as a chain of ternaries in
 * `App` it was easy to read and hard to see: two of the six, an attached
 * terminal and the first screen, were in the wrong order and nothing about the
 * markup showed it.
 *
 * **The defect that put the terminal above the first screen, and why tests
 * missed it.** Attaching a shell writes `activeTerminalId`, and everything else
 * keyed off that fact behaved — the composer withdrew, because a terminal owns
 * the keyboard — except the view itself, which was tested *after* the first
 * screen. Opening a terminal in a workspace with no conversation yet therefore
 * drew the greeting over a shell that was already running, with **the composer
 * gone as well** (it keys off the same attach). So the screen lost its input box
 * *and* showed no terminal, and the only control that could have detached —
 * the one inside `TerminalView` — was the view that was not being drawn. That is
 * a deadlock reached from a single press of "New terminal" on the first screen,
 * and every existing test passed through it, because each layer's behaviour was
 * individually right.
 *
 * Ordering, and the reasons, top down:
 *
 *   1. **A start-up failure.** With no runtime there is no session and no shell
 *      either, so this outranks everything — the reason and the way out are the
 *      only useful thing on screen.
 *   2. **One session's refusal to start.** A child that would not start belongs
 *      to the conversation somebody asked for, and the window may be running
 *      others happily; it must be said before "starting…" is printed over a
 *      process that already gave up.
 *   3. **An attached terminal.** Above both the first screen and "starting…",
 *      and this is the load-bearing line. It is a deliberate act with a live
 *      shell behind it, and `TerminalView` is the *only* place the way out
 *      lives — so a priority order that can hide it strands the person in a
 *      state they cannot leave.
 *   4. **The first screen.** No session at all, or one with nothing said in it
 *      yet. A fresh session reaches `ready` with only notices in its stream, so
 *      "no conversation" is the right test rather than "not ready".
 *   5. **"Starting the runtime…".** Reached only with a session that is not
 *      ready and has not failed.
 *   6. **The transcript.**
 *
 * Pure, and exported, so the order can be asserted without a window: the
 * mistake is a wrong branch, it throws nothing, and the screen it produces looks
 * plausible — which is exactly the class of defect the other pure helpers in
 * this tree (`focusIsInTerminal`, `listKeyAction`, `contentBoxOf`,
 * `resolveAttachWorkspace`) exist to make assertable.
 */
export type ConversationView =
  | 'startup-problem'
  | 'session-problem'
  | 'terminal'
  | 'welcome'
  | 'booting'
  | 'stream';

export interface ConversationViewInput {
  /** `AppStore.startupProblem` — the window has no runtime at all. */
  startupProblem: boolean;
  /** `SessionRuntime.problem` — this session's child would not start. */
  sessionProblem: boolean;
  /** `SessionRuntime.activeTerminalId`, read from the session on screen. */
  attachedTerminalId: string | null;
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
  // Deliberately before the two below — see the header. Attaching takes the
  // keyboard away from the composer, so a priority order that drew anything
  // else here would take the input box *and* withhold the shell.
  if (input.attachedTerminalId !== null) return 'terminal';
  if (!input.hasSession || (input.ready && !input.hasConversation)) return 'welcome';
  if (!input.ready) return 'booting';
  return 'stream';
}

/**
 * Whether the composer is drawn under the column.
 *
 * It is derived from the view rather than from `activeTerminalId`, and that is
 * the other half of the same fix. The two used to be separate statements about
 * one decision — the view asked "is a terminal attached *and* is nothing else
 * winning", while the composer asked only "is a terminal attached" — so they
 * could disagree, and when they did the composer vanished with nothing in its
 * place. One view, one answer.
 *
 * A terminal owns every keystroke while it has the screen (`TerminalView`), so a
 * text box under the output would be a control that cannot accept input, and
 * its `+` and send button gestures that do nothing.
 */
export function showsComposer(view: ConversationView): boolean {
  return view !== 'terminal';
}
