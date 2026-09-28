/**
 * 运行时接线盒。
 *
 * desktop-ui-spec.md §0 前提 1：运行时是独立进程，前端是客户端。
 * 这里刻意只暴露 send/subscribe 两个动作，不暴露任何运行时内部状态 ——
 * 换成真的 Tauri command / WebSocket / stdio 桥时不改上层。
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

/** 唯一的出站口。运行时未就绪时静默丢弃，由界面上的「启动中」阶段兜底 */
export function send(msg: FrontendMsg): void {
  if (!current) return;
  current.send(msg);
}
