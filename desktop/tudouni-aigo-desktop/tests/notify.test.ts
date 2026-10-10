/**
 * When a session is worth interrupting somebody about, and what the window's X
 * button does.
 *
 * Two features, one suite, because both are the same kind of thing: a **rule**
 * extracted so it can be read on its own and asserted without a window, an OS or
 * a child process. Neither has anything to observe in a rendered string — a
 * notification that should not have been sent and one that should have look
 * identical on screen, and a close policy that forgot a choice simply asks again
 * — so neither can be caught by looking. They have to be written down.
 *
 * The cases below are grouped by the mistake each one prevents, and the two that
 * matter most are:
 *
 *   - **`idle` is not news on its own.** It is where a session that has never
 *     been spoken to sits, and where one goes after being read. Notifying on
 *     either would be an interruption about nothing having happened, and the
 *     cost of getting this wrong is a feature people switch off.
 *   - **A minimized window is nobody's attention.** The most important case for
 *     the whole feature: a turn that ends while the window is hidden and the
 *     session happens to be the one *on screen* would otherwise be judged
 *     "watched" and reported to nobody.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeT } from '@/i18n';
import {
  decodeNotifyRows,
  decodeNotifySnapshot,
  encodeNotifyRows,
  encodeNotifySnapshot,
  isWatched,
  notifyContent,
  notifyDecision,
  notifyReason,
  readNotifyEnabled,
  type NotifyRow,
} from '@/runtime/notify';
import { CLOSE_POLICIES, needsPrompt, readClosePolicy } from '@/runtime/windowClose';
import type { RowStatus } from '@/state/store';

/* ============================================================
   Which transitions are news
   ============================================================ */

test('a session seen for the first time is not news', () => {
  // Its status is simply what it is. At start-up every open session would
  // otherwise produce a notification at once, which is the worst possible first
  // impression for a feature whose whole job is not to be noise.
  for (const status of ['asking', 'broken', 'unseen', 'idle', 'running'] as RowStatus[]) {
    assert.equal(notifyReason(undefined, status), null, `${status} on first sight`);
  }
});

test('an unchanged status is never news, whatever it is', () => {
  // The caller diffs against its last observation, but the rule is written to be
  // correct on its own: a rule that is only true when called correctly is a rule
  // that will be called incorrectly. A second approval while the first is still
  // unanswered leaves the status at `asking`, and one notification is the right
  // number for it.
  for (const status of ['asking', 'broken', 'unseen', 'idle', 'running'] as RowStatus[]) {
    assert.equal(notifyReason(status, status), null, `${status} -> ${status}`);
  }
});

test('a blocking request is the most urgent thing to say', () => {
  assert.equal(notifyReason('running', 'asking'), 'needs-you');
  assert.equal(notifyReason('idle', 'asking'), 'needs-you');
  assert.equal(notifyReason('unseen', 'asking'), 'needs-you');
});

test('a failure is reported as a failure', () => {
  assert.equal(notifyReason('running', 'broken'), 'failed');
  assert.equal(notifyReason('idle', 'broken'), 'failed');
});

test('a finished turn nobody looked at says so', () => {
  assert.equal(notifyReason('running', 'unseen'), 'finished');
});

test('a turn ending while the session is on screen is still announced', () => {
  // The session on screen goes straight back to `idle` (there is no `unseen` for
  // it — `run_finished` only sets that flag when nobody is looking). Whether the
  // person actually saw it is `isWatched`'s question, not this one's: a
  // minimized window is precisely the case where this transition must survive
  // the status being `idle`.
  assert.equal(notifyReason('running', 'idle'), 'finished');
});

test('merely being idle is not news', () => {
  // The grouped assertion this suite exists for. A session that has never been
  // spoken to, and one that was read a moment ago, both sit at `idle` — and
  // neither is something that happened.
  assert.equal(notifyReason('idle', 'idle'), null);
  assert.equal(notifyReason('unseen', 'idle'), null);
  assert.equal(notifyReason('asking', 'idle'), null);
});

test('work starting is not news', () => {
  // Nothing has happened yet that a person could act on, and a toast per turn
  // start would arrive before the work it announces.
  assert.equal(notifyReason('idle', 'running'), null);
  assert.equal(notifyReason('unseen', 'running'), null);
  assert.equal(notifyReason('broken', 'running'), null);
});

/* ============================================================
   Whether anybody is looking
   ============================================================ */

const watched = (over: Partial<Parameters<typeof isWatched>[0]> = {}) => ({
  key: 'k1',
  activeKey: 'k1',
  windowForeground: true,
  modalKey: null,
  modalVisible: false,
  ...over,
});

test('the session on screen in a focused window is being watched', () => {
  assert.equal(isWatched(watched()), true);
});

test('a minimized window is nobody\'s attention', () => {
  // The case the feature exists for, and the reason `activeKey` alone is not the
  // test. A turn that ends while the window is in the tray would otherwise be
  // judged "watched" and reported to nobody at all.
  assert.equal(isWatched(watched({ windowForeground: false })), false);
});

