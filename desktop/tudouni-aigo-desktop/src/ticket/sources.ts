/**
 * Ticket Sources, the front-end half (docs/design/ticket-sources.md).
 *
 * Pure logic, no React: the shapes of `sources.json` and of the Rust commands'
 * answers, the table that drives the settings form (`PROBE_SPECS`), and the
 * checks the form runs before it asks Rust to write.
 *
 * **The front-end checks are a courtesy, not the authority.** `sources_write`
 * runs the same rules on the Rust side and refuses a file the scanner would
 * choke on. These exist so a person sees "the repository is empty" next to the
 * box, instead of after a Save round trip. They are deliberately no stricter
 * than the design says: a rule invented here would reject a file Rust accepts.
 *
 * **Nothing here drops a field it does not know.** The file is edited by hand
 * as well as by the panel, and the design says unknown fields are ignored, not
 * rejected. So a source is edited as a plain object with spreads, and a field
 * this version has never heard of survives a read-edit-write.
 */

import type { Translate, TKey } from '@/i18n';
import type { TaskWorkspaceRef } from '@/task/tasks';

/* ============================================================
   The file
   ============================================================ */

export const PROBE_KINDS = [
  'github.pulls',
  'github.issues',
  'github.branch',
  'github.releases',
  'github.checks',
  'git.remote',
  'git.local',
  'file',
  'dir',
  'http.json',
  'schedule',
  'command',
] as const;

export type ProbeKind = (typeof PROBE_KINDS)[number];

export function isProbeKind(value: unknown): value is ProbeKind {
  return typeof value === 'string' && (PROBE_KINDS as readonly string[]).includes(value);
}

export const SOURCE_EVENTS = ['added', 'changed', 'removed'] as const;
export type SourceEvent = (typeof SOURCE_EVENTS)[number];

export const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 200;
export const DEFAULT_LIMIT = 20;
/** What Rust applies when the file leaves `on` / `emit.thread` out. Shown by the
 *  form as the placeholder, so a blank box says what blank means. */
export const DEFAULT_ON: readonly SourceEvent[] = ['added', 'changed'];
export const DEFAULT_THREAD_TEMPLATE = '{event}:{key}@{version}';

/** `{kind, ...params}`. The params are whatever the kind takes, plus anything
 *  a newer version wrote; they are all kept. */
export interface SourceProbe {
  kind: string;
  [param: string]: unknown;
}

export interface SourceEmit {
  thread?: string;
  title?: string;
  brief?: string;
  url?: string;
  workspace?: TaskWorkspaceRef;
  model?: string;
  [extra: string]: unknown;
}

export interface SourceConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  probe: SourceProbe;
  on?: SourceEvent[];
  filter?: Record<string, string>;
  initial?: 'baseline' | 'emit';
  limit?: number;
  emit: SourceEmit;
  [extra: string]: unknown;
}

export interface SourcesFile {
  schema: number;
  sources: SourceConfig[];
  [extra: string]: unknown;
}

export function emptySourcesFile(): SourcesFile {
  return { schema: 1, sources: [] };
}

/* ============================================================
   What the Rust commands answer
   ============================================================ */

/** One Source's last scan, as `sources-state.json` records it. */
export interface LastScan {
  atMs: number;
  ok: boolean;
  error: string | null;
  emitted: number;
  deferred: number;
  baseline: boolean;
  total: number;
}

export interface ScanSourceResult {
  id: string;
  ok: boolean;
  error: string | null;
  skipped: 'disabled' | 'invalid' | null;
  baseline: boolean;
  total: number;
  emitted: number;
  deferred: number;
}

export interface ScanReport {
  configError: string | null;
  sources: ScanSourceResult[];
}

export interface SourceItem {
  key: string;
  version: string;
  fields?: Record<string, unknown>;
}

export interface ProbeResult {
  ok: boolean;
  error: string | null;
  total: number;
  /** At most 20; `total` is the real count. */
  items: SourceItem[];
}

/* ============================================================
   Parse and serialize
   ============================================================ */

export type SourcesProblemCode = 'json' | 'shape' | 'schema' | 'entry';

/** Why a file could not be taken as it is. `detail` is raw (a parser message,
 *  a schema value, an index), so the panel puts it in a sentence. */
