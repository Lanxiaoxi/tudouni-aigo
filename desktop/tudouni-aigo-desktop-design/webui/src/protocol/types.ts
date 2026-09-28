/**
 * tudouni-aigo · 前端 ↔ 运行时 协议类型
 * 唯一依据：desktop-ui-spec.md §0「消息全集」。不增不改语义。
 *
 * 硬约束（对应 §0 第 2、3 条）：
 *  - 界面上每个数字都必须来自本文件定义的消息，前端不许自己推导。
 *  - 状态以运行时为准，禁止乐观更新。
 */

/* ============================================================
   基础枚举
   ============================================================ */

export type Locale = 'zh' | 'en';

/** 工具风险等级。MEDIUM/HIGH 需在流里突出显示 */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/** 状态栏左半的「阶段」（§4） */
export type Phase =
  | 'booting' // 启动中
  | 'idle' // 空闲
  | 'running' // 进行中
  | 'done' // 已完成
  | 'step_limit' // 到步数上限
  | 'failed' // 失败
  | 'interrupted'; // 被打断

export type RunEndReason = 'completed' | 'failed' | 'interrupted' | 'step_limit';

export type DeltaChannel = 'text' | 'reasoning';

export type PermissionDecision = 'allow' | 'deny' | 'always' | 'autopilot';

export type ToolResultStatus = 'ok' | 'error' | 'denied';

/** 流内大屏文本块（§5） */
export type StreamBlockKind = 'status' | 'tools' | 'context' | 'compact';

/* ============================================================
   侧栏 / 状态栏承载的运行时事实（§3、§4）
   ============================================================ */

export interface Goal {
  /** 正文。有上限，超出由运行时截断并置 truncated 标志 */
  text: string;
  truncated?: boolean;
  turn: number;
  phase: string;
  /** armed = 生效中；disarmed = 已解除 */
  armed: boolean;
  /** 阻塞原因，非空时侧栏要能一眼看到 */
  blocked_reason: string | null;
}

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export interface Task {
  id: string;
  text: string;
  status: TaskStatus;
}

export interface LoadedSkill {
  name: string;
  description: string;
}

export interface SkippedSkill {
  name: string;
  reason: string;
}

export type JobStatus = 'running' | 'done' | 'failed' | 'killed';

export interface BackgroundJob {
  id: string;
  status: JobStatus;
  command: string;
  duration_ms: number;
  exit_code: number | null;
  /** false = 结果还没收回来，侧栏要给别人一眼看出的信号 */
  collected: boolean;
}

export type McpState = 'running' | 'configured' | 'failed';

export interface McpServer {
  name: string;
  /** 三态不可合并（§5 MCP 面板） */
  state: McpState;
  tool_count: number;
  /** 启动方式，如 "stdio: npx -y @modelcontextprotocol/server-filesystem" */
  launch: string;
  /** state=failed 时的原因 */
  error: string | null;
}

export interface SubAgent {
  id: string;
  label: string;
  model: string;
  depth: number;
  started_ms: number;
  /** 计数：已跑的工具调用数 */
  calls: number;
  activity: string;
}

export interface ContextUsage {
  used: number;
  /** 窗口未知时为 null —— 此时只报用量，不报百分比（§4） */
  window: number | null;
  percent: number | null;
}

/* ============================================================
   会话
   ============================================================ */

export interface SessionMeta {
  id: string;
  /** 是否续接已有会话 */
  resumed: boolean;
  model: string;
  model_route: string;
  thinking: boolean;
  effort: string | null;
  max_steps: number;
}

/** 权限状态：只读事实展示，不是控件（§1·2、§9.5） */
export interface PermissionScope {
  /** 自动放行是否开启 */
  autopilot: boolean;
  /** 哪些风险等级会弹审批 */
  ask_on: RiskLevel[];
  /** 已在运行时侧记住的规则条数 */
  remembered_rules: number;
}

/** /resume 列表一行。预览与进度由运行时算好，前端不读会话文件（§5） */
export interface SessionListItem {
  id: string;
  message_count: number;
  step_count: number;
  task_done: number;
  task_total: number;
  preview: string;
  /** epoch ms */
  modified_at: number;
}

/* ============================================================
   模型 / 参数
   ============================================================ */

export interface ModelInfo {
  name: string;
  route: string;
  context_window: number | null;
  description: string;
  current: boolean;
}

