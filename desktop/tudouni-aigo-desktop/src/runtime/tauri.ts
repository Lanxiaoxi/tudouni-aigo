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
// The panel's own shapes for the two configuration files, which the Rust side
// produces (`src-tauri/src/config_file.rs`). Imported as types only: the rules
// that go with them live in that module, and this file is the bridge, not a
// second place that decides what a route may hold.
import type { ConfigDocument, ConfigPatch } from './userConfig';

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

  /**
   * Lines a live sink is waiting for, held until the frame they will be drawn in.
   *
   * **Why hold them at all.** A streaming turn's deltas arrive as one IPC event
   * each, and delivering each into the store as it lands gives each delta its
   * own React render — so a fast stream cost one render per line, and on a long
   * conversation that is the "the thinking counter falls behind" report. Holding
   * each line until the next frame and releasing a session's whole queue in one
   * synchronous pass leaves the reducer's semantics untouched (messages are
   * still applied in arrival order, one after the other, each seeing the state
   * the previous one left) while React's automatic batching collapses the
   * releases into a single render per frame.
   *
   * The release is scheduled three ways, and which one runs is load-bearing:
   *
   *   - **Visible**: `requestAnimationFrame`, so the work lands with the frame
   *     that will paint it — with a 32 ms task behind it, because a frame can be
   *     requested from a window that is not being presented and never arrive
   *     (see `scheduleFlush`).
   *   - **Hidden**: a 16 ms task. A hidden WebView never paints, and rAF never
   *     fires there — a stream running behind a minimized window would queue
   *     for as long as it stays hidden if rAF alone carried this.
   *   - **No window at all** (the Node test harness): a plain task.
   *     `setTimeout(…, 0)` lands within the first macrotask after the lines
   *     arrive, which is the await the attach-race test already uses to let a
   *     delivery settle.
   */
  private frameLines = new Map<string, RuntimeMsg[]>();
  private flushScheduled = false;
  private frameHandle: number | null = null;
  private taskHandle: ReturnType<typeof setTimeout> | null = null;

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
    if (!sink) {
      this.pendingLines.set(key, [...(this.pendingLines.get(key) ?? []), msg]);
      return;
    }
    // The sink exists, so this line's only question is *when* it is applied —
    // and the answer is "with its frame", not "now". See `frameLines`.
    const held = this.frameLines.get(key);
    if (held) held.push(msg);
    else this.frameLines.set(key, [msg]);
    this.scheduleFlush();
  }

  /**
   * Arm the release of held lines, once. Idempotent across the lines of one
   * frame: every delivery during the wait lands in the same queues, and the
   * single release that was scheduled carries them all.
   */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    if (typeof document !== 'undefined' && document.hidden) {
      this.taskHandle = setTimeout(() => this.flushHeldLines(), 16);
    } else if (typeof requestAnimationFrame === 'function') {
      this.frameHandle = requestAnimationFrame(() => this.flushHeldLines());
      // **A frame is not guaranteed to arrive, and that is not a hypothetical.**
      // The main window is created hidden and stays hidden until the front end
      // says its first screen is drawn — so the very lines that *make* it
      // ready are held waiting for a frame. WebView2 is happy to accept a
      // `requestAnimationFrame` from a window that has never been shown and
      // never call it back, while `document.hidden` still reads `false` (the
      // page is not "hidden", merely in a window nobody can see), so the branch
      // above does not catch it either. The result was a launch that never
      // finished booting: `init` sat in this queue, `ready` never became true,
      // and the splash had nothing to hand over to until the window was
      // revealed some other way (the tray, or the 20 s deadline) — at which
      // point the accumulated lines flushed and everything looked fine.
      //
      // A task after one frame's worth of time is the backstop: if the frame
      // has run, `flushScheduled` is already down and this finds nothing to do;
      // if it has not, the lines are delivered a few milliseconds late rather
      // than indefinitely. The frame is still tried first, because landing with
      // the paint is the whole reason the queue exists.
      const frame = this.frameHandle;
      this.taskHandle = setTimeout(() => {
        if (this.frameHandle === frame) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
          this.flushHeldLines();
        }
      }, 32);
    } else {
      this.taskHandle = setTimeout(() => this.flushHeldLines(), 0);
    }
  }

  /**
   * Release every held line, in arrival order per key.
   *
   * The flag goes down **before** the pass: the pass itself cannot schedule a
   * release (lines only ever arrive from the bridge's events, never from within
   * `emit`), but the next event after it must be free to arm a new one.
   *
   * A key whose sink vanished while its lines waited is dropped, not rerouted:
   * `detach` clears the pending maps on purpose, and a stale key is never
   * reused, so the only thing rerouting would do is resurrect a queue for a
   * session that is gone.
   */
  private flushHeldLines(): void {
    this.flushScheduled = false;
    this.frameHandle = null;
    this.taskHandle = null;
    if (this.frameLines.size === 0) return;
    const held = this.frameLines;
    this.frameLines = new Map();
    for (const [key, msgs] of held) {
      const sink = this.sinks.get(key);
      if (!sink) continue;
      for (const msg of msgs) sink.emit(msg);
    }
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
    // The same for lines held for this frame. The release would skip them (the
    // sink lookup misses), but deleting here keeps the queue from outliving the
    // session it was held for.
    this.frameLines.delete(key);
  }

  dispose(): void {
    this.disposed = true;
    this.sinks.clear();
    this.pendingLines.clear();
    this.pendingStderr.clear();
    this.frameLines.clear();
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    if (this.taskHandle !== null) clearTimeout(this.taskHandle);
    this.frameHandle = null;
    this.taskHandle = null;
    this.flushScheduled = false;
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
  /** `--model <id>`: the model this workspace last used, as the desktop
   *  remembers it. A **fallback** the runtime applies to a fresh session
   *  only — a session that stored its own choice keeps it, and a name the
   *  runtime's catalogue no longer holds falls back to the configured
   *  default. Absent (or empty) means nothing was remembered. */
  model?: string;
  /** `--effort <level>`, remembered together with the model. Applied on
   *  the same terms: fresh sessions only, and only when the model takes
   *  the level. */
  effort?: string;
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
 * The version of the runtime running on **one remote child's host**.
 *
 * The per-session counterpart of `readRuntimeVersion`, and it has to be per
 * session: the window-level call reads the binary next to this application, and
 * on a remote screen that is a different build from the one answering the
 * conversation. Audit showed both facts side by side, so the version line
 * contradicted the `protocol` line exactly when somebody was reading them to
 * work out why something did not take effect.
 *
 * Addressed by the child key, not by a path: the Rust side takes the destination
 * and the binary from the bridge, the same rule the paste and the deliverable
 * download follow.
 *
 * `null` is "the host did not answer" — a refusal, a missing binary, a host that
 * has gone away. The panel draws "unknown" for it, which is honest, where an
 * error would suggest the session itself is broken.
 */
export async function readRemoteRuntimeVersion(key: string): Promise<string | null> {
  if (!isHosted()) return null;
  const target = bridgeKey(key);
  if (target === null) return null;
  try {
    return await tauriInvoke<string | null>('remote_runtime_version', { key: target });
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
      // The same guard the shutting-down commands use. A handle is only minted
      // for a key the bridge returned, so this should always pass — but
      // `Number('failed-…')` is `NaN` and `JSON.stringify` turns that into
      // `null`, which would be rejected by Rust's `ChildKey` and then vanish
      // into the `catch` below. A message that never left is not something
      // `runtime://exited` can explain.
      const target = bridgeKey(key);
      if (target === null) return;
      void tauriInvoke('runtime_send', { key: target, line: JSON.stringify(msg) }).catch(
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
      model: options.model ?? null,
      effort: options.effort ?? null,
    },
  });
  return String(key);
}