export interface SourcesProblem {
  code: SourcesProblemCode;
  detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read `sources.json`'s text.
 *
 * A missing file and a blank one are the same thing: no sources yet. Anything
 * else that does not fit comes back as a `problem` **with an empty file**, and
 * the panel must refuse to save over it: a file this version cannot read is
 * not an empty shelf, and writing the empty one back would destroy it.
 *
 * The parsed object is returned as it is (not rebuilt), so top-level fields
 * this version does not know ride along to the next write.
 */
export function parseSourcesFile(text: string | null): {
  file: SourcesFile;
  problem: SourcesProblem | null;
} {
  const fail = (problem: SourcesProblem) => ({ file: emptySourcesFile(), problem });
  if (text === null || text.trim() === '') return { file: emptySourcesFile(), problem: null };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return fail({ code: 'json', detail: err instanceof Error ? err.message : String(err) });
  }
  if (!isRecord(raw)) return fail({ code: 'shape', detail: 'not an object' });
  if (raw.schema !== 1) return fail({ code: 'schema', detail: String(raw.schema) });
  if (raw.sources === undefined) raw.sources = [];
  if (!Array.isArray(raw.sources)) return fail({ code: 'shape', detail: 'sources is not a list' });
  for (let i = 0; i < raw.sources.length; i++) {
    // Dropping a non-object entry silently would delete whatever the person
    // wrote there on the next save.
    if (!isRecord(raw.sources[i])) return fail({ code: 'entry', detail: `#${i + 1}` });
  }
  return { file: raw as SourcesFile, problem: null };
}

/** Two-space indent and a trailing newline: what a person editing by hand
 *  expects, and what keeps a diff of the file small. */
