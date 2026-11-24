/**
 * The Workspace Host client, driven through a fake transport: request
 * correlation, timeouts, base64, the rules about unknown input, and what an
 * unrequested exit does to a connection.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HostRequestError,
  WorkspaceHostClient,
  WorkspaceHostRegistry,
  createWorkspaceHostStore,
  encodeBase64,
  localWorkspaceId,
  selectConnection,
  workspaceIdOf,
  type HostAttachRequest,
  type HostAttachResponse,
  type HostLineHandlers,
  type HostTransport,
  type WorkspaceTarget,
} from '@/workspaceHost';

/* ---------------- fake transport ---------------- */

class FakeTransport implements HostTransport {
  attaches: HostAttachRequest[] = [];
  sent: { workspaceId: string; msg: Record<string, unknown> }[] = [];
  shutdowns: string[] = [];
  handlers = new Map<string, Set<HostLineHandlers>>();
  attachResponse: HostAttachResponse = { already_running: false };
  attachError: Error | null = null;
  sendError: Error | null = null;
  /** Say `host_init` as part of attach, the way a fast host would. */
  autoInit = true;
  initOverrides: Record<string, unknown> = {};

  async attach(request: HostAttachRequest): Promise<HostAttachResponse> {
    this.attaches.push(request);
    if (this.attachError) throw this.attachError;
    if (this.autoInit) queueMicrotask(() => this.pushInit(request.workspaceId, request.root));
    return this.attachResponse;
  }
  async send(workspaceId: string, line: string): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.sent.push({ workspaceId, msg: JSON.parse(line) as Record<string, unknown> });
  }
  async shutdown(workspaceId: string): Promise<void> {
    this.shutdowns.push(workspaceId);
  }
  subscribe(workspaceId: string, h: HostLineHandlers): () => void {
    let set = this.handlers.get(workspaceId);
    if (!set) this.handlers.set(workspaceId, (set = new Set()));
    set.add(h);
    return () => set!.delete(h);
  }

  line(workspaceId: string, value: unknown): void {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const h of this.handlers.get(workspaceId) ?? []) h.line(text);
  }
  exit(workspaceId: string, code: number, reason: string): void {
    for (const h of this.handlers.get(workspaceId) ?? []) h.exit({ code, reason });
  }
  stderr(workspaceId: string, line: string): void {
    for (const h of this.handlers.get(workspaceId) ?? []) h.stderr(line);
  }
  initLine(workspaceId: string, root: string): Record<string, unknown> {
    return {
      v: 1,
      t: 'host_init',
      workspace_id: workspaceId,
      root,
      host_protocol: 1,
      version: '7.8.0',
      pid: 4242,
      workspace_capabilities: {
        files: true,
        file_watch: true,
        file_range_read: true,
        git: false,
        terminal: true,
        terminal_output_replay: true,
        system_open: false,
      },
      ...this.initOverrides,
    };
  }
  pushInit(workspaceId: string, root: string): void {
    this.line(workspaceId, this.initLine(workspaceId, root));
  }
  /** The last request sent with this `t`. */
  last(t: string): Record<string, unknown> {
    const found = [...this.sent].reverse().find((s) => s.msg.t === t);
    assert.ok(found, `no ${t} was sent`);
    return found.msg;
  }
  reply(workspaceId: string, req: unknown, data: unknown): void {
    this.line(workspaceId, { v: 1, t: 'result', req, ok: true, data });
  }
}

function target(id = 'local:abc', root = '/work/app'): WorkspaceTarget {
  return { workspaceId: id, root, remoteWorkspaceId: null, connection: null };
}

