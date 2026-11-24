/**
 * Terminal recovery (docs/design/workspace-dock.md 7.4-7.6): the byte-offset
 * dedupe and gap rules, and the manager's bookkeeping against a fake host
 * client and a fake emulator. xterm needs a DOM, so it is never imported here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TermStream,
  TerminalHostManager,
  type TermAttachResult,
  type TermExitEvent,
  type TermGapEvent,
  type TermHostClient,
  type TermOutputEvent,
  type TermView,
  type Term,
  type WorkspaceConnection,
  type WorkspaceTarget,
  IDLE_CONNECTION,
} from '@/workspaceHost';
import { pickAfterClose, tabName } from '@/components/dock/terminal/tabs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (s: string) => enc.encode(s);

class Sink {
  chunks: string[] = [];
  write(data: Uint8Array | string): void {
    this.chunks.push(typeof data === 'string' ? data : dec.decode(data));
  }
  get text(): string {
    return this.chunks.join('');
  }
}

const GAP = 'output before this point is no longer available';

/* ---------------- TermStream ---------------- */

test('stream: in-order chunks are written and advance lastSeq by bytes', () => {
  const sink = new Sink();
  const s = new TermStream(sink, () => GAP);
  assert.equal(s.output(0, bytes('hello ')), 'written');
  assert.equal(s.output(6, bytes('world')), 'written');
  assert.equal(sink.text, 'hello world');
  assert.equal(s.lastSeq, 11);
});

test('stream: seq counts bytes, not characters', () => {
  const sink = new Sink();
  const s = new TermStream(sink, () => GAP);
  s.output(0, bytes('é')); // 2 bytes
  assert.equal(s.lastSeq, 2);
});

test('stream: a repeated or older chunk is dropped; an overlapping one is trimmed', () => {
  const sink = new Sink();
  const s = new TermStream(sink, () => GAP);
  s.output(0, bytes('abcdef'));
  assert.equal(s.output(0, bytes('abcdef')), 'dropped');
  assert.equal(s.output(2, bytes('cd')), 'dropped');
  assert.equal(s.output(4, bytes('efgh')), 'trimmed');
  assert.equal(sink.text, 'abcdefgh');
  assert.equal(s.lastSeq, 8);
});

test('stream: an empty chunk changes nothing', () => {
  const sink = new Sink();
  const s = new TermStream(sink, () => GAP);
  assert.equal(s.output(0, new Uint8Array(0)), 'dropped');
  assert.equal(sink.chunks.length, 0);
});

test('stream: a hole between chunks writes the notice once and continues', () => {
  const sink = new Sink();
  const s = new TermStream(sink, () => GAP);
  s.output(0, bytes('ab'));
  s.output(10, bytes('cd'));
  assert.equal(sink.text.split(GAP).length - 1, 1);
  assert.ok(sink.text.startsWith('ab'));
  assert.ok(sink.text.endsWith('cd'));
  assert.equal(s.lastSeq, 12);
});

test('stream: term_gap writes the notice and resumes at to_seq; a stale one is ignored', () => {
  const sink = new Sink();
  const s = new TermStream(sink, () => GAP);
  s.output(0, bytes('ab'));
  s.skip(2, 100);
  assert.equal(s.lastSeq, 100);
  s.output(100, bytes('xy'));
  s.skip(2, 50); // already past
  assert.equal(sink.text.split(GAP).length - 1, 1);
  assert.equal(s.lastSeq, 102);
});

test('stream: attach with gap announces it before the replay; live output waits behind the replay', () => {
  const sink = new Sink();
  const s = new TermStream(sink, () => GAP);
  s.output(0, bytes('old'));
  s.beginAttach();
  // A push that overtakes the attach result is held, not written early.
  assert.equal(s.output(13, bytes('LIVE')), 'queued');
  assert.equal(sink.text, 'old');
  s.applyAttach(10, bytes('abc'), true);
  assert.equal(
    sink.text,
    `old\u001b[0m\r\n\u001b[2m${GAP}\u001b[0m\r\nabcLIVE`,
  );
  assert.equal(s.lastSeq, 17);
  assert.equal(s.attaching, false);
});

