/**
 * The boards' workspace filter (`utils/workspaceFilter.ts`): which option a
 * session card or a Ticket lands under, and what the options list offers.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emptyTicket, type Ticket } from '@/ticket/model';
import {
  ALL_WORKSPACES,
  effectiveWorkspaceFilter,
  ticketWorkspaceScope,
  workspaceOptions,
  workspaceScopeOf,
} from '@/utils/workspaceFilter';

const REMOTES = new Map([['rw1', 'build box']]);

function ticket(patch: Partial<Ticket>): Ticket {
  return { ...emptyTicket(1), ...patch };
}

test('a local and a remote workspace with the same path are two options', () => {
  const local = workspaceScopeOf('/srv/app', null, REMOTES);
  const remote = workspaceScopeOf('/srv/app', 'rw1', REMOTES);
  assert.notEqual(local.key, remote.key);
  assert.equal(remote.label, 'build box');
  assert.equal(workspaceOptions([local, remote]).length, 2);
});

test('path spelling does not split one local workspace in two', () => {
  const a = workspaceScopeOf('C:\\Repo\\App\\', null, REMOTES);
  const b = workspaceScopeOf('c:/repo/app', null, REMOTES);
  assert.equal(a.key, b.key);
  assert.equal(workspaceOptions([a, b]).length, 1);
});

test('two directories with the same name read as their full paths', () => {
  const options = workspaceOptions([
    workspaceScopeOf('C:/one/app', null, REMOTES),
    workspaceScopeOf('C:/two/app', null, REMOTES),
  ]);
  assert.deepEqual(
    options.map((o) => o.label),
    ['C:/one/app', 'C:/two/app'],
  );
});

test('a Ticket that has run is filed where it ran, not under its ref', () => {
  const ran = ticket({
    workspace: { kind: 'active' },
    assignments: [
      {
        id: 'a1',
        executor: { kind: 'session', sessionKey: 'k', sessionId: 's', remoteWorkspaceId: null, workspace: 'C:/other' },
        startedAtMs: 1,
        endedAtMs: null,
        end: null,
      },
    ],
  });
  assert.equal(ticketWorkspaceScope(ran, 'C:/screen', null, REMOTES).key, workspaceScopeOf('C:/other', null, REMOTES).key);
});

test('a Ticket that never ran follows its ref; active means the screen', () => {
  const onScreen = ticket({ workspace: { kind: 'active' } });
  const local = ticket({ workspace: { kind: 'local', path: 'C:/bookmark' } });
  const remote = ticket({ workspace: { kind: 'remote', id: 'rw1' } });
  assert.equal(ticketWorkspaceScope(onScreen, 'C:/screen', null, REMOTES).key, 'c:/screen');
  assert.equal(ticketWorkspaceScope(local, 'C:/screen', null, REMOTES).key, 'c:/bookmark');
  assert.equal(ticketWorkspaceScope(remote, 'C:/screen', null, REMOTES).key, 'rw:rw1');
});

test('a choice with nothing left on the board falls back to all', () => {
  const options = workspaceOptions([workspaceScopeOf('C:/a', null, REMOTES)]);
  assert.equal(effectiveWorkspaceFilter('c:/a', options), 'c:/a');
  assert.equal(effectiveWorkspaceFilter('c:/gone', options), ALL_WORKSPACES);
  assert.equal(effectiveWorkspaceFilter(ALL_WORKSPACES, options), ALL_WORKSPACES);
});
