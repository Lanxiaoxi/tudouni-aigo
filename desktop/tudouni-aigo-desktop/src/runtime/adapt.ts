/**
 * The projection layer: real protocol -> the shapes the interface draws.
 *
 * It is a set of **pure functions**, and that is the whole point: every number
 * on screen stays traceable to a protocol message, and the interface's entry
 * points do not move when the wire does.
 *
 * Two rules, both from §5.4 of the design:
 *   - **No default fallbacks.** If a fact is not in the protocol, the view model
 *     says "unknown" (null) rather than inventing a number. A plausible wrong
 *     value is worse than a visible gap.
 *   - **No derivation of runtime facts.** Job states, dispositions, session
 *     progress and previews are computed by the runtime. This file maps, it does
 *     not decide.
 */

import type {
  AgentsMdRow,
  CompactionResult,
  ContextLedger,
  GoalSnapshot,
  InitMsg,
  JobRow,
  McpRow,
  ModelAlias,
  ModelCatalogRow,
  PermissionScope,
  RiskLevel,
  RiskScopeRow,
  SessionListItem,
  SessionMessage,
  SkillCatalogRow,
  SkillPointer,
  StatusGroup,
  SubagentRow,
  TodoRow,
  TodoStatus,
  ToolRow,
  UiCompactedMsg,
  UiContextMsg,
  UiMcpMsg,
  UiSkillsMsg,
  UiStateMsg,
  UiStatusMsg,
  UiToolsMsg,
} from '@/protocol/types';

/* ============================================================
   The status bar's coarse phase
   ============================================================ */

/** Mirrors the TUI's vocabulary so both front ends read the same way. */
export type Phase =
  | 'booting'
  | 'idle'
  | 'running'
  | 'done'
  | 'step_limit'
  | 'failed'
  | 'interrupted'
  /** The turn finished with no text at all. Not a failure, and not "done"
   *  either: "Done" over a blank body reads as "your answer was lost". */
  | 'empty'
  /** The turn was cut off because the runtime process went away. Its own word:
   *  "Done" would claim the answer finished, and "Failed" would blame the
   *  model. */
  | 'runtime_gone';

/**
 * Map a `run_finished.stop_reason` onto the phase.
 *
 * The distinctions are the ones a reader acts on: "finished", "hit the step
 * limit", "you stopped it" and "the model failed" must not share a word.
 *
 * `empty_response` gets its own phase. It is not a failure — nothing errored —
 * but "Done" over a blank turn is a lie the reference front end explicitly
 * refuses to tell (`internal/frontends/tui/model.go:956`: "the only thing that
 * makes the fixed wording readable is a line saying that the blank space is the
 * whole story"). Reading "Done" over an empty body, a person concludes their
 * answer was lost.
 */
export function phaseFromStopReason(reason: string): Phase {
  switch (reason) {
    case 'max_steps':
      return 'step_limit';
    case 'cancelled':
      return 'interrupted';
    case 'model_error':
    case 'model_fatal':
      return 'failed';
    case 'empty_response':
      return 'empty';
    // Synthesized by `settleAbandonedTurn`, not by the runtime: it is what the
    // turn head is closed with when the child disappears mid-turn.
    case 'runtime_exited':
      return 'runtime_gone';
    default:
      return 'done';
  }
}

/* ============================================================
   View-model shapes
   ============================================================ */

export interface VmGoal {
  /** False when the runtime sent the empty shape. The key is always present. */
  present: boolean;
  id: string;
  objective: string;
  phase: string;
  roundsText: string;
  armed: boolean;
  limitReached: boolean;
  blockedCode: string;
  blockedMessage: string;
}

export interface VmTask {
  content: string;
  status: TodoStatus;
}

export interface VmSkill {
  name: string;
  digest: string;
  /** From the first snapshot's catalog, which is the only place it lives. */
  description: string | null;
}

export interface VmJob {
  id: string;
  command: string;
  state: JobRow['state'];
  seconds: number;
  exitCode: number | null;
  /** `running` or `uncollected` — the two states that mean "somebody still has
   *  to look at this". Computed by the runtime, carried through unchanged. */
  outstanding: boolean;
  /** The one that fails silently: the command finished and nobody read it. */
  uncollected: boolean;
}

