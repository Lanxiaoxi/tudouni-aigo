/**
 * One `WorkspaceHostClient` per workspace id, and the connection state the UI
 * reads — **not** keyed by session bucket.
 *
 * Why a store of its own instead of a slice of `useApp`: the Dock's resources
 * belong to a workspace, and a workspace outlives every session in it
 * (docs/design/workspace-dock.md §1.2, §9). Putting the connection on a session
 * bucket would make "switch session" look like "switch host", and would drop the
 * state with the bucket. The app store is also a very large object whose slices
 * are all session-shaped; this one is `{ [workspaceId]: WorkspaceConnection }`
 * and nothing else.
 *
 * The registry is created with an injected transport and store so a test can
 * build one around a fake; the window's own instance is `workspaceHosts`.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  HostRequestError,
  WorkspaceHostClient,
  type HostClientOptions,
} from './client';
import {
  IDLE_CONNECTION,
  type WorkspaceConnection,
  type WorkspaceTarget,
} from './connection';
import type { HostTransport } from './transport';
import { tauriHostTransport } from './tauri';

/* ============================================================
   The per-workspace connection store
   ============================================================ */

export interface WorkspaceHostState {
  /** Connection of every workspace a client exists for. A workspace nobody has
   *  asked about is absent: read it through `selectConnection`. */
  connections: Record<string, WorkspaceConnection>;
}

export type WorkspaceHostStore = UseBoundStore<StoreApi<WorkspaceHostState>>;

export function createWorkspaceHostStore(): WorkspaceHostStore {
  return create<WorkspaceHostState>()(() => ({ connections: {} }));
}

/** The connection of one workspace, or the shared frozen idle value (selectors
 *  must return stable identities, and an unknown id has none of its own). */
export function selectConnection(
  state: WorkspaceHostState,
  workspaceId: string | null,
): WorkspaceConnection {
  if (workspaceId === null) return IDLE_CONNECTION;
  return state.connections[workspaceId] ?? IDLE_CONNECTION;
}

/* ============================================================
   The registry
   ============================================================ */

export interface WorkspaceHostRegistryOptions {
  transport: HostTransport;
  store?: WorkspaceHostStore;
  client?: Pick<HostClientOptions, 'requestTimeoutMs' | 'initTimeoutMs'>;
}

export class WorkspaceHostRegistry {
  readonly store: WorkspaceHostStore;
  private readonly transport: HostTransport;
  private readonly clientOptions: Pick<HostClientOptions, 'requestTimeoutMs' | 'initTimeoutMs'>;
  private clients = new Map<string, WorkspaceHostClient>();
  private offs = new Map<string, () => void>();

  constructor(options: WorkspaceHostRegistryOptions) {
    this.transport = options.transport;
    this.store = options.store ?? createWorkspaceHostStore();
    this.clientOptions = options.client ?? {};
  }

  /** The client for `target.workspaceId`, created on first use. Its target is
   *  refreshed on every call, so a later `connect` uses current connection
   *  facts (a binary installed since) — a running host is never moved. */
  clientFor(target: WorkspaceTarget): WorkspaceHostClient {
    let client = this.clients.get(target.workspaceId);
    if (!client) {
      client = new WorkspaceHostClient(target, { transport: this.transport, ...this.clientOptions });
      const id = target.workspaceId;
      this.clients.set(id, client);
      this.offs.set(
        id,
        client.onConnection((connection) => {
          this.store.setState((s) => ({ connections: { ...s.connections, [id]: connection } }));
        }),
      );
      this.store.setState((s) => ({ connections: { ...s.connections, [id]: client!.connection } }));
    } else {
      client.setTarget(target);
    }
    return client;
  }

  /** The existing client, or `undefined` when none was ever created. */
  get(workspaceId: string): WorkspaceHostClient | undefined {
    return this.clients.get(workspaceId);
  }

  /** Every workspace id that has a client. */
  ids(): string[] {
    return [...this.clients.keys()];
  }

  /** Lazy start (design 3.1.1: "first time the Dock is opened for the
   *  workspace"). Safe to call from any number of components. */
  connect(target: WorkspaceTarget): Promise<WorkspaceConnection> {
    return this.clientFor(target).connect();
  }

  /** Retry a `disconnected` workspace. A `ready` one is left alone. */
  reconnect(target: WorkspaceTarget): Promise<WorkspaceConnection> {
    return this.clientFor(target).reconnect();
  }

  /** The request client of a **ready** workspace, or a rejection that names the
   *  reason — for callers that want one `await` instead of checking state. */
  async ready(target: WorkspaceTarget): Promise<WorkspaceHostClient> {
    const client = this.clientFor(target);
    await client.connect();
    if (!client.isReady) {
      throw new HostRequestError('not_connected', 'the workspace host is not connected');
    }
    return client;
  }

  /** End one workspace's host on purpose and forget its client. Terminals in it
   *  die. The caller is the one who asks the person first (design 3.1.1). */
  async close(workspaceId: string): Promise<void> {
    const client = this.clients.get(workspaceId);
    if (client) {
      await client.disconnect();
      this.forget(workspaceId);
      return;
    }
    // No client in this window, but a host may still exist (another client
    // started it before a reload): ask the bridge anyway.
    await this.transport.shutdown(workspaceId).catch(() => undefined);
  }

  /** Drop a client without touching its host. */
  release(workspaceId: string): void {
    this.forget(workspaceId);
  }

  private forget(workspaceId: string): void {
    this.offs.get(workspaceId)?.();
    this.offs.delete(workspaceId);
    this.clients.get(workspaceId)?.dispose();
    this.clients.delete(workspaceId);
    this.store.setState((s) => {
      const { [workspaceId]: _gone, ...rest } = s.connections;
      return { connections: rest };
    });
  }

  /** Stop every client in this window. Hosts keep running (the app's exit hook
   *  on the Rust side ends them). */
  disposeAll(): void {
    for (const id of [...this.clients.keys()]) this.forget(id);
  }
}

/* ============================================================
   The window's instance
   ============================================================ */

export const workspaceHostStore: WorkspaceHostStore = createWorkspaceHostStore();

export const workspaceHosts = new WorkspaceHostRegistry({
  transport: tauriHostTransport,
  store: workspaceHostStore,
});

/** React hook: one workspace's connection. `null` is "no workspace". */
export function useWorkspaceConnection(workspaceId: string | null): WorkspaceConnection {
  return workspaceHostStore((s) => selectConnection(s, workspaceId));
}
