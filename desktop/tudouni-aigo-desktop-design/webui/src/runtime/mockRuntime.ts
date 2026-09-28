/**
 * Mock 运行时。
 *
 * 目的：让界面在**没有真运行时**的情况下也能完整跑通，且严格遵守
 * desktop-ui-spec.md §0 的消息全集 —— 界面里每个数字都来自这里发出的消息，
 * 组件里不允许出现硬编码的业务数值。
 *
 * 换成真实现时，只要提供同样形状的 Runtime 接口即可（见 bus.ts），
 * 上层组件与 store 一行都不用改。
 *
 * ⚠ 两处需要运行时作者确认的约定（写在这里，避免埋雷）：
 *  1. `/new` 新建会话：消息全集里没有 session_new，这里约定
 *     `session_switch` 携带 id `"__new__"` 表示开新会话。
 *  2. 思考强度档位清单随模型变，本 mock 通过 `ui(state).efforts` 下发。
 */

import type {
  BackgroundJob,
  EffortOption,
  FrontendMsg,
  Goal,
  LoadedSkill,
  McpServer,
  ModelInfo,
  PermissionRequestMsg,
  QuestionRequestMsg,
  RuntimeMsg,
  SessionListItem,
  SessionMeta,
  SkillRow,
  SubAgent,
  Task,
} from '@/protocol/types';
import type { Runtime } from './bus';

const WORKSPACE = 'C:/Users/XPS/projects/aigo';
const VERSION = '0.9.4';
const AUDIT_PATH = 'C:/Users/XPS/.aigo/sessions/2026-09-26/session-a7f3c1.jsonl';
const NEW_SESSION_SENTINEL = '__new__';

const now = () => Date.now();

const SESSIONS: SessionListItem[] = [
  {
    id: 'a7f3c1',
    message_count: 24,
    step_count: 41,
    task_done: 3,
    task_total: 7,
    preview: '把鉴权模块从单 PASSWORD 改成多用户 SQLite，先给我方案。',
    modified_at: now() - 3 * 60_000,
  },
  {
    id: 'b2e904',
    message_count: 18,
    step_count: 29,
    task_done: 3,
    task_total: 3,
    preview: '给 /api/items 加上 offset/limit 分批加载，顺便补测试',
    modified_at: now() - 46 * 60_000,
  },
  {
    id: 'c1d77a',
    message_count: 11,
    step_count: 16,
    task_done: 0,
    task_total: 2,
    preview: '封面本地化脚本 download_covers.py 变慢了，查一下',
    modified_at: now() - 26 * 3600_000,
  },
  {
    id: 'd90b23',
    message_count: 31,
    step_count: 55,
    task_done: 2,
    task_total: 4,
    preview: 'Android TV 端 Media3 播放器偶发黑屏，抓 log',
    modified_at: now() - 2 * 24 * 3600_000,
  },
  {
    id: 'e45510',
    message_count: 7,
    step_count: 9,
    task_done: 0,
    task_total: 1,
    preview: '整理 FastAPI 层的错误码约定',
    modified_at: now() - 5 * 24 * 3600_000,
  },
];

const MODELS: ModelInfo[] = [
  {
    name: 'deepseek-chat',
    route: 'deepseek',
    context_window: 128_000,
    description: '主力对话模型，快、便宜',
    current: true,
  },
  {
    name: 'deepseek-reasoner',
    route: 'deepseek',
    context_window: 128_000,
    description: '带思考链，复杂重构更稳',
    current: false,
  },
  {
    name: 'gpt-5.1',
    route: 'openai',
    context_window: 400_000,
    description: '长上下文，单价高',
    current: false,
  },
  {
    // 同名模型跨路由 —— 面板必须能区分（§5）
    name: 'gpt-5.1',
    route: 'azure-east',
    context_window: 400_000,
    description: '同名模型，走 Azure 东区路由',
    current: false,
  },
  {
    name: 'claude-sonnet-4.5',
    route: 'anthropic',
    context_window: 200_000,
    description: '长文档与写作',
    current: false,
  },
];

const EFFORTS_CHAT: EffortOption[] = [
  { id: 'low', label: 'low', description: '最少思考，最快返回' },
  { id: 'medium', label: 'medium', description: '默认档，均衡' },
  { id: 'high', label: 'high', description: '更深推理，慢一点' },
];

const EFFORTS_REASONER: EffortOption[] = [
  { id: 'minimal', label: 'minimal', description: '只给结论' },
  { id: 'low', label: 'low', description: '轻量思考' },
  { id: 'medium', label: 'medium', description: '默认档' },
  { id: 'high', label: 'high', description: '深推理' },
  { id: 'max', label: 'max', description: '拉满，耗时最长' },
];

