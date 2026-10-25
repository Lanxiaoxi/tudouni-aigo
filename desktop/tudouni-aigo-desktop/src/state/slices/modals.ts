/**
 * modals slice.
 *
 * Moved verbatim out of store.ts; the wrapper is all that changed — the
 * shared helpers arrive as `ctx` instead of being closed over.
 */
import type { StoreContext } from '../storeContext';
import type { AppStore } from '../storeShape';
import { nextId } from '@/state/entries';
import { refineSelectedNumbers } from '@/learn/refineTemplate';
import { sendTo } from '@/runtime/bus';
import { inlineImage, inlineImageRemote, readRemoteRuntimeVersion } from '@/runtime/tauri';
import { drainModal } from '../modalQueue';
import { pollNow } from '../polling';
import { selectModalVisible } from '../selectors/session';
import { activeWorkspaceOf, remoteConnectionOf } from '../appView';

export function modalsSlice(ctx: StoreContext): Pick<AppStore, 'answerPermission' | 'answerQuestion' | 'minimizeQuestion' | 'restoreQuestion' | 'requestSessionList' | 'resolveRuntimeBuild' | 'deleteSession' | 'archiveSession' | 'forkSession' | 'setAutopilot' | 'chooseModel' | 'chooseEffort' | 'setThinking' | 'requestBlock' | 'refreshContext' | 'refreshStatus' | 'requestMcp' | 'requestSkills' | 'goalAction' | 'refreshState' | 'listFiles' | 'readFile' | 'previewImage' | 'requestMemory' | 'memoryAction' | 'requestCodeIntel' | 'codeIntelAction' | 'requestUsage'> {
  const { set, get, patch, patchWith, markSavedSessionsPending } = ctx;
  return {
    answerPermission(decision) {
      const m = get().modal;
      if (!m || m.kind !== 'permission') return;
      // Closing the modal is only visual; the permission record row waits for the
      // runtime's own `permission` event.
      set(drainModal(get()));
      // **Back to the session that asked.** This is the one send in this file
      // whose target is not `activeKey`, and it has to be: the answer belongs to
      // the id the runtime is blocked on, and a response delivered to another
      // child both hangs the asker (it waits on that id forever) and consumes
      // the other one's attention on a question nobody asked it.
      sendTo(m.key, { v: 1, t: 'permission_response', id: m.req.id, decision });
    },

    answerQuestion(answers) {
      const m = get().modal;
      if (!m || m.kind !== 'question') return;
      set(drainModal(get()));
      // **One response per request id.** The runtime opened one waiter per
      // question and blocks on each of them, so a batch is answered by a batch:
      // every id of it gets its own `question_response`, in order. `answers`
      // is null when the person skipped the whole batch, and a null entry
      // skips that one question — both are explicit, never an empty submit.
      const members = m.batch.questions;
      for (let index = 0; index < members.length; index++) {
        const member = members[index];
        if (member === null) continue; // never happens while ready, but the wire id is the contract
        const text = answers === null ? '' : ((answers[index] ?? '').trim());
        const status = answers === null || text === '' ? 'skipped' : 'answered';
        sendTo(m.key, {
          v: 1,
          t: 'question_response',
          id: member.id,
          status,
          text,
        });
      }
      // The refine delivery: when the question came out of a refine run, the
      // person's choice is applied here, by the front end. The agent never
      // touches `aigo.prefs` (it cannot — that is this window's persistence),
      // so the selected candidate's text, read back out of the report this
      // session delivered, is the only copy that ever lands on the task.
      // `createdAtMs` is the task's birth and survives; `updatedAtMs` moves.
      // A refine run asks exactly one question, so the batch's first member
      // is the one the choice refers to.
      const first = answers?.[0] ?? null;
      if (first !== null && first.trim() !== '') {
        const text = first;
        const bucket = get().sessions[m.key];
        const taskId = bucket?.refineTaskId ?? null;
        const candidates = bucket?.refineCandidates;
        if (taskId !== null && candidates !== null && candidates.length > 0) {
          const task = get().tasks.find((row) => row.id === taskId);
          if (task !== undefined) {
            const chosen = refineSelectedNumbers(text, candidates.length);
            const applied = chosen.filter((n) => candidates[n - 1] !== undefined);
            if (applied.length > 0) {
              const newPrompt = candidates[applied[applied.length - 1] - 1];
              get().upsertTask({ ...task, prompt: newPrompt });
            }
            // The report either way: it is the one line that says what the
            // choice did. Zero is "the answer named nothing recognisable",
            // which is a fact the transcript should carry rather than an
            // application that silently did not happen.
            patchWith(m.key, (b) => ({
              entries: [
                ...b.entries,
                {
                  kind: 'note' as const,
                  id: nextId('note'),
                  tone: 'info' as const,
                  code: 'refineApplied',
                  text: '',
                  message: { code: 'refineApplied' as const, taskId, applied: applied.length },
                },
              ],
            }));
          }
        }
      }
    },

    minimizeQuestion() {
      const m = get().modal;
      // Only a drawn question can be put aside. A permission request is a
      // decision to read in full (see its own header), and a held request is
      // already off screen — minimizing it would be a gesture with no effect.
      if (!m || m.kind !== 'question' || !selectModalVisible(get())) return;
      // No message goes out: the runtime keeps waiting on this id, and the
      // queue keeps holding the request. The render is the only thing that
      // moves. See the field's comment for why `selectModalVisible` is
      // deliberately left unchanged.
      // The mark keys to the **batch** id: minimize puts the whole panel
      // aside, and restoring brings back every page of it.
      set({ questionMinimizedId: m.batch.batch_id });
    },

    restoreQuestion() {
      const s = get();
      if (s.questionMinimizedId === null) return;
      const m = s.modal;
      // Still minimized and still the one in the drawn slot: bring it back.
      if (m && m.kind === 'question' && m.batch.batch_id === s.questionMinimizedId) {
        set({ questionMinimizedId: null });
        return;
      }
      // The request moved on (answered, switched, the child died): nothing to
      // restore, so the mark goes. Id-keying makes this unreachable in
      // practice — those paths already clear it — but the pill must never
      // point at a request that is not on screen, and this is the last place
      // to guarantee that.
      set({ questionMinimizedId: null });
    },

    /* ==========================================================
       Session list and per-session settings
       ========================================================== */
    requestSessionList() {
      const key = get().activeKey;
      if (key === null) return;
      // The **workspace's** list goes back to loading, not this child's: the
      // reply is filed under the workspace (see `SavedSessions`), so marking a
      // bucket would leave the rail drawing the old list over a refresh that is
      // on its way. The machine comes off the same bucket as the path.
      const current = get().sessions[key];
      markSavedSessionsPending(
        activeWorkspaceOf(get()),
        current?.remoteWorkspaceId ?? null,
      );
      sendTo(key, { v: 1, t: 'session_list', filter: get().sessionFilter });
    },

    /**
     * Ask the host which build it is running, once per session, and keep it.
     *
     * **Only a remote session needs this**, and only when somebody looks: the
     * window-level version reads this machine's binary, which on a remote screen
     * is the wrong answer beside a `protocol` that came from the host.
     *
     * Lazy rather than at connect, because it costs an SSH dial and the answer is
     * wanted by one panel. A session that already has it is not asked again — the
     * process on the far end cannot change its build mid-life.
     */
    async resolveRuntimeBuild(key) {
      const current = get().sessions[key];
      if (current === undefined) return;
      if (current.remoteWorkspaceId === null) return; // local: the window value is right
      if (current.runtimeBuild !== null) return; // asked already

      const build = await readRemoteRuntimeVersion(key);
      // Re-read rather than patch blindly: the session may have been closed, or
      // opened again under a new key, while the host was answering.
      if (!get().sessions[key]) return;
      // `null` is stored as an empty string, because "asked and the host did not
      // answer" is a different fact from "never asked" — and the panel draws
      // them differently.
      patch(key, { runtimeBuild: build ?? '' });
    },

    deleteSession(id, via) {
      const s = get();
      // The default route is the focused child, as always; a caller that names
      // `via` (the board's card menu) acts through that card's own connection —
      // the process whose workspace the session file actually lives in.
      const key = via ?? s.activeKey;
      if (key === null) return;

      // **Any other child holding this session is stopped first.** The runtime
      // waits its *own* turn out before deleting (see `Server.deleteSession`),
      // but it cannot see another process's writer — and deleting a file out
      // from under an appender is how a half line happens. With one session per
      // conversation that other process is now possible, so it is checked.
      for (const other of s.order) {
        if (other === key) continue;
        if (s.sessions[other]?.sessionId === id) void get().detachSession(other);
      }

      // No optimistic removal: the row leaves the list when the runtime's next
      // `sessions` arrives, because the delete can fail (a locked file, a
      // `sub-` id) and a row that vanished on send would be a lie.
      sendTo(key, { v: 1, t: 'session_delete', session_id: id });
    },

    archiveSession(id, archived, via) {
      const s = get();
      // The default route is the focused child, as always; the board's card
      // menu names the card's own connection, which is the one process whose
      // workspace this session file actually lives in.
      const key = via ?? s.activeKey;
      if (key === null) return;

      // **The one gate the runtime cannot keep.** "Do not archive a session a
      // running child is writing" is a fact about *this end's* connections — the
      // runtime has no view of the other processes, so it neither can nor should
      // refuse. The index is the same one `openSession` maintains; a hit means a
      // live child holds this id, and archiving would edit metadata under a
      // writer.
      //
      // **One route is exempt on purpose: the holder itself.** The runtime
      // waits its *mounted* session's turn out before rewriting
      // (`Server.archiveSession` joins the turn), so the holder's own writes are
      // quiesced — coupling the next write to the archive instead of racing it.
      // Any *other* holder is still a writer outside that wait, and the action
      // refuses it. The controls disable for any live row, so the default path
      // never files an archive under a holder; the exemption is what lets the
      // card menu act on a card that is definitionally open.
      for (const other of s.order) {
        if (other === via) continue;
        if (s.sessions[other]?.sessionId === id) return;
      }

      // No optimistic change: the row's flag and the list both wait for the
      // runtime's next `sessions`. The filter's effect (a newly archived row
      // leaving an `active`-only list) is the runtime's to apply, before its cap.
      sendTo(key, { v: 1, t: 'session_archive', session_id: id, archived });
    },

    forkSession(reply, userBefore) {
      const s = get();
      const key = s.activeKey;
      if (key === null) return;
      const sessionId = s.sessions[key]?.sessionId;
      // The id arrives with the handshake, not with the first message: before
      // `init` the runtime has not named the conversation, and a fork without
      // a source is a copy of nothing.
      if (sessionId === null || sessionId === '') return;
      // A turn running would end mid-fork: the runtime joins it before it
      // copies, so the request is safe to file now, but a turn in flight is
      // also a transcript that is still changing — the `userBefore` count it
      // was named from is no longer true, and a fork from a mid-answer row
      // would cut a turn in half. The button is not drawn while a turn runs;
      // this is the same fact checked here, because a click that beats the
      // redraw would otherwise race the answer.
      if (s.sessions[key]?.activeRunId !== null) return;
      sendTo(key, { v: 1, t: 'session_fork', session_id: sessionId, reply, user_before: userBefore });
    },

    setAutopilot(on) {
      const key = get().activeKey;
      if (key === null) return;
      // Absolute state, not a toggle. The display waits for `ui(state)`.
      sendTo(key, { v: 1, t: 'set_autopilot', on });
    },

    chooseModel(model) {
      const key = get().activeKey;
      set({ panel: null });
      if (key === null) return;
      sendTo(key, { v: 1, t: 'set_model', model });
    },

    chooseEffort(effort) {
      const key = get().activeKey;
      set({ panel: null });
      if (key === null) return;
      sendTo(key, { v: 1, t: 'set_effort', effort });
    },

    setThinking(on) {
      const key = get().activeKey;
      if (key === null) return;
      sendTo(key, { v: 1, t: 'set_thinking', on });
    },

    requestBlock(which) {
      const key = get().activeKey;
      set({ panel: null });
      if (key === null) return;
      if (which === 'status') sendTo(key, { v: 1, t: 'status' });
      if (which === 'tools') sendTo(key, { v: 1, t: 'tools' });
      if (which === 'context') sendTo(key, { v: 1, t: 'context' });
      if (which === 'compact') sendTo(key, { v: 1, t: 'compact' });
    },

    refreshContext() {
      const key = get().activeKey;
      if (key === null) return;
      sendTo(key, { v: 1, t: 'context' });
    },

    refreshStatus() {
      const key = get().activeKey;
      if (key === null) return;
      sendTo(key, { v: 1, t: 'status' });
    },

    requestMcp(action, servers) {
      const key = get().activeKey;
      if (key === null) return;
      // A load/unload is a real round trip — the runtime waits the running turn
      // out and then connects, which is seconds — so the row marks it as in
      // flight. `list` changes nothing and answers immediately, so it is not worth
      // marking.
      //
      // This is **not** an optimistic update: it claims nothing about the server's
      // state, only that this front end has just sent the request. The state still
      // comes from `ui(state)` and from nowhere else.
      if (action !== 'list') {
        const current = get().sessions[key];
        const pending = new Set(current?.mcpPending ?? []);
        for (const name of servers) pending.add(name);
        patch(key, { mcpPending: [...pending] });
      }
      sendTo(key, { v: 1, t: 'mcp', action, servers });
    },

    requestSkills() {
      const key = get().activeKey;
      if (key === null) return;
      sendTo(key, { v: 1, t: 'skills' });
    },

    goalAction(action) {
      const key = get().activeKey;
      if (key === null) return;
      sendTo(key, action === undefined ? { v: 1, t: 'goal' } : { v: 1, t: 'goal', action });
    },

    refreshState() {
      const key = get().activeKey;
      if (key === null) return;
      pollNow(key, () => sendTo(key, { v: 1, t: 'refresh_state' }));
    },

    /* ==========================================================
       The workspace: files
       ========================================================== */

    listFiles(path) {
      const key = get().activeKey;
      if (key === null) return;
      // The previous refusal is cleared here rather than on the answer: a new
      // listing supersedes it the moment it is asked for, and leaving it up would
      // show a stale reason over a directory that may now list fine.
      patch(key, { filesLoading: true, filesProblem: null });
      // The path is sent verbatim. Whether it exists, is a directory, or stays
      // inside the workspace is the **runtime's** judgement — it holds the
      // boundary — and a second check here would be a second answer that
      // eventually disagrees with it.
      sendTo(key, { v: 1, t: 'file_list', path });
    },

    readFile(path) {
      const key = get().activeKey;
      if (key === null) return;
      // The viewer's own state, so the panel can say "reading…" in place. The
      // transcript block is still the runtime's answer and still arrives on its
      // own; this is the panel's copy of the same fact, not a second one.
      patch(key, { fileView: { path, answer: null, problem: null } });
      sendTo(key, { v: 1, t: 'file_read', path });
    },

    previewImage(path) {
      // **Open the panel first, before any session check.**
      //
      // The bytes need a session (the workspace they are relative to is that
      // child's), but *opening a window* does not — and returning early on a null
      // key made the card do nothing at all in a window that had no live session,
      // which is a dead button rather than a refusal. Nothing is read in that
      // case; the viewer says so.
      // `true` is the focus flag, so `openPanel` sets it in the same update that
      // opens the panel — one place, not two that could disagree.
      get().openPanel('files', true);
      const key = get().activeKey;
      if (key === null) {
        // No child to ask, and `fileView` lives on a session bucket — so there is
        // nowhere to record why. The panel draws its own "nothing to show" state
        // in focus mode when the view is missing, which is the honest answer: the
        // window has no workspace, so this path cannot be resolved.
        return;
      }
      const workspace = get().sessions[key]?.session?.workspace ?? get().sessions[key]?.workspace ?? '';
      // `image: null` is "a picture, being read" — distinct from the `undefined`
      // that means "this is not a picture at all", which is what keeps the panel
      // from drawing an empty picture frame for a text file.
      patch(key, { fileView: { path, answer: null, problem: null, image: null } });

      // A remote session's picture lives on the far host, so the local door
      // (`inlineImage`, whose boundary is a local `canonicalize`) cannot reach
      // it: the same split the deliverable card makes for its "open" button.
      // The remote door is keyed by the child, never by a destination the UI
      // assembled, for the same reason. A session whose saved entry or host
      // was deleted since it started has no dial to give — the local door's
      // refusal ("not there") is the honest answer for that one.
      const remote = remoteConnectionOf(get(), key);
      const read = remote !== null ? inlineImageRemote(key, path) : inlineImage(workspace, path);

      // The command answers with a refusal written for a person when the file is
      // gone, outside the workspace, or not an image it can draw — so the failure
      // is shown where the picture would have been, not only in the transcript.
      void read.then(
        (image) => {
          // Re-check: the person may have closed the panel, or opened another
          // file, while the bytes were being read. Writing the answer into a view
          // that has moved on would draw one file's picture under another's name.
          const current = get().sessions[key]?.fileView;
          if (!current || current.path !== path) return;
          patch(key, { fileView: { ...current, image: image.url } });
        },
        (error: unknown) => {
          const current = get().sessions[key]?.fileView;
          if (!current || current.path !== path) return;
          patch(key, {
            fileView: {
              ...current,
              problem: error instanceof Error && error.message !== '' ? error.message : null,
            },
          });
        },
      );
    },

    /* ==========================================================
       The workspace: memory
       ========================================================== */

    requestMemory() {
      const key = get().activeKey;
      if (key === null) return;
      // No "loading" flag to raise: the panel draws `memory === null` as its loading
      // state already, and a second boolean saying the same thing is a second thing to
      // get out of step.
      sendTo(key, { v: 1, t: 'memory_list' });
    },

    memoryAction(action, args) {
      const key = get().activeKey;
      if (key === null) return;
      // The previous refusal is cleared here rather than on the answer: a new decision
      // supersedes it the moment it is asked for, and leaving it up would show a stale
      // reason over a panel whose state may now be fine.
      patch(key, { memoryProblem: null });
      // The verb and its arguments travel as the runtime's own vocabulary. Which
      // argument a verb needs is the **runtime's** judgement — it is the side that knows
      // what publishing takes, and a second check here would be a second answer that
      // eventually disagrees with it.
      sendTo(key, { v: 1, t: 'memory_action', action, ...(args ?? {}) });
    },

    requestCodeIntel() {
      const key = get().activeKey;
      if (key === null) return;
      // No loading flag, for the same reason `requestMemory` has none: the panel draws
      // `codeintel === null` as its loading state, and a second boolean saying the same
      // thing is a second thing to get out of step.
      sendTo(key, { v: 1, t: 'codeintel_action', action: 'status' });
    },

    codeIntelAction(action, args) {
      const key = get().activeKey;
      if (key === null) return;
      // The previous refusal is cleared here rather than on the answer: a new press
      // supersedes it, and leaving it up would show a stale reason over a panel whose
      // state may already be fine.
      patch(key, { codeintelProblem: null });
      sendTo(key, { v: 1, t: 'codeintel_action', action, ...(args ?? {}) });
    },

    requestUsage() {
      const key = get().activeKey;
      if (key === null) return;
      // No loading flag, for the reason `requestCodeIntel` has none: the panel draws
      // `usage === null` as its loading state. A re-open while a snapshot is already
      // held shows that snapshot until the fresh answer replaces it — a stale "as
      // of" line beats a blank panel that knows the answer.
      sendTo(key, { v: 1, t: 'usage_stats' });
    },

    /* ==========================================================
       The workspace: terminals
       ========================================================== */
  };
}
