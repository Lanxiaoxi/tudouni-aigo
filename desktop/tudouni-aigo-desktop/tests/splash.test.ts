/**
 * When the launch splash may be retired.
 *
 * The splash is a window of its own, so every wrong answer here is visible for
 * the length of a launch and every right answer is invisible — the definition of
 * a rule that has to be asserted rather than looked at:
 *
 *   - a `welcome` that is only *transient* (no session attached yet) must not
 *     retire it, or the greeting is shown and then "starting" appears behind it;
 *   - a settled start-up that is still `booting` (the child exists, the
 *     handshake has not landed) must not either, or the booting screen replaces
 *     the icon that was covering it;
 *   - a window-level failure must, immediately — the splash would otherwise hide
 *     the only screen that says what happened.
 *
 * `splash.html` and `src-tauri/src/splash.rs` are read as text for the three
 * things a document cannot otherwise prove: that the splash holds no script (the
 * whole point of it being a still image), that it honours reduced motion, and
 * that the two ends agree on the event's name. The event name is the one link
 * between the two sides that has no type to catch it drifting.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SPLASH_READY_COMMAND, shouldDismissSplash, type SplashHandoverInput } from '@/splash';

/** A launch that has not reached an end and is looking at "starting…". */
function booting(overrides: Partial<SplashHandoverInput> = {}): SplashHandoverInput {
  return {
    bootSettled: false,
    startupProblem: null,
    view: 'booting',
    ...overrides,
  };
}

/* ============================================================
   The ordinary hand-overs
   ============================================================ */

test('a settled start-up on the transcript retires the splash', () => {
  assert.equal(shouldDismissSplash(booting({ bootSettled: true, view: 'stream' })), true);
});

test('a settled start-up on the greeting retires the splash', () => {
  // `ready && !hasConversation` — a fresh session that has said nothing yet. The
  // greeting is the first screen, so this is the ordinary second launch.
  assert.equal(shouldDismissSplash(booting({ bootSettled: true, view: 'welcome' })), true);
});

test('a settled start-up on the board or in a shell retires the splash', () => {
  assert.equal(shouldDismissSplash(booting({ bootSettled: true, view: 'board' })), true);
  assert.equal(shouldDismissSplash(booting({ bootSettled: true, view: 'terminal' })), true);
});

/* ============================================================
   The two ways it must not fire early
   ============================================================ */

test('the transient welcome before any session is attached does not count', () => {
  // No session is open yet, so the column says `welcome` — and the first session
  // is about to be attached, which will flip the column to `booting`. A rule
  // that read the view alone would hand over to an empty greeting and then put
  // "starting" up behind it.
  assert.equal(shouldDismissSplash(booting({ bootSettled: false, view: 'welcome' })), false);
});

test('a settled start-up still looking at "starting…" does not count', () => {
  // `attachSession` resolving means the child exists; it does not mean the
  // handshake landed. This is the stretch the splash exists to cover.
  assert.equal(shouldDismissSplash(booting({ bootSettled: true, view: 'booting' })), false);
});

/* ============================================================
   The failures it must reveal
   ============================================================ */

test('a window-level failure retires the splash without waiting for the chain', () => {
  // No runtime at all: there is no session to attach, so `bootSettled` may never
  // be set — and the error screen is the first screen rather than a moment on
  // the way to one.
  assert.equal(
    shouldDismissSplash(
      booting({ bootSettled: false, startupProblem: 'no runtime binary', view: 'startup-problem' }),
    ),
    true,
  );
});

test('a refused session reveals its own failure panel', () => {
  assert.equal(
    shouldDismissSplash(booting({ bootSettled: true, startupProblem: null, view: 'session-problem' })),
    true,
  );
});

/* ============================================================
   The mechanism, which is the half that actually shipped broken
   ============================================================ */

