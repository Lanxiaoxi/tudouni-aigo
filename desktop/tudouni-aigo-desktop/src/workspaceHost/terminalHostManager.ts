/**
 * The window's terminals, outside React (docs/design/workspace-dock.md §7.4).
 *
 * One `TerminalHostManager` per window. It holds a **view** (an xterm instance
 * and its container) for every terminal of every workspace the window has
 * looked at, keyed `workspaceId + terminalId`, and it is the only thing that
 * talks to the host about terminals:
 *
 *   - **No React lifecycle reaches it.** Switching tab, folding the terminal
 *     area, switching workspace or closing the Dock only `mount`s / unmounts a
 *     view's container into a slot; nothing here disposes a view or detaches a
 *     PTY because a component went away. A view dies when its terminal is closed
 *     (`close`), when the host no longer has it (reconcile), or with
 *     `disposeWorkspace`.
 *   - **Output is routed here, not by the component.** Pushes for a workspace
 *     are written to the right view whether or not it is on screen, through a
 *     `TermStream` that dedupes by byte offset and announces holes.
 *   - **A reconnect attaches, it never creates.** When a workspace's host comes
 *     back (`ready` after not being ready), the manager lists the host's
 *     terminals and `term_attach`es each from its own `lastSeq`. A host that
 *     restarted has none, so nothing is attached and nothing is created: the old
 *     tabs stay, marked ended, until the person closes them.
 *
 * The client and the view are injected (`TermHostClient`, `ViewFactory`), so the
 * bookkeeping is tested in Node against fakes; xterm itself needs a DOM and
 * lives in `components/dock/terminal/xtermView.ts`.
 */
import type { TermAttachResult, TermExitEvent, TermGapEvent, TermOutputEvent } from './client';
import type { WorkspaceConnection, WorkspaceTarget } from './connection';
import type { Term } from './protocol';
import { TermStream, noticeLine, type ByteSink } from './termStream';

/* ============================================================
   Seams
   ============================================================ */

/** The slice of `WorkspaceHostClient` the manager uses. */
export interface TermHostClient {
  readonly isReady: boolean;
  onConnection(cb: (c: WorkspaceConnection) => void): () => void;
  onTermOutput(cb: (e: TermOutputEvent) => void): () => void;
  onTermExit(cb: (e: TermExitEvent) => void): () => void;
  onTermGap(cb: (e: TermGapEvent) => void): () => void;
  termList(): Promise<Term[]>;
  termCreate(params?: { cwd?: string; cols?: number; rows?: number; title?: string }): Promise<Term>;
  termAttach(id: string, fromSeq?: number): Promise<TermAttachResult>;
  termInput(id: string, data: string): Promise<void>;
  termResize(id: string, cols: number, rows: number): Promise<void>;
  termKill(id: string): Promise<void>;
  termClose(id: string): Promise<void>;
}

export interface TermSize {
  cols: number;
  rows: number;
}

/** What the manager needs of a terminal emulator (xterm, or a fake). */
export interface TermView extends ByteSink {
  /** Put the view's surface into `slot` (opening the emulator the first time). */
  mount(slot: unknown): void;
  /** Take the surface out of whatever slot it is in. Does not dispose. */
  unmount(): void;
  /** Fit to the slot. `null` while there is nothing measurable (not mounted, hidden). */
  fit(): TermSize | null;
  focus(): void;
  /** Re-read the theme colours (the app's theme may have changed since). */
  refreshTheme(): void;
  dispose(): void;
}

export type ViewFactory = (options: {
  cols: number;
  rows: number;
  /** What the person typed (already encoded by the emulator). */
  onData: (data: string) => void;
}) => TermView;

/** The sentences written into the terminal itself. */
export interface TermNotices {
  gap(): string;
  exited(code: number | null): string;
  hostLost(): string;
}

export interface TerminalHostManagerOptions {
  clientFor(target: WorkspaceTarget): TermHostClient;
  createView: ViewFactory;
  notices: TermNotices;
  /** Quiet period before a changed size is sent to the host. Default 80 ms. */
  resizeDebounceMs?: number;
}

/** One terminal as the UI draws it. Replaced (never mutated) on every change. */
export interface TerminalInfo {
  id: string;
  /** What the tab says: the person's name for it, else the host's title. */
  label: string;
  /** The person's rename, or `null`. */
  customName: string | null;
  title: string;
  cwd: string;
  shell: string;
  state: 'running' | 'exited';
  exitCode: number | null;
  /** The host that owned it is gone: it ended with the host. */
  hostLost: boolean;
  createdAt: number;
}

