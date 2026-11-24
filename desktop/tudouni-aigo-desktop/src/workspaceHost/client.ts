/**
 * One workspace's connection to its `--workspace-host` process.
 *
 * A `WorkspaceHostClient` is the typed face of the JSONL channel in
 * `docs/spec/workspace-host-protocol.md`: it attaches (`host_attach`), waits for
 * `host_init`, correlates `req` ↔ `result`, decodes the base64 payloads, and
 * turns pushes (`workspace_event`, `term_output`, `term_exit`) into
 * subscriptions. It knows nothing about React, zustand or Tauri — the line
 * transport is injected (`transport.ts`), which is also how it is tested.
 *
 * Rules it keeps:
 *
 *   - **Unknown is ignored.** A message with an unknown `t`, an unknown field,
 *     a `v` other than 1 or text that is not JSON never throws and never changes
 *     state (the spec: both ends ignore what they do not know).
 *   - **A request is answered exactly once**: by its `result`, by a timeout, or
 *     by the connection ending — never twice, never never. A late `result` for a
 *     request that already timed out is dropped.
 *   - **A host that ended is not a host that is closed.** An unrequested exit is
 *     `disconnected` (with a reason a person can read, including the host's last
 *     stderr line); a `disconnect()` the caller asked for is `idle`. Terminals
 *     that were running are gone either way — the design promises no PTY outlives
 *     its host — and the client says so by rejecting everything in flight.
 *   - **No destructive reconnect.** `reconnect()` on a `ready` host does nothing.
 */
import { decodeBase64 } from './base64';
import {
  IDLE_CONNECTION,
  type HostExitInfo,
  type WorkspaceConnection,
  type WorkspaceTarget,
} from './connection';
import {
  HOST_ENVELOPE_VERSION,
  HOST_PROTOCOL,
  type FsListData,
  type FsReadData,
  type FsSearchData,
  type FsStatData,
  type GitDiffData,
  type GitDiffSource,
  type GitStatus,
  type HostErrorBody,
  type HostInitMsg,
  type HostRequestMap,
  type HostRequestName,
  type Term,
  type WorkspaceCapabilities,
  type WorkspaceEvent,
} from './protocol';
import type { HostAttachResponse, HostTransport } from './transport';

/* ============================================================
   Public shapes
   ============================================================ */

/** A request that did not succeed: the host's `error`, or one of ours. */
export class HostRequestError extends Error {
  /** The host's error code (`not_found`, `path_escape`, …) or the client's own:
   *  `timeout`, `not_connected`, `disconnected`, `send_failed`, `attach_failed`,
   *  `protocol_mismatch`, `host_exited`, `ssh_closed`, `disposed`. */
  readonly code: string;
  /** The request's message name, when the failure belongs to one. */
  readonly request: string | null;
  constructor(code: string, message: string, request: string | null = null) {
    super(message);
    this.name = 'HostRequestError';
    this.code = code;
    this.request = request;
  }
}

export interface HostClientOptions {
  transport: HostTransport;
  /** Per-request budget. Default 15 s. */
  requestTimeoutMs?: number;
  /** How long to wait for `host_init` once `host_attach` has returned. The ssh
   *  dial happens inside `host_attach` and has its own budget. Default 20 s. */
  initTimeoutMs?: number;
}

export interface RequestOptions {
  timeoutMs?: number;
}

/** `term_output`, decoded. `data` covers bytes `[seq, seq + data.length)`. */
export interface TermOutputEvent {
  id: string;
  seq: number;
  data: Uint8Array;
}

export interface TermExitEvent {
  id: string;
  exit_code: number | null;
}

/** `term_gap`: the host skipped `[from_seq, to_seq)` because this consumer was
 *  too slow and the ring buffer overwrote it. Output continues at `to_seq`. */
export interface TermGapEvent {
  id: string;
  from_seq: number;
  to_seq: number;
}

/** `term_attach`, decoded. */
export interface TermAttachResult {
  terminal: Term;
  /** The offset `data` actually starts at (later than asked when `gap`). */
  from_seq: number;
  data: Uint8Array;
  /** The ring buffer no longer reached back to the requested offset. */
  gap: boolean;
}