test('stream: a replay that overlaps what was already written is deduped', () => {
  const sink = new Sink();
  const s = new TermStream(sink, () => GAP);
  s.output(0, bytes('0123456789'));
  s.beginAttach();
  s.applyAttach(4, bytes('456789ABC'), false);
  assert.equal(sink.text, '0123456789ABC');
  assert.equal(s.lastSeq, 13);
});

test('stream: a cancelled attach releases nothing and accepts live output again', () => {
  const sink = new Sink();
  const s = new TermStream(sink, () => GAP);
  s.beginAttach();
  s.cancelAttach();
  assert.equal(s.output(0, bytes('x')), 'written');
});

/* ---------------- tabs ---------------- */

test('tabName: custom name wins; otherwise the shell base name and the id', () => {
  assert.equal(tabName({ id: 't2', customName: 'build', title: 'pwsh', shell: 'x' }), 'build');
  assert.equal(tabName({ id: 't2', customName: null, title: 'C:\\Windows\\pwsh.exe', shell: 'x' }), 'pwsh.exe t2');
  assert.equal(tabName({ id: 't3', customName: null, title: '', shell: '/bin/bash' }), 'bash t3');
});

test('pickAfterClose: keeps an unrelated active tab, else right neighbour, else left, else none', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(pickAfterClose(list, 'a', 'c'), 'c');
  assert.equal(pickAfterClose(list, 'b', 'b'), 'c');
  assert.equal(pickAfterClose(list, 'c', 'c'), 'b');
  assert.equal(pickAfterClose([{ id: 'a' }], 'a', 'a'), null);
});

/* ---------------- manager ---------------- */

class FakeView implements TermView {
  written = new Sink();
  mounted: unknown = null;
  mounts = 0;
  unmounts = 0;
  disposed = false;
  size: { cols: number; rows: number } | null = { cols: 100, rows: 30 };
  focuses = 0;
  constructor(readonly onData: (d: string) => void) {}
  write(d: Uint8Array | string): void {
    this.written.write(d);
  }
  mount(slot: unknown): void {
    this.mounted = slot;
    this.mounts++;
  }
  unmount(): void {
    this.mounted = null;
    this.unmounts++;
  }
  fit() {
    return this.mounted === null ? null : this.size;
  }
  focus(): void {
    this.focuses++;
  }
  refreshTheme(): void {}
  dispose(): void {
    this.disposed = true;
  }
}

class FakeClient implements TermHostClient {
  isReady = true;
  terms: Term[] = [];
  /** Per terminal: the whole output so far. */
  output = new Map<string, Uint8Array>();
  ringStart = new Map<string, number>();
  calls: string[] = [];
  attaches: { id: string; from: number | undefined }[] = [];
  resizes: { id: string; cols: number; rows: number }[] = [];
  inputs: { id: string; data: string }[] = [];
  private conn = new Set<(c: WorkspaceConnection) => void>();
  private out = new Set<(e: TermOutputEvent) => void>();
  private exit = new Set<(e: TermExitEvent) => void>();
  private gap = new Set<(e: TermGapEvent) => void>();
  nextId = 1;

  onConnection(cb: (c: WorkspaceConnection) => void) {
    this.conn.add(cb);
    return () => void this.conn.delete(cb);
  }
  onTermOutput(cb: (e: TermOutputEvent) => void) {
    this.out.add(cb);
    return () => void this.out.delete(cb);
  }
  onTermExit(cb: (e: TermExitEvent) => void) {
    this.exit.add(cb);
    return () => void this.exit.delete(cb);
  }
  onTermGap(cb: (e: TermGapEvent) => void) {
    this.gap.add(cb);
    return () => void this.gap.delete(cb);
  }
  async termList() {
    this.calls.push('list');
    return this.terms.map((t) => ({ ...t }));
  }
  async termCreate(params: { cwd?: string; cols?: number; rows?: number } = {}) {
    this.calls.push('create');
    const t: Term = {
      id: `t${this.nextId++}`,
      workspace_id: 'ws',
      cwd: params.cwd ?? '',
      shell: 'pwsh',
      title: 'pwsh',
      created_at: 1000 + this.nextId,
      state: 'running',
      exit_code: null,
      cols: params.cols ?? 80,
      rows: params.rows ?? 24,
      output_seq: 0,
    };
    this.terms.push(t);
    return { ...t };
  }
  async termAttach(id: string, fromSeq = 0): Promise<TermAttachResult> {
    this.calls.push('attach');
    this.attaches.push({ id, from: fromSeq });
    const all = this.output.get(id) ?? new Uint8Array(0);
    const start = this.ringStart.get(id) ?? 0;
    const from = Math.max(fromSeq, start);
    return {
      terminal: { ...this.terms.find((t) => t.id === id)! },
      from_seq: from,
      data: all.subarray(from),
      gap: fromSeq < start,
    };
  }
  async termInput(id: string, data: string) {
    this.inputs.push({ id, data });
  }
  async termResize(id: string, cols: number, rows: number) {
    this.resizes.push({ id, cols, rows });
  }
  async termKill(id: string) {
    this.calls.push('kill');
    const t = this.terms.find((x) => x.id === id)!;
    t.state = 'exited';
    t.exit_code = null;
  }
  async termClose(id: string) {
    this.calls.push('close');
    this.terms = this.terms.filter((x) => x.id !== id);
  }

