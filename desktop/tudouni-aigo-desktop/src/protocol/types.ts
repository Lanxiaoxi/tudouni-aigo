/**
 * tudouni-aigo desktop · the runtime protocol, one-to-one.
 *
 * Authority: `protocol/schema/{inbound,outbound}.schema.json` and
 * `internal/protocol/messages.go`. Every key name here matches the wire; the
 * envelope (`v` / `t` / `kind`) is flat, never nested.
 *
 * Two rules this file exists to keep:
 *   - `v` is the envelope version and the only hard failure point. `protocol`
 *     (on `init`) is the conversation's semantic version and is survivable: a
 *     front end that does not know `delta` ignores it and still gets the full
 *     answer from `ui(run_finished).answer`.
 *   - Messages are maps, not structs, on purpose. Both ends upgrade
 *     independently; the rule is "ignore what you do not know, keep going".
 */

/** Envelope version. `internal/protocol/messages.go:25`. */
export const ENVELOPE_VERSION = 1;

/** Semantic version of the conversation, carried as `init.protocol`. */
export const PROTOCOL_VERSION = 3;

/* ============================================================
   Shared vocabulary
   ============================================================ */

/** Tool risk. Declared per tool; the interface renders it, never hard-codes it. */
export type RiskLevel = 'low' | 'medium' | 'high';

/** `ui(tools)` disposition, decided by the runtime's policy. */
export type Disposition = 'auto' | 'ask' | 'deny';

/** `ui(state).risk_scope[]` disposition. Note: no `deny` here. */
export type RiskDisposition = 'auto' | 'ask';

/** Which stream a `delta` belongs to. Both carry strings; crossing them puts
 *  the model thinking out loud into the answer. */
export type DeltaChannel = 'text' | 'reasoning';

export type PermissionDecision = 'allow' | 'deny' | 'always' | 'always_group';

export type QuestionStatus = 'answered' | 'skipped';

/** `notice.level`. `error` is not a value the runtime emits. */
export type NoticeLevel = 'info' | 'warn';

/** Backend job state machine, computed by the runtime. `uncollected` is the
 *  one that means "the result is not in yet". */
export type JobState = 'running' | 'uncollected' | 'done' | 'killed';

/** MCP server state. Three different questions, never merged: `loaded` is
 *  running, `unload` is configured but not running, `failed` we tried and it
 *  did not work. */
/**
 * MCP server state.
 *
 * **The runtime only ever sends `loaded` and `unload`** — `internal/runtime/
 * mcp.go` `mcpInventory` has no other branch. `failed` is tolerated here for a
 * future version that might add it, but nothing should wait for it: a server
 * that would not connect is reported as an `mcp_notes` sentence, which
 * `notesByServer` attaches to the row.
 */
export type McpState = 'loaded' | 'unload' | 'failed';

/** `ui(state).todos[].status`. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** `init.model_catalog.aliases[]`: a name we accept that is not in the list. */
export interface ModelAlias {
  id: string;
  of: string;
}

/* ============================================================
   Runtime -> front end
   ============================================================ */

export interface InitTool {
  name: string;
  risk: RiskLevel;
  parallel_safe: boolean;
  /** The handler blocks on a person (today only the question tool). */
  interactive: boolean;
}

export interface InitNotice {
  level: NoticeLevel;
  /** Machine-readable category: context / web / mcp / tools / permissions / … */
  code: string;
  /** The whole line, already written for a person. */
  text: string;
}

/**
 * The permission scope in force at start-up.
 *
 * **Only non-default entries are present** — on an ordinary run this is an
 * empty object, and the interface then shows nothing. Deciding what counts as
 * non-default is the configuration's knowledge, so the runtime decides it.
 */
export interface PermissionScope {
  auto_approve?: string[];
  auto_approve_tools?: string[];
  deny_tools?: string[];
  shell_allow?: string[];
}

export interface ModelCatalogRow {
  provider: string;
  id: string;
  label: string;
  /** Context window, or null when the catalogue does not say. */
  window: number | null;
  summary: string;
  note: string;
  vision: boolean;
  current: boolean;
  /** The level this model would run at if picked. */
  effort: string;
  effort_levels: string[];
}

