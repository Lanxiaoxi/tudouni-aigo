/**
 * When the launch splash has done its job, and the one call that says so.
 *
 * The splash is a window of its own (`splash.html`, behind `splash::arm` on the
 * Rust side). It exists until the front end can promise that there is something
 * on screen behind it: the handshake has landed and the first screen — the
 * greeting, the transcript, or a stated failure — is drawn. This module owns
 * that promise, because it is the only layer that can see the store.
 *
 * **The rule is one pure function**, and the two halves of it are each a bug
 * that has an obvious wrong version:
 *
 *   - `bootSettled` gates the *transient* first screen. Before the first session
 *     is attached the view is `welcome` for a moment — no session is open yet —
 *     and a rule that read the view alone would lower the splash over an empty
 *     greeting and then put "starting" up behind it.
 *   - `view !== 'booting'` gates the *ongoing* one. A settled start-up can still
 *     be looking at "Starting the runtime…" — the child exists, the handshake
 *     has not landed — and handing over then would show the booting screen,
 *     which is the thing the splash was covering.
 *
 * A window-level `startupProblem` bypasses the first gate because there is no
 * session to attach and never will be: the very first screen is the error, and
 * the splash would otherwise hide the only useful thing on it.
 *
 * **Why the decision is a store subscription and not an effect.** It was an
 * effect in `App` first, reading `view` from a render. That is correct in a
 * visible window and wrong in a hidden one: the main window is hidden for the
 * whole of this decision's life, and React's scheduler does not run effects for
 * a renderer that is not being presented. The measured shape was brutal — the
 * start-up chain finished at 290 ms, `markBootSettled` ran then, and the effect
 * that would have made the call first ran at **32.7 s**, after the 20-second
 * deadline had already shown the window and un-suspended the renderer. The
 * store's `set` is a plain function call and cannot be deferred that way, so the
 * check lives there: a write bumps the subscriber, which makes the call.
 */
import { conversationViewOf, type ConversationView } from '@/conversationView';
import { useApp, type AppStore } from '@/state/store';
import { isHosted } from '@/runtime/tauri';

/** The command Rust's `splash::splash_ready` answers. */
export const SPLASH_READY_COMMAND = 'splash_ready';

export interface SplashHandoverInput {
  /** The start-up chain reached one of its end points (see `markBootSettled`). */
  bootSettled: boolean;
  /** `AppStore.startupProblem`: the window has no runtime at all. */
  startupProblem: string | null;
  /** Which of the seven things the conversation column is drawing. */
  view: ConversationView;
}

/**
 * Whether the splash may be retired now.
 *
 * Pure, so the two wrong rules above can be asserted rather than watched for:
 * both produce a plausible-looking launch — an empty greeting with "starting"
 * behind it, or a booting shell where the icon was — and neither throws.
 */
export function shouldDismissSplash(input: SplashHandoverInput): boolean {
  const settled = input.bootSettled || input.startupProblem !== null;
  return settled && input.view !== 'booting';
}

/**
 * Whether the start-up chain has reached an end, once and for all.
 *
 * A latch rather than a store field because it is a *history* fact — "this
 * launch finished starting" — rather than a value that is ever set back. The
 * callers are the end points of `useRuntimeBridge`; there is no path that
 * clears it, which is the whole reason a transient `welcome` cannot retire the
 * splash early.
 */
let bootSettled = false;

/** Record that the start-up chain has reached an end. Idempotent. */
export function markBootSettled(): void {
  if (bootSettled) return;
  bootSettled = true;
  // Wake the subscriber. A store write is a plain function call on the turn of
  // the event loop that made the change — no renderer, no paint, no scheduler —
  // which is what makes it work in the hidden main window. See the module doc.
  useApp.setState((s) => ({ splashTick: s.splashTick + 1 }));
}

/** Whether `markBootSettled` has been called in this document. */
export function isBootSettled(): boolean {
  return bootSettled;
}

/** The call is sent once per document, whatever the update cadence. */
let asked = false;

/**
 * Hand the screen to the main window, if this is the moment — at most once.
 *
 * **Why this is `invoke` and not `emit`.** An earlier version emitted
 * `splash://ready`, and a launch after a quit proved why that is the wrong
 * mechanism: both launches logged that they had emitted, and Rust logged that it
 * had received neither. An **event has no queue**: it is delivered to whatever
 * happens to be listening at that instant, and a one-shot listener that is armed
 * or isn't is not something the sender can observe. A command is a request with
 * an answer: ordered against the rest of the window's IPC, impossible to deliver
 * to nobody, and the caller finds out if it failed.
 *
 * `isHosted()` is checked before invoking because a plain browser has no Rust
 * side to hear it: `npm run dev` should not produce a stack trace about an IPC
 * that does not exist. The latch is claimed either way, so a browser dev loop
 * cannot invoke later against a Tauri host that appeared mid-session.
 */
export async function handOverSplashIfDue(input: SplashHandoverInput): Promise<void> {
  if (asked) return;
  if (!shouldDismissSplash(input)) return;
  asked = true;
  if (!isHosted()) return;

  // Imported lazily, the same way the bridge imports its own Tauri modules: the
  // invoke API only exists under a Tauri host, and this module is loaded by the
  // test runner and the browser build as well.
  const core = await import('@tauri-apps/api/core');
  try {
    await core.invoke<boolean>(SPLASH_READY_COMMAND);
  } catch (err) {
    // No retry, and deliberately loud rather than silent: the deadline in
    // `splash.rs` still hands the window over, so this costs a delay rather than
    // a launch — but a failure here is the one thing that would explain that
    // delay, and it must not be swallowed into a console nobody reads after the
    // fact.
    console.error(`[splash] could not hand over to the main window: ${String(err)}`);
  }
}

/**
 * Watch the store and make the call when the rule says so.
 *
 * Called once from `main.tsx`, outside React, for the reason in the module doc:
 * a hidden renderer's effects are not scheduled, and this decision is made
 * entirely while the window is hidden.
 *
 * Subscribed to the **whole store** rather than a slice: one predicate is
 * simpler than three subscriptions whose values each need the other two, and the
 * write is already happening — the comparison costs one call to
 * `conversationViewOf`.
 */
export function watchSplashHandover(): void {
  let lastKey = '';

  const check = (s: AppStore): void => {
    const input: SplashHandoverInput = {
      bootSettled: isBootSettled(),
      startupProblem: s.startupProblem,
      view: conversationViewOf(s),
    };
    // Only call through when the answer could have changed: this runs on every
    // store write, and a stream repaints hundreds of times.
    const key = `${input.bootSettled}|${input.startupProblem !== null}|${input.view}`;
    if (key === lastKey) return;
    lastKey = key;
    void handOverSplashIfDue(input);
  };

  useApp.subscribe(check);
  // The store may already have settled while this module was loading — a reload
  // finishes the boot before `main.tsx` gets here — so the first look is not an
  // optimisation.
  check(useApp.getState());
}