/* ============================================================
   Internals
   ============================================================ */

interface Entry {
  readonly workspaceId: string;
  readonly id: string;
  readonly createdAt: number;
  /** Order of creation in this manager: lets a sync tell "listed before this
   *  entry existed" from "missing from the host". */
  readonly stamp: number;
  readonly view: TermView;
  readonly stream: TermStream;
  title: string;
  cwd: string;
  shell: string;
  state: 'running' | 'exited';
  exitCode: number | null;
  customName: string | null;
  hostLost: boolean;
  exitNoticeWritten: boolean;
  /** The epoch of the connection this entry last attached on. */
  attachedEpoch: number;
  attaching: boolean;
  /** The last size the host is known to have. */
  sentSize: TermSize | null;
  resizeTimer: ReturnType<typeof setTimeout> | null;
  slot: unknown;
  disposed: boolean;
}

interface Binding {
  client: TermHostClient;
  offs: (() => void)[];
  /** Counts the times this workspace's host became ready. */
  epoch: number;
  wasReady: boolean;
  /** The tail of the serialised syncs. */
  chain: Promise<void>;
}

const DEFAULT_SIZE: TermSize = { cols: 80, rows: 24 };
const keyOf = (workspaceId: string, id: string) => `${workspaceId}\u0000${id}`;
const noop = () => undefined;

function idNumber(id: string): number {
  const n = Number(id.replace(/^\D+/, ''));
  return Number.isFinite(n) ? n : 0;
}

/* ============================================================
   The manager
   ============================================================ */

export class TerminalHostManager {
  private readonly opts: TerminalHostManagerOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly bindings = new Map<string, Binding>();
  private readonly listeners = new Set<() => void>();
  private readonly infoCache = new Map<string, readonly TerminalInfo[]>();
  private stampCounter = 0;
  private lastSize: TermSize = DEFAULT_SIZE;

  constructor(options: TerminalHostManagerOptions) {
    this.opts = options;
  }

  /* ---------------- observation ---------------- */

  /** Stable arrow: usable directly as `useSyncExternalStore`'s subscribe. */
  readonly subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  /** One workspace's terminals, oldest first. The same array until something
   *  about them changes (a snapshot for `useSyncExternalStore`). */
  terminals(workspaceId: string): readonly TerminalInfo[] {
    const cached = this.infoCache.get(workspaceId);
    if (cached) return cached;
    const infos = this.entriesOf(workspaceId)
      .sort((a, b) => a.createdAt - b.createdAt || idNumber(a.id) - idNumber(b.id))
      .map(
        (e): TerminalInfo => ({
          id: e.id,
          label: e.customName ?? e.title,
          customName: e.customName,
          title: e.title,
          cwd: e.cwd,
          shell: e.shell,
          state: e.state,
          exitCode: e.exitCode,
          hostLost: e.hostLost,
          createdAt: e.createdAt,
        }),
      );
    this.infoCache.set(workspaceId, infos);
    return infos;
  }

  has(workspaceId: string, id: string): boolean {
    return this.entries.has(keyOf(workspaceId, id));
  }

  /** The offset of the next byte expected from a terminal (0 when unknown). */
  lastSeq(workspaceId: string, id: string): number {
    return this.entries.get(keyOf(workspaceId, id))?.stream.lastSeq ?? 0;
  }

  private entriesOf(workspaceId: string): Entry[] {
    const out: Entry[] = [];
    for (const e of this.entries.values()) if (e.workspaceId === workspaceId) out.push(e);
    return out;
  }