export interface ModelCatalog {
  models: ModelCatalogRow[];
  aliases: ModelAlias[];
}

export interface InitMsg {
  v: number;
  t: 'init';
  protocol: number;
  session_id: string;
  resumed: boolean;
  model: string;
  /** Which route the request goes to. Separate from the model name on purpose:
   *  two routes can carry the same model name, and "where the request went" is
   *  a different fact on a bill. */
  provider: string;
  thinking: boolean;
  /** Present even when thinking is off: that is the user's intent, not an
   *  error state. Display it as-is, never convert. */
  effort: string;
  /** Which levels the current model accepts. Never hard-code this. */
  effort_levels: string[];
  model_catalog: ModelCatalog;
  workspace: string;
  max_steps: number;
  stream: boolean;
  /** The denominator for the usage percentage. **Null means the interface
   *  reports the amount only, never a percentage** — a wrong percentage is
   *  worse than no percentage. */
  context_tokens: number | null;
  tools: InitTool[];
  permissions: PermissionScope;
  audit_path: string;
  notices: InitNotice[];
}

/**
 * The restored picture. `messages` is the session's own array, verbatim, so one
 * of these can be several megabytes.
 */
export interface SessionLoadMsg {
  v: number;
  t: 'session_load';
  messages: SessionMessage[];
}

/**
 * A session message as stored.
 *
 * Deliberately loose: this is the runtime's storage format, not a protocol
 * shape. The adapter reads `role` and `content` and tolerates the rest.
 */
export interface SessionMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

/* ---------------- events ---------------- */

/** Envelope fields every event carries. */
export interface EventEnvelope {
  v: number;
  t: 'event';
  kind: string;
  session_id: string;
  run_id: string;
  step: number;
  ts: string;
}

export interface RunStartedEvent extends EventEnvelope {
  kind: 'run_started';
  model: string;
  provider: string;
  thinking: boolean;
  effort: string;
  effort_levels: string[];
}

export interface ModelCallEvent extends EventEnvelope {
  kind: 'model_call';
  /** Only `model_call` carries a model name. */
  model?: string;
  status: string;
  duration_ms?: number;
  /** Set when this call is about to be retried. */
  backoff_ms?: number;
  tool_calls?: number;
  prompt_tokens?: number;
  cached_tokens?: number;
  miss_tokens?: number;
  completion_tokens?: number;
  streamed?: boolean;
  stream_chunks?: number;
  streamed_chars?: number;
  /** The thinking text, whole and untruncated. The only content-shaped field
   *  in the audit — and it is what makes folding-by-default possible. */
  reasoning?: string;
  finish_reason?: string;
}

export interface ToolCallEvent extends EventEnvelope {
  kind: 'tool_call';
  tool: string;
  call_id: string;
  tool_index: number;
  /** Already truncated by the runtime for the log. */
  arguments: string;
}

export interface ToolResultEvent extends EventEnvelope {
  kind: 'tool_result';
  tool: string;
  call_id: string;
  tool_index: number;
  /** `denied` must be drawn as its own row: "did not run" and "ran and failed"
   *  are handled differently. */
  status: string;
  chars: number;
  duration_ms: number;
  parallel?: boolean;
  /** Passed through from the tool's own audit fields. */
  exit_code?: number;
  [key: string]: unknown;
}

export interface PermissionEvent extends EventEnvelope {
  kind: 'permission';
  tool: string;
  risk: RiskLevel;
  decision: string;
  outcome: string;
  arguments: string;
  waited_ms?: number;
  remembered?: string[];
  rule?: string;
}

export interface ToolBatchEvent extends EventEnvelope {
  kind: 'tool_batch';
  calls: number;
  /** Wall-clock, not the sum of the parts. */
  wall_ms: number;
  tools: string;
}

export interface RunFinishedEvent extends EventEnvelope {
  kind: 'run_finished';
  stop_reason: string;
  duration_ms: number;
}

export interface ContextDegradedEvent extends EventEnvelope {
  kind: 'context_degraded';
  items?: number;
  estimated?: number;
  limit?: number;
  changes?: unknown;
}

