/**
 * The Workspace Host wire protocol (HOST_PROTOCOL 1), as types and name tables.
 *
 * Authority: `docs/spec/workspace-host-protocol.md`. The Go side
 * (`internal/workspace/host`) defines the same facts independently; the
 * cross-language test (`tests/workspace-host-protocol.test.ts`) compares
 * `HOST_PROTOCOL`, `HOST_MESSAGE_NAMES` and `HOST_REQUEST_FIELDS` against the
 * spec and the Go source, so a name added on one side only fails a test instead
 * of failing quietly in a window.
 *
 * This is a different channel from the session protocol in `@/protocol/types`:
 * different process (`--workspace-host`), different version constant, and
 * `fs_*` / `git_*` / `term_*` names that must not be confused with the session
 * protocol's `file_*` / `terminal_*`.
 */

/** Semantic version of the host channel. Independent of the session `PROTOCOL`. */
export const HOST_PROTOCOL = 1;

/** The `v` every line carries. A line with another `v` is ignored. */
export const HOST_ENVELOPE_VERSION = 1;

/* ============================================================
   Message names
   ============================================================ */

/** Requests: carry `req`, answered by exactly one `result`. */
export const HOST_REQUEST_NAMES = [
  'fs_list',
  'fs_stat',
  'fs_read',
  'fs_read_bytes',
  'fs_search',
  'git_status',
  'git_diff',
  'term_list',
  'term_create',
  'term_attach',
  'term_detach',
  'term_input',
  'term_resize',
  'term_kill',
  'term_close',
] as const;
export type HostRequestName = (typeof HOST_REQUEST_NAMES)[number];

/** Frontend → host messages that are not requests (no `req`, no `result`). */
export const HOST_CONTROL_NAMES = ['shutdown'] as const;
export type HostControlName = (typeof HOST_CONTROL_NAMES)[number];

/** The answer to a request, and the host's own complaint (`bad_version`). */
export const HOST_REPLY_NAMES = ['result', 'error'] as const;
export type HostReplyName = (typeof HOST_REPLY_NAMES)[number];

/** Host-initiated, no `req`. `term_gap` reports output overwritten in the
 *  ring buffer before this client read it (spec, "实现补充"). */
export const HOST_PUSH_NAMES = [
  'host_init',
  'workspace_event',
  'term_output',
  'term_exit',
  'term_gap',
] as const;
export type HostPushName = (typeof HOST_PUSH_NAMES)[number];

/** Every message name on the channel, in both directions. */
export const HOST_MESSAGE_NAMES: readonly string[] = [
  ...HOST_REQUEST_NAMES,
  ...HOST_CONTROL_NAMES,
  ...HOST_REPLY_NAMES,
  ...HOST_PUSH_NAMES,
];

/**
 * The parameter names of each request, as the spec's tables list them (the
 * envelope's `v`, `t` and `req` excluded). Compared against the spec by the
 * cross-language test.
 */
export const HOST_REQUEST_FIELDS = {
  fs_list: ['path'],
  fs_stat: ['path'],
  fs_read: ['path', 'offset', 'limit'],
  fs_read_bytes: ['path', 'max'],
  fs_search: ['query', 'limit'],
  git_status: [],
  git_diff: ['path', 'source'],
  term_list: [],
  term_create: ['cwd', 'cols', 'rows', 'title'],
  term_attach: ['id', 'from_seq'],
  term_detach: ['id'],
  term_input: ['id', 'data'],
  term_resize: ['id', 'cols', 'rows'],
  term_kill: ['id'],
  term_close: ['id'],
} as const satisfies Record<HostRequestName, readonly string[]>;

/** `result.error.code` values the host may send. */
export const HOST_ERROR_CODES = [
  'bad_request',
  'not_found',
  'path_escape',
  'too_large',
  'not_git',
  'unsupported',
  'internal',
  'bad_version',
] as const;
export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

/** Codes this client makes up itself; the host never sends them. */
export type HostClientErrorCode = 'timeout' | 'not_connected' | 'disconnected' | 'send_failed';

/* ============================================================
   Handshake
   ============================================================ */

export interface WorkspaceCapabilities {
  files: boolean;
  file_watch: boolean;
  file_range_read: boolean;
  git: boolean;
  terminal: boolean;
  terminal_output_replay: boolean;
  /** The host always reports false; opening locally is the desktop's own call
   *  (and never for a remote workspace). */
  system_open: boolean;
}

export const CAPABILITY_NAMES = [
  'files',
  'file_watch',
  'file_range_read',
  'git',
  'terminal',
  'terminal_output_replay',
  'system_open',
] as const satisfies readonly (keyof WorkspaceCapabilities)[];

export interface HostInitMsg {
  v: 1;
  t: 'host_init';
  workspace_id: string;
  root: string;
  host_protocol: number;
  version: string;
  pid: number;
  workspace_capabilities: WorkspaceCapabilities;
}

/* ============================================================
   Files
   ============================================================ */

export type HostEntryKind = 'file' | 'dir' | 'link';

export interface HostEntry {
  name: string;
  /** Workspace-relative, `/`-separated. */
  path: string;
  kind: HostEntryKind;
  size: number;
  mtime_ms: number;
  /** The name starts with `.`. */
  hidden: boolean;
}

export interface FsListParams {
  path: string;
}
export interface FsListData {
  path: string;
  entries: HostEntry[];
  truncated: boolean;
}

