/**
 * The composer's prompt history: what is worth offering back, and which one.
 *
 * The feature has no crash as its failure mode. A wrong matcher offers a
 * sentence the person did not mean, a parser that trusts the file offers a
 * sentence from a future build, and a remembered attachment path offers a
 * picture that is not in the draft any more — all three look exactly like a
 * working suggestion line. That is why the rules are asserted here rather than
 * checked by typing into a window.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  mergePrompt,
  parsePromptHistory,
  PROMPT_HISTORY_MAX,
  PROMPT_TEXT_MAX,
  promptFileKey,
  promptHistoryKey,
  rememberablePrompt,
  serializePromptHistory,
  suggestPrompt,
  type PromptEntry,
} from '@/state/promptHistory';

/* ============================================================
   the file's name, and the workspace's key
   ============================================================ */

test('a workspace key is the same key the saved-session list uses', () => {
  // The two lists describe one place, so they must agree about which place it
  // is — including the remote half, where the path alone cannot say.
  assert.equal(promptHistoryKey('/srv/app', null), '/srv/app');
  assert.equal(promptHistoryKey('/srv/app', 'entry-7'), 'rw:entry-7');
  assert.equal(promptHistoryKey('/srv/app', 'entry-8'), promptHistoryKey('/srv/app', 'entry-8'));
});

test('a file name is a stable, legal hex key', () => {
  const first = promptFileKey('C:\\work\\app');
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(promptFileKey('C:\\work\\app'), first, 'stable across calls');
  assert.notEqual(promptFileKey('C:\\work\\app'), promptFileKey('C:\\work\\other'));
  // The remote key is a different place and must not collide with a path.
  assert.notEqual(promptFileKey('rw:entry-7'), promptFileKey('/srv/app'));
});

/* ============================================================
   reading the sidecar
   ============================================================ */

const line = (text: string, at: number, count = 1): string =>
  JSON.stringify({ v: 1, text, at, count });

test('the same sentence on two lines is one entry with the sends added up', () => {
  const entries = parsePromptHistory(
    [line('请 pull 一下', 10), line('please run the tests', 20), line('请 pull 一下', 30)].join('\n'),
  );
  assert.equal(entries.length, 2);
  const pull = entries.find((entry) => entry.text === '请 pull 一下');
  assert.deepEqual(pull, { text: '请 pull 一下', count: 2, at: 30 });
});

test('a malformed, future or oversized line is dropped whole', () => {
  const entries = parsePromptHistory(
    [
      'not json',
      '{}',
      JSON.stringify({ v: 2, text: 'from a newer build', at: 1 }),
      JSON.stringify({ v: 1, text: 'x'.repeat(PROMPT_TEXT_MAX + 1), at: 1 }),
      JSON.stringify({ v: 1, text: '   ', at: 1 }),
      line('kept', 5),
    ].join('\n'),
  );
  assert.deepEqual(entries, [{ text: 'kept', count: 1, at: 5 }]);
});

test('an empty or missing file reads as no suggestions', () => {
  assert.deepEqual(parsePromptHistory(null), []);
  assert.deepEqual(parsePromptHistory(''), []);
});

test('the ranked order is frequency first, newest second', () => {
  const entries = parsePromptHistory(
    [line('once, old', 10), line('twice, older', 5), line('twice, older', 6), line('once, new', 99)].join(
      '\n',
    ),
  );
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ['twice, older', 'once, new', 'once, old'],
  );
});

test('serialising and reading back is a round trip', () => {
  const entries: PromptEntry[] = [
    { text: '第一句\n第二句', count: 2, at: 12 },
    { text: 'a "quoted" sentence', count: 1, at: 4 },
  ];
  assert.deepEqual(parsePromptHistory(serializePromptHistory(entries)), entries);
});

/* ============================================================
   the suggestion
   ============================================================ */

const entries = parsePromptHistory(
  [
    line('请pull代码', 10),
    line('请pull代码', 11),
    line('请push到远端', 12),
    line('please run the tests', 13),
    line('Please run the linter', 14),
  ].join('\n'),
);

test('a Chinese prefix completes, and the most-used sentence wins', () => {
  assert.equal(suggestPrompt('请p', entries), '请pull代码');
  assert.equal(suggestPrompt('请 pu', entries), null, 'the stored text has no such space');
  assert.equal(suggestPrompt('请push', entries), '请push到远端');
});

test('Latin matching ignores case in both directions', () => {
  assert.equal(suggestPrompt('please run the t', entries), 'please run the tests');
  assert.equal(suggestPrompt('PLEASE RUN THE L', entries), 'Please run the linter');
});

test('a draft too short, already complete or longer than a sentence offers nothing', () => {
  assert.equal(suggestPrompt('p', entries), null);
  assert.equal(suggestPrompt('请', entries), null);
  assert.equal(suggestPrompt('请pull代码', entries), null);
  assert.equal(suggestPrompt('请pull代码并提交', entries), null);
  assert.equal(suggestPrompt('x'.repeat(PROMPT_TEXT_MAX + 1), entries), null);
  assert.equal(suggestPrompt('请p', []), null);
});

test('a send joins the list, counts, and stays under the cap', () => {
  const once = mergePrompt([], '请pull代码', 10);
  assert.deepEqual(once, [{ text: '请pull代码', count: 1, at: 10 }]);
  const twice = mergePrompt(once, '请pull代码', 20);
  assert.deepEqual(twice, [{ text: '请pull代码', count: 2, at: 20 }]);
  assert.notEqual(twice, once, 'the snapshot has to be a new array');

  const full: PromptEntry[] = Array.from({ length: PROMPT_HISTORY_MAX }, (_, index) => ({
    text: `prompt ${index}`,
    count: 1,
    at: index,
  }));
  assert.equal(mergePrompt(full, 'prompt 0', 999).length, PROMPT_HISTORY_MAX);
});

/* ============================================================
   what one send leaves behind
   ============================================================ */

test('an attachment path comes out of the sentence that is remembered', () => {
  const sent = '看下这两张图 /tmp/tudouni/a.png 和 srv/upload/b.png，然后改颜色';
  assert.equal(
    rememberablePrompt(sent, ['/tmp/tudouni/a.png', 'srv/upload/b.png']),
    '看下这两张图 和 ，然后改颜色',
  );
  // A sentence that was only a picture is not a sentence.
  assert.equal(rememberablePrompt('/tmp/tudouni/a.png', ['/tmp/tudouni/a.png']), '');
});

test('newlines survive, runs of spaces do not', () => {
  assert.equal(
    rememberablePrompt('first   line\n\n   second line  ', []),
    'first line\n\nsecond line',
  );
});

test('a pasted document is not offered back', () => {
  assert.equal(rememberablePrompt('x'.repeat(PROMPT_TEXT_MAX + 1), []), '');
});