export interface VmSubagent {
  id: string;
  label: string;
  model: string;
  provider: string;
  depth: number;
  seconds: number;
  steps: number;
  toolCalls: number;
  activity: string;
}

export interface VmMcp {
  name: string;
  state: McpRow['state'];
  tools: number;
  where: string;
  /** Only present on a `failed` row. */
  error: string | null;
}

export interface VmRiskScope {
  risk: RiskScopeRow['risk'];
  disposition: RiskScopeRow['disposition'];
}

export interface VmAgentsMd {
  path: string;
  lines: number;
  status: string;
  problem: string | null;
}

export interface VmTool {
  name: string;
  risk: ToolRow['risk'];
  disposition: ToolRow['disposition'];
  parallelSafe: boolean;
  interactive: boolean;
  external: boolean;
  granted: boolean;
  command: string | null;
}

/**
 * A registry row as the handshake carries it.
 *
 * It is narrower than a `ui(tools)` row on purpose: `init` says what the tool
 * *is* (risk, whether it holds the input, whether it leaves the machine), while
 * `ui(tools)` adds what the runtime has since *decided* about it
 * (`disposition`, `granted`, `command`). The missing ones stay null until
 * `ui(tools)` answers — never guessed.
 */
export interface VmInitTool {
  name: string;
  risk: RiskLevel | null;
  parallelSafe: boolean;
  interactive: boolean;
}

export interface VmModel {
  provider: string;
  id: string;
  label: string;
  /** Null when the catalogue does not name a window. Never guessed. */
  window: number | null;
  summary: string;
  note: string;
  vision: boolean;
  current: boolean;
  effort: string;
  effortLevels: string[];
}

export interface VmSessionListItem {
  id: string;
  messages: number;
  steps: number;
  /** Ready-made progress text; empty means no tasks. */
  todos: string;
  /** Empty means the session never spoke. */
  preview: string;
  /** Epoch **seconds**, or null when unreadable. */
  modifiedAt: number | null;
}

export interface VmCompaction {
  status: string;
  folded: number;
  totalFolded: number;
  summaryId: string;
  summaryChars: number;
  generation: number;
  before: number | null;
  after: number | null;
  durationMs: number | null;
}

/** The context ledger, with "unknown" kept distinct from zero. */
export interface VmContext {
  present: boolean;
  used: number | null;
  window: number | null;
  percent: number | null;
  estimatedTokens: number | null;
  limitTokens: number | null;
  compactThreshold: number | null;
  artifacts: number | null;
  items: number | null;
  open: number | null;
  removed: number | null;
  pinned: number | null;
  /** A **count** of degraded items (`len(LastDegraded)`), or null when the
   *  ledger did not say. Zero and "unknown" are different statements. */
  degraded: number | null;
  messages: number | null;
  active: boolean | null;
  folded: number | null;
  summaryChars: number | null;
}

/** The permission facts, all of them runtime-computed. */
export interface VmPermissionScope {
  autopilot: boolean;
  /** Only non-default entries; an ordinary run sends none of them. */
  autoApprove: string[];
  autoApproveTools: string[];
  denyTools: string[];
  shellAllow: string[];
  grantedTools: string[];
  grantedPrefixes: string[];
  deniedTools: string[];
  riskScope: VmRiskScope[];
}

export interface VmStatus {
  counters: Record<string, number>;
  usage: Record<string, number>;
  meta: StatusGroup['meta'] | null;
  lastPromptTokens: number | null;
  /** The window `status` reports. It travels with the usage numbers. */
  window: number | null;
}

/** One `ui(state)` snapshot, projected. */
export interface VmState {
  todos: VmTask[];
  skills: VmSkill[];
  /** First snapshot only; the later ones omit it on purpose. */
  skillCatalog: SkillCatalogRow[];
  jobs: VmJob[];
  subagents: VmSubagent[];
  mcp: VmMcp[];
  goal: VmGoal;
  riskScope: VmRiskScope[];
  agentsMd: VmAgentsMd[];
  messages: number;
  steps: number;
  model: string;
  modelProvider: string;
  modelWindow: number | null;
  thinking: boolean;
  effort: string;
  effortLevels: string[];
  autopilot: boolean;
  permission: VmPermissionScope;
}