async function ready(options: { requestTimeoutMs?: number; initTimeoutMs?: number } = {}) {
  const transport = new FakeTransport();
  const client = new WorkspaceHostClient(target(), { transport, ...options });
  await client.connect();
  return { transport, client };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/* ---------------- connecting ---------------- */

test('connect attaches with the target and resolves on host_init', async () => {
  const transport = new FakeTransport();
  const client = new WorkspaceHostClient(target(), { transport });
  assert.equal(client.connection.state, 'idle');
  const seen: string[] = [];
  client.onConnection((c) => seen.push(c.state));
  const connection = await client.connect();
  assert.equal(connection.state, 'ready');
  assert.deepEqual(seen, ['connecting', 'ready']);
  assert.deepEqual(transport.attaches, [
    { workspaceId: 'local:abc', root: '/work/app', remoteWorkspaceId: null, connection: null },
  ]);
  assert.equal(connection.capabilities?.git, false);
  assert.equal(connection.capabilities?.terminal, true);
  assert.equal(connection.capabilities?.system_open, false);
  assert.equal(connection.root, '/work/app');
  assert.equal(connection.hostVersion, '7.8.0');
  assert.equal(connection.hostPid, 4242);
});

test('concurrent connects share one attach, and a ready client does not attach again', async () => {
  const transport = new FakeTransport();
  const client = new WorkspaceHostClient(target(), { transport });
  await Promise.all([client.connect(), client.connect(), client.connect()]);
  await client.connect();
  assert.equal(transport.attaches.length, 1);
});

test('a host_init that beats the attach reply is not lost', async () => {
  const transport = new FakeTransport();
  transport.autoInit = false;
  const client = new WorkspaceHostClient(target(), { transport });
  const originalAttach = transport.attach.bind(transport);
  transport.attach = async (request) => {
    transport.pushInit(request.workspaceId, request.root); // before the reply
    return originalAttach(request);
  };
  assert.equal((await client.connect()).state, 'ready');
});

test('an already running host replays its opening line from the attach answer', async () => {
  const transport = new FakeTransport();
  transport.autoInit = false;
  transport.attachResponse = {
    already_running: true,
    init_line: JSON.stringify(transport.initLine('local:abc', '/work/app')),
  };
  const client = new WorkspaceHostClient(target(), { transport });
  assert.equal((await client.connect()).state, 'ready');
});

test('a failed attach is disconnected with the reason, and can be retried', async () => {
  const transport = new FakeTransport();
  transport.attachError = new Error('the workspace /x is not a directory');
  const client = new WorkspaceHostClient(target(), { transport });
  await assert.rejects(client.connect(), (e: unknown) => {
    assert.ok(e instanceof HostRequestError);
    assert.equal(e.code, 'attach_failed');
    return true;
  });
  assert.equal(client.connection.state, 'disconnected');
  assert.match(client.connection.lastError ?? '', /not a directory/);
  transport.attachError = null;
  assert.equal((await client.reconnect()).state, 'ready');
  assert.equal(client.connection.lastError, null);
});

test('no host_init within the budget is a timeout, not a hang', async () => {
  const transport = new FakeTransport();
  transport.autoInit = false;
  const client = new WorkspaceHostClient(target(), { transport, initTimeoutMs: 20 });
  await assert.rejects(client.connect(), (e: unknown) => e instanceof HostRequestError && e.code === 'timeout');
  assert.equal(client.connection.state, 'disconnected');
  assert.equal(client.connection.lastErrorCode, 'timeout');
});

test('reconnect after a handshake timeout ends the wedged host first', async () => {
  const transport = new FakeTransport();
  transport.autoInit = false;
  const client = new WorkspaceHostClient(target(), { transport, initTimeoutMs: 20 });
  await assert.rejects(client.connect());
  transport.autoInit = true;
  await client.reconnect();
  assert.deepEqual(transport.shutdowns, ['local:abc']);
  assert.equal(client.connection.state, 'ready');
  // The wedged host's exit arrives late and must not take the new one down.
  transport.exit('local:abc', 0, 'shutdown');
  assert.equal(client.connection.state, 'ready');
});

test('a host speaking another protocol is refused with a sentence', async () => {
  const transport = new FakeTransport();
  transport.initOverrides = { host_protocol: 2 };
  const client = new WorkspaceHostClient(target(), { transport });
  await assert.rejects(client.connect(), (e: unknown) => e instanceof HostRequestError && e.code === 'protocol_mismatch');
  await tick();
  assert.equal(client.connection.lastErrorCode, 'protocol_mismatch');
  assert.match(client.connection.lastError ?? '', /protocol 2/);
  assert.equal(client.connection.capabilities, null);
});

test('a host_init for another workspace is ignored', async () => {
  const transport = new FakeTransport();
  transport.autoInit = false;
  const client = new WorkspaceHostClient(target(), { transport, initTimeoutMs: 30 });
  const connecting = client.connect();
  await tick();
  transport.line('local:abc', transport.initLine('local:other', '/elsewhere'));
  await assert.rejects(connecting, (e: unknown) => e instanceof HostRequestError && e.code === 'timeout');
});

/* ---------------- requests ---------------- */

test('requests are refused before the host is ready', async () => {
  const transport = new FakeTransport();
  const client = new WorkspaceHostClient(target(), { transport });
  await assert.rejects(client.fsList(''), (e: unknown) => e instanceof HostRequestError && e.code === 'not_connected');
  assert.equal(transport.sent.length, 0);
});

test('results are correlated by req, in any order', async () => {
  const { transport, client } = await ready();
  const a = client.fsList('src');
  const b = client.fsStat('a.go');
  const c = client.gitStatus();
  await tick();
  assert.equal(transport.sent.length, 3);
  const [ra, rb, rc] = transport.sent.map((s) => s.msg.req);
  assert.equal(new Set([ra, rb, rc]).size, 3, 'req values are unique');
  // Answered in reverse order.
  transport.reply('local:abc', rc, { repo: false, entries: [], truncated: false });
  transport.reply('local:abc', rb, { name: 'a.go', path: 'a.go', kind: 'file', size: 3, mtime_ms: 1, hidden: false });
  transport.reply('local:abc', ra, { path: 'src', entries: [], truncated: false });
  assert.equal((await a).path, 'src');
  assert.equal((await b).name, 'a.go');
  assert.equal((await c).repo, false);
});

test('request parameters and the envelope reach the wire as the spec names them', async () => {
  const { transport, client } = await ready();
  void client.fsRead('a.go', { offset: 10, limit: 20 }).catch(() => undefined);
  void client.gitDiff('a.go', 'index').catch(() => undefined);
  void client.termCreate({ cwd: 'sub', cols: 100, rows: 30, title: 't' }).catch(() => undefined);
  void client.termAttach('t1', 7).catch(() => undefined);
  void client.termAttach('t2').catch(() => undefined);
  void client.fsSearch('main', { limit: 5 }).catch(() => undefined);
  await tick();
  const by = (t: string) => transport.sent.filter((s) => s.msg.t === t).map((s) => s.msg);
  const fsRead = by('fs_read')[0]!;
  assert.equal(fsRead.v, 1);
  assert.equal(typeof fsRead.req, 'string');
  assert.deepEqual({ path: fsRead.path, offset: fsRead.offset, limit: fsRead.limit }, { path: 'a.go', offset: 10, limit: 20 });
  assert.deepEqual([by('git_diff')[0]!.path, by('git_diff')[0]!.source], ['a.go', 'index']);
  const create = by('term_create')[0]!;
  assert.deepEqual([create.cwd, create.cols, create.rows, create.title], ['sub', 100, 30, 't']);
  const attaches = by('term_attach');
  assert.equal(attaches[0]!.from_seq, 7);
  assert.equal('from_seq' in attaches[1]!, false, 'an omitted from_seq is not sent');
  assert.deepEqual([by('fs_search')[0]!.query, by('fs_search')[0]!.limit], ['main', 5]);
});

test('a failed result rejects with the host error code and the request name', async () => {
  const { transport, client } = await ready();
  const p = client.fsRead('../../etc/passwd');
  await tick();
  transport.line('local:abc', {
    v: 1,
    t: 'result',
    req: transport.last('fs_read').req,
    ok: false,
    error: { code: 'path_escape', message: 'outside the workspace' },
  });
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof HostRequestError);
    assert.equal(e.code, 'path_escape');
    assert.equal(e.request, 'fs_read');
    assert.equal(e.message, 'outside the workspace');
    return true;
  });
});