export interface ContextCompactedEvent extends EventEnvelope {
  kind: 'context_compacted';
  folded: number;
  folded_total: number;
  messages: number;
  summary_id: string;
  summary_chars: number;
  generation: number;
  before: number;
  after: number;
  duration_ms: number;
  model: string;
}

/**
 * One picture entering the context, or one that was refused.
 *
 * Three shapes share the kind, told apart by which keys are present:
 *   - attached:   `artifact_id` / `name` / `path` / `mime` / `bytes` / `width` / `height`
 *   - skipped:    `status: "skipped"` + `reason`
 *   - over_limit: `status: "over_limit"` + `limit` / `rest` / `paths`
 */
export interface ImageAttachedEvent extends EventEnvelope {
  kind: 'image_attached';
  artifact_id?: string;
  name?: string;
  path?: string;
  mime?: string;
  bytes?: number;
  width?: number;
  height?: number;
  status?: string;
  reason?: string;
  limit?: number;
  rest?: number;
  paths?: string[];
}

export interface DeltaResetEvent extends EventEnvelope {
  kind: 'delta_reset';
}

/** Anything we do not model. Fields are still readable; nothing is required. */
export interface UnknownEvent extends EventEnvelope {
  kind: string;
  [key: string]: unknown;
}

export type RuntimeEvent =
  | RunStartedEvent
  | ModelCallEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionEvent
  | ToolBatchEvent
  | RunFinishedEvent
  | DeltaResetEvent
  | ContextDegradedEvent
  | ContextCompactedEvent
  | ImageAttachedEvent
  | UnknownEvent;

export interface EventMsg extends EventEnvelope {
  [key: string]: unknown;
}

/* ---------------- ui payloads ---------------- */

/** `ui(state).todos[]`. */
export interface TodoRow {
  content: string;
  status: TodoStatus;
}

/** `ui(state).skills[]` — pointers only; the body is L2 and needs a tool call. */
export interface SkillPointer {
  name: string;
  digest: string;
}

/** First snapshot only. The description lives here, not on the pointer. */
export interface SkillCatalogRow {
  name: string;
  description: string;
}

/** `ui(state).jobs[]`. Unfinished first; the state is computed by the runtime. */
export interface JobRow {
  id: string;
  command: string;
  state: JobState;
  seconds: number;
  exit_code: number | null;
}

/** `ui(state).subagents[]` — `internal/subagent/board.go` `Board.Panel()`. */
export interface SubagentRow {
  id: string;
  label: string;
  model: string;
  provider: string;
  depth: number;
  /** Elapsed seconds, not a start timestamp. */
  seconds: number;
  steps: number;
  tool_calls: number;
  activity: string;
}

/** `ui(state).mcp[]`. The `error` key only appears on `ui(mcp)`. */
export interface McpRow {
  name: string;
  state: McpState;
  tools: number;
  error?: string;
  where: string;
}

export interface RiskScopeRow {
  risk: RiskLevel;
  disposition: RiskDisposition;
}

/** `ui(state).agents_md[]` — where this session's AGENT.md went. */
export interface AgentsMdRow {
  path: string;
  lines: number;
  status: string;
  problem?: string;
}

/**
 * The goal panel.
 *
 * Both shapes are present in both cases: with no goal the runtime sends the
 * empty one rather than omitting the key.
 */
export interface GoalSnapshot {
  id: string;
  objective: string;
  phase: string;
  revision?: number;
  rounds?: number;
  max_rounds?: number;
  rounds_text?: string;
  limit_reached?: boolean;
  armed: boolean;
  blocked_code?: string;
  blocked_message?: string;
}

/**
 * `ui(state)`.
 *
 * Empty lists go out as `[]`, never `null`: the interface never has to tell
 * "there are none" apart from "the runtime did not say".
 */
