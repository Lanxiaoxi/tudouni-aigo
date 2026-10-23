/**
 * sessions slice.
 *
 * Moved verbatim out of store.ts; the wrapper is all that changed — the
 * shared helpers arrive as `ctx` instead of being closed over.
 */
import type { StoreContext } from '../storeContext';
import type { AppStore } from '../storeShape';
import { nextId } from '@/state/entries';
import { buildLearningMessage, learningSessionRefs } from '@/learn/template';
import { buildRefineMessage } from '@/learn/refineTemplate';
import { canRunTask, refineAvailability, refineRunScope, type RefineScreen, type Task, type TaskRunLink } from '@/task/tasks';
import { registerRuntime, sendTo, type Runtime, unregisterRuntime } from '@/runtime/bus';
import { attachRuntime, createTauriRuntime, readRuntimeStderr, shutdownRuntime, type BridgeOptions } from '@/runtime/tauri';
import { TASK_RUNS_MAX, type LaunchArgs } from '../types';
import { createSessionBucket } from '../sessionBucket';
import { persistPrefs } from '../prefs';
import { headForActive, releaseModalsOf } from '../modalQueue';
import { forgetPolling } from '../polling';
import { selectSavedSessionsOf, selectSessionHome } from '../selectors/session';
import { activeRuntime, activeWorkspaceOf, resolveAttachWorkspace } from '../appView';
import { FIND_IDLE } from '../find';
import { nextStartingKey } from '../startingSeq';
import { describeFailure, releaseImages } from '../runtimeLanding';

/** How long a task's first prompt waits for the handshake. Matches the
 *  `init`-then-`session_load` ordering rule: the prompt may only be written
 *  once the empty `session_load` of a fresh session has been applied, and a
 *  child that has not handshaken within half a minute is not about to. */
const HANDSHAKE_WAIT_MS = 30_000;

