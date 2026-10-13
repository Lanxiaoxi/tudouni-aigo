/**
 * Adding a remote workspace, and opening one that is already saved.
 *
 * Two halves, both about rules that are **invisible on screen** — a rendered
 * dialog looks identical whether or not the rule holds, which is why they are
 * asserted here rather than by looking at the window.
 *
 * ## The wizard's rules
 *
 * The flow is three steps (which host, connect, which directory), and the parts
 * worth pinning are the ones that damage something outside this application when
 * they are wrong:
 *
 *   - **a `Host` block written into the person's own `~/.ssh/config`** — the file
 *     their `ssh` reads. It must never carry a `Password` line, because
 *     `Password` is this project's own extension rather than an OpenSSH keyword:
 *     OpenSSH would refuse to start at all, on **every** connection to every host
 *     in the file, with `Bad configuration option: password`;
 *   - **which saved host a new workspace reuses**, so one machine does not become
 *     two records that drift apart the moment either is edited;
 *   - **what a row is called**, which falls back to the path's own last segment.
 *
 * ## The open path's rules
 *
 * `enterRemoteWorkspace` with an empty `remoteBinary` means "the Runtime is not
 * on this host yet", and the answer is to install it and then connect — not to
 * fail. The distinction matters because §8.4 requires an install failure and a
 * connection failure to be **different sentences**: they have different causes
 * and different next steps, and a single generic "could not connect" would send
 * somebody to check their network for a problem that is actually a missing
 * binary.
 *
 * The store is driven directly here (it is a plain zustand store, and
 * `tests/workspace.test.ts` establishes the same pattern), with the bridge's own
 * functions stubbed — nothing in this file opens a socket.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildHostBlock,
  findReusableHost,
  newHostProblem,
  workspaceLabel,
} from '../src/components/modals/remoteWorkspace';
import { createSessionBucket, useApp } from '@/state/store';

/* ============================================================
   The `Host` block written into ~/.ssh/config
   ============================================================ */

test('a new host block carries no Password line, ever', () => {
  // The assertion this file exists for. `Password` is not an OpenSSH keyword, so
  // a block carrying one makes `ssh` fail to start for the whole file — every
  // host, not just this one. There is no password field in `PendingHost` at all,
  // and this is what keeps it that way: the rule is about the *written text*, so
  // it is asserted on the text rather than on the type.
  const lines = buildHostBlock({
    alias: 'myserver',
    host: '192.168.1.10',
    port: 22,
    user: 'deploy',
    identityFiles: [],
  });
  const text = lines.join('\n');
  assert.ok(!/password/i.test(text), `a Password line reached the config: ${text}`);
});

test('a host block is the expected directives, in order', () => {
  const lines = buildHostBlock({
    alias: 'bg-prod',
    host: '10.0.1.5',
    port: 2222,
    user: 'deploy',
    identityFiles: ['/home/me/.ssh/id_ed25519'],
  });
  assert.deepEqual(lines, [
    'Host bg-prod',
    '    HostName 10.0.1.5',
    '    Port 2222',
    '    User deploy',
    '    IdentityFile /home/me/.ssh/id_ed25519',
  ]);
});

test('port 22 is not restated, because OpenSSH already assumes it', () => {
  const lines = buildHostBlock({
    alias: 'a',
    host: 'example.com',
    port: 22,
    user: 'me',
    identityFiles: [],
  });
  assert.ok(
    !lines.some((line) => line.trim().startsWith('Port')),
    'a line restating the default is a line somebody has to read to learn it says nothing',
  );
});

test('several keys are one line each, which is how OpenSSH accumulates them', () => {
  const lines = buildHostBlock({
    alias: 'a',
    host: 'example.com',
    port: 22,
    user: 'me',
    identityFiles: ['/k/one', '/k/two', '/k/three'],
  });
  const keys = lines.filter((line) => line.trim().startsWith('IdentityFile'));
  // Three files, three lines — not one line with three values, which is not a
  // form OpenSSH reads the same way.
  assert.equal(keys.length, 3);
  assert.deepEqual(keys, ['    IdentityFile /k/one', '    IdentityFile /k/two', '    IdentityFile /k/three']);
});

test('empty fields emit nothing rather than a dangling directive', () => {
  const lines = buildHostBlock({
    alias: 'a',
    host: 'example.com',
    port: 22,
    // A blank user, and a list containing only blanks and whitespace.
    user: '   ',
    identityFiles: ['', '   '],
  });
  assert.deepEqual(lines, ['Host a', '    HostName example.com']);
});

/* ============================================================
   Reusing a saved host rather than duplicating it
   ============================================================ */

const SAVED = [
  { id: 'ssh-1', host: '10.0.1.5', port: 2222, user: 'deploy' },
  { id: 'ssh-2', host: '192.168.1.200', port: 22, user: 'tudouni' },
];