export interface UiStateMsg {
  v: number;
  t: 'ui';
  kind: 'state';
  todos: TodoRow[];
  skills: SkillPointer[];
  skill_catalog?: SkillCatalogRow[];
  jobs: JobRow[];
  subagents: SubagentRow[];
  messages: number;
  steps: number;
  model: string;
  model_provider: string;
  /** Null = the catalogue does not name this model. Report amount only. */
  model_window: number | null;
  thinking: boolean;
  effort: string;
  effort_levels: string[];
  autopilot: boolean;
  granted_tools: string[];
  granted_prefixes: string[];
  denied_tools: string[];
  risk_scope: RiskScopeRow[];
  agents_md: AgentsMdRow[];
  mcp: McpRow[];
  goal: GoalSnapshot;
}

/** `ui(status).status` — grouped on purpose; the screen spans four layers. */
export interface StatusGroup {
  session: {
    id: string;
    resumed: boolean;
    workspace: string;
    messages: number;
    steps: number;
  };
  model: {
    provider: string;
    current: string;
    selected: string;
    last_used: string;
    since: number;
    window: number | null;
    base_url: string;
    /** An object, not the effort string. Reading `reasoning["thinking"]` off a
     *  string yields nothing and the front end silently falls back. */
    reasoning: { thinking: boolean; effort: string };
  };
  counters: Record<string, number>;
  usage: Record<string, number>;
  /** Null when this runtime has no context layer — a different statement from
   *  a row of zeroes. */
  context: Record<string, unknown> | null;
  meta: {
    max_steps: number;
    stream: boolean;
    autopilot: boolean;
    tool_count: number;
    audit_path: string;
    permissions: PermissionScope;
    started: string;
    catalog: string;
  };
}

export interface UiStatusMsg {
  v: number;
  t: 'ui';
  kind: 'status';
  status: StatusGroup;
  last_prompt_tokens: number | null;
  context_tokens: number | null;
}

export interface ToolRow {
  name: string;
  risk: RiskLevel;
  disposition: Disposition;
  parallel_safe: boolean;
  interactive: boolean;
  external: boolean;
  /** The user pressed `t` for this one. */
  granted: boolean;
  /** The argument that holds a command line, when the tool has one. */
  command: string | null;
}

export interface UiToolsMsg {
  v: number;
  t: 'ui';
  kind: 'tools';
  tools: ToolRow[];
  granted_prefixes: string[];
}

export interface UiMcpMsg {
  v: number;
  t: 'ui';
  kind: 'mcp';
  mcp_servers: McpRow[];
  /** Whole sentences, already prefixed with `[MCP]` by the runtime. */
  mcp_notes: string[];
}

/** The context layer's own numbers (`internal/context/manager.go` `Stats`). */
export interface ContextLedger {
  artifacts?: number;
  items?: number;
  compact?: number;
  open?: number;
  removed?: number;
  pinned?: number;
  stable?: number;
  dynamic?: number;
  estimated_tokens?: number;
  limit_tokens?: number;
  compact_threshold?: number;
  /** **A count, not a flag**: `len(m.LastDegraded)` — how many items were
   *  degraded, 0 when none. */
  degraded?: number;
  version?: number;
  [key: string]: unknown;
}

/**
 * The "context feature" container.
 *
 * The nesting is deliberate (`internal/runtime/composition.go` `ContextMessage`
 * / `contextPayload`): this object is "the context feature" and `context` inside
 * it is the ledger. An absent container means there is no context management
 * here, which must read as that rather than as a row of zeroes.
 *
 * **Everything** the message carries lives here — `window`, `messages`,
 * `active`, `folded` included — because that is what the runtime actually sends:
 *
 *   {"v":1,"t":"ui","kind":"context","context":{
 *      "context":{"estimated_tokens":3791,"limit_tokens":896313,…},
 *      "window":1000000,"messages":1,"active":false,"folded":0}}
 *
 * Verified against real bytes in `tests/fixtures/opening.jsonl`.
 */
export interface ContextFeature {
  /** The ledger itself, or absent when there is no context layer. */
  context?: ContextLedger;
  window?: number | null;
  messages?: number;
  active?: boolean;
  folded?: number;
  generation?: number;
  summary_id?: string;
  summary_chars?: number;
}

export interface UiContextMsg {
  v: number;
  t: 'ui';
  kind: 'context';
  context?: ContextFeature;
}

