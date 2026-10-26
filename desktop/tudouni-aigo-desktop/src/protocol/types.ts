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

/** Semantic version of the conversation, carried as `init.protocol`.
 *
 * **4** adds the workspace's two non-session capabilities: Files (`file_list`,
 * `file_read`) and Terminal (`terminal_list`, `terminal_create`,
 * `terminal_input`, `terminal_resize`, `terminal_kill`, `terminal_close`, plus the `terminal_*`
 * and `files` / `file_read` kinds on the `ui` channel). It is additive in the
 * same way 2 was: a front end that knows neither simply never asks, and one that
 * does not recognise `terminal_output` ignores a kind it cannot draw — which is
 * why the state snapshot also carries the terminal list, and why a terminal's
 * whole life stays observable from `ui(state)` alone.
 *
 * **5** adds the last turn's wall-time breakdown to `ui(status)`: a `timing`
 * group beside `counters` and `usage`. Additive again — a front end that does
 * not know the key simply never reads it.
 *
 * **6** adds workspace memory: `memory_list` / `memory_action` inbound, and one
 * more `ui` kind (`memory`).
 *
 * **7** adds `session_fork` inbound: copy a saved session up to a chosen
 * reply, under a fresh id, and open the copy. A front end that draws a fork
 * control gates it on this number: a runtime below 7 would silently ignore the
 * message, and a button that answers with nothing is a promise the runtime
 * behind it cannot keep.
 *
 * **8** adds `memory_pending` to the `ui(state)` snapshot: the count of memory
 * proposals waiting for review. Additive — a runtime below 8 simply never
 * sends the key, and a badge that reads "absent" as zero would hide a queue
 * the runtime is holding, so the badge gates on this number.
 *
 * **9** adds the workspace's code index: `codeintel_action` inbound, the
 * `codeintel` kind on the `ui` channel, and a `codeintel` group on
 * `ui(state)`. Two shapes are this number's own design:
 *
 *   - `init` / `sync` **answer immediately** and the build narrates itself
 *     through pushed `ui(codeintel)` messages carrying `progress`. A reply that
 *     waited for a multi-minute pass would block the connection that is drawing
 *     the progress.
 *   - `enabled` and `indexed` are **separate facts** — a person reaches both
 *     mismatched states (built then switched off; switched on but never built),
 *     and one boolean could not express either.
 *
 * **10** batched `ask_user`'s questions into one panel.
 *
 * **11** adds `usage_stats` inbound and the `usage` kind on the `ui` channel:
 * the cross-workspace usage ledger folded into the desktop's usage panel
 * numbers. Purely additive — a front end that does not know the kind ignores
 * it, and nothing about a session's behaviour depends on the panel being
 * drawn.
 *
 * **12** splits the usage snapshot's `by_day` by model: a day whose rows
 * record models may carry a `models` map of `{model: tokens}`. Additive in
 * the same way 8 was — a runtime below 12 sends days without the key, and a
 * front end that does not know it reads the day totals exactly as before.
 * The absence rule runs the other way too: a day with no modeled rows omits
 * the key, so a front end that draws per-model charts hides them rather than
 * inventing a split the ledger never recorded.
 */
export const PROTOCOL_VERSION = 12;

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

/* ---------------- workspace: files and terminals ---------------- */

/** `file_list` rows. `path` is **workspace-relative** and is what gets sent
 *  back; `name` is what gets shown. They are separate fields because a nested
 *  row's path is not its name, and a front end that joined them itself would be
 *  doing the path arithmetic the boundary exists to keep on the runtime's side. */
export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  /** Bytes, and 0 for a directory — not "unknown". */
  size: number;
}

/** `ui(files)`. `path` is the **runtime's normalised** spelling, not the
 *  request's: after `/./src/../src` the two differ, and the reply's is the one
 *  that makes "where am I" answerable. */
export interface UiFilesMsg {
  v: number;
  t: 'ui';
  kind: 'files';
  path: string;
  entries: FileEntry[];
}