/** Mirror the launch arguments of a session that just opened, for the next
 *  launch's pre-spawn (`launch::pre_spawn` on the Rust side reads
 *  `~/.tudouni/desktop-launch.json` and starts that runtime while the WebView
 *  is still booting; the first `runtime_attach` of the next launch adopts it).
 *
 *  Fire-and-forget on purpose: the mirror can only help a launch that has not
 *  happened yet, so a failed write has nothing to say to the session that
 *  caused it — and a caller that had to handle the error would be tempted to
 *  show it. The arguments are the *resolved* ones, the same values the attach
 *  sent, so the next launch's speculative child and its first real attach
 *  describe one session rather than two. */
export function mirrorLaunchPrefs(launch: {
  workspace: string;
  ericai: boolean;
  maxSteps: number | null;
  stream: boolean;
  model: string | null;
  effort: string | null;
}): void {
  if (!isHosted()) return;
  void tauriInvoke('runtime_pref_mirror', { pref: launch }).catch(() => undefined);
}

/** What `attachRuntimeRemote` sends across — the camelCase mirror of the
 *  Rust side's `RemoteAttachOptions`, one field at a time rather than a
 *  passthrough object, for the same reason `attachRuntime` above spells
 *  each one out: a field silently dropped from an object literal is a typo
 *  nothing catches, while a missing argument to a typed function is one
 *  tsc catches on every build. */
export interface RemoteAttachOptions {
  host: string;
  port: number;
  user: string;
  identityFiles: string[];
  password: string | null;
  remoteBinary: string;
  remoteWorkspace: string;
  sessionId?: string;
  maxSteps?: number;
  stream?: boolean;
  autopilot?: boolean;
  ericai?: boolean;
  /** `--model <id>`: the workspace's remembered model, as on the local path.
   *  The runtime **on the remote host** validates it against **that** host's
   *  catalogue, which is a different file — a name unknown there simply
   *  falls back to the configured default, the same rule as locally. */
  model?: string;
  /** `--effort <level>`, on the same terms as `model`. */
  effort?: string;
  /** Milliseconds for the TCP connect + SSH handshake + authentication,
   *  together. `undefined` means the Rust side's own default (15s). */
  connectTimeoutMs?: number;
}

/**
 * Starts the runtime on a remote host over SSH (`runtime_attach_remote`),
 * the Remote Backend's one entry point from this front end — see
 * `ssh_backend.rs`'s module doc on the Rust side for everything downstream
 * of the key this returns: it is the same bridge, the same
 * `runtime://line` / `runtime://stderr` / `runtime://exited` events, and the
 * same `createTauriRuntime` handle `attachRuntime` already uses.
 *
 * Outside a Tauri host there is no bridge to start anything, and `null` is
 * returned so a caller can tell "no runtime" from "a runtime with a key" —
 * same convention as `attachRuntime`.
 */
export async function attachRuntimeRemote(
  options: RemoteAttachOptions,
): Promise<string | null> {
  if (!isHosted()) return null;
  const key = await tauriInvoke<number>('runtime_attach_remote', {
    options: {
      host: options.host,
      port: options.port,
      user: options.user,
      identityFiles: options.identityFiles,
      password: options.password,
      remoteBinary: options.remoteBinary,
      remoteWorkspace: options.remoteWorkspace,
      sessionId: options.sessionId ?? null,
      maxSteps: options.maxSteps ?? null,
      stream: options.stream ?? true,
      autopilot: options.autopilot ?? null,
      ericai: options.ericai ?? null,
      model: options.model ?? null,
      effort: options.effort ?? null,
      connectTimeoutMs: options.connectTimeoutMs ?? null,
    },
  });
  return String(key);
}