export interface CompactionResult {
  /** `compacted` / `nothing` / `busy` / `no_context`. Failure and "nothing to
   *  fold" collapse into `nothing` on purpose. */
  status: string;
  folded?: number;
  total_folded?: number;
  summary_id?: string;
  summary_chars?: number;
  generation?: number;
  before?: number;
  after?: number;
  duration_ms?: number;
}

export interface UiCompactedMsg {
  v: number;
  t: 'ui';
  kind: 'compacted';
  compaction: CompactionResult;
  /** The same container `ui(context)` carries (`contextPayload`). */
  context?: ContextFeature;
}

export interface SkillRow {
  name: string;
  description: string;
  active?: boolean;
  [key: string]: unknown;
}

export interface UiSkillsMsg {
  v: number;
  t: 'ui';
  kind: 'skills';
  skills: SkillRow[];
  active: unknown[];
  roots: unknown[];
  /** Rendered problem lines, already written by the runtime. */
  problems: string[];
  shadowed: string[];
}

export interface UiRunFinishedMsg {
  v: number;
  t: 'ui';
  kind: 'run_finished';
  /** This turn's final body. In non-streaming mode the only way to get it. */
  answer: string;
  run_id: string;
}

export type UiMsg =
  | UiStateMsg
  | UiStatusMsg
  | UiToolsMsg
  | UiMcpMsg
  | UiContextMsg
  | UiCompactedMsg
  | UiSkillsMsg
  | UiRunFinishedMsg;

/* ---------------- the rest ---------------- */

export interface DeltaMsg {
  v: number;
  t: 'delta';
  session_id: string;
  run_id: string;
  step: number;
  channel: DeltaChannel;
  /** The new piece, not the accumulated body. */
  text: string;
  /** Reserved; always false. Clearing is `delta_reset`. */
  reset: boolean;
}

export interface DeltaResetMsg {
  v: number;
  t: 'delta_reset';
  session_id: string;
  run_id: string;
  /** Clears that step only — earlier steps must survive a retry. */
  step: number;
}

export interface NoticeMsg {
  v: number;
  t: 'notice';
  level: NoticeLevel;
  /** Machine-readable category. */
  code: string;
  /** Already written for a person; display verbatim. */
  text: string;
}

export interface SessionListItem {
  session_id: string;
  messages: number;
  steps: number;
  /** Ready-made progress text; empty string means no tasks. */
  todos: string;
  /** Truncated preview of the first user message; empty means never spoke. */
  preview: string;
  /** Epoch **seconds**, or null when the file could not be read. */
  modified_at: number | null;
}

export interface SessionsMsg {
  v: number;
  t: 'sessions';
  items: SessionListItem[];
}

/**
 * Blocking modal one: approval.
 *
 * `arguments` is the full text — never truncated. It is not an event's
 * companion field; it *is* the material a person judges from, and the important
 * half of a risky command is usually at the end.
 */
export interface PermissionRequestMsg {
  v: number;
  t: 'permission_request';
  id: string;
  call_id: string;
  tool: string;
  risk: RiskLevel;
  arguments: Record<string, unknown>;
  /** What would be written to permissions.json. Null means there is nothing to
   *  remember, so "always allow" must not be shown. */
  remember: Record<string, unknown> | null;
  /** Display verbatim, not one character changed, never translated. */
  remember_hint: string | null;
  /** False means the "allow all" button must be hidden. */
  allow_trust_all: boolean;
  /** Also verbatim. It carries one extra job: saying this is a snapshot. */
  trust_all_hint: string | null;
}

/**
 * Blocking modal two: a question.
 *
 * `options` is a `string[]` — an empty array means free-form. Answers are only
 * `answered` / `skipped`; `unavailable` is produced by the runtime and is never
 * sent by a front end.
 */
export interface QuestionRequestMsg {
  v: number;
  t: 'question_request';
  id: string;
  question: string;
  /** At most 12 characters; empty means there is none. */
  header: string;
  options: string[];
  multi_select: boolean;
}

/**
 * The client's own message, not the runtime's: it is synthesized when the child
 * process ends without being asked to. No payload on the wire — the exit code
 * and the `requested` flag come from the bridge.
 */
