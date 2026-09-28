/**
 * 会话流条目模型 + 归约逻辑
 *
 * 对应 desktop-ui-spec.md §2（12 类条目、quiet 两种形态）、§5（流内大屏文本块）。
 * 关键约束：
 *  - 迟到与乱序的消息按 run_id + step 归属，不靠「先来后到」（§9.3）
 *  - 本轮正文有两次出口（流式 delta 与最终 answer），只有 answer 是最终答案（§9.2）
 *  - 拒绝行必须独立成条：与「跑失败了」的处置完全不同（§2）
 */

import type {
  DeltaChannel,
  PermissionDecision,
  RiskLevel,
  RunEndReason,
  RuntimeEvent,
  RuntimeUi,
  StreamBlockKind,
  ToolResultStatus,
} from '@/protocol/types';

/* ============================================================
   条目定义
   ============================================================ */

export interface ToolResultState {
  status: ToolResultStatus;
  chars: number;
  durationMs: number;
  exitCode: number | null;
  preview: string;
}

export type TurnStatus = 'running' | RunEndReason;

export type Entry =
  /** 1. 回合头 */
  | {
      kind: 'turn';
      id: string;
      runId: string;
      turn: number;
      step: number;
      maxSteps: number;
      status: TurnStatus;
    }
  /** 2. 用户输入（本地回显） */
  | { kind: 'user'; id: string; text: string; atMs: number }
  /** 3. 模型步 */
  | {
      kind: 'model';
      id: string;
      runId: string;
      step: number;
      durationMs: number | null;
      inputTokens: number | null;
      cachedTokens: number | null;
      retry: { attempt: number; waitMs: number } | null;
    }
  /** 4. 工具调用（含 5. 结果） */
  | {
      kind: 'tool';
      id: string;
      runId: string;
      step: number;
      index: number;
      tool: string;
      params: string;
      risk: RiskLevel;
      builtin: boolean;
      parallelSafe: boolean;
      occupiesInput: boolean;
      result: ToolResultState | null;
    }
  /** 6. 拒绝行 —— 独立条目 */
  | {
      kind: 'denied';
      id: string;
      runId: string;
      step: number;
      index: number;
      tool: string;
      reason: string;
    }
  /** 7. 并发批次 */
  | { kind: 'batch'; id: string; runId: string; step: number; count: number; wallMs: number }
  /** 8. 权限记录 */
  | {
      kind: 'perm';
      id: string;
      runId: string;
      step: number;
      tool: string;
      decision: PermissionDecision;
      waited: boolean;
      waitedMs: number;
      rule: string | null;
    }
  /** 9. 思考块 */
  | {
      kind: 'reason';
      id: string;
      runId: string;
      step: number;
      text: string;
      streaming: boolean;
    }
  /** 10. 回答块（最终正文） */
  | { kind: 'answer'; id: string; runId: string; text: string }
  /** 11. 流式正文（展示层，非最终答案） */
  | { kind: 'stream'; id: string; runId: string; step: number; text: string; streaming: boolean }
  /** 12. 附加 / 系统行 */
  | {
      kind: 'note';
      id: string;
      tone: 'info' | 'warn' | 'error' | 'degraded' | 'compacted' | 'image';
      key: string | null;
      text: string | null;
      params?: Record<string, string | number>;
    }
  /** §5 流内大屏文本块 */
  | { kind: 'block'; id: string; block: StreamBlockKind; payload: unknown };

/** 工具调用 + 结果的合并键：靠 run_id / step / index 三元组归属 */
function sameCall(e: Entry, runId: string, step: number, index: number): boolean {
  return e.kind === 'tool' && e.runId === runId && e.step === step && e.index === index;
}

/* ============================================================
   ID 生成
   ============================================================ */

let seq = 0;
export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/* ============================================================
   event 归约
   ============================================================ */

export interface ReduceResult {
  entries: Entry[];
  /** run_started / run_finished 之外的消息若返回 stale=true，调用方应丢弃并计数 */
  stale?: boolean;
  /** run_finished 时要写回 activeRunId = null */
  runEnded?: boolean;
}