test('a request that gets no answer times out, and its late result is dropped', async () => {
  const { transport, client } = await ready({ requestTimeoutMs: 20 });
  const p = client.gitStatus();
  await tick();
  const req = transport.last('git_status').req;
  await assert.rejects(p, (e: unknown) => e instanceof HostRequestError && e.code === 'timeout' && e.request === 'git_status');
  // The answer arrives after the budget: nothing throws, nothing changes.
  transport.reply('local:abc', req, { repo: false });
  assert.equal(client.connection.state, 'ready');
  // A later request still works.
  const next = client.gitStatus();
  await tick();
  transport.reply('local:abc', transport.last('git_status').req, { repo: true });
  assert.equal((await next).repo, true);
});

test('a per-request timeout overrides the default', async () => {
  const { client } = await ready({ requestTimeoutMs: 60_000 });
  await assert.rejects(client.fsList('', { timeoutMs: 15 }), (e: unknown) => e instanceof HostRequestError && e.code === 'timeout');
});

test('a send that fails rejects that request only', async () => {
  const { transport, client } = await ready();
  transport.sendError = new Error('that workspace\'s host is not running');
  await assert.rejects(client.fsList(''), (e: unknown) => e instanceof HostRequestError && e.code === 'send_failed');
  transport.sendError = null;
  assert.equal(client.connection.state, 'ready');
});

