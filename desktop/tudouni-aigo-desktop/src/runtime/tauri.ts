/**
 * The Tauri bridge: the only place that talks to a real runtime.
 *
 * The runtime is a separate process per session. The Rust side owns them —
 * starting them, guarding them, moving bytes — and deliberately does **not**
 * parse the protocol: it hands whole lines to the WebView and writes whole lines
 * back. Any urge to read `kind` in Rust would create a second definition of the
 * protocol, and it would drift.
 *
 * Two things this module does that the Rust side cannot do for it:
 *   - it decodes each line with the tolerant decoder, counting what it drops;
 *   - it synthesizes `runtime_exited` from the bridge's exit event, because the
 *     runtime never sends one (see `internal/protocol/client.go`: it is the
 *     client's own message).
 *
 * **The listeners are registered once, process-wide, and dispatch by key.**
 * Registering a set per session would be N sets of three, each needing its own
 * teardown, and the teardown is where this has gone wrong before (see `listen`
 * below). The key arrives on every event because the bridge adds it — it cannot
 * be read off the payload, since `session_load`, every `ui` kind, `notice`,
 * `sessions` and both blocking requests carry no `session_id`.
 *
 * In a plain browser (`npm run dev` without a Tauri host) the IPC surface is
 * absent, so the bridge reports itself unavailable and the UI stays in its
 * "starting" phase rather than throwing.
 */

import type { FrontendMsg, RuntimeMsg } from '@/protocol/types';
import { decodeLine } from '@/protocol/types';
import type { Runtime } from './bus';

type UnlistenFn = () => void;

/** The bridge tags every event with the key of the child that produced it. */
interface KeyedEvent {
  key: number;
  line: string;
}

interface ExitEvent {
  key: number;
  code: number;
  requested: boolean;
}

interface StderrEvent {
  key: number;
  line: string;
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
  // Headers, because a raw body leaves no room for a named argument — which is
  // how `image_stash` is told which session's workspace to write into.
  options?: { headers?: Record<string, string> },
): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  // The cast is for the third parameter's `HeadersInit` in the upstream types,
  // which a plain record satisfies at runtime and does not structurally be.
  return mod.invoke<T>(cmd, args, options as Parameters<typeof mod.invoke>[2]);
}

async function tauriListen<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  const mod = await import('@tauri-apps/api/event');
  return mod.listen<T>(event, (e) => cb(e.payload));
}

/* ============================================================
   The host: one set of listeners, many sessions
   ============================================================ */

/** What the host needs in order to hand a session its lines. */
interface Sink {
  emit(msg: RuntimeMsg): void;
  stderr(line: string): void;
}

/**
 * A line the decoder refused.
 *
 * The key comes first because the count has to land in the session it came from:
 * one shared tally would let a session with a broken writer look like a session
 * with an ordering problem, which is the mistake `dropped` and `lateDropped`
 * were split apart to avoid in the first place.
 */
interface DropReport {
  (key: string, reason: string, fatal: boolean): void;
}

/**
 * Process-wide wiring between the bridge's events and the per-session handles.
 *
 * It exists so that `listen` is called three times for the window rather than
 * three times per session, and so that a line which arrives for a key with no
 * handle yet has somewhere to wait. That case is real: `attachRuntime` returns
 * the key, and the child can emit `init` before the caller has finished building
 * the handle to receive it.
 */
class RuntimeHost {
  private sinks = new Map<string, Sink>();
  /** Lines and diagnostics for keys with no handle yet, in arrival order. */
  private pendingLines = new Map<string, RuntimeMsg[]>();
  private pendingStderr = new Map<string, string[]>();

