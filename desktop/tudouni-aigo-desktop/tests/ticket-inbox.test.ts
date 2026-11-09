/**
 * The ticket inbox: work that arrived as a file.
 *
 * Four rules, each one a way the door could be wrong without anybody noticing:
 *
 *   - **A drop never starts work.** What lands is an `open` Ticket. A program
 *     that can write a file must not be able to make work begin, for the same
 *     reason it cannot make a Ticket `done`.
 *   - **The same drop yields one Ticket.** The board drains on every open, so a
 *     redelivered issue must not add a second Ticket each time.
 *   - **A bad file is skipped, not fatal.** One unreadable or empty drop must not
 *     hide the good ones beside it, and must not stop the board from loading.
 *   - **A finished Ticket still answers its thread.** A `done` or `dropped`
 *     Ticket was somebody's answer to this drop; re-scanning must not reopen it.
 *
 * The pure half is asserted on its own; the drain is driven through the store
 * against a fake Tauri host, the way `ticket-store.test.ts` is.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_SOURCE,
  hasTicketFor,
  originOf,
  parseInboxFile,
  planScan,
  splitFrontMatter,
  type InboxFile,
} from '@/ticket/inbox';
import { emptyTicket, isValidTicket, newTicketId, type Ticket } from '@/ticket/model';

/* ============================================================
   splitFrontMatter
   ============================================================ */

test('front matter is split at the closing rule', () => {
  const { fields, body } = splitFrontMatter('---\nsource: github\nthread: issue#1\n---\nFix it.\n');
  assert.deepEqual(fields, { source: 'github', thread: 'issue#1' });
  assert.equal(body, 'Fix it.\n');
});

test('a file with no front matter is all body', () => {
  const { fields, body } = splitFrontMatter('Just do the thing.\n');
  assert.deepEqual(fields, {});
  assert.equal(body, 'Just do the thing.\n');
});

test('an unclosed --- is body, not a guess at where it ends', () => {
  // The alternative — treating the rest as front matter — would eat the brief.
  const text = '---\nsource: github\n';
  const { fields, body } = splitFrontMatter(text);
  assert.deepEqual(fields, {});
  assert.equal(body, text);
});

test('unknown fields are ignored rather than rejected', () => {
  const { fields } = splitFrontMatter('---\nsource: x\npriority: high\n---\nbody');
  assert.deepEqual(fields, { source: 'x' });
});

test('a BOM does not stop the block from being recognised', () => {
  const { fields } = splitFrontMatter('\uFEFF---\nsource: x\n---\nbody');
  assert.equal(fields.source, 'x');
});

test('CRLF line endings parse the same as LF', () => {
  const { fields, body } = splitFrontMatter('---\r\nsource: x\r\n---\r\nbody\r\n');
  assert.equal(fields.source, 'x');
  assert.equal(body.trim(), 'body');
});

/* ============================================================
   parseInboxFile
   ============================================================ */

const file = (name: string, text: string): InboxFile => ({ name, text });

test('a plain note becomes a drop named after its file', () => {
  const drop = parseInboxFile(file('note-1', 'Water the plants\nSecond line'));
  assert.notEqual(drop, null);
  assert.equal(drop!.source, DEFAULT_SOURCE);
  assert.equal(drop!.thread, 'note-1');
  assert.equal(drop!.file, 'note-1');
  assert.equal(drop!.title, 'Water the plants');
});

test('the front matter names the source and the thread', () => {
  const drop = parseInboxFile(file('whatever', '---\nsource: github\nthread: issue#123\n---\nFix it'));
  assert.equal(drop!.source, 'github');
  assert.equal(drop!.thread, 'issue#123');
  assert.equal(drop!.brief, 'Fix it');
});

test('a title in the front matter wins over the first line', () => {
  const drop = parseInboxFile(file('x', '---\ntitle: Safari blank page\n---\nFix it'));
  assert.equal(drop!.title, 'Safari blank page');
});

test('an empty body is not a drop', () => {
  assert.equal(parseInboxFile(file('x', '   \n\n  ')), null);
  assert.equal(parseInboxFile(file('x', '---\nsource: github\n---\n\n')), null);
});

test('a very long first line is cut, as ticketTitle cuts one', () => {
  const long = 'x'.repeat(200);
  const drop = parseInboxFile(file('x', long));
  assert.equal(drop!.title.length, 80);
  assert.ok(drop!.title.endsWith('…'));
});

test('the source is folded to lower case, because it is half the key', () => {
  // Two programs spelling it `GitHub` and `github` describe one feed; counting
  // them apart would yield a duplicate Ticket and report nothing.
  const upper = parseInboxFile(file('a', '---\nsource: GitHub\nthread: 1\n---\nwork'))!;
  const lower = parseInboxFile(file('b', '---\nsource: github\nthread: 1\n---\nwork'))!;
  assert.equal(upper.source, 'github');
  assert.equal(upper.source, lower.source);
});