/* ---------------- unknown input ---------------- */

test('unknown messages, unknown fields, other versions and junk are ignored', async () => {
  const { transport, client } = await ready();
  const events: unknown[] = [];
  client.onWorkspaceEvent((e) => events.push(e));
  const before = client.connection;

  transport.line('local:abc', { v: 1, t: 'brand_new_push', anything: 1 });
  transport.line('local:abc', { v: 1, t: 'term_gap', id: 't1' });
  transport.line('local:abc', { v: 2, t: 'workspace_event', revision: 1, changes: [], invalidates: [], reset_required: false });
  transport.line('local:abc', { t: 'workspace_event', revision: 1 });
  transport.line('local:abc', '[1,2,3]');
  transport.line('local:abc', 'not json at all');
  transport.line('local:abc', { v: 1, t: 'result', req: 'never-sent', ok: true, data: {} });
  transport.line('local:abc', { v: 1, t: 'result', ok: true, data: {} });
  assert.equal(client.connection, before);
  assert.deepEqual(events, []);
  assert.equal(client.droppedLineCount, 1, 'only the non-JSON line is counted as dropped');

  // Unknown fields on a known message do not matter.
  const p = client.fsStat('a');
  await tick();
  transport.line('local:abc', {
    v: 1, t: 'result', req: transport.last('fs_stat').req, ok: true, extra: true,
    data: { name: 'a', path: 'a', kind: 'file', size: 1, mtime_ms: 2, hidden: false, brand_new_field: 1 },
  });
  assert.equal((await p).name, 'a');
});

/* ---------------- pushes ---------------- */

test('workspace_event reaches subscribers, normalised', async () => {
  const { transport, client } = await ready();
  const seen: unknown[] = [];
  const off = client.onWorkspaceEvent((e) => seen.push(e));
  transport.line('local:abc', {
    v: 1, t: 'workspace_event', workspace_id: 'local:abc', revision: 108,
    changes: [{ path: 'src/main.go', type: 'modified' }], invalidates: ['files', 'git'], reset_required: false,
  });
  transport.line('local:abc', { v: 1, t: 'workspace_event', revision: 109, reset_required: true });
  off();
  transport.line('local:abc', { v: 1, t: 'workspace_event', revision: 110 });
  assert.deepEqual(seen, [
    {
      workspace_id: 'local:abc', revision: 108,
      changes: [{ path: 'src/main.go', type: 'modified' }], invalidates: ['files', 'git'], reset_required: false,
    },
    { workspace_id: 'local:abc', revision: 109, changes: [], invalidates: [], reset_required: true },
  ]);
});

test('term_output is base64-decoded to bytes, including bytes that are not UTF-8', async () => {
  const { transport, client } = await ready();
  const seen: { id: string; seq: number; data: Uint8Array }[] = [];
  client.onTermOutput((e) => seen.push(e));
  const bytes = new Uint8Array([0x68, 0x69, 0xe4, 0xbd]); // "hi" + half of a 3-byte character
  transport.line('local:abc', { v: 1, t: 'term_output', id: 't1', seq: 4096, data: encodeBase64(bytes) });
  transport.line('local:abc', { v: 1, t: 'term_output', id: 't1', seq: 4100, data: '' });
  transport.line('local:abc', { v: 1, t: 'term_output', id: 't1', seq: 'x', data: 'aGk=' }); // malformed: ignored
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.id, 't1');
  assert.equal(seen[0]!.seq, 4096);
  assert.ok(seen[0]!.data instanceof Uint8Array);
  assert.deepEqual([...seen[0]!.data], [...bytes]);
  assert.equal(seen[1]!.data.length, 0);
});

