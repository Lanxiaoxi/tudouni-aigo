/**
 * What happens when a ui(state) snapshot lands, plus the small helpers the
 * runtime path needs (tool facts, failure sentences, preview release).
 *
 * Moved verbatim out of store.ts. `applyStateSnapshot` takes `set`/`get` as
 * arguments — it never closed over them.
 */
import { presentedFiles, type ToolFacts } from '@/state/entries';
import { mergeSkills, type VmState } from '@/runtime/adapt';
import { sendTo } from '@/runtime/bus';
import { type AppStore } from './storeShape';
import { SIDEBAR_BLOCKS, type SessionRuntime, type SidebarBlockKey } from './types';
import { persistPrefs } from './prefs';
import { noteOutstanding } from './polling';
import { applyTerminalList, recomputeModelCurrent } from './terminal';


/** Release the preview URLs of a set of pictures — stashed, or still being
 *  written (`PendingImage`); both carry a `blob:` URL this store owns. */
export function releaseImages(images: { url: string }[]): void {
  for (const image of images) URL.revokeObjectURL(image.url);
}

/**
 * A tool's facts for one session's stream rows.
 *
 * `ui(tools)` is the richer source — it also carries the disposition and the
 * command argument — but it is only ever sent because somebody asked for the
 * `/tools` screen. The handshake's registry is the one that is always there, so
 * it is what a tool row's risk badge is actually drawn from. `external` is only
 * in the richer source, and stays unknown until then rather than being guessed
 * as false.
 *
 * It takes the bucket rather than the key because the reducer calls it once per
 * event and re-reading the store each time would be a lookup per tool call for a
 * fact that cannot change inside one message.
 */
export function lookupToolFacts(bucket: SessionRuntime | null, name: string): ToolFacts | null {
  if (!bucket) return null;
  const live = bucket.tools.find((tool) => tool.name === name);
  const registry = bucket.toolRegistry.find((tool) => tool.name === name);
  if (!live && !registry) return null;
  return {
    risk: live?.risk ?? registry?.risk ?? null,
    parallelSafe: live?.parallelSafe ?? registry?.parallelSafe ?? null,
    interactive: live?.interactive ?? registry?.interactive ?? null,
    external: live ? live.external : null,
  };
}

/** Turn whatever a failed IPC call threw into a sentence for a person. The
 *  Rust side already writes these for a reader ("the runtime binary … was not
 *  found next to the application"), so they are passed through. */
export function describeFailure(err: unknown): string {
  if (typeof err === 'string' && err.trim() !== '') return err;
  if (err instanceof Error && err.message.trim() !== '') return err.message;
  return String(err);
}

/**
 * Whether a refused remote dial is saying **"the binary that was recorded is not
 * there any more"**.
 *
 * That is a different problem from "the connection was refused", and the answer
 * to it is different too: the first is repaired by installing again (and the
 * entry's stale `remoteBinary` is what stops the install from doing anything),
 * while the second is a network or credential problem an install cannot fix.
 *
 * The phrases come from the shell and from `exec` on the far side — a POSIX shell
 * says "No such file or directory" or "not found", and a file without the execute
 * bit says "Permission denied". Matching on text is not elegant, and it is what
 * there is: the far end reports through the SSH channel as a string, and the
 * alternative is re-running a probe before every dial (which would double the
 * latency of the common, working case to detect a rare one).
 *
 * Deliberately narrow. A false positive costs one wasted upload that ends in the
 * same refusal with the flag set; a false negative leaves the row stuck, which is
 * the state this repairs. Both are recoverable, but only one of them looks like a
 * broken button, so the list errs towards recognising the case.
 */
export function looksLikeMissingBinary(reason: string): boolean {
  const text = reason.toLowerCase();
  return (
    text.includes('no such file') ||
    text.includes('not found') ||
    text.includes('permission denied') ||
    text.includes('cannot execute') ||
    text.includes('exec format error')
  );
}

/* ============================================================
   ui(state) landing, plus the auto-expand rule
   ============================================================ */