  // test drivers
  push(id: string, seq: number, text: string) {
    const data = bytes(text);
    const prev = this.output.get(id) ?? new Uint8Array(0);
    const next = new Uint8Array(Math.max(prev.length, seq + data.length));
    next.set(prev);
    next.set(data, seq);
    this.output.set(id, next);
    for (const cb of [...this.out]) cb({ id, seq, data });
  }
  emitExit(id: string, code: number | null) {
    const t = this.terms.find((x) => x.id === id);
    if (t) {
      t.state = 'exited';
      t.exit_code = code;
    }
    for (const cb of [...this.exit]) cb({ id, exit_code: code });
  }
  emitGap(id: string, from: number, to: number) {
    for (const cb of [...this.gap]) cb({ id, from_seq: from, to_seq: to });
  }
  setConnection(state: WorkspaceConnection['state']) {
    this.isReady = state === 'ready';
    for (const cb of [...this.conn]) cb({ ...IDLE_CONNECTION, state });
  }
}

const target: WorkspaceTarget = { workspaceId: 'ws', root: '/w', remoteWorkspaceId: null, connection: null };

function setup(debounce = 0) {
  const client = new FakeClient();
  const views: FakeView[] = [];
  const manager = new TerminalHostManager({
    clientFor: () => client,
    createView: ({ onData }) => {
      const v = new FakeView(onData);
      views.push(v);
      return v;
    },
    notices: {
      gap: () => GAP,
      exited: (c) => (c === null ? 'process exited' : `process exited (code ${c})`),
      hostLost: () => 'host ended',
    },
    resizeDebounceMs: debounce,
  });
  return { client, views, manager };
}

const wait = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

function seed(client: FakeClient, id: string, text: string) {
  client.terms.push({
    id,
    workspace_id: 'ws',
    cwd: '',
    shell: 'pwsh',
    title: 'pwsh',
    created_at: 500,
    state: 'running',
    exit_code: null,
    cols: 80,
    rows: 24,
    output_seq: bytes(text).length,
  });
  client.output.set(id, bytes(text));
}

test('manager: open lists, creates a view per terminal and attaches from 0', async () => {
  const { client, views, manager } = setup();
  seed(client, 't1', 'hello');
  await manager.open(target);
  assert.equal(views.length, 1);
  assert.equal(views[0]!.written.text, 'hello');
  assert.deepEqual(client.attaches, [{ id: 't1', from: 0 }]);
  assert.equal(manager.lastSeq('ws', 't1'), 5);
  assert.equal(manager.terminals('ws').length, 1);
  assert.equal(client.calls.includes('create'), false);
});

test('manager: output is routed to the right view, on screen or not, deduped by seq', async () => {
  const { client, views, manager } = setup();
  seed(client, 't1', '');
  seed(client, 't2', '');
  await manager.open(target);
  client.push('t1', 0, 'one');
  client.push('t2', 0, 'two');
  client.push('t1', 0, 'one'); // replayed
  assert.equal(views[0]!.written.text, 'one');
  assert.equal(views[1]!.written.text, 'two');
});