/* ============================================================
   Projections
   ============================================================ */

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bool(value: unknown): boolean {
  return value === true;
}

/** Narrow a wire string to a risk level. Anything else is unknown, not "low". */
export function riskLevel(value: unknown): RiskLevel | null {
  return value === 'low' || value === 'medium' || value === 'high' ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

export function projectGoal(raw: GoalSnapshot | undefined): VmGoal {
  if (!raw) {
    return {
      present: false,
      id: '',
      objective: '',
      phase: '',
      roundsText: '',
      armed: false,
      limitReached: false,
      blockedCode: '',
      blockedMessage: '',
    };
  }
  const objective = str(raw.objective);
  return {
    // The runtime always sends the key; the empty shape is how it says "none".
    present: objective !== '' || str(raw.id) !== '',
    id: str(raw.id),
    objective,
    phase: str(raw.phase),
    roundsText: str(raw.rounds_text),
    armed: bool(raw.armed),
    limitReached: bool(raw.limit_reached),
    blockedCode: str(raw.blocked_code),
    blockedMessage: str(raw.blocked_message),
  };
}

export function projectTodos(rows: TodoRow[] | undefined): VmTask[] {
  return (rows ?? []).map((row) => ({
    content: str(row.content),
    status: row.status,
  }));
}

/**
 * Merge the two skill sources.
 *
 * `ui(state).skills` is pointers only (`name` + `digest`) — the body is L2 and
 * needs a tool call. The description lives in the first snapshot's
 * `skill_catalog`. Neither list alone answers "which skills are loaded, and what
 * are they", so the panel reads both.
 */
export function projectSkills(
  pointers: SkillPointer[] | undefined,
  catalog: SkillCatalogRow[] | undefined,
): VmSkill[] {
  const described = new Map<string, string>();
  for (const row of catalog ?? []) described.set(str(row.name), str(row.description));
  return (pointers ?? []).map((row) => ({
    name: str(row.name),
    digest: str(row.digest),
    description: described.get(str(row.name)) ?? null,
  }));
}

export function projectJobs(rows: JobRow[] | undefined): VmJob[] {
  return (rows ?? []).map((row) => {
    const state = row.state;
    return {
      id: str(row.id),
      command: str(row.command),
      state,
      seconds: num(row.seconds) ?? 0,
      exitCode: num(row.exit_code),
      outstanding: state === 'running' || state === 'uncollected',
      uncollected: state === 'uncollected',
    };
  });
}

export function projectSubagents(rows: SubagentRow[] | undefined): VmSubagent[] {
  return (rows ?? []).map((row) => ({
    id: str(row.id),
    label: str(row.label),
    model: str(row.model),
    provider: str(row.provider),
    depth: num(row.depth) ?? 0,
    seconds: num(row.seconds) ?? 0,
    steps: num(row.steps) ?? 0,
    toolCalls: num(row.tool_calls) ?? 0,
    activity: str(row.activity),
  }));
}

export function projectMcp(rows: McpRow[] | undefined): VmMcp[] {
  return (rows ?? []).map((row) => ({
    name: str(row.name),
    state: row.state,
    tools: num(row.tools) ?? 0,
    where: str(row.where),
    error: typeof row.error === 'string' && row.error !== '' ? row.error : null,
  }));
}

export function projectRiskScope(rows: RiskScopeRow[] | undefined): VmRiskScope[] {
  return (rows ?? []).map((row) => ({ risk: row.risk, disposition: row.disposition }));
}

export function projectAgentsMd(rows: AgentsMdRow[] | undefined): VmAgentsMd[] {
  return (rows ?? []).map((row) => ({
    path: str(row.path),
    lines: num(row.lines) ?? 0,
    status: str(row.status),
    problem: typeof row.problem === 'string' && row.problem !== '' ? row.problem : null,
  }));
}

export function projectTools(rows: ToolRow[] | undefined): VmTool[] {
  return (rows ?? []).map((row) => ({
    name: str(row.name),
    risk: row.risk,
    disposition: row.disposition,
    parallelSafe: bool(row.parallel_safe),
    interactive: bool(row.interactive),
    external: bool(row.external),
    granted: bool(row.granted),
    command: typeof row.command === 'string' ? row.command : null,
  }));
}

export function projectModels(catalog: { models?: ModelCatalogRow[] } | undefined): VmModel[] {
  return (catalog?.models ?? []).map((row) => ({
    provider: str(row.provider),
    id: str(row.id),
    label: str(row.label),
    window: num(row.window),
    summary: str(row.summary),
    note: str(row.note),
    vision: bool(row.vision),
    current: bool(row.current),
    effort: str(row.effort),
    effortLevels: strings(row.effort_levels),
  }));
}

/**
 * Session list rows.
 *
 * The sort key is creation time and it is not in the payload, so the order the
 * runtime sent is preserved; `modifiedAt` is what gets *shown* ("last talked
 * to"), and it is a different fact from the order.
 */
export function projectSessionList(items: SessionListItem[] | undefined): VmSessionListItem[] {
  return (items ?? []).map((row) => ({
    id: str(row.session_id),
    messages: num(row.messages) ?? 0,
    steps: num(row.steps) ?? 0,
    todos: str(row.todos),
    preview: str(row.preview),
    modifiedAt: num(row.modified_at),
  }));
}

export function projectCompaction(raw: CompactionResult | undefined): VmCompaction | null {
  if (!raw) return null;
  return {
    status: str(raw.status),
    folded: num(raw.folded) ?? 0,
    totalFolded: num(raw.total_folded) ?? 0,
    summaryId: str(raw.summary_id),
    summaryChars: num(raw.summary_chars) ?? 0,
    generation: num(raw.generation) ?? 0,
    before: num(raw.before),
    after: num(raw.after),
    durationMs: num(raw.duration_ms),
  };
}

function projectLedger(ledger: ContextLedger | undefined): Partial<VmContext> {
  if (!ledger) return {};
  return {
    estimatedTokens: num(ledger.estimated_tokens),
    limitTokens: num(ledger.limit_tokens),
    compactThreshold: num(ledger.compact_threshold),
    artifacts: num(ledger.artifacts),
    items: num(ledger.items),
    open: num(ledger.open),
    removed: num(ledger.removed),
    pinned: num(ledger.pinned),
    // A count on the wire (`len(LastDegraded)`), so null means "unknown" and 0
    // means "none degraded" — two different statements.
    degraded: num(ledger.degraded),
  };
}

const EMPTY_CONTEXT: VmContext = {
  present: false,
  used: null,
  window: null,
  percent: null,
  estimatedTokens: null,
  limitTokens: null,
  compactThreshold: null,
  artifacts: null,
  items: null,
  open: null,
  removed: null,
  pinned: null,
  degraded: null,
  messages: null,
  active: null,
  folded: null,
  summaryChars: null,
};

/** The percentage is only computed when the window is known. */
function usagePercent(used: number | null, window: number | null): number | null {
  if (used === null || window === null || window <= 0) return null;
  return used / window;
}

export function projectContext(msg: UiContextMsg): VmContext {
  // Everything lives inside the "context feature" container: the ledger is
  // `msg.context.context`, and `window` / `messages` / `active` / `folded` sit
  // beside it on that same container.
  //
  // This shape is not inferred — it is what the runtime sends, frozen in
  // `tests/fixtures/opening.jsonl`:
  //
  //   {"v":1,"t":"ui","kind":"context","context":{
  //      "context":{"estimated_tokens":3791,…},"window":1000000,"messages":1}}
  //
  // Reading the ledger off `msg.context` (one level too high) is what made every
  // number in the panel `unknown`.
  const feature = msg.context;
  const ledger = projectLedger(feature?.context);
  const window = num(feature?.window);
  const used = ledger.estimatedTokens ?? null;
  return {
    ...EMPTY_CONTEXT,
    ...ledger,
    // Absent inner object = no context management here, which is not the same
    // as a ledger full of zeroes.
    present: feature?.context !== undefined,
    used,
    window,
    percent: usagePercent(used, window),
    messages: num(feature?.messages),
    active: typeof feature?.active === 'boolean' ? feature.active : null,
    folded: num(feature?.folded),
    summaryChars: num(feature?.summary_chars),
  };
}

/**
 * The live permission facts.
 *
 * What is *not* here matters: the config-level scope (`auto_approve`,
 * `auto_approve_tools`, `shell_allow`) travels on `init` and `ui(status).meta`
 * only, because those are the messages that carry the configuration. A snapshot
 * has the runtime's live answers instead — the granted lists and the risk scope
 * — and those are the ones that change while a session runs.
 */
export function projectState(msg: UiStateMsg): VmState {
  const permission: VmPermissionScope = {
    autopilot: bool(msg.autopilot),
    autoApprove: [],
    autoApproveTools: [],
    denyTools: strings(msg.denied_tools),
    shellAllow: [],
    grantedTools: strings(msg.granted_tools),
    grantedPrefixes: strings(msg.granted_prefixes),
    deniedTools: strings(msg.denied_tools),
    riskScope: projectRiskScope(msg.risk_scope),
  };
  return {
    todos: projectTodos(msg.todos),
    skills: projectSkills(msg.skills, msg.skill_catalog),
    skillCatalog: msg.skill_catalog ?? [],
    jobs: projectJobs(msg.jobs),
    subagents: projectSubagents(msg.subagents),
    mcp: projectMcp(msg.mcp),
    goal: projectGoal(msg.goal),
    riskScope: projectRiskScope(msg.risk_scope),
    agentsMd: projectAgentsMd(msg.agents_md),
    messages: num(msg.messages) ?? 0,
    steps: num(msg.steps) ?? 0,
    model: str(msg.model),
    modelProvider: str(msg.model_provider),
    modelWindow: num(msg.model_window),
    thinking: bool(msg.thinking),
    effort: str(msg.effort),
    effortLevels: strings(msg.effort_levels),
    autopilot: bool(msg.autopilot),
    permission,
  };
}

/**
 * The `init` handshake, projected.
 *
 * Note what is *not* here: a product version, a locale, a user name, a theme
 * list. The protocol carries none of them (§5.3). The desktop's own version is
 * its own business; the runtime's version comes from `--version`; the greeting's
 * user name comes from the OS; and there is exactly one theme, the system's.
 */
export interface VmInit {
  sessionId: string;
  resumed: boolean;
  workspace: string;
  model: string;
  provider: string;
  thinking: boolean;
  effort: string;
  effortLevels: string[];
  models: VmModel[];
  /** Names the runtime accepts that are not in the list. They are still
   *  callable, and the panel shows them labelled rather than hiding them. */
  modelAliases: ModelAlias[];
  maxSteps: number;
  stream: boolean;
  contextTokens: number | null;
  auditPath: string;
  permissions: PermissionScope;
  /**
   * `init.tools[]` — name, risk, parallel_safe, interactive.
   *
   * The handshake's registry is the **only** place these facts exist until
   * `ui(tools)` is asked for. `tool_call` events carry no risk of their own, so
   * without this the risk badge is permanently unknown on every tool row.
   */
  tools: VmInitTool[];
  notices: Array<{ level: 'info' | 'warn'; code: string; text: string }>;
  protocol: number;
}

export function projectInit(msg: InitMsg): VmInit {
  return {
    sessionId: str(msg.session_id),
    resumed: bool(msg.resumed),
    workspace: str(msg.workspace),
    model: str(msg.model),
    provider: str(msg.provider),
    thinking: bool(msg.thinking),
    effort: str(msg.effort),
    effortLevels: strings(msg.effort_levels),
    models: projectModels(msg.model_catalog),
    modelAliases: (msg.model_catalog?.aliases ?? []).map((alias) => ({
      id: str(alias.id),
      of: str(alias.of),
    })),
    maxSteps: num(msg.max_steps) ?? 0,
    stream: bool(msg.stream),
    contextTokens: num(msg.context_tokens),
    auditPath: str(msg.audit_path),
    permissions: msg.permissions ?? {},
    tools: (msg.tools ?? []).map((tool) => ({
      name: str(tool.name),
      risk: riskLevel(tool.risk),
      parallelSafe: bool(tool.parallel_safe),
      interactive: bool(tool.interactive),
    })),
    notices: (msg.notices ?? []).map((item) => ({
      level: item.level,
      code: str(item.code),
      text: str(item.text),
    })),
    protocol: num(msg.protocol) ?? 0,
  };
}

export function projectStatus(msg: UiStatusMsg): VmStatus {
  return {
    counters: (msg.status?.counters ?? {}) as Record<string, number>,
    usage: (msg.status?.usage ?? {}) as Record<string, number>,
    meta: msg.status?.meta ?? null,
    lastPromptTokens: num(msg.last_prompt_tokens),
    window: num(msg.context_tokens),
  };
}

export function projectToolsMsg(msg: UiToolsMsg): { tools: VmTool[]; grantedPrefixes: string[] } {
  return {
    tools: projectTools(msg.tools),
    grantedPrefixes: strings(msg.granted_prefixes),
  };
}

export function projectMcpMsg(msg: UiMcpMsg): { servers: VmMcp[]; notes: string[] } {
  return {
    servers: projectMcp(msg.mcp_servers),
    notes: strings(msg.mcp_notes),
  };
}

/**
 * Attach each note to the server it names.
 *
 * The runtime has no `failed` state on the wire: `mcpInventory` only ever writes
 * `loaded` or `unload`, and a server that would not connect is reported as a
 * **sentence** — `mcp.host.load_failed`, "server \`name\` did not connect
 * (problem); press again to retry". So on the row itself, "configured and never
 * loaded" and "we tried and it failed" look identical, and the only place the
 * difference appeared was a note group at the bottom of the panel.
 *
 * This is attribution, not inference: the note is the runtime's own sentence and
 * it names its server in backticks, which is the format `internal/i18n/en.go`
 * writes. Nothing is decided about the server's state here — the sentence is
 * simply shown next to the row it is about, where a reader looking at that
 * server will see it.
 */
export function notesByServer(servers: VmMcp[], notes: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const note of notes) {
    // A name is matched only inside backticks, and only against a server that
    // exists: a note mentioning a file path or an unconfigured name then simply
    // stays in the general list rather than being attached to the wrong row.
    for (const server of servers) {
      if (server.name === '') continue;
      if (!note.includes(`\`${server.name}\``)) continue;
      const bucket = out.get(server.name) ?? [];
      bucket.push(note);
      out.set(server.name, bucket);
    }
  }
  return out;
}

