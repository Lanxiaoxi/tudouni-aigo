/**
 * The composer's prompt history: what this workspace has been asked before,
 * folded into the one line the toolbar can say.
 *
 * **The unit is the workspace, not the conversation.** A person opens the same
 * directory every morning and types "请 pull 一下"; a session is a conversation
 * and ends, while the habit belongs to the place. So the entries are filed under
 * the same key the saved-session list uses (`savedSessionsKey`): a normalised
 * local path, or `rw:<id>` for a saved remote workspace.
 *
 * **What is stored is the sentence that was sent, minus its attachments.** The
 * draft carries placeholders for pasted pictures and attached files, and the
 * sentence that goes out carries their real paths instead. Neither belongs in a
 * suggestion: a placeholder recalls a picture that is not in the draft any more,
 * and an absolute path is machine noise that can point at a file the runtime has
 * since swept. `rememberablePrompt` removes exactly the paths this send carried.
 * What remains is prose, which is what the next completion should say.
 *
 * **The suggestion is a prefix match on the whole draft.** The earlier the
 * person is in the sentence the more useful the guess, and the caret-at-the-end
 * rule is the caller's (a completion offered mid-sentence would overwrite the
 * sentence's tail). Ranking is frequency first, recency second: a phrase said
 * ten times is a habit, while a phrase said once last week may be an answer to a
 * question that is already closed.
 *
 * This module is pure — no storage, no Tauri — because the matcher is the part
 * worth asserting in a test. The cache and the two file calls live in
 * `promptStore.ts`.
 */
import { savedSessionsKey } from './savedSessionsKey';

/** One sentence this workspace has sent, and how often. */
export interface PromptEntry {
  text: string;
  /** How many times this exact sentence was sent. */
  count: number;
  /** Epoch seconds of the newest send. */
  at: number;
}

/**
 * The cap on distinct sentences kept for one workspace.
 *
 * The matcher is a linear scan that runs while somebody types, so this is a
 * latency ceiling as much as a size one: a thousand short strings is tens of
 * microseconds, and the list a person would actually pick from is shorter still.
 */
export const PROMPT_HISTORY_MAX = 1000;

/**
 * Longer than this is a paste, not a sentence.
 *
 * A whole document recalled into the composer is a worse suggestion than none:
 * the person wanted the first clause and would have to delete the rest. Such a
 * send still works; it is simply not offered back.
 */
export const PROMPT_TEXT_MAX = 2000;

/** Fewer characters than this is too little to guess from. */
export const PROMPT_PREFIX_MIN = 2;

/** A shared empty answer, so a `useSyncExternalStore` snapshot has one identity. */
export const NO_PROMPTS: readonly PromptEntry[] = [];

/** The key one workspace's prompt history is filed under. */
export function promptHistoryKey(workspace: string, remoteWorkspaceId: string | null): string {
  return savedSessionsKey(workspace, remoteWorkspaceId);
}

/**
 * The key as a file name.
 *
 * A workspace key is a path (`C:\work\app`) or `rw:<id>`, and neither is a legal
 * name on Windows. FNV-1a keeps the mapping stable across launches and cheap
 * enough to compute on a keystroke, and a 64-bit output makes a collision
 * between two workspaces a thing that will not happen in one person's lifetime.
 */