/** What `installRemoteRuntime` sends across — the camelCase mirror of the
 *  Rust side's `InstallRemoteOptions`. */
export interface InstallRemoteOptions {
  host: string;
  port: number;
  user: string;
  identityFiles: string[];
  password: string | null;
  connectTimeoutMs?: number;
  /** The version this install should be recorded under — the desktop
   *  app's own build version (`getVersion()` from `@tauri-apps/api/app`,
   *  read by the caller), not resolved on the Rust side: that side has no
   *  more direct a way to know its own version string than this one does. */
  version: string;
}

/** One step of a remote install's progress, carried by
 *  `remote-install://progress` — see `ssh_backend::InstallStage` on the
 *  Rust side for what each stage name means. */
export type InstallStage =
  | 'detecting_platform'
  | 'checking_existing_install'
  | 'preparing_staging'
  | 'uploading'
  | 'verifying_and_switching'
  | 'done';

export interface InstallProgressEvent {
  requestId: string;
  stage: InstallStage;
  uploadedEntries: number;
  totalEntries: number;
}

/**
 * Installs or upgrades the Runtime on a remote host over SSH
 * (`install_remote_runtime`) — the Remote Bootstrapper's one entry point
 * from this front end (§3.5, §8 of the design).
 *
 * Progress is reported through `onInstallProgress`, keyed by `requestId`
 * (a caller-chosen correlation id, not a session key — an install can
 * happen before any session exists for the workspace it is about to make
 * usable). Subscribe to that **before** calling this, or the earliest
 * progress events may be missed; `attachRuntime`'s own queueing exists for
 * exactly this ordering problem, but an install is a plain Tauri event
 * rather than a queued child line, so there is no equivalent buffer here.
 *
 * Resolves to the absolute path of the installed binary on success — what
 * a subsequent `attachRuntimeRemote` call should pass as `remoteBinary`.
 * Outside a Tauri host there is nothing to install, and this rejects
 * rather than silently resolving: unlike `attachRuntime`'s "no bridge, no
 * key" convention, an install that appears to succeed while doing nothing
 * would leave a caller believing a remote host now has a working Runtime
 * when it does not.
 */
export async function installRemoteRuntime(
  requestId: string,
  options: InstallRemoteOptions,
): Promise<string> {
  if (!isHosted()) {
    throw new Error('cannot install a remote runtime outside the desktop app');
  }
  return await tauriInvoke<string>('install_remote_runtime', {
    requestId,
    options: {
      host: options.host,
      port: options.port,
      user: options.user,
      identityFiles: options.identityFiles,
      password: options.password,
      connectTimeoutMs: options.connectTimeoutMs ?? null,
      version: options.version,
    },
  });
}

/** Subscribes to every remote install's progress events. Returns the
 *  unsubscribe function. A caller that only cares about one `requestId`
 *  filters inside `cb` — events are not split per-request on this side,
 *  the same way `onCloseRequested` and the runtime's own line events are
 *  one shared stream rather than one subscription per session. */
export function onInstallProgress(cb: (event: InstallProgressEvent) => void): () => void {
  let unlisten: (() => void) | null = null;
  let stopped = false;
  void (async () => {
    if (!isHosted()) return;
    try {
      const off = await tauriListen<InstallProgressEvent>('remote-install://progress', cb);
      if (stopped) off();
      else unlisten = off;
    } catch {
      /* Not hosted, or the capability is missing; nothing to listen to. */
    }
  })();
  return () => {
    stopped = true;
    unlisten?.();
  };
}

/**
 * This desktop app's own build version, for `installRemoteRuntime`'s
 * `version` field — the string a remote install is recorded under
 * (`~/.tudouni/runtime/<version>/`).
 *
 * `'0.0.0'` outside a Tauri host: there is no app to ask, and no install to
 * attempt either, so the fallback value is never actually sent anywhere —
 * `installRemoteRuntime` itself refuses outside a host before this would
 * matter.
 */
export async function getAppVersion(): Promise<string> {
  if (!isHosted()) return '0.0.0';
  const mod = await import('@tauri-apps/api/app');
  return mod.getVersion();
}

/* ============================================================
   Config sync (Phase 4, §9)
   ============================================================ */

/** The SSH destination `check_remote_config`/`writeRemoteConfig` connect
 *  to — the same shape `RemoteAttachOptions` carries, minus the
 *  runtime-specific fields that call has no use for. */
export interface RemoteConfigTarget {
  host: string;
  port: number;
  user: string;
  identityFiles: string[];
  password: string | null;
  connectTimeoutMs?: number;
}

/** The remote account's `~/.tudouni/config.json` state, per §9.3. */
export type RemoteConfigStatus = 'missing' | 'empty_template' | 'no_usable_route' | 'valid' | 'corrupt';

export interface RemoteConfigInspection {
  status: RemoteConfigStatus;
  /** Hex SHA256 of the file's bytes; empty when `status === 'missing'`. */
  fingerprint: string;
  /** Set only when `status === 'corrupt'`. */
  error: string | null;
}

/** Reads and classifies the remote account's config.json, without writing
 *  anything — the one call a `configPolicy` of `'ask'` needs before it can
 *  draw a choice. */
export async function checkRemoteConfig(target: RemoteConfigTarget): Promise<RemoteConfigInspection> {
  return await tauriInvoke<RemoteConfigInspection>('check_remote_config', { target });
}