/**
 * `ui(file_read)`.
 *
 * `content` is the **head** of the file (`runtime.FileReadPreviewChars`), not
 * the whole body: the body is an Artifact on disk under `artifact_id`, for the
 * same reason a tool result's is — a session file is appended to, so a body
 * written into it costs its own size again every round.
 */
export interface UiFileReadMsg {
  v: number;
  t: 'ui';
  kind: 'file_read';
  path: string;
  artifact_id: string;
  content: string;
  chars: number;
  bytes: number;
  /** Whether `content` is all of it. **Must be shown**: half a file presented
   *  as the whole thing is the one silent failure this layer can produce. */
  truncated: boolean;
  total_lines: number;
}

/**
 * Workspace memory: the model's confidence in one memory.
 *
 * It is a statement about the evidence, not about the content: the same note is
 * `inferred` the first time somebody guesses and `verified` after it is reproduced.
 * The panel shows it because it is the difference between "this happened here" and
 * "this was deduced", and a reader deciding whether to trust a note needs it.
 */
export type MemoryConfidence = 'observed' | 'verified' | 'inferred';

/**
 * The workspace's memory settings, as `config.json` holds them.
 *
 * Every field is present, including the ones this panel does not draw: the runtime
 * writes the whole file, and a front end that reconstructed it from the fields it
 * knows would silently reset the others on every save.
 */
export interface MemoryConfig {
  version: number;
  /** The master switch. Off pauses recall; the files on disk are untouched. */
  enabled: boolean;
  /** Whether recalled memories go into the request at all. Off leaves the
   *  explicit `memory_search` tool working — which is what somebody who wants to
   *  choose for themselves actually wants. */
  auto_inject: boolean;
  recall_on_turn_start: boolean;
  recall_on_tool_failure: boolean;
  max_recall: number;
  max_results: number;
  min_score: number;
  entry_chars: number;
  note_chars: number;
}

/** One published memory, as the panel lists it. No body: rows are a list, and the
 *  body is what `memory_get` is for. `chars` is its size, which is how a person
 *  decides whether opening it is worth it. */
export interface MemoryEntryRow {
  id: string;
  revision: number;
  title: string;
  updated_at: string;
  confidence: MemoryConfidence;
  triggers: string[];
  tags: string[];
  scope_paths: string[];
  chars: number;
}

/** One proposal waiting for review.
 *
 *  `op` says what publishing it would do, and that has to be on the row: `create`,
 *  `update` and `deprecate` are one click away from each other and only one of them
 *  adds something. `expected_revision` is the version the proposal was written
 *  against — publishing it against a newer one is refused by the runtime. */
export interface MemoryCandidateRow {
  id: string;
  op: 'create' | 'update' | 'deprecate';
  target_id: string;
  expected_revision: number;
  title: string;
  created_at: string;
  confidence: MemoryConfidence;
  triggers: string[];
  tags: string[];
  body: string;
  chars: number;
  reason: string;
}

/** The derived index, as the panel reports it. `rebuilt` means this session found
 *  it missing or stale and repaired it — worth saying, because it is the
 *  difference between "your index is fine" and "it was broken and has been fixed". */
export interface MemoryIndexStatus {
  entries: number;
  built_at: string;
  rebuilt: boolean;
  problem: string;
}

/** `ui(memory)`'s `memory` object: the whole panel, in one message.
 *
 *  Full snapshots rather than deltas, for the reason the terminal list is one: a
 *  front end that patched its own copy would eventually disagree with the runtime
 *  about what exists. */
export interface MemorySnapshot {
  root: string;
  config: MemoryConfig;
  entries: MemoryEntryRow[];
  candidates: MemoryCandidateRow[];
  index: MemoryIndexStatus;
  problem: string;
  unreadable: string[];
}

