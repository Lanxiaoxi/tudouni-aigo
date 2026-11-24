/**
 * What the conversation column shows, and the order that decides it.
 *
 * "Which of the six things is on screen" is a *priority order*, and a wrong
 * order reads as ordinary code and draws a plausible-looking screen. So the
 * order is one pure function and these tests drive it directly.
 *
 * The suite used to be the regression test for an attached terminal that took
 * the column and the keyboard (`TerminalView`). Terminals now live in the
 * Workspace Dock, so that occupant and its priority rules are gone; what is
 * left is the order of the rest, in pairs: "X wins over Y" **and** "the
 * composer is still drawn when Y wins".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  conversationView,
  showsComposer,
  showsTranscript,
  type ConversationViewInput,
} from '@/conversationView';

/** A healthy, ready session with a conversation in it — the ordinary screen. */
function healthy(overrides: Partial<ConversationViewInput> = {}): ConversationViewInput {
  return {
    startupProblem: false,
    sessionProblem: false,
    board: null,
    hasSession: true,
    ready: true,
    hasConversation: true,
    ...overrides,
  };
}

test('the composer is drawn for every view except the boards', () => {
  // The contract in one assertion, so a view added later cannot be forgotten
  // here: only the boards withdraw it, because there is no single conversation
  // to speak into while one is up.
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
    assert.notEqual(view, 'board');
    assert.notEqual(view, 'tickets');
    assert.equal(showsComposer(view), true, `${view} must leave the composer in place`);
  }
  assert.equal(showsComposer('board'), false, 'the board has no addressee, so no composer');
  assert.equal(showsComposer('tickets'), false, 'nor does the ticket board');
});

test('find is offered only while the transcript is the column', () => {
  // The find bar is drawn **by** the transcript, so this is the whole condition
  // for "there is something to search": not "is a session open" — four of the
  // seven occupants have one. `App` hands the same answer to the session bar,
  // which is why a wrong rule here would put a search button on screen whose
  // press produced nothing.
  //
  // Driven from **inputs** rather than a list of view names, like the composer
  // contract above: an eighth occupant added later cannot be forgotten here.
  const inputs: ConversationViewInput[] = [
    healthy({ startupProblem: true }),
    healthy({ sessionProblem: true }),
    healthy({ board: 'sessions' }),
    healthy({ hasConversation: false }),
    healthy({ ready: false }),
    healthy(),
  ];
  const views = inputs.map(conversationView);
  // Six inputs, six occupants: if two of them ever collapse onto one view,
  // the priority order has lost a branch, and the loop below would silently stop
  // covering one of them.
  assert.equal(new Set(views).size, inputs.length, `views: ${views.join(', ')}`);
  for (const view of views) {
    assert.equal(
      showsTranscript(view),
      view === 'stream',
      `${view}: find must be ${view === 'stream' ? 'available' : 'unavailable'}`,
    );
  }
  // Spelled out for the two that are easiest to conflate: both show a session,
  // neither shows its text.
  assert.equal(showsTranscript('board'), false);
  assert.equal(showsTranscript('welcome'), false);
  assert.equal(showsTranscript('stream'), true);
});

/* ============================================================
   The order, pair by pair
   ============================================================ */

test('a start-up failure outranks everything', () => {
  // Without a runtime there is no session either, so the reason and the two
  // ways out are the only useful thing on screen.
  assert.equal(conversationView(healthy({ startupProblem: true, board: 'sessions' })), 'startup-problem');
  assert.equal(
    conversationView(healthy({ startupProblem: true, sessionProblem: true })),
    'startup-problem',
  );
});

test('one session\'s own failure outranks the board, but not the window\'s', () => {
  // A child that refused to start belongs to the conversation somebody asked
  // for, and the window may be running others happily.
  assert.equal(conversationView(healthy({ sessionProblem: true, board: 'sessions' })), 'session-problem');
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

/* ============================================================
   The board: above the first screen
   ============================================================ */

test('the board covers the first screen — the case it is built for', () => {
  // The board exists for "three or four sessions are running, let me look at
  // all of them", and that is *precisely* the state in which the session on
  // screen has just spoken or has not spoken yet. Placed under the first screen
  // it would be covered in the one case it was made for.
  assert.equal(conversationView(healthy({ board: 'sessions', hasConversation: false })), 'board');
  assert.equal(conversationView(healthy({ board: 'sessions' })), 'board');
});

test('the board is reachable from a booting and a no-session workspace', () => {
  // It has no `hasSession` / `ready` condition on purpose: those describe the
  // session on screen, and the board is about *all* of them. A workspace whose
  // session is still starting, or has no session open at all, are both states
  // the board must be reachable from — "there is nothing here" is not a reason
  // to hide "what is running".
  assert.equal(conversationView(healthy({ board: 'sessions', ready: false })), 'board');
  assert.equal(conversationView(healthy({ board: 'sessions', hasSession: false })), 'board');
});