/** 思考强度档位：清单随模型变，前端不许写死（§5） */
export interface EffortOption {
  id: string;
  label: string;
  description: string;
}

/** 技能面板一行 */
export interface SkillRow {
  name: string;
  description: string;
  skipped: boolean;
  reason: string | null;
}

/* ============================================================
   运行时 → 前端
   ============================================================ */

/** event 的 11 种 kind（§0） */
export type RuntimeEvent =
  | {
      kind: 'run_started';
      run_id: string;
      step: number;
      max_steps: number;
      turn: number;
    }
  | {
      kind: 'model_call';
      run_id: string;
      step: number;
      duration_ms: number | null;
      input_tokens: number | null;
      cached_tokens: number | null;
      reasoning?: string;
      /** 失败重试时改报这个（§2） */
      retry?: { attempt: number; wait_ms: number };
    }
  | {
      kind: 'tool_call';
      run_id: string;
      step: number;
      index: number;
      tool: string;
      /** 已由运行时截断到 120 字符 */
      params_preview: string;
      risk: RiskLevel;
      builtin: boolean;
      parallel_safe: boolean;
      occupies_input: boolean;
    }
  | {
      kind: 'tool_result';
      run_id: string;
      step: number;
      index: number;
      tool: string;
      status: ToolResultStatus;
      chars: number;
      duration_ms: number;
      exit_code: number | null;
      /** 结果首行摘要，可为空 */
      preview: string;
    }
  | {
      kind: 'permission';
      run_id: string;
      step: number;
      tool: string;
      decision: PermissionDecision;
      /** 是否等人回答 */
      waited: boolean;
      waited_ms: number;
      rule: string | null;
    }
  | {
      kind: 'tool_batch';
      run_id: string;
      step: number;
      count: number;
      wall_ms: number;
    }
  | {
      kind: 'run_finished';
      run_id: string;
      reason: RunEndReason;
      steps: number;
    }
  | {
      kind: 'delta_reset';
      run_id: string;
      step: number;
      channel: DeltaChannel;
    }
  | {
      kind: 'context_degraded';
      run_id: string;
      reason: string;
      dropped: number;
    }
  | {
      kind: 'context_compacted';
      run_id: string;
      before: number;
      after: number;
      saved: number;
    }
  | {
      kind: 'image_attached';
      run_id: string;
      ok: boolean;
      name: string;
      reason: string | null;
    };

/** ui 的 7 种 kind（§0） */
export interface UiStatusPayload {
  phase: Phase;
  action: string | null;
  last_result: string | null;
  step: number;
  max_steps: number;
}

export interface UiToolsPayload {
  rows: Array<{
    name: string;
    builtin: boolean;
    risk: RiskLevel;
    /** 是否已记住规则 */
    remembered: boolean;
    description: string;
  }>;
}

export interface UiContextPayload {
  sections: Array<{ name: string; tokens: number; note: string }>;
  used: number;
  window: number | null;
}

export interface UiCompactedPayload {
  before: number;
  after: number;
  saved: number;
  summary: string;
  note: string;
}

/** ui(state) 快照：侧栏 5 区块 + 会话栏 + 状态栏的全部事实 */
export interface UiStatePayload {
  session: SessionMeta;
  permission_scope: PermissionScope;
  status: UiStatusPayload;
  context: ContextUsage;
  cache_hit_rate: number | null;
  elapsed_ms: number | null;
  session_span_ms: number | null;
  audit_path: string;
  subagents: SubAgent[];
  background_jobs: BackgroundJob[];
  goal: Goal | null;
  tasks: Task[];
  skills: LoadedSkill[];
  skipped_skills: SkippedSkill[];
  mcp: McpServer[];
  /**
   * 思考强度档位。清单随模型变，所以挂在状态快照里 ——
   * 前端绝不许写死（§5「思考强度」面板）。
   */
  efforts: EffortOption[];
  /** 各区块的内容上限，超出由前端从底部丢弃并标 (+N more) */
  caps: Record<'goal' | 'tasks' | 'skills' | 'jobs' | 'mcp', number>;
}

export type RuntimeUi =
  | { kind: 'run_finished'; run_id: string; answer: string; answer_reasoning?: string | null }
  | { kind: 'state'; state: UiStatePayload }
  | { kind: 'status'; status: UiStatusPayload }
  | { kind: 'tools'; tools: UiToolsPayload }
  | { kind: 'mcp'; servers: McpServer[] }
  | { kind: 'compacted'; compacted: UiCompactedPayload }
  | { kind: 'context'; context: UiContextPayload };

