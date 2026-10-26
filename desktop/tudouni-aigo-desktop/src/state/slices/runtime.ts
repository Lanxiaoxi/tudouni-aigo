/**
 * runtime slice.
 *
 * Moved verbatim out of store.ts; the wrapper is all that changed — the
 * shared helpers arrive as `ctx` instead of being closed over.
 */
import type { StoreContext } from '../storeContext';
import type { AppStore } from '../storeShape';
import { type CodeIntelSnapshot, type MemorySnapshot, type ProbeEffortSnapshot } from '@/protocol/types';
import { appendBlock, applyDelta, applyFinalAnswer, clearStream, lastStopReason, lastTurnHead, newTurnStartsFolded, nextId, pushBlock, reduceEvent, settleAbandonedTurn, type Entry, type LooseEvent, type NoteEntry } from '@/state/entries';
import { mergeSkills, projectCompacted, projectContext, projectHistory, projectInit, projectMcpMsg, projectSessionList, projectSkillsMsg, projectState, projectStatus, projectToolsMsg } from '@/runtime/adapt';
import { extractRefinePrompts } from '@/learn/refineTemplate';
import { outcomeOfChildExit, outcomeOfTurnStatus } from '@/task/tasks';
import { sendTo } from '@/runtime/bus';
import { samePath } from '@/utils/format';
import { attachRuntimeListener, quitApp } from '@/runtime/tauri';
import { STDERR_TAIL } from '../types';
import { persistPrefs } from '../prefs';
import { enqueueModal, questionBatchOf, releaseModalsOf } from '../modalQueue';
import { pollNow, wakePolling } from '../polling';
import { appendTerminalOutput, applyTerminalList, replaceTerminal, terminalEndedNote } from '../terminal';
import { runtimeOf } from '../appView';
import { applyStateSnapshot, lookupToolFacts } from '../runtimeLanding';