export function projectSkillsMsg(msg: UiSkillsMsg): {
  /** The whole set this session **can load** — not the loaded ones. */
  available: VmSkill[];
  /** The names actually loaded, in load order (`skills.ActiveNames`). */
  active: string[];
  problems: string[];
  shadowed: string[];
} {
  return {
    available: (msg.skills ?? []).map((row) => ({
      name: str(row.name),
      // `ui(skills)` rows carry no digest: this is the catalogue, not the
      // pointers. The digest is a fact about the *loaded* entry and travels on
      // `ui(state).skills` — so it is left empty here and merged in from there,
      // rather than being invented.
      digest: '',
      description: str(row.description) === '' ? null : str(row.description),
    })),
    // The one field that answers "what is loaded". Declared in the type since
    // the beginning and never read, which is how the whole catalogue came to be
    // shown under the "loaded" badge.
    active: strings(msg.active),
    problems: strings(msg.problems),
    shadowed: strings(msg.shadowed),
  };
}

/**
 * Merge the four skill facts the runtime sends into the two lists the interface
 * draws.
 *
 * They are genuinely different facts and the wire keeps them apart:
 *   - `ui(skills).skills`  — everything this session *can* load (the catalogue)
 *   - `ui(skills).active`  — the names *actually loaded*, in load order
 *   - `ui(state).skills`   — pointers for the loaded ones (`name` + `digest`)
 *   - `ui(state).skill_catalog` — one-line descriptions (first snapshot only)
 *
 * "Loaded" is therefore `active`, and the catalogue's interesting part is the
 * **difference** — what a person could still load. Deriving "loaded" from the
 * catalogue instead made the difference always empty.
 */