test('an unfocused window is nobody\'s attention either', () => {
  assert.equal(isWatched(watched({ windowForeground: false, activeKey: 'k1' })), false);
});

test('a background session is not watched, however focused the window is', () => {
  // The multi-session case, which is most of the point: four conversations
  // running while somebody reads a fifth is exactly when "one of them finished"
  // is worth saying. If focusing the window silenced every session, the feature
  // would do nothing.
  assert.equal(isWatched(watched({ activeKey: 'k2' })), false);
});

test('a session whose prompt is on screen is watched even in the background', () => {
  // A blocking request is drawn over whatever conversation is on screen, so the
  // session asking need not be `activeKey` while its prompt is perfectly
  // visible. It is being watched, and a notification would be a second copy of
  // something already in front of the person.
  assert.equal(
    isWatched(watched({ activeKey: 'k2', modalKey: 'k1', modalVisible: true })),
    true,
  );
});

test('a prompt that is held rather than drawn does not count as watching', () => {
  // The session board holds the conversation column, and a request arriving there
  // is deliberately unrendered (`selectModalVisible`). Nobody can see it, so
  // nobody is watching — and the notification is the surface that says so.
  assert.equal(
    isWatched(watched({ activeKey: 'k2', modalKey: 'k1', modalVisible: false })),
    false,
  );
});

test('a prompt from a different session is not this session being watched', () => {
  assert.equal(
    isWatched(watched({ activeKey: 'k3', modalKey: 'k2', modalVisible: true })),
    false,
  );
});

/* ============================================================
   The two rules together
   ============================================================ */

test('a transition in a watched session is suppressed, and elsewhere is not', () => {
  const base = { windowForeground: true, modalKey: null, modalVisible: false };
  // On screen and focused: nothing is said.
  assert.equal(notifyDecision('running', 'idle', { ...base, key: 'k1', activeKey: 'k1' }), null);
  // Same transition, another session on screen: said.
  assert.equal(
    notifyDecision('running', 'idle', { ...base, key: 'k1', activeKey: 'k2' }),
    'finished',
  );
  // Same, window minimized: said.
  assert.equal(
    notifyDecision('running', 'idle', {
      ...base,
      key: 'k1',
      activeKey: 'k1',
      windowForeground: false,
    }),
    'finished',
  );
});

test('the watch rule cannot rescue a transition the first rule refuses', () => {
  // Order matters: "not news" outranks "not watched". A background session that
  // is merely idle stays silent.
  assert.equal(
    notifyDecision('idle', 'idle', {
      key: 'k1',
      activeKey: 'k2',
      windowForeground: true,
      modalKey: null,
      modalVisible: false,
    }),
    null,
  );
});

/* ============================================================
   The compact snapshot — one format, one definition
   ============================================================ */

const ROWS: NotifyRow[] = [
  { key: '7', sessionId: '20261010-120000', status: 'asking', workspace: 'C:/work/one' },
  { key: '9', sessionId: '', status: 'idle', workspace: '' },
];

test('rows survive a round trip', () => {
  assert.deepEqual(decodeNotifyRows(encodeNotifyRows(ROWS)), ROWS);
});

test('an empty list encodes to nothing and decodes to nothing', () => {
  assert.equal(encodeNotifyRows([]), '');
  assert.deepEqual(decodeNotifyRows(''), []);
});

test('a workspace path cannot be mistaken for a field boundary', () => {
  // The reason the separators are control characters. A Windows path may contain
  // almost anything printable — a colon, a comma, a space — and a path that split
  // as a separator would put a fragment in the status column, which is how a
  // notification ends up about the wrong session.
  const tricky: NotifyRow[] = [
    { key: '1', sessionId: 'a,b:c', status: 'unseen', workspace: 'C:/Program Files/x, y' },
  ];
  assert.deepEqual(decodeNotifyRows(encodeNotifyRows(tricky)), tricky);
});

test('a malformed row is dropped rather than guessed at', () => {
  // A row with a missing column would otherwise land in `notifyDecision` as a
  // session with an unknown status — and an unknown status is not one of the
  // five, so the comparison against the previous one would be meaningless.
  const text = encodeNotifyRows(ROWS);
  assert.equal(decodeNotifyRows(`${text}\u0001broken`).length, 2);
  // A row with no key cannot be attributed to a session at all.
  assert.equal(decodeNotifyRows('\u0000s\u0000idle\u0000p').length, 0);
});

test('the watch fields survive a round trip', () => {
  const snapshot = {
    activeKey: '7',
    modalVisible: true,
    modalKey: '9',
    rows: ROWS,
  };
  assert.deepEqual(decodeNotifySnapshot(encodeNotifySnapshot(snapshot)), snapshot);
});

