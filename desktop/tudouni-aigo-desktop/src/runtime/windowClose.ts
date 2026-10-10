/**
 * What the window's X button does, and how that choice is remembered.
 *
 * The X button used to mean one thing: finish every session and exit. It now
 * means one of two — **minimize** (the window hides, every session keeps
 * running, a turn in flight is not cut in half) or **close** (every child is
 * asked to finish, and the application exits) — and the difference is large
 * enough that the application asks rather than guessing.
 *
 * ## Why the prompt exists at all
 *
 * Not because closing is dangerous: `runtime_shutdown` is graceful and a turn
 * that is running is allowed to finish. It is because the two outcomes are
 * indistinguishable *before* the fact and entirely different *after* it. A
 * person who meant "get this out of my way" and got "every session ended" has
 * lost work; a person who meant "I am done" and got "the window is in the tray"
 * thinks the application is broken. One question removes both.
 *
 * ## Where the answer lives
 *
 * In this front end, with the rest of the person's preferences (`aigo.prefs`),
 * and not in the Rust side. That split is not arbitrary: Rust holds the *events*
 * (`CloseRequested`, the prompt's deadline, the children's teardown) and the
 * front end holds *preferences*, which is the same division the workspace list,
 * the rail widths and quiet mode already follow. Rust therefore always asks, and
 * the front end decides whether asking the person is necessary — see
 * `useWindowClose`.
 *
 * ## The three states, and why the default is `ask`
 *
 * `ask` is not merely the starting value: it is also **what an unreadable stored
 * value falls back to** (`readClosePolicy`). A corrupted or hand-edited
 * preference must never silently pick a behaviour — and both of the real choices
 * are unpleasant to be given by surprise. Falling back to `ask` is the only
 * option that can be wrong without costing anything, because it asks.
 */

/**
 * What a close request should do.
 *
 * `ask` is the absence of a remembered choice rather than a third action. It is
 * spelled as a member of the union anyway, because it *is* one of the three
 * things the settings row offers and the field is what gets stored — modelling
 * it as `null` would put the distinction "no preference" versus "a preference
 * that happens to be ask" into every reader for no gain.
 */
export type ClosePolicy = 'ask' | 'minimize' | 'close';

/** What the settings row offers, in the order it offers them. */
export const CLOSE_POLICIES: ClosePolicy[] = ['ask', 'minimize', 'close'];

/**
 * Read a stored policy, refusing anything that is not one of the three.
 *
 * **Unrecognised falls back to `ask`, and that direction is the decision.** This
 * is `localStorage`, so it outlives every build, and a value this function did
 * not write is either a leftover from an older version or something a person
 * edited. Both of the real choices are wrong to apply without being asked for:
 * `close` ends every session, and `minimize` leaves a window the person believes
 * they closed. `ask` is safe precisely because it does not act.
 *
 * Pure, and exported, so the fallback can be asserted without a browser.
 */
export function readClosePolicy(raw: unknown): ClosePolicy {
  return raw === 'minimize' || raw === 'close' ? raw : 'ask';
}

/**
 * Whether a close request needs to be put to the person.
 *
 * A remembered choice is applied directly: the whole point of remembering is
 * that the second time is not a question. This is the one line that makes
 * "remember" mean anything, and it is separated out so it can be read as the
 * rule it is rather than as a condition buried in an event handler.
 *
 * **It is a type predicate, and that is load-bearing rather than decorative.**
 * The caller's shape is "if this is not `ask`, hand the policy straight to the
 * bridge" — and the bridge answers `'minimize' | 'close'`, because `ask` is not
 * something a window can be told to do. Written to return a bare `boolean` this
 * function would leave `'ask'` in the caller's union and the call would not
 * typecheck; narrowing it here is what keeps the rule in one place instead of
 * making every call site restate it as an explicit comparison.
 */
export function needsPrompt(policy: ClosePolicy): policy is 'ask' {
  return policy === 'ask';
}