/** `ui(memory)`.
 *
 *  **A refusal arrives here too**, as `problem` with the snapshot still attached:
 *  the panel is a modal layer over the transcript, so a `notice` explaining a
 *  failed publish would be printed behind the panel that is asking. */
export interface UiMemoryMsg {
  v: number;
  t: 'ui';
  kind: 'memory';
  memory?: MemorySnapshot;
  problem?: string;
}

/* ============================================================
   The code index
   ============================================================ */

/** How far the index is behind the working tree.
 *
 *  `count` is the sum and is what a badge shows; the three parts are what the
 *  panel's sentence names, because "12 modified" and "3 deleted" mean different
 *  things — one is a working tree that moved, the other is files the index still
 *  believes exist. */
export interface CodeIntelStaleness {
  added: number;
  changed: number;
  removed: number;
  checked: number;
  count: number;
}

/** One deliberate build this session ran. In memory only on the runtime side:
 *  it describes what that process did, and a saved copy would let a window open
 *  with a claim about a build somebody has since closed. */
export interface CodeIntelRun {
  full: boolean;
  ok: boolean;
  files: number;
  nodes: number;
  edges: number;
  unresolved: number;
  problem: string;
  at: string;
}

/** A build in flight. */
export interface CodeIntelProgress {
  phase: string;
  done: number;
  total: number;
}

/** `ui(codeintel)`'s `codeintel` object: the whole panel, in one message.
 *
 *  **`enabled` and `indexed` are two facts, not one.** `enabled` is the person's
 *  permission (the switch, from `.tudouni/codeintel/config.json`); `indexed` is
 *  whether a database exists. Both mismatched states are reachable, and the panel
 *  draws each of them with its own sentence.
 *
 *  `parser` is about the **installation**, not the index: false means this build
 *  carries no `cg-parse` for this platform, so an existing index can be queried
 *  but nothing can rebuild it. */
export interface CodeIntelSnapshot {
  workspace: string;
  enabled: boolean;
  indexed: boolean;
  /** Where the database lives, relative to the workspace. */
  path: string;
  size_bytes: number;
  files: number;
  nodes: number;
  edges: number;
  unresolved: number;
  pending: number;
  ambiguous_edges: number;
  /** Files that produced no symbols at all — the coverage hole the panel shows
   *  by language, because a language whose files all land here is a parser gap. */
  deferred: number;
  /** Files the grammar rejected but the line scanner could read: symbols, no
   *  call graph. A different fact from `deferred` and never merged with it. */
  heuristic: number;
  deferred_by_language: Record<string, number>;
  heuristic_by_language: Record<string, number>;
  stale: CodeIntelStaleness;
  /** RFC 3339, absent when the index has never been built. */
  indexed_at?: string;
  parser: boolean;
  building: boolean;
  /** Present only while `building`. */
  progress?: CodeIntelProgress;
  last?: CodeIntelRun;
  /** Why the counts could not be read. Empty is the normal state, including for
   *  "there is no index yet" — that is a state, not an error. */
  problem: string;
}

/** `ui(codeintel)`.
 *
 *  One kind for the whole panel **and** for a build's progress, so a front end has
 *  one shape to keep right rather than two. A refusal arrives here too, as
 *  `problem` beside the snapshot, for the same reason `ui(memory)` carries one:
 *  the transcript is behind the panel that asked. */
export interface UiCodeIntelMsg {
  v: number;
  t: 'ui';
  kind: 'codeintel';
  codeintel?: CodeIntelSnapshot;
  problem?: string;
}

/** One day's activity, as `by_day` and `peak` carry it. `tokens` is
 *  prompt + completion — cached input counted, because it was really sent. */
export interface UsageDay {
  /** Local calendar day, `YYYY-MM-DD`, from the record's own timestamp. */
  day: string;
  tokens: number;
  turns: number;
  /** The day's tokens split by model (protocol 12). A turn's row names the
   *  model of its last successful call, and a row without one lands in the
   *  day's totals but in no bucket here — so the split can sum to less than
   *  `tokens`, which is the honest answer, not a lost ledger row. Absent
   *  when the runtime predates the split or the day has no modeled rows;
   *  the panel hides its per-model charts rather than drawing an invented
   *  one. */
  models?: Record<string, number>;
}