export interface InitMsg {
  type: 'init';
  version: string;
  workspace: string;
  locale: Locale;
  /** 首屏问候要含用户名（§7） */
  user_name: string;
  session: SessionMeta;
  permission_scope: PermissionScope;
  context: ContextUsage;
  audit_path: string;
  max_steps: number;
  /** 可选模型清单（init 期一次性下发，切换模型只翻转 current 标记） */
  models: ModelInfo[];
  /** 技能清单，含被跳过的技能及原因（§5 技能面板）；加载中的技能另有 ui(state).skills */
  skills_catalog: SkillRow[];
  /** 可用主题名。主题是前端呈现层，运行时只负责给名字 */
  themes: string[];
}

export interface SessionLoadMsg {
  type: 'session_load';
  session: SessionMeta;
  messages: Array<{ role: 'user' | 'assistant'; text: string; at_ms: number }>;
}

export interface EventMsg {
  type: 'event';
  event: RuntimeEvent;
}

export interface UiMsg {
  type: 'ui';
  ui: RuntimeUi;
}

export interface DeltaMsg {
  type: 'delta';
  run_id: string;
  step: number;
  channel: DeltaChannel;
  text: string;
}

export interface DeltaResetMsg {
  type: 'delta_reset';
  run_id: string;
  step: number;
  channel: DeltaChannel;
}

/** 运行期说明。优先走 key；permission/question 的提示原文才用 text 直传 */
export interface NoticeMsg {
  type: 'notice';
  level: 'info' | 'warn' | 'error';
  key: string | null;
  text: string | null;
  params?: Record<string, string | number>;
}

export interface SessionsMsg {
  type: 'sessions';
  sessions: SessionListItem[];
  total: number;
}

/** 阻塞模态一：审批（§6.1） */
export interface PermissionRequestMsg {
  type: 'permission_request';
  id: string;
  run_id: string;
  step: number;
  tool: string;
  builtin: boolean;
  risk: RiskLevel;
  /** 全文，前端不许截断（高风险命令的关键常在后半句） */
  params: string;
  parallel_safe: boolean;
  occupies_input: boolean;
  /**
   * 运行时给的两句提示原文，一字不许改。
   * 这是唯一知道「记住意味着什么」的一方写的。
   */
  hints: [string, string];
  /** 是否给了可记住的规则 */
  remember_rule: string | null;
  /** 「全部允许」是否可用；可用时提示里已说明这是快照 */
  allow_all: boolean;
}

/** 阻塞模态二：提问（§6.2） */
export interface QuestionRequestMsg {
  type: 'question_request';
  id: string;
  run_id: string;
  step: number;
  question: string;
  tags: string[];
  options: Array<{ id: string; label: string; description: string | null }>;
  multi: boolean;
  allow_free_text: boolean;
  /** 跳过是独立动作，永远可用（空选项 = 自由作答） */
  allow_skip: true;
}

export type RuntimeMsg =
  | InitMsg
  | SessionLoadMsg
  | EventMsg
  | UiMsg
  | DeltaMsg
  | DeltaResetMsg
  | NoticeMsg
  | SessionsMsg
  | PermissionRequestMsg
  | QuestionRequestMsg;

/* ============================================================
   前端 → 运行时
   ============================================================ */

export type PermissionResponseAction = 'allow' | 'deny' | 'always' | 'allow_all';
export type QuestionResponseAction = 'choose' | 'free_text' | 'skip';

export type FrontendMsg =
  | { type: 'user_message'; text: string }
  | { type: 'interrupt' }
  | { type: 'session_switch'; id: string }
  | { type: 'session_list' }
  | { type: 'set_model'; model: string }
  | { type: 'set_thinking'; enabled: boolean }
  | { type: 'set_effort'; effort: string }
  | { type: 'set_autopilot'; enabled: boolean }
  | { type: 'status' }
  | { type: 'tools' }
  | { type: 'context' }
  | { type: 'compact' }
  | { type: 'mcp'; action: 'list' | 'load' | 'unload'; name?: string }
  | { type: 'refresh_state' }
  | {
      type: 'permission_response';
      id: string;
      action: PermissionResponseAction;
    }
  | {
      type: 'question_response';
      id: string;
      action: QuestionResponseAction;
      selected?: string[];
      text?: string;
    }
  | { type: 'shutdown' };

export type FrontendMsgType = FrontendMsg['type'];
