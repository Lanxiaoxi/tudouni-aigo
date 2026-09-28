/**
 * The runtime junction box.
 *
 * The runtime is a separate process and this is its client, so this module
 * exposes exactly two actions — `send` and `subscribe` — and no runtime state
 * whatsoever. Swapping the transport (Tauri IPC today, anything else tomorrow)
 * does not move a single line above it.
 */

import type { FrontendMsg, RuntimeMsg } from '@/protocol/types';

export interface Runtime {
  send(msg: FrontendMsg): void;
  subscribe(cb: (msg: RuntimeMsg) => void): () => void;
  dispose(): void;
}

let current: Runtime | null = null;

export function setRuntime(rt: Runtime | null): void {
  current = rt;
}

export function getRuntime(): Runtime | null {
  return current;
}

/**
 * The one outbound door.
 *
 * A message sent before the runtime is up is dropped here; the "booting" phase
 * on screen is what covers that window.
 */
export function send(msg: FrontendMsg): void {
  if (!current) return;
  current.send(msg);
}