export function serializeSourcesFile(file: SourcesFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/* ============================================================
   The form table
   ============================================================ */

export type ParamType = 'text' | 'number' | 'bool' | 'select' | 'list' | 'json';

export interface ParamSpec {
  key: string;
  type: ParamType;
  /** Required means "the scan cannot run without it". A required param that
   *  has a `default` is satisfied by leaving it empty, because Rust applies
   *  that default (`branch` is required and defaults to main). */
  required?: boolean;
  default?: string | number | boolean;
  /** For `select`: the values the file takes. Shown as they are written. */
  options?: readonly string[];
  /** For `number`. */
  min?: number;
  max?: number;
  /** For `json`: what the parsed value must be. */
  shape?: 'object' | 'array';
  /** For `text`: a multi-line box. */
  multiline?: boolean;
  /** For `text`: a format the front end can safely insist on. */
  pattern?: RegExp;
  /** An example, not a sentence: untranslated on purpose. */
  placeholder?: string;
  /** Behind the "Advanced" fold. */
  advanced?: boolean;
  labelKey: TKey;
  hintKey: TKey;
}

export interface EmitDefaults {
  on: SourceEvent[];
  thread: string;
  title: string;
  brief: string;
  url: string;
}

export interface ProbeSpec {
  fields: ParamSpec[];
  defaults: EmitDefaults;
}

type ParamExtra = Partial<Omit<ParamSpec, 'key' | 'type' | 'labelKey' | 'hintKey'>>;

function param(key: string, type: ParamType, extra: ParamExtra = {}): ParamSpec {
  return {
    key,
    type,
    ...extra,
    labelKey: `ticket.sources.param.${key}` as TKey,
    hintKey: `ticket.sources.param.${key}.hint` as TKey,
  };
}

const REPO = param('repo', 'text', {
  required: true,
  placeholder: 'org/repo',
  pattern: /^[^/\s]+\/[^/\s]+$/,
});
const STATE = param('state', 'select', { options: ['open', 'closed', 'all'], default: 'open' });
const PER_PAGE = param('perPage', 'number', { min: 1, max: 100, default: 50, advanced: true });
const TIMEOUT = param('timeoutSec', 'number', { min: 1, max: 600, default: 60, advanced: true });
const GITHUB_ACCESS = [
  param('tokenEnv', 'text', { placeholder: 'GITHUB_TOKEN', advanced: true }),
  param('apiBase', 'text', { placeholder: 'https://api.github.com', advanced: true }),
  param('proxy', 'text', { placeholder: 'http://127.0.0.1:7890', advanced: true }),
];

export const PROBE_SPECS: Record<ProbeKind, ProbeSpec> = {
  'github.pulls': {
    fields: [
      REPO,
      STATE,
      param('base', 'text', { placeholder: 'main' }),
      PER_PAGE,
      ...GITHUB_ACCESS,
      TIMEOUT,
    ],
    defaults: {
      // One ticket per PR (`pr#{key}`), so `changed` could only redeliver the
      // same thread; the inbox would drop it as a duplicate.
      on: ['added'],
      thread: 'pr#{key}',
      title: 'PR #{key}: {fields.title}',
      brief:
        'Review pull request #{key} "{fields.title}" by {fields.author} ({fields.head} into {fields.base}).\n{fields.url}',
      url: '{fields.url}',
    },
  },
  'github.issues': {
    fields: [
      REPO,
      STATE,
      param('labels', 'list', { placeholder: 'bug, help wanted' }),
      PER_PAGE,
      ...GITHUB_ACCESS,
      TIMEOUT,
    ],
    defaults: {
      on: ['added'],
      thread: 'issue#{key}',
      title: 'Issue #{key}: {fields.title}',
      brief: 'Look into issue #{key} "{fields.title}" opened by {fields.author}.\n{fields.url}',
      url: '{fields.url}',
    },
  },
  'github.branch': {
    fields: [
      REPO,
      param('branch', 'text', { required: true, default: 'main', placeholder: 'main' }),
      ...GITHUB_ACCESS,
      TIMEOUT,
    ],
    defaults: {
      on: ['changed'],
      thread: 'push#{version}',
      title: '{key} moved to {version|short}',
      brief: 'Branch {key} has a new commit {version}: {fields.message}\n{fields.url}',
      url: '{fields.url}',
    },
  },
  'github.releases': {
    fields: [
      REPO,
      param('includePrerelease', 'bool', { default: false }),
      PER_PAGE,
      ...GITHUB_ACCESS,
      TIMEOUT,
    ],
    defaults: {
      on: ['added'],
      thread: 'release#{key}',
      title: 'Release {key}',
      brief: 'A new release {key} ({fields.name}) was published.\n{fields.url}',
      url: '{fields.url}',
    },
  },
  'github.checks': {
    fields: [
      REPO,
      param('ref', 'text', { required: true, placeholder: 'main' }),
      ...GITHUB_ACCESS,
      TIMEOUT,
    ],
    defaults: {
      // The version is the verdict, so `changed` fires when CI goes red or
      // recovers, and two reds in a row are not a second event.
      on: ['changed'],
      thread: 'ci#{fields.sha}',
      title: 'CI is {version} on {key}',
      brief: 'The checks for {key} ({fields.sha|short}) are now {version}.\n{fields.url}',
      url: '{fields.url}',
    },
  },
  'git.remote': {
    fields: [
      param('url', 'text', { required: true, placeholder: 'https://github.com/org/repo.git' }),
      param('refs', 'text', { default: 'refs/heads/*', placeholder: 'refs/heads/*' }),
      TIMEOUT,
    ],
    defaults: {
      on: ['added', 'changed'],
      thread: 'ref#{key}@{version}',
      title: '{key} is at {version|short}',
      brief: 'The remote ref {key} points to {version}.',
      url: '',
    },
  },
  'git.local': {
    fields: [
      param('path', 'text', { required: true, placeholder: 'D:/repo' }),
      param('branches', 'text', { default: '*', placeholder: '*' }),
      TIMEOUT,
    ],
    defaults: {
      on: ['changed'],
      thread: 'branch#{key}@{version}',
      title: '{key}: {fields.subject}',
      brief: 'Branch {key} moved to {version}: {fields.subject}',
      url: '',
    },
  },
  file: {
    fields: [param('glob', 'text', { required: true, placeholder: 'D:/reports/**/*.csv' }), TIMEOUT],
    defaults: {
      on: ['added', 'changed'],
      thread: 'file#{key}@{version|short}',
      title: 'File {fields.name}',
      brief: 'The file {key} appeared or changed.',
      url: '',
    },
  },
  dir: {
    fields: [
      param('path', 'text', { required: true, placeholder: 'D:/drop' }),
      param('pattern', 'text', { default: '*', placeholder: '*' }),
      TIMEOUT,
    ],
    defaults: {
      on: ['added', 'changed'],
      thread: 'file#{key}@{version}',
      title: 'File {fields.name}',
      brief: 'The file {fields.path} appeared or changed.',
      url: '',
    },
  },
  'http.json': {
    fields: [
      param('url', 'text', { required: true, placeholder: 'https://example.com/api/items' }),
      param('method', 'select', { options: ['GET', 'POST'], default: 'GET' }),
      param('headers', 'json', { shape: 'object', placeholder: '{"Authorization": "Bearer ..."}' }),
      param('body', 'text', { multiline: true }),
      param('items', 'text', { placeholder: 'data.items' }),
      param('key', 'text', { required: true, placeholder: 'id' }),
      param('version', 'text', { placeholder: 'updated_at' }),
      param('proxy', 'text', { placeholder: 'http://127.0.0.1:7890', advanced: true }),
      TIMEOUT,
    ],
    defaults: {
      on: ['added'],
      thread: 'item#{key}',
      title: 'Item {key}',
      brief: 'The API reported item {key} (version {version}). Look into it.',
      url: '',
    },
  },
  schedule: {
    fields: [
      param('every', 'select', {
        required: true,
        options: ['hourly', 'daily', 'weekly', 'monthly'],
        default: 'daily',
      }),
      param('at', 'text', { placeholder: '09:00', pattern: /^([01]\d|2[0-3]):[0-5]\d$/ }),
      param('weekday', 'number', { min: 1, max: 7, placeholder: '1' }),
    ],
    defaults: {
      // A new period is a change; the first scan is only the baseline.
      on: ['changed'],
      thread: 'schedule#{version}',
      title: 'Scheduled run {version}',
      brief: 'The schedule reached a new period ({version}). Do the recurring work.',
      url: '',
    },
  },
  command: {
    fields: [
      param('run', 'json', { required: true, shape: 'array', placeholder: '["python", "scan.py"]' }),
      param('cwd', 'text', { placeholder: 'D:/repo' }),
      TIMEOUT,
    ],
    defaults: {
      on: ['added', 'changed'],
      thread: '{event}:{key}@{version}',
      title: '{key}',
      brief: 'The command reported {key} (version {version}). Look into it.',
      url: '',
    },
  },
};

export function kindLabelKey(kind: ProbeKind): TKey {
  return `ticket.sources.kind.${kind}` as TKey;
}

export function kindHintKey(kind: ProbeKind): TKey {
  return `ticket.sources.kind.${kind}.hint` as TKey;
}

/**
 * A new source of `kind`, with an id nobody else in the file has.
 *
 * Only the params that are required **and** have a default are filled in
 * (`branch`, `every`): the rest start empty so the form shows what is missing
 * instead of a value nobody chose.
 */
export function emptySource(kind: ProbeKind, existingIds: Iterable<string>): SourceConfig {
  const spec = PROBE_SPECS[kind];
  const taken = new Set(existingIds);
  const base = kind.replace(/\./g, '-');
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;

  const probe: SourceProbe = { kind };
  for (const field of spec.fields) {
    if (field.required && field.default !== undefined) probe[field.key] = field.default;
  }
  const d = spec.defaults;
  return {
    id,
    enabled: true,
    probe,
    on: [...d.on],
    filter: {},
    initial: 'baseline',
    limit: DEFAULT_LIMIT,
    emit: {
      thread: d.thread,
      title: d.title,
      brief: d.brief,
      url: d.url,
      workspace: { kind: 'active' },
      model: '',
    },
  };
}

/* ============================================================
   Editing: copies, with `undefined` meaning "take the default"
   ============================================================ */

function withKey<T extends object>(obj: T, key: string, value: unknown): T {
  const next: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as T;
}

/** Set one top-level field of a source. `undefined` removes it, which is how a
 *  field goes back to the default the design gives it. */
export function setSourceField(src: SourceConfig, key: string, value: unknown): SourceConfig {
  return withKey(src, key, value);
}

export function setProbeParam(src: SourceConfig, key: string, value: unknown): SourceConfig {
  return { ...src, probe: withKey(src.probe, key, value) };
}

export function setEmitField(src: SourceConfig, key: string, value: unknown): SourceConfig {
  return { ...src, emit: withKey(src.emit ?? {}, key, value) };
}

/** The text a `list` param shows. The file stores the comma-separated string
 *  the design describes; an array written by hand is shown joined. */
export function listText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(String).join(', ');
  return '';
}

