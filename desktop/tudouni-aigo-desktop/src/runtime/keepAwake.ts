/**
 * Keep the screen awake while a session is working, or let it sleep otherwise.
 *
 * A turn can run for hours, and nothing the runtime does tells the operating
 * system that work is happening — so Windows locks the screen on schedule in
 * the middle of a long task, which is the reported bug this exists to fix.
 *
 * The rule is deliberately narrow: the window is held awake **while a turn is
 * in flight, in any open session**, and only then. An app that merely sits
 * open must not suppress the system's power policy for its whole life — that
 * is a worse habit than the bug it would cure, on a laptop with a battery.
 *
 * The *fact* — whether a turn is running — is the front end's, from the
 * transcript (`hasRunningTurn`, the same source `selectPhase` reads). This
 * module only decides what to **send** for a given count and talks to the OS
 * through the Rust command; the count itself is owned by the caller.
 */

import { isHosted } from './tauri';

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

/**
 * Ask the OS to keep the display awake, or to stop.
 *
 * The Rust command is idempotent (calling it twice with the same value is a
 * no-op on the windowing layer), so a caller may assert the state on every
 * change without remembering what it sent last.
 *
 * A failure is **not fatal and not reported**: a refusal here costs the old
 * behaviour — the screen may lock mid-turn — but it is not a failure of the
 * session, and the session must keep running. A warning is enough; a `notice`
 * would be a sentence about the transcript for something that is not.
 */
export async function setKeepAwake(on: boolean): Promise<void> {
  if (!isHosted()) return;
  try {
    await tauriInvoke('set_prevent_sleep', { on });
  } catch (err) {
    console.warn('could not change the screen-awake state:', err);
  }
}

/**
 * The state the OS should be in, given how many sessions are running a turn.
 *
 * Pure, so the rule can be asserted without an OS. The whole policy is in this
 * one comparison, and it is worth spelling out: zero running sessions means
 * sleep is allowed **even if the app is open**, and one is the same as many —
 * the OS flag has no count of its own.
 */
export function awakeForRunningCount(running: number): boolean {
  return running > 0;
}