test('settling the boot notifies the store and does not wait for a render', async () => {
  // The defect this pins was not in the rule but in where the rule ran. As an
  // effect in `App` it was correct and useless: the main window is hidden while
  // this decision is made, and React does not schedule effects for a renderer
  // that is not being presented. Measured, the chain settled at 290 ms and the
  // effect first ran at 32.7 s. So the decision moved to a store subscription,
  // and this asserts the half that makes that possible: settling the boot is a
  // **store write**, delivered synchronously to subscribers, with no renderer
  // involved anywhere.
  const { markBootSettled, isBootSettled } = await import('@/splash');
  const { useApp } = await import('@/state/store');

  if (isBootSettled()) {
    // The latch is process-wide and this suite may run after another test has
    // already settled it; nothing to assert then.
    return;
  }

  const seen: number[] = [];
  const off = useApp.subscribe((s) => seen.push(s.splashTick));
  const before = useApp.getState().splashTick;

  markBootSettled();

  off();

  assert.equal(isBootSettled(), true, 'the latch is set');
  assert.equal(
    useApp.getState().splashTick,
    before + 1,
    'and the store was written, which is what wakes the subscriber',
  );
  // Synchronous: the notification arrived without any await, microtask, frame or
  // render in between. That is the property a hidden window preserves and a
  // React effect does not.
  assert.deepEqual(seen, [before + 1], 'the subscriber was called once, on the same turn');
});

/* ============================================================
   The two ends, read as text
   ============================================================ */

const root = process.cwd();

const splashHtml = readFileSync(resolve(root, 'splash.html'), 'utf8');
const splashModule = readFileSync(resolve(root, 'src', 'splash.ts'), 'utf8');
const splashRust = readFileSync(resolve(root, 'src-tauri', 'src', 'splash.rs'), 'utf8');

test('splash.html holds no script at all', () => {
  // A still image, by construction: the Rust side never talks to this document,
  // and a script here would be one more thing the first paint waits for.
  assert.equal(/<script/i.test(splashHtml), false, 'splash.html must not carry a script');
  assert.equal(/on[a-z]+=/i.test(splashHtml), false, 'splash.html must not carry inline handlers');
});

test('splash.html honours reduced motion instead of dropping the animation', () => {
  // The icon has to read as alive either way; the media query turns the scale
  // into an opacity pulse rather than taking it away.
  assert.match(splashHtml, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(splashHtml, /@keyframes splash-breathe/);
  assert.match(splashHtml, /@keyframes splash-fade/);
});

test('splash.html draws the icon the bundle already ships', () => {
  // Stronger than "it names a picture": the URL is the one `vite.config.ts`
  // serves from `src-tauri/icons/128x128@2x.png`, so the splash cannot drift
  // away from the packaged icon.
  assert.match(splashHtml, /src="\/splash-icon\.png"/);
  assert.match(
    readFileSync(resolve(root, 'vite.config.ts'), 'utf8'),
    /src-tauri[\\/]icons[\\/]128x128@2x\.png/,
  );
});

test('the two ends agree on how the front end says it is ready', () => {
  // The link between the front end and Rust has no type to catch it drifting:
  // rename the command on one side and the splash never hands over — silently,
  // because an invoke for an unregistered command rejects only where the caller
  // looks, and a missing listener has no such courtesy at all. That is the
  // launch this suite was written after: both sides logged their half, and the
  // window waited out the deadline.
  assert.equal(SPLASH_READY_COMMAND, 'splash_ready');
  assert.match(splashModule, /SPLASH_READY_COMMAND = 'splash_ready'/);
  assert.match(splashRust, /pub\(crate\) async fn splash_ready\(/);
  // And the command is registered, or the invoke above rejects at runtime.
  const libRs = readFileSync(resolve(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.match(libRs, /crate::splash::splash_ready/);
});

test('the rust deadline outlasts any plausible handshake, and the linger is short', () => {
  // Two numbers with opposite jobs: the deadline must not cut a slow launch
  // short, and the linger must not be a second of splash over a live window.
  assert.match(splashRust, /HANDOVER_TIMEOUT: Duration = Duration::from_secs\(20\)/);
  assert.match(splashRust, /SPLASH_LINGER: Duration = Duration::from_millis\(150\)/);
});