export function mergeSkills(
  pointers: VmSkill[],
  catalog: SkillCatalogRow[],
  available: VmSkill[],
  active: string[],
): { loaded: VmSkill[]; available: VmSkill[] } {
  const descriptionOf = new Map<string, string>();
  for (const row of catalog) {
    if (str(row.description) !== '') descriptionOf.set(str(row.name), str(row.description));
  }
  for (const row of available) {
    if (row.description !== null && !descriptionOf.has(row.name)) {
      descriptionOf.set(row.name, row.description);
    }
  }
  const digestOf = new Map<string, string>();
  for (const row of pointers) {
    if (row.digest !== '') digestOf.set(row.name, row.digest);
  }

  // `active` is authoritative when it was sent. With nothing loaded it is an
  // empty list, and then the pointers are still a real (if redundant) source —
  // a runtime that reports pointers but not names is one this build tolerates.
  const names = active.length > 0 ? active : pointers.map((row) => row.name);

  const loaded: VmSkill[] = names.map((name) => ({
    name,
    digest: digestOf.get(name) ?? '',
    description: descriptionOf.get(name) ?? null,
  }));
  const loadedNames = new Set(names);
  const rest = available.filter((row) => !loadedNames.has(row.name));

  return { loaded, available: rest };
}

export function projectCompacted(msg: UiCompactedMsg): {
  compaction: VmCompaction | null;
  context: VmContext | null;
} {
  return {
    compaction: projectCompaction(msg.compaction),
    // `context` here is the same container `ui(context)` carries, so it is
    // projected through the same function rather than reshaped by hand.
    context: msg.context
      ? projectContext({ v: msg.v, t: 'ui', kind: 'context', context: msg.context })
      : null,
  };
}