  private touch(workspaceId: string): void {
    this.infoCache.delete(workspaceId);
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (err) {
        console.error('terminal listener failed:', err);
      }
    }
  }

  /* ---------------- binding to a workspace ---------------- */

  /**
   * Start following a workspace's terminals: subscribe to its client and, when
   * the host is ready, reconcile with `term_list` and attach. Idempotent; the
   * promise settles when that first reconcile has.
   */
  open(target: WorkspaceTarget): Promise<void> {
    const workspaceId = target.workspaceId;
    const client = this.opts.clientFor(target);
    let binding = this.bindings.get(workspaceId);
    if (binding && binding.client !== client) {
      this.unbind(binding);
      binding = undefined;
    }
    if (!binding) binding = this.bind(workspaceId, client);
    return client.isReady ? this.sync(workspaceId) : Promise.resolve();
  }

  private bind(workspaceId: string, client: TermHostClient): Binding {
    const binding: Binding = {
      client,
      offs: [],
      epoch: client.isReady ? 1 : 0,
      wasReady: client.isReady,
      chain: Promise.resolve(),
    };
    binding.offs.push(
      client.onConnection((c) => {
        const ready = c.state === 'ready';
        if (ready && !binding.wasReady) {
          binding.epoch += 1;
          binding.wasReady = true;
          void this.sync(workspaceId).catch(noop);
        } else if (!ready && binding.wasReady) {
          binding.wasReady = false;
          this.markLost(workspaceId);
        }
      }),
      client.onTermOutput((e) => {
        this.entries.get(keyOf(workspaceId, e.id))?.stream.output(e.seq, e.data);
      }),
      client.onTermGap((e) => {
        this.entries.get(keyOf(workspaceId, e.id))?.stream.skip(e.from_seq, e.to_seq);
      }),
      client.onTermExit((e) => this.onExit(workspaceId, e)),
    );
    this.bindings.set(workspaceId, binding);
    return binding;
  }

  private unbind(binding: Binding): void {
    for (const off of binding.offs) off();
    binding.offs = [];
    for (const [workspaceId, b] of this.bindings) if (b === binding) this.bindings.delete(workspaceId);
  }

  private requireBinding(workspaceId: string): Binding {
    const binding = this.bindings.get(workspaceId);
    if (!binding) throw new Error('the workspace is not open in the terminal manager');
    return binding;
  }

  /* ---------------- reconcile and attach ---------------- */

  /** Reconcile with the host's list and attach what is not attached yet.
   *  Serialised per workspace; safe to call from anywhere, any number of times. */
  sync(workspaceId: string): Promise<void> {
    const binding = this.bindings.get(workspaceId);
    if (!binding) return Promise.resolve();
    const run = binding.chain.then(() => this.doSync(workspaceId, binding));
    binding.chain = run.catch(noop);
    return run;
  }

  private async doSync(workspaceId: string, binding: Binding): Promise<void> {
    if (!binding.client.isReady) return;
    const stamp = ++this.stampCounter;
    const list = await binding.client.termList();
    if (this.bindings.get(workspaceId) !== binding) return;

    const listed: Entry[] = [];
    const seen = new Set<string>();
    for (const term of list) {
      seen.add(term.id);
      let entry = this.entries.get(keyOf(workspaceId, term.id));
      // The same id on a different terminal (a host that restarted reuses `t1`):
      // the old view is not this terminal. The same `created_at` is the same
      // PTY, which is the case after a dropped connection to a host that kept
      // running: it keeps its scrollback and is re-attached from `lastSeq`.
      if (entry && entry.createdAt !== term.created_at) {
        this.drop(entry);
        entry = undefined;
      }
      if (entry) {
        entry.hostLost = false;
        this.applyMeta(entry, term);
      } else entry = this.addEntry(workspaceId, term);
      listed.push(entry);
    }
    // Gone from the host (closed elsewhere). An entry created after this sync
    // asked is newer than the list and is left alone; so is one that ended with
    // a host (it is shown until the person closes it).
    for (const entry of this.entriesOf(workspaceId)) {
      if (!seen.has(entry.id) && !entry.hostLost && entry.stamp < stamp) this.drop(entry);
    }
    this.touch(workspaceId);
    await Promise.all(listed.map((e) => this.attach(e, binding)));
  }

  private addEntry(workspaceId: string, term: Term): Entry {
    const view = this.opts.createView({
      cols: term.cols > 0 ? term.cols : DEFAULT_SIZE.cols,
      rows: term.rows > 0 ? term.rows : DEFAULT_SIZE.rows,
      onData: (data) => this.input(workspaceId, term.id, data),
    });
    const entry: Entry = {
      workspaceId,
      id: term.id,
      createdAt: term.created_at,
      stamp: ++this.stampCounter,
      view,
      stream: new TermStream(view, () => this.opts.notices.gap()),
      title: term.title,
      cwd: term.cwd,
      shell: term.shell,
      state: term.state,
      exitCode: term.exit_code,
      customName: null,
      hostLost: false,
      exitNoticeWritten: false,
      attachedEpoch: -1,
      attaching: false,
      sentSize: { cols: term.cols, rows: term.rows },
      resizeTimer: null,
      slot: null,
      disposed: false,
    };
    this.entries.set(keyOf(workspaceId, term.id), entry);
    this.touch(workspaceId);
    return entry;
  }

  private applyMeta(entry: Entry, term: Term): void {
    entry.title = term.title;
    entry.cwd = term.cwd;
    entry.shell = term.shell;
    entry.state = term.state;
    entry.exitCode = term.exit_code;
    if (term.state === 'running') entry.exitNoticeWritten = false;
    entry.sentSize = { cols: term.cols, rows: term.rows };
    this.touch(entry.workspaceId);
  }

  private async attach(entry: Entry, binding: Binding): Promise<void> {
    if (entry.disposed || entry.attaching || entry.attachedEpoch === binding.epoch) return;
    entry.attaching = true;
    entry.stream.beginAttach();
    try {
      const result = await binding.client.termAttach(entry.id, entry.stream.lastSeq);
      if (entry.disposed) return;
      entry.stream.applyAttach(result.from_seq, result.data, result.gap);
      entry.attachedEpoch = binding.epoch;
      this.applyMeta(entry, result.terminal);
    } catch {
      // The terminal vanished, or the host did: nothing was replayed and the
      // host is not pushing. The next sync tries again.
      entry.stream.cancelAttach();
    } finally {
      entry.attaching = false;
      this.flushExit(entry);
      if (entry.slot !== null) this.refitEntry(entry);
    }
  }

  /** The host went away: its terminals are gone with it (nothing outlives the
   *  host). The tabs stay, ended, so the output can still be read. */
  private markLost(workspaceId: string): void {
    for (const entry of this.entriesOf(workspaceId)) {
      if (entry.state === 'running') {
        entry.state = 'exited';
        entry.exitCode = null;
        entry.exitNoticeWritten = true;
        entry.stream.cancelAttach();
        entry.view.write(noticeLine(this.opts.notices.hostLost()));
      }
      entry.hostLost = true;
      entry.attachedEpoch = -1;
      if (entry.resizeTimer !== null) clearTimeout(entry.resizeTimer);
      entry.resizeTimer = null;
    }
    this.touch(workspaceId);
  }

  private onExit(workspaceId: string, event: TermExitEvent): void {
    const entry = this.entries.get(keyOf(workspaceId, event.id));
    if (!entry) return;
    entry.state = 'exited';
    entry.exitCode = event.exit_code;
    this.flushExit(entry);
    this.touch(workspaceId);
  }

  /** "process exited (code N)", once, and not in the middle of a replay. */
  private flushExit(entry: Entry): void {
    if (entry.disposed || entry.state !== 'exited' || entry.exitNoticeWritten || entry.attaching) return;
    entry.exitNoticeWritten = true;
    entry.view.write(noticeLine(this.opts.notices.exited(entry.exitCode)));
  }

  /* ---------------- acts ---------------- */

  /** Create a terminal (`cwd` is workspace-relative), attach it, return its id. */
  async create(workspaceId: string, options: { cwd?: string } = {}): Promise<string> {
    const binding = this.requireBinding(workspaceId);
    const params: { cwd?: string; cols: number; rows: number } = {
      cols: this.lastSize.cols,
      rows: this.lastSize.rows,
    };
    if (options.cwd) params.cwd = options.cwd;
    const term = await binding.client.termCreate(params);
    const entry = this.entries.get(keyOf(workspaceId, term.id)) ?? this.addEntry(workspaceId, term);
    await this.attach(entry, binding);
    return term.id;
  }

  /** End the process; the tab and its exit code stay (`term_kill`). */
  async kill(workspaceId: string, id: string): Promise<void> {
    const entry = this.entries.get(keyOf(workspaceId, id));
    if (!entry || entry.hostLost) return;
    const binding = this.requireBinding(workspaceId);
    await binding.client.termKill(id);
    if (entry.state === 'running') {
      // The `term_exit` push normally lands first; if it has not, ask.
      const found = (await binding.client.termList()).find((t) => t.id === id);
      if (found && !entry.disposed) {
        this.applyMeta(entry, found);
        this.flushExit(entry);
      }
    }
  }

  /** End the process if running and remove the terminal (`term_close`). A
   *  terminal that ended with its host has nothing on the host to remove. */
  async close(workspaceId: string, id: string): Promise<void> {
    const entry = this.entries.get(keyOf(workspaceId, id));
    if (!entry) return;
    if (!entry.hostLost) {
      try {
        await this.requireBinding(workspaceId).client.termClose(id);
      } catch (err) {
        // Already gone on the host is the state being asked for.
        if ((err as { code?: unknown } | null)?.code !== 'not_found') throw err;
      }
    }
    this.drop(entry);
  }

  /** A name of the person's own. The host has no rename, so it lives here. */
  rename(workspaceId: string, id: string, name: string): void {
    const entry = this.entries.get(keyOf(workspaceId, id));
    if (!entry) return;
    const next = name.trim() === '' ? null : name.trim();
    if (entry.customName === next) return;
    entry.customName = next;
    this.touch(workspaceId);
  }

  private input(workspaceId: string, id: string, data: string): void {
    const entry = this.entries.get(keyOf(workspaceId, id));
    const binding = this.bindings.get(workspaceId);
    if (!entry || !binding || entry.state === 'exited' || !binding.client.isReady) return;
    binding.client.termInput(id, data).catch(noop);
  }

  /* ---------------- on screen ---------------- */

  /**
   * Show a terminal in `slot`. Returns the function that takes it out again,
   * which only **unmounts**: the emulator, its scrollback and the PTY attach stay.
   */
  mount(workspaceId: string, id: string, slot: unknown, options: { focus?: boolean } = {}): () => void {
    const entry = this.entries.get(keyOf(workspaceId, id));
    if (!entry) return noop;
    entry.view.mount(slot);
    entry.slot = slot;
    entry.view.refreshTheme();
    this.refitEntry(entry);
    if (options.focus) entry.view.focus();
    return () => {
      if (entry.slot !== slot || entry.disposed) return;
      entry.view.unmount();
      entry.slot = null;
    };
  }

  /** The slot changed size: refit and, when the grid changed, tell the host. */
  refit(workspaceId: string, id: string): void {
    const entry = this.entries.get(keyOf(workspaceId, id));
    if (entry) this.refitEntry(entry);
  }

  focus(workspaceId: string, id: string): void {
    this.entries.get(keyOf(workspaceId, id))?.view.focus();
  }

  private refitEntry(entry: Entry): void {
    if (entry.disposed) return;
    const size = entry.view.fit();
    if (!size || size.cols < 1 || size.rows < 1) return;
    this.lastSize = size;
    if (entry.resizeTimer !== null) {
      clearTimeout(entry.resizeTimer);
      entry.resizeTimer = null;
    }
    if (entry.state === 'exited') return;
    if (entry.sentSize && entry.sentSize.cols === size.cols && entry.sentSize.rows === size.rows) return;
    entry.resizeTimer = setTimeout(() => {
      entry.resizeTimer = null;
      const binding = this.bindings.get(entry.workspaceId);
      if (entry.disposed || !binding || !binding.client.isReady || entry.state === 'exited') return;
      entry.sentSize = size;
      binding.client.termResize(entry.id, size.cols, size.rows).catch(() => {
        // Not delivered: the next refit may try again.
        if (entry.sentSize === size) entry.sentSize = null;
      });
    }, this.opts.resizeDebounceMs ?? 80);
  }

  /* ---------------- teardown ---------------- */

  private drop(entry: Entry): void {
    if (entry.disposed) return;
    entry.disposed = true;
    if (entry.resizeTimer !== null) clearTimeout(entry.resizeTimer);
    entry.resizeTimer = null;
    if (entry.slot !== null) entry.view.unmount();
    entry.slot = null;
    entry.view.dispose();
    this.entries.delete(keyOf(entry.workspaceId, entry.id));
    this.touch(entry.workspaceId);
  }

  /** Forget a workspace entirely (its host was closed on purpose). The host's
   *  terminals are not touched here: closing the host is what ends them. */
  disposeWorkspace(workspaceId: string): void {
    const binding = this.bindings.get(workspaceId);
    if (binding) this.unbind(binding);
    for (const entry of this.entriesOf(workspaceId)) this.drop(entry);
    this.touch(workspaceId);
  }
}