export interface FsStatParams {
  path: string;
}
export type FsStatData = HostEntry;

export interface FsReadParams {
  path: string;
  /** Default 0. */
  offset?: number;
  /** Default 262144, at most 1048576. */
  limit?: number;
}
export type FsReadStatus = 'ok' | 'binary' | 'non_utf8';
export interface FsReadData {
  path: string;
  size: number;
  offset: number;
  bytes_read: number;
  content: string;
  /** `null` once the end of the file has been read. */
  next_offset: number | null;
  truncated: boolean;
  /** Only when the whole file was read in one go; never a count of lines read. */
  total_lines: number | null;
  encoding: string;
  status: FsReadStatus;
  mime: string;
}

export interface FsReadBytesParams {
  path: string;
  /** Default 8388608; a larger file is `too_large`. */
  max?: number;
}
/** As sent: `data` is base64. */
export interface FsReadBytesWire {
  path: string;
  size: number;
  mime: string;
  data: string;
}

export interface FsSearchParams {
  query: string;
  /** Default 200. */
  limit?: number;
}
export interface FsSearchData {
  results: HostEntry[];
  truncated: boolean;
}

/* ============================================================
   Git
   ============================================================ */

export type GitDiffSource = 'worktree' | 'index' | 'untracked';
export type GitOperation = '' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

export interface GitStatusEntry {
  path: string;
  orig_path: string;
  /** Porcelain v2 letter; `.` is unchanged, `?` is untracked. */
  index: string;
  worktree: string;
  conflict: boolean;
  untracked: boolean;
}

export interface GitStatus {
  /** False outside a repository, which is not an error. */
  repo: boolean;
  branch: string;
  head: string;
  upstream: string;
  ahead: number;
  behind: number;
  detached: boolean;
  unborn: boolean;
  operation: GitOperation;
  entries: GitStatusEntry[];
  truncated: boolean;
}

export interface GitDiffParams {
  path: string;
  source: GitDiffSource;
}
export interface GitDiffData {
  path: string;
  source: GitDiffSource;
  old_path: string;
  diff: string;
  binary: boolean;
  truncated: boolean;
}

/* ============================================================
   Terminals
   ============================================================ */

export type TermState = 'running' | 'exited';

export interface Term {
  id: string;
  workspace_id: string;
  /** Workspace-relative. */
  cwd: string;
  shell: string;
  title: string;
  /** Unix milliseconds. */
  created_at: number;
  state: TermState;
  /** `null` while running. */
  exit_code: number | null;
  cols: number;
  rows: number;
  /** Cumulative output, in bytes. */
  output_seq: number;
}

export interface TermListData {
  terminals: Term[];
}

export interface TermCreateParams {
  cwd?: string;
  cols?: number;
  rows?: number;
  title?: string;
}
export interface TermCreateData {
  terminal: Term;
}

export interface TermAttachParams {
  id: string;
  /** Default 0. */
  from_seq?: number;
}
/** As sent: `data` is base64. */
export interface TermAttachWire {
  terminal: Term;
  from_seq: number;
  data: string;
  gap: boolean;
}

export interface TermIdParams {
  id: string;
}
export interface TermInputParams {
  id: string;
  data: string;
}
export interface TermResizeParams {
  id: string;
  cols: number;
  rows: number;
}

/* ============================================================
   Pushes
   ============================================================ */

export type WorkspaceChangeType = 'created' | 'modified' | 'deleted' | 'renamed';
export interface WorkspaceChange {
  path: string;
  type: WorkspaceChangeType;
}
export type WorkspaceInvalidation = 'files' | 'git';

export interface WorkspaceEvent {
  workspace_id: string;
  /** Workspace-wide, monotonic, from 1. A gap means events were lost. */
  revision: number;
  changes: WorkspaceChange[];
  invalidates: WorkspaceInvalidation[];
  /** Re-list and re-query everything instead of trusting the cache. */
  reset_required: boolean;
}

/** As sent: `data` is base64. */
export interface TermOutputWire {
  id: string;
  seq: number;
  data: string;
}
export interface TermExitWire {
  id: string;
  exit_code: number | null;
}

/* ============================================================
   Results and errors
   ============================================================ */

export interface HostErrorBody {
  code: HostErrorCode | (string & {});
  message: string;
}

/** What the client's typed methods map each request to. */
export interface HostRequestMap {
  fs_list: { params: FsListParams; data: FsListData };
  fs_stat: { params: FsStatParams; data: FsStatData };
  fs_read: { params: FsReadParams; data: FsReadData };
  fs_read_bytes: { params: FsReadBytesParams; data: FsReadBytesWire };
  fs_search: { params: FsSearchParams; data: FsSearchData };
  git_status: { params: Record<string, never>; data: GitStatus };
  git_diff: { params: GitDiffParams; data: GitDiffData };
  term_list: { params: Record<string, never>; data: TermListData };
  term_create: { params: TermCreateParams; data: TermCreateData };
  term_attach: { params: TermAttachParams; data: TermAttachWire };
  term_detach: { params: TermIdParams; data: Record<string, never> };
  term_input: { params: TermInputParams; data: Record<string, never> };
  term_resize: { params: TermResizeParams; data: Record<string, never> };
  term_kill: { params: TermIdParams; data: Record<string, never> };
  term_close: { params: TermIdParams; data: Record<string, never> };
}