/** `fs_read_bytes`, decoded. */
export interface FsReadBytesResult {
  path: string;
  size: number;
  mime: string;
  data: Uint8Array;
}

/** An unrequested end of a connection that had been `ready`. */
export interface HostDisconnectInfo {
  code: string;
  message: string;
  exit: HostExitInfo | null;
}

type Unsubscribe = () => void;

interface Pending {
  t: string;
  resolve(data: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface InitWaiter {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INIT_TIMEOUT_MS = 20_000;
const STDERR_TAIL = 8;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ============================================================
   The client
   ============================================================ */

export class WorkspaceHostClient {
  readonly workspaceId: string;

  private target: WorkspaceTarget;
  private readonly transport: HostTransport;
  private readonly requestTimeoutMs: number;
  private readonly initTimeoutMs: number;

  private conn: WorkspaceConnection = IDLE_CONNECTION;
  private pending = new Map<string, Pending>();
  private counter = 0;
  private unsubscribeTransport: Unsubscribe | null = null;
  private connecting: Promise<WorkspaceConnection> | null = null;
  private initWaiter: InitWaiter | null = null;
  private stderrLines: string[] = [];
  private droppedLines = 0;
  private disposed = false;

  /** We believe a host process exists for this workspace. */
  private hostMaybeRunning = false;
  /** Shutdown exits we caused and have not yet seen come back. They are not
   *  failures, and one can arrive after a reconnect has already begun. */
  private expectedShutdownExits = 0;

  private connectionListeners = new Set<(c: WorkspaceConnection) => void>();
  private eventListeners = new Set<(e: WorkspaceEvent) => void>();
  private outputListeners = new Set<(e: TermOutputEvent) => void>();
  private termExitListeners = new Set<(e: TermExitEvent) => void>();
  private termGapListeners = new Set<(e: TermGapEvent) => void>();
  private disconnectListeners = new Set<(i: HostDisconnectInfo) => void>();
  private stderrListeners = new Set<(line: string) => void>();

  constructor(target: WorkspaceTarget, options: HostClientOptions) {
    this.target = target;
    this.workspaceId = target.workspaceId;
    this.transport = options.transport;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  }

  /* ---------------- state ---------------- */

  /** The connection as of now (a new object whenever it changes). */
  get connection(): WorkspaceConnection {
    return this.conn;
  }

  get isReady(): boolean {
    return this.conn.state === 'ready';
  }

  /** The last few lines the host wrote to stderr, oldest first. */
  get stderrTail(): readonly string[] {
    return this.stderrLines;
  }

  /** Lines that were not JSON or whose payload could not be decoded. */
  get droppedLineCount(): number {
    return this.droppedLines;
  }

  /** Replace the connection facts used by the **next** attach (a remote binary
   *  that was just installed, say). Never moves a running host. */
  setTarget(target: WorkspaceTarget): void {
    if (target.workspaceId !== this.workspaceId) {
      throw new Error('a client belongs to one workspace id');
    }
    this.target = target;
  }

  get currentTarget(): WorkspaceTarget {
    return this.target;
  }

  private setConn(next: WorkspaceConnection): void {
    this.conn = next;
    for (const cb of [...this.connectionListeners]) this.safely(() => cb(next));
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      // A subscriber's bug must not stop the channel or the other subscribers.
      console.error('workspace host listener failed:', err);
    }
  }

  /* ---------------- subscriptions ---------------- */

  /** Every change of connection state, capabilities or error. */
  onConnection(cb: (c: WorkspaceConnection) => void): Unsubscribe {
    this.connectionListeners.add(cb);
    return () => this.connectionListeners.delete(cb);
  }

  /** `workspace_event` pushes, normalised (`changes` / `invalidates` are always
   *  arrays). A `revision` that skips a number means events were lost; the host
   *  says so itself with `reset_required`, and the consumer decides what to do. */
  onWorkspaceEvent(cb: (e: WorkspaceEvent) => void): Unsubscribe {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  /** `term_output` pushes with the base64 already decoded. Only terminals this
   *  client has attached (`termAttach`) produce them. */
  onTermOutput(cb: (e: TermOutputEvent) => void): Unsubscribe {
    this.outputListeners.add(cb);
    return () => this.outputListeners.delete(cb);
  }

  /** `term_exit` pushes — for every terminal, attached or not. */
  onTermExit(cb: (e: TermExitEvent) => void): Unsubscribe {
    this.termExitListeners.add(cb);
    return () => this.termExitListeners.delete(cb);
  }

  /** `term_gap` pushes: output the host had to skip for an attached terminal. */
  onTermGap(cb: (e: TermGapEvent) => void): Unsubscribe {
    this.termGapListeners.add(cb);
    return () => this.termGapListeners.delete(cb);
  }

  /** A `ready` connection ended without being asked to. */
  onDisconnect(cb: (info: HostDisconnectInfo) => void): Unsubscribe {
    this.disconnectListeners.add(cb);
    return () => this.disconnectListeners.delete(cb);
  }

  /** The host's stderr, line by line (diagnostics, never protocol data). */
  onStderr(cb: (line: string) => void): Unsubscribe {
    this.stderrListeners.add(cb);
    return () => this.stderrListeners.delete(cb);
  }

  /* ---------------- connecting ---------------- */

  /**
   * Start the host if it is not running and resolve once it has said
   * `host_init`. Idempotent: concurrent calls share one attempt, a `ready`
   * client resolves at once. Rejects with a `HostRequestError` (the connection
   * keeps the same reason in `lastError`).
   */
  connect(): Promise<WorkspaceConnection> {
    if (this.disposed) {
      return Promise.reject(new HostRequestError('disposed', 'the client was disposed'));
    }
    if (this.conn.state === 'ready') return Promise.resolve(this.conn);
    if (this.connecting) return this.connecting;
    const attempt = this.doConnect().finally(() => {
      if (this.connecting === attempt) this.connecting = null;
    });
    this.connecting = attempt;
    return attempt;
  }

  /**
   * Bring a `disconnected` (or `idle`) client back. Does nothing to a `ready`
   * one — restarting would kill its terminals, and that is `disconnect()` then
   * `connect()` said out loud, not something a retry button may do by accident.
   * A host we believe is still running but never answered (a handshake that
   * timed out) is ended first, so the retry does not attach to the same wedged
   * process.
   */
  async reconnect(): Promise<WorkspaceConnection> {
    if (this.conn.state === 'ready') return this.conn;
    if (this.connecting) return this.connecting;
    if (this.hostMaybeRunning) await this.disconnect();
    return this.connect();
  }

  /**
   * End the host on purpose (`shutdown`, a short wait, a kill — on the Rust
   * side). The client goes `idle` immediately; everything in flight is
   * rejected; running terminals die with the host.
   */
  async disconnect(): Promise<void> {
    const wasRunning = this.hostMaybeRunning;
    this.hostMaybeRunning = false;
    if (wasRunning) this.expectedShutdownExits += 1;
    const gone = new HostRequestError('disconnected', 'the workspace host was closed');
    this.rejectAll(gone);
    this.rejectInitWaiter(gone);
    this.setConn(IDLE_CONNECTION);
    try {
      await this.transport.shutdown(this.workspaceId);
    } catch {
      // Nothing running, or the bridge is gone: either way there is no host to
      // keep, and the state above is already the truth.
    }
  }

  /** Stop listening and fail what is in flight. The host keeps running — it
   *  outlives any window or component that talked to it. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gone = new HostRequestError('disposed', 'the client was disposed');
    this.rejectAll(gone);
    this.rejectInitWaiter(gone);
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
    this.connectionListeners.clear();
    this.eventListeners.clear();
    this.outputListeners.clear();
    this.termExitListeners.clear();
    this.termGapListeners.clear();
    this.disconnectListeners.clear();
    this.stderrListeners.clear();
  }

  private ensureSubscribed(): void {
    if (this.unsubscribeTransport) return;
    this.unsubscribeTransport = this.transport.subscribe(this.workspaceId, {
      line: (line) => this.onLine(line),
      exit: (info) => this.onExit(info),
      stderr: (line) => this.onStderrLine(line),
    });
  }

  private async doConnect(): Promise<WorkspaceConnection> {
    // Subscribed before attaching: `host_init` is emitted by a thread that may
    // beat `host_attach`'s own reply.
    this.ensureSubscribed();
    this.stderrLines = [];
    this.setConn({ ...IDLE_CONNECTION, state: 'connecting' });

    let response: HostAttachResponse;
    try {
      response = await this.transport.attach({
        workspaceId: this.target.workspaceId,
        root: this.target.root,
        remoteWorkspaceId: this.target.remoteWorkspaceId,
        connection: this.target.connection,
      });
    } catch (err) {
      const message = messageOf(err);
      this.fail('attach_failed', message);
      throw new HostRequestError('attach_failed', message);
    }
    // A host already refused during the attach (its `host_init` can overtake
    // the reply) has been told to shut down; it is not one to keep believing in.
    if (this.conn.state !== 'disconnected') this.hostMaybeRunning = true;

    const ready = this.waitForInit();
    // A host somebody else started has already said its piece; the registry
    // kept the line for exactly this.
    if (typeof response.init_line === 'string') this.onLine(response.init_line);
    await ready;
    return this.conn;
  }

  private waitForInit(): Promise<void> {
    if (this.conn.state === 'ready') return Promise.resolve();
    // The host can speak (and be refused, or exit) before this is armed: a fast
    // host's `host_init` is delivered ahead of `host_attach`'s own reply. A
    // failure that already happened is this attempt's answer, not something to
    // wait out for the whole handshake budget.
    if (this.conn.state === 'disconnected') {
      return Promise.reject(
        new HostRequestError(
          this.conn.lastErrorCode ?? 'disconnected',
          this.conn.lastError ?? 'the workspace host is not connected',
        ),
      );
    }
    if (this.conn.state === 'idle') {
      return Promise.reject(new HostRequestError('disconnected', 'the workspace host was closed'));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          'timeout',
          `the workspace host did not complete its handshake within ${Math.round(this.initTimeoutMs / 1000)}s`,
        );
      }, this.initTimeoutMs);
      this.initWaiter = { resolve, reject, timer };
    });
  }

  private rejectInitWaiter(error: Error): void {
    const waiter = this.initWaiter;
    if (!waiter) return;
    this.initWaiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  /** The connection is not usable: record why, fail what is in flight. */
  private fail(code: string, message: string, exit: HostExitInfo | null = null): void {
    const was = this.conn.state;
    this.rejectAll(new HostRequestError('disconnected', message));
    this.rejectInitWaiter(new HostRequestError(code, message));
    this.setConn({
      ...IDLE_CONNECTION,
      state: 'disconnected',
      lastError: message,
      lastErrorCode: code,
      exit,
    });
    if (was === 'ready') {
      const info: HostDisconnectInfo = { code, message, exit };
      for (const cb of [...this.disconnectListeners]) this.safely(() => cb(info));
    }
  }

  /* ---------------- incoming ---------------- */

  private onStderrLine(line: string): void {
    this.stderrLines.push(line);
    if (this.stderrLines.length > STDERR_TAIL) this.stderrLines.shift();
    for (const cb of [...this.stderrListeners]) this.safely(() => cb(line));
  }

  private onExit(info: { code: number; reason: string }): void {
    if (this.disposed) return;
    this.hostMaybeRunning = false;
    if (info.reason === 'shutdown' && this.expectedShutdownExits > 0) {
      // Ours. It may be the exit of a host a reconnect has already replaced, so
      // it must not touch the current connection.
      this.expectedShutdownExits -= 1;
      return;
    }
    // Closed on purpose and nothing is running: a stale exit has nothing to say.
    if (this.conn.state === 'idle') return;

    const tail = this.stderrLines.slice(-2).join(' ').trim();
    let code: string;
    let message: string;
    if (info.reason === 'ssh_closed') {
      code = 'ssh_closed';
      message = 'The connection to the remote host was lost.';
    } else if (info.reason === 'shutdown') {
      code = 'host_exited';
      message = 'The workspace host was shut down.';
    } else {
      code = 'host_exited';
      message = `The workspace host exited unexpectedly (code ${info.code}).`;
    }
    if (tail !== '') message = `${message} ${tail}`;
    this.fail(code, message, { code: info.code, reason: info.reason });
  }

  private onLine(line: string): void {
    if (this.disposed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.droppedLines += 1;
      return;
    }
    if (!isRecord(parsed) || parsed.v !== HOST_ENVELOPE_VERSION) return;

    switch (parsed.t) {
      case 'host_init':
        this.onHostInit(parsed);
        return;
      case 'result':
        this.onResult(parsed);
        return;
      case 'error':
        // The host's own complaint (`bad_version`). It fails the request it
        // names, if any; otherwise there is nothing to change.
        this.onErrorMessage(parsed);
        return;
      case 'workspace_event':
        this.onWorkspaceEventMsg(parsed);
        return;
      case 'term_output':
        this.onTermOutputMsg(parsed);
        return;
      case 'term_exit':
        this.onTermExitMsg(parsed);
        return;
      case 'term_gap':
        this.onTermGapMsg(parsed);
        return;
      default:
        // Anything newer than this client.
        return;
    }
  }

  private onHostInit(msg: Record<string, unknown>): void {
    if (typeof msg.workspace_id === 'string' && msg.workspace_id !== this.workspaceId) return;
    const protocol = typeof msg.host_protocol === 'number' ? msg.host_protocol : null;
    if (protocol !== HOST_PROTOCOL) {
      const text = `the workspace host speaks protocol ${protocol ?? 'unknown'}, this app speaks ${HOST_PROTOCOL}`;
      this.fail('protocol_mismatch', text);
      // It would only keep running unreachable.
      void this.endRefusedHost();
      return;
    }
    const init = msg as Partial<HostInitMsg>;
    const caps: Record<string, unknown> = isRecord(init.workspace_capabilities)
      ? init.workspace_capabilities
      : {};
    const capabilities: WorkspaceCapabilities = {
      files: caps.files === true,
      file_watch: caps.file_watch === true,
      file_range_read: caps.file_range_read === true,
      git: caps.git === true,
      terminal: caps.terminal === true,
      terminal_output_replay: caps.terminal_output_replay === true,
      // The host always says false; opening a file is the desktop's own call.
      system_open: caps.system_open === true,
    };
    this.hostMaybeRunning = true;
    this.setConn({
      state: 'ready',
      capabilities,
      root: typeof init.root === 'string' ? init.root : null,
      hostVersion: typeof init.version === 'string' ? init.version : null,
      hostPid: typeof init.pid === 'number' ? init.pid : null,
      lastError: null,
      lastErrorCode: null,
      exit: null,
      connectedAt: Date.now(),
    });
    const waiter = this.initWaiter;
    if (waiter) {
      this.initWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  /** End a host we are refusing. The connection stays `disconnected` with the
   *  reason: going through `disconnect()` would pass through `idle` and lose it. */
  private async endRefusedHost(): Promise<void> {
    // Unconditional: a host that sent `host_init` exists, even when its attach
    // reply has not been processed yet and `hostMaybeRunning` is still false.
    this.expectedShutdownExits += 1;
    this.hostMaybeRunning = false;
    try {
      await this.transport.shutdown(this.workspaceId);
    } catch {
      // Nothing left to end.
    }
  }

  private onResult(msg: Record<string, unknown>): void {
    const req = typeof msg.req === 'string' ? msg.req : null;
    if (req === null) return;
    const pending = this.pending.get(req);
    // Unknown (timed out already, or never ours): dropped.
    if (!pending) return;
    this.pending.delete(req);
    clearTimeout(pending.timer);
    if (msg.ok === true) {
      pending.resolve(isRecord(msg.data) ? msg.data : {});
      return;
    }
    const body = isRecord(msg.error) ? (msg.error as Partial<HostErrorBody>) : {};
    pending.reject(
      new HostRequestError(
        typeof body.code === 'string' ? body.code : 'internal',
        typeof body.message === 'string' ? body.message : 'the workspace host refused the request',
        pending.t,
      ),
    );
  }

  private onErrorMessage(msg: Record<string, unknown>): void {
    const req = typeof msg.req === 'string' ? msg.req : null;
    if (req === null) return;
    const pending = this.pending.get(req);
    if (!pending) return;
    this.pending.delete(req);
    clearTimeout(pending.timer);
    pending.reject(
      new HostRequestError(
        typeof msg.code === 'string' ? msg.code : 'internal',
        typeof msg.message === 'string' ? msg.message : 'the workspace host reported an error',
        pending.t,
      ),
    );
  }

  private onWorkspaceEventMsg(msg: Record<string, unknown>): void {
    if (typeof msg.revision !== 'number') return;
    const event: WorkspaceEvent = {
      workspace_id: typeof msg.workspace_id === 'string' ? msg.workspace_id : this.workspaceId,
      revision: msg.revision,
      changes: Array.isArray(msg.changes) ? (msg.changes as WorkspaceEvent['changes']) : [],
      invalidates: Array.isArray(msg.invalidates)
        ? (msg.invalidates as WorkspaceEvent['invalidates'])
        : [],
      reset_required: msg.reset_required === true,
    };
    for (const cb of [...this.eventListeners]) this.safely(() => cb(event));
  }

  private onTermOutputMsg(msg: Record<string, unknown>): void {
    if (typeof msg.id !== 'string' || typeof msg.seq !== 'number' || typeof msg.data !== 'string') {
      return;
    }
    let data: Uint8Array;
    try {
      data = decodeBase64(msg.data);
    } catch {
      this.droppedLines += 1;
      return;
    }
    const event: TermOutputEvent = { id: msg.id, seq: msg.seq, data };
    for (const cb of [...this.outputListeners]) this.safely(() => cb(event));
  }

  private onTermExitMsg(msg: Record<string, unknown>): void {
    if (typeof msg.id !== 'string') return;
    const event: TermExitEvent = {
      id: msg.id,
      exit_code: typeof msg.exit_code === 'number' ? msg.exit_code : null,
    };
    for (const cb of [...this.termExitListeners]) this.safely(() => cb(event));
  }

  private onTermGapMsg(msg: Record<string, unknown>): void {
    if (typeof msg.id !== 'string' || typeof msg.from_seq !== 'number' || typeof msg.to_seq !== 'number') {
      return;
    }
    const event: TermGapEvent = { id: msg.id, from_seq: msg.from_seq, to_seq: msg.to_seq };
    for (const cb of [...this.termGapListeners]) this.safely(() => cb(event));
  }

  /* ---------------- requests ---------------- */

  private rejectAll(error: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) {
      clearTimeout(p.timer);
      p.reject(error);
    }
  }

  /**
   * Send one request and wait for its `result`.
   *
   * Only a `ready` client sends: before `host_init` the host has not said what
   * it can do, and after the host is gone nobody would answer.
   */
  request<K extends HostRequestName>(
    t: K,
    params: HostRequestMap[K]['params'],
    options: RequestOptions = {},
  ): Promise<HostRequestMap[K]['data']> {
    if (this.disposed) {
      return Promise.reject(new HostRequestError('disposed', 'the client was disposed', t));
    }
    if (this.conn.state !== 'ready') {
      return Promise.reject(
        new HostRequestError('not_connected', 'the workspace host is not connected', t),
      );
    }
    this.counter += 1;
    const req = `r${this.counter}`;
    // The envelope goes last: a parameter can never overwrite `v`, `t` or `req`.
    const line = JSON.stringify({ ...params, v: HOST_ENVELOPE_VERSION, t, req });
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;

    return new Promise<HostRequestMap[K]['data']>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(req)) {
          reject(
            new HostRequestError(
              'timeout',
              `the workspace host did not answer ${t} within ${Math.round(timeoutMs / 1000)}s`,
              t,
            ),
          );
        }
      }, timeoutMs);
      this.pending.set(req, {
        t,
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      });
      this.transport.send(this.workspaceId, line).catch((err: unknown) => {
        const pending = this.pending.get(req);
        if (!pending) return;
        this.pending.delete(req);
        clearTimeout(pending.timer);
        pending.reject(new HostRequestError('send_failed', messageOf(err), t));
      });
    });
  }

  /* ---------------- typed methods ---------------- */

  /** `fs_list`: one directory level. `''` is the root. */
  fsList(path = '', options?: RequestOptions): Promise<FsListData> {
    return this.request('fs_list', { path }, options);
  }

  /** `fs_stat` */
  fsStat(path: string, options?: RequestOptions): Promise<FsStatData> {
    return this.request('fs_stat', { path }, options);
  }

  /** `fs_read`: a byte range as text. `status` says `binary` / `non_utf8`
   *  without it being an error. */
  fsRead(
    path: string,
    range: { offset?: number; limit?: number } = {},
    options?: RequestOptions,
  ): Promise<FsReadData> {
    return this.request('fs_read', { path, ...range }, options);
  }

  /** `fs_read_bytes`: the whole file as bytes (base64 decoded here). */
  async fsReadBytes(
    path: string,
    limits: { max?: number } = {},
    options?: RequestOptions,
  ): Promise<FsReadBytesResult> {
    const wire = await this.request('fs_read_bytes', { path, ...limits }, options);
    return { path: wire.path, size: wire.size, mime: wire.mime, data: decodeBase64(wire.data) };
  }

  /** `fs_search`: name substring search. */
  fsSearch(query: string, limits: { limit?: number } = {}, options?: RequestOptions): Promise<FsSearchData> {
    return this.request('fs_search', { query, ...limits }, options);
  }

  /** `git_status`. Outside a repository `repo` is false (not an error); no git
   *  on the host is a `not_git` rejection. */
  gitStatus(options?: RequestOptions): Promise<GitStatus> {
    return this.request('git_status', {}, options);
  }

  /** `git_diff` */
  gitDiff(path: string, source: GitDiffSource, options?: RequestOptions): Promise<GitDiffData> {
    return this.request('git_diff', { path, source }, options);
  }

  /** `term_list` → the terminals (running and exited). */
  async termList(options?: RequestOptions): Promise<Term[]> {
    const data = await this.request('term_list', {}, options);
    return Array.isArray(data.terminals) ? data.terminals : [];
  }

  /** `term_create` → the new terminal. It is **not** attached: call
   *  `termAttach` to receive its output. */
  async termCreate(
    params: { cwd?: string; cols?: number; rows?: number; title?: string } = {},
    options?: RequestOptions,
  ): Promise<Term> {
    const data = await this.request('term_create', params, options);
    return data.terminal;
  }

  /** `term_attach`: replay from `fromSeq` (default 0 = everything buffered),
   *  then live `term_output`. `data` is decoded. */
  async termAttach(id: string, fromSeq?: number, options?: RequestOptions): Promise<TermAttachResult> {
    const wire = await this.request(
      'term_attach',
      fromSeq === undefined ? { id } : { id, from_seq: fromSeq },
      options,
    );
    return {
      terminal: wire.terminal,
      from_seq: wire.from_seq,
      data: decodeBase64(wire.data ?? ''),
      gap: wire.gap === true,
    };
  }

  /** `term_detach`: stop receiving output; the process keeps running. */
  async termDetach(id: string, options?: RequestOptions): Promise<void> {
    await this.request('term_detach', { id }, options);
  }

  /** `term_input`: raw text for the PTY's stdin. */
  async termInput(id: string, data: string, options?: RequestOptions): Promise<void> {
    await this.request('term_input', { id, data }, options);
  }

  /** `term_resize` */
  async termResize(id: string, cols: number, rows: number, options?: RequestOptions): Promise<void> {
    await this.request('term_resize', { id, cols, rows }, options);
  }

  /** `term_kill`: end the process, keep the entry and its exit code. */
  async termKill(id: string, options?: RequestOptions): Promise<void> {
    await this.request('term_kill', { id }, options);
  }

  /** `term_close`: end the process if running, then remove the entry. */
  async termClose(id: string, options?: RequestOptions): Promise<void> {
    await this.request('term_close', { id }, options);
  }
}