test('term_output with an undecodable payload is dropped, not thrown', async () => {
  const { transport, client } = await ready();
  const seen: unknown[] = [];
  client.onTermOutput((e) => seen.push(e));
  transport.line('local:abc', { v: 1, t: 'term_output', id: 't1', seq: 0, data: '***not base64***' });
  assert.deepEqual(seen, []);
  assert.equal(client.droppedLineCount, 1);
});

test('term_exit reaches subscribers', async () => {
  const { transport, client } = await ready();
  const seen: unknown[] = [];
  client.onTermExit((e) => seen.push(e));
  transport.line('local:abc', { v: 1, t: 'term_exit', id: 't1', exit_code: 3 });
  transport.line('local:abc', { v: 1, t: 'term_exit', id: 't2' });
  assert.deepEqual(seen, [{ id: 't1', exit_code: 3 }, { id: 't2', exit_code: null }]);
});

test('term_gap reaches subscribers; a malformed one is ignored', async () => {
  const { transport, client } = await ready();
  const seen: unknown[] = [];
  const off = client.onTermGap((e) => seen.push(e));
  transport.line('local:abc', { v: 1, t: 'term_gap', id: 't1', from_seq: 100, to_seq: 4196 });
  transport.line('local:abc', { v: 1, t: 'term_gap', id: 't1', from_seq: 'x', to_seq: 5 });
  transport.line('local:abc', { v: 1, t: 'term_gap', from_seq: 1, to_seq: 5 });
  assert.deepEqual(seen, [{ id: 't1', from_seq: 100, to_seq: 4196 }]);
  off();
  transport.line('local:abc', { v: 1, t: 'term_gap', id: 't1', from_seq: 1, to_seq: 2 });
  assert.equal(seen.length, 1);
});

test('a throwing subscriber does not stop the others', async () => {
  const { transport, client } = await ready();
  const original = console.error;
  console.error = () => undefined;
  try {
    const seen: number[] = [];
    client.onTermExit(() => { throw new Error('boom'); });
    client.onTermExit((e) => seen.push(e.exit_code ?? -1));
    transport.line('local:abc', { v: 1, t: 'term_exit', id: 't1', exit_code: 0 });
    assert.deepEqual(seen, [0]);
  } finally {
    console.error = original;
  }
});

/* ---------------- typed methods that decode ---------------- */

test('termAttach decodes the replay and keeps gap / from_seq', async () => {
  const { transport, client } = await ready();
  const p = client.termAttach('t1', 0);
  await tick();
  transport.reply('local:abc', transport.last('term_attach').req, {
    terminal: { id: 't1', workspace_id: 'local:abc', cwd: '', shell: 'sh', title: 'sh', created_at: 1, state: 'running', exit_code: null, cols: 80, rows: 24, output_seq: 5 },
    from_seq: 2,
    data: encodeBase64(new TextEncoder().encode('llo')),
    gap: true,
  });
  const r = await p;
  assert.equal(r.gap, true);
  assert.equal(r.from_seq, 2);
  assert.equal(new TextDecoder().decode(r.data), 'llo');
  assert.equal(r.terminal.output_seq, 5);
});

test('fsReadBytes decodes the file into bytes', async () => {
  const { transport, client } = await ready();
  const p = client.fsReadBytes('logo.png', { max: 1024 });
  await tick();
  assert.equal(transport.last('fs_read_bytes').max, 1024);
  transport.reply('local:abc', transport.last('fs_read_bytes').req, {
    path: 'logo.png', size: 3, mime: 'image/png', data: encodeBase64(new Uint8Array([0x89, 0x50, 0x4e])),
  });
  const r = await p;
  assert.deepEqual([...r.data], [0x89, 0x50, 0x4e]);
  assert.equal(r.mime, 'image/png');
});