test('an empty snapshot says nothing is watched and nothing is open', () => {
  const empty = encodeNotifySnapshot({
    activeKey: '',
    modalVisible: false,
    modalKey: '',
    rows: [],
  });
  assert.deepEqual(decodeNotifySnapshot(empty), {
    activeKey: '',
    modalVisible: false,
    modalKey: '',
    rows: [],
  });
});

test('a garbage snapshot decodes to "nothing watched" rather than to a guess', () => {
  // The notifier's response to that is to send nothing, which is the safe
  // direction for a rule whose whole job is not to interrupt people.
  assert.deepEqual(decodeNotifySnapshot('nonsense'), {
    activeKey: 'nonsense',
    modalVisible: false,
    modalKey: '',
    rows: [],
  });
});

/* ============================================================
   The sentences
   ============================================================ */

test('each reason gets its own title', () => {
  const t = makeT();
  const subject = { workspace: 'C:/work/one', sessionId: '20261010-120000', preview: '' };
  const titles = (['needs-you', 'failed', 'finished'] as const).map(
    (reason) => notifyContent(t, reason, subject).title,
  );
  assert.equal(new Set(titles).size, 3, 'three distinct titles');
  for (const title of titles) {
    // No key may leak through: `T` returns the key itself for an unknown one, so
    // a typo would ship as `notify.title.finished` on screen.
    assert.ok(!title.startsWith('notify.'), `untranslated: ${title}`);
  }
});

test('the body names the session by its workspace and id', () => {
  const t = makeT();
  const { body } = notifyContent(t, 'finished', {
    workspace: 'C:/work/one',
    sessionId: '20261010-120000',
    preview: '',
  });
  // The base name, not the whole path: a toast shows one or two lines, and the
  // last segment is the part that identifies the project.
  assert.ok(body.includes('one'), body);
  assert.ok(body.includes('20261010-120000'), body);
  assert.ok(!body.includes('C:/work'), 'the full path stays out of the toast');
});

test('a session with nothing known about it still produces a body', () => {
  // Before `init` there is no id, and a session may have no workspace. The
  // alternative — joining with a separator — would draw a dangling `·` that
  // reads as a value that went missing.
  const t = makeT();
  const { body } = notifyContent(t, 'needs-you', {
    workspace: '',
    sessionId: '',
    preview: '',
  });
  assert.equal(body, '');
});

test('the preview is collapsed to one line and bounded', () => {
  const t = makeT();
  const long = 'x'.repeat(400);
  const { body } = notifyContent(t, 'finished', {
    workspace: 'C:/w',
    sessionId: 's1',
    preview: `first line\n${long}`,
  });
  assert.ok(!body.includes('\nfirst') || body.includes('first line'), body);
  // One line for the preview, so the newline before it is the only one.
  const previewPart = body.split('\n')[1] ?? '';
  assert.ok(previewPart.length <= 141, `preview was ${previewPart.length} chars`);
  assert.ok(previewPart.endsWith('…'), 'a clipped preview says that it was clipped');
});

/* ============================================================
   What the X button does
   ============================================================ */

test('a remembered choice is read back as itself', () => {
  assert.equal(readClosePolicy('minimize'), 'minimize');
  assert.equal(readClosePolicy('close'), 'close');
  assert.equal(readClosePolicy('ask'), 'ask');
});

test('anything unrecognised means "ask"', () => {
  // `localStorage` outlives every build, so this value is either a leftover or
  // something a person edited. `ask` is the only fallback that cannot be wrong,
  // because it does not act: `close` would end every session and `minimize`
  // would leave a window somebody believes they closed.
  for (const raw of [undefined, null, '', 'Close', 'MINIMIZE', 0, 1, {}, [], true]) {
    assert.equal(readClosePolicy(raw), 'ask', `raw: ${JSON.stringify(raw)}`);
  }
});

test('a remembered choice is applied without asking', () => {
  assert.equal(needsPrompt('ask'), true);
  assert.equal(needsPrompt('minimize'), false);
  assert.equal(needsPrompt('close'), false);
});

test('the three policies are the ones the settings row offers', () => {
  // The list, the reader and the prompt have to agree: two of them listing
  // different values would show a control that cannot be selected.
  assert.deepEqual([...CLOSE_POLICIES].sort(), ['ask', 'close', 'minimize']);
  for (const policy of CLOSE_POLICIES) {
    assert.equal(readClosePolicy(policy), policy);
  }
});

/* ============================================================
   Notifications on or off
   ============================================================ */

test('notifications are on unless they were switched off', () => {
  // The one preference whose malformed-value fallback is "work" rather than "do
  // nothing": a notifier that starts switched off is a feature nobody discovers.
  assert.equal(readNotifyEnabled(undefined), true);
  assert.equal(readNotifyEnabled(null), true);
  assert.equal(readNotifyEnabled('yes'), true);
  assert.equal(readNotifyEnabled(0), true);
});

test('only an explicit false switches them off', () => {
  assert.equal(readNotifyEnabled(false), false);
  assert.equal(readNotifyEnabled(true), true);
});
