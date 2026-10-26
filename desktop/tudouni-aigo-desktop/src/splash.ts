/**
 * When the launch splash has done its job, and the one event that says so.
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
 *     greeting and then put "starting" up behind it. `bootSettled` is set only
 *     when the start-up chain has reached an end (a session attached, no
 *     remembered workspace, a refused workspace, a failed listener, a plain
 *     browser), which is exactly the moment the view becomes an answer rather
 *     than a moment on the way to one.
 *   - `view !== 'booting'` gates the *ongoing* one. A settled start-up can still
 *     be looking at "Starting the runtime…" — the child exists, the handshake
 *     has not landed — and handing over then would show the booting screen,
 *     which is the thing the splash was covering.
 *
 * A window-level `startupProblem` bypasses the first gate because there is no
 * session to attach and never will be: the very first screen is the error, and
 * the splash would otherwise hide the only useful thing on it.
 */
import type { ConversationView } from '@/conversationView';
import { isHosted } from '@/runtime/tauri';

/** The event Rust's `splash::arm` listens for, emitted at most once. */
export const SPLASH_READY_EVENT = 'splash://ready';

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
  bootSettled = true;
}

/** Whether `markBootSettled` has been called in this document. */
export function isBootSettled(): boolean {
  return bootSettled;
}

/** The event is sent once per document, whatever the render cadence. */
let handedOver = false;

/**
 * Hand the screen to the main window, if this is the moment — at most once.
 *
 * Called from `App` on every render of the decision, and the latch is what makes
 * that safe: the store updates many times during a boot (each message repaints),
 * and every one of those would otherwise emit again. Emitting twice would not
 * break the handover — Rust listens `once_any`, and every step of the handover
 * is idempotent — but a promise kept once is easier to reason about than one
 * kept N times.
 *
 * `isHosted()` is checked before emitting because a plain browser has no Rust
 * side to hear it: `npm run dev` should not produce a stack trace about an IPC
 * that does not exist. The latch is claimed either way, so a browser dev loop
 * cannot emit later against a Tauri host that appeared mid-session.
 */
export async function handOverSplashIfDue(input: SplashHandoverInput): Promise<void> {
  if (handedOver) return;
  if (!shouldDismissSplash(input)) return;
  handedOver = true;
  if (!isHosted()) return;

  // Imported lazily, the same way the bridge imports its own Tauri modules: the
  // event API only exists under a Tauri host, and this module is loaded by the
  // test runner and the browser build as well.
  const event = await import('@tauri-apps/api/event');
  await event.emit(SPLASH_READY_EVENT);
}