/** Writes `contents` (the whole file, as text) to the remote account's
 *  config.json — a temp file, a backup of whatever was there, then an
 *  atomic rename into place (§9.6). Returns the new fingerprint, which the
 *  caller should record as the sync baseline. */
export async function writeRemoteConfig(target: RemoteConfigTarget, contents: string): Promise<string> {
  return await tauriInvoke<string>('write_remote_config', { target, contents });
}

/** The local config.json's raw text and its fingerprint, or `null` when the
 *  file does not exist yet. */
export interface LocalConfigText {
  text: string;
  fingerprint: string;
}

/** Reads the local config.json as plain text, alongside its fingerprint —
 *  the one piece `checkConfigSync` (in the store) needs that the structured
 *  `readUserConfig`/`ConfigDocument` shape cannot give exactly: the literal
 *  bytes a sync comparison and a `'sync-local'` upload both need. */
export async function readLocalConfigText(): Promise<LocalConfigText | null> {
  if (!isHosted()) return null;
  try {
    return await tauriInvoke<LocalConfigText | null>('read_local_config_text');
  } catch {
    return null;
  }
}

/** The desktop's user data, as the text of `~/.tudouni/desktop.json`.
 *  `null` when the file does not exist yet (a first launch). */
export async function readDesktopData(): Promise<string | null> {
  if (!isHosted()) return null;
  try {
    return await tauriInvoke<string | null>('desktop_data_read');
  } catch {
    return null;
  }
}

/** Replace `~/.tudouni/desktop.json`, atomically on the Rust side.
 *  Resolves to the text it wrote; rejects when the write refused. */
export async function writeDesktopData(text: string): Promise<string> {
  await tauriInvoke<null>('desktop_data_write', { text });
  return text;
}

/** Tell the bridge the front end is listening, so it flushes everything every
 *  child queued before that was true. Returns how many lines were released.
 *
 *  **A rejection is left as a rejection**, unlike the readers above. Zero is
 *  also the legitimate answer ("nothing was queued"), so swallowing the error
 *  would make the one unrecoverable failure — the bridge never heard the
 *  announcement and therefore queues every future line for ever — look exactly
 *  like a quiet start. The caller is the only place that can say so. */