export function reduceEvent(
  entries: Entry[],
  ev: RuntimeEvent,
  activeRunId: string | null,
): ReduceResult {
  // run_started 永远接受，并成为新的「当前回合」
  if (ev.kind === 'run_started') {
    return {
      entries: [
        ...entries,
        {
          kind: 'turn',
          id: nextId('turn'),
          runId: ev.run_id,
          turn: ev.turn,
          step: ev.step,
          maxSteps: ev.max_steps,
          status: 'running',
        },
      ],
    };
  }

  // 迟到 / 乱序：不属于当前回合的直接丢
  if (activeRunId !== null && ev.run_id !== activeRunId) {
    return { entries, stale: true };
  }

  switch (ev.kind) {
    case 'model_call': {
      return {
        entries: [
          ...entries,
          {
            kind: 'model',
            id: nextId('model'),
            runId: ev.run_id,
            step: ev.step,
            durationMs: ev.duration_ms,
            inputTokens: ev.input_tokens,
            cachedTokens: ev.cached_tokens,
            retry: ev.retry
              ? { attempt: ev.retry.attempt, waitMs: ev.retry.wait_ms }
              : null,
          },
        ],
      };
    }

    case 'tool_call': {
      return {
        entries: [
          ...entries,
          {
            kind: 'tool',
            id: nextId('tool'),
            runId: ev.run_id,
            step: ev.step,
            index: ev.index,
            tool: ev.tool,
            params: ev.params_preview,
            risk: ev.risk,
            builtin: ev.builtin,
            parallelSafe: ev.parallel_safe,
            occupiesInput: ev.occupies_input,
            result: null,
          },
        ],
      };
    }

    case 'tool_result': {
      // 先尝试挂到已有的 tool 条目上
      let attached = false;
      const patched = entries.map((e) => {
        if (!attached && sameCall(e, ev.run_id, ev.step, ev.index)) {
          attached = true;
          return {
            ...(e as Extract<Entry, { kind: 'tool' }>),
            result: {
              status: ev.status,
              chars: ev.chars,
              durationMs: ev.duration_ms,
              exitCode: ev.exit_code,
              preview: ev.preview,
            },
          } satisfies Entry;
        }
        return e;
      });

      // denied 必须独立成条（§2）
      if (ev.status === 'denied') {
        return {
          entries: [
            ...patched,
            {
              kind: 'denied',
              id: nextId('denied'),
              runId: ev.run_id,
              step: ev.step,
              index: ev.index,
              tool: ev.tool,
              reason: ev.preview,
            },
          ],
        };
      }

      if (attached) return { entries: patched };

      // 没找到对应调用（例如前端中途接入），补一条只有结果的条目
      return {
        entries: [
          ...patched,
          {
            kind: 'tool',
            id: nextId('tool'),
            runId: ev.run_id,
            step: ev.step,
            index: ev.index,
            tool: ev.tool,
            params: '',
            risk: 'LOW',
            builtin: true,
            parallelSafe: true,
            occupiesInput: false,
            result: {
              status: ev.status,
              chars: ev.chars,
              durationMs: ev.duration_ms,
              exitCode: ev.exit_code,
              preview: ev.preview,
            },
          },
        ],
      };
    }

    case 'permission': {
      return {
        entries: [
          ...entries,
          {
            kind: 'perm',
            id: nextId('perm'),
            runId: ev.run_id,
            step: ev.step,
            tool: ev.tool,
            decision: ev.decision,
            waited: ev.waited,
            waitedMs: ev.waited_ms,
            rule: ev.rule,
          },
        ],
      };
    }

    case 'tool_batch': {
      return {
        entries: [
          ...entries,
          {
            kind: 'batch',
            id: nextId('batch'),
            runId: ev.run_id,
            step: ev.step,
            count: ev.count,
            wallMs: ev.wall_ms,
          },
        ],
      };
    }

    case 'run_finished': {
      const patched = entries.map((e) => {
        if (e.kind === 'turn' && e.runId === ev.run_id) {
          return { ...e, status: ev.reason, step: ev.steps } satisfies Entry;
        }
        // 回合结束，流式光标一律停掉
        if ((e.kind === 'stream' || e.kind === 'reason') && e.runId === ev.run_id) {
          return { ...e, streaming: false } satisfies Entry;
        }
        return e;
      });
      return { entries: patched, runEnded: true };
    }

    case 'delta_reset': {
      return { entries: clearStream(entries, ev.run_id, ev.step, ev.channel) };
    }

    case 'context_degraded': {
      return {
        entries: [
          ...entries,
          {
            kind: 'note',
            id: nextId('note'),
            tone: 'degraded',
            key: 'note.contextDegraded',
            text: null,
            params: { dropped: ev.dropped, reason: ev.reason },
          },
        ],
      };
    }

    case 'context_compacted': {
      return {
        entries: [
          ...entries,
          {
            kind: 'note',
            id: nextId('note'),
            tone: 'compacted',
            key: 'note.contextCompacted',
            text: null,
            params: { before: ev.before, after: ev.after, saved: ev.saved },
          },
        ],
      };
    }

    case 'image_attached': {
      return {
        entries: [
          ...entries,
          {
            kind: 'note',
            id: nextId('note'),
            tone: ev.ok ? 'image' : 'error',
            key: ev.ok ? 'note.imageAttached' : 'note.imageRejected',
            text: null,
            params: ev.reason ? { name: ev.name, reason: ev.reason } : { name: ev.name },
          },
        ],
      };
    }

    default:
      return { entries };
  }
}