/** `ui(usage)`'s `usage` object: the cross-workspace usage ledger folded into
 *  the panel's numbers.
 *
 *  The ledger lives beside `config.json` in the user's home, so these are
 *  facts about **the user of this machine**, not about any one workspace or
 *  conversation — which is also why the snapshot lands in a window-level slot
 *  rather than in a session's bucket.
 *
 *  Only numbers travel. `peak` and `longest_run_ms` are **absent** when no
 *  record exists yet, and that absence is a sentence — "nothing has been spent
 *  here" — that a zero would corrupt into "the busiest day spent nothing". */
export interface UsageSnapshot {
  /** When this aggregation was computed. The panel shows it as "as of": the
   *  data is one snapshot per panel open, never a live stream. */
  generated_at: string;
  totals: {
    prompt: number;
    cached: number;
    miss: number;
    completion: number;
    /** prompt + completion. */
    tokens: number;
    /** Finished turns with at least one successful model call. */
    turns: number;
    calls: number;
    /** Distinct calendar days with at least one record. */
    days: number;
  };
  /** The busiest day over the whole history. Absent until a record exists. */
  peak?: UsageDay;
  /** Wall time of the longest finished turn. Absent for the same reason. */
  longest_run_ms?: number;
  streak: {
    /** Counted back from today — or from yesterday when today has no record
     *  yet, because a day is not over until it is. */
    current: number;
    longest: number;
  };
  /** Days with records inside the last 365, ascending. The empty cells of the
   *  heatmap are the front end's to draw. */
  by_day: UsageDay[];
}

/** `ui(usage)`. A refusal arrives as `problem` with no `usage` — the one
 *  case where the panel has no snapshot to draw beside it. */
export interface UiUsageMsg {
  v: number;
  t: 'ui';
  kind: 'usage';
  usage?: UsageSnapshot;
  problem?: string;
}

/** The verbs a `codeintel_action` message accepts.
 *
 *  `status` is one verb rather than its own message kind: the panel asks for the
 *  snapshot on open and after every action anyway, so a separate request kind would
 *  always produce the same reply as its siblings'. */
export type CodeIntelActionKind = 'status' | 'config' | 'init' | 'sync';

/**
 * One terminal, as the runtime reports it.
 *
 * A terminal belongs to the **workspace**, not to a session: switching or
 * closing a conversation never ends one. That is why the list rides on
 * `ui(state)` and on `ui(terminals)` rather than on anything session-shaped.
 */
export interface TerminalRow {
  id: string;
  /** The workspace root this terminal is bounded by. An absolute path. */
  workspace: string;
  /** Workspace-relative, the same vocabulary as `FileEntry.path`. */
  cwd: string;
  shell: string;
  pid: number;
  /**
   * The runtime's state machine. **Never derived here** — a front end that
   * decided "it is probably still running" would be a second answer to a
   * question only the process's owner can answer.
   *
   * `starting` and `failed` do not exist on the wire: creation is synchronous,
   * so a terminal is running by the time any answer travels, and a PTY that will
   * not start produces an error rather than a row.
   */
  status: 'running' | 'exited' | 'killed';
  /** Null while it runs, and **null after a kill**: a killed shell did not
   *  choose an exit status, and printing 0 would make "we killed it" and "it
   *  finished cleanly" the same row. */
  exit_code: number | null;
  created_at: number;
  cols: number;
  rows: number;
}

/** `ui(terminals)` — the full list, never a delta. */
export interface UiTerminalsMsg {
  v: number;
  t: 'ui';
  kind: 'terminals';
  terminals: TerminalRow[];
}