export async function attachRuntimeListener(): Promise<number> {
  if (!isHosted()) return 0;
  return await tauriInvoke<number>('runtime_attach_listener');
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

/* ============================================================
   The notification click
   ============================================================ */

/**
 * What the bridge says when somebody clicks a system notification.
 *
 * Paired with `notify_send` and `notify://activated` in
 * `src-tauri/src/lib.rs`, which is where the toast and its activation callback
 * live. The three fields are the ones the notification was sent *about*, echoed
 * back verbatim — the bridge does not conclude anything from them, because the
 * only thing that can say whether that session still exists is the store.
 */
export interface NotifyActivated {
  /** The bridge's child key, as a decimal string. May name a session that has
   *  since been closed — see `notifyDestination`. */
  key: string;
  /** The runtime's session id, empty if the handshake had not landed. */
  sessionId: string;
  /** The workspace the session was in, for reopening it. */
  workspace: string;
}

/**
 * Listen for a click on a system notification.
 *
 * **Windows only in practice, and that is not a defect here.** The event is
 * emitted by the Rust side, and only the Windows delivery path can produce one:
 * `tauri-plugin-notification` reports no activation on the desktop, and the two
 * desktop platforms that keep using it would need a mechanism of their own
 * (macOS an application delegate, Linux a D-Bus default action). So in a plain
 * browser, and on a platform whose toast cannot report a click, this simply never
 * fires — which costs nothing, because the click was never offered.
 *
 * Returns the unsubscribe function, with the same promise race handled the same
 * way as `onCloseRequested`: `listen` is async, so the caller may unmount while
 * the subscription is in flight, and dropping the handle there would leak a
 * listener that outlives its component.
 */
export function onNotifyActivated(cb: (activated: NotifyActivated) => void): () => void {
  let unlisten: (() => void) | null = null;
  let stopped = false;
  void (async () => {
    if (!isHosted()) return;
    try {
      const mod = await import('@tauri-apps/api/event');
      const off = await mod.listen<NotifyActivated>('notify://activated', (event) =>
        cb(event.payload),
      );
      if (stopped) off();
      else unlisten = off;
    } catch {
      // Not hosted, or the capability is missing. Nothing to fall back to and
      // nothing to report: no click will arrive, and the notification itself was
      // never the only way to notice the session.
    }
  })();
  return () => {
    stopped = true;
    unlisten?.();
    unlisten = null;
  };
}

/* ============================================================
   The tray menu's session commands
   ============================================================ */

/** What the tray menu can ask the front end to do. */
export type TrayAction = 'new-session' | 'open-board';

/**
 * What the bridge says when somebody clicks a session act in the tray menu.
 *
 * Paired with `tray://command` in `src-tauri/src/lib.rs`, which shows the
 * window first and then emits this — so by the time the front end reads it the
 * window is already back, and the only thing left to decide is the act itself.
 * That decision is deliberately not the bridge's: the board's gate and the
 * modal guard are the store's selectors, and repeating them here would be a
 * second copy that could drift.
 */
export interface TrayCommand {
  action: TrayAction;
}

/**
 * Listen for a session act clicked in the tray menu.
 *
 * Returns the unsubscribe function, with the same promise race handled the
 * same way as `onNotifyActivated`: `listen` is async, so the caller may
 * unmount while the subscription is in flight, and dropping the handle there
 * would leak a listener. In a plain browser the tray does not exist, so this
 * simply never fires.
 */
export function onTrayCommand(cb: (command: TrayCommand) => void): () => void {
  let unlisten: (() => void) | null = null;
  let stopped = false;
  void (async () => {
    if (!isHosted()) return;
    try {
      const mod = await import('@tauri-apps/api/event');
      const off = await mod.listen<TrayCommand>('tray://command', (event) => cb(event.payload));
      if (stopped) off();
      else unlisten = off;
    } catch {
      // Not hosted, or the capability is missing. Nothing to fall back to: the
      // tray menu was never the only way to reach either act.
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
  const target = bridgeKey(key);
  if (target === null) return [];
  try {
    return await tauriInvoke<string[]>('runtime_stderr', { key: target });
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

/**
 * The user's `~/.ssh/config`, as the Add Remote Workspace form's host
 * picker needs it.
 *
 * **Prefill data, not a claim about reachability.** Reading the file makes
 * no connection and checks nothing: a listed host may be down, may need a
 * password, and may even be unselectable (a `refused` reason) because the
 * Go side's own dial rules reject a field it names. The form treats every
 * filled field as an editable suggestion — Save validates, and the actual
 * connection answers when the row is opened.
 *
 * `null` when not hosted (a plain browser): the form then simply has
 * nothing to offer and its manual fields work as before, which is the same
 * "no bridge, no list" convention as the other reads here.
 */
export interface SshConfigHost {
  /** The pattern the `Host` block wrote, verbatim. */
  alias: string;
  /** The resolved destination the form's Host field is filled with. */
  hostname: string;
  port: number;
  user: string;
  identityFiles: string[];
  /** The block sets a `Password` directive; the value is not returned. */
  hasPassword: boolean;
  /** Why this block is listed but not selectable, when it is. */
  refused: string | null;
}

export interface SshConfigDocument {
  /** The file this was read from, for the picker's caption. */
  path: string;
  /** `false` when there was no file at all — an ordinary state, not an error. */
  exists: boolean;
  hosts: SshConfigHost[];
  /** Why the file was read but its hosts cannot be trusted (a `Match`
   *  block, an unreadable file). `null` in every other case. */
  problem: string | null;
}

export async function readSshConfig(): Promise<SshConfigDocument | null> {
  if (!isHosted()) return null;
  try {
    return await tauriInvoke<SshConfigDocument>('read_ssh_config');
  } catch {
    return null;
  }
}

/** What `appendSshHost` writes: one `Host` block's fields. */
export interface AppendSshHostOptions {
  alias: string;
  hostname: string;
  port: number;
  user: string;
  identityFiles: string[];
}

/**
 * Add one `Host` block to the user's own `~/.ssh/config`, returning the file's
 * path.
 *
 * This is what "configure a host here" means in this application:
 * `~/.ssh/config` is the **one** place a host is configured — the Go side reads
 * the same file, and so does the person's own `ssh` — so a host added here is
 * written there rather than into a private list only this program can see.
 *
 * Never writes a password: `Password` is this project's own extension rather
 * than an OpenSSH keyword, and writing it would break the person's `ssh` with
 * `Bad configuration option: password` on every connection. Use
 * `attachRuntimeRemote`'s own `password` field for a host that needs one.
 *
 * Rejects with a sentence when the alias already exists, when the file carries
 * a `Match` block, or when the write fails.
 */
export async function appendSshHost(options: AppendSshHostOptions): Promise<string> {
  if (!isHosted()) {
    throw new Error('adding a host to ~/.ssh/config needs the desktop app');
  }
  return await tauriInvoke<string>('append_ssh_host', { options });
}

/* ============================================================
   The connection step of "add a remote workspace"
   ============================================================ */

/** One directory a remote host offers as a possible workspace. */
export interface RemoteDirEntry {
  /** The directory's own name, for the row. */
  name: string;
  /** Its absolute path — what choosing it actually means. */
  path: string;
}

/** Everything `probeRemoteHost` reports about a host it just connected to.
 *  Every field is an answer from the far end; none of it is inferred here. */
export interface RemoteProbe {
  /** The remote account's `$HOME`, the root the browser starts at. */
  home: string;
  /** The directory this reply describes, after resolving symlinks. */
  path: string;
  /** The parent directory, or `null` at the filesystem root. */
  parent: string | null;
  /** `"linux"`, `"windows"`, or `"unknown"`. */
  os: string;
  arch: string;
  /** Whether this program publishes a Runtime for that platform. */
  supported: boolean;
  /** Why not, when it does not — the Rust side's own sentence, shown as given. */
  platformProblem: string | null;
  /** The installed Runtime's absolute path, when one is already there. */
  runtimeBinary: string | null;
  /** The version `CurrentLink` points at, when it points at one. */
  runtimeVersion: string | null;
  /** `~/.tudouni/config.json`'s state on the remote account. */
  configStatus: RemoteConfigStatus;
  /** Why the listed directory cannot itself be a workspace, when it cannot. */
  workspaceProblem: string | null;
  /** The directories inside `path`, sorted, dot-directories omitted. */
  entries: RemoteDirEntry[];
}

/** The SSH destination these three calls connect to — the same shape
 *  `RemoteConfigTarget` carries, since they are all the same question asked of
 *  the same server. */
export interface RemoteProbeTarget {
  host: string;
  port: number;
  user: string;
  identityFiles: string[];
  password: string | null;
  connectTimeoutMs?: number;
}

function probeTargetWire(target: RemoteProbeTarget) {
  return {
    host: target.host,
    port: target.port,
    user: target.user,
    identityFiles: target.identityFiles,
    password: target.password,
    connectTimeoutMs: target.connectTimeoutMs ?? null,
  };
}

/**
 * Connect to a host and report what is on the other end — the **first** step of
 * adding a remote workspace, and the reason the flow no longer begins with a
 * long form: everything this answers is something only the far end knows, so
 * asking a person to type it would be asking them to guess.
 *
 * It writes nothing and installs nothing. `path` omitted or empty means the
 * account's home directory, which is where the browser starts.
 *
 * Rejects (rather than resolving a null) when the connection fails: a probe
 * that could not connect is the subject of the step, not a background detail,
 * and the caller has a sentence to show for it.
 */
export async function probeRemoteHost(
  target: RemoteProbeTarget,
  path?: string,
): Promise<RemoteProbe> {
  if (!isHosted()) {
    throw new Error('connecting to a remote host needs the desktop app');
  }
  return await tauriInvoke<RemoteProbe>('probe_remote_host', {
    target: probeTargetWire(target),
    path: path ?? null,
  });
}

/** One directory the person just navigated to over the probe's connection.
 *  Only the listing changed by the click — the host's facts (platform,
 *  runtime, config) are the first probe's and do not repeat here. */
export interface RemoteBrowse {
  /** The directory this reply describes, after resolving symlinks. */
  path: string;
  /** The parent directory, or `null` at the filesystem root. */
  parent: string | null;
  /** Why the listed directory cannot itself be a workspace, when it cannot. */
  workspaceProblem: string | null;
  /** The directories inside `path`, sorted, dot-directories omitted. */
  entries: RemoteDirEntry[];
}

/**
 * List one directory on a host the wizard has already probed — the browser's
 * "open a folder" and "up" clicks.
 *
 * It answers only the listing: re-asking the host what it is (platform,
 * runtime, config) is what used to make every click cost a full reconnect,
 * and none of those facts change while a person is choosing a directory.
 * The caller keeps its `RemoteProbe` for those and swaps this listing in.
 */
export async function browseRemoteDirectory(
  target: RemoteProbeTarget,
  path?: string,
): Promise<RemoteBrowse> {
  if (!isHosted()) {
    throw new Error('listing a remote directory needs the desktop app');
  }
  return await tauriInvoke<RemoteBrowse>('browse_remote_dir', {
    target: probeTargetWire(target),
    path: path ?? null,
  });
}

/**
 * Create one directory on a remote host — the wizard's "new folder".
 *
 * A separate call from `probeRemoteHost` on purpose: looking around a host must
 * not be able to leave anything behind on it. Resolves to the directory's
 * absolute path, which is what the caller then lists.
 */
export async function createRemoteDirectory(
  target: RemoteProbeTarget,
  path: string,
): Promise<string> {
  if (!isHosted()) {
    throw new Error('creating a remote directory needs the desktop app');
  }
  return await tauriInvoke<string>('create_remote_directory', {
    target: probeTargetWire(target),
    path,
  });
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
 * A file picker — the plus menu's "浏览" entry. Null when the person cancels or
 * the host refuses (not hosted, missing permission), and the caller says
 * nothing in the null case: a cancelled dialog is not an event worth a sentence.
 *
 * `directory: false` is the default and stated anyway, to be the visible
 * counterpart of `chooseWorkspaceDirectory` above: the two pickers differ by
 * exactly this flag and sit next to each other so it stays that way.
 */
export async function chooseAttachmentFile(): Promise<string | null> {
  if (!isHosted()) return null;
  try {
    const mod = await import('@tauri-apps/plugin-dialog');
    const picked = await mod.open({ directory: false, multiple: false });
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

/**
 * Read the configuration files the config panel edits.
 *
 * **Rust does the reading, not this end**, even though `tauri-plugin-fs` is in
 * the dependency tree. The file has to be *merged* — a save sets the keys the
 * form owns and leaves everything else byte-equivalent — and a merge written in
 * Rust is one implementation instead of two, next to the atomic write it has to
 * agree with. It also means the WebView never needs filesystem permission to a
 * file full of API keys, which is the narrower capability.
 *
 * A failure here is returned as `null` rather than thrown: the panel's job with
 * it is to say that the files could not be read at all, and an exception would
 * land in an error boundary with nothing to say about which of the two was the
 * problem.
 */
export async function readUserConfig(): Promise<ConfigDocument | null> {
  if (!isHosted()) return null;
  try {
    return await tauriInvoke<ConfigDocument>('config_read');
  } catch {
    return null;
  }
}

/** One cross-session search hit: the session and the line of evidence. */
export interface SessionSearchHit {
  /** The runtime's own session id — the same name the saved list carries. */
  sessionId: string;
  /** The matched message, folded and cut around the hit. The proof the row is there. */
  snippet: string;
  /** Epoch seconds, or null when the file's mtime could not be stated. */
  modifiedAt: number | null;
}

/**
 * Search the workspace's saved sessions for a keyword.
 *
 * **The host answers, not a runtime child.** The session files belong to the
 * workspace, and a child only knows its own — so a search that spans "the
 * sessions I can see" is asked of the host process, which is always present
 * and belongs to no session. The scan is read-only and never needs a live
 * child: that is what makes the button work in a workspace with nothing open.
 *
 * A failure is returned as `null` rather than thrown: the rail's job with it
 * is to say nothing matched or that the search could not run, and an exception
 * would land in an error boundary with nothing to say about which.
 */
export async function searchSessions(workspace: string, query: string): Promise<SessionSearchHit[] | null> {
  if (!isHosted()) return null;
  try {
    return await tauriInvoke<SessionSearchHit[]>('sessions_search', { workspace, query });
  } catch {
    return null;
  }
}

/**
 * Apply one save, and get the files back as they are **afterwards**.
 *
 * The reply is a re-read rather than the patch echoed back, so what the panel
 * draws next is the file's own content — the same rule the settings panel
 * follows when it shows the argv a child was actually given. For that reason a
 * successful save **must** be applied from the reply: keeping the draft would
 * leave the screen showing a value that is not what the runtime will read.
 *
 * The error is propagated rather than swallowed. Every refusal here is a reason
 * nothing was written, and a save that silently did nothing is the one outcome
 * this feature can least afford — the person would believe their key is in the
 * file.
 */
export async function writeUserConfig(patch: ConfigPatch): Promise<ConfigDocument> {
  return tauriInvoke<ConfigDocument>('config_write', { patch });
}

/* ---- the same panel, on the far host ---- */

/**
 * Read a **remote** account's `config.json` + `mcp.json`, in the panel's shape.
 *
 * The panel edits "the config file", and on both machines that file is
 * `~/.tudouni/config.json` — one string that names two different files. Reading
 * it from this machine while a remote session is on screen is the bug this pair
 * of calls fixes: the panel showed this machine's routes and the runtime kept
 * using the host's, so an edit looked applied and did nothing.
 *
 * The `target` is built by the caller from the saved host, because that layer is
 * where the credentials live (`remoteConnectionOf` deliberately carries none).
 */
export async function readRemoteUserConfig(target: RemoteConfigTarget): Promise<ConfigDocument | null> {
  if (!isHosted()) return null;
  try {
    return await tauriInvoke<ConfigDocument>('read_remote_user_config', { target });
  } catch {
    return null;
  }
}

/** What one remote save produced: the document as it now reads, and what was
 *  written. Both fingerprints matter — the sync baseline is a pair (§9.5), and
 *  a save that is not recorded there makes the next open report the person's own
 *  edit as somebody else's change. */
export interface RemoteConfigWriteResult {
  document: ConfigDocument;
  /** Hex SHA256 of the `config.json` written, or null when the patch did not
   *  touch it. */
  configFingerprint: string | null;
  /** The same for `mcp.json`. */
  mcpFingerprint: string | null;
}

/**
 * Apply one save on the far host.
 *
 * The merge happens there, against bytes read over the same SFTP session
 * immediately before the write — so a panel that has been open for ten minutes
 * cannot overwrite what changed in between, on a machine this end cannot watch.
 * Thrown errors are refusals: the Rust side only returns `Err` when nothing was
 * written.
 */
export async function writeRemoteUserConfig(
  target: RemoteConfigTarget,
  patch: ConfigPatch,
): Promise<RemoteConfigWriteResult> {
  return tauriInvoke<RemoteConfigWriteResult>('write_remote_user_config', { target, patch });
}

/**
 * Show one configuration file in the OS file manager.
 *
 * This is the panel's **only** non-form affordance, and it is here for the state
 * the form cannot fix itself: a file that will not parse. The panel shows the
 * sentence explaining what is wrong and refuses to write, and the answer is for
 * the person to open the file — so the way to reach it has to be on the screen
 * next to that sentence.
 *
 * `revealItemInDir` rather than opening it in the default application: the file
 * manager is where somebody decides *which* editor, and handing a file full of
 * API keys to whatever happens to be associated with `.json` is a decision this
 * panel has no business making for them.
 */
export async function revealConfigFile(path: string): Promise<void> {
  if (!isHosted() || path.trim() === '') return;
  try {
    const mod = await import('@tauri-apps/plugin-opener');
    await mod.revealItemInDir(path);
  } catch (err) {
    // Nothing to report and nothing to fall back to: the path is already on
    // screen for anybody who has to type it, and a failure here means the OS
    // refused — which no sentence from this end changes.
    console.warn('could not reveal the configuration file:', err);
  }
}

/**
 * Open one declared deliverable in the OS default application.
 *
 * **Through Rust, not through `openPath` directly.** The plugin's `openPath`
 * takes a path and knows nothing about workspaces, so calling it from here would
 * make this layer the only thing standing between a model-authored path and
 * `explorer.exe`. The `deliverable_open` command re-checks the boundary against
 * the file that is really there, at the moment of the act, and returns a sentence
 * written for the person reading the card.
 *
 * `workspace` is the **runtime's own** answer (`init.workspace`), not something
 * this window assembled: the path is relative to that root, and the two have to
 * be the same fact for the join to mean anything.
 */
export async function openDeliverable(workspace: string, path: string): Promise<void> {
  await tauriInvoke<void>('deliverable_open', { workspace, path });
}

/**
 * Open a file **mentioned in the model's reply text** in the OS default
 * application.
 *
 * Accepts both relative paths (resolved against `workspace`) and absolute
 * paths. The front end has already narrowed the call to an allow-list of
 * extensions, so the trust model is "the user clicked a path the model wrote,
 * and the extension is one we agreed to open." Less strict than
 * {@link openDeliverable}, which guards a *declared* output the runtime vouched
 * for — this guards a string in prose.
 */
export async function openFilePath(workspace: string, path: string): Promise<void> {
  await tauriInvoke<void>('open_file_path', { workspace, path });
}

/** What the bridge hands back after pulling one remote deliverable down. */
export interface DownloadedDeliverable {
  /** The absolute path of the local copy — what the OS is handed and what
   *  the card shows as "the copy is here". */
  path: string;
  /** True when nothing was transferred: the copy was already in the cache
   *  tree, and the sentence on the card should say so rather than claim a
   *  download that did not happen. */
  fromCache: boolean;
}

/**
 * Download one declared deliverable from a **remote** session's workspace
 * into the local cache tree.
 *
 * Named by the session's child key, not by connection parameters: the host,
 * credentials and remote workspace come from the child the bridge started —
 * the same rule `stashImage` follows — so a caller cannot pull a file from a
 * machine the session does not run on.
 *
 * The card's "open" becomes "download" for a remote workspace for one reason:
 * `deliverable_open`'s boundary is a local `canonicalize`, which cannot reach
 * a file on the far host. This command pulls the bytes over, and the OS opens
 * the local copy. A second call for the same file serves the cached copy
 * without re-downloading (`fromCache: true`).
 *
 * Rejections arrive as sentences written for the person reading the card, the
 * same convention as every other bridge refusal.
 */
export async function downloadDeliverable(key: string, path: string): Promise<DownloadedDeliverable> {
  if (!isHosted()) {
    throw new Error('deliverables can only be downloaded in the desktop application');
  }
  const target = bridgeKey(key);
  if (target === null) throw new Error("that session's runtime is not running");
  return tauriInvoke<DownloadedDeliverable>('deliverable_download', { key: target, path });
}

/**
 * Open a **local copy** of a downloaded remote deliverable in the OS default
 * application — the second half of the remote card's gesture.
 *
 * `deliverable_open` cannot be reused for this: its boundary is the workspace
 * root, and the copy lives under the app's own data directory. The Rust
 * command applies the same rule with a different root — canonicalize and
 * require the path to stay under the downloads tree — so a string this window
 * hands back cannot reach anywhere else on disk.
 */
export async function openLocalDeliverable(path: string): Promise<void> {
  if (!isHosted()) {
    throw new Error('deliverables can only be opened in the desktop application');
  }
  await tauriInvoke<void>('deliverable_open_local', { path });
}

/**
 * Read one picture from a **remote** session's workspace as a `data:` URL —
 * the remote twin of {@link inlineImage}, whose boundary is a local
 * `canonicalize` and therefore cannot reach a file on the far host either.
 *
 * Keyed by the session's child for the same reason {@link downloadDeliverable}
 * is: the workspace and the SSH connection are facts the child carries, and
 * neither may arrive from the caller.
 */
export async function inlineImageRemote(key: string, path: string): Promise<InlineImage> {
  if (!isHosted()) {
    throw new Error('pictures can only be drawn in the desktop application');
  }
  const target = bridgeKey(key);
  if (target === null) throw new Error("that session's runtime is not running");
  return tauriInvoke<InlineImage>('inline_image_remote', { key: target, path });
}

/** What the bridge hands back after reading a workspace picture. */
export interface InlineImage {
  /** A complete `data:` URL, ready for an `<img src>`. */
  url: string;
}

/**
 * Read one picture inside the workspace as a `data:` URL, for drawing in the chat.
 *
 * **Through Rust, not through `asset:` or a bare filesystem read.** A WebView
 * cannot load `C:\…\out.png` as an `<img>`, and the `asset:` protocol's scope is a
 * static list decided at build time — it cannot name a workspace nobody has picked
 * yet. It would also turn any model-authored `![](asset://…)` into a read of
 * whatever the scope covers, decided by the renderer instead of by a boundary.
 * The command instead takes the workspace, canonicalizes the target against it,
 * and refuses anything that escapes — the same rule `deliverable_open` applies,
 * for the same reason.
 *
 * `workspace` is the **runtime's own** answer (`init.workspace`), never a path
 * this window assembled: the relative path only means something against that root.
 *
 * A refusal is returned as a rejected promise carrying a sentence written for a
 * person; the caller shows it beside the picture that did not load.
 */
export async function inlineImage(workspace: string, path: string): Promise<InlineImage> {
  if (!isHosted()) {
    throw new Error('pictures can only be drawn in the desktop application');
  }
  return tauriInvoke<InlineImage>('inline_image', { workspace, path });
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
  const target = bridgeKey(key);
  if (target === null) throw new Error("that session's runtime is not running");
  return tauriInvoke<StashedImage>('image_stash', bytes, {
    headers: { 'x-tudouni-key': String(target) },
  });
}

/** One file uploaded into a remote workspace, as the composer needs it back. */
export interface AttachedRemoteFile {
  /** Workspace-relative, forward slashes — the string the sentence carries. */
  path: string;
  /** The file's own name, or its numbered twin when that one was taken. */
  name: string;
  bytes: number;
}

/**
 * Copy one file on **this** machine into a remote session's workspace, and
 * answer with the workspace-relative path.
 *
 * The sibling of `stashImage`, for the other OS entry point: a drop and the
 * native file dialog both hand over a path that only means something here. On a
 * remote screen that path is meaningless to the far runtime — its `SafePath`
 * refuses it, and the far shell cannot see this machine either — so the bytes
 * are uploaded and the sentence names the relative path instead, exactly as a
 * pasted picture does.
 *
 * **The key, not a target.** The host and workspace come from the child the
 * bridge already started; a front end that could name them could upload into a
 * machine the session does not run on. It is also what keeps credentials out of
 * this layer: `remoteConnectionOf` deliberately carries none.
 *
 * Rejections are surfaced: every one of them is a reason the file did not
 * attach, and the caller turns them into the composer's notice.
 */
export async function attachRemoteFile(key: string, localPath: string): Promise<AttachedRemoteFile> {
  if (!isHosted()) {
    throw new Error('remote file attach needs the desktop application');
  }
  const target = bridgeKey(key);
  if (target === null) throw new Error("that session's runtime is not running");
  return tauriInvoke<AttachedRemoteFile>('attach_file_remote', {
    key: target,
    localPath,
  });
}