export function sessionsSlice(ctx: StoreContext): Pick<AppStore, 'attachSession' | 'focusSession' | 'detachSession' | 'openSession' | 'startLearning' | 'refineTask' | 'upsertTask' | 'deleteTask' | 'clearTaskRuns' | 'runTask' | 'noteTaskRunInit' | 'noteTaskRunOutcome'> {
  const { set, get, patch, patchWith, abandonIfUntouched } = ctx;

  /**
   * Wait for one session's handshake, and say **which** of the three outcomes
   * happened rather than folding them together.
   *
   * `gone` is the ordinary failure (the bucket was replaced by a problem row or
   * closed while waiting) and the failure is already on screen. `timeout` is
   * not: the child is still there and still booting, so nothing has been said
   * about the prompt that was never sent — the caller has to say it.
   */
  async function waitForReady(key: string): Promise<'ready' | 'gone' | 'timeout'> {
    const deadline = Date.now() + HANDSHAKE_WAIT_MS;
    for (;;) {
      const current = get().sessions[key];
      if (current === undefined) return 'gone';
      if (current.ready) return 'ready';
      if (Date.now() >= deadline) return 'timeout';
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Say that a task's first prompt never left this window.
   *
   * A note rather than a silent return, because there is no other surface that
   * could carry it: the session is still booting (so there is no `problem`
   * row), and the composer's draft was never written (so the input box shows
   * nothing either). `task` is the template's own title when the caller has
   * one — "this prompt" is the honest sentence for a learning run, which has
   * no task behind it.
   */
  function sayHandshakeTimedOut(key: string, task: string | null): void {
    patchWith(key, (bucket) => ({
      entries: [
        ...bucket.entries,
        {
          kind: 'note',
          id: nextId('note'),
          tone: 'warn',
          code: 'handshake_timeout',
          text: '',
          message: { code: 'handshakeTimeout', seconds: HANDSHAKE_WAIT_MS / 1000, task },
        },
      ],
    }));
  }

  return {
    async attachSession(options = {}) {
      const s = get();
      // Where the child goes. The precedence — caller, then the active session's
      // own answer, then the remembered one — is `resolveAttachWorkspace`, and it
      // is pure so that it can be asserted without a bridge.
      const workspace = resolveAttachWorkspace(
        options.workspace,
        activeRuntime(s)?.workspace,
        s.lastWorkspace,
      );

      // **Nothing to go on means nothing is started.** Not a fallback to
      // something plausible: the only thing left is the bridge's `None`, whose
      // documented meaning is "the directory the application was started in" —
      // for a packaged application, its own install folder. That is how a launch
      // with no workspace open came up in a directory nobody chose, with the
      // session file nowhere in it. `ResolveSession` then reads an id with no
      // file as *a new session with that name*, so nothing failed loudly either;
      // the screen simply moved somewhere else. A refusal is visible and this
      // was not, which is the whole difference.
      //
      // The caller is told by the empty return, so nothing is left looking like
      // it worked. But a caller is not a person — `/new` and the rail's "new
      // session" button both land here when no workspace is remembered, and a
      // button that silently does nothing is exactly the failure this change is
      // meant to remove. So the reason is said on the first screen, which is
      // where the workspace list is.
      if (workspace === '') {
        set({ startupNotice: { code: 'no-workspace' } });
        return null;
      }

      // **A caller that does not name a value inherits the remembered one.**
      // Every open path — the rail's new session, a new workspace, a saved
      // session from the list, the first launch — lands here without saying
      // anything, so they all follow the person's last choice in the settings
      // panel instead of silently starting without the flag. An explicit
      // `ericai` still outranks the default: `applyLaunch` restarts the session
      // on screen with exactly what was applied, and `retrySession` replays the
      // failed launch verbatim.
      const ericai = options.ericai ?? get().ericaiDefault;
      const maxSteps = options.maxSteps ?? get().maxStepsDefault;
      const launch: LaunchArgs = { ericai, maxSteps };

      // **The default is passed on, not only recorded.** Computing it above and
      // then handing the caller's `options` straight through made the two
      // disagree in exactly the case the default exists for — opening a saved
      // session from the list, which names no workspace. The bridge then fell
      // back to the *process's* working directory, which for a packaged
      // application is its own install directory, and started the child there.
      // Nothing failed loudly: the session file is not in that directory, and
      // `ResolveSession` reads an id with no file as *a new session with that
      // name* (`internal/runtime/composition.go`). So the screen moved to a
      // different, empty conversation, in a workspace nobody asked for, while
      // the row that was clicked stayed where it was. Written down but never
      // spawned in, the default was decoration.
      //
      // **The two start-up arguments had the same defect, and it was worse,
      // because it was invisible.** They were resolved into `launch` — the record
      // the settings panel draws — and then dropped, because the payload was
      // spread from the caller's `options` and every open path but `applyLaunch`
      // names neither. So a session started from the rail, from the sidebar, or by
      // the launch itself ran **without `--ericai`** while the panel reported it as
      // in force.
      //
      // What that costs is not a subtle difference in behaviour: `--ericai` is what
      // makes the runtime refresh the token at all (`Options.EricAI` gates every
      // path in `internal/runtime/auth_session.go`). Without it the session runs
      // until the token it was opened with expires and then answers 401 to every
      // single message, with no recovery, for the life of the process — while the
      // panel still says the token is managed. `--max-steps` is the same shape with
      // a smaller blast radius: the runtime reads it while it is being assembled,
      // so a value that never reaches the command line is not a limit anybody is
      // under.
      //
      // The payload is therefore built from the **resolved** values rather than
      // from `options`: what is recorded and what is started have to be the same
      // two facts, or the record is a claim about a command line that was never
      // run.
      const attach: Partial<BridgeOptions> = {
        ...options,
        workspace,
        ericai,
        // Only when there is one: `BridgeOptions.maxSteps` is a number and `null`
        // is how "nothing remembered" is spelled here, so the absent key is what
        // the bridge's own `?? null` turns into "no flag".
        ...(maxSteps === null ? {} : { maxSteps }),
      };

      // **The placeholder is installed before the child exists.** The bridge's
      // spawn is synchronous work that can take a while (it sweeps the
      // workspace's staging directories), and until it returns there is no
      // bucket to draw: the screen kept showing the *previous* conversation,
      // perfectly healthy, so a slow start read as a frozen window rather
      // than as a start-up. The placeholder — a real bucket with a
      // non-numeric key the bridge will never mint — is what makes the
      // conversation column show its booting state from the click itself.
      //
      // The key is `starting-<n>` rather than a fixed name because a bucket
      // is only replaced by an explicit rekey, and two placeholders at once
      // (a start-up in flight while the person presses the button in another
      // workspace) must not overwrite each other.
      const placeholderKey = nextStartingKey();
      const placeholder = createSessionBucket(placeholderKey, workspace, launch);
      // A no-op handle: the placeholder cannot receive protocol data (the
      // child's key is not minted yet), but registering it is what keeps a
      // send aimed at it from throwing and gives the rekey something to retire.
      const placeholderRuntime: Runtime = {
        key: placeholderKey,
        send: () => undefined,
        subscribe: () => () => undefined,
        dispose: () => undefined,
      };
      registerRuntime(placeholderRuntime);
      set((state) => ({
        sessions: { ...state.sessions, [placeholderKey]: placeholder },
        order: [...state.order, placeholderKey],
        activeKey: placeholderKey,
        panel: null,
        // A new conversation is about to be shown, so a window-level refusal
        // or a "nothing opened" note is no longer what the screen is about.
        startupProblem: null,
        startupNotice: null,
      }));

      let key: string | null;
      try {
        key = await attachRuntime(attach);
      } catch (err) {
        // A refusal here belongs to the session that was being opened rather
        // than to the window: with one open already, taking over the screen
        // would hide a perfectly healthy conversation behind a message about a
        // process that does not exist.
        //
        // The sentence lands on the placeholder — it is the row the person
        // just asked for, and it is already the one on screen — rather than in
        // a second, duplicate bucket. `problem` moving from null to set is
        // what turns the column from "starting…" to the failure panel, so a
        // refusal is now visible for the whole time it took to arrive.
        patch(placeholderKey, { problem: describeFailure(err) });
        // **No abandonment here, deliberately.** The screen moved, but to a
        // session that is not a conversation — so the one it displaced is
        // whatever the person was working in, and closing that because an
        // unrelated start-up was refused would cost them the only thing that
        // still works. It stays on screen behind the refusal.
        return null;
      }

      if (key === null) {
        // No bridge at all (a plain browser). Nothing to record: there is no
        // process, so there is no session to show a problem for. The
        // placeholder goes with it — kept, it would say "starting" forever
        // over a start that will never finish.
        set((state) => {
          const { [placeholderKey]: _gone, ...rest } = state.sessions;
          return {
            sessions: rest,
            order: state.order.filter((entry) => entry !== placeholderKey),
            activeKey: state.activeKey === placeholderKey ? s.activeKey : state.activeKey,
          };
        });
        return null;
      }

      // The handle is built before the first line can be routed to it, and it
      // holds anything that arrives before a subscriber exists.
      const runtime = createTauriRuntime(key, (line) => {
        get().pushStderr(key, line);
      });
      // The placeholder's no-op handle is retired before the real one is
      // registered: the registry is keyed, and the placeholder key would
      // shadow nothing — but leaving it would keep a handle to a bucket that
      // no longer exists, and `detachSession` on the real key would never find
      // it.
      unregisterRuntime(placeholderKey);
      registerRuntime(runtime);

      // **The bucket is re-keyed, not replaced, and it is installed before
      // anything is subscribed — that order is load-bearing.** A line the
      // child sent before the handle existed is held — by the host's
      // `pendingLines`, and then by the handle's own queue — and `subscribe`
      // is what flushes it, straight into `applyRuntimeMessage`. That function
      // drops a message for a key with no bucket, and it has to: from a key
      // alone, "this session is gone" and "this session has not been installed
      // yet" are the same statement.
      //
      // So subscribing first and installing the bucket afterwards threw away
      // exactly the lines the queue exists to protect: the opening
      // `init` -> `session_load` -> `ui(state)` triple. The child is perfectly
      // healthy and every *later* reply lands normally (`session_list` is sent
      // below, after the bucket exists, so `sessions` populates the rail) —
      // which is what makes this so quiet. With `init` gone there is no
      // `session_id`, so the rail cannot mark the row current; with `ui(state)`
      // gone the right rail has no snapshot; and because `ready` never becomes
      // true the screen shows "Starting the runtime…" forever over a process
      // that is running and answering. Nothing reports a failure, because
      // nothing failed.
      //
      // Re-keying rather than creating a second bucket is what keeps the
      // placeholder's draft and any Send the person made during the start-up
      // alive: the bucket is the same object, and only its key — the bridge's
      // — changes. A fresh bucket would have been a conversation that lost
      // whatever was typed into the one it replaced, one keystroke at a time.

      // The session this one displaced **on screen**: the one that was
      // focused when the open was asked for, `s.activeKey` read at the top.
      // Not `get().activeKey` here — the placeholder already took that seat,
      // and the person may have moved on again while the child was starting,
      // so neither answers "what did this open push off the screen". When the
      // person switched away mid-start-up, `s.activeKey` names the session the
      // placeholder displaced, which is the one that gets abandoned if it is
      // untouched — the same rule `focusSession` applies.
      const leaving = s.activeKey;
      set((state) => {
        const current = state.sessions[placeholderKey];
        if (!current) return {};
        const { [placeholderKey]: _old, ...rest } = state.sessions;
        return {
          sessions: { ...rest, [key as string]: current },
          order: state.order.flatMap((entry) => (entry === placeholderKey ? [key as string] : [entry])),
          // The screen stays where the person put it: focused back onto this
          // bucket only when it is still the one being looked at.
          activeKey: state.activeKey === placeholderKey ? key : state.activeKey,
          // A new conversation is (or was) on screen, so the rendered slot is
          // re-aimed at it — the same act as in `focusSession`, and it matters
          // here because a request this brand-new session sends while it is
          // booting must draw over the screen it belongs to rather than queue
          // behind one held from the session it displaced.
          modal: headForActive(state.pendingModals, state.activeKey === placeholderKey ? key : state.activeKey),
          panel: null,
        };
      });

      // Only now, with somewhere for them to land.
      runtime.subscribe((msg) => {
        get().applyRuntimeMessage(key, msg);
      });

      // Anything the child printed before it gave up is already in the bridge's
      // ring; read it once so a start-up failure has something to show even if
      // it died faster than the event subscription.
      void readRuntimeStderr(key).then((early) => {
        for (const line of early) get().pushStderr(key, line);
      });

      // A child is running in this directory — the bridge does not hand back a
      // key otherwise — and it is now the one on screen. That is the plainest
      // available statement that this is where work is happening, so it is what
      // the next launch should open. `init.workspace` refines it a moment later
      // with the runtime's own canonical answer.
      get().rememberWorkspace(workspace);

      // The session list is what the left rail draws saved conversations from,
      // and a fresh child is the only thing that can answer for this workspace.
      sendTo(key, { v: 1, t: 'session_list', filter: get().sessionFilter });

      // The other half of a switch: the session this one displaced is now off
      // screen, and if it never became a conversation it is closed rather than
      // left as a row nothing can delete. See `abandonIfUntouched`.
      abandonIfUntouched(leaving);

      return key;
    },

    focusSession(key) {
      const s = get();
      if (!s.sessions[key]) return;
      if (s.activeKey === key) return;
      const leaving = s.activeKey;
      patchWith(key, () => ({ unseen: false }));
      // **Nothing is sent.** Switching which conversation is drawn is a local
      // act; the child keeps running and keeps its transcript. This is the
      // difference between this and `session_switch`, which made the runtime
      // rebuild itself and abandon whatever it was waiting on.
      //
      // Second act of the hold rule (`selectModalVisible`): switching is what
      // surfaces a request this session was holding — the drawn slot is
      // recomputed against the new focus, so its first prompt is on screen by
      // the time the row lands. The panel clears here for the same reason.
      set((state) => ({
        activeKey: key,
        panel: null,
        modal: state.pendingModals.find((entry) => entry.key === key) ?? null,
        // The transcript under the bar is about to be a different one. See
        // `FIND_IDLE`.
        ...FIND_IDLE,
      }));
      // The session being looked at is the one this window is working in, so its
      // workspace is what the next launch should open. Without this, "last used"
      // would mean "last opened", and focusing a session in another workspace is
      // precisely how somebody changes which one that is.
      //
      // **A remote session is skipped, and recorded separately.** Its
      // `workspace` is a directory on the remote host, and `lastWorkspace` is
      // opened **on this machine** by `openFirstSession` — remembering it there
      // would make the next start-up offer a directory that is not here. The
      // entry's id goes into `lastRemoteWorkspaceId` instead, which is the only
      // thing that says "that one, over there".
      const focused = s.sessions[key];
      const workspace = focused?.workspace ?? '';
      if (workspace !== '' && focused?.remoteWorkspaceId === null) {
        get().rememberWorkspace(workspace);
      }
      if (focused?.remoteWorkspaceId != null) {
        get().rememberRemoteWorkspace(focused.remoteWorkspaceId);
      }
      // Last, with the new focus already in place: what is being looked at now
      // is the one that stays, whatever it is.
      abandonIfUntouched(leaving);
    },

    async detachSession(key) {
      const s = get();
      if (!s.sessions[key]) return;

      // The pictures of the session being closed are nobody's any more, and
      // their blob URLs would otherwise live until the window did.
      releaseImages(s.sessions[key].pastedImages);
      unregisterRuntime(key);
      forgetPolling(key);

      set((state) => {
        const { [key]: _gone, ...rest } = state.sessions;
        const order = state.order.filter((entry) => entry !== key);
        // Focus moves to a neighbour rather than nowhere: with several sessions
        // open, closing one should not blank the screen.
        const activeKey =
          state.activeKey === key ? (order[order.length - 1] ?? null) : state.activeKey;
        return {
          sessions: rest,
          order,
          activeKey,
          // A queued request from the session that is going away can never be
          // answered — its child is the one that was waiting — so it leaves the
          // queue, and the rendered slot is re-aimed at whatever the focus
          // moved to. The re-aim gets the **new** focus: inside this one write
          // the state's `activeKey` still names the session being closed, and
          // aiming at it would leave the slot empty by construction.
          ...releaseModalsOf(state, key, activeKey),
        };
      });

      try {
        await shutdownRuntime(key);
      } catch {
        /* The child is already gone; the exit event is what says so. */
      }
    },

    async openSession(sessionId, workspace) {
      const s = get();
      if (sessionId !== null) {
        // A child that already has this session open is focused rather than
        // duplicated. Two processes on one session id would write the same
        // session file, and the store's watermark (`SessionStore.Save`) is
        // per-process — so this is a data-safety rule, not an optimisation.
        const existing = s.order.find(
          (key) => s.sessions[key]?.sessionId === sessionId,
        );
        if (existing) {
          get().focusSession(existing);
          return;
        }
      }
      // **A saved id names its own place, and that place is asked first.**
      //
      // The rule below (a remote *screen* owns both open paths) only holds while
      // the screen is where the conversation lives. Two entry points routinely
      // click an id belonging to a place that is not on screen, and both of them
      // used to end up at the wrong machine:
      //
      //   - a **notification's** reopen (`useNotifications`) carries the
      //     workspace the toast was raised from, which for a remote session is
      //     the *remote* path. Clicked with a local conversation on screen, the
      //     screen test said "not here" and the id went to the local spawn with
      //     a remote path — "the workspace … is not a directory", or (where the
      //     path exists here) a local child resuming a remote id;
      //   - a **task's run history** (`TaskPanel`) calls `openSession(id)` with
      //     no workspace at all, so `namesTheScreen` was trivially true and the
      //     *screen's* identity was used for a run that had happened elsewhere.
      //     The child then got `--session <id>` for a file it does not have, and
      //     the runtime reads an id with no file as *a new session with that
      //     name*: an empty conversation, silently.
      //
      // The saved lists are the authority on which place an id belongs to, and
      // they are the only thing here that knows about a machine the person is not
      // currently looking at. `null` (no list holds it) falls through to the
      // screen rule, which is the right answer whenever the screen *is* the place.
      const home = sessionId === null ? null : selectSessionHome(s, sessionId);
      if (home !== null && home.remoteWorkspaceId !== null) {
        // The state the entry still exists. A saved list can outlive its remote
        // entry (the row was forgotten while a child was running), and there is
        // no dial to build from nothing — falling through would send a remote
        // path to the local spawn, so it is refused here instead, with the same
        // sentence the other "no entry" paths use.
        const entry = s.remoteWorkspaces.find((item) => item.id === home.remoteWorkspaceId);
        if (entry === undefined) {
          set({ startupNotice: { code: 'no-workspace' } });
          return;
        }
        await get().connectRemoteWorkspace(home.remoteWorkspaceId, {
          forceNew: true,
          ...(sessionId === null ? {} : { sessionId }),
        });
        return;
      }
      // **A remote screen owns both open paths: a *new* conversation and a
      // *saved* session from the rail's list.** The session on screen carries
      // `remoteWorkspaceId`, and its `workspace` is a directory on the
      // *remote* host — `resolveAttachWorkspace` would hand that path to the
      // local spawn, which checks it against this machine's filesystem and
      // refuses with "the workspace … is not a directory". "Here" on a remote
      // screen means there: a second child in the same remote workspace,
      // which is `connectRemoteWorkspace` with `forceNew` (the guard that
      // focuses an existing session is precisely what would swallow the
      // request).
      //
      // When the request names a *saved* session, its id rides along as
      // `sessionId`: the remote child is started with `--session <id>` and
      // resumes the conversation the person clicked, the same id the local
      // path passes on. Without it the remote child would start a new
      // conversation and the clicked row would stay closed.
      // An explicit `workspace` argument still wins when it names a *local*
      // directory the caller chose (`/resume` in another directory): that is
      // a statement about this machine. The one name that is not a new
      // statement is the screen's own — a notification's reopen carries the
      // session's own workspace, which on a remote screen **is** the remote
      // path — and passing that through the local spawn is exactly the
      // refusal this rule exists to avoid.
      const active = s.activeKey === null ? null : (s.sessions[s.activeKey] ?? null);
      // `?? null` folds the "no active session" case (`undefined`) and the
      // "local session" case (`remoteWorkspaceId: null`) into one `null`, so
      // a non-null result is exactly "the session on screen is remote".
      const remoteId = active?.remoteWorkspaceId ?? null;
      const namesTheScreen =
        workspace === undefined ||
        (workspace ?? '') === (active?.session?.workspace ?? active?.workspace ?? '');
      if (remoteId !== null && namesTheScreen) {
        await get().connectRemoteWorkspace(remoteId, {
          forceNew: true,
          ...(sessionId === null ? {} : { sessionId }),
        });
        return;
      }
      await get().attachSession({
        ...(workspace === undefined ? {} : { workspace }),
        ...(sessionId === null ? {} : { sessionId }),
      });
    },

    async startLearning(scope, deliverables, objectives) {
      // The panel already closed itself before this runs: the form's submit
      // button is the only door into here, and a form left open over the
      // screen that is about to change is a form that hides the change.
      const s = get();
      const workspace = activeWorkspaceOf(s);
      if (workspace === '') return;
      // `Of`: learning from this workspace must be told about **its** sessions,
      // and a path alone does not say which machine's — two hosts can each have
      // a `/srv/app`.
      const saved = selectSavedSessionsOf(s, s.activeKey);
      const refs = learningSessionRefs(saved.items, scope);
      const text = buildLearningMessage({
        workspace,
        scope,
        sessions: refs,
        deliverables,
        objectives,
      });

      // A new child, in the workspace on screen — the same act the rail's
      // "new session" takes, so the learning run and its transcript are what
      // the person sees next. `attachSession` moves the screen there for a
      // **local** workspace, but a screen over a remote bucket carries a
      // workspace that is a directory on the *remote* host: handing it to the
      // local spawn fails the local directory check with "the workspace … is
      // not a directory". `openSession` makes the same split — a remote
      // screen goes through `connectRemoteWorkspace` with `forceNew` (the
      // guard that focuses an existing session is precisely what would
      // swallow the request).
      // `?? null` folds "no active session" and "local session"
      // (`remoteWorkspaceId: null`) into one `null`, so a non-null result is
      // exactly "the screen is over a remote workspace" — the same fold
      // `openSession` uses to make its split.
      const remoteId = activeRuntime(s)?.remoteWorkspaceId ?? null;
      let key: string | null;
      if (remoteId !== null) {
        await get().connectRemoteWorkspace(remoteId, { forceNew: true });
        key = get().activeKey;
        if (key === null) return;
      } else {
        key = await get().attachSession({});
        if (key === null) return;
      }
      patchWith(key, () => ({ learning: true }));

      // The task prompt goes out as the session's first `user_message`.
      //
      // The handshake's order is `init` then `session_load` then the first
      // `ui(state)`, all flushed in order through the same queue the listener
      // reads, so by the time `ready` is set the empty `session_load` of a
      // fresh session has already been applied and cannot wipe what this
      // writes into `entries`. Waiting for `ready` is therefore the whole of
      // the timing problem, and the wait is bounded — with the timeout stated
      // rather than swallowed: a child that died has a problem row of its own,
      // but one that is merely silent has no surface at all.
      const wait = await waitForReady(key);
      if (wait === 'gone') return;
      if (wait === 'timeout') {
        sayHandshakeTimedOut(key, null);
        return;
      }

      const active = get().activeKey;
      if (active !== key) {
        // The person moved on before the child was ready. The message still
        // goes to the session it was configured for — that is the one that
        // is the learning run — and its transcript carries it.
        patchWith(key, (bucket) => ({
          entries: [...bucket.entries, { kind: 'user', id: nextId('user'), text, atMs: Date.now() }],
          draft: '',
          history: [...bucket.history, text].slice(-100),
          historyCursor: null,
          hasSpoken: true,
        }));
        sendTo(key, { v: 1, t: 'user_message', text });
        return;
      }

      // On screen: go through the composer's own submit so the transcript,
      // the history and the send all take the single existing path.
      get().setDraft(text);
      get().submitDraft();
    },

    async refineTask(taskId, scope, failedOnly, objectives) {
      const s = get();
      const task = s.tasks.find((row) => row.id === taskId);
      if (!task) return null;
      const workspace = activeWorkspaceOf(s);
      if (workspace === '') return null;
      // The store's half of the panel's availability gate. The panel is the one
      // that says *why*; this re-checks only the facts it owns — the task still
      // exists, and the screen is still the place the task names.
      //
      // **The place is a pair: directory *and* machine.** A remote refine is
      // perfectly possible — the remote child reads its own
      // `.tudouni/sessions/`, which is exactly where the runs' evidence is. What
      // is impossible is refining a task whose place is not the one on screen,
      // because then the child would study a different machine's transcripts
      // (or, worse, a same-named local directory's).
      const links = s.taskRuns.filter((row) => row.taskId === taskId);
      const screen: RefineScreen = {
        workspace,
        remoteWorkspaceId: activeRuntime(s)?.remoteWorkspaceId ?? null,
      };
      if (!refineAvailability(task, links, screen).ok) return null;

      const text = buildRefineMessage({
        taskName: task.name,
        currentPrompt: task.prompt,
        workspace,
        scope,
        failedOnly,
        runs: refineRunScope(links, scope, failedOnly),
        objectives,
      });

      // **A new child in the workspace on screen — the same split
      // `startLearning` makes.** On a local screen that is
      // `attachSession({})`; on a remote one the workspace is a path on the
      // other host, so handing it to the local spawn would fail the local
      // directory check ("the workspace … is not a directory"). `forceNew`
      // because refine means a *new* conversation, never "focus the one already
      // open" — the guard inside `connectRemoteWorkspace` is precisely what
      // would swallow the request.
      //
      // There is no second upload or SFTP read here: the remote child resolves
      // the same workspace-relative `.tudouni/sessions/<id>.jsonl` paths the
      // prompt lists, on its own filesystem.
      const remoteId = screen.remoteWorkspaceId;
      let key: string | null;
      if (remoteId !== null) {
        await get().connectRemoteWorkspace(remoteId, { forceNew: true });
        key = get().activeKey;
        if (key === null) return null;
      } else {
        key = await get().attachSession({});
        if (key === null) return null;
      }
      // The front end's half of the delivery. The candidate is applied by
      // `upsertTask` on the question's answer, and the answer is read back
      // out of *this* session's transcript against *this* task — both halves
      // of that rule live on the bucket here.
      patchWith(key, () => ({ refineTaskId: taskId }));

      // The prompt goes out as the session's first `user_message`, waiting on
      // the handshake for exactly the reason `startLearning` waits: the
      // `session_load` right behind `init` would wipe what is written before
      // it lands. `gone` returns null because the failure is already on
      // screen; `timeout` returns the key (the session still exists) after
      // saying that the prompt did not go out.
      const wait = await waitForReady(key);
      if (wait === 'gone') return null;
      if (wait === 'timeout') {
        sayHandshakeTimedOut(key, task.name);
        return key;
      }
      const active = get().activeKey;
      if (active !== key) {
        patchWith(key, (bucket) => ({
          entries: [...bucket.entries, { kind: 'user', id: nextId('user'), text, atMs: Date.now() }],
          draft: '',
          history: [...bucket.history, text].slice(-100),
          historyCursor: null,
          hasSpoken: true,
        }));
        sendTo(key, { v: 1, t: 'user_message', text });
        return key;
      }
      get().setDraft(text);
      get().submitDraft();
      return key;
    },

    /* ==========================================================
       Task templates
       ========================================================== */
    upsertTask(task) {
      set((s) => {
        const at = s.tasks.findIndex((row) => row.id === task.id);
        const stamped: Task = { ...task, updatedAtMs: Date.now() };
        const tasks =
          at < 0 ? [...s.tasks, stamped] : s.tasks.map((row) => (row.id === task.id ? stamped : row));
        return { tasks };
      });
      persistPrefs(get());
    },

    deleteTask(taskId) {
      // The links stay: the design is explicit that removing a template must
      // not erase the trace of the runs it produced — the link carries its own
      // copies of the name and model precisely so it stays readable after this.
      set((s) => ({ tasks: s.tasks.filter((row) => row.id !== taskId) }));
      persistPrefs(get());
    },

    clearTaskRuns() {
      set({ taskRuns: [] });
      persistPrefs(get());
    },

    async runTask(taskId) {
      const task = get().tasks.find((row) => row.id === taskId);
      if (!task || !canRunTask(task)) return null;

      // Where the run goes. `active` means the workspace on screen — whatever
      // it is, local or remote, `openSession(null)` already answers it: it
      // dials another child there on a remote screen and spawns here on a
      // local one. An explicit local path is a plain attach; an explicit
      // remote ref is the forceNew connect when the workspace already has a
      // live child (a Run means a **new** session, never "focus the old one")
      // and the rail's own entry otherwise, which owns the config-sync
      // decision and the automatic install.
      const s = get();
      let workspaceLabel: string;
      let opened: Promise<void>;
      if (task.workspace.kind === 'active') {
        const active = activeRuntime(s);
        workspaceLabel = active?.session?.workspace ?? active?.workspace ?? '';
        if (workspaceLabel === '') return null;
        opened = get().openSession(null);
      } else if (task.workspace.kind === 'local') {
        workspaceLabel = task.workspace.path;
        opened = get().openSession(null, task.workspace.path);
      } else {
        const remoteId = task.workspace.id;
        const entry = s.remoteWorkspaces.find((item) => item.id === remoteId);
        const host = entry !== undefined ? s.sshHosts.find((item) => item.id === entry.hostId) : undefined;
        if (entry === undefined || host === undefined) return null;
        workspaceLabel = entry.remotePath;
        const live = s.order.find((key) => s.sessions[key]?.remoteWorkspaceId === remoteId);
        opened =
          live !== undefined
            ? get().connectRemoteWorkspace(remoteId, { forceNew: true })
            : get().enterRemoteWorkspace(remoteId);
      }

      // The keys that existed before the open. The run's link may only land on
      // a bucket created **by this open**: the open paths can also merely
      // focus an existing session (and a config-sync prompt can park the open
      // entirely, leaving the screen where it was), and recording a run against
      // a conversation that already existed would be the "fake success" the
      // design refuses.
      const previousKeys = new Set(s.order);

      let openError: unknown = null;
      try {
        await opened;
      } catch (err) {
        // A refused open (the config check could not connect, for one) is the
        // panel's to show; nothing was started, so nothing is recorded.
        openError = err;
      }
      if (openError !== null) return null;

      const after = get();
      const key = after.activeKey;
      const bucket = key !== null ? after.sessions[key] : null;
      if (key === null || bucket === null || previousKeys.has(key) || bucket.problem !== null) {
        // Either nothing opened, an existing session was focused, or the open
        // failed with its own row (`failed-…` or a problem placeholder —
        // `attachSession` catches its bridge's refusal and shows it there, so
        // no throw reaches the `await` above) — in every one of those no
        // session was created, so no link, no prompt, and no key is returned:
        // the contract is "the key a run landed in", and nothing landed.
        return null;
      }

      const link: TaskRunLink = {
        taskId: task.id,
        sessionId: '',
        sessionKey: key,
        startedAtMs: Date.now(),
        taskName: task.name,
        model: task.model,
        workspaceLabel,
        // The same frozen fact as the name and the model: what *was* sent into
        // the session, so a run of a template whose switch has since changed
        // still shows how it was started.
        autopilot: task.autopilot === true,
        // The prompt itself, frozen unconditionally: prompts are short, and a
        // diff check would be an optimisation nobody could see. It is what
        // makes "which runs ran under which prompt" answerable — the whole
        // ground of the refine feature.
        prompt: task.prompt,
        // **Which machine this run's evidence is on**, read off the bucket that
        // actually opened rather than off the task's ref. The ref can say
        // `active` (meaning "wherever I was"), and what matters later — when
        // refine reads `.tudouni/sessions/<id>.jsonl` — is where the run
        // *happened*. `null` is a local child, which is also what every link
        // persisted before this field existed means.
        remoteWorkspaceId: bucket.remoteWorkspaceId,
      };
      set((state) => ({
        taskRuns: [...state.taskRuns, link].slice(-TASK_RUNS_MAX),
      }));
      persistPrefs(get());

      // The model, when the template names one: the same `set_model` the model
      // panel sends, once the child can receive it. Not a new protocol field.
      const model = task.model.trim();
      const applyModel = model === '' ? null : () => sendTo(key, { v: 1, t: 'set_model', model });

      // The autopilot switch, when the template wants one: the same
      // `set_autopilot` the status bar sends — but filed *before* the prompt,
      // because the prompt is the run and a run that is already working is
      // one the switch may not reach. A template without the field (saved by
      // an older build) sends nothing and keeps its old behaviour.
      const wantAutopilot = task.autopilot === true;
      const applyAutopilot = wantAutopilot ? () => sendTo(key, { v: 1, t: 'set_autopilot', on: true }) : null;

      // The prompt, as the session's first message — the same two-step
      // (`wait for ready`, then speak) `startLearning` established, for the
      // same reason: `session_load` lands right behind `init` and must not
      // wipe what the run writes into the transcript. The run's link already
      // exists at this point, so a timeout is said in the session it belongs
      // to rather than on the composer.
      void (async () => {
        const wait = await waitForReady(key);
        if (wait === 'gone') return;
        if (wait === 'timeout') {
          sayHandshakeTimedOut(key, task.name);
          return;
        }
        applyAutopilot?.();
        applyModel?.();
        const active = get().activeKey;
        if (active !== key) {
          patchWith(key, (b) => ({
            entries: [...b.entries, { kind: 'user' as const, id: nextId('user'), text: task.prompt, atMs: Date.now() }],
            draft: '',
            history: [...b.history, task.prompt].slice(-100),
            historyCursor: null,
            hasSpoken: true,
          }));
          sendTo(key, { v: 1, t: 'user_message', text: task.prompt });
          return;
        }
        get().setDraft(task.prompt);
        get().submitDraft();
      })();

      return key;
    },

    noteTaskRunInit(key, sessionId) {
      const s = get();
      // Newest first matters here: a task can legitimately have many pending
      // runs at once (the cap is per link, not per task), and the one this
      // handshake names is the one still missing its id.
      const at = [...s.taskRuns].reverse().findIndex((row) => row.sessionKey === key && row.sessionId === '');
      if (at < 0) return;
      const index = s.taskRuns.length - 1 - at;
      set((state) => ({
        taskRuns: state.taskRuns.map((row, i) => (i === index ? { ...row, sessionId } : row)),
      }));
      persistPrefs(get());
    },

    noteTaskRunOutcome(key, outcome, durationMs) {
      // Newest first, the same rule `noteTaskRunInit` uses and for the same
      // reason: one task can have several runs against one child key over a
      // long life of the app (a Retry focuses nothing — it starts a *new*
      // child — but a key is reused by the bridge), and the one this verdict
      // belongs to is the most recent link on that key.
      const s = get();
      const at = [...s.taskRuns].reverse().findIndex((row) => row.sessionKey === key);
      if (at < 0) return;
      const index = s.taskRuns.length - 1 - at;
      const current = s.taskRuns[index];
      const nextDuration = durationMs ?? current.durationMs;
      // Nothing new to say. `durationMs` is `null` for a child that died
      // mid-turn (the runtime never sent a figure), so comparing it against the
      // stored one has to tolerate the absent case rather than treat "no new
      // measurement" as a change and rewrite the record on every verdict.
      if (current.outcome === outcome && nextDuration === current.durationMs) return;
      const stamped: TaskRunLink = { ...current, outcome, ...(nextDuration !== undefined ? { durationMs: nextDuration } : {}) };
      set((state) => ({
        taskRuns: state.taskRuns.map((row, i) => (i === index ? stamped : row)),
      }));
      persistPrefs(get());
    },

    /* ==========================================================
       Outbound
       ========================================================== */
  };
}
