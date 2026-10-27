/**
 * The desktop's user data: `~/.tudouni/desktop.json`.
 *
 * The rules asserted here are the ones that decide whether a person's task
 * templates survive an upgrade — the same class of rule `user-config.test.ts`
 * pins for `config.json`:
 *
 *   - **The file is the home; localStorage is the fallback.** A valid file
 *     wins over the legacy record, even a record that still holds the same
 *     fields.
 *   - **The migration is one-way and loss-ordered.** The legacy fields move
 *     to the file, and they leave the localStorage record **only after the
 *     write landed** — a refused write keeps the old copy as the backup, so a
 *     launch that cannot write still has the data somewhere.
 *   - **A broken file is not an empty one.** The only writer is this program
 *     and it always writes valid JSON, so a file that will not parse is
 *     damage from outside — a legacy record that still exists is real data
 *     and wins over an empty shelf.
 *   - **The pre-hydrate guard.** A store change while the file read is in
 *     flight must not become a write: the in-memory copy at that moment is
 *     the empty shelf, and the empty shelf delivered over the person's data
 *     is the bug the latch exists to refuse.
 *
 * Node has no localStorage, so this suite installs the same in-memory shim
 * every browser test gets for free, and a fake Tauri host that keeps the
 * file in a variable.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  desktopDataSnapshot,
  emptyDesktopData,
  flush,
  hydrateDesktopData,
  resetDesktopDataForTests,
  syncFromStore,
} from '@/state/desktopData';
import type { AppStore } from '@/state/store';

/* ============================================================
   The window: a localStorage shim and a fake Tauri host
   ============================================================ */

const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
  setItem: (key: string, value: string) => {
    storage.set(key, String(value));
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => storage.clear(),
};

/** The file on disk, as the Rust side would hand it back. `null` = absent. */
let fileText: string | null = null;
let writes = 0;
let refuseWrite = false;

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke(cmd: string, args?: Record<string, unknown>) {
      if (cmd === 'desktop_data_read') return Promise.resolve(fileText);
      if (cmd === 'desktop_data_write') {
        writes += 1;
        if (refuseWrite) return Promise.reject(new Error('disk is full'));
        fileText = args?.text as string;
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    },
  },
};

function reset(): void {
  resetDesktopDataForTests();
  fileText = null;
  writes = 0;
  refuseWrite = false;
  storage.clear();
}

/** The legacy record: the window's presentation plus whatever user data the
 *  pre-split builds persisted. */
function setLegacy(user: Record<string, unknown> = {}): void {
  storage.set('aigo.prefs', JSON.stringify({ quiet: 'simple', sidebarWidth: 260, ...user }));
}

function legacyRecord(): Record<string, unknown> {
  const raw = storage.get('aigo.prefs');
  assert.ok(raw, 'the legacy record is still there');
  return JSON.parse(raw) as Record<string, unknown>;
}

const HOST = { id: 'ssh-1', label: 'prod', host: '10.2.0.4', port: 22, user: 'deploy', identityFiles: [] };
/** A host missing `user` and with a string port: malformed, dropped whole. */
const BAD_HOST = { id: 'ssh-2', label: 'x', host: 'y', port: '22', identityFiles: [] };
const TASK = {
  id: 'task-1',
  name: 'nightly',
  description: '',
  prompt: 'build everything',
  workspace: { kind: 'active' },
  model: '',
  enabled: true,
  autopilot: true,
  createdAtMs: 1,
  updatedAtMs: 1,
};

function state(fields: Record<string, unknown> = {}): AppStore {
  return { ...emptyDesktopData(), ...fields } as AppStore;
}

/* ============================================================
   Hydration: what the file, the legacy record and a first launch
   each answer
   ============================================================ */

test('a valid file is the home: the store takes its content and nothing is rewritten', async () => {
  reset();
  fileText = JSON.stringify({ ...emptyDesktopData(), workspaces: ['/srv'], lastWorkspace: '/srv/app' });
  setLegacy({ workspaces: ['/stale'], lastWorkspace: '/stale/app' });

  const data = await hydrateDesktopData();
  assert.deepEqual(data.workspaces, ['/srv'], 'the file wins over the legacy record');
  assert.equal(data.lastWorkspace, '/srv/app');
  assert.equal(writes, 0, 'a healthy file is not rewritten at every launch');
  assert.deepEqual(desktopDataSnapshot().workspaces, ['/srv']);
  // The presentation fields were never part of the file's business.
  assert.equal(legacyRecord().quiet, 'simple');
});

test('a first launch with no file and no legacy record gets an empty shelf', async () => {
  reset();
  const data = await hydrateDesktopData();
  assert.deepEqual(data, emptyDesktopData());
  // The empty record goes to the file: the next launch reads a file rather
  // than discovering its absence again.
  assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(fileText as string), emptyDesktopData());
});

/* ============================================================
   The migration: legacy record → file, one-way
   ============================================================ */