test('an empty source falls back to the default rather than the empty string', () => {
  const drop = parseInboxFile(file('a', '---\nsource:   \n---\nwork'))!;
  assert.equal(drop.source, DEFAULT_SOURCE);
});

test('the thread is not folded: its case may be meaningful', () => {
  const drop = parseInboxFile(file('a', '---\nsource: gh\nthread: Issue#ABC\n---\nwork'))!;
  assert.equal(drop.thread, 'Issue#ABC');
});

test('originOf carries the key and the file', () => {
  const drop = parseInboxFile(file('issue-9', '---\nsource: gh\nthread: 9\n---\nwork'))!;
  assert.deepEqual(originOf(drop), { kind: 'source', source: 'gh', thread: '9', file: 'issue-9' });
});

/* ============================================================
   Idempotence: the same drop, one Ticket
   ============================================================ */

function sourced(source: string, thread: string): Ticket {
  const ticket = emptyTicket(1);
  return { ...ticket, origin: { kind: 'source', source, thread, file: `${source}-${thread}` } };
}

test('a Ticket on the same source and thread is found', () => {
  const drop = parseInboxFile(file('x', '---\nsource: gh\nthread: 9\n---\nwork'))!;
  assert.equal(hasTicketFor([sourced('gh', '9')], drop), true);
});

test('a different thread from the same source is a different drop', () => {
  const drop = parseInboxFile(file('x', '---\nsource: gh\nthread: 10\n---\nwork'))!;
  assert.equal(hasTicketFor([sourced('gh', '9')], drop), false);
});

test('a manual Ticket never answers a drop', () => {
  const drop = parseInboxFile(file('x', 'work'))!;
  assert.equal(hasTicketFor([emptyTicket(1)], drop), false);
});

test('a finished Ticket still answers its thread', () => {
  // `done` is somebody's verdict on the issue; re-scanning must not reopen it.
  for (const status of ['done', 'dropped'] as const) {
    const ticket = { ...sourced('gh', '9'), status };
    const drop = parseInboxFile(file('x', '---\nsource: gh\nthread: 9\n---\nwork'))!;
    assert.equal(hasTicketFor([ticket], drop), true, status);
  }
});

/* ============================================================
   planScan
   ============================================================ */

test('a scan splits fresh, known and empty', () => {
  const plan = planScan(
    [
      file('a', '---\nsource: gh\nthread: 1\n---\nfirst'),
      file('b', '---\nsource: gh\nthread: 2\n---\nsecond'),
      file('c', '   '),
    ],
    [sourced('gh', '1')],
  );
  assert.deepEqual(
    plan.fresh.map((drop) => drop.thread),
    ['2'],
  );
  assert.deepEqual(
    plan.known.map((drop) => drop.thread),
    ['1'],
  );
  assert.deepEqual(plan.empty, ['c']);
});

test('two files for one thread in one scan make one Ticket', () => {
  // One request delivered twice: the first file wins and the second is archived
  // as `known`, the answer it would get had it arrived one scan later.
  const plan = planScan(
    [
      file('a', '---\nsource: gh\nthread: 1\n---\nfirst'),
      file('b', '---\nsource: gh\nthread: 1\n---\nsecond'),
    ],
    [],
  );
  assert.deepEqual(plan.fresh.map((drop) => drop.brief), ['first']);
  assert.deepEqual(plan.known.map((drop) => drop.brief), ['second']);
});

test('the batch dedupe is per pair, not per thread or per source alone', () => {
  const plan = planScan(
    [
      file('a', '---\nsource: gh\nthread: 1\n---\none'),
      file('b', '---\nsource: jira\nthread: 1\n---\ntwo'),
      file('c', '---\nsource: gh\nthread: 2\n---\nthree'),
    ],
    [],
  );
  assert.equal(plan.fresh.length, 3);
  assert.equal(plan.known.length, 0);
});

/* ============================================================
   The guard accepts what the inbox writes
   ============================================================ */

test('a sourced Ticket passes the record guard', () => {
  assert.equal(isValidTicket(sourced('gh', '9')), true);
});

test('an origin this build does not know is not a record', () => {
  const ticket = { ...emptyTicket(1), origin: { kind: 'future' } } as unknown as Ticket;
  assert.equal(isValidTicket(ticket), false);
});

test('a source origin needs all three fields', () => {
  const base = emptyTicket(1);
  assert.equal(isValidTicket({ ...base, origin: { kind: 'source', source: 'gh' } } as unknown as Ticket), false);
  assert.equal(
    isValidTicket({ ...base, origin: { kind: 'source', source: 'gh', thread: '1' } } as unknown as Ticket),
    false,
  );
});

test('a manual Ticket is still valid, so old records load', () => {
  assert.equal(isValidTicket(emptyTicket(1)), true);
});

test('newTicketId does not collide across a batch', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newTicketId(1000)));
  assert.equal(ids.size, 200);
});
