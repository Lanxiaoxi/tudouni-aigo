/**
 * Display formatting only.
 *
 * These convert presentation, never meaning: nothing here may compute a new
 * number. Every fact on screen has to come from a protocol message, so a
 * formatting helper is not allowed to invent one.
 */

/** Duration: ms below 10s, then units, so 1234567ms never appears. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m}m${rest.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
}

/** Token counts, thousands-separated, matching the terminal's style. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-US');
}

/** A 0..1 ratio as a percentage. Null stays an em dash: "no measurement" and
 *  "zero" are different statements. */
export function formatPercent(r: number | null | undefined, digits = 0): string {
  if (r === null || r === undefined) return '—';
  return `${(r * 100).toFixed(digits)}%`;
}

/** Relative time from an epoch-**millisecond** value. Callers converting from
 *  `modified_at` must multiply by 1000 first: that field is in seconds. */
export function formatRelative(atMs: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - atMs);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  return `${mon}mo ago`;
}

export function formatClock(atMs: number): string {
  const d = new Date(atMs);
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Single-line truncation, for parameter previews and first-message previews.
 *  It changes presentation only, never meaning. */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

/**
 * Render a permission request's arguments for display.
 *
 * **Full text, no truncation.** This is not an event's companion field; it is
 * the material a person judges from, and the decisive half of a risky command is
 * usually in the second sentence. So: pretty-print when it parses, fall back to
 * the raw JSON when it does not, and never cut.
 */
export function formatArguments(args: Record<string, unknown>): string {
  if (args === null || args === undefined) return '';
  // A shell command is the common case and reads best as its own line, without
  // JSON's quoting and escaping.
  const command = args['command'];
  if (typeof command === 'string' && Object.keys(args).length === 1) return command;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

export function formatPath(p: string, max = 42): string {
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/);
  if (parts.length <= 2) return `…${p.slice(-max)}`;
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`;
}

/** The last segment of a path, for display.
 *
 *  Both separators are accepted, because this is not allowed to guess which
 *  platform produced the string: a workspace path can reach here with either
 *  one, and `split('/')` alone would return the whole path on Windows. */
export function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last && last !== '' ? last : p;
}

/**
 * One workspace path in the form comparisons are made in: both separators
 * normalised to `/`, trailing separators dropped, lower-cased.
 *
 * Exported because a comparison is not the only thing that needs it: the saved
 * session list is **keyed** by workspace, and a key has to be built the same way
 * it is looked up. Two implementations of "the same directory" — one for the
 * lookup and one for the key — is exactly how a list ends up stored under a path
 * nothing ever asks for. `samePath` is written in terms of this so the two
 * cannot drift.
 */
export function normPath(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Are these two paths the same workspace?
 *
 * A comparison of two strings, not a filesystem call. A workspace bookmark is
 * the string the person picked, and the runtime reports the same directory back
 * on `init.workspace` — possibly with different casing, or with the other
 * separator. Case-insensitive is right on Windows and merely permissive
 * elsewhere; the cost of a false match is one merged row, while a false mismatch
 * draws the current workspace twice, once as "current" and once as a bookmark.
 */
export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}