test('a missing file migrates the legacy record to the file and clears the fields', async () => {
  reset();
  setLegacy({
    workspaces: ['/srv'],
    sshHosts: [HOST, BAD_HOST],
    lastWorkspace: '/srv/app',
    lastRemoteWorkspaceId: 'rw-1',
    ericaiDefault: true,
    maxStepsDefault: 40,
    closePolicy: 'minimize',
    tasks: [TASK],
    taskRuns: [],
  });

  const data = await hydrateDesktopData();
  assert.deepEqual(data.workspaces, ['/srv']);
  assert.equal(data.sshHosts.length, 1, 'the malformed host is dropped whole, the good one kept');
  assert.equal(data.sshHosts[0].id, 'ssh-1');
  assert.equal(data.lastWorkspace, '/srv/app');
  assert.equal(data.lastRemoteWorkspaceId, 'rw-1');
  assert.equal(data.ericaiDefault, true);
  assert.equal(data.maxStepsDefault, 40);
  assert.equal(data.closePolicy, 'minimize');
  assert.deepEqual(data.tasks, [TASK]);

  // The file holds the migrated record.
  assert.equal(writes, 1);
  const onFile = JSON.parse(fileText as string);
  assert.deepEqual(onFile.sshHosts, [HOST]);
  assert.deepEqual(onFile.tasks, [TASK]);

  // The legacy record keeps the presentation, and only the presentation.
  assert.deepEqual(legacyRecord(), { quiet: 'simple', sidebarWidth: 260 });
});

test('a migration whose write was refused keeps the legacy copy as the backup', async () => {
  reset();
  refuseWrite = true;
  setLegacy({ workspaces: ['/srv'], lastWorkspace: '/srv/app' });

  const data = await hydrateDesktopData();
  assert.deepEqual(data.workspaces, ['/srv'], 'the window still shows the data');
  // The write refused, so the file was not written and the record still
  // carries the user fields: the next launch retries the migration.
  assert.equal(fileText, null);
  assert.deepEqual(legacyRecord().workspaces, ['/srv']);
  assert.equal(legacyRecord().lastWorkspace, '/srv/app');
  // The presentation fields were never touched by the migration.
  assert.equal(legacyRecord().quiet, 'simple');
});

/* ============================================================
   A file that will not parse
   ============================================================ */

test('a broken file with a legacy record: the legacy record wins, and the file is replaced', async () => {
  reset();
  fileText = '{ not json';
  setLegacy({ workspaces: ['/srv'], lastWorkspace: '/srv/app' });

  const data = await hydrateDesktopData();
  assert.deepEqual(data.workspaces, ['/srv'], 'the legacy copy is real data; the empty shelf is not');
  assert.equal(fileText !== null, true);
  const onFile = JSON.parse(fileText as string);
  assert.deepEqual(onFile.workspaces, ['/srv'], 'the broken text is replaced, not kept for the next launch');
  assert.deepEqual(legacyRecord(), { quiet: 'simple', sidebarWidth: 260 });
});

test('a broken file with no legacy record: the empty shelf, and the file is replaced', async () => {
  reset();
  fileText = '{ not json';

  const data = await hydrateDesktopData();
  assert.deepEqual(data, emptyDesktopData());
  const onFile = JSON.parse(fileText as string);
  assert.deepEqual(onFile, emptyDesktopData(), 'the broken text does not survive the launch');
});

/* ============================================================
   The latch: a store change before the read lands is refused
   ============================================================ */

test('a store change before hydrate must not overwrite the file', async () => {
  reset();
  fileText = JSON.stringify({ ...emptyDesktopData(), workspaces: ['/file'] });

  // The window opens and something persists before the read has landed. The
  // store's user fields at that moment are the empty shelf — exactly the
  // value the guard refuses to let touch the file.
  syncFromStore(state({ workspaces: [] }));

  const data = await hydrateDesktopData();
  assert.deepEqual(data.workspaces, ['/file'], 'the file is what the store took, not the empty shelf');
  assert.equal(desktopDataSnapshot().workspaces[0], '/file');
});

test('a store change after hydrate reaches the file; a repeated one does not', async () => {
  reset();
  fileText = JSON.stringify({ ...emptyDesktopData(), workspaces: ['/a'] });
  await hydrateDesktopData();
  assert.equal(writes, 0);

  syncFromStore(state({ workspaces: ['/a', '/b'] }));
  const written = await flush();
  assert.equal(written, true, 'the change was pending');
  assert.deepEqual(JSON.parse(fileText as string).workspaces, ['/a', '/b']);
  assert.equal(writes, 1);

  // Nothing moved since: the common case costs no write.
  const again = await flush();
  assert.equal(again, false, 'a second flush with nothing pending is a no-op');
  assert.equal(writes, 1);
});

test('a refused write reports itself, and the data stays in memory', async () => {
  reset();
  fileText = JSON.stringify({ ...emptyDesktopData(), workspaces: ['/a'] });
  await hydrateDesktopData();

  refuseWrite = true;
  syncFromStore(state({ workspaces: ['/a', '/b'] }));
  const written = await flush();
  assert.equal(written, false);
  assert.deepEqual(desktopDataSnapshot().workspaces, ['/a', '/b'], 'the in-memory copy holds the change');
  // The file is untouched.
  assert.deepEqual(JSON.parse(fileText as string).workspaces, ['/a']);
});

/* ============================================================
   The one-shot
   ============================================================ */

test('hydrate runs once: a second call takes the in-memory copy, not the file', async () => {
  reset();
  fileText = JSON.stringify({ ...emptyDesktopData(), workspaces: ['/first'] });
  const first = await hydrateDesktopData();

  fileText = JSON.stringify({ ...emptyDesktopData(), workspaces: ['/second'] });
  const second = await hydrateDesktopData();
  assert.deepEqual(second, first, 'the window does not re-read its data under a running session');
});