/* ============================================================
   delta 归约（展示层）
   ============================================================ */

export function applyDelta(
  entries: Entry[],
  runId: string,
  step: number,
  channel: DeltaChannel,
  text: string,
  activeRunId: string | null,
): { entries: Entry[]; stale?: boolean } {
  if (activeRunId !== null && runId !== activeRunId) return { entries, stale: true };

  const wantKind = channel === 'reasoning' ? 'reason' : 'stream';

  const idx = entries.findIndex(
    (e) =>
      (e.kind === 'reason' || e.kind === 'stream') &&
      e.kind === wantKind &&
      e.runId === runId &&
      e.step === step,
  );

  if (idx >= 0) {
    const next = entries.slice();
    const target = next[idx];
    if (target.kind === 'reason') {
      next[idx] = { ...target, text: target.text + text, streaming: true };
    } else if (target.kind === 'stream') {
      next[idx] = { ...target, text: target.text + text, streaming: true };
    }
    return { entries: next };
  }

  const fresh: Entry =
    channel === 'reasoning'
      ? { kind: 'reason', id: nextId('reason'), runId, step, text, streaming: true }
      : { kind: 'stream', id: nextId('stream'), runId, step, text, streaming: true };

  return { entries: [...entries, fresh] };
}

/** 按 step + channel 清掉流式条目，等重画（delta_reset） */
export function clearStream(
  entries: Entry[],
  runId: string,
  step: number,
  channel: DeltaChannel,
): Entry[] {
  const wantKind = channel === 'reasoning' ? 'reason' : 'stream';
  return entries.filter(
    (e) =>
      !(
        (e.kind === 'reason' || e.kind === 'stream') &&
        e.kind === wantKind &&
        e.runId === runId &&
        e.step === step
      ),
  );
}

/* ============================================================
   ui 归约
   ============================================================ */

/**
 * ui(run_finished).answer 是本轮正文的唯一最终出口。
 * 到达时把该 run 的所有流式条目清掉，避免同一段正文渲染两遍（§9.2）。
 */
export function applyFinalAnswer(
  entries: Entry[],
  runId: string,
  answer: string,
  answerReasoning: string | null | undefined,
): Entry[] {
  const cleaned = entries.filter(
    (e) => !((e.kind === 'stream' || e.kind === 'reason') && e.runId === runId),
  );

  // 思考块：若之前是流式展开的，落成折叠态并保留全文
  const reasoning = answerReasoning?.trim();

  const withReason: Entry[] =
    reasoning && reasoning.length > 0
      ? [
          ...cleaned,
          {
            kind: 'reason',
            id: nextId('reason'),
            runId,
            step: 0,
            text: reasoning,
            streaming: false,
          },
        ]
      : cleaned;

  return [...withReason, { kind: 'answer', id: nextId('answer'), runId, text: answer }];
}

/** 把 ui(tools)/ui(context)/ui(compacted)/ui(status) 落成流内块 */
export function pushBlock(entries: Entry[], block: StreamBlockKind, payload: unknown): Entry[] {
  // 同一类块只保留最新一条，避免重复堆积
  const filtered = entries.filter((e) => !(e.kind === 'block' && e.block === block));
  return [...filtered, { kind: 'block', id: nextId('block'), block, payload }];
}

export function removeBlocks(entries: Entry[]): Entry[] {
  return entries.filter((e) => e.kind !== 'block');
}

export function applyUi(
  entries: Entry[],
  ui: RuntimeUi,
  activeRunId: string | null,
  isActiveRun: (runId: string) => boolean,
): { entries: Entry[]; stale?: boolean; runEnded?: boolean } {
  switch (ui.kind) {
    case 'run_finished': {
      if (!isActiveRun(ui.run_id) && activeRunId !== null) return { entries, stale: true };
      return {
        entries: applyFinalAnswer(entries, ui.run_id, ui.answer, ui.answer_reasoning),
        runEnded: true,
      };
    }
    case 'tools':
      return { entries: pushBlock(entries, 'tools', ui.tools) };
    case 'context':
      return { entries: pushBlock(entries, 'context', ui.context) };
    case 'compacted':
      return { entries: pushBlock(entries, 'compact', ui.compacted) };
    case 'status':
      return { entries: pushBlock(entries, 'status', ui.status) };
    case 'mcp':
    case 'state':
      // 这两类只喂侧栏/状态栏，不进流
      return { entries };
    default:
      return { entries };
  }
}

/* ============================================================
   展示派生
   ============================================================ */

/** 思考块默认折叠时显示字符数（§2） */
export function charCount(text: string): number {
  return Array.from(text).length;
}
