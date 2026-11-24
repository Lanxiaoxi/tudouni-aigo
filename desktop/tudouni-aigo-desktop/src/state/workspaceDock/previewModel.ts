/**
 * The file preview's reading rules (docs/design/workspace-dock.md 5.3).
 *
 * A preview is a growing list of `fs_read` ranges. This module is the part that
 * decides what is true about it: where the next range starts, what may be said
 * about the length, and how a refresh keeps what was already read.
 */
import type { FsReadData } from '@/workspaceHost/protocol';

/** The first range, and each "load more": the host's default and the spec. */
export const PREVIEW_CHUNK = 262144;

export interface PreviewState {
  path: string;
  size: number;
  mime: string;
  /** `ok` is text; the other two are an empty state, not an error. */
  status: FsReadData['status'];
  /** The text read so far, concatenated. */
  content: string;
  /** Bytes read so far from the start of the file. */
  bytesRead: number;
  /** Where the next range starts; `null` once the end has been read. */
  nextOffset: number | null;
  /** The file's line count, only when the host knew it (a single read of the
   *  whole file); never derived from what has been read. */
  totalLines: number | null;
  encoding: string;
}

/** A first range → state. */
export function previewFromRead(data: FsReadData): PreviewState {
  const text = data.status === 'ok';
  return {
    path: data.path,
    size: data.size,
    mime: data.mime,
    status: data.status,
    content: text ? data.content : '',
    bytesRead: text ? (data.offset ?? 0) + (data.bytes_read ?? 0) : 0,
    nextOffset: text ? (data.next_offset ?? null) : null,
    totalLines: text && data.total_lines !== undefined ? data.total_lines : null,
    encoding: data.encoding ?? '',
  };
}

/**
 * Append a following range. A range that does not start where the last one
 * ended (the file changed under us) is refused with `null`, and the caller
 * reloads from the top rather than gluing two versions of a file together.
 */
export function appendRead(state: PreviewState, data: FsReadData): PreviewState | null {
  if (data.status !== 'ok') return null;
  if (state.nextOffset === null) return state;
  // `offset` echoes the actual start; a cut inside a character moves it forward
  // to the next boundary, never backwards.
  if (data.offset < state.nextOffset) return null;
  return {
    ...state,
    size: data.size,
    content: state.content + data.content,
    bytesRead: data.offset + data.bytes_read,
    nextOffset: data.next_offset ?? null,
    // Only the first read of a whole file can know it, and this is not one.
    totalLines: null,
  };
}

/** Whether there is more of the file than has been read. */
export function isTruncated(state: PreviewState): boolean {
  return state.status === 'ok' && state.nextOffset !== null;
}

/** The limit to send for the next range: the chunk, capped at what remains. */
export function nextLimit(state: PreviewState): number {
  if (state.nextOffset === null) return PREVIEW_CHUNK;
  const left = Math.max(0, state.size - state.nextOffset);
  return Math.max(1, Math.min(PREVIEW_CHUNK, left));
}

/** Lines of the text read so far (what is on screen), not of the file. */
export function countShownLines(content: string): number {
  if (content === '') return 0;
  const n = content.split('\n').length;
  return content.endsWith('\n') ? n - 1 : n;
}

/**
 * What to say about the length. `total` only when the host gave it; otherwise
 * the shown count with `atLeast` so the caller can say "first N lines" and not
 * "N lines".
 */
export function lineSummary(state: PreviewState): { shown: number; total: number | null; atLeast: boolean } {
  const shown = countShownLines(state.content);
  if (state.totalLines !== null) return { shown, total: state.totalLines, atLeast: false };
  return { shown, total: null, atLeast: isTruncated(state) };
}

/* ---------------- what kind of file ---------------- */

export type PreviewKind = 'image' | 'markdown' | 'code' | 'text';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx']);

export function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The picture kinds drawn through `fs_read_bytes`. SVG is left to the text
 *  preview: it is XML a person usually wants to read, and an `<img>` of
 *  untrusted markup is a decision this viewer need not make. */
export function isImagePath(path: string): boolean {
  const ext = extOf(path);
  return IMAGE_EXT.has(ext) && ext !== 'svg';
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXT.has(extOf(path));
}

/** File extension → a highlight.js language name, for what is not the same. */
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  jsonc: 'json',
  toml: 'ini',
  ini: 'ini',
  md: 'markdown',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  php: 'php',
  sql: 'sql',
  lua: 'lua',
  diff: 'diff',
  patch: 'diff',
  makefile: 'makefile',
  mk: 'makefile',
};

/**
 * A highlight.js language for the file, or `null` for plain text. Only
 * languages in rehype-highlight's default ("common") set are named: asking
 * for one it has not registered makes it skip the block anyway.
 */
export function languageOfPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name === 'makefile') return 'makefile';
  return LANG_BY_EXT[extOf(path)] ?? null;
}

export function previewKindOf(path: string, mime: string): PreviewKind {
  if (isImagePath(path) || (mime.startsWith('image/') && mime !== 'image/svg+xml')) return 'image';
  if (isMarkdownPath(path)) return 'markdown';
  return languageOfPath(path) !== null ? 'code' : 'text';
}

/** The largest picture requested through `fs_read_bytes`: the host's default. */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