const SKILLS_CATALOG: SkillRow[] = [
  {
    name: 'python-refactor',
    description: 'Python 重构与批量改写的流程约束',
    skipped: false,
    reason: null,
  },
  {
    name: 'sqlite-migrate',
    description: 'SQLite schema 迁移与回滚脚本生成',
    skipped: false,
    reason: null,
  },
  {
    name: 'pdf',
    description: 'PDF 读取、合并、拆分',
    skipped: true,
    reason: '本轮没有出现 PDF 相关意图',
  },
  {
    name: 'sheetagent',
    description: '既有表格的分析与清洗',
    skipped: true,
    reason: '已有表格类技能命中，避免重复加载',
  },
];

const GOAL: Goal = {
  text: '把 LibreTV 后端鉴权从全局单 PASSWORD 迁到多用户 SQLite，token 绑定 user_id，旧 localStorage 数据可丢弃。',
  turn: 3,
  phase: '实现',
  armed: true,
  blocked_reason: null,
};

const TASKS: Task[] = [
  { id: 't1', text: '读取现有鉴权实现', status: 'done' },
  { id: 't2', text: '设计 users / tokens 表结构', status: 'done' },
  { id: 't3', text: '写迁移脚本（含回滚）', status: 'done' },
  { id: 't4', text: '改造 token 校验逻辑', status: 'in_progress' },
  { id: 't5', text: '前端登录页对接', status: 'pending' },
  { id: 't6', text: '补回归测试', status: 'pending' },
  { id: 't7', text: '端到端验证', status: 'pending' },
];

const LOADED_SKILLS: LoadedSkill[] = [
  { name: 'python-refactor', description: 'Python 重构与批量改写的流程约束' },
  { name: 'sqlite-migrate', description: 'SQLite schema 迁移与回滚脚本生成' },
];

const MCP: McpServer[] = [
  {
    name: 'filesystem',
    state: 'running',
    tool_count: 11,
    launch: 'stdio: npx -y @modelcontextprotocol/server-filesystem ~/projects',
    error: null,
  },
  {
    name: 'postgres',
    state: 'configured',
    tool_count: 6,
    launch: 'stdio: mcp-server-postgres --dsn postgres://localhost/libretv',
    error: null,
  },
  {
    name: 'browser',
    state: 'failed',
    tool_count: 0,
    launch: 'http: http://127.0.0.1:9222/mcp',
    error: 'ECONNREFUSED 127.0.0.1:9222',
  },
];

const CAPS = { goal: 1, tasks: 6, skills: 8, jobs: 6, mcp: 6 };

const REASONING_TEXT = [
  '先把现状读清楚：现在是一把全局 PASSWORD 比对，token 是一段常量派生的字符串，不绑人。',
  '要切成多用户，关键是三件事 —— users 表、token 归属、以及校验路径上把 user_id 带出来。',
  '旧 localStorage 里的 token 可以整体作废，迁移时不做兼容分支，能省掉一大块复杂度。',
  '有个坑：vodlist 那条链路上游只透传 pg，鉴权要挂在 FastAPI 层，不能指望资源站回传身份。',
  '决定先动 schema 和校验，前端登录页放后面单独一轮。',
].join('\n');

const ANSWER_TEXT = `方案已经跑通了，分三块说。

## 1. 数据层

新增两张表，用同一个 SQLite 文件：

- \`users\` —— \`id / username / password_hash / created_at\`，密码走 \`argon2id\`，不再存明文比对。
- \`tokens\` —— \`token_hash / user_id / issued_at / expires_at / revoked\`，token 本体只存 hash。

迁移脚本带 \`--rollback\`，回滚只删这两张表，不动老业务表。

## 2. 校验路径

\`require_user()\` 依赖挂在 FastAPI 层，**不碰 CMS V10 那一层**：

\`\`\`python
async def require_user(token: str = Depends(bearer)) -> User:
    row = await db.fetch_token(token_hash(token))
    if row is None or row.revoked:
        raise HTTPException(401, "invalid token")
    return await db.fetch_user(row.user_id)
\`\`\`

所有受保护的 handler 只依赖 \`require_user\`，拿到的就是 \`User\`，不再有全局态。

## 3. 迁移取舍

- 旧 localStorage 的 token **一律作废**，前端清掉重新登录，不写兼容分支。
- 老 PASSWORD 环境变量在迁移完成后删掉，避免两套逻辑并存。
- 这一轮**不动前端登录页**，只保证 token 带上 \`user_id\`；界面改造单独开一轮。

## 待你确认

1. token 有效期定 30 天还是 7 天？
2. 要不要保留「单密码应急登录」作为兜底？

确认后我就把这三块落到代码上。`;

