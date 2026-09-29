/**
 * The Tauri bridge: the only place that talks to a real runtime.
 *
 * The runtime is a separate process. The Rust side owns it — starting it,
 * guarding it, moving bytes — and deliberately does **not** parse the protocol:
 * it hands whole lines to the WebView and writes whole lines back. Any urge to
 * read `kind` in Rust would create a second definition of the protocol, and it
 * would drift.
 *
 * Two things this module does that the Rust side cannot do for it:
 *   - it decodes each line with the tolerant decoder, counting what it drops;
 *   - it synthesizes `runtime_exited` from the bridge's exit event, because the
 *     runtime never sends one (see `internal/protocol/client.go`: it is the
 *     client's own message).
 *
 * In a plain browser (`npm run dev` without a Tauri host) the IPC surface is
 * absent, so the bridge reports itself unavailable and the UI stays in its
 * "starting" phase rather than throwing.
 */

import type { FrontendMsg, RuntimeMsg } from '@/protocol/types';
import { decodeLine } from '@/protocol/types';
import type { Runtime } from './bus';

type UnlistenFn = () => void;

interface LineEvent {
  line: string;
}

interface ExitEvent {
  code: number;
  requested: boolean;
}

/** Is this page hosted by Tauri? */
export function isHosted(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/* ============================================================
   Tauri IPC, imported lazily
   ============================================================ */

async function tauriInvoke<T>(
  cmd: string,
  // `Uint8Array` as well as an object, because one command takes the **bytes
  // themselves** as its payload (`image_stash`). Tauri sends a `Uint8Array`
  // argument as a raw body rather than a JSON value, which is the whole point:
  // five megabytes of picture as base64 is 6.7MB of text, and as a JSON number
  // array it is over 20MB.
  args?: Record<string, unknown> | Uint8Array,
): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

async function tauriListen<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  const mod = await import('@tauri-apps/api/event');
  return mod.listen<T>(event, (e) => cb(e.payload));
}

/* ============================================================
   The runtime bridge
   ============================================================ */

export interface BridgeOptions {
  /** Absolute path to the runtime binary. Never resolved from PATH: another
   *  build on PATH is another program, and the symptom is a child that exits
   *  immediately. */
  binary: string;
  /** The workspace. The runtime takes its working directory as the workspace. */
  workspace: string;
  /** `--session <id>`, when resuming a specific one. */
  sessionId?: string;
  /** `--max-steps <n>`. */
  maxSteps?: number;
  /** `--stream`. */
  stream?: boolean;
  /** `--autopilot`. */
  autopilot?: boolean;
}

/** Read the runtime's version. The binary path is optional: the Rust side knows
 *  where it put the packaged runtime. */
export async function readRuntimeVersion(binary = ''): Promise<string | null> {
  if (!isHosted()) return null;
  try {
    return await tauriInvoke<string | null>('runtime_version', { binary });
  } catch {
    return null;
  }
}

/**
 * @param onDrop  A line the decoder refused. `fatal` is set for the one reason
 *                that means no further line can be read either — an envelope
 *                version mismatch — which is a statement about the pairing, not
 *                about the line.
 * @param onStderr  Diagnostics from the child, verbatim. Not protocol data, and
 *                deliberately not part of any `RuntimeMsg`: it is what the
 *                "the runtime would not start" panel is made of.
 */