/**
 * One SSH remote session, as the runtime reports it.
 *
 * Like a terminal, a session belongs to the **workspace**: the runtime's
 * snapshot restates the list every `ui(state)` so a front end that started
 * after a connection was opened — or lost a message — learns about it rather
 * than never (`internal/runtime/ssh.go`, the same reason the terminal list
 * rides on every snapshot).
 *
 * Display only: the operations stay with the `ssh_*` tools, so nothing here
 * acts on a row.
 */
export interface SshRow {
  id: string;
  /** What the model asked for. Empty when it addressed the host directly. */
  alias: string;
  /** Where the connection actually resolved. Can differ from `alias`. */
  destination: string;
  /** The runtime's `ssh.Status`: running, exited, killed, or timed_out. **Never
   *  derived here** — the runtime owns the lifecycle, the same rule as a
   *  terminal's `status`. */
  status: 'running' | 'exited' | 'killed' | 'timed_out';
  /** Null while it runs — "no exit code yet", not "the runtime did not say". */
  exit_code: number | null;
  created_at: number;
}

/** `ui(terminal_created)` — the answer to a successful `terminal_create`. */
export interface UiTerminalCreatedMsg {
  v: number;
  t: 'ui';
  kind: 'terminal_created';
  terminal: TerminalRow;
  terminal_id: string;
}

/**
 * `ui(terminal_output)` — one coalesced batch of PTY bytes.
 *
 * It carries the id and the data and **nothing else**, and that is deliberate:
 * it is the one message sent thousands of times, so repeating a full row on
 * every batch would multiply the cost of the only high-frequency thing here.
 *
 * `data` is an **increment**, not the accumulated output — accumulating is the
 * client's job. Batches are cut on rune boundaries by the runtime, so a
 * multi-byte character is never split across two of them.
 */
export interface UiTerminalOutputMsg {
  v: number;
  t: 'ui';
  kind: 'terminal_output';
  terminal_id: string;
  data: string;
}

/**
 * `ui(terminal_exit)` — the shell ended, whether it exited or was killed.
 *
 * This is the **only** report of an ending. A kill answered from the request
 * that asked for it would be a second truth, and the two would disagree the
 * first time a process refused to die.
 */
export interface UiTerminalExitMsg {
  v: number;
  t: 'ui';
  kind: 'terminal_exit';
  terminal_id: string;
  terminal: TerminalRow;
  reason: 'exited' | 'killed';
  exit_code: number | null;
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
  /**
   * Elapsed seconds, not a start timestamp. A row whose answer is already waiting
   * to be collected reports the run's total, so it stops climbing — the done panel
   * reports the same number for it.
   */
  seconds: number;
  steps: number;
  tool_calls: number;
  activity: string;
  /** Present since background delegations: true when the row outlives its turn. */
  background?: boolean;
}

/**
 * `ui(state).subagents_done[]` — `internal/subagent/board.go` `Board.DonePanel()`.
 * Background delegations, newer first. A row is `running` until its child
 * settles; `uncollected` means the answer is in memory waiting for the parent's
 * collect tool, and `stop_reason` names how it ended once it has.
 */