export function promptFileKey(historyKey: string): string {
  let hash = 0xcbf29ce484222325n;
  const mask = 0xffffffffffffffffn;
  for (const byte of new TextEncoder().encode(historyKey)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Read the sidecar's lines into the ranked list the matcher uses.
 *
 * Defensive by the same rule the other record readers follow: the file outlives
 * every build, so a malformed line is dropped whole rather than guessed at, and
 * a record from a future version is not reinterpreted. Duplicate texts are
 * merged — the file is append-only, so the same sentence is one line per send —
 * and the newest timestamp wins.
 */
export function parsePromptHistory(text: string | null): PromptEntry[] {
  const byText = new Map<string, PromptEntry>();
  for (const line of (text ?? '').split('\n')) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const raw = record as Record<string, unknown>;
    if (raw.v !== 1) continue;
    if (typeof raw.text !== 'string') continue;
    const prompt = raw.text.trim();
    if (prompt === '' || prompt.length > PROMPT_TEXT_MAX) continue;
    const at =
      typeof raw.at === 'number' && Number.isFinite(raw.at) ? Math.max(0, Math.floor(raw.at)) : 0;
    const count =
      typeof raw.count === 'number' && Number.isInteger(raw.count) && raw.count > 0
        ? raw.count
        : 1;
    const existing = byText.get(prompt);
    if (existing === undefined) {
      byText.set(prompt, { text: prompt, count, at });
      continue;
    }
    existing.count += count;
    existing.at = Math.max(existing.at, at);
  }
  return rank([...byText.values()]);
}

/** The sidecar's text — one record per line, which is what makes appending cheap. */
export function serializePromptHistory(entries: readonly PromptEntry[]): string {
  let out = '';
  for (const entry of entries) {
    out += `${JSON.stringify({ v: 1, text: entry.text, count: entry.count, at: entry.at })}\n`;
  }
  return out;
}

/**
 * Add one send to a loaded list.
 *
 * The returned array is a new one (the store's snapshot has to change identity
 * or React will not draw it), and it is ranked again because the sentence just
 * sent is now the most recent — and, if it was said before, a stronger habit.
 */
export function mergePrompt(
  entries: readonly PromptEntry[],
  text: string,
  at: number,
): PromptEntry[] {
  const prompt = text.trim();
  if (prompt === '' || prompt.length > PROMPT_TEXT_MAX) return [...entries];
  const next: PromptEntry[] = [];
  let seen = false;
  for (const entry of entries) {
    if (entry.text !== prompt) {
      next.push(entry);
      continue;
    }
    next.push({ text: entry.text, count: entry.count + 1, at: Math.max(entry.at, at) });
    seen = true;
  }
  if (!seen) next.push({ text: prompt, count: 1, at });
  return rank(next).slice(0, PROMPT_HISTORY_MAX);
}

/**
 * The one sentence the toolbar should offer, or `null`.
 *
 * The draft is matched **as typed** (`请p` contains no trailing space and is a
 * prefix of `请pull…`), case-insensitively for Latin text. The matched entry is
 * already ranked, so the first hit is the best one. A suggestion never repeats
 * what is already in the box: `请pull代码` typed in full offers nothing, and
 * keeps offering nothing until the next character makes a longer sentence a
 * different sentence.
 */
export function suggestPrompt(draft: string, entries: readonly PromptEntry[]): string | null {
  if (entries.length === 0) return null;
  if (draft.length > PROMPT_TEXT_MAX) return null;
  if (draft.trim().length < PROMPT_PREFIX_MIN) return null;
  const prefix = draft.toLowerCase();
  for (const entry of entries) {
    if (entry.text.length <= draft.length) continue;
    if (entry.text.toLowerCase().startsWith(prefix)) return entry.text;
  }
  return null;
}

/**
 * The sentence worth remembering from one send, or `''` when there is none.
 *
 * `paths` are the exact attachment paths this send carried. They are removed
 * whole — a sentence that was only a picture is not a sentence — and runs of
 * spaces left behind are folded to one. Newlines survive: a multi-line prompt
 * recalled as one line would lose the code block it was written around.
 */
export function rememberablePrompt(sent: string, paths: readonly string[]): string {
  let text = sent;
  for (const path of paths) {
    if (path !== '') text = text.split(path).join(' ');
  }
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .trim();
  if (text === '' || text.length > PROMPT_TEXT_MAX) return '';
  return text;
}

/** Frequency first, newest second, text last so equal entries have a stable order. */
function rank(entries: PromptEntry[]): PromptEntry[] {
  return entries.sort((a, b) => b.count - a.count || b.at - a.at || a.text.localeCompare(b.text));
}