test('manager: unmounting a view (tab switch, fold, workspace switch) disposes nothing and detaches nothing', async () => {
  const { client, views, manager } = setup();
  seed(client, 't1', 'x');
  seed(client, 't2', 'y');
  await manager.open(target);
  const slot = {};
  const off1 = manager.mount('ws', 't1', slot);
  off1(); // switch away from t1
  const off2 = manager.mount('ws', 't2', slot);
  off2(); // fold the dock
  assert.equal(views.some((v) => v.disposed), false);
  assert.equal(manager.has('ws', 't1'), true);
  assert.equal(client.calls.filter((c) => c === 'close' || c === 'kill').length, 0);
  // Output keeps flowing into the hidden view.
  client.push('t1', 1, 'more');
  assert.equal(views[0]!.written.text, 'xmore');
  // Showing it again re-mounts the same instance.
  manager.mount('ws', 't1', slot);
  assert.equal(views.length, 2);
  assert.equal(views[0]!.mounts, 2);
});

test('manager: a stale unmount cannot pull a newer mount out', async () => {
  const { client, views, manager } = setup();
  seed(client, 't1', '');
  await manager.open(target);
  const a = {};
  const b = {};
  const offA = manager.mount('ws', 't1', a);
  manager.mount('ws', 't1', b);
  offA();
  assert.equal(views[0]!.mounted, b);
});

test('manager: reconnect re-attaches from lastSeq and never creates', async () => {
  const { client, views, manager } = setup();
  seed(client, 't1', 'abc');
  await manager.open(target);
  client.setConnection('disconnected');
  assert.equal(manager.terminals('ws')[0]!.hostLost, true);
  // The host kept its terminal (same created_at) and produced more output.
  client.terms[0]!.created_at = 500;
  client.output.set('t1', bytes('abcdef'));
  client.setConnection('ready');
  await wait();
  assert.deepEqual(client.attaches.at(-1), { id: 't1', from: 3 });
  assert.equal(client.calls.includes('create'), false);
  assert.equal(views.length, 1);
  // Only the bytes after lastSeq were written (no second "abc"), after the
  // notice that the connection had dropped.
  const text = views[0]!.written.text;
  assert.equal(text.split('abc').length - 1, 1);
  assert.ok(text.startsWith('abc'));
  assert.ok(text.endsWith('def'));
  assert.ok(text.indexOf('host ended') < text.indexOf('def'));
  assert.equal(manager.terminals('ws')[0]!.hostLost, false);
});

test('manager: reconnect with a ring buffer that no longer reaches back writes the gap notice', async () => {
  const { client, views, manager } = setup();
  seed(client, 't1', 'abc');
  await manager.open(target);
  client.setConnection('disconnected');
  client.output.set('t1', bytes('abc0123456789'));
  client.ringStart.set('t1', 8);
  client.setConnection('ready');
  await wait();
  const text = views[0]!.written.text;
  assert.ok(text.includes(GAP));
  assert.ok(text.endsWith('56789'));
  assert.equal(manager.lastSeq('ws', 't1'), 13);
});

test('manager: a restarted host (same id, new created_at) replaces the stale tab and still never creates', async () => {
  const { client, views, manager } = setup();
  seed(client, 't1', 'old');
  await manager.open(target);
  client.setConnection('disconnected');
  client.terms = [];
  client.setConnection('ready');
  await wait();
  // Nothing on the host: the old tab stays, ended with the host.
  const infos = manager.terminals('ws');
  assert.equal(infos.length, 1);
  assert.equal(infos[0]!.state, 'exited');
  assert.equal(infos[0]!.hostLost, true);
  assert.ok(views[0]!.written.text.includes('host ended'));
  assert.equal(client.calls.includes('create'), false);
  assert.equal(views[0]!.disposed, false);
});

test('manager: exit keeps the entry, writes the notice once, and stops forwarding input and resize', async () => {
  const { client, views, manager } = setup();
  seed(client, 't1', 'hi');
  await manager.open(target);
  client.emitExit('t1', 7);
  client.emitExit('t1', 7);
  const info = manager.terminals('ws')[0]!;
  assert.equal(info.state, 'exited');
  assert.equal(info.exitCode, 7);
  assert.equal(views[0]!.written.text.split('process exited (code 7)').length - 1, 1);
  assert.equal(views[0]!.disposed, false);
  views[0]!.onData('ls\r');
  assert.equal(client.inputs.length, 0);
});