  private unlisten: UnlistenFn[] = [];
  private ready: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private onDrop: DropReport,
    private onAttachFailure: (problem: string) => void,
  ) {}

  /**
   * Point the window's reporters at the latest session's callback.
   *
   * The two reports are process-wide statements (see `register`), but they are
   * *reported* through a session's handle because that is where the store's
   * plumbing lives. Adopting the newest is right: they all end in the same two
   * places — the global startup problem, and a process-wide drop count.
   */
  adopt(onDrop: DropReport, onAttachFailure: (problem: string) => void): void {
    this.onDrop = onDrop;
    this.onAttachFailure = onAttachFailure;
  }

  /** Register the three event listeners, once. Idempotent. */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.register();
    return this.ready;
  }

  /** The same promise, for a caller that only needs to know when to proceed. */
  started(): Promise<void> {
    return this.start();
  }

  private async register(): Promise<void> {
    if (!isHosted()) return;
    try {
      const offLine = await tauriListen<KeyedEvent>('runtime://line', (payload) => {
        const key = String(payload.key);
        const result = decodeLine(payload.line);
        if (result.msg === null) {
          // A malformed line is skipped and counted, never a stream failure:
          // half a line is a real thing (the writer was killed), and a mistyped
          // flag makes the child print usage prose to stdout. A version mismatch
          // is the exception and is reported as fatal.
          //
          // The key goes with it because the *count* is per session even though
          // the fatal case is not: one shared tally would let a session with a
          // broken writer look like one with an ordering problem.
          if (result.reason) this.onDrop(key, result.reason, result.fatal === true);
          return;
        }
        this.deliverLine(key, result.msg);
      });
      this.unlisten.push(offLine);

      const offExit = await tauriListen<ExitEvent>('runtime://exited', (payload) => {
        // The runtime never sends this; the bridge synthesizes it. Both a
        // requested shutdown and a dead process exit with code 0, so the
        // `requested` flag is the only thing that tells "the session ended"
        // from "the runtime died". The key is what makes that statement about
        // one session rather than about the window.
        this.deliverLine(String(payload.key), {
          v: 1,
          t: 'runtime_exited',
          code: payload.code,
          requested: payload.requested,
        });
      });
      this.unlisten.push(offExit);

      // stderr is diagnostics only, never business data. It is kept for the
      // local "the runtime would not start" panel and goes no further.
      //
      // The handler used to be empty, which is how the bridge ended up holding
      // a ring of perfectly good stderr that nothing could see — the panel the
      // README describes was never built, because nothing consumed this.
      const offStderr = await tauriListen<StderrEvent>('runtime://stderr', (payload) => {
        this.deliverStderr(String(payload.key), payload.line);
      });
      this.unlisten.push(offStderr);
    } catch (err) {
      // Reported rather than swallowed. A silent failure here leaves the bridge
      // with `listening = false`, and `forward_line` then queues every line the
      // child sends without ever releasing it — the UI boots forever over a
      // healthy runtime, with no error anywhere to explain it.
      this.onAttachFailure(`could not register the runtime listeners: ${String(err)}`);
    }
  }

  private deliverLine(key: string, msg: RuntimeMsg): void {
    const sink = this.sinks.get(key);
    if (sink) {
      sink.emit(msg);
      return;
    }
    this.pendingLines.set(key, [...(this.pendingLines.get(key) ?? []), msg]);
  }

  private deliverStderr(key: string, line: string): void {
    const sink = this.sinks.get(key);
    if (sink) {
      sink.stderr(line);
      return;
    }
    this.pendingStderr.set(key, [...(this.pendingStderr.get(key) ?? []), line]);
  }

  /**
   * Attach a session and drain whatever arrived before it.
   *
   * Draining is the point of the pending maps: the child starts writing as soon
   * as it is spawned, which is one IPC round trip before this handle exists.
   */
  attach(key: string, sink: Sink): void {
    this.sinks.set(key, sink);
    for (const msg of this.pendingLines.get(key) ?? []) sink.emit(msg);
    this.pendingLines.delete(key);
    for (const line of this.pendingStderr.get(key) ?? []) sink.stderr(line);
    this.pendingStderr.delete(key);
  }

  detach(key: string): void {
    this.sinks.delete(key);
    // Whatever arrived for a session that is gone is not for anybody: a stale
    // key is never reused, so nothing will ever claim it.
    this.pendingLines.delete(key);
    this.pendingStderr.delete(key);
  }

  dispose(): void {
    this.disposed = true;
    this.sinks.clear();
    this.pendingLines.clear();
    this.pendingStderr.clear();
    for (const off of this.unlisten) off();
    this.unlisten.length = 0;
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

/** The window's one host. Installed by `initBridge`, before any session. */
let host: RuntimeHost | null = null;

/**
 * Install the window's listeners and its two process-wide reporters.
 *
 * **Called once, before any session is started**, and that ordering is
 * load-bearing rather than tidy. The announcement that follows
 * (`attachRuntimeListener`) tells the bridge to stop queueing and start emitting
 * — so making it before the listeners exist is the same as having no listeners at
 * all: the bridge flushes its opening triple into the void and the UI boots
 * forever over a perfectly healthy runtime. Waiting on this call is what makes
 * that impossible, instead of relying on a `catch` that used to swallow it.
 *
 * Both reporters are per-window facts, not per-session ones: a decoder refusal is
 * a statement about the pairing (and every child is the same binary), and a
 * failure to register listeners is a statement about this WebView. So they are
 * installed here rather than handed in with each session.
 */
export async function initBridge(
  onDrop: DropReport,
  onAttachFailure: (problem: string) => void,
): Promise<void> {
  if (!isHosted()) return;
  if (!host || host.isDisposed()) {
    host = new RuntimeHost(onDrop, onAttachFailure);
  } else {
    host.adopt(onDrop, onAttachFailure);
  }
  await host.started();
}

/** The installed host, or null when nothing has been wired yet. */
function ensureHost(): RuntimeHost | null {
  if (host && !host.isDisposed()) return host;
  return null;
}

/* ============================================================
   Launch options
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
  /** `--ericai`: manage the EricAI token for this session.
   *
   *  A start-up argument and **not** a setting, which is not a matter of taste:
   *  the runtime decides at open which route the session manages, and a session
   *  moved onto that route afterwards is deliberately not taken over
   *  (`internal/runtime/composition.go`, `Options.EricAI`). So it can only be
   *  passed when the child is started — which is why changing it means opening
   *  another session rather than sending a message.
   *
   *  Absent and `false` are the same thing. It is never defaulted to true: turning
   *  it on lets this process rewrite `providers.ericai.api_key` in the person's own
   *  configuration and keep a refresh token under `~/.tudouni/`. */
  ericai?: boolean;
}