test('termList / termCreate unwrap their payloads; the void methods resolve', async () => {
  const { transport, client } = await ready();
  const term = { id: 't1', workspace_id: 'local:abc', cwd: '', shell: 'sh', title: 'sh', created_at: 1, state: 'running', exit_code: null, cols: 80, rows: 24, output_seq: 0 };
  const list = client.termList();
  const create = client.termCreate();
  await tick();
  transport.reply('local:abc', transport.last('term_list').req, { terminals: [term] });
  transport.reply('local:abc', transport.last('term_create').req, { terminal: term });
  assert.equal((await list).length, 1);
  assert.equal((await create).id, 't1');

  const calls = [
    client.termDetach('t1'),
    client.termInput('t1', 'ls\r'),
    client.termResize('t1', 120, 40),
    client.termKill('t1'),
    client.termClose('t1'),
  ];
  await tick();
  for (const t of ['term_detach', 'term_input', 'term_resize', 'term_kill', 'term_close']) {
    transport.reply('local:abc', transport.last(t).req, {});
  }
  await Promise.all(calls);
  assert.equal(transport.last('term_input').data, 'ls\r');
  assert.deepEqual([transport.last('term_resize').cols, transport.last('term_resize').rows], [120, 40]);
});

/* ---------------- the host going away ---------------- */

test('an unrequested exit disconnects, rejects what is in flight and says why', async () => {
  const { transport, client } = await ready();
  const disconnects: string[] = [];
  client.onDisconnect((i) => disconnects.push(i.code));
  transport.stderr('local:abc', 'panic: something');
  const inFlight = client.gitStatus();
  await tick();
  transport.exit('local:abc', 2, 'exited');
  await assert.rejects(inFlight, (e: unknown) => e instanceof HostRequestError && e.code === 'disconnected');
  const c = client.connection;
  assert.equal(c.state, 'disconnected');
  assert.equal(c.capabilities, null);
  assert.equal(c.lastErrorCode, 'host_exited');
  assert.match(c.lastError ?? '', /code 2/);
  assert.match(c.lastError ?? '', /panic: something/);
  assert.deepEqual(c.exit, { code: 2, reason: 'exited' });
  assert.deepEqual(disconnects, ['host_exited']);
  await assert.rejects(client.fsList(''), (e: unknown) => e instanceof HostRequestError && e.code === 'not_connected');
});

test('a lost ssh channel is reported as such', async () => {
  const { transport, client } = await ready();
  transport.exit('local:abc', -1, 'ssh_closed');
  assert.equal(client.connection.lastErrorCode, 'ssh_closed');
  assert.match(client.connection.lastError ?? '', /connection to the remote host was lost/);
});

test('reconnect brings a disconnected host back and does nothing to a ready one', async () => {
  const { transport, client } = await ready();
  transport.exit('local:abc', 1, 'exited');
  assert.equal(client.connection.state, 'disconnected');
  await client.reconnect();
  assert.equal(client.connection.state, 'ready');
  assert.equal(transport.attaches.length, 2);
  await client.reconnect();
  assert.equal(transport.attaches.length, 2, 'a ready host is not restarted');
  assert.deepEqual(transport.shutdowns, []);
});

test('disconnect on purpose goes idle, shuts the host down and is not a failure', async () => {
  const { transport, client } = await ready();
  const disconnects: unknown[] = [];
  client.onDisconnect((i) => disconnects.push(i));
  const inFlight = client.fsList('');
  await tick();
  await client.disconnect();
  await assert.rejects(inFlight, (e: unknown) => e instanceof HostRequestError && e.code === 'disconnected');
  assert.equal(client.connection.state, 'idle');
  assert.deepEqual(transport.shutdowns, ['local:abc']);
  // The exit we asked for comes back and changes nothing.
  transport.exit('local:abc', 0, 'shutdown');
  assert.equal(client.connection.state, 'idle');
  assert.deepEqual(disconnects, []);
});

test('connect after disconnect starts a fresh host, and the old exit does not kill it', async () => {
  const { transport, client } = await ready();
  await client.disconnect();
  await client.connect();
  assert.equal(client.connection.state, 'ready');
  transport.exit('local:abc', 0, 'shutdown'); // the first host's exit, late
  assert.equal(client.connection.state, 'ready');
});