export function createTauriRuntime(
  onDrop: (reason: string, fatal: boolean) => void,
  onStderr?: (line: string) => void,
  onAttachFailure?: (problem: string) => void,
): Runtime {
  const listeners = new Set<(msg: RuntimeMsg) => void>();
  const unlisten: UnlistenFn[] = [];
  let disposed = false;

  // Lines that arrive before anything subscribes are held here and flushed in
  // order. This is the race the design calls out: the process can be up and
  // `init` sent before the WebView's listener exists, and a WebView's load
  // timing is not ours to control. Queueing is more reliable than "register
  // early and hope".
  let queue: RuntimeMsg[] = [];
  let attached = false;

  function emit(msg: RuntimeMsg): void {
    if (listeners.size === 0) {
      queue.push(msg);
      return;
    }
    for (const listener of listeners) listener(msg);
  }

  function flush(): void {
    if (queue.length === 0) return;
    const pending = queue;
    queue = [];
    for (const listener of listeners) {
      for (const msg of pending) listener(msg);
    }
  }

  /**
   * Register one listener, and honour a `dispose()` that lands while the IPC
   * call is still in flight.
   *
   * Registration is `await`ed — the Tauri IPC round trip is asynchronous — and
   * `dispose()` is not: it can run between the call and its resolution. Pushing
   * the `unlisten` into the array only *after* the await means that race leaves
   * a listener registered on the host that nothing will ever remove. React 19's
   * StrictMode double-mounts every effect in development, so this happened on
   * every dev start, leaking three listeners and a queue nobody drains per
   * mount — and making `runtime_attach` fire twice, which starts a second child.
   */
  async function listen<T>(event: string, cb: (payload: T) => void): Promise<void> {
    const off = await tauriListen<T>(event, cb);
    if (disposed) off();
    else unlisten.push(off);
  }

  void (async () => {
    if (!isHosted()) return;
    try {
      await listen<LineEvent>('runtime://line', (payload) => {
        const result = decodeLine(payload.line);
        if (result.msg === null) {
          // A malformed line is skipped and counted, never a stream failure:
          // half a line is a real thing (the writer was killed), and a mistyped
          // flag makes the child print usage prose to stdout. A version mismatch
          // is the exception and is reported as fatal.
          if (result.reason) onDrop(result.reason, result.fatal === true);
          return;
        }
        emit(result.msg);
      });

      await listen<ExitEvent>('runtime://exited', (payload) => {
        // The runtime never sends this; the bridge synthesizes it. Both a
        // requested shutdown and a dead process exit with code 0, so the
        // `requested` flag is the only thing that tells "the session ended"
        // from "the runtime died".
        emit({
          v: 1,
          t: 'runtime_exited',
          code: payload.code,
          requested: payload.requested,
        });
      });

      // stderr is diagnostics only, never business data. It is kept for the
      // local "the runtime would not start" panel and goes no further.
      //
      // The handler used to be empty, which is how the bridge ended up holding
      // a ring of perfectly good stderr that nothing could see — the panel the
      // README describes was never built, because nothing consumed this.
      await listen<LineEvent>('runtime://stderr', (payload) => {
        onStderr?.(payload.line);
      });
    } catch (err) {
      // Reported rather than swallowed. A silent failure here leaves the bridge
      // with `listening = false`, and `forward_line` then queues every line the
      // child sends without ever releasing it — the UI boots forever over a
      // healthy runtime, with no error anywhere to explain it.
      onAttachFailure?.(`could not register the runtime listeners: ${String(err)}`);
    }
  })();

  return {
    send(msg: FrontendMsg): void {
      if (disposed || !isHosted()) return;
      void tauriInvoke('runtime_send', { line: JSON.stringify(msg) }).catch(() => {
        /* The child is gone; `runtime://exited` is the message that says so. */
      });
    },

    subscribe(cb: (msg: RuntimeMsg) => void): () => void {
      listeners.add(cb);
      if (!attached) {
        attached = true;
        // Flush whatever the bridge queued before this listener existed.
        flush();
      }
      return () => {
        listeners.delete(cb);
      };
    },

    dispose(): void {
      disposed = true;
      listeners.clear();
      for (const off of unlisten) off();
      unlisten.length = 0;
    },
  };
}

/** Start (or restart) the child. Resolves once the bridge has accepted it.
 *
 *  An empty options object means "use the bridge's defaults": the binary and the
 *  workspace are resolved by the Rust side (the packaged runtime next to the app
 *  resources, and the workspace the user last chose).
 *
 *  Streaming is on unless a caller says otherwise. The runtime's stdio front end
 *  does not stream by itself — both `--stream` and `--no-stream` default to off,
 *  and only the full-screen TUI turns it on for itself (`cmd/tudouni/main.go`) —
 *  while this interface is built around `delta`: the body accumulates as it is
 *  written and `run_finished.answer` then settles it (`src/state/entries.ts`).
 *  Without the flag nothing is painted until the whole answer exists, which on a
 *  long step reads as a hang. `stream: false` asks for exactly that. */
export async function attachRuntime(options: Partial<BridgeOptions> = {}): Promise<void> {
  if (!isHosted()) return;
  await tauriInvoke('runtime_attach', {
    options: {
      binary: options.binary ?? null,
      workspace: options.workspace ?? null,
      sessionId: options.sessionId ?? null,
      maxSteps: options.maxSteps ?? null,
      // Not `?? null`: leaving the flag out is how the runtime is told *not* to
      // stream, so the default has to be spelled out here.
      stream: options.stream ?? true,
      autopilot: options.autopilot ?? null,
    },
  });
}

/** Tell the bridge the front end is listening, so it flushes everything it
 *  queued before that was true. Returns how many lines were released. */
export async function attachRuntimeListener(): Promise<number> {
  if (!isHosted()) return 0;
  try {
    return await tauriInvoke<number>('runtime_attach_listener');
  } catch {
    return 0;
  }
}