/* ============================================================
   Per-session handles
   ============================================================ */

/**
 * A session key as the bridge's `u64`, or `null` when it names no child.
 *
 * **This is not a cast, it is a guard, and it exists because of what `null`
 * means on the wire.** The Rust commands take `Option<ChildKey>`, where `None`
 * is documented as "every session" — and `JSON.stringify({ key: NaN })` is
 * `{"key":null}`, because JSON has no NaN. So `Number(key)` on a key the bridge
 * never minted silently escalates a per-session act into a window-wide one.
 *
 * It is reachable rather than theoretical: `attachSession` names the bucket for a
 * child that refused to start `failed-<stamp>`, so `Number('failed-muoy2dpe')` is
 * `NaN` — and the "Try again" button on that session would otherwise have shut
 * down every *other* conversation the person had open.
 *
 * The keys the bridge mints are positive integers as decimal strings
 * (`ChildKey = u64`, `guard.next_key += 1`), so anything else is not one.
 */
function bridgeKey(key: string): number | null {
  if (!/^\d+$/.test(key)) return null;
  const value = Number(key);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Read the runtime's version. The binary path is optional: the Rust side knows
 * where it put the packaged runtime.
 *
 * Process-wide rather than per session, and that is not an optimisation: every
 * child is the same binary, so asking once answers for all of them.
 */
export async function readRuntimeVersion(binary = ''): Promise<string | null> {
  if (!isHosted()) return null;
  try {
    return await tauriInvoke<string | null>('runtime_version', { binary });
  } catch {
    return null;
  }
}

/**
 * The handle for one session's child.
 *
 * @param key       The bridge's key, from `attachRuntime`.
 * @param onStderr  Diagnostics from **this** child, verbatim. Not protocol data,
 *                  and deliberately not part of any `RuntimeMsg`: it is what the
 *                  "the runtime would not start" panel is made of. Per session
 *                  because a start-up failure belongs to the session whose
 *                  binary would not start.
 *
 * The two process-wide reporters are installed by `initBridge`, not here: a
 * decoder refusal and a listener-registration failure are statements about the
 * window, and every child is the same binary.
 */
export function createTauriRuntime(
  key: string,
  onStderr?: (line: string) => void,
): Runtime {
  const listeners = new Set<(msg: RuntimeMsg) => void>();
  let disposed = false;

  // Lines that arrive before anything subscribes are held here and flushed in
  // order. This is the race the design calls out: the process can be up and
  // `init` sent before the subscriber exists. The host has its own copy of this
  // queue for the window between "key returned" and "handle built"; this one
  // covers the window between "handle built" and "store subscribed".
  let queue: RuntimeMsg[] = [];
  let attached = false;

  const theHost = ensureHost();

  theHost?.attach(key, {
    emit(msg) {
      if (listeners.size === 0) {
        queue.push(msg);
        return;
      }
      for (const listener of listeners) listener(msg);
    },
    stderr(line) {
      onStderr?.(line);
    },
  });

  function flush(): void {
    if (queue.length === 0) return;
    const pending = queue;
    queue = [];
    for (const listener of listeners) {
      for (const msg of pending) listener(msg);
    }
  }

  return {
    key,

    send(msg: FrontendMsg): void {
      if (disposed || !isHosted()) return;
      void tauriInvoke('runtime_send', { key: Number(key), line: JSON.stringify(msg) }).catch(
        () => {
          /* The child is gone; `runtime://exited` is the message that says so. */
        },
      );
    },

    subscribe(cb: (msg: RuntimeMsg) => void): () => void {
      listeners.add(cb);
      if (!attached) {
        attached = true;
        // Flush whatever was queued before this listener existed.
        flush();
      }
      return () => {
        listeners.delete(cb);
      };
    },

    dispose(): void {
      disposed = true;
      listeners.clear();
      theHost?.detach(key);
    },
  };
}

/* ============================================================
   Process-level commands
   ============================================================ */

/** Start one session's child and return the key that names it.
 *
 *  **It adds a session; it does not replace one.** Calling it twice gives two
 *  running sessions, which is what a person who opens a second conversation
 *  while the first is working is asking for.
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
 *  long step reads as a hang. `stream: false` asks for exactly that.
 *
 *  Outside a Tauri host there is no bridge to start anything, and `null` is
 *  returned so a caller can tell "no runtime" from "a runtime with a key". */
export async function attachRuntime(
  options: Partial<BridgeOptions> = {},
): Promise<string | null> {
  if (!isHosted()) return null;
  const key = await tauriInvoke<number>('runtime_attach', {
    options: {
      binary: options.binary ?? null,
      workspace: options.workspace ?? null,
      sessionId: options.sessionId ?? null,
      maxSteps: options.maxSteps ?? null,
      // Not `?? null`: leaving the flag out is how the runtime is told *not* to
      // stream, so the default has to be spelled out here.
      stream: options.stream ?? true,
      autopilot: options.autopilot ?? null,
      // `?? null` rather than `?? false`, and it makes no difference to the child —
      // the Rust side only adds `--ericai` for `Some(true)`. The distinction lives
      // here so that "nobody said" stays visible: this is the one flag that lets
      // the runtime write to the person's configuration file.
      ericai: options.ericai ?? null,
    },
  });
  return String(key);
}

/** Tell the bridge the front end is listening, so it flushes everything every
 *  child queued before that was true. Returns how many lines were released. */
export async function attachRuntimeListener(): Promise<number> {
  if (!isHosted()) return 0;
  try {
    return await tauriInvoke<number>('runtime_attach_listener');
  } catch {
    return 0;
  }
}

/**
 * Ask for a graceful shutdown, then make sure the child is gone.
 *
 * `key` omitted means **every session**, which is what closing the window wants:
 * nothing survives that, and asking them one at a time would multiply the wait
 * by the number of conversations open.
 *
 * A single key is a different act — closing one conversation is not a reason to
 * end another.
 *
 * **A key that names no child is refused here, never escalated to "all of
 * them".** `null` is the wire form of `None`, which this command reads as every
 * session — and `Number('failed-muoy2dpe')` is `NaN`, which `JSON.stringify`
 * writes as `null`. So a bucket whose child never started (`attachSession`'s
 * `catch` names it `failed-…`) used to shut down every *other* conversation when
 * its "Try again" button was pressed. The two cases are now distinct: an absent
 * key means all, and a key that is not a child is a no-op.
 */
export async function shutdownRuntime(key?: string): Promise<void> {
  if (!isHosted()) return;
  if (key === undefined) {
    await tauriInvoke('runtime_shutdown', { key: null });
    return;
  }
  const target = bridgeKey(key);
  if (target === null) return;
  await tauriInvoke('runtime_shutdown', { key: target });
}

/**
 * Quit the application: finish every runtime, then close the window.
 *
 * Going through the **bridge** command rather than a bare `shutdown` protocol
 * message is the load-bearing part. `runtime_shutdown` is what sets
 * `requested = true` before waiting, and `runtime://exited` carries that flag —
 * so this reads as "the session ended". A protocol `shutdown` left the flag
 * false, and a deliberate quit would have been reported, in red, as a
 * runtime that died unexpectedly with code 0.
 *
 * **It ends in `window_destroy`, not `close()`.** `close()` raises a close
 * request, and the window now answers those with the minimize-or-close prompt —
 * so a person who typed `/exit` would be asked whether they meant to exit. They
 * did; that is what typing it means. `window_destroy` is the one path that skips
 * the question, and this is the only caller.
 *
 * The window is closed even if the graceful wait fails: a quit that leaves the
 * window open is a quit that did not happen.
 */
export async function quitApp(): Promise<void> {
  if (!isHosted()) return;
  try {
    await tauriInvoke('runtime_shutdown', { key: null });
  } finally {
    try {
      await tauriInvoke('window_destroy');
    } catch {
      /* Already gone. */
    }
  }
}

/* ============================================================
   Closing the window: minimize, or close for real
   ============================================================ */

/**
 * Tell Rust the close prompt is **on screen**.
 *
 * The counterpart to the deadline in `lib.rs`, and the reason the prompt can be
 * read at leisure: Rust opens a window close request, arms a watchdog for the
 * round trip, and this call disarms it. Without it the window would close itself
 * a few seconds after the dialog appeared — while somebody was still deciding,
 * which for a dialog that offers to remember the choice is the normal case.
 *
 * Called before the dialog renders, not after, because the deadline it clears is
 * short and a render is a frame the front end cannot promise the timing of. What
 * it claims is "the dialog is up", and the component that calls it is the one
 * that is about to draw it.
 */
export async function acknowledgeClosePrompt(): Promise<void> {
  if (!isHosted()) return;
  try {
    await tauriInvoke('close_prompt_ack');
  } catch {
    // Rust will close the window when the deadline expires. That is the correct
    // outcome for a front end that cannot reach it, and there is nothing a
    // sentence here could add.
  }
}

/** Which of the three things the close prompt can resolve to. */
export type CloseChoice = 'minimize' | 'close' | 'cancel';

/**
 * Answer the close prompt.
 *
 * **The only way the window closes from that dialog.** Calling
 * `getCurrentWindow().close()` here would raise a fresh close request, which the
 * handler refuses and turns into another prompt — so the dialog would reappear
 * every time it was answered, and the window could never be closed through it.
 *
 * "Minimize" leaves every session running; that is the whole meaning of the
 * choice, and Rust does not touch a child for it. "Cancel" is a dismissal: the
 * window stays up and the close request is over, which is what Esc and a click
 * outside both resolve to.
 */
export async function answerClosePrompt(choice: CloseChoice): Promise<void> {
  if (!isHosted()) return;
  try {
    await tauriInvoke('close_prompt_answer', { choice });
  } catch (err) {
    // The window is gone already, or the command was refused. Nothing to report:
    // the alternative to a failed close is a torn-down window in every case.
    console.warn('could not answer the close prompt:', err);
  }
}

/**
 * Listen for a window close request.
 *
 * The bridge emits `window://close-requested` (no payload) from the
 * `CloseRequested` handler, having already called `prevent_close()` — so the
 * window is guaranteed still to be there when this fires, and the dialog has as
 * long as it needs.
 *
 * Returns the unsubscribe function, like the bridge's other listeners, so the
 * caller can tear it down. `listen` is a promise, so an unmount that races the
 * subscription is possible; the returned function handles that by awaiting the
 * same promise and unsubscribing when it lands, rather than by dropping the
 * handle and leaking the listener.
 */
export function onCloseRequested(cb: () => void): () => void {
  let unlisten: (() => void) | null = null;
  let stopped = false;
  void (async () => {
    if (!isHosted()) return;
    try {
      const mod = await import('@tauri-apps/api/event');
      const off = await mod.listen('window://close-requested', () => cb());
      // The component unmounted while that was in flight.
      if (stopped) off();
      else unlisten = off;
    } catch {
      // Not hosted, or the capability is missing. The Rust watchdog then closes
      // the window after its deadline, which is the documented fallback rather
      // than a hang.
    }
  })();
  return () => {
    stopped = true;
    unlisten?.();
    unlisten = null;
  };
}

/** The kill switch, for when the graceful wait is not enough. `key` omitted
 *  means every session.
 *
 *  Same guard as `shutdownRuntime`, and for the same reason: `null` is `None`,
 *  which this command reads as every session — so a key the bridge never minted
 *  must be a no-op rather than an escalation. */
export async function killRuntime(key?: string): Promise<void> {
  if (!isHosted()) return;
  if (key === undefined) {
    await tauriInvoke('runtime_kill', { key: null });
    return;
  }
  const target = bridgeKey(key);
  if (target === null) return;
  await tauriInvoke('runtime_kill', { key: target });
}

/** The last stderr lines of one session's child, for the local "it would not
 *  start" panel. Not protocol data. */
export async function readRuntimeStderr(key: string): Promise<string[]> {
  if (!isHosted()) return [];
  try {
    return await tauriInvoke<string[]>('runtime_stderr', { key: Number(key) });
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
 * Write a pasted picture into **one session's** workspace and get its path back.
 *
 * The bytes go as the **raw request body** (`invoke` with a `Uint8Array`), not as
 * base64 inside a JSON argument: five megabytes as base64 is 6.7MB of text, and
 * as a JSON number array it is over 20MB. That also means no second named
 * argument can travel with the call — the payload *is* the picture — so the key
 * goes as a header instead. The Rust side then takes the workspace from *that
 * child* rather than from here, which is what keeps a caller-supplied string from
 * ever reaching the path.
 *
 * The key is not optional and not inferred. Writing the file into another
 * session's workspace would produce a path that looks perfectly ordinary in the
 * sentence and resolves to nothing when the turn runs — a paste that silently
 * did nothing, which is this feature's worst failure mode.
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
export async function stashImage(key: string, bytes: Uint8Array): Promise<StashedImage> {
  if (!isHosted()) {
    throw new Error('pictures can only be pasted into the desktop application');
  }
  return tauriInvoke<StashedImage>('image_stash', bytes, {
    headers: { 'x-tudouni-key': String(Number(key)) },
  });
}