/* ============================================================
   Session history
   ============================================================ */

export interface VmHistoryEntry {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Read `role` and `content` out of a stored session message.
 *
 * The content is deliberately loose: it is the runtime's storage format, not a
 * protocol shape, and it may be a string or a list of parts. Only text parts are
 * rendered — a picture's bytes are not something a transcript row can show, and
 * inventing a placeholder for one would be a second fact.
 */
export function projectHistory(messages: SessionMessage[] | undefined): VmHistoryEntry[] {
  const out: VmHistoryEntry[] = [];
  for (const message of messages ?? []) {
    const role = str(message.role);
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textOf(message.content);
    if (text === '') continue;
    out.push({ role, text });
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (typeof part === 'object' && part !== null) {
      const record = part as Record<string, unknown>;
      if (typeof record['text'] === 'string') parts.push(record['text']);
    }
  }
  return parts.join('\n');
}

/* ============================================================
   Display helpers that need a protocol fact
   ============================================================ */

/** `internal/state/status.go:124` (`HitRate`) — with no input tokens it is an em
 *  dash, not 0%: "no lookup has happened yet" and "the cache is broken" are
 *  different statements.
 *
 *  The two fields are the ledger's **totals**: `prompt` is every input token and
 *  `cached` is the subset a cache served, a nesting the Go normalisers establish
 *  for all three dialects (`internal/model/anthropic.go` is the one that has to
 *  add, because the Messages protocol reports the cache read beside the uncached
 *  remainder rather than inside it). Dividing them without that nesting is what
 *  once put 3426% on the status bar. */
export function cacheHitRate(usage: Record<string, number>): number | null {
  const prompt = usage['prompt'] ?? 0;
  const cached = usage['cached'] ?? 0;
  if (prompt === 0) return null;
  return cached / prompt;
}

/** The tool-call count of a `tool_result` row, read from the audit's own
 *  counters rather than recounted here. */
export function counter(status: VmStatus, key: string): number | null {
  const value = status.counters[key];
  return typeof value === 'number' ? value : null;
}