/** Ask for a graceful shutdown. The bridge waits, then kills on timeout. */
export async function shutdownRuntime(): Promise<void> {
  if (!isHosted()) return;
  await tauriInvoke('runtime_shutdown');
}

/**
 * Quit the application: finish the runtime, then close the window.
 *
 * Going through the **bridge** command rather than a bare `shutdown` protocol
 * message is the load-bearing part. `runtime_shutdown` is what sets
 * `requested = true` before waiting, and `runtime://exited` carries that flag —
 * so this reads as "the session ended". A protocol `shutdown` left the flag
 * false, and the person who pressed Ctrl+C was told, in red, that the runtime
 * had died unexpectedly with code 0.
 *
 * The window is closed even if the graceful wait fails: a quit that leaves the
 * window open is a quit that did not happen.
 */
export async function quitApp(): Promise<void> {
  if (!isHosted()) return;
  try {
    await tauriInvoke('runtime_shutdown');
  } finally {
    try {
      const mod = await import('@tauri-apps/api/window');
      await mod.getCurrentWindow().close();
    } catch {
      /* Already gone. */
    }
  }
}

/** The kill switch, for when the graceful wait is not enough. */
export async function killRuntime(): Promise<void> {
  if (!isHosted()) return;
  await tauriInvoke('runtime_kill');
}

/** The last stderr lines, for the local "it would not start" panel. Not
 *  protocol data. */
export async function readRuntimeStderr(): Promise<string[]> {
  if (!isHosted()) return [];
  try {
    return await tauriInvoke<string[]>('runtime_stderr');
  } catch {
    return [];
  }
}

/** The OS user name, for the greeting. Null when it cannot be read: the
 *  greeting then omits the name rather than saying "unknown". */
export async function readUserName(): Promise<string | null> {
  if (!isHosted()) return null;
  try {
    const name = await tauriInvoke<string | null>('os_user_name');
    return name && name.trim() !== '' ? name : null;
  } catch {
    return null;
  }
}

/** A directory picker. Null when the person cancels. */
export async function chooseWorkspaceDirectory(): Promise<string | null> {
  if (!isHosted()) return null;
  try {
    const mod = await import('@tauri-apps/plugin-dialog');
    const picked = await mod.open({ directory: true, multiple: false });
    return typeof picked === 'string' ? picked : null;
  } catch {
    return null;
  }
}

/**
 * Why the runtime could not be started in this directory, or null when it could.
 *
 * Asked **before** a directory becomes a row in the list. The rule is the same
 * one the spawn path applies (`unsafe_workspace` is shared, so the two cannot
 * drift): the runtime refuses the home directory, a volume root and an ancestor
 * of home, and it does so by exiting with code 2 after writing to a stderr
 * nobody is reading. Discovering that at the moment of choosing — while the
 * choice is still in front of the person — is worth one round trip.
 *
 * Outside a Tauri host there is nothing to ask, and the answer is "no objection"
 * rather than a made-up refusal: the browser has no runtime either.
 */
export async function checkWorkspace(path: string): Promise<string | null> {
  if (!isHosted()) return null;
  try {
    return await tauriInvoke<string | null>('workspace_check', { path });
  } catch {
    return null;
  }
}

/** What the bridge hands back after writing a pasted picture. */
export interface StashedImage {
  /** Workspace-relative, with forward slashes — the string that goes into the
   *  sentence and that the runtime's scanner will resolve. */
  path: string;
  name: string;
  mime: string;
  bytes: number;
}

/**
 * Write a pasted picture into the workspace and get its path back.
 *
 * The bytes go as the **raw request body** (`invoke` with a `Uint8Array`), not as
 * base64 inside a JSON argument: five megabytes as base64 is 6.7MB of text, and
 * as a JSON number array it is over 20MB. That also means no second named
 * argument can travel with the call — the payload *is* the picture — which is why
 * the Rust side takes the workspace from the bridge rather than from here.
 *
 * This is the only place a paste touches the disk, and it deliberately does no
 * checking of its own: the gates (workspace present, format, size) are applied
 * before the call, by `runtime/paste.ts`, so a refusal can be a sentence the
 * person reads immediately instead of an error string from across the IPC. The
 * Rust side re-checks all three anyway — it is a different process, and the first
 * check is in a different language.
 *
 * Rejections are surfaced rather than swallowed: every one of them is a reason
 * the picture did not attach, and a paste that silently does nothing is the
 * failure this feature can least afford.
 */
export async function stashImage(bytes: Uint8Array): Promise<StashedImage> {
  if (!isHosted()) {
    throw new Error('pictures can only be pasted into the desktop application');
  }
  return tauriInvoke<StashedImage>('image_stash', bytes);
}
