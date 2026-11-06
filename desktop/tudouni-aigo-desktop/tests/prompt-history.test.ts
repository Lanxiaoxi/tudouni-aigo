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
  type Suggestion,
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

/** Shorthand for a Suggestion, so the assertions read as the text and the
 *  clause boundary index rather than an object literal. */
function sug(text: string, acceptTo: number): Suggestion {
  return { text, acceptTo };
}

test('a Chinese prefix completes, and the most-used sentence wins', () => {
  assert.deepEqual(suggestPrompt('请p', entries), sug('请pull代码', 7));
  assert.equal(suggestPrompt('请 pu', entries), null, 'the stored text has no such space');
  assert.deepEqual(suggestPrompt('请push', entries), sug('请push到远端', 8));
});

test('Latin matching ignores case in both directions', () => {
  assert.deepEqual(suggestPrompt('please run the t', entries), sug('please run the tests', 20));
  assert.deepEqual(suggestPrompt('PLEASE RUN THE L', entries), sug('Please run the linter', 21));
});

test('a draft too short, already complete or longer than a sentence offers nothing', () => {
  assert.equal(suggestPrompt('p', entries), null);
  assert.equal(suggestPrompt('请', entries), null);
  assert.equal(suggestPrompt('请pull代码', entries), null);
  assert.equal(suggestPrompt('请pull代码并提交', entries), null);
  assert.equal(suggestPrompt('x'.repeat(PROMPT_TEXT_MAX + 1), entries), null);
  assert.equal(suggestPrompt('请p', []), null);
});

/* ------------------------------------------------------------
   clause-aware acceptance: Tab stops at punctuation boundaries
   ------------------------------------------------------------ */

const clauseEntries = parsePromptHistory(
  [line('pull代码，出一个安装包，然后发邮件通知', 10)].join('\n'),
);

test('pass 1: a whole-sentence prefix matches and Tab stops at the next clause', () => {
  // Draft "pull代码" — pass 1 matches the full sentence. The first clause
  // boundary is right after the comma at index 6, so Tab inserts "，" and
  // stops there.
  assert.deepEqual(suggestPrompt('pull代码', clauseEntries), sug('pull代码，出一个安装包，然后发邮件通知', 7));
});

test('pass 1: after accepting one clause, the next Tab stops at the following boundary', () => {
  // Draft "pull代码，" (len 7) — the next boundary is after "出一个安装包，"
  // at index 14 (the comma sits at index 13, the boundary follows it).
  assert.deepEqual(suggestPrompt('pull代码，', clauseEntries), sug('pull代码，出一个安装包，然后发邮件通知', 14));
});

test('pass 1: the last clause has no delimiter, so Tab accepts it whole', () => {
  // Draft "pull代码，出一个安装包，" (len 14) — the remainder "然后发邮件通知"
  // has no internal delimiter, so Tab inserts the whole tail (acceptTo = 21,
  // the full text length).
  assert.deepEqual(
    suggestPrompt('pull代码，出一个安装包，', clauseEntries),
    sug('pull代码，出一个安装包，然后发邮件通知', 21),
  );
});

test('pass 2: a clause-boundary prefix matches from inside a sentence', () => {
  // Draft "出一个" (len 3) — pass 1 misses (the sentence does not start with
  // it); pass 2 matches from the clause boundary at index 7. The segment is
  // "出一个安装包，然后发邮件通知", and Tab stops after "出一个安装包，" (the
  // comma in the segment sits at index 6, so acceptTo = 7).
  assert.deepEqual(suggestPrompt('出一个', clauseEntries), sug('出一个安装包，然后发邮件通知', 7));
});

test('pass 2: a clause-boundary prefix on the last clause accepts it whole', () => {
  // Draft "然后" — pass 2 matches from the boundary at index 15. The segment
  // "然后发邮件通知" has no internal delimiter, so Tab inserts the whole tail.
  assert.deepEqual(suggestPrompt('然后', clauseEntries), sug('然后发邮件通知', 7));
});

test('pass 2: a prefix that straddles a clause boundary does not match', () => {
  // Draft "代码，出" — it starts in the middle of the first clause and crosses
  // into the second. Neither pass matches: pass 1 needs a whole-sentence
  // prefix, pass 2 needs a clause-boundary prefix.
  assert.equal(suggestPrompt('代码，出', clauseEntries), null);
});

/* ------------------------------------------------------------
   two-pass priority: whole-sentence match beats clause match
   ------------------------------------------------------------ */

test('a low-frequency whole-sentence match beats a high-frequency clause match', () => {
  // "出一个安装包" (count 1) is a whole-sentence match for draft "出一个";
  // "pull代码，出一个安装包" (count 10) has a clause-boundary match.
  // Pass 1 wins: the person started from the beginning of a sentence.
  const mixed = parsePromptHistory(
    [
      line('pull代码，出一个安装包', 1),
      line('pull代码，出一个安装包', 2),
      line('pull代码，出一个安装包', 3),
      line('出一个安装包', 10),
    ].join('\n'),
  );
  assert.deepEqual(suggestPrompt('出一个', mixed), sug('出一个安装包', 6));
});

test('when pass 1 misses, pass 2 finds the clause match by frequency', () => {
  // Neither sentence starts with "出一个", so pass 1 misses. Pass 2 finds
  // the clause match in the higher-frequency sentence.
  const clauseOnly = parsePromptHistory(
    [
      line('pull代码，出一个安装包', 1),
      line('pull代码，出一个安装包', 2),
      line('pull代码，出一个安装包', 3),
      line('改bug，出一个补丁', 10),
    ].join('\n'),
  );
  assert.deepEqual(suggestPrompt('出一个', clauseOnly), sug('出一个安装包', 6));
});

/* ------------------------------------------------------------
   clause boundaries without internal punctuation
   ------------------------------------------------------------ */

test('a sentence with no internal delimiters offers a single whole-clause accept', () => {
  // "pull代码即可" (len 8) — no delimiter inside, so acceptTo equals text.length.
  // Tab inserts the whole remainder in one step, same as the old behaviour.
  const noClause = parsePromptHistory([line('pull代码即可', 10)].join('\n'));
  assert.deepEqual(suggestPrompt('pull代码', noClause), sug('pull代码即可', 8));
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