test('dispose stops listening and fails what is in flight, but leaves the host alone', async () => {
  const { transport, client } = await ready();
  const p = client.fsList('');
  await tick();
  client.dispose();
  await assert.rejects(p, (e: unknown) => e instanceof HostRequestError && e.code === 'disposed');
  assert.equal(transport.handlers.get('local:abc')?.size ?? 0, 0);
  assert.deepEqual(transport.shutdowns, []);
  await assert.rejects(client.connect(), (e: unknown) => e instanceof HostRequestError && e.code === 'disposed');
});

/* ---------------- the registry ---------------- */

test('the registry keeps one client and one connection per workspace id', async () => {
  const transport = new FakeTransport();
  const store = createWorkspaceHostStore();
  const registry = new WorkspaceHostRegistry({ transport, store });
  const a = target('local:a', '/a');
  const b = target('local:b', '/b');

  assert.equal(registry.clientFor(a), registry.clientFor(a));
  assert.notEqual(registry.clientFor(a), registry.clientFor(b));
  assert.equal(selectConnection(store.getState(), 'local:a').state, 'idle');
  assert.equal(selectConnection(store.getState(), 'never-seen').state, 'idle');
  assert.equal(selectConnection(store.getState(), null), selectConnection(store.getState(), 'never-seen'), 'one shared idle value');

  await registry.connect(a);
  assert.equal(selectConnection(store.getState(), 'local:a').state, 'ready');
  assert.equal(selectConnection(store.getState(), 'local:b').state, 'idle', 'workspaces do not share state');
  assert.deepEqual(transport.attaches.map((r) => r.workspaceId), ['local:a']);

  // A's host dying does not touch B's.
  await registry.connect(b);
  transport.exit('local:a', 1, 'exited');
  assert.equal(selectConnection(store.getState(), 'local:a').state, 'disconnected');
  assert.equal(selectConnection(store.getState(), 'local:b').state, 'ready');

  await registry.reconnect(a);
  assert.equal(selectConnection(store.getState(), 'local:a').state, 'ready');
});

test('closing a workspace ends its host and forgets it; releasing keeps the host', async () => {
  const transport = new FakeTransport();
  const store = createWorkspaceHostStore();
  const registry = new WorkspaceHostRegistry({ transport, store });
  await registry.connect(target('local:a', '/a'));
  await registry.connect(target('local:b', '/b'));

  await registry.close('local:a');
  assert.deepEqual(transport.shutdowns, ['local:a']);
  assert.equal(registry.get('local:a'), undefined);
  assert.equal('local:a' in store.getState().connections, false);

  registry.release('local:b');
  assert.deepEqual(transport.shutdowns, ['local:a'], 'release does not stop the host');
  assert.equal(registry.get('local:b'), undefined);
});

test('ready() resolves a usable client or rejects with the reason', async () => {
  const transport = new FakeTransport();
  const registry = new WorkspaceHostRegistry({ transport, store: createWorkspaceHostStore() });
  const client = await registry.ready(target('local:a', '/a'));
  assert.equal(client.isReady, true);
  transport.attachError = new Error('no binary');
  await assert.rejects(registry.ready(target('local:z', '/z')), (e: unknown) => e instanceof HostRequestError && e.code === 'attach_failed');
});

/* ---------------- workspace ids ---------------- */

test('a local workspace id is derived from the normalised path and is stable', () => {
  const id = localWorkspaceId('C:\\Work\\App');
  assert.match(id, /^local:[0-9a-f]{16}$/);
  // Same directory spelled differently (case, separators, trailing slash).
  assert.equal(localWorkspaceId('c:/work/app/'), id);
  assert.equal(localWorkspaceId('C:\\Work\\App\\'), id);
  // A different directory is a different id.
  assert.notEqual(localWorkspaceId('C:\\Work\\Other'), id);
  // Pinned: a change here would orphan every running host's identity after an
  // upgrade, so it has to be a conscious one.
  assert.equal(localWorkspaceId('/srv/app'), 'local:' + localWorkspaceId('/SRV/app/').slice('local:'.length));
});

test('a remote workspace is known by its saved entry id, whatever the path', () => {
  assert.equal(workspaceIdOf('/srv/app', 'rw-abc-123'), 'rw-abc-123');
  assert.equal(workspaceIdOf('/srv/other', 'rw-abc-123'), 'rw-abc-123');
  assert.equal(workspaceIdOf('/srv/app', null), localWorkspaceId('/srv/app'));
});