export function applyStateSnapshot(
  set: (partial: Partial<AppStore> | ((s: AppStore) => Partial<AppStore>)) => void,
  get: () => AppStore,
  key: string,
  snap: VmState,
): void {
  const s = get();
  const bucket = s.sessions[key];
  if (!bucket) return;

  // The workspace's remembered model, written from the runtime's own report
  // of the model in force. The snapshot restates it on every send, so the
  // ordinary case is a no-op; `rememberModel` carries the comparison. A
  // fresh session in this workspace starts from it; a session that stored
  // its own choice keeps it (the runtime's rule, not this one).
  if (snap.model !== '') {
    get().rememberModel(bucket.workspace, bucket.remoteWorkspaceId, snap.model, snap.effort);
  }

  const hasContent: Record<SidebarBlockKey, boolean> = {
    goal: snap.goal.present,
    // The files block is fed by the transcript rather than by this snapshot, so
    // it asks the bucket the same question the block itself does. A `present`
    // that has landed is content even before the turn's own `ui(state)` follows
    // it — and this gate runs on that later message, which is enough for the
    // one-time unfold.
    files: presentedFiles(bucket.entries).length > 0,
    tasks: snap.todos.length > 0,
    skills: snap.skills.length > 0,
    jobs: snap.jobs.length > 0,
    mcp: snap.mcp.some((server) => server.state === 'loaded'),
    // Ended sessions the list still keeps are history, not load — but they are
    // content the block can say something about, so they count here. The badge
    // counts live ones only; this gate is about "is there a row to show".
    ssh: snap.ssh.length > 0,
  };

  // The block-fold preferences are **window-level**, and they stay that way: a
  // folded rail is where a person put it, and having it spring open because a
  // background session acquired a task would be a layout that moves on its own.
  // The "expand once on first appearance" rule is therefore shared, which at
  // worst means the second session to acquire a block does not get the one-time
  // expansion — the block is still there, with its count, one click away.
  const collapsed = { ...s.blockCollapsed };
  const autoExpanded = { ...s.blockAutoExpanded };
  let changedPrefs = false;

  for (const blockKey of SIDEBAR_BLOCKS) {
    // A human fold always wins, and never fires the one-time expansion later:
    // once a person has touched the block, `toggleBlock`'s state is final. The
    // mark is written here rather than relying on the rule skipping a touched
    // block forever — that variant comes unstuck when the first snapshot
    // *follows* the touch in the same tick, in which case nothing else would
    // ever write the mark, `blockAutoExpanded` would stay empty and the stale
    // record could resurface after a Preferences repair. `changedPrefs` fires
    // whenever the mark is new, which for a first session is every block.
    if (s.blockTouched[blockKey] === true) {
      if (autoExpanded[blockKey] !== true) {
        autoExpanded[blockKey] = true;
        changedPrefs = true;
      }
      continue;
    }
    // The one-time auto-expand: the day a block has something to say, it says it.
    if (hasContent[blockKey] && autoExpanded[blockKey] !== true) {
      collapsed[blockKey] = false;
      autoExpanded[blockKey] = true;
      changedPrefs = true;
    }
  }

  // The catalogue only travels on the **first** snapshot, so a later one must
  // not wipe it: the panel would lose every description the session ever had.
  // `null` is what "absent" looks like after projection, and an empty array is
  // a real answer ("this runtime has no catalogue").
  const catalog = snap.skillCatalog.length > 0 ? snap.skillCatalog : bucket.skillCatalog;
  // Re-merges the loaded set against the descriptions and digests that only
  // this message carries. Without it the panel shows `N / 0` and every row's
  // description is missing, because the catalogue it reads is never written.
  const merged = mergeSkills(snap.skills, catalog, bucket.skillAvailable, bucket.skillActive);

  const session = bucket.session;
  set((state) => {
    const live = state.sessions[key];
    if (!live) return {};
    return {
      sessions: {
        ...state.sessions,
        [key]: {
          ...live,
          uiState: snap,
          skillCatalog: catalog,
          skills: merged.loaded,
          skillAvailable: merged.available,
          // **The snapshot's terminal list is the workspace's whole truth**, so
          // it is applied rather than ignored. It is the one path that lets a
          // front end which started after a shell existed — or which lost a
          // message — learn about it instead of never; `terminal_created` and
          // `terminal_exit` remain the immediate patch for the moments between
          // two snapshots.
          ...applyTerminalList(live, snap.terminals),
          // Same rule as the terminal list: the snapshot's list is replaced,
          // never merged — an ended session leaving the runtime's list must
          // stop being shown here too.
          ssh: snap.ssh,
          // The catalogue's `current` flag is stamped once, at `init`. The
          // snapshot carries the live `model`/`modelProvider` on every send, so a
          // row's flag goes stale the moment a model is chosen — which is what
          // left the panel's "current" badge pinned to the first model while the
          // top bar (reading `session.model`) moved on. Recompute it from the
          // snapshot here, the same rule the TUI's picker applies: `current` is
          // "this row is the one in effect", not a fact the catalogue asserts.
          // Provider is compared too, so two routes serving a same-named model
          // cannot both light up.
          models: recomputeModelCurrent(live.models, snap.model, snap.modelProvider),
          ...(session
            ? {
                session: {
                  ...session,
                  // These follow the runtime, not the request that asked for them.
                  //
                  // `''` is the projection's "the key was absent or not a string", so
                  // it is tested explicitly rather than left to `||`. The two agree
                  // today because the runtime always sends the current model — but
                  // `||` would also swallow a *deliberately* empty value, and there is
                  // no way to tell the two apart after the fact.
                  model: snap.model === '' ? session.model : snap.model,
                  provider: snap.modelProvider === '' ? session.provider : snap.modelProvider,
                  thinking: snap.thinking,
                  effort: snap.effort,
                  effortLevels:
                    snap.effortLevels.length > 0 ? snap.effortLevels : session.effortLevels,
                  contextTokens: snap.modelWindow,
                  steps: snap.steps,
                },
              }
            : {}),
        },
      },
      ...(changedPrefs ? { blockCollapsed: collapsed, blockAutoExpanded: autoExpanded } : {}),
    };
  });

  // The auto-expand rule changes a **persisted** preference (`blockCollapsed`),
  // and a preference that changed without being written is one that silently
  // reverts on the next launch — the sidebar would come back in a shape the
  // person did not leave it in. Only written when it actually changed, so a
  // snapshot refresh is not a disk write.
  if (changedPrefs) persistPrefs(get());

  // Something is still outstanding: keep asking, one booked send at a time,
  // throttled **for this session**. This is the only reason the front end ever
  // polls — and it gives up after a few identical answers, so a job nobody
  // collects cannot turn this into a heartbeat.
  //
  // **A delegation counts here for the same reason a job does, and polling is the
  // only thing that makes its row move.** The runtime has no timers, so a running
  // subagent's `seconds`, `steps` and `activity` are only ever as fresh as the last
  // snapshot — and while a *foreground* delegation runs, the parent is blocked
  // inside the tool call and the runtime sends none at all: the child's own records
  // are forwarded deliberately without a snapshot, since forty tool calls must not
  // become forty snapshots. Without this the panel and the badge sat on a row frozen
  // at `0s · 0 steps` with an empty activity line for the whole delegation.
  //
  // The landing only **books** the send (`noteOutstanding`); a timer fires it.
  // Checking the floor here cannot work: the landing that answers a poll arrives a
  // few dozen milliseconds after the send, so the floor was always unexpired at
  // check time — the loop died after one iteration, and the freeze above is exactly
  // what a quiet session (a foreground delegation, an idle one with a background
  // job) then sat in. `polling.ts` carries the full argument.
  //
  // The `seconds` in each key is what keeps the poll alive while something is really
  // running and lets it stop once a settled row's numbers freeze — the same shape
  // the job keys already had.
  const outstandingKey = [
    ...snap.jobs
      .filter((job) => job.outstanding)
      .map((job) => `job:${job.id}:${job.state}:${job.seconds}`),
    ...snap.subagents.map(
      (agent) =>
        `subagent:${agent.id}:${agent.seconds}:${agent.steps}:${agent.toolCalls}:${agent.activity}`,
    ),
    ...snap.subagentsDone
      .filter((row) => row.state === 'uncollected')
      .map((row) => `subagentDone:${row.id}:${row.seconds}`),
  ]
    .sort()
    .join(',');
  noteOutstanding(key, outstandingKey, () => sendTo(key, { v: 1, t: 'refresh_state' }));
}