export interface SubagentDoneRow {
  id: string;
  label: string;
  model: string;
  provider: string;
  depth: number;
  /** Total run seconds once finished; elapsed while still running. */
  seconds: number;
  steps: number;
  tool_calls: number;
  activity: string;
  state: 'running' | 'uncollected';
  /** Empty while still running. */
  stop_reason: string;
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
  /** Background delegations, newer first. Present since background delegation
   *  support; a runtime without it simply omits the key. */
  subagents_done?: SubagentDoneRow[];
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
  /** The workspace's terminals, on every snapshot. Carried here as well as on
   *  `ui(terminals)` so a front end that started after a shell was created — or
   *  that lost a message — learns about it rather than never. */
  terminals: TerminalRow[];
  /** The workspace's SSH remote sessions, on every snapshot. Same reason as
   *  `terminals`, and the same shape the `ssh_sessions` tool reports
   *  (`internal/runtime/ssh.go`). Empty — `[]`, never `null` — before the
   *  first connection. */
  ssh: SshRow[];
  /** The count of memory proposals waiting for review, on every snapshot.
   *  Protocol 8. Count only — the full candidate list still travels on
   *  `ui(memory)`, which the front end only asks for when the panel is open.
   *  Without this the workbench's Memory badge stayed empty after a
   *  `memory_propose`, because that is a **tool** and the only snapshot a
   *  tool result re-states is this one. Absent on a runtime below 8, and
   *  "absent" must not be read as zero: the runtime is holding a queue the
   *  front end has no way of counting. */
  memory_pending?: number;
  /** The code index, in three booleans. Protocol 9.
   *
   *  Counts stay on `ui(codeintel)`: this rides on every tool result, and the
   *  workbench row needs only enough to decide whether to draw and whether to
   *  badge. `enabled` is the switch, `indexed` is whether a database exists —
   *  two facts, both reachable mismatched, so neither can be derived from the
   *  other. Absent on a runtime below 9, which must read as "this build cannot
   *  say" rather than as "off". */
  codeintel?: {
    enabled: boolean;
    indexed: boolean;
    building: boolean;
  };
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
  /**
   * The wall-time breakdown of the **last turn** (protocol 5), in
   * milliseconds. `run_ms` is the turn's own total — the same figure
   * `run_finished.duration_ms` puts on `lastTurnMs` — and `unattributed` is
   * what nothing measured of it; the buckets between them are `SummarizeTime`'s,
   * the same sums the `--audit` line states.
   *
   * **Per turn, not cumulative.** `counters` and `usage` above are session
   * totals and this group is one turn's, because the reader is the status bar's
   * turn chip, and a cumulative bucket beside a single turn's total would not
   * add up to it. `null` when no turn has run yet — the absence, not a zero
   * row claiming a turn took 0ms.
   */
  timing: {
    run_ms: number;
    model_ms: number;
    tool_ms: number;
    waited_ms: number;
    human_ms: number;
    backoff_ms: number;
    saved_ms: number;
    unattributed: number;
  } | null;
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

/** The answer to `probe_effort` (protocol 13).
 *
 *  One row per level the current model offers. `result` is the runtime's own
 *  three-way reading: the endpoint accepted the level (`ok`), refused it by
 *  naming the parameter (`rejected`), or did not answer in a way this program
 *  can read as either (`uncertain` — with the endpoint's own sentence in
 *  `note`). `problem` rides beside the kind for a probe that could not run at
 *  all, for the reason `memory` and `codeintel` carry theirs: the panel is a
 *  layer over the transcript, and a notice lands behind it. */
/** The probed (model, provider) and its rows, as the store keeps them.
 *  Flat rather than nested under `probe`: the store's field is the snapshot,
 *  and a nesting the wire has but the state does not is a re-shape every
 *  reader has to remember. */
export interface ProbeEffortSnapshot {
  model: string;
  provider: string;
  levels: Array<{ level: string; result: string; note?: string }>;
}

export interface UiProbeEffortMsg {
  v: number;
  t: 'ui';
  kind: 'probe_effort';
  problem?: string;
  probe?: ProbeEffortSnapshot;
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
  | UiRunFinishedMsg
  | UiFilesMsg
  | UiFileReadMsg
  | UiTerminalsMsg
  | UiTerminalCreatedMsg
  | UiTerminalOutputMsg
  | UiTerminalExitMsg
  | UiMemoryMsg
  | UiCodeIntelMsg
  | UiUsageMsg
  | UiProbeEffortMsg;

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
  /**
   * One line describing the session: what was asked, then (when the budget has
   * room) where that turn got to. The runtime composes and caps it — a front
   * end that re-cut it would disagree with the next one about the same row.
   * Empty means the session never spoke.
   */
  preview: string;
  /** Epoch **seconds**, or null when the file could not be read. */
  modified_at: number | null;
  /**
   * Whether this session is archived.
   *
   * Always on the row, never optional: a front end drawing an archive filter
   * needs the fact on every row, and "absent" would be a second way of saying
   * false. Whether archived rows appear in the list at all is the request's
   * `filter` (see `FrontendMsg`), which the runtime applies **before** its cap.
   */
  archived: boolean;
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
  /**
   * Batch metadata. All `question_request`s of one `ask_user` call carry the
   * same `batch_id` (the first question's id) and a 0-based `question_index`
   * of the batch's size. The runtime sends the whole batch back to back and
   * only then waits, so the front end groups them into one panel; `null`
   * values mean the sender predates batches and the request stands alone.
   */
  batch_id: string | null;
  question_index: number | null;
  question_count: number | null;
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

/** The verbs a `memory_action` message accepts.
 *
 *  They are the **person's** vocabulary: `publish`, `reject` and `deprecate` are
 *  review decisions, and the model has no way to send any of them — it can only
 *  propose, which lands in the candidate queue. `rebuild` repairs the derived index
 *  and `config` writes this workspace's settings. */
export type MemoryActionKind = 'publish' | 'reject' | 'deprecate' | 'rebuild' | 'config';

export type FrontendMsg =
  | { v: number; t: 'user_message'; text: string }
  | { v: number; t: 'permission_response'; id: string; decision: PermissionDecision }
  | { v: number; t: 'question_response'; id: string; status: QuestionStatus; text: string }
  /** Missing or null `session_id` means a new session; an id whose file does not
   *  exist means a new session too. */
  | { v: number; t: 'session_switch'; session_id?: string | null }
  /** Ask for the saved-session list.
   *
   *  `filter` chooses whether archived sessions are in the answer, and it is the
   *  **view** this front end is establishing rather than a one-off argument: the
   *  list is re-sent for reasons nobody asked about (a delete, an archive,
   *  a session switch) and every one of those answers carries the same filter.
   *  Omitted means `all`, which is the compatibility default — the CLI and TUI
   *  send a bare `session_list` and have no way to un-archive, so hiding rows
   *  from them would hide conversations they cannot get back. */
  | { v: number; t: 'session_list'; filter?: 'active' | 'all' }
  /** Delete one saved session. The runtime waits for the running turn, deletes
   *  the file, then re-sends `sessions`. Deleting the mounted session makes it
   *  open a fresh one and re-send the opening triple. */
  | { v: number; t: 'session_delete'; session_id: string }
  /** Archive or un-archive one saved session.
   *
   *  `archived` is an **absolute state**, not a toggle, so re-sending is
   *  idempotent and the front end need not know the current value. Archiving is a
   *  metadata edit, not a move: a session being written by another child is a
   *  race the runtime cannot see, so **this front end gates the action** on "no
   *  live child holds this id". */
  | { v: number; t: 'session_archive'; session_id: string; archived: boolean }
  /** Fork one saved session at one of its replies: the runtime copies the
   *  conversation up to the end of that reply's turn, under a fresh id, and
   *  mounts the copy.
   *
   *  The reply is named by `reply` (its exact text) plus `user_before`, the
   *  number of user rows the front end drew above it. The two facts together are
   *  what a front end can state about the row it drew: the text locates the
   *  message (it may repeat, so the count breaks the tie), and the count is
   *  exact only until the runtime inserts a change note the front end never
   *  echoed. The cut lands on the **turn boundary** after the reply — the
   *  store's `Fork` owns that rule — so the copy never carries `tool_calls`
   *  without their results. */
  | { v: number; t: 'session_fork'; session_id: string; reply: string; user_before: number }
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
  /** Ask for the workspace-memory panel's whole snapshot (`ui(memory)`). */
  | { v: number; t: 'memory_list' }
  /** One review decision about workspace memory.
   *
   *  The verbs are the person's: the model can only *propose*. `publish` and `reject`
   *  take `proposal_id`; `deprecate` takes `entry_id` (and an optional `reason`);
   *  `rebuild` repairs the derived index; `config` writes a patch of the settings. The
   *  answer is always a fresh `ui(memory)`, so a front end never patches its own view
   *  from a success flag. */
  | {
      v: number;
      t: 'memory_action';
      action: MemoryActionKind;
      proposal_id?: string;
      entry_id?: string;
      reason?: string;
      config?: Partial<MemoryConfig>;
    }
  /** One verb on the workspace's code index.
   *
   *  `status` reads; `config` writes the enable switch; `init` rebuilds from
   *  scratch and `sync` tops up. `init` and `sync` **answer immediately** — the
   *  build narrates itself through pushed `ui(codeintel)` messages — so the reply
   *  is an acknowledgement plus the panel's state as it was before the pass began,
   *  and `building` in that snapshot is what a front end draws.
   *
   *  These are the person's verbs: the model cannot spend somebody else's
   *  afternoon on an index build. */
  | {
      v: number;
      t: 'codeintel_action';
      action: CodeIntelActionKind;
      /** `config` only. */
      enabled?: boolean;
    }
  /** Ask for the cross-workspace usage ledger's snapshot. No arguments and no
   *  verbs: the panel opens, asks once, and draws — there is nothing on it a
   *  person can act on, and nothing to poll for. */
  | { v: number; t: 'usage_stats' }
  /** Ask the runtime to probe the current model's reasoning levels: one real
   *  request per offered level, the answer on `ui(probe_effort)`. No arguments
   *  — the levels are the catalogue's and only the runtime knows them. The
   *  asks cost real tokens, so this window confirms with the person **before**
   *  sending it; the runtime simply does what it is asked. Gate on protocol 13. */
  | { v: number; t: 'probe_effort' }
  | { v: number; t: 'mcp'; action: McpAction; servers: string[] }
  /** List one directory level. An **empty** path is the workspace root — the
   *  same value the runtime uses for "the workspace itself", so there is no
   *  second spelling to keep in step. */
  | { v: number; t: 'file_list'; path: string }
  /** Read one file. The reply carries a preview plus an `artifact_id`; the whole
   *  body stays on disk. */
  | { v: number; t: 'file_read'; path: string }
  | { v: number; t: 'terminal_list' }
  /** Open a shell. `cwd` is workspace-relative and **may be omitted** (the
   *  runtime then uses the workspace root); so may the size, which then becomes
   *  the conventional 80x24. */
  | { v: number; t: 'terminal_create'; cwd?: string; cols?: number; rows?: number }
  /** Write raw bytes to a shell. **There is no reply** — the output arrives
   *  asynchronously as `ui(terminal_output)`, which is why this is fire-and-
   *  forget rather than a request/response. */
  | { v: number; t: 'terminal_input'; terminal_id: string; data: string }
  | { v: number; t: 'terminal_resize'; terminal_id: string; cols: number; rows: number }
  | { v: number; t: 'terminal_kill'; terminal_id: string }
  /** Forget a terminal that has **already ended**, so it stops appearing in the
   *  list. Not a synonym for `terminal_kill`: that one ends a process, this one
   *  deletes a record, and the runtime refuses this for a terminal that still
   *  needs the other. The answer is a fresh `ui(terminals)` — a refused close
   *  answers with a notice *and* that list, so a tab dropped too early is
   *  restored from the same reply. */
  | { v: number; t: 'terminal_close'; terminal_id: string }
  /** Stop one background subagent. `subagent_id` is the child's session id,
   *  the same string every subagent row carries. There is no result payload:
   *  the child settles with the ordinary `cancelled` reason, and the next
   *  `ui(state)` re-draws the panels. A refused stop arrives as a notice. */
  | { v: number; t: 'subagent_stop'; subagent_id: string }
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
