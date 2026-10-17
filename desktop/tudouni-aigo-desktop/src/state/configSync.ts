/**
 * §9.4/§9.5 of the design, as pure functions: what a saved host's config.json
 * difference actually *is*, and what the application should do about it.
 *
 * This lives apart from the store for one reason: the interesting part is
 * invisible on screen. A dialog that asks a question looks the same whether the
 * question was necessary or not, so the two rules that decide whether to ask at
 * all are asserted without a window (`tests/config-sync.test.ts`), and the store
 * is left with the I/O.
 *
 * **Content, never a timestamp.** Both sides are compared as SHA256
 * fingerprints of the exact bytes (§9.5: "modification time must not be the only
 * signal used to decide whether a configuration has changed"). That is why a
 * host asked about again five minutes after it was rewritten is *not*
 * automatically a bug — it means one of the two fingerprints differs from the
 * agreed baseline — and why the prompt now names which side moved instead of
 * repeating "both changed".
 *
 * **Two baselines, because two sides move independently.** The first version
 * compared *both* current fingerprints against the single baseline recorded at
 * the last sync. That reads correctly for "nothing has changed since we agreed",
 * and then breaks the moment a person answers "use remote": the local file is
 * now permanently different from the baseline — by definition, since the remote
 * one was kept — so every later open re-reported `local_changed` and asked the
 * same question again, forever, with no state anywhere that could say "yes, I
 * already know the local file is different; I chose that". So each side records
 * the value it was last *seen* at: `baseline` for the remote, `localBaseline`
 * for the local file. A change is a difference from that side's own last-seen
 * value, which is the question a person can actually answer.
 *
 * Two more rules are worth naming, because each of them made the prompt appear
 * where there was nothing to decide:
 *
 *   1. **A missing local file is not a local change.** The old comparison
 *      substituted `''` for "there is no local config.json", so a host whose
 *      local file does not exist could never match a baseline recorded from the
 *      remote: every open flagged `local_changed`, the only enabled answer was
 *      "use remote" (which writes nothing), and the next open asked again.
 *      `localFingerprint` is now `null` for that case, and `null` never counts
 *      as a change.
 *   2. **Neither side having a file is not a question** — both buttons of the
 *      prompt would come up disabled.
 */

import type { RemoteConfigStatus } from '@/runtime/tauri';

/** Which side of a config-sync decision a person picked. */
export type ConfigSyncChoice = 'use-local' | 'use-remote';

/**
 * A saved host's sync policy (§9.4): `'ask'` prompts, `'sync-local'` always
 * uploads the local file, `'use-remote'` is a one-way lock that only ever
 * records the remote's fingerprint.
 */
export type ConfigSyncPolicy = 'ask' | 'sync-local' | 'use-remote';

/** §9.5's four-way outcome, the same vocabulary as `bootstrap.ConfigConflict`. */
export type ConfigConflict = 'none' | 'remote_changed' | 'local_changed' | 'both_changed';

export interface ConfigSyncInput {
  /**
   * The remote fingerprint recorded the last time the two sides were compared,
   * or `''` when no sync has happened yet (which is "cannot compare accurately"
   * rather than "nothing changed").
   */
  baseline: string;
  /**
   * The local fingerprint recorded at that same moment — `''` for a host saved
   * by a build that did not keep one, which falls back to `baseline` (the old
   * single-baseline comparison) rather than reading every such host as changed.
   */
  localBaseline: string;
  /** The local file's fingerprint, or `null` when there is no local file. */
  localFingerprint: string | null;
  /** The remote file's fingerprint; `''` when there is no remote file. */
  remoteFingerprint: string;
  remoteStatus: RemoteConfigStatus;
  policy: ConfigSyncPolicy;
}

export type ConfigSyncDecision =
  /** Nothing to decide and nothing to do. */
  | { kind: 'nothing' }
  /** The baseline follows the remote's content; **no file is written**. */
  | { kind: 'adopt-remote'; fingerprint: string }
  /** The local file wins: the remote is overwritten with it. */
  | { kind: 'upload-local' }
  /** A person has to choose; the prompt carries the conflict. */
  | { kind: 'ask'; conflict: Exclude<ConfigConflict, 'none'> };

/**
 * Compares each side's current fingerprint against the value it was last seen
 * at.
 *
 * An empty remote baseline is `both_changed` rather than "no change": per §9.5,
 * "when an accurate comparison is not possible, treat it as a conflict; never
 * default to overwriting."
 */
export function configConflict(
  input: Pick<ConfigSyncInput, 'baseline' | 'localBaseline' | 'localFingerprint' | 'remoteFingerprint'>,
): ConfigConflict {
  if (input.baseline === '') return 'both_changed';
  // A host saved before the local side was recorded has only the one baseline;
  // comparing the local file against it is the old behaviour, and it settles
  // itself the next time a decision is taken.
  const localSeen = input.localBaseline === '' ? input.baseline : input.localBaseline;
  // `null` is "there is no local file", which is not a fingerprint that could
  // have moved away from what was last seen — see this module's doc, rule 1.
  const localChanged = input.localFingerprint !== null && input.localFingerprint !== localSeen;
  const remoteChanged = input.remoteFingerprint !== input.baseline;
  if (localChanged && remoteChanged) return 'both_changed';
  if (!localChanged && !remoteChanged) return 'none';
  return remoteChanged ? 'remote_changed' : 'local_changed';
}

/** What to do about a host's config, decided without touching anything. */
export function decideConfigSync(input: ConfigSyncInput): ConfigSyncDecision {
  const conflict = configConflict(input);
  if (conflict === 'none') return { kind: 'nothing' };

  if (input.policy === 'use-remote') {
    // A one-way lock (§9.4): the remote file is trusted, and a local change is
    // never pushed up without an explicit later action. Only the baseline moves,
    // so the next check compares against today's remote content rather than
    // re-flagging the same "conflict" on every connection. A remote that does
    // not exist yet records nothing — `''` is not a baseline, and storing it
    // would make every later check look like a first sync.
    return input.remoteFingerprint === ''
      ? { kind: 'nothing' }
      : { kind: 'adopt-remote', fingerprint: input.remoteFingerprint };
  }

  if (input.policy === 'sync-local') {
    // Local always wins. Uploading is only possible when there is a local file;
    // with none there is nothing to push and the remote is left alone.
    return input.localFingerprint === null ? { kind: 'nothing' } : { kind: 'upload-local' };
  }

  // 'ask'.
  //
  // §9.3's one automatic case: a remote that is still an untouched template, on
  // an account with no local file, is where a fresh account always starts — not
  // a decision. Adopting it writes nothing and stops the prompt repeating.
  if (input.remoteStatus === 'empty_template' && input.localFingerprint === null) {
    return input.remoteFingerprint === ''
      ? { kind: 'nothing' }
      : { kind: 'adopt-remote', fingerprint: input.remoteFingerprint };
  }

  // Neither side has a file: there is no choice to offer, and both buttons of
  // the prompt would come up disabled.
  if (input.localFingerprint === null && input.remoteStatus === 'missing') {
    return { kind: 'nothing' };
  }

  // A local-only change is still a question, and deliberately so: pushing it up
  // is the only path from here to a remote that has the new key, and the answer
  // "use remote" is a real choice too. What made it repeat was the missing local
  // baseline, not the asking — see this module's doc.
  return { kind: 'ask', conflict };
}