/** Text of a `json` param. A string is a draft the person is still typing
 *  (see `parseJsonParam`), so it is shown as it is. An argv array stays on one
 *  line, because `["python", "scan.py"]` spread over four lines reads as a
 *  different thing; an object (headers) is indented. */
export function jsonParamText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}

/**
 * Read what was typed into a number box.
 *
 * Blank is "not set" (the field goes back to its default). Whole numbers are
 * numbers. Anything else comes back as the **raw string**, which is stored so
 * that `validateSource` reports it, instead of being quietly rounded or
 * dropped into a value the box does not show.
 */
export function parseNumberInput(text: string): number | string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : text;
}

export function numberText(value: unknown): string {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value : '';
}

/**
 * Read what was typed into a `json` box.
 *
 * Blank is "not set". Text that does not parse is returned as the **raw
 * string** rather than dropped, so the box keeps what was typed and
 * `validateSource` then reports `json` until it is fixed. Storing it is what
 * keeps Save disabled; keeping the last valid value instead would let a person
 * save something other than what the box shows.
 */
export function parseJsonParam(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface FilterRow {
  path: string;
  glob: string;
}

export function filterToRows(filter: unknown): FilterRow[] {
  if (!isRecord(filter)) return [];
  return Object.entries(filter).map(([path, glob]) => ({ path, glob: String(glob) }));
}

/** Rows with a blank path are half-typed and are left out; a repeated path
 *  keeps the later row, as the object it becomes would. `undefined` when
 *  nothing is left, so the field goes back to the default `{}`. */
export function rowsToFilter(rows: readonly FilterRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const path = row.path.trim();
    if (path !== '') out[path] = row.glob;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/* ============================================================
   Validation
   ============================================================ */

/** The reasons the form can give. The panel turns each into a sentence. */
export type SourceErrorCode =
  | 'required'
  | 'format'
  | 'duplicate'
  | 'unknownKind'
  | 'empty'
  | 'range'
  | 'type'
  | 'option'
  | 'json';

/** Keyed by field: `id`, `kind`, `on`, `filter`, `initial`, `limit`, `brief`
 *  and `probe.<param>`. Empty means nothing to fix. */
export type SourceErrors = Record<string, SourceErrorCode>;

function isBlank(value: unknown, type: ParamType): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (type === 'json' && Array.isArray(value)) return value.length === 0;
  if (type === 'json' && isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function checkParam(spec: ParamSpec, value: unknown): SourceErrorCode | null {
  if (isBlank(value, spec.type)) {
    return spec.required && spec.default === undefined ? 'required' : null;
  }
  switch (spec.type) {
    case 'text':
      if (typeof value !== 'string') return 'type';
      return spec.pattern !== undefined && !spec.pattern.test(value.trim()) ? 'format' : null;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'type';
      if (!Number.isInteger(value)) return 'range';
      if (spec.min !== undefined && value < spec.min) return 'range';
      if (spec.max !== undefined && value > spec.max) return 'range';
      return null;
    case 'bool':
      return typeof value === 'boolean' ? null : 'type';
    case 'select':
      if (typeof value !== 'string') return 'type';
      return spec.options?.includes(value) ? null : 'option';
    case 'list':
      if (typeof value === 'string') return null;
      return Array.isArray(value) && value.every((v) => typeof v === 'string') ? null : 'type';
    case 'json':
      if (typeof value === 'string') return 'json';
      if (spec.shape === 'array') {
        return Array.isArray(value) && value.every((v) => typeof v === 'string') ? null : 'json';
      }
      return isRecord(value) ? null : 'json';
  }
}

/**
 * Check one source against the design's rules, naming what is wrong field by
 * field. `others` are the other sources in the file (for the id's uniqueness).
 */
export function validateSource(src: SourceConfig, others: readonly SourceConfig[]): SourceErrors {
  const errors: SourceErrors = {};

  const id = typeof src.id === 'string' ? src.id : '';
  if (id === '') errors.id = 'required';
  else if (!SOURCE_ID_PATTERN.test(id)) errors.id = 'format';
  else if (others.some((other) => other.id === id)) errors.id = 'duplicate';

  const probe = isRecord(src.probe) ? src.probe : ({} as Record<string, unknown>);
  if (!isProbeKind(probe.kind)) {
    errors.kind = 'unknownKind';
  } else {
    for (const spec of PROBE_SPECS[probe.kind].fields) {
      const code = checkParam(spec, probe[spec.key]);
      if (code !== null) errors[`probe.${spec.key}`] = code;
    }
  }

  if (src.on !== undefined) {
    if (!Array.isArray(src.on)) errors.on = 'type';
    else if (src.on.length === 0) errors.on = 'empty';
    else if (src.on.some((e) => !(SOURCE_EVENTS as readonly unknown[]).includes(e))) errors.on = 'type';
  }

  if (src.filter !== undefined) {
    const f = src.filter as unknown;
    if (!isRecord(f) || Object.values(f).some((v) => typeof v !== 'string')) errors.filter = 'type';
  }

  if (src.initial !== undefined && src.initial !== 'baseline' && src.initial !== 'emit') {
    errors.initial = 'option';
  }

  if (src.limit !== undefined) {
    const limit = src.limit as unknown;
    if (typeof limit !== 'number' || !Number.isFinite(limit)) errors.limit = 'type';
    else if (!Number.isInteger(limit) || limit < LIMIT_MIN || limit > LIMIT_MAX) errors.limit = 'range';
  }

  const brief = isRecord(src.emit) ? src.emit.brief : undefined;
  if (typeof brief !== 'string' || brief.trim() === '') errors.brief = 'required';

  return errors;
}

/* ============================================================
   Saying what a scan did
   ============================================================ */

export interface ScanSummary {
  emitted: number;
  deferred: number;
  baselines: number;
  /** Sources that were looked at (not disabled). */
  scanned: number;
  failures: Array<{ id: string; error: string }>;
  configError: string | null;
}

export function summarizeScan(report: ScanReport): ScanSummary {
  const summary: ScanSummary = {
    emitted: 0,
    deferred: 0,
    baselines: 0,
    scanned: 0,
    failures: [],
    configError: report.configError,
  };
  for (const s of report.sources) {
    if (s.skipped === 'disabled') continue;
    summary.scanned += 1;
    summary.emitted += s.emitted;
    summary.deferred += s.deferred;
    if (s.baseline) summary.baselines += 1;
    if (!s.ok || s.skipped === 'invalid') summary.failures.push({ id: s.id, error: s.error ?? '' });
  }
  return summary;
}

/** Whether the board's note should read as a warning rather than as news. */
export function scanHadProblem(report: ScanReport): boolean {
  return summarizeScan(report).failures.length > 0 || report.configError !== null;
}

const ERROR_CLIP = 200;

function clip(text: string): string {
  return text.length > ERROR_CLIP ? `${text.slice(0, ERROR_CLIP)}…` : text;
}

/**
 * One line for the board: how many were dropped, how many only set a baseline,
 * which failed and why. When something was dropped it also points at "Check
 * inbox", because a scan only writes files and the board reads them on its
 * own press.
 */
export function describeScan(report: ScanReport, t: Translate): string {
  const s = summarizeScan(report);
  if (s.configError !== null) return t('ticket.sources.note.configError', { error: clip(s.configError) });

  const parts: string[] = [];
  if (s.emitted > 0) parts.push(t('ticket.sources.note.emitted', { n: s.emitted }));
  if (s.baselines > 0) parts.push(t('ticket.sources.note.baseline', { n: s.baselines }));
  if (s.deferred > 0) parts.push(t('ticket.sources.note.deferred', { n: s.deferred }));
  if (s.failures.length > 0) {
    const list = s.failures.map((f) => (f.error === '' ? f.id : `${f.id}: ${clip(f.error)}`)).join('; ');
    parts.push(t('ticket.sources.note.failed', { n: s.failures.length, list }));
  }
  if (parts.length === 0) {
    return s.scanned === 0 ? t('ticket.sources.note.noSources') : t('ticket.sources.note.nothing');
  }
  const line = parts.join('; ');
  return s.emitted > 0 ? `${line}. ${t('ticket.sources.note.goInbox')}` : line;
}