interface PendingResolver {
  resolve: (r: { action: string; selected?: string[]; text?: string }) => void;
}

export function createMockRuntime(): Runtime {
  /* ---------------- 可变状态 ---------------- */
  let session: SessionMeta = {
    id: 'a7f3c1',
    resumed: true,
    model: 'deepseek-chat',
    model_route: 'deepseek',
    thinking: true,
    effort: 'medium',
    max_steps: 60,
  };

  let efforts: EffortOption[] = EFFORTS_CHAT;
  let models: ModelInfo[] = MODELS.map((m) => ({ ...m }));

  let phase: 'idle' | 'running' | 'done' | 'failed' | 'interrupted' | 'step_limit' = 'idle';
  let action: string | null = null;
  let lastResult: string | null = null;
  let step = 0;
  let turn = 3;
  let contextUsed = 62_418;
  const contextWindow = 128_000;
  let autopilot = false;
  let subagents: SubAgent[] = [];
  let jobs: BackgroundJob[] = [
    {
      id: 'job-1',
      status: 'running',
      command: 'pytest tests/test_auth_migration.py -x',
      duration_ms: 42_000,
      exit_code: null,
      collected: true,
    },
    {
      id: 'job-2',
      status: 'done',
      command: 'python tools/download_covers.py --all',
      duration_ms: 213_400,
      exit_code: 0,
      collected: false,
    },
    {
      id: 'job-3',
      status: 'failed',
      command: 'npm run build --prefix webui',
      duration_ms: 8_900,
      exit_code: 1,
      collected: false,
    },
  ];
  let mcp: McpServer[] = MCP.map((m) => ({ ...m }));

  /* ---------------- 通道 ---------------- */
  const subs = new Set<(m: RuntimeMsg) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending = new Map<string, PendingResolver>();
  let disposed = false;
  let reqSeq = 0;

  function emit(msg: RuntimeMsg): void {
    if (disposed) return;
    for (const cb of subs) cb(msg);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (disposed) {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        timers.delete(t);
        resolve();
      }, ms);
      timers.add(t);
    });
  }

  function alive(): boolean {
    return !disposed;
  }

  /* ---------------- 出站快照 ---------------- */

  function statusPayload() {
    return {
      phase,
      action,
      last_result: lastResult,
      step,
      max_steps: session.max_steps,
    };
  }

  function pushState(): void {
    emit({
      type: 'ui',
      ui: {
        kind: 'state',
        state: {
          session,
          permission_scope: {
            autopilot,
            ask_on: autopilot ? [] : (['MEDIUM', 'HIGH'] as const).slice(),
            remembered_rules: 2,
          },
          status: statusPayload(),
          context: {
            used: contextUsed,
            window: contextWindow,
            percent: contextUsed / contextWindow,
          },
          cache_hit_rate: 0.72,
          elapsed_ms: phase === 'running' ? now() % 100_000 : 18_400,
          session_span_ms: 2 * 3600_000 + 41 * 60_000,
          audit_path: AUDIT_PATH,
          subagents,
          background_jobs: jobs,
          goal: GOAL,
          tasks: TASKS,
          skills: LOADED_SKILLS,
          skipped_skills: SKILLS_CATALOG.filter((s) => s.skipped).map((s) => ({
            name: s.name,
            reason: s.reason ?? '',
          })),
          mcp,
          efforts,
          caps: CAPS,
        },
      },
    });
  }

  function pushStatus(): void {
    emit({ type: 'ui', ui: { kind: 'status', status: statusPayload() } });
  }

  function setPhase(
    p: 'idle' | 'running' | 'done' | 'failed' | 'interrupted' | 'step_limit',
    act: string | null,
    result: string | null = null,
  ): void {
    phase = p;
    action = act;
    lastResult = result;
    pushStatus();
    pushState();
  }

  /* ---------------- 脚本化回合 ---------------- */

  async function runTurn(userText: string): Promise<void> {
    const runId = `run-${++reqSeq}-${now()}`;
    turn += 1;
    step = 0;

    setPhase('running', '准备上下文');
    emit({
      type: 'event',
      event: {
        kind: 'run_started',
        run_id: runId,
        step: 0,
        max_steps: session.max_steps,
        turn,
      },
    });

    // —— 思考流式（channel=reasoning）——
    step = 1;
    await sleep(220);
    setPhase('running', '思考中');
    const chunks = REASONING_TEXT.match(/.{1,24}/gs) ?? [REASONING_TEXT];
    for (const c of chunks) {
      if (!alive()) return;
      emit({ type: 'delta', run_id: runId, step, channel: 'reasoning', text: c });
      await sleep(70);
    }

    // 子代理起飞（状态栏角标 + 明细入口）
    subagents = [
      {
        id: 'sub-1',
        label: '读现有鉴权实现',
        model: 'deepseek-chat',
        depth: 1,
        started_ms: now() - 9_000,
        calls: 3,
        activity: 'Grep auth → read session.py',
      },
      {
        id: 'sub-2',
        label: '草拟迁移脚本',
        model: 'deepseek-reasoner',
        depth: 1,
        started_ms: now() - 4_200,
        calls: 1,
        activity: '写 001_add_users_tokens.sql',
      },
    ];
    pushState();

    // —— 模型步：带 token 与缓存命中 ——
    emit({
      type: 'event',
      event: {
        kind: 'model_call',
        run_id: runId,
        step,
        duration_ms: 2_140,
        input_tokens: 18_433,
        cached_tokens: 12_800,
      },
    });
    await sleep(160);

    // —— 第一次工具调用：读文件（LOW）——
    step = 2;
    setPhase('running', '读取 src/auth/session.py');
    emit({
      type: 'event',
      event: {
        kind: 'tool_call',
        run_id: runId,
        step,
        index: 1,
        tool: 'Read',
        params_preview: '{"path":"src/auth/session.py","limit":400}',
        risk: 'LOW',
        builtin: true,
        parallel_safe: true,
        occupies_input: false,
      },
    });
    await sleep(420);
    emit({
      type: 'event',
      event: {
        kind: 'tool_result',
        run_id: runId,
        step,
        index: 1,
        tool: 'Read',
        status: 'ok',
        chars: 4_812,
        duration_ms: 412,
        exit_code: null,
        preview: '1  import os',
      },
    });

    // —— 第二次：grep（LOW）——
    step = 3;
    setPhase('running', '搜索 PASSWORD 的全部引用');
    emit({
      type: 'event',
      event: {
        kind: 'tool_call',
        run_id: runId,
        step,
        index: 1,
        tool: 'Grep',
        params_preview: '{"pattern":"PASSWORD|verify_token","path":"src","glob":"*.py"}',
        risk: 'LOW',
        builtin: true,
        parallel_safe: true,
        occupies_input: false,
      },
    });
    await sleep(340);
    emit({
      type: 'event',
      event: {
        kind: 'tool_result',
        run_id: runId,
        step,
        index: 1,
        tool: 'Grep',
        status: 'ok',
        chars: 1_246,
        duration_ms: 331,
        exit_code: null,
        preview: '9 matches in 5 files',
      },
    });

    // —— 并发批次：3 个只读调用一起跑 ——
    step = 4;
    setPhase('running', '并发读取 3 个文件');
    const batch = [
      { i: 1, tool: 'Read', params: '{"path":"src/api/deps.py"}' },
      { i: 2, tool: 'Read', params: '{"path":"src/db/schema.sql"}' },
      { i: 3, tool: 'Grep', params: '{"pattern":"localStorage","path":"web/src"}' },
    ];
    for (const b of batch) {
      emit({
        type: 'event',
        event: {
          kind: 'tool_call',
          run_id: runId,
          step,
          index: b.i,
          tool: b.tool,
          params_preview: b.params,
          risk: 'LOW',
          builtin: true,
          parallel_safe: true,
          occupies_input: false,
        },
      });
    }
    await sleep(560);
    let i = 0;
    for (const b of batch) {
      i += 1;
      emit({
        type: 'event',
        event: {
          kind: 'tool_result',
          run_id: runId,
          step,
          index: b.i,
          tool: b.tool,
          status: 'ok',
          chars: 900 + i * 733,
          duration_ms: 180 + i * 90,
          exit_code: null,
          preview: 'ok',
        },
      });
    }
    emit({
      type: 'event',
      event: { kind: 'tool_batch', run_id: runId, step, count: batch.length, wall_ms: 892 },
    });

    // —— MEDIUM 风险写文件：阻塞模态一 ——
    step = 5;
    setPhase('running', '等待审批：写入迁移脚本');
    const permId = `perm-${++reqSeq}`;
    const permReq: PermissionRequestMsg = {
      type: 'permission_request',
      id: permId,
      run_id: runId,
      step,
      tool: 'Write',
      builtin: true,
      risk: 'MEDIUM',
      params: JSON.stringify(
        {
          path: 'migrations/001_add_users_tokens.sql',
          bytes: 1842,
          content: [
            'CREATE TABLE users (',
            '  id INTEGER PRIMARY KEY,',
            '  username TEXT NOT NULL UNIQUE,',
            '  password_hash TEXT NOT NULL,',
            '  created_at INTEGER NOT NULL',
            ');',
            '',
            'CREATE TABLE tokens (',
            '  token_hash TEXT PRIMARY KEY,',
            '  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,',
            '  issued_at INTEGER NOT NULL,',
            '  expires_at INTEGER,',
            '  revoked INTEGER NOT NULL DEFAULT 0',
            ');',
          ].join('\n'),
        },
        null,
        2,
      ),
      parallel_safe: false,
      occupies_input: false,
      hints: [
        '这个调用会新建 migrations/001_add_users_tokens.sql，不会修改任何已有文件。',
        '记住之后，同样写入 migrations/ 目录的操作不会再问；改密码或删除表的操作仍会问。',
      ],
      remember_rule: 'Write(path: migrations/**)',
      allow_all: true,
    };
    emit(permReq);

    const decision = await waitFor(permId);
    if (!alive()) return;

    emit({
      type: 'event',
      event: {
        kind: 'permission',
        run_id: runId,
        step,
        tool: 'Write',
        decision: decision.action === 'deny' ? 'deny' : 'allow',
        waited: true,
        waited_ms: 3_900,
        rule: decision.action === 'always' ? permReq.remember_rule : null,
      },
    });

    if (decision.action === 'deny') {
      // 拒绝行必须独立成条，且与「跑失败了」处置不同
      emit({
        type: 'event',
        event: {
          kind: 'tool_result',
          run_id: runId,
          step,
          index: 1,
          tool: 'Write',
          status: 'denied',
          chars: 0,
          duration_ms: 0,
          exit_code: null,
          preview: '你拒绝了这次写入',
        },
      });
    } else {
      emit({
        type: 'event',
        event: {
          kind: 'tool_call',
          run_id: runId,
          step,
          index: 1,
          tool: 'Write',
          params_preview: '{"path":"migrations/001_add_users_tokens.sql","bytes":1842}',
          risk: 'MEDIUM',
          builtin: true,
          parallel_safe: false,
          occupies_input: false,
        },
      });
      await sleep(380);
      emit({
        type: 'event',
        event: {
          kind: 'tool_result',
          run_id: runId,
          step,
          index: 1,
          tool: 'Write',
          status: 'ok',
          chars: 1_842,
          duration_ms: 366,
          exit_code: null,
          preview: 'created migrations/001_add_users_tokens.sql',
        },
      });
    }

    // —— 提问模态：阻塞模态二 ——
    step = 6;
    setStatusRunning('等待你的选择：token 有效期');
    const qId = `q-${++reqSeq}`;
    const qReq: QuestionRequestMsg = {
      type: 'question_request',
      id: qId,
      run_id: runId,
      step,
      question: 'token 有效期定多少？这个值会写进 schema 的 expires_at 默认逻辑。',
      tags: ['auth', 'schema', '需要决策'],
      options: [
        { id: 'd7', label: '7 天', description: '更安全，用户需要更频繁登录' },
        { id: 'd30', label: '30 天', description: '和现在前端「记住我」的体感一致' },
        { id: 'd90', label: '90 天', description: '电视端少登录，但风险更高' },
      ],
      multi: false,
      allow_free_text: true,
      allow_skip: true,
    };
    emit(qReq);

    const answer = await waitFor(qId);
    if (!alive()) return;

    // —— HIGH 风险：跑测试 ——
    step = 7;
    setStatusRunning('运行迁移回归测试');
    const highId = `perm-${++reqSeq}`;
    emit({
      type: 'permission_request',
      id: highId,
      run_id: runId,
      step,
      tool: 'Bash',
      builtin: true,
      risk: 'HIGH',
      params: JSON.stringify(
        {
          command:
            'pytest tests/test_auth_migration.py -x --tb=short && alembic upgrade head --sql > /tmp/plan.sql',
          cwd: WORKSPACE,
          timeout_ms: 300_000,
          note: '会跑 alembic 并把 SQL 计划写到 /tmp/plan.sql；注意第二条命令带重定向。',
        },
        null,
        2,
      ),
      parallel_safe: false,
      occupies_input: true,
      hints: [
        '这条命令会在你的工作区里执行 alembic，并把计划 SQL 重定向到 /tmp/plan.sql。',
        '记住之后，cwd 在此外的 Bash 调用仍会逐条询问。',
      ],
      remember_rule: 'Bash(cwd: projects/aigo)',
      allow_all: false,
    });

    const high = await waitFor(highId);
    if (!alive()) return;

    emit({
      type: 'event',
      event: {
        kind: 'permission',
        run_id: runId,
        step,
        tool: 'Bash',
        decision: high.action === 'deny' ? 'deny' : high.action === 'always' ? 'always' : 'allow',
        waited: true,
        waited_ms: 6_200,
        rule: high.action === 'always' ? 'Bash(cwd: projects/aigo)' : null,
      },
    });

    if (high.action === 'deny') {
      emit({
        type: 'event',
        event: {
          kind: 'tool_result',
          run_id: runId,
          step,
          index: 1,
          tool: 'Bash',
          status: 'denied',
          chars: 0,
          duration_ms: 0,
          exit_code: null,
          preview: '你拒绝了这次执行',
        },
      });
    } else {
      emit({
        type: 'event',
        event: {
          kind: 'tool_call',
          run_id: runId,
          step,
          index: 1,
          tool: 'Bash',
          params_preview:
            '{"command":"pytest tests/test_auth_migration.py -x --tb=short && alembic upgrade head --sql > /tmp/plan.sql"}',
          risk: 'HIGH',
          builtin: true,
          parallel_safe: false,
          occupies_input: true,
        },
      });
      await sleep(1_100);
      emit({
        type: 'event',
        event: {
          kind: 'tool_result',
          run_id: runId,
          step,
          index: 1,
          tool: 'Bash',
          status: 'ok',
          chars: 12_406,
          duration_ms: 1_064,
          exit_code: 0,
          preview: '3 passed in 8.42s',
        },
      });
    }

    // —— 上下文降级 + 压缩痕迹 ——
    step = 8;
    contextUsed = 118_940;
    pushState();
    await sleep(200);
    emit({
      type: 'event',
      event: {
        kind: 'context_degraded',
        run_id: runId,
        reason: '接近窗口上限，最旧的工具结果降为摘要',
        dropped: 6,
      },
    });
    await sleep(180);
    emit({
      type: 'event',
      event: { kind: 'context_compacted', run_id: runId, before: 118_940, after: 41_207, saved: 77_733 },
    });
    contextUsed = 41_207;
    pushState();
    await sleep(180);

    // —— 图片附加痕迹 ——
    emit({
      type: 'event',
      event: {
        kind: 'image_attached',
        run_id: runId,
        ok: true,
        name: 'schema-draft.png',
        reason: null,
      },
    });
    emit({
      type: 'event',
      event: {
        kind: 'image_attached',
        run_id: runId,
        ok: false,
        name: 'whiteboard.heic',
        reason: '不支持的格式，请转成 PNG / JPEG',
      },
    });

    // —— 子代理收工 ——
    subagents = [];
    jobs = jobs.map((j) =>
      j.id === 'job-2' ? { ...j, collected: true } : j,
    );
    pushState();

    // —— 正文流式出口 ——
    step = 9;
    setStatusRunning('正在整理方案');
    const paras = ANSWER_TEXT.match(/[\s\S]{1,60}/g) ?? [ANSWER_TEXT];
    for (const p of paras) {
      if (!alive()) return;
      emit({ type: 'delta', run_id: runId, step, channel: 'text', text: p });
      await sleep(38);
    }

    // —— 最终出口：ui(run_finished).answer ——
    emit({
      type: 'ui',
      ui: {
        kind: 'run_finished',
        run_id: runId,
        answer: ANSWER_TEXT,
        answer_reasoning: REASONING_TEXT,
      },
    });

    step = 9;
    emit({
      type: 'event',
      event: { kind: 'run_finished', run_id: runId, reason: 'completed', steps: step },
    });

    // 让这一步的用户选择落到可见文案里
    const chosen =
      answer.action === 'skip'
        ? '跳过'
        : answer.action === 'free_text'
          ? `自由作答「${answer.text ?? ''}」`
          : (answer.selected ?? []).join(' / ');
    setPhase('done', null, `已答完 · 你的选择：${chosen} · 共 ${step} 步`);

    void userText;
  }

  function setStatusRunning(act: string): void {
    phase = 'running';
    action = act;
    pushStatus();
    pushState();
  }

  /* ---------------- 阻塞等待 ---------------- */
  function waitFor(id: string): Promise<{ action: string; selected?: string[]; text?: string }> {
    return new Promise((resolve) => {
      pending.set(id, { resolve });
    });
  }

  /* ---------------- 后台任务的自然演进 ---------------- */
  async function jobTicker(): Promise<void> {
    // 安静时段也会自己结束（§0 第 8 条），所以必须能刷新面板
    await sleep(14_000);
    if (!alive()) return;
    jobs = jobs.map((j) =>
      j.id === 'job-1'
        ? { ...j, status: 'done' as const, exit_code: 0, collected: true }
        : j,
    );
    pushState();
    emit({
      type: 'notice',
      level: 'info',
      key: 'note.contextCompacted',
      text: null,
      params: { before: 0, after: 0, saved: 0 },
    });
  }

  /* ---------------- 入站 ---------------- */
  function handle(msg: FrontendMsg): void {
    switch (msg.type) {
      case 'user_message': {
        if (phase === 'running') {
          emit({
            type: 'notice',
            level: 'warn',
            key: null,
            text: '运行时还在跑上一轮，这条消息已排队。',
          });
          return;
        }
        void runTurn(msg.text);
        break;
      }

      case 'interrupt': {
        if (phase !== 'running') return;
        phase = 'interrupted';
        action = null;
        lastResult = '被你中断（切在回合边界）';
        // 关掉还挂着的模态
        for (const [id, p] of pending) {
          p.resolve({ action: 'deny' });
          pending.delete(id);
        }
        subagents = [];
        pushStatus();
        pushState();
        break;
      }

      case 'session_list': {
        emit({ type: 'sessions', sessions: SESSIONS, total: SESSIONS.length });
        break;
      }

      case 'session_switch': {
        if (msg.id === NEW_SESSION_SENTINEL) {
          session = {
            ...session,
            id: `new-${Math.floor(now() / 1000).toString(36)}`,
            resumed: false,
          };
          turn = 0;
          step = 0;
          contextUsed = 0;
          emit({ type: 'session_load', session, messages: [] });
          setPhase('idle', null, null);
          break;
        }
        const found = SESSIONS.find((s) => s.id === msg.id);
        session = { ...session, id: msg.id, resumed: true };
        emit({
          type: 'session_load',
          session,
          messages: [
            {
              role: 'user',
              text: found?.preview ?? '（会话内容已载入）',
              at_ms: (found?.modified_at ?? now()) - 240_000,
            },
            {
              role: 'assistant',
              text:
                '已从审计日志恢复这段会话。这一轮的结论是：鉴权改到 FastAPI 层做，users / tokens 两张表，旧 localStorage 数据作废，前端登录页单独开一轮。',
              at_ms: (found?.modified_at ?? now()) - 60_000,
            },
          ],
        });
        turn = 3;
        setPhase('idle', null, '已载入历史会话');
        break;
      }

      case 'set_model': {
        const target = models.find((m) => m.name === msg.model);
        if (target) {
          models = models.map((m) => ({ ...m, current: m.name === msg.model }));
          session = { ...session, model: target.name, model_route: target.route };
          // 档位清单随模型变（§5）
          efforts = target.name.includes('reasoner') ? EFFORTS_REASONER : EFFORTS_CHAT;
          if (!efforts.some((e) => e.id === session.effort)) {
            session = { ...session, effort: efforts[0].id };
          }
        }
        pushState();
        emit({
          type: 'notice',
          level: 'info',
          key: null,
          text: `模型已切到 ${msg.model}，档位清单同步更新。`,
        });
        break;
      }

      case 'set_thinking': {
        session = { ...session, thinking: msg.enabled };
        pushState();
        break;
      }

      case 'set_effort': {
        session = { ...session, effort: msg.effort };
        pushState();
        emit({
          type: 'notice',
          level: 'info',
          key: null,
          text: `思考强度 → ${msg.effort}`,
        });
        break;
      }

      case 'set_autopilot': {
        autopilot = msg.enabled;
        pushState();
        emit({
          type: 'notice',
          level: msg.enabled ? 'warn' : 'info',
          key: null,
          text: msg.enabled
            ? '自动放行已开启：MEDIUM / HIGH 风险动作不再逐条确认。'
            : '自动放行已关闭：MEDIUM / HIGH 风险动作恢复逐条确认。',
        });
        break;
      }

      case 'status':
      case 'refresh_state': {
        pushStatus();
        pushState();
        if (msg.type === 'status') {
          emit({ type: 'ui', ui: { kind: 'status', status: statusPayload() } });
        }
        break;
      }

      case 'tools': {
        emit({
          type: 'ui',
          ui: {
            kind: 'tools',
            tools: {
              rows: [
                {
                  name: 'Read',
                  builtin: true,
                  risk: 'LOW',
                  remembered: true,
                  description: '读取工作区内文件',
                },
                {
                  name: 'Grep',
                  builtin: true,
                  risk: 'LOW',
                  remembered: true,
                  description: '正则搜索文件内容',
                },
                {
                  name: 'Write',
                  builtin: true,
                  risk: 'MEDIUM',
                  remembered: true,
                  description: '写入 / 覆盖文件（migrations/** 已记住）',
                },
                {
                  name: 'Bash',
                  builtin: true,
                  risk: 'HIGH',
                  remembered: false,
                  description: '执行 shell 命令，每次都问',
                },
                {
                  name: 'mcp__filesystem__move',
                  builtin: false,
                  risk: 'MEDIUM',
                  remembered: false,
                  description: 'MCP 外部工具：移动文件',
                },
              ],
            },
          },
        });
        break;
      }

      case 'context': {
        emit({
          type: 'ui',
          ui: {
            kind: 'context',
            context: {
              sections: [
                { name: 'system prompt', tokens: 3_120, note: '固定' },
                { name: 'skills', tokens: 1_880, note: '2 个技能' },
                { name: 'conversation', tokens: 24_406, note: '已压缩过一次' },
                { name: 'tool results', tokens: 9_640, note: '旧结果降为摘要' },
                { name: 'attachments', tokens: 2_161, note: '1 张图' },
              ],
              used: contextUsed,
              window: contextWindow,
            },
          },
        });
        break;
      }

      case 'compact': {
        emit({
          type: 'ui',
          ui: {
            kind: 'compacted',
            compacted: {
              before: 118_940,
              after: 41_207,
              saved: 77_733,
              summary:
                '把 5 轮之前的工具结果压成一段摘要：核心结论是鉴权改到 FastAPI 层、users/tokens 两表、旧 token 作废。',
              note: '压缩只改上下文里的表示，磁盘上的会话与审计文件一个字都没删。',
            },
          },
        });
        break;
      }

      case 'mcp': {
        if (msg.action === 'load' && msg.name) {
          mcp = mcp.map((m) =>
            m.name === msg.name ? { ...m, state: 'running' as const, error: null } : m,
          );
          emit({ type: 'ui', ui: { kind: 'mcp', servers: mcp } });
          pushState();
          emit({
            type: 'notice',
            level: 'info',
            key: null,
            text: `已加载 ${msg.name}，新增 ${
              mcp.find((m) => m.name === msg.name)?.tool_count ?? 0
            } 个工具。`,
          });
        } else if (msg.action === 'unload' && msg.name) {
          mcp = mcp.map((m) =>
            m.name === msg.name ? { ...m, state: 'configured' as const } : m,
          );
          emit({ type: 'ui', ui: { kind: 'mcp', servers: mcp } });
          pushState();
          emit({
            type: 'notice',
            level: 'warn',
            key: null,
            text: `已卸载 ${msg.name}，它的工具从本轮起不可用。`,
          });
        } else {
          emit({ type: 'ui', ui: { kind: 'mcp', servers: mcp } });
        }
        break;
      }

      case 'permission_response': {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.resolve({ action: msg.action });
        }
        break;
      }

      case 'question_response': {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.resolve({ action: msg.action, selected: msg.selected, text: msg.text });
        }
        break;
      }

      case 'shutdown': {
        setPhase('interrupted', null, '运行时已退出');
        break;
      }

      default:
        break;
    }
  }

  /* ---------------- 启动 ---------------- */
  void (async () => {
    // 慢启动：演示「启动中」阶段要有第二句提示（§4）
    await sleep(900);
    if (!alive()) return;

    emit({
      type: 'init',
      version: VERSION,
      workspace: WORKSPACE,
      locale: 'zh',
      user_name: '土豆泥',
      session,
      permission_scope: {
        autopilot: false,
        ask_on: ['MEDIUM', 'HIGH'],
        remembered_rules: 2,
      },
      context: { used: contextUsed, window: contextWindow, percent: contextUsed / contextWindow },
      audit_path: AUDIT_PATH,
      max_steps: session.max_steps,
      models,
      skills_catalog: SKILLS_CATALOG,
      themes: ['system', 'dark', 'light'],
    });

    await sleep(120);
    if (!alive()) return;
    emit({ type: 'sessions', sessions: SESSIONS, total: SESSIONS.length });

    pushState();
    void jobTicker();
  })();

  return {
    send: handle,
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    dispose() {
      disposed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const [, p] of pending) p.resolve({ action: 'deny' });
      pending.clear();
      subs.clear();
    },
  };
}
