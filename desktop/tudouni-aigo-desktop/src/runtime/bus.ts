/**
 * The runtime junction box.
 *
 * The runtime is a separate process per session and this is its client, so this
 * module exposes exactly two actions — `send` and `subscribe` — and no runtime
 * state whatsoever. Swapping the transport (Tauri IPC today, anything else
 * tomorrow) does not move a single line above it.
 *
 * **It holds a registry, not one runtime.** With one session this was a single
 * slot; with several, "the runtime" is not a thing a module-level variable can
 * name. Each session gets its own `Runtime` handle, and the key is what says
 * which one a message goes to. Keeping the handle in the registry rather than
 * passing a key into every call means "which conversation am I talking to" is
 * decided where the handle was obtained, and the components never see a key at
 * all.
 */

import type { FrontendMsg, RuntimeMsg } from '@/protocol/types';

export interface Runtime {
  /** The bridge's key for this session's child. Stable for its whole life. */
  readonly key: string;
  send(msg: FrontendMsg): void;
  subscribe(cb: (msg: RuntimeMsg) => void): () => void;
  dispose(): void;
}

const registry = new Map<string, Runtime>();

export function registerRuntime(rt: Runtime): void {
  registry.set(rt.key, rt);
}

export function unregisterRuntime(key: string): void {
  registry.delete(key);
}

export function getRuntime(key: string): Runtime | null {
  return registry.get(key) ?? null;
}

/** Every key with a live handle, for the shutdown paths. */
export function runtimeKeys(): string[] {
  return [...registry.keys()];
}

/**
 * The one outbound door, addressed.
 *
 * A message sent to a key with no runtime is dropped here; that is the same
 * contract as before — the "booting" phase on screen is what covers the window
 * between a session being requested and its child answering — and it is also
 * what a send races with a shutdown.
 */
export function sendTo(key: string, msg: FrontendMsg): void {
  const rt = registry.get(key);
  if (!rt) return;
  rt.send(msg);
}
