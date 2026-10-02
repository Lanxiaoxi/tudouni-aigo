/**
 * What the conversation column shows, and the order that decides it.
 *
 * This is the regression suite for one press: **"New terminal" on the first
 * screen**. Measured on `cfd5836`, it produced a screen with no terminal and no
 * input box at all — the greeting was drawn over a running shell, and the
 * composer had withdrawn because a shell owned the keyboard. The only control
 * that could have left that state lives inside the view that was not drawn, so
 * it was a deadlock with a plausible-looking screen.
 *
 * Every layer was individually right, which is why this survived a green suite:
 *
 *   - `TerminalView` withdraws the composer and every keystroke goes to the
 *     shell — correct, and asserted in `terminal.test.ts`;
 *   - the first screen is shown whenever `ready && !hasConversation` — correct
 *     for a conversation nobody has spoken into;
 *   - and the two conditions were answered by **two separate expressions** in
 *     `App`, one for the view and one for the composer.
 *
 * That last point is the defect, and it is not visible in a rendered string:
 * "which of the six things is on screen" is a *priority order*, and it was
 * written as a chain of ternaries where an ordering mistake reads as ordinary
 * code. So the order is now one pure function and these tests drive it
 * directly — the same reason `listKeyAction`, `focusIsInTerminal`,
 * `contentBoxOf` and `resolveAttachWorkspace` are pure.
 *
 * The bug is *pairwise*: no single branch is wrong, so the assertions below come
 * in pairs — "the terminal wins over X" **and** "the composer is still drawn
 * when X wins". A test that only checked one of the two would have passed on the
 * broken code.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  conversationView,
  showsComposer,
  type ConversationViewInput,
} from '@/conversationView';

/** A healthy, ready session with a conversation in it — the ordinary screen. */
function healthy(overrides: Partial<ConversationViewInput> = {}): ConversationViewInput {
  return {
    startupProblem: false,
    sessionProblem: false,
    attachedTerminalId: null,
    hasSession: true,
    ready: true,
    hasConversation: true,
    ...overrides,
  };
}

/* ============================================================
   The reported defect
   ============================================================ */

test('a terminal attached on the first screen draws the terminal, not the greeting', () => {
  // The exact state the report came from: a workspace with a live shell and a
  // conversation nobody has spoken into yet. Clicking "New terminal" in the
  // terminal panel attaches — and `ready && !hasConversation` was still true, so
  // the greeting won and the shell was invisible.
  const input = healthy({ hasConversation: false, attachedTerminalId: 'term-01' });

  assert.equal(
    conversationView(input),
    'terminal',
    'the first screen must not be drawn over a shell somebody just opened',
  );
});

test('and the composer comes back with it, because that is the way out', () => {
  // The other half, and the half that made it a deadlock rather than an
  // inconvenience. The composer withdrew on the *attach* alone, so this screen
  // had neither the terminal nor the input box. Drawing the terminal restores
  // the tab strip, which carries the named "back to the conversation" button —
  // so "the terminal wins" is what makes the state escapable at all.
  const input = healthy({ hasConversation: false, attachedTerminalId: 'term-01' });
  const view = conversationView(input);

  assert.equal(
    showsComposer(view),
    false,
    'the shell owns the keyboard, so a text box under it would accept nothing',
  );
  // And the thing that replaced the composer is the terminal itself.
  assert.equal(view, 'terminal');
});

test('an attached terminal outranks "starting the runtime…" too', () => {
  // The same ordering, reached from the other side: a fresh session's shell can
  // be attached in the window before `init` lands. `Booting` used to be tested
  // before the attach as well, so the shell was hidden behind a sentence about a
  // process that was in fact answering.
  const input = healthy({ ready: false, hasConversation: false, attachedTerminalId: 'term-01' });
  assert.equal(conversationView(input), 'terminal');
});

test('the composer is drawn for every view except the terminal', () => {
  // The contract in one assertion, so a seventh view added later cannot be
  // forgotten here: only a shell takes the keyboard away.
  const others: ConversationViewInput[] = [
    healthy({ startupProblem: true }),
    healthy({ sessionProblem: true }),
    healthy({ hasConversation: false }),
    healthy({ ready: false }),
    healthy({ hasSession: false }),
    healthy(),
  ];
  for (const input of others) {
    const view = conversationView(input);
    assert.notEqual(view, 'terminal');
    assert.equal(showsComposer(view), true, `${view} must leave the composer in place`);
  }
});

/* ============================================================
   The order, pair by pair
   ============================================================ */

test('a start-up failure outranks everything, shells included', () => {
  // Without a runtime there are no shells either, so the reason and the two ways
  // out are the only useful thing on screen — an attach cannot outrank it.
  assert.equal(
    conversationView(healthy({ startupProblem: true, attachedTerminalId: 'term-01' })),
    'startup-problem',
  );
  assert.equal(
    conversationView(healthy({ startupProblem: true, sessionProblem: true })),
    'startup-problem',
  );
});

test('one session\'s own failure outranks a terminal, but not the window\'s', () => {
  // A child that refused to start belongs to the conversation somebody asked
  // for, and the window may be running others happily. It is checked before the
  // attach for the same reason it is checked before `Booting`: it never becomes
  // ready, so anything else drawn here would be a sentence over a process that
  // gave up.
  assert.equal(
    conversationView(healthy({ sessionProblem: true, attachedTerminalId: 'term-01' })),
    'session-problem',
  );
});

test('a session\'s failure outranks "not ready", which is the point of it', () => {
  // `problem` is only ever set on a bucket that is not ready — the refusal is
  // why it never became ready — so if `Booting` were tested first the failure
  // would be permanently invisible.
  assert.equal(conversationView(healthy({ sessionProblem: true, ready: false })), 'session-problem');
});

test('no session open is the first screen, never "starting the runtime…"', () => {
  // Closing the last session is a normal state now: there is no child to boot,
  // so `ready` can never become true and `Booting` would be a sentence about a
  // process nobody started.
  assert.equal(conversationView(healthy({ hasSession: false, ready: false })), 'welcome');
  // Even with a conversation still in the bucket it is leaving.
  assert.equal(conversationView(healthy({ hasSession: false, hasConversation: true })), 'welcome');
});

test('the first screen needs a ready session with nothing said in it', () => {
  // Only notices in the stream: `session_load` has not landed, or the session is
  // fresh. The handshake's own sentences are not a conversation.
  assert.equal(conversationView(healthy({ hasConversation: false })), 'welcome');
  // A session still starting, with nothing said yet, says so instead.
  assert.equal(conversationView(healthy({ ready: false, hasConversation: false })), 'booting');
});

test('a conversation on screen is the transcript', () => {
  assert.equal(conversationView(healthy()), 'stream');
});