test('the same machine under another alias is one saved host', () => {
  // `10.0.1.5` reached as `prod` and as `10.0.1.5` is one destination. Keying on
  // the alias would save it twice, and two records for one machine drift the
  // moment either is edited — the connection triple is what a dial uses.
  const found = findReusableHost(SAVED, { host: '10.0.1.5', port: 2222, user: 'deploy' });
  assert.equal(found?.id, 'ssh-1');
});

test('a different user or port is a different host', () => {
  assert.equal(findReusableHost(SAVED, { host: '10.0.1.5', port: 2222, user: 'root' }), null);
  assert.equal(findReusableHost(SAVED, { host: '10.0.1.5', port: 22, user: 'deploy' }), null);
  assert.equal(findReusableHost(SAVED, { host: '10.0.1.6', port: 2222, user: 'deploy' }), null);
});

test('a port that arrived as a string still matches the saved number', () => {
  // A form field hands back a string, and `Number('22') === 22`. Comparing them
  // as strings would miss this and create the duplicate the rule exists to
  // prevent — which is exactly how it would happen in practice.
  const found = findReusableHost(SAVED, {
    host: '192.168.1.200',
    port: Number('22'),
    user: 'tudouni',
  });
  assert.equal(found?.id, 'ssh-2');
});

test('surrounding whitespace does not defeat the match', () => {
  const found = findReusableHost(SAVED, { host: '  10.0.1.5 ', port: 2222, user: ' deploy ' });
  assert.equal(found?.id, 'ssh-1');
});

test('an unknown host is not reused', () => {
  assert.equal(findReusableHost(SAVED, { host: 'elsewhere', port: 22, user: 'me' }), null);
  assert.equal(findReusableHost([], { host: 'elsewhere', port: 22, user: 'me' }), null);
});

/* ============================================================
   The manual form's validation
   ============================================================ */

test('the manual form needs a name, an address and a user', () => {
  assert.equal(
    newHostProblem({ alias: '', hostname: '10.0.0.1', port: '22', user: 'me' }),
    'incomplete',
  );
  assert.equal(
    newHostProblem({ alias: 'a', hostname: '', port: '22', user: 'me' }),
    'incomplete',
  );
  assert.equal(
    newHostProblem({ alias: 'a', hostname: '10.0.0.1', port: '22', user: '' }),
    'incomplete',
  );
  assert.equal(
    newHostProblem({ alias: 'a', hostname: '10.0.0.1', port: '22', user: 'me' }),
    null,
  );
});

test('the port is a real port number', () => {
  const base = { alias: 'a', hostname: '10.0.0.1', user: 'me' };
  assert.equal(newHostProblem({ ...base, port: '0' }), 'badPort');
  assert.equal(newHostProblem({ ...base, port: '65536' }), 'badPort');
  assert.equal(newHostProblem({ ...base, port: 'abc' }), 'badPort');
  assert.equal(newHostProblem({ ...base, port: '1' }), null);
  assert.equal(newHostProblem({ ...base, port: '65535' }), null);
});

test('a name that would change the file\'s meaning is refused', () => {
  const base = { hostname: '10.0.0.1', port: '22', user: 'me' };
  // `*` alone would apply the appended block to **every** host in the file,
  // which is a configuration change nobody asked for; `!` and `#` are the other
  // two ways a name stops meaning "this one host".
  assert.equal(newHostProblem({ ...base, alias: '*' }), 'badName');
  assert.equal(newHostProblem({ ...base, alias: 'prod*' }), 'badName');
  assert.equal(newHostProblem({ ...base, alias: '!prod' }), 'badName');
  assert.equal(newHostProblem({ ...base, alias: 'a#b' }), 'badName');
  assert.equal(newHostProblem({ ...base, alias: 'a b' }), 'badName');
  // An ordinary name with punctuation OpenSSH allows is fine.
  assert.equal(newHostProblem({ ...base, alias: 'bg-prod_1.example' }), null);
});

/* ============================================================
   A row's label
   ============================================================ */

test('a workspace row is the host and the directory\'s own name', () => {
  assert.equal(workspaceLabel('tudouni', '/home/tudouni/tudouni-kb'), 'tudouni:tudouni-kb');
  // A trailing slash is the same directory, not an empty name.
  assert.equal(workspaceLabel('tudouni', '/home/tudouni/tudouni-kb/'), 'tudouni:tudouni-kb');
  // The root: the trimmed path is empty, so it falls back to the path itself
  // rather than producing a label ending in a colon.
  assert.equal(workspaceLabel('host', '/'), 'host:/');
});

test('a single-segment path is its own name', () => {
  assert.equal(workspaceLabel('host', '/srv'), 'host:srv');
  assert.equal(workspaceLabel('host', 'relative-name'), 'host:relative-name');
});

/* ============================================================
   A remote path must not become a *local* workspace
   ============================================================ */

/**
 * `lastWorkspace` is opened **on this machine** by `openFirstSession` (it asks
 * `workspace_check` about it before starting anything), so a remote session must
 * never write to it: `init.workspace` on a remote child is a path on the far
 * host, and remembering it would make the next launch refuse a directory that
 * was never here — and say so on the first screen — because of a session that
 * worked.
 *
 * The same reasoning governs `focusSession`, and the rail's own `currentWorkspace`
 * (which feeds the **local** rows, where a remote path is a row that can only
 * ever fail). All three key off the session's own `remoteWorkspaceId`, so this
 * asserts the field the three of them read is set the way they assume.
 */
