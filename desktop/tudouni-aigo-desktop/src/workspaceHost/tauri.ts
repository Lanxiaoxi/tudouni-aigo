/**
 * The Tauri side of the host channel: `host_*` commands and
 * `workspace-host://*` events behind the `HostTransport` seam.
 *
 * Same degradation rule as `runtime/tauri.ts`: outside a Tauri host there is no
 * bridge, so nothing throws at import or subscribe time; only `attach` — the one
 * call that cannot honestly do nothing — rejects, with a sentence.
 *
 * **Listeners first, attach second.** `host_init` is emitted by a thread the
 * moment the process speaks, which can be before `host_attach` has even returned.
 * Unlike the session bridge the Rust side keeps no queue for it, so `attach`
 * awaits the three `listen` calls before invoking the command. The listeners are
 * registered once for the window and dispatch by `workspace_id`.
 */
import { isHosted } from '@/runtime/tauri';
import type {
  HostAttachRequest,
  HostAttachResponse,
  HostLineHandlers,
  HostListRow,
  HostTransport,
} from './transport';

interface LineEvent {
  workspace_id: string;
  line: string;
}
interface ExitEvent {
  workspace_id: string;
  code: number;
  reason: string;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

async function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  const mod = await import('@tauri-apps/api/event');
  return mod.listen<T>(event, (e) => cb(e.payload));
}

export class TauriHostTransport implements HostTransport {
  private subscribers = new Map<string, Set<HostLineHandlers>>();
  private started: Promise<void> | null = null;

  /** Whether the host channel can work at all in this page. */
  available(): boolean {
    return isHosted();
  }

  private start(): Promise<void> {
    if (this.started) return this.started;
    // A failed registration is retried by the next attach rather than cached:
    // the promise is dropped on rejection.
    this.started = this.register().catch((err) => {
      this.started = null;
      throw err;
    });
    return this.started;
  }

  private async register(): Promise<void> {
    await listen<LineEvent>('workspace-host://line', (p) => {
      for (const h of this.subscribers.get(p.workspace_id) ?? []) h.line(p.line);
    });
    await listen<ExitEvent>('workspace-host://exit', (p) => {
      for (const h of this.subscribers.get(p.workspace_id) ?? []) {
        h.exit({ code: p.code, reason: p.reason });
      }
    });
    await listen<LineEvent>('workspace-host://stderr', (p) => {
      for (const h of this.subscribers.get(p.workspace_id) ?? []) h.stderr(p.line);
    });
  }

  subscribe(workspaceId: string, handlers: HostLineHandlers): () => void {
    let set = this.subscribers.get(workspaceId);
    if (!set) {
      set = new Set();
      this.subscribers.set(workspaceId, set);
    }
    set.add(handlers);
    return () => {
      const current = this.subscribers.get(workspaceId);
      current?.delete(handlers);
      if (current && current.size === 0) this.subscribers.delete(workspaceId);
    };
  }

  async attach(request: HostAttachRequest): Promise<HostAttachResponse> {
    if (!isHosted()) {
      throw new Error('the workspace host needs the desktop app');
    }
    await this.start();
    const c = request.connection;
    return await invoke<HostAttachResponse>('host_attach', {
      workspaceId: request.workspaceId,
      root: request.root,
      remoteWorkspaceId: request.remoteWorkspaceId,
      connection:
        c === null
          ? null
          : {
              host: c.host,
              port: c.port,
              user: c.user,
              identityFiles: c.identityFiles,
              password: c.password,
              remoteBinary: c.remoteBinary,
              connectTimeoutMs: c.connectTimeoutMs ?? null,
            },
    });
  }

  async send(workspaceId: string, line: string): Promise<void> {
    if (!isHosted()) throw new Error('the workspace host needs the desktop app');
    await invoke<null>('host_send', { workspaceId, line });
  }

  async shutdown(workspaceId: string): Promise<void> {
    if (!isHosted()) return;
    await invoke<null>('host_shutdown', { workspaceId });
  }

  async list(): Promise<HostListRow[]> {
    if (!isHosted()) return [];
    return await invoke<HostListRow[]>('host_list');
  }
}

/** The window's one transport. */
export const tauriHostTransport = new TauriHostTransport();

/** Whether the host channel exists in this page (a plain browser has none). */
export function isHostAvailable(): boolean {
  return isHosted();
}
