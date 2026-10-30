/**
 * The prompt history's one copy in this window, and the two file calls behind it.
 *
 * **Nothing here runs on a keystroke.** The cache is filled once per workspace
 * (a read of a small append-only sidecar), `rememberPrompt` is called when a
 * sentence is sent, and the matcher reads the cached array. The only I/O on the
 * typing path would be a load that had not finished yet, and that answers "no
 * suggestion" rather than waiting.
 *
 * **The file is an index, not the only copy.** The sentences already exist in
 * the workspace's session files; this sidecar is the small, fast reading of them
 * (and the place a sentence lands the moment it is sent, before the runtime has
 * written its own record). Losing it costs the suggestions until the next send,
 * never a conversation.
 *
 * The snapshot follows the store's own rule: one array per workspace, replaced
 * when it changes and otherwise identical, because `useSyncExternalStore`
 * compares by identity.
 */
import {
  appendPromptHistory,
  readPromptHistory,
  seedPromptHistory,
  writePromptHistory,
} from '@/runtime/tauri';
import {
  mergePrompt,
  NO_PROMPTS,
  parsePromptHistory,
  PROMPT_HISTORY_MAX,
  promptFileKey,
  serializePromptHistory,
  type PromptEntry,
} from './promptHistory';

const cache = new Map<string, PromptEntry[]>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

/** The cached list for one workspace. A stable empty array when there is none. */
export function cachedPrompts(key: string | null): readonly PromptEntry[] {
  if (key === null) return NO_PROMPTS;
  return cache.get(key) ?? NO_PROMPTS;
}

export function subscribePrompts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(key: string, entries: PromptEntry[]): void {
  cache.set(key, entries);
  for (const listener of listeners) listener();
}

/**
 * Load one workspace's history, once.
 *
 * The read is the whole "scan": the sidecar holds at most a few thousand short
 * lines. When it is empty and the workspace is **local**, the session files are
 * offered as a one-time seed — the history from before this feature existed.
 * A remote workspace returns `null` from the seed call: its sessions live on
 * another machine, so there is nothing here to read.
 *
 * A failure is cached as empty rather than retried per keystroke; the next
 * launch tries again.
 */
export function ensurePromptHistory(
  key: string,
  workspace: string,
  remoteWorkspaceId: string | null,
): Promise<void> {
  if (cache.has(key)) return Promise.resolve();
  const running = inflight.get(key);
  if (running !== undefined) return running;

  const task = (async () => {
    const fileKey = promptFileKey(key);
    const text = await readPromptHistory(fileKey);
    let entries = parsePromptHistory(text);

    if (entries.length === 0 && remoteWorkspaceId === null && workspace !== '') {
      const seeded = await seedPromptHistory(workspace, fileKey);
      if (seeded !== null) entries = parsePromptHistory(seeded);
    }

    // A send may have landed while the read was in flight; its in-memory entry
    // is newer than the file the read saw, and overwriting it would drop a
    // suggestion the person just earned.
    if (!cache.has(key)) publish(key, entries);

    const lines = (text ?? '').split('\n').filter((line) => line.trim() !== '').length;
    if (lines > PROMPT_HISTORY_MAX * 2) {
      // Load-time compaction, never on a send: the file is append-only so a
      // crash can lose at most one line, and rewriting it is the one operation
      // that could lose all of them. Only a file that has doubled the cap earns
      // the rewrite.
      void writePromptHistory(fileKey, serializePromptHistory(entries)).catch((err) => {
        console.error('prompt history could not be compacted:', err);
      });
    }
  })()
    .catch((err) => {
      console.error('prompt history could not be loaded:', err);
      if (!cache.has(key)) publish(key, []);
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, task);
  return task;
}

/**
 * Remember one sent sentence, for this workspace.
 *
 * The in-memory copy moves first so the next keystroke already knows the
 * sentence; the append follows and is deliberately not awaited — the message is
 * on its way either way, and a history file that refused is not a reason to
 * stall or fail a send. When the history has not loaded yet there is nothing to
 * update in memory, and the append is still written for the load that follows.
 */
export function rememberPrompt(key: string, text: string): void {
  const prompt = text.trim();
  if (prompt === '') return;
  const at = Math.floor(Date.now() / 1000);
  const loaded = cache.get(key);
  if (loaded !== undefined) publish(key, mergePrompt(loaded, prompt, at));
  void appendPromptHistory(promptFileKey(key), prompt, at).catch((err) => {
    console.error('prompt history could not be appended:', err);
  });
}

/** A test seam: the cache outlives one suite, and each test wants a clean desk. */
export function resetPromptHistoryForTests(): void {
  cache.clear();
  inflight.clear();
  listeners.clear();
}