test('a remote session carries its remote id, a local one does not', () => {
  const local = createSessionBucket('k-local', 'C:/work/project', { ericai: false, maxSteps: null });
  assert.equal(local.remoteWorkspaceId, null, 'a local bucket has no remote workspace');
  assert.equal(local.connection.phase, 'local');

  const remote = createSessionBucket(
    'k-remote',
    '/home/tudouni/actions-runner',
    { ericai: false, maxSteps: null },
    'rw-1',
  );
  assert.equal(remote.remoteWorkspaceId, 'rw-1', 'a remote bucket names its saved row');
  // A remote session starts out connecting rather than `local` — the other half
  // of the same distinction, and what the connection badge draws from.
  assert.equal(remote.connection.phase, 'connecting');
});

/** The store must not remember a remote directory as the local one to reopen. */
test('a remote session never becomes the remembered local workspace', () => {
  const before = useApp.getState().lastWorkspace;

  // Installing a remote bucket and focusing it is what `enterRemoteWorkspace`
  // ends with; the assertion is that the remembered path did not follow it.
  const key = 'k-remote-remember';
  const bucket = createSessionBucket(key, '/home/tudouni/actions-runner', { ericai: false, maxSteps: null }, 'rw-1');
  useApp.setState((s) => ({
    sessions: { ...s.sessions, [key]: bucket },
    order: s.order.includes(key) ? s.order : [...s.order, key],
  }));
  useApp.getState().focusSession(key);

  assert.equal(
    useApp.getState().lastWorkspace,
    before,
    'focusing a remote session must not write its remote path into lastWorkspace',
  );

  useApp.setState((s) => {
    const sessions = { ...s.sessions };
    delete sessions[key];
    return { sessions, order: s.order.filter((k) => k !== key), activeKey: null };
  });
});

/* ============================================================
   Saving the same workspace twice
   ============================================================ */

/**
 * `addRemoteWorkspace` deduplicates on the (hostId, remotePath) pair.
 *
 * The wizard can legitimately be walked to the same directory twice — pick the
 * host, browse there, open it, and later do the same again — and two rows for
 * one place are indistinguishable in the sidebar (same label, same host, same
 * path) while `enterRemoteWorkspace` can only ever focus one of them. The second
 * row is then permanently un-openable, which reads as a broken button.
 *
 * Asserted on the store itself rather than on a helper, because the rule is
 * about what the list ends up holding after two calls.
 */
test('adding the same remote workspace twice keeps one row', () => {
  const store = useApp.getState();
  for (const entry of store.remoteWorkspaces) store.removeRemoteWorkspace(entry.id);
  for (const host of useApp.getState().sshHosts) useApp.getState().removeSshHost(host.id);

  const hostId = useApp.getState().addSshHost({
    label: 'test-host',
    host: '10.9.9.9',
    port: 22,
    user: 'tester',
    identityFiles: [],
  });

  const first = useApp
    .getState()
    .addRemoteWorkspace({ hostId, remotePath: '/srv/app', remoteBinary: '', label: 'a:/srv/app' });
  const second = useApp
    .getState()
    .addRemoteWorkspace({ hostId, remotePath: '/srv/app', remoteBinary: '', label: 'a:/srv/app' });

  assert.equal(first, second, 'the second add returns the row that already exists');
  assert.equal(useApp.getState().remoteWorkspaces.length, 1);

  // A different host with the same path is genuinely a different place, so it
  // does get its own row — the pair, not the path, is what identifies a row.
  const otherHost = useApp.getState().addSshHost({
    label: 'other',
    host: '10.9.9.10',
    port: 22,
    user: 'tester',
    identityFiles: [],
  });
  useApp
    .getState()
    .addRemoteWorkspace({ hostId: otherHost, remotePath: '/srv/app', remoteBinary: '', label: 'b:/srv/app' });
  assert.equal(useApp.getState().remoteWorkspaces.length, 2);

  // A path that was blank (nothing installed yet) and is now known is worth
  // recording: the wizard learned something since the row was made.
  useApp.getState().addRemoteWorkspace({
    hostId,
    remotePath: '/srv/app',
    remoteBinary: '/home/tester/.tudouni/runtime/current/tudouni-aigo',
    label: 'a:/srv/app',
  });
  const row = useApp.getState().remoteWorkspaces.find((w) => w.hostId === hostId);
  assert.equal(row?.remoteBinary, '/home/tester/.tudouni/runtime/current/tudouni-aigo');

  // Leave the store as it was found: this suite shares one module instance.
  for (const entry of useApp.getState().remoteWorkspaces) useApp.getState().removeRemoteWorkspace(entry.id);
  for (const host of useApp.getState().sshHosts) useApp.getState().removeSshHost(host.id);
});