export function runtimeSlice(ctx: StoreContext): Pick<AppStore, 'send' | 'markNotesRead' | 'setRuntimeInfo' | 'setNotifyEnabled' | 'setClosePolicy' | 'setStartupProblem' | 'setStartupNotice' | 'rememberWorkspace' | 'rememberRemoteWorkspace' | 'pushStderr' | 'countDrop' | 'setSessionProblem' | 'retrySession' | 'retryStartup' | 'quit' | 'applyRuntimeMessage'> {
  const { set, get, patch, patchWith, noteSavedSessions, markSavedSessionsPending, activeKeyForSend } = ctx;
  return {
    send(msg) {
      const key = activeKeyForSend();
      if (key === null) return;
      sendTo(key, msg);
    },

    markNotesRead() {
      const key = activeKeyForSend();
      if (key === null) return;
      patchWith(key, (current) => ({
        notesReadCount: current.entries.reduce(
          (read, row) => (row.kind === 'note' ? read + 1 : read),
          0,
        ),
      }));
    },

    setRuntimeInfo(info) {
      set({ runtimeVersion: info.version, userName: info.userName ?? '' });
    },

    setNotifyEnabled(on) {
      set({ notifyEnabled: on });
      persistPrefs(get());
    },

    setClosePolicy(policy) {
      set({ closePolicy: policy });
      persistPrefs(get());
    },

    setStartupProblem(problem) {
      set({ startupProblem: problem });
    },

    setStartupNotice(notice) {
      set({ startupNotice: notice });
    },

    rememberWorkspace(path) {
      const trimmed = path.trim();
      // Nothing to remember. An empty string here is a caller passing through a
      // value it did not have, which is not a statement that the remembered
      // workspace should be forgotten — so it is ignored rather than honoured.
      //
      // There is deliberately no "forget" action either. A remembered workspace
      // that has since been deleted is **reported** at start-up (`workspace_check`
      // answers about it) rather than erased, because a directory can come back:
      // an unplugged drive, an unmounted share, a folder mid-rename. It also
      // heals itself the moment somebody picks a workspace, since `init.workspace`
      // then overwrites it.
      if (trimmed === '') return;
      // `samePath` rather than `!==`: the runtime echoes the directory back with
      // its own casing and separators, so a strict comparison would make every
      // ordinary `init` look like a change and write localStorage each time.
      const remembered = get().lastWorkspace;
      if (remembered !== null && samePath(remembered, trimmed)) return;
      set({ lastWorkspace: trimmed });
      persistPrefs(get());
    },

    rememberRemoteWorkspace(remoteWorkspaceId) {
      // The remote counterpart of `rememberWorkspace`, and it is a **different
      // field** rather than the same one: the answer to "where was the work" is
      // either a directory on this machine or a saved entry on another host, and
      // one field cannot hold both without the start-up having to guess which
      // machine a path belonged to.
      //
      // The id is checked against the saved entries before it is written: a
      // session whose entry was just deleted would otherwise leave an id that
      // names nothing, and the start-up would have to decide whether to trust it.
      const trimmed = remoteWorkspaceId.trim();
      if (trimmed === '') return;
      const known = get().remoteWorkspaces.some((entry) => entry.id === trimmed);
      if (!known) return;
      if (get().lastRemoteWorkspaceId === trimmed) return;
      set({ lastRemoteWorkspaceId: trimmed });
      persistPrefs(get());
    },

    pushStderr(key, line) {
      patchWith(key, (current) => {
        const next = [...current.stderrTail, line];
        // A tail, not a log: the last N lines are what explain a refusal, and an
        // unbounded array would grow for the life of a long session.
        return {
          stderrTail: next.length > STDERR_TAIL ? next.slice(next.length - STDERR_TAIL) : next,
        };
      });
    },

    countDrop(key) {
      patchWith(key, (current) => ({ dropped: current.dropped + 1 }));
    },

    setSessionProblem(key, problem) {
      patch(key, { problem });
    },

    async retrySession(key) {
      const current = runtimeOf(get(), key);
      if (!current) return;
      patch(key, { problem: null, stderrTail: [] });
      // A remote failure is retried the remote way, with the same arguments
      // that failed: a local spawn would check the remote path against this
      // machine's filesystem and refuse it again, with the same sentence.
      // The same `forceNew` route "New session" on a remote screen uses —
      // it also covers a retry whose entry lost its binary (install, then
      // connect), and it records a second refusal on its own new row, the
      // same shape `connectRemoteWorkspace` gives every other failure.
      if (current.remoteWorkspaceId !== null) {
        // The failed row is retired before the dial, the same way the local
        // path detaches before attaching: a retry must not leave the row that
        // failed sitting beside the row that worked.
        await get().detachSession(key);
        await get().connectRemoteWorkspace(current.remoteWorkspaceId, { forceNew: true });
        return;
      }
      // A retry is a new process, because the old one is gone by definition —
      // there would be nothing to retry inside a live child. The failed bucket
      // is retired once the new one exists, so a retry never leaves the row
      // that failed sitting beside the row that worked.
      const workspace = current.workspace;
      const launch = current.launch;
      await get().detachSession(key);
      await get().attachSession({
        ...(workspace === '' ? {} : { workspace }),
        ericai: launch.ericai,
        ...(launch.maxSteps === null ? {} : { maxSteps: launch.maxSteps }),
      });
    },

    async retryStartup() {
      // **The announcement is retried first.** A start-up problem can be the
      // bridge never hearing that this window is listening, and in that state
      // starting a child would only queue its handshake behind a door that
      // never opens. Announcing again is harmless when the first one worked:
      // it flips the same flag and releases an empty queue.
      try {
        await attachRuntimeListener();
      } catch (err) {
        set({
          startupProblem: `the window could not start listening to the runtime: ${String(err)}`,
        });
        return;
      }
      set({ startupProblem: null });
      // The active session's child is gone (that is why the screen is up), so
      // this is a fresh session rather than a retry inside a live one.
      await get().attachSession({});
    },

    async quit() {
      await quitApp();
    },

    /* ==========================================================
       Inbound: the only door for runtime facts
       ========================================================== */
    applyRuntimeMessage(key, msg) {
      const s = get();
      const bucket = s.sessions[key];
      // A message for a session that is gone (its child was shut down while a
      // line was in flight) has nowhere to go and is dropped rather than
      // resurrecting a bucket nothing would ever reap.
      if (!bucket) return;

      switch (msg.t) {
        case 'init': {
          const init = projectInit(msg);
          // A handshake means a (possibly different) runtime process is now
          // answering — and the usage ledger lives on **that process's machine**.
          // A snapshot held from the previous connection would describe a ledger
          // this one may not own (a remote workspace, another host), so it is
          // dropped here; switching sessions within one connection keeps it,
          // which is what the window-level slot is for.
          set({ usage: null, usageProblem: null });
          // The handshake's notices are the runtime's own sentences, written for
          // a person. They are kept in their own field, because `session_load`
          // arrives right behind this message and rebuilds the whole transcript —
          // putting them in `entries` here is what made every start-up diagnostic
          // ("no ripgrep", "no model configured") invisible.
          const notices: NoteEntry[] = init.notices.map((notice) => ({
            kind: 'note' as const,
            id: nextId('note'),
            tone: notice.level === 'warn' ? ('warn' as const) : ('info' as const),
            code: notice.code,
            text: notice.text,
          }));
          patch(key, {
            ready: true,
            // The runtime's own id, which is what makes "open the saved session
            // S" able to find this child later.
            sessionId: init.sessionId,
            workspace: init.workspace,
            // The protocol handshake landing is what actually means "ready",
            // for a remote session — see §4.3 of the design: a successful SSH
            // login or a successful remote process start is not sufficient by
            // itself, only this moment is. A local bucket's `connection` is
            // already `{ phase: 'local' }` and this leaves it alone.
            connection: bucket.remoteWorkspaceId === null ? bucket.connection : { phase: 'ready' as const, problem: null },
            session: {
              id: init.sessionId,
              resumed: init.resumed,
              model: init.model,
              provider: init.provider,
              thinking: init.thinking,
              effort: init.effort,
              effortLevels: init.effortLevels,
              maxSteps: init.maxSteps,
              steps: 0,
              stream: init.stream,
              workspace: init.workspace,
              contextTokens: init.contextTokens,
              auditPath: init.auditPath,
              permissions: init.permissions,
              protocol: init.protocol,
            },
            models: init.models,
            modelAliases: init.modelAliases,
            // The registry the tool rows look their risk up in. Without this the
            // badge is permanently unknown, because `toolFacts` would only ever
            // have `ui(tools)` to answer from.
            toolRegistry: init.tools,
            handshakeNotices: notices,
            entries: [...bucket.entries, ...notices],
            // The handshake means this child is up, so a previous refusal is no
            // longer true.
            problem: null,
          });
          // The runtime's own answer about where this session is, which is what
          // the next launch should open — **when this is the session on screen.**
          // A background session's `init` must not move the remembered workspace
          // out from under the person, who is working in the one they can see.
          // Compared with `samePath` so that the ordinary case (the bridge's
          // string, echoed back) is not a write at all.
          //
          // **A remote session's workspace is not remembered, and that is the
          // whole of this condition's second half.** `init.workspace` on a remote
          // child is a path on the *remote* host, and `lastWorkspace` is what the
          // next launch opens **on this machine** (`openFirstSession` asks
          // `workspace_check` for it) — so remembering it would make the next
          // start-up refuse a directory that was never here, and say so on the
          // first screen, because of a session that worked. Where a remote
          // workspace is remembered is `remoteWorkspaces`, which is exactly what
          // the sidebar row is.
          if (
            get().activeKey === key &&
            bucket.remoteWorkspaceId === null &&
            init.workspace.trim() !== ''
          ) {
            get().rememberWorkspace(init.workspace);
          }
          // A task run's link learns its session id here: `init` is the first
          // message that carries one, and until it lands the link is reachable
          // only by the child key. A no-op for every session no task started.
          if (init.sessionId !== '') {
            get().noteTaskRunInit(key, init.sessionId);
          }
          // The first screen shows the four most recent sessions, and only this
          // message ever asks for them. Without it those slots stay empty until
          // somebody opens `/resume`, and `Ctrl+1..9` has nothing to switch to.
          //
          // The list is a **workspace** fact, so what is marked pending is that
          // workspace's list — not this child's bucket. `init.workspace` is the
          // runtime's own name for the directory, which is the key the reply will
          // be filed under, and the child's own `remoteWorkspaceId` names the
          // machine: the same path on another host is a different list.
          markSavedSessionsPending(init.workspace, bucket.remoteWorkspaceId);
          sendTo(key, { v: 1, t: 'session_list', filter: get().sessionFilter });
          break;
        }

        case 'session_load': {
          const history = projectHistory(msg.messages);
          // Rebuild the transcript from the stored messages. Only the two roles a
          // transcript row can draw are rendered. The user count walks with the
          // rebuild: each answer's `userBefore` is how many prompts it sits
          // below in **this** row list, which is the runtime's `Fork` tiebreak
          // for a reply the model produced more than once.
          const rebuilt: Entry[] = [];
          let userRows = 0;
          for (const row of history) {
            if (row.role === 'user') {
              userRows += 1;
              rebuilt.push({ kind: 'user', id: nextId('user'), text: row.text, atMs: 0 });
            } else {
              rebuilt.push({
                kind: 'answer',
                id: nextId('answer'),
                runId: 'history',
                text: row.text,
                userBefore: userRows,
              });
            }
          }
          // The turns this rebuild already accounts for. The stored message list
          // carries no turn boundary, so the rebuilt stream has no `turn` head to
          // read a number from — without this the first message sent after
          // reopening a conversation badged "Turn 1" again (the report: ten turns
          // yesterday, and today's first message restarted the count while the
          // turn rail went on saying 11).
          //
          // One per `user` row, which is exactly how `turnRail` counts a stored
          // turn. See `SessionRuntime.restoredTurns`.
          const restoredTurns = rebuilt.reduce(
            (turns, row) => (row.kind === 'user' ? turns + 1 : turns),
            0,
          );
          // The handshake's diagnostics go back at the head of the rebuilt
          // stream. They belong to the session, not to the moment they were said,
          // and the design is explicit that they are not pushed out by session
          // content.
          //
          // The rebuild also re-reads the notice ledger: everything the rebuilt
          // stream carries counts as seen, so reopening a session does not badge
          // diagnostics that were on screen when it was closed. Only notes that
          // land after this moment are unread.
          const rebuiltEntries = [...bucket.handshakeNotices, ...rebuilt];
          patch(key, {
            entries: rebuiltEntries,
            notesReadCount: rebuiltEntries.reduce(
              (read, row) => (row.kind === 'note' ? read + 1 : read),
              0,
            ),
            restoredTurns,
            activeRunId: null,
            lastRunId: null,
            hasSpoken: history.length > 0,
          });
          break;
        }

        case 'event': {
          const result = reduceEvent(
            bucket.entries,
            // `event` is the audit record forwarded verbatim: loose by design, and
            // unknown kinds and extra fields must be tolerated rather than rejected.
            msg as unknown as LooseEvent,
            {
              activeRunId: bucket.activeRunId,
              lastRunId: bucket.lastRunId,
              // The lookup is bound to **this** session: risk comes from that
              // child's tool registry, and two sessions can have different tools
              // (different workspaces, different loaded skills).
              lookup: (name) => lookupToolFacts(bucket, name),
              maxSteps: bucket.session?.maxSteps ?? 0,
              // What the restored transcript already accounted for, so a new
              // head's "Turn N" continues the conversation instead of restarting
              // at 1. See `SessionRuntime.restoredTurns`.
              restoredTurns: bucket.restoredTurns,
            },
          );
          if (result.stale) {
            patch(key, { lateDropped: bucket.lateDropped + 1 });
            break;
          }
          patch(key, {
            entries: result.entries,
            activeRunId: result.startedRunId ?? (result.runEnded ? null : bucket.activeRunId),
            lastRunId:
              result.startedRunId ?? (result.runEnded ? msg.run_id : bucket.lastRunId),
            // The turn's wall time is on `run_finished` itself, so the status bar
            // does not have to wait for the `status` round trip to show it.
            ...(result.runEnded && typeof msg.duration_ms === 'number'
              ? { lastTurnMs: msg.duration_ms }
              : {}),
            // A successful call's own figures, straight off the event. This is
            // what makes the usage numbers on the bar move per **step** rather
            // than per turn: they were only ever refreshed from `ui(status)`,
            // which is fetched when a turn ends (decision 5 — `status` reads the
            // audit log and must not become a heartbeat).
            ...(result.lastCall ? { liveCall: result.lastCall } : {}),
          });

          // **A new turn opens the way the turn above it is.** The fold is a
          // reading shape, and a person who has just folded a turn's work away
          // does not want the next one to arrive wide open — nor, having opened
          // one to read it, does the next one arrive folded. See
          // `newTurnStartsFolded`, which owns the rule; this is only where the
          // head it applies to is written. `bucket.entries` is the transcript
          // *before* the patch above, so its last head is the turn above.
          if (result.startedRunId !== undefined) {
            const fresh = lastTurnHead(result.entries);
            if (fresh !== null && newTurnStartsFolded(bucket.entries, get().turnFolded)) {
              set({ turnFolded: { ...get().turnFolded, [fresh.id]: true } });
            }
          }

          // A finished turn is the one moment the usage/cache/elapsed numbers are
          // worth fetching (decision 5) — and it is also what lifts the poll
          // backoff, since a turn that just ended can change what is outstanding.
          if (result.runEnded) {
            wakePolling(key);
            pollNow(key, () => sendTo(key, { v: 1, t: 'status' }));

            // A task-started run's verdict, written the one moment it is
            // knowable. Read from the **post-patch** state rather than from
            // `msg`, because `result.entries` is the whole transcript and
            // `lastStopReason` is the single authority on how a turn ended —
            // restating that mapping here would be a second copy of the rule
            // `selectRowStatus` already owns.
            //
            // The order matters: this runs after the `patch` above, so the
            // finished turn is in `entries`, and before anything can close the
            // child. A no-op for a session no task started.
            const settled = get().sessions[key];
            if (settled !== undefined) {
              const stop = lastStopReason(settled.entries);
              if (stop !== null) {
                get().noteTaskRunOutcome(
                  key,
                  outcomeOfTurnStatus(stop),
                  typeof msg.duration_ms === 'number' ? msg.duration_ms : null,
                );
              }
            }

            // **The rail's saved list is re-read here, and this is the fix for
            // the frozen numbers.** A row used to carry whatever `sessions.items`
            // said the first time, and the list was only ever asked for again
            // while the *active* conversation was still missing from its own
            // child's copy — so a conversation's message and step counts stayed
            // at their first-ever values for the life of the window: one session
            // showed 135 · 48 in the rail while its file held 237 messages.
            //
            // A finished turn is the right moment and the only one needed: the
            // checkpoint that ends it is what writes the messages down, so this
            // is when any row's numbers can have changed. It is bounded by
            // **turns**, not by time, which is why it needs no throttle of its
            // own — a turn is not a heartbeat. The read is `LoadSummary` per
            // session, which skips the `ctx` records that make up the bulk of a
            // real file.
            //
            // The reply is filed under this child's **workspace**, so it also
            // refreshes the rail for every other conversation open in it.
            //
            // A conversation with no id yet has no file and nothing to list.
            if (bucket.sessionId !== null) {
              sendTo(key, { v: 1, t: 'session_list', filter: get().sessionFilter });
            }
          }
          break;
        }

        case 'ui': {
          switch (msg.kind) {
            case 'state': {
              applyStateSnapshot(set, get, key, projectState(msg));
              break;
            }
            case 'status': {
              patch(key, { status: projectStatus(msg) });
              break;
            }
            case 'tools': {
              const projected = projectToolsMsg(msg);
              patchWith(key, (current) => ({
                tools: projected.tools,
                grantedPrefixes: projected.grantedPrefixes,
                entries: pushBlock(current.entries, 'tools', msg),
              }));
              break;
            }
            case 'mcp': {
              const projected = projectMcpMsg(msg);
              // This is the runtime answering an `mcp` message, so whatever this
              // front end had in flight has been answered. The reply carries no
              // request id, so the marks are released as a batch rather than one
              // by one; a person pressing two rows before the first answers would
              // see the first reply clear both. That is a cosmetic early release
              // and never a claim about a server — the state on the row still
              // comes from this payload alone.
              patchWith(key, (current) => ({
                mcp: projected.servers,
                mcpNotes: projected.notes,
                mcpPending: [],
                // The runtime's own notes go into the stream, verbatim.
                ...(projected.notes.length > 0
                  ? {
                      entries: [
                        ...current.entries,
                        ...projected.notes.map((text) => ({
                          kind: 'note' as const,
                          id: nextId('note'),
                          tone: 'info' as const,
                          code: 'mcp',
                          text,
                        })),
                      ],
                    }
                  : {}),
              }));
              break;
            }
            case 'context': {
              const context = projectContext(msg);
              patchWith(key, (current) => ({
                context,
                contextMsg: msg,
                // When the request came from the context panel, the answer goes
                // to the panel alone — a block inserted into the transcript
                // behind the open dialog would be a second copy the reader did
                // not ask for. The palette's `/context` closes no panel and
                // keeps the block, exactly as it always did.
                ...(get().panel === 'context'
                  ? {}
                  : { entries: pushBlock(current.entries, 'context', msg) }),
              }));
              break;
            }
            case 'compacted': {
              const projected = projectCompacted(msg);
              patchWith(key, (current) => ({
                compaction: projected.compaction,
                ...(projected.context ? { context: projected.context } : {}),
                entries: pushBlock(current.entries, 'compact', msg),
              }));
              break;
            }
            case 'skills': {
              // `ui(skills)` is the real source for "what is loaded": `skills` is
              // the catalogue this session *can* load and `active` is the names
              // actually loaded. `ui(state).skills` is pointers for the loaded
              // ones, which is why the digest and description are merged in from
              // there rather than taken from this message.
              const projected = projectSkillsMsg(msg);
              const merged = mergeSkills(
                bucket.uiState?.skills ?? [],
                bucket.skillCatalog,
                projected.available,
                projected.active,
              );
              patch(key, {
                skills: merged.loaded,
                skillAvailable: merged.available,
                skillActive: projected.active,
                skillProblems: projected.problems,
                skillShadowed: projected.shadowed,
              });
              break;
            }
            case 'files': {
              // The **runtime's** path, not the one that was asked for: the two
              // differ after a `/./src/../src`, and the reply's spelling is what
              // makes "where am I" answerable and the parent-directory step
              // correct.
              //
              // `filesProblem` is cleared here because this *is* the answer: the
              // refusal that set it belongs to a request that has now been
              // superseded.
              patch(key, {
                filesPath: typeof msg.path === 'string' ? msg.path : '',
                filesEntries: Array.isArray(msg.entries) ? msg.entries : [],
                filesLoading: false,
                filesProblem: null,
              });
              break;
            }
            case 'memory': {
              // **The snapshot replaces, never merges.** It is the runtime's whole
              // answer about what memories and proposals exist, and a front end that
              // unioned it with what it already had would keep a published proposal on
              // the review list for ever — the same rule the terminal list follows.
              //
              // `problem` arrives on a refusal **together with** the snapshot, which is
              // why the two are handled in one branch: the panel has to say what failed
              // and still draw the state it failed in.
              const snapshot = msg.memory;
              patchWith(key, (live) => {
                const uiState = live.uiState
                  ? {
                      ...live.uiState,
                      // The workbench's Memory badge reads `uiState.memoryPending`,
                      // which a state snapshot keeps fresh. A publish or reject in
                      // the panel must not leave it showing the pre-decision count
                      // until the next state snapshot happens to arrive — so the
                      // panel's own answer re-stamps the same figure, from the same
                      // runtime snapshot. When the answer carried no snapshot
                      // (a refusal that dropped it) the old value is kept, and a
                      // `null` from a runtime below protocol 8 stays `null`, not
                      // zero: "the runtime did not say" is not "the queue is empty".
                      memoryPending: Array.isArray(snapshot?.candidates)
                        ? snapshot.candidates.length
                        : live.uiState.memoryPending,
                    }
                  : live.uiState;
                return {
                  ...(snapshot && typeof snapshot === 'object'
                    ? { memory: snapshot as MemorySnapshot }
                    : {}),
                  uiState,
                  memoryProblem: typeof msg.problem === 'string' && msg.problem !== ''
                    ? msg.problem
                    : null,
                };
              });
              break;
            }
            case 'codeintel': {
              // **The snapshot replaces, never merges** — the same rule the memory
              // panel follows, and for the same reason: the runtime is the only
              // source of truth about what the index holds, and a front end that
              // unioned the new answer with its own copy would keep drawing a file
              // count from a build that has since been replaced.
              //
              // Two kinds of message land here and both carry this shape: the answer
              // to a `codeintel_action`, and a **pushed** message from a build in
              // flight (progress, and the outcome when it ends). That is why the
              // branch does not distinguish them — the payload says everything the
              // panel needs, including whether a build is still running.
              //
              // `problem` arrives beside the snapshot rather than instead of it: a
              // refused action has to say what failed *and* still draw the state it
              // failed in.
              const snapshot = msg.codeintel;
              patchWith(key, (live) => ({
                ...(snapshot && typeof snapshot === 'object'
                  ? { codeintel: snapshot as CodeIntelSnapshot }
                  : {}),
                // The switch is also carried on `ui(state)`; this keeps the workbench
                // row and any badge in step with the panel's own answer instead of
                // waiting for the next tool result to arrive.
                uiState:
                  snapshot && typeof snapshot === 'object' && live.uiState
                    ? {
                        ...live.uiState,
                        codeintel: {
                          enabled: snapshot.enabled,
                          indexed: snapshot.indexed,
                          building: snapshot.building,
                        },
                      }
                    : live.uiState,
                codeintelProblem:
                  typeof msg.problem === 'string' && msg.problem !== '' ? msg.problem : null,
              }));
              break;
            }
            case 'usage': {
              // **A window-level slot, not a bucket field.** The ledger counts this
              // user's spend across every workspace, so the snapshot means the same
              // thing whatever conversation the answer arrived on — filing it under
              // the session would blank the panel on every switch. `set`, not
              // `patchWith`, for exactly that reason.
              //
              // The snapshot replaces, never merges (the codeintel rule); `problem`
              // with no snapshot is the one refusal that has nothing to draw beside
              // it, and it clears the previous problem rather than joining it — the
              // newest answer is the only one the panel should be able to name.
              const snapshot = msg.usage && typeof msg.usage === 'object' ? msg.usage : null;
              set({
                ...(snapshot !== null ? { usage: snapshot } : {}),
                usageProblem:
                  typeof msg.problem === 'string' && msg.problem !== '' ? msg.problem : null,
              });
              break;
            }
            case 'probe_effort': {
              // The answer is a **replacement**, not a merge — the codeintel
              // rule — and it is filed beside the session for the same reason:
              // the (model, provider) it names is what a config save looks up
              // afterwards, and a switch of model in the meantime is exactly
              // what the panel uses to decide the result no longer applies.
              //
              // `problem` with no snapshot is the one refusal that has nothing
              // to draw beside it (the runtime cannot probe, or the pass
              // failed), and it clears the previous problem rather than
              // joining it: the newest answer is the only one the panel names.
              const snapshot =
                msg.probe && typeof msg.probe === 'object' ? (msg.probe as ProbeEffortSnapshot) : null;
              patch(key, {
                ...(snapshot !== null
                  ? { probeEffort: snapshot, probeEffortAt: Date.now() / 1000 }
                  : {}),
                // The answer — refusal or result — ends the pass either way.
                probeEffortStartedAt: null,
                probeEffortProblem:
                  typeof msg.problem === 'string' && msg.problem !== '' ? msg.problem : null,
              });
              break;
            }
            case 'file_read': {
              // **Two destinations, one answer.** The body goes into the
              // transcript as a block — that is where a file read belongs in
              // arrival order — *and* into the browser's own viewer, because the
              // browser is a modal layer drawn over the transcript. Without the
              // second one, pressing Enter on a file in the panel changed nothing
              // anybody could see.
              //
              // `filesLoading` is not cleared here: a read is not a listing, and
              // releasing the listing's spinner on a read's answer would say "the
              // directory came back" when it did not.
              patchWith(key, (current) => ({
                fileView: {
                  // The path the answer is about, taken **from the payload**: the
                  // runtime may have normalised it, and a viewer labelled with
                  // the request's spelling would name a path it did not read.
                  path: typeof msg.path === 'string' ? msg.path : '',
                  answer: msg,
                  problem: null,
                },
                // `appendBlock`, not `pushBlock`: a file read is one of a
                // sequence, not the newest state of one thing. Replacing meant
                // opening a second file deleted the first from the transcript.
                entries: appendBlock(current.entries, 'file', msg),
              }));
              break;
            }
            case 'terminals': {
              // The list is **replaced**, never merged: it is the runtime's whole
              // answer, and a front end that unioned it with what it already had
              // would keep a closed terminal's tab alive for ever.
              //
              // So this is also where a closed terminal's leftovers go, and there
              // are exactly two of them. Its output tail can never receive
              // another byte once the runtime has forgotten the id, and the
              // attach can no longer resolve to a row — leaving either in place
              // would draw a terminal view for a shell that does not exist, with
              // no tab to switch away from it.
              //
              // **A refused create also answers with this list** (see the
              // runtime's `handleTerminalCreate`), which is why `'new'` is
              // released here as well as on success: otherwise one refusal would
              // leave the "New terminal" button disabled for the rest of the
              // session, with nothing on screen to explain why.
              const rows = Array.isArray(msg.terminals) ? msg.terminals : [];
              patchWith(key, (current) => applyTerminalList(current, rows));
              break;
            }
            case 'terminal_created': {
              // The new row goes into the list straight away so the panel can
              // show it without waiting for a snapshot, and the answer also
              // **attaches** to it: the reply to "open a terminal" is a shell to
              // type into, not a list to read.
              const row = msg.terminal;
              patchWith(key, (current) => ({
                terminals: row ? [...current.terminals, row] : current.terminals,
                activeTerminalId: row && row.id ? row.id : current.activeTerminalId,
                terminalPending: current.terminalPending.filter((id) => id !== 'new'),
              }));
              break;
            }
            case 'terminal_output': {
              // The one high-frequency message. It carries no row, no snapshot
              // and no status — only which terminal and which bytes — so this
              // handler does one thing: append to that terminal's bounded tail.
              const id = msg.terminal_id;
              const data = typeof msg.data === 'string' ? msg.data : '';
              if (id === '' || data === '') break;
              patchWith(key, (current) => ({
                terminalTails: appendTerminalOutput(current.terminalTails, id, data),
              }));
              break;
            }
            case 'terminal_exit': {
              const exited = msg.terminal;
              // **The second half of a close.** Somebody clicking the tab of a
              // running shell asked to be rid of it, and the runtime's rule is
              // that a running terminal can be ended but not forgotten — so the
              // ending had to come first, and this is where it has arrived. The
              // row is now an ended one, which the close will accept.
              //
              // Read before the patch, because the patch is what clears it.
              const pendingClose = bucket.terminalClosing.includes(msg.terminal_id);
              patchWith(key, (current) => ({
                // The row is **replaced whole** rather than patched: it carries
                // the status and the exit code the runtime decided, and merging
                // two fields by hand is how the row and the runtime end up
                // describing different terminals.
                terminals: exited
                  ? replaceTerminal(current.terminals, exited)
                  : current.terminals,
                terminalPending: current.terminalPending.filter(
                  (id) => id !== msg.terminal_id,
                ),
                terminalClosing: current.terminalClosing.filter(
                  (id) => id !== msg.terminal_id,
                ),
                entries: [
                  ...current.entries,
                  {
                    kind: 'note' as const,
                    id: nextId('note'),
                    tone: msg.reason === 'killed' ? ('warn' as const) : ('info' as const),
                    code: 'terminal',
                    // **No sentence here.** The store holds the fact; `i18n`
                    // holds the words (see `FrontMessage`). This used to build
                    // `Terminal term-01 exited with code 0.` inside the reducer,
                    // which put English in the store and made the one sentence a
                    // person reads about a dead shell unreachable by translation.
                    text: '',
                    message: terminalEndedNote(msg.terminal_id, msg.reason, msg.exit_code ?? null),
                  },
                ],
              }));
              if (pendingClose) {
                sendTo(key, { v: 1, t: 'terminal_close', terminal_id: msg.terminal_id });
              }
              break;
            }
            case 'run_finished': {
              const runId = msg.run_id;
              const answer = typeof msg.answer === 'string' ? msg.answer : '';
              // The two `run_finished` messages are not ordered, so pairing is by
              // run id alone. A mismatch against a *different* finished run is
              // dropped; anything else is this session's answer.
              if (
                bucket.activeRunId !== null &&
                runId !== bucket.activeRunId &&
                runId !== bucket.lastRunId
              ) {
                patch(key, { lateDropped: bucket.lateDropped + 1 });
                break;
              }
              patch(key, {
                // `answer` is read through a type guard rather than passed
                // straight on. It reaches `Markdown`, which calls `text.replace`,
                // and there is no error boundary above it — so one message with a
                // missing or non-string `answer` would blank the whole window
                // instead of dropping a line. A missing answer is simply absent:
                // `applyFinalAnswer` keeps the streamed body in that case.
                entries: applyFinalAnswer(bucket.entries, runId, answer),
                activeRunId: null,
                lastRunId: runId,
                // A refine run's report is the turn that carries the candidate
                // blocks, and this finish is the moment they are read out of it:
                // the question's answer applies against the extracted list, not
                // the transcript — every `session_load` rebuilds the entries, and
                // a later turn has moved the stream on by the time a person picks.
                ...(bucket.refineTaskId !== null && answer !== ''
                  ? { refineCandidates: extractRefinePrompts(answer) }
                  : {}),
                // The turn is over. If nobody is looking at this session, that
                // is the fact the blue dot exists to report — a background
                // session that finished is not running, not asking and not
                // broken, so without this it would show nothing at all.
                ...(s.activeKey === key ? {} : { unseen: true }),
              });
              break;
            }
            default:
              break;
          }
          break;
        }

        case 'delta': {
          const result = applyDelta(
            bucket.entries,
            msg.run_id,
            msg.step,
            msg.channel,
            msg.text,
            bucket.activeRunId,
            bucket.lastRunId,
          );
          if (result.stale) {
            patch(key, { lateDropped: bucket.lateDropped + 1 });
            break;
          }
          patch(key, { entries: result.entries });
          break;
        }

        case 'delta_reset': {
          if (
            (bucket.activeRunId !== null && msg.run_id !== bucket.activeRunId) ||
            (bucket.activeRunId === null &&
              bucket.lastRunId !== null &&
              msg.run_id !== bucket.lastRunId)
          ) {
            patch(key, { lateDropped: bucket.lateDropped + 1 });
            break;
          }
          // Both channels are cleared for that step: the message carries no
          // channel, and a reset invalidates whatever was drawn for the step.
          patch(key, {
            entries: clearStream(
              clearStream(bucket.entries, msg.run_id, msg.step, 'text'),
              msg.run_id,
              msg.step,
              'reasoning',
            ),
          });
          break;
        }

        case 'notice': {
          // **A refusal is an answer too.** A `notice` with `code: 'files'` is
          // what the runtime sends instead of `ui(files)` when it will not list
          // or read a path, so it is also the only thing that can release the
          // listing's spinner — and the sentence that explains it belongs to the
          // panel the person is looking at, not only to the transcript that panel
          // is covering.
          //
          // Other notices are untouched by this and still go to the stream,
          // verbatim.
          patchWith(key, (current) => ({
            ...(msg.code === 'files'
              ? {
                  filesLoading: false,
                  filesProblem: msg.text,
                  ...(current.fileView && current.fileView.answer === null
                    ? { fileView: { ...current.fileView, problem: msg.text } }
                    : {}),
                }
              : {}),
            entries: [
              ...current.entries,
              {
                kind: 'note',
                id: nextId('note'),
                tone: msg.level === 'warn' ? 'warn' : 'info',
                code: msg.code,
                // Written by the runtime for a person. Displayed verbatim.
                text: msg.text,
              },
            ],
          }));
          break;
        }

        case 'sessions': {
          // **A workspace fact, not a session one.** The list is built by reading
          // the session files of one directory, so every child in that workspace
          // would answer identically — and storing it in the bucket of whichever
          // child replied is what made the rail's list change when nobody asked
          // it to. See `SavedSessions`.
          noteSavedSessions(
            bucket.session?.workspace ?? bucket.workspace,
            bucket.remoteWorkspaceId,
            projectSessionList(msg.items),
            true,
          );
          break;
        }

        case 'permission_request': {
          // A blocking modal outranks everything (priority: approval > question >
          // panel > stream).
          //
          // **Queued, never overwritten.** The runtime waits forever on the id it
          // asked about, so replacing an unanswered request with a second one
          // loses the first id permanently and hangs that call. Only the head is
          // rendered; the rest wait their turn.
          set(enqueueModal(get(), { kind: 'permission', key, req: msg }));
          break;
        }

        case 'question_request': {
          // One batch member. The rest of the batch is already on its way —
          // the runtime sends them back to back — and `enqueueModal` merges
          // the members into the one entry that holds the batch.
          set(enqueueModal(get(), { kind: 'question', key, batch: questionBatchOf(msg) }));
          break;
        }

        case 'runtime_exited': {
          // The runtime is gone, so this turn cannot end any other way. Without
          // this the phase stays "Running" forever: the composer sits behind its
          // Stop button, Enter and Esc both do nothing, and the "Stop" message
          // goes into a `.catch(() => {})` because there is no child to receive
          // it. The turn is settled with a reason the reader can act on.
          //
          // The child is also the only thing that could ever answer a request it
          // was waiting on, so its own pending requests leave the queue —
          // `releaseModalsOf` re-aims the rendered slot at the focus, exactly as
          // `detachSession` does. Without this the dot stays amber for ever on
          // a session whose prompt can no longer exist, and one sitting in the
          // rendered slot would keep the composer and rail inert around
          // nothing.
          set({ ...releaseModalsOf(get(), key, get().activeKey) });
          patch(key, {
            runtimeExit: { code: msg.code, requested: msg.requested },
            entries: settleAbandonedTurn(bucket.entries),
            activeRunId: null,
            // Cleared so the next turn is not attributed against a dead run.
            lastRunId: null,
            // Nothing will answer an MCP request now, so the marks must go: a
            // button left disabled by a reply that can never arrive is worse than
            // one that lets the person press again after the runtime is back.
            mcpPending: [],
            // §5.1/§5.3 of the design: a connection ending is reported through
            // its own state, independent of the turn it leaves unsettled above.
            // `requested` is what the Rust/Go bridges already use to separate
            // "the front end asked to close" from "the SSH session dropped or
            // the remote process died" — the same distinction `RuntimeExited`
            // makes on the Go side, carried through unchanged rather than
            // re-derived here from an exit code alone.
            connection:
              bucket.remoteWorkspaceId === null
                ? bucket.connection
                : msg.requested
                  ? { phase: 'closed' as const, problem: null }
                  : {
                      phase: 'interrupted' as const,
                      problem: `the connection ended unexpectedly (exit code ${msg.code})`,
                    },
          });

          // A task-started run whose child died. §"the child is the only thing
          // that could settle this turn" above: if one *was* running,
          // `settleAbandonedTurn` closed it with `runtime_exited` and that is
          // the verdict. If none was, the exit itself is the statement —
          // but only when nobody asked for it. See `outcomeOfChildExit` for why
          // a requested close records nothing rather than recording success.
          {
            const settled = get().sessions[key];
            if (settled !== undefined) {
              const stop = lastStopReason(settled.entries);
              const verdict =
                stop === 'runtime_exited'
                  ? outcomeOfTurnStatus(stop)
                  : outcomeOfChildExit(msg.requested);
              if (verdict !== null) get().noteTaskRunOutcome(key, verdict, null);
            }
          }
          break;
        }

        default:
          break;
      }
    },

    /* ==========================================================
       Composer — all of it scoped to the active session
       ========================================================== */
  };
}