test('manager: kill keeps the entry; close removes it and disposes the view', async () => {
  const { client, views, manager } = setup();
  seed(client, 't1', '');
  await manager.open(target);
  await manager.kill('ws', 't1');
  assert.equal(manager.has('ws', 't1'), true);
  assert.equal(manager.terminals('ws')[0]!.state, 'exited');
  assert.equal(client.calls.includes('close'), false);
  await manager.close('ws', 't1');
  assert.equal(client.calls.includes('close'), true);
  assert.equal(manager.has('ws', 't1'), false);
  assert.equal(views[0]!.disposed, true);
});

test('manager: create attaches (the host does not) and returns the id', async () => {
  const { client, views, manager } = setup();
  await manager.open(target);
  const id = await manager.create('ws', { cwd: 'src' });
  assert.equal(id, 't1');
  assert.equal(client.terms[0]!.cwd, 'src');
  assert.deepEqual(client.attaches, [{ id: 't1', from: 0 }]);
  assert.equal(views.length, 1);
  // A later sync does not attach it again on the same connection.
  await manager.sync('ws');
  assert.equal(client.attaches.length, 1);
});

test('manager: typed input goes to the host; a gap push writes the notice', async () => {
  const { client, views, manager } = setup();
  seed(client, 't1', '');
  await manager.open(target);
  views[0]!.onData('ls\r');
  assert.deepEqual(client.inputs, [{ id: 't1', data: 'ls\r' }]);
  client.push('t1', 0, 'ab');
  client.emitGap('t1', 2, 50);
  client.push('t1', 50, 'cd');
  assert.ok(views[0]!.written.text.includes(GAP));
  assert.equal(manager.lastSeq('ws', 't1'), 52);
});

test('manager: a terminal closed elsewhere disappears on the next sync', async () => {
  const { client, views, manager } = setup();
  seed(client, 't1', '');
  await manager.open(target);
  client.terms = [];
  await manager.sync('ws');
  assert.equal(manager.terminals('ws').length, 0);
  assert.equal(views[0]!.disposed, true);
});

test('manager: resize is sent once per change, debounced, and not for an unchanged grid', async () => {
  const { client, views, manager } = setup(5);
  seed(client, 't1', ''); // the host has 80x24
  await manager.open(target);
  const slot = {};
  manager.mount('ws', 't1', slot);
  manager.refit('ws', 't1');
  manager.refit('ws', 't1');
  await wait(30);
  assert.deepEqual(client.resizes, [{ id: 't1', cols: 100, rows: 30 }]);
  manager.refit('ws', 't1'); // same grid
  await wait(30);
  assert.equal(client.resizes.length, 1);
  views[0]!.size = { cols: 120, rows: 30 };
  manager.refit('ws', 't1');
  await wait(30);
  assert.deepEqual(client.resizes.at(-1), { id: 't1', cols: 120, rows: 30 });
  // Nothing measurable (hidden): no resize.
  views[0]!.size = null;
  manager.refit('ws', 't1');
  await wait(30);
  assert.equal(client.resizes.length, 2);
});

test('manager: rename is local, trimmed, and an empty name restores the default', async () => {
  const { client, manager } = setup();
  seed(client, 't1', '');
  await manager.open(target);
  manager.rename('ws', 't1', '  build  ');
  assert.equal(manager.terminals('ws')[0]!.label, 'build');
  manager.rename('ws', 't1', '');
  assert.equal(manager.terminals('ws')[0]!.label, 'pwsh');
});

test('manager: the snapshot is the same array until something changes', async () => {
  const { client, manager } = setup();
  seed(client, 't1', '');
  await manager.open(target);
  const a = manager.terminals('ws');
  assert.equal(manager.terminals('ws'), a);
  manager.rename('ws', 't1', 'x');
  assert.notEqual(manager.terminals('ws'), a);
});

test('manager: disposeWorkspace drops views and stops following the host', async () => {
  const { client, views, manager } = setup();
  seed(client, 't1', '');
  await manager.open(target);
  manager.disposeWorkspace('ws');
  assert.equal(views[0]!.disposed, true);
  client.push('t1', 0, 'late');
  assert.equal(views[0]!.written.text, '');
});