export interface RuntimeExitedMsg {
  v: number;
  t: 'runtime_exited';
  code: number;
  /** True when we asked for the shutdown. Both cases exit with code 0, so this
   *  boolean is the only thing that tells "the session ended" from "the runtime
   *  died". */
  requested: boolean;
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
  | QuestionRequestMsg
  | RuntimeExitedMsg;

/* ============================================================
   Front end -> runtime
   ============================================================ */

export type McpAction = 'list' | 'load' | 'unload';

export type GoalAction = 'pause' | 'resume' | 'clear';

export type FrontendMsg =
  | { v: number; t: 'user_message'; text: string }
  | { v: number; t: 'permission_response'; id: string; decision: PermissionDecision }
  | { v: number; t: 'question_response'; id: string; status: QuestionStatus; text: string }
  /** Missing or null `session_id` means a new session; an id whose file does not
   *  exist means a new session too. */
  | { v: number; t: 'session_switch'; session_id?: string | null }
  | { v: number; t: 'session_list' }
  | { v: number; t: 'interrupt' }
  | { v: number; t: 'set_autopilot'; on: boolean }
  | { v: number; t: 'set_model'; model: string }
  | { v: number; t: 'set_thinking'; on: boolean }
  | { v: number; t: 'set_effort'; effort: string }
  | { v: number; t: 'status' }
  | { v: number; t: 'tools' }
  | { v: number; t: 'context' }
  | { v: number; t: 'compact' }
  | { v: number; t: 'skills' }
  /** `action` omitted means "just report the state". */
  | { v: number; t: 'goal'; action?: GoalAction }
  /** Only send this when you know something of yours is outstanding. */
  | { v: number; t: 'refresh_state' }
  | { v: number; t: 'mcp'; action: McpAction; servers: string[] }
  | { v: number; t: 'shutdown' };

/* ============================================================
   Decoding
   ============================================================ */

export interface DecodeResult {
  msg: RuntimeMsg | null;
  /** Why the line was dropped, when it was. */
  reason?: string;
  /**
   * A dropped line the front end may count and continue past, or a dropped line
   * that means the two ends cannot talk at all.
   *
   * The distinction matters because the two have different answers. A malformed
   * line is a real thing — half a line is what a killed writer leaves — and the
   * stream carries on. An envelope version mismatch does not: every following
   * line will fail the same check, so counting them one by one produces a
   * plausible-looking "N dropped" instead of "this runtime speaks v=2 and this
   * build only knows v=1" — which is the one thing the reader needs (§4.1).
   */
  fatal?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turn one protocol line into a message.
 *
 * Tolerance follows the schema: a malformed line is skipped and counted, never
 * treated as a stream failure — half a line is a real thing (the writer was
 * killed). A version mismatch is the one hard failure, and it is reported as
 * such rather than silently dropped.
 */
export function decodeLine(line: string): DecodeResult {
  const trimmed = line.trim();
  if (trimmed === '') return { msg: null, reason: 'empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { msg: null, reason: 'unparseable' };
  }
  if (!isRecord(parsed)) return { msg: null, reason: 'not-an-object' };

  const v = parsed['v'];
  if (typeof v !== 'number') return { msg: null, reason: 'missing-envelope-version' };
  if (v !== ENVELOPE_VERSION) {
    // The one hard failure: no line from this runtime will ever pass this check.
    return { msg: null, reason: `envelope-version-mismatch:${v}`, fatal: true };
  }

  const t = parsed['t'];
  if (typeof t !== 'string') return { msg: null, reason: 'missing-type' };

  // Unknown types are ignored on purpose, not an error.
  switch (t) {
    case 'init':
    case 'session_load':
    case 'event':
    case 'ui':
    case 'delta':
    case 'delta_reset':
    case 'notice':
    case 'sessions':
    case 'permission_request':
    case 'question_request':
      return { msg: parsed as unknown as RuntimeMsg };
    case 'runtime_exited':
      return { msg: parsed as unknown as RuntimeMsg };
    default:
      return { msg: null, reason: `unknown-type:${t}` };
  }
}
