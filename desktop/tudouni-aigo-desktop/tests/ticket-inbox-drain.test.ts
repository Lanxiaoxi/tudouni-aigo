/**
 * The inbox drain, through the store.
 *
 * `ticket-inbox.test.ts` asserts the pure half. This one asserts the part that
 * touches the world: that a scan creates **open** Tickets, archives exactly the
 * files it accounted for, and leaves alone the ones a person still has to fix.
 *
 * Driven against a fake Tauri host that keeps the inbox in a map and the record
 * in a string, the way `ticket-store.test.ts` does.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAppStore } from '@/state/store';
import { resetTicketStoreForTests } from '@/ticket/store';

/* ============================================================
   The host: the record in a string, the inbox in a map
   ============================================================ */

let fileText: string | null = null;
let inbox = new Map<string, string>();
let archived: string[] = [];
let failList = false;
let failArchive = false;

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke(cmd: string, args?: Record<string, unknown>) {
      switch (cmd) {
        case 'tickets_read':
          return Promise.resolve(fileText);
        case 'tickets_write':
          fileText = args?.text as string;
          return Promise.resolve(null);
        case 'inbox_list':
          if (failList) return Promise.reject(new Error('access denied'));
          return Promise.resolve(
            [...inbox.entries()].map(([name, text]) => ({ name, text })).sort((a, b) => (a.name < b.name ? -1 : 1)),
          );
        case 'inbox_archive': {
          if (failArchive) return Promise.reject(new Error('locked'));
          const name = args?.name as string;
          inbox.delete(name);
          archived.push(name);
          return Promise.resolve(null);
        }
        default:
          return Promise.resolve(null);
      }
    },
  },
};

function reset(): void {
  resetTicketStoreForTests();
  fileText = null;
  inbox = new Map();
  archived = [];
  failList = false;
  failArchive = false;
  console.warn = () => undefined;
}

async function loadedStore() {
  reset();
  const store = createAppStore();
  await store.getState().loadTickets();
  return store;
}

const note = (source: string, thread: string, brief = 'the work') =>
  `---\nsource: ${source}\nthread: ${thread}\n---\n${brief}\n`;

/* ============================================================
   What a drain does
   ============================================================ */

test('no inbox means nothing happens, and no write', async () => {
  const store = await loadedStore();
  const result = await store.getState().scanTicketInbox();
  assert.deepEqual(result, { created: 0, known: 0, empty: [] });
  assert.equal(fileText, null);
});

test('a drop becomes an OPEN Ticket with its origin recorded', async () => {
  const store = await loadedStore();
  inbox.set('gh-9', note('github', 'issue#9', 'Fix the blank page'));
  const result = await store.getState().scanTicketInbox();

  assert.equal(result!.created, 1);
  const ticket = store.getState().tickets[0];
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.brief.trim(), 'Fix the blank page');
  assert.deepEqual(ticket.origin, { kind: 'source', source: 'github', thread: 'issue#9', file: 'gh-9' });
});

test('a drop that names its workspace, model and link lands with them', async () => {
  // The Source layer (docs/design/ticket-sources.md 3.4) writes these; a Ticket
  // for one repo's release must not run in whatever workspace is on screen.
  const store = await loadedStore();
  inbox.set(
    'src-rel-1',
    '---\nsource: rel\nthread: push#abc\nworkspace: local:D:/repo-a\nmodel: m1\nurl: https://example.com/c/abc\n---\nRelease abc\n',
  );
  await store.getState().scanTicketInbox();

  const ticket = store.getState().tickets[0];
  assert.deepEqual(ticket.workspace, { kind: 'local', path: 'D:/repo-a' });
  assert.equal(ticket.model, 'm1');
  assert.deepEqual(ticket.origin, {
    kind: 'source',
    source: 'rel',
    thread: 'push#abc',
    file: 'src-rel-1',
    url: 'https://example.com/c/abc',
  });
  // And the record still passes the guard after a round trip through the file.
  assert.match(fileText ?? '', /"url":\s*"https:\/\/example.com\/c\/abc"/);
});

test('a drain never starts work', async () => {
  // The whole point of the door: a program may propose, not command.
  const store = await loadedStore();
  inbox.set('a', note('gh', '1'));
  await store.getState().scanTicketInbox();
  assert.equal(store.getState().tickets[0].status, 'open');
  assert.equal(store.getState().tickets[0].assignments.length, 0);
});

test('the file moves to processed once its Ticket exists', async () => {
  const store = await loadedStore();
  inbox.set('a', note('gh', '1'));
  await store.getState().scanTicketInbox();
  assert.deepEqual(archived, ['a']);
  assert.equal(inbox.size, 0);
});

