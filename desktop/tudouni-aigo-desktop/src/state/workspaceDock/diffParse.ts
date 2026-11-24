/**
 * Unified diff → hunks and numbered lines (docs/design/workspace-dock.md 6.3).
 *
 * Pure, and tolerant: the text is whatever `git diff` printed, possibly cut off
 * at the host's 512KB cap in the middle of a line. A malformed header is skipped
 * rather than thrown on, because a viewer that errors on odd input shows nothing
 * where it could show most of a diff.
 */

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  /** Without the leading `+`/`-`/space. */
  text: string;
  /** 1-based line number in the old file; `null` for an added line. */
  oldNo: number | null;
  /** 1-based line number in the new file; `null` for a removed line. */
  newNo: number | null;
  /** `\ No newline at end of file` followed this line. */
  noNewline: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The text after the second `@@` (git's function context), or `''`. */
  section: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  /** From `rename from` / `rename to` (or `copy from` / `copy to`). */
  renameFrom: string | null;
  renameTo: string | null;
  copy: boolean;
  /** `Binary files ... differ` or `GIT binary patch`. */
  binary: boolean;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** Whole-file mode lines (`new file mode`, `deleted file mode`). */
  newFile: boolean;
  deletedFile: boolean;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseUnifiedDiff(text: string): ParsedDiff {
  const out: ParsedDiff = {
    renameFrom: null,
    renameTo: null,
    copy: false,
    binary: false,
    hunks: [],
    added: 0,
    removed: 0,
    newFile: false,
    deletedFile: false,
  };
  if (text === '') return out;

  const rows = text.split('\n');
  // A diff ends with a newline, so the last element is an empty artefact; a
  // truncated one may end mid-line and keeps that fragment.
  if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();

  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;

  for (const raw of rows) {
    const row = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    // Inside a hunk the counts say when it is over; a line that begins with
    // `---` there is a removed line whose text begins with `--`.
    if (hunk !== null && (oldLeft > 0 || newLeft > 0)) {
      const c = row[0];
      if (c === '+') {
        hunk.lines.push({ kind: 'add', text: row.slice(1), oldNo: null, newNo, noNewline: false });
        newNo += 1;
        newLeft -= 1;
        out.added += 1;
        continue;
      }
      if (c === '-') {
        hunk.lines.push({ kind: 'del', text: row.slice(1), oldNo, newNo: null, noNewline: false });
        oldNo += 1;
        oldLeft -= 1;
        out.removed += 1;
        continue;
      }
      if (c === ' ' || row === '') {
        hunk.lines.push({ kind: 'context', text: row.slice(1), oldNo, newNo, noNewline: false });
        oldNo += 1;
        newNo += 1;
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
    }

    if (row.startsWith('\\')) {
      // `\ No newline at end of file` qualifies the line just above it.
      const last = hunk?.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }

    const m = HUNK.exec(row);
    if (m) {
      const oldStart = Number(m[1]);
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      hunk = { header: row, oldStart, oldCount, newStart, newCount, section: m[5] ?? '', lines: [] };
      out.hunks.push(hunk);
      oldNo = oldStart;
      newNo = newStart;
      oldLeft = oldCount;
      newLeft = newCount;
      continue;
    }

    // A header line: only meaningful outside a hunk's body.
    hunk = oldLeft > 0 || newLeft > 0 ? hunk : null;
    if (hunk !== null) continue;
    if (row.startsWith('rename from ')) out.renameFrom = row.slice('rename from '.length);
    else if (row.startsWith('rename to ')) out.renameTo = row.slice('rename to '.length);
    else if (row.startsWith('copy from ')) {
      out.renameFrom = row.slice('copy from '.length);
      out.copy = true;
    } else if (row.startsWith('copy to ')) {
      out.renameTo = row.slice('copy to '.length);
      out.copy = true;
    } else if (row.startsWith('new file mode')) out.newFile = true;
    else if (row.startsWith('deleted file mode')) out.deletedFile = true;
    else if (row.startsWith('Binary files ') || row.startsWith('GIT binary patch')) out.binary = true;
  }
  return out;
}

/* ============================================================
   Split view
   ============================================================ */

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * Pair a hunk's lines for the side-by-side view: context lines sit on both
 * sides; a run of removals is laid against the run of additions that follows it
 * (the longer run leaves blanks opposite).
 */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === 'context') {
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === 'del') dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === 'add') adds.push(lines[i++]!);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k += 1) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

/** The viewer width from which Split is offered (design 6.3: narrow → Unified). */
export const SPLIT_MIN_WIDTH = 720;

export function splitAvailable(width: number): boolean {
  return width >= SPLIT_MIN_WIDTH;
}