test('scanning twice yields one Ticket, the second time as known', async () => {
  const store = await loadedStore();
  inbox.set('a', note('gh', '1'));
  await store.getState().scanTicketInbox();

  // A source re-delivers the same issue: the same file name, written again.
  inbox.set('a', note('gh', '1'));
  const second = await store.getState().scanTicketInbox();

  assert.equal(store.getState().tickets.length, 1);
  assert.deepEqual(second, { created: 0, known: 1, empty: [] });
  assert.deepEqual(archived, ['a', 'a']);
});

test('a finished Ticket still answers a redelivered thread', async () => {
  const store = await loadedStore();
  inbox.set('a', note('gh', '1'));
  await store.getState().scanTicketInbox();
  const id = store.getState().tickets[0].id;
  store.getState().dropTicket(id);

  inbox.set('a', note('gh', '1'));
  const again = await store.getState().scanTicketInbox();
  assert.equal(store.getState().tickets.length, 1, 'a dropped Ticket was reopened by a scan');
  assert.equal(again!.created, 0);
});

test('an empty file is left in place and reported', async () => {
  const store = await loadedStore();
  inbox.set('blank', '   \n\n');
  const result = await store.getState().scanTicketInbox();
  assert.deepEqual(result, { created: 0, known: 0, empty: ['blank'] });
  assert.equal(inbox.has('blank'), true, 'a blank file may still be being typed into');
  assert.equal(store.getState().tickets.length, 0);
});

test('a brief the runtime would refuse is not turned into a Ticket', async () => {
  // A Ticket whose `ticket_bind` the runtime refuses would say Running with no
  // report tool behind it; the door refuses it before that can happen.
  const store = await loadedStore();
  inbox.set('huge', 'x'.repeat(20_001));
  const result = await store.getState().scanTicketInbox();
  assert.equal(result!.created, 0);
  assert.equal(store.getState().tickets.length, 0);
  assert.equal(inbox.has('huge'), true, 'the file stays where its author can fix it');
});

test('several drops in one scan all arrive, in file order', async () => {
  const store = await loadedStore();
  inbox.set('b', note('gh', '2', 'second'));
  inbox.set('a', note('gh', '1', 'first'));
  const result = await store.getState().scanTicketInbox();
  assert.equal(result!.created, 2);
  assert.deepEqual(
    store.getState().tickets.map((ticket) => ticket.brief.trim()),
    ['first', 'second'],
  );
});

/* ============================================================
   Refusals
   ============================================================ */

test('an unreadable inbox is reported as no scan, not as a clean one', async () => {
  const store = await loadedStore();
  failList = true;
  assert.equal(await store.getState().scanTicketInbox(), null);
});

test('a read-only record does not scan', async () => {
  // Every drop would be refused, so offering the scan would be a lie.
  reset();
  fileText = JSON.stringify({ schema: 99, tickets: [] });
  const store = createAppStore();
  await store.getState().loadTickets();
  assert.equal(store.getState().ticketsReadOnly, true);
  inbox.set('a', note('gh', '1'));
  assert.equal(await store.getState().scanTicketInbox(), null);
});

test('a record not yet read does not scan', async () => {
  reset();
  const store = createAppStore();
  inbox.set('a', note('gh', '1'));
  assert.equal(await store.getState().scanTicketInbox(), null);
});

test('a failed archive keeps the Ticket and lets the next scan reconcile', async () => {
  const store = await loadedStore();
  inbox.set('a', note('gh', '1'));
  failArchive = true;
  const result = await store.getState().scanTicketInbox();

  assert.equal(result!.created, 1);
  assert.equal(store.getState().tickets.length, 1);
  assert.equal(inbox.has('a'), true, 'the file is still there');

  // The next scan sees the same thread, matches it as known, and tries again.
  failArchive = false;
  const again = await store.getState().scanTicketInbox();
  assert.deepEqual(again, { created: 0, known: 1, empty: [] });
  assert.equal(inbox.has('a'), false);
});

/* ============================================================
   Persistence
   ============================================================ */

test('a drained Ticket is written to the file', async () => {
  const store = await loadedStore();
  inbox.set('a', note('gh', '1', 'Fix it'));
  await store.getState().scanTicketInbox();
  const saved = JSON.parse(fileText!);
  assert.equal(saved.tickets.length, 1);
  assert.equal(saved.tickets[0].origin.source, 'gh');
  assert.equal(saved.tickets[0].status, 'open');
});

test('a drain leaves the existing Tickets alone', async () => {
  const store = await loadedStore();
  inbox.set('a', note('gh', '1', 'first'));
  await store.getState().scanTicketInbox();
  inbox.set('b', note('gh', '2', 'second'));
  await store.getState().scanTicketInbox();

  assert.equal(store.getState().tickets.length, 2);
  assert.deepEqual(
    store.getState().tickets.map((ticket) => ticket.brief.trim()),
    ['first', 'second'],
  );
});
