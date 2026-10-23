/**
 * workspaces slice.
 *
 * Moved verbatim out of store.ts; the wrapper is all that changed — the
 * shared helpers arrive as `ctx` instead of being closed over.
 */
import type { StoreContext } from '../storeContext';
import type { AppStore } from '../storeShape';
import { registerRuntime, sendTo } from '@/runtime/bus';
import { samePath } from '@/utils/format';
import { attachRuntimeRemote, checkRemoteConfig, chooseWorkspaceDirectory, createTauriRuntime, getAppVersion, installRemoteRuntime, onInstallProgress, readLocalConfigText, readRuntimeStderr, writeRemoteConfig } from '@/runtime/tauri';
import { decideConfigSync } from '@/state/configSync';
import { type InstallStatus, type LaunchArgs } from '../types';
import { createSessionBucket } from '../sessionBucket';
import { persistPrefs } from '../prefs';
import { headForActive } from '../modalQueue';
import { activeRuntime } from '../appView';
import { FIND_IDLE } from '../find';
import { describeFailure, lookupToolFacts } from '../runtimeLanding';
import { nextFailedKey } from '../startingSeq';

export function workspacesSlice(ctx: StoreContext): Pick<AppStore, 'pickWorkspace' | 'enterWorkspace' | 'addWorkspace' | 'removeWorkspace' | 'addSshHost' | 'updateSshHost' | 'removeSshHost' | 'addRemoteWorkspace' | 'updateRemoteWorkspace' | 'removeRemoteWorkspace' | 'enterRemoteWorkspace' | 'connectRemoteWorkspace' | 'installRemoteWorkspace' | 'checkConfigSync' | 'resolveConfigSync' | 'dismissConfigSync' | 'applyLaunch' | 'toolFacts'> {
  const { set, get, abandonIfUntouched } = ctx;

  /**
   * Put a failed remote open on screen as its own short-lived row.
   *
   * Both failure paths in `connectRemoteWorkspace` — the automatic install
   * ending without a binary, and the dial itself rejecting — need exactly this,
   * and they used to build it twice. The key comes from the counter rather
   * than a timestamp: two opens settling in the same millisecond would
   * otherwise share one key, and the second `set` would replace the first row
   * while `order` kept a second entry pointing at the same bucket.
   *
   * The row has **no runtime handle** (there was never a child), which is why
   * its key must be one `bridgeKey` refuses: `sendTo` is a no-op on it, and a
   * "Try again" goes through `attachSession` rather than a command keyed by
   * it.
   */
  function openFailedRow(
    workspace: string,
    launch: LaunchArgs,
    remoteWorkspaceId: string,
    reason: string,
  ): void {
    const key = nextFailedKey();
    const bucket = createSessionBucket(key, workspace, launch, remoteWorkspaceId);
    bucket.problem = reason;
    bucket.connection = { phase: 'failed', problem: reason };
    set((state) => ({
      sessions: { ...state.sessions, [key]: bucket },
      order: [...state.order, key],
      activeKey: key,
      // The open is over, so the in-flight mark goes too.
      openingRemote: null,
    }));
  }

  return {
    async pickWorkspace() {
      // A different workspace means a different child process: the runtime takes
      // its working directory as the workspace, and the file tools' boundary is
      // exactly that. Opening a session there is a new process, not a move.
      const picked = await chooseWorkspaceDirectory();
      if (picked === null) return;
      // Picking a directory is also a decision to keep it: a place somebody just
      // navigated to is a place they will want again, and asking them to bookmark
      // it separately would be asking twice for one intention.
      get().addWorkspace(picked);
      await get().enterWorkspace(picked);
    },

    async enterWorkspace(path) {
      const s = get();
      // Already there: a live session in that directory is focused rather than
      // duplicated, and — the part that changed — no other session is touched.
      // Opening a conversation in another workspace used to kill the one that
      // was running, which is precisely what the second target scenario needs to
      // stop happening.
      const existing = s.order.find((key) => {
        const bucket = s.sessions[key];
        return bucket && bucket.workspace !== '' && samePath(bucket.workspace, path);
      });
      if (existing) {
        get().focusSession(existing);
        return;
      }
      await get().attachSession({ workspace: path });
    },

    addWorkspace(path) {
      const trimmed = path.trim();
      if (trimmed === '') return;
      const list = get().workspaces;
      if (list.some((entry) => samePath(entry, trimmed))) return;
      set({ workspaces: [...list, trimmed] });
      persistPrefs(get());
    },

    removeWorkspace(path) {
      const list = get().workspaces.filter((entry) => !samePath(entry, path));
      if (list.length === get().workspaces.length) return;
      set({ workspaces: list });
      persistPrefs(get());
    },

    addSshHost(host) {
      const id = `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({ sshHosts: [...state.sshHosts, { ...host, id }] }));
      persistPrefs(get());
      return id;
    },

    updateSshHost(id, patch) {
      const list = get().sshHosts;
      const index = list.findIndex((entry) => entry.id === id);
      if (index === -1) return;
      const updated = [...list];
      updated[index] = { ...updated[index], ...patch, id };
      set({ sshHosts: updated });
      persistPrefs(get());
    },

    removeSshHost(id) {
      // Refused while a saved remote workspace still references this host —
      // see the method's own doc on the interface for why this is a refusal
      // rather than a cascading delete.
      const inUse = get().remoteWorkspaces.some((entry) => entry.hostId === id);
      if (inUse) return false;
      const list = get().sshHosts.filter((entry) => entry.id !== id);
      if (list.length === get().sshHosts.length) return false;
      set({ sshHosts: list });
      persistPrefs(get());
      return true;
    },

    addRemoteWorkspace(entry) {
      // **A workspace already saved is returned, not saved twice.** The same
      // rule `addWorkspace` applies to a local directory, and it matters more
      // here: the wizard can legitimately be walked to the same directory twice
      // (pick the host, browse there, open it; later do it again), and the two
      // rows are indistinguishable in the sidebar — same label, same host, same
      // path — while `enterRemoteWorkspace` can only ever focus one of them. The
      // second row would be permanently un-openable, which reads as a broken
      // button rather than as a duplicate.
      //
      // Identity is the (host, path) pair and not the path alone: two different
      // hosts can each have a `/srv/app`, and those are genuinely two places.
      const existing = get().remoteWorkspaces.find(
        (item) => item.hostId === entry.hostId && item.remotePath === entry.remotePath,
      );
      if (existing) {
        // A path that was blank (no Runtime installed yet) and is now known is
        // worth recording — that is the wizard having learned something since.
        if (existing.remoteBinary.trim() === '' && entry.remoteBinary.trim() !== '') {
          get().updateRemoteWorkspace(existing.id, { remoteBinary: entry.remoteBinary });
        }
        return existing.id;
      }

      const id = `rw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      set((state) => ({ remoteWorkspaces: [...state.remoteWorkspaces, { ...entry, id }] }));
      persistPrefs(get());
      return id;
    },

    updateRemoteWorkspace(id, patch) {
      const list = get().remoteWorkspaces;
      const index = list.findIndex((entry) => entry.id === id);
      if (index === -1) return;
      const updated = [...list];
      updated[index] = { ...updated[index], ...patch, id };
      set({ remoteWorkspaces: updated });
      persistPrefs(get());
    },

    removeRemoteWorkspace(id) {
      const list = get().remoteWorkspaces.filter((entry) => entry.id !== id);
      if (list.length === get().remoteWorkspaces.length) return;
      set({ remoteWorkspaces: list });
      persistPrefs(get());
    },

    async enterRemoteWorkspace(remoteWorkspaceId) {
      const s = get();
      const entry = s.remoteWorkspaces.find((item) => item.id === remoteWorkspaceId);
      if (!entry) return;

      // Already there: a live session against this remote workspace is
      // focused rather than duplicated — the same rule `enterWorkspace`
      // applies for a local directory, kept here so switching between a
      // local and a remote row in the sidebar behaves identically.
      const existing = s.order.find((key) => s.sessions[key]?.remoteWorkspaceId === remoteWorkspaceId);
      if (existing) {
        get().focusSession(existing);
        return;
      }

      const host = s.sshHosts.find((item) => item.id === entry.hostId);
      if (!host) {
        set({
          startupNotice: { code: 'no-workspace' },
        });
        return;
      }

      // From this moment an open is in flight for this row, and the stretch
      // ahead — the config-sync check, the automatic install, the dial — has no
      // session bucket to read `connection.phase` off. The toast reads this
      // instead; `connectRemoteWorkspace` clears it once the bucket exists.
      set({ openingRemote: remoteWorkspaceId });

      // §9.4 of the design: config sync is checked before connecting, not
      // folded silently into the connection attempt itself — a policy of
      // 'ask' may need to put a prompt on screen, and that has to happen
      // before the SSH connection, never after a session is already open and
      // running turns against whichever config the remote runtime happened to
      // read at its own start-up.
      //
      // **And the connection then actually waits.** This used to call
      // `checkConfigSync` and carry straight on, which meant the prompt was
      // raised *and* the session was opened against the remote file the person
      // had not yet decided about — so the decision arrived after the thing it
      // was supposed to decide. On a host whose remote `config.json` has no
      // usable route (a fresh account, which is the ordinary first case) the
      // session then died with exit code 2 while the question was still on
      // screen, and answering it changed nothing.
      // A check that itself could not connect refuses the open before a bucket
      // exists, so the "in flight" mark must not outlive it. The rejection is
      // re-raised unchanged: that is how this call already reports a failure
      // to its caller, and the toast's own job is to have cleared, not to
      // invent a new failure sentence.
      const openFailed = () => {
        if (get().openingRemote === remoteWorkspaceId) set({ openingRemote: null });
      };
      try {
        await get().checkConfigSync(host.id);
      } catch (err) {
        openFailed();
        throw err;
      }
      if (get().configSyncPrompt !== null) {
        // Remember what was being opened, so the answer can resume it. The rest
        // of this function is `connectRemoteWorkspace`, which the prompt's own
        // answer calls once there is a decision to act on.
        set({ pendingRemoteOpen: remoteWorkspaceId });
        return;
      }

      await get().connectRemoteWorkspace(remoteWorkspaceId);
    },

    async connectRemoteWorkspace(remoteWorkspaceId, options) {
      const s = get();
      // **No entry-level clear of `openingRemote` here, deliberately.** The
      // mark set by `enterRemoteWorkspace` must survive everything this
      // function does *before* a bucket exists — the automatic install and the
      // dial — and only the terminal paths (bucket installed, or a failure)
      // are allowed to end it. Clearing it on entry would drop the toast for
      // the whole install stretch that follows a config-sync decision.
      const entry = s.remoteWorkspaces.find((item) => item.id === remoteWorkspaceId);
      if (!entry) return;

      // A second call for a workspace that already has a live session is a
      // no-op: the prompt's answer can arrive twice (a double press), and
      // opening two children against one row is not what either press meant.
      // The `forceNew` caller — "New session" on screen over a remote bucket —
      // is the exception: there the person asked for **another** conversation
      // in the same place, which is a second child rather than a duplicate.
      if (!options?.forceNew) {
        const already = s.order.find(
          (key) => s.sessions[key]?.remoteWorkspaceId === remoteWorkspaceId,
        );
        if (already) {
          // No open is in flight — one already exists — so the mark goes.
          if (s.openingRemote === remoteWorkspaceId) set({ openingRemote: null });
          get().focusSession(already);
          return;
        }
      }

      const host = s.sshHosts.find((item) => item.id === entry.hostId);
      if (!host) {
        set({ startupNotice: { code: 'no-workspace' }, openingRemote: null });
        return;
      }

      const ericai = s.ericaiDefault;
      const maxSteps = s.maxStepsDefault;
      const launch: LaunchArgs = { ericai, maxSteps };

      // A workspace saved without a binary path is not a broken bookmark —
      // it is "this host has not had the Runtime installed yet", and the
      // answer is the automatic install, not a form asking for an address.
      // The install is attempted here (and its progress drawn on the row's
      // own install badge) rather than folded into `attachRuntimeRemote`, so
      // §8.4 holds even on this path: a failure that names *what was
      // installed and where* is distinguishable from one that names a
      // connection that refused, and the entry's `remoteBinary` is written
      // by the same act the row's download button uses.
      let binary = entry.remoteBinary.trim();
      if (binary === '') {
        set((state) => ({
          installStatus: {
            ...state.installStatus,
            [remoteWorkspaceId]: {
              stage: 'detecting_platform',
              uploadedEntries: 0,
              totalEntries: 0,
              error: null,
              installedBinary: null,
            },
          },
        }));
        await get().installRemoteWorkspace(remoteWorkspaceId);
        const settled = get().installStatus[remoteWorkspaceId];
        const after = get().remoteWorkspaces.find((item) => item.id === remoteWorkspaceId);
        binary = after?.remoteBinary.trim() ?? '';
        if (settled?.error !== null || binary === '') {
          // The refusal belongs to the session being opened, same shape as
          // the catch below — except the sentence says the install failed
          // (with the install's own reason), not that a connection was
          // attempted and refused.
          openFailedRow(
            entry.remotePath,
            launch,
            remoteWorkspaceId,
            settled?.error !== null
              ? settled.error
              : 'the runtime was not installed on the remote host',
          );
          return;
        }
      }

      let key: string | null;
      try {
        key = await attachRuntimeRemote({
          host: host.host,
          port: host.port,
          user: host.user,
          identityFiles: host.identityFiles,
          password: host.password ?? null,
          remoteBinary: binary,
          remoteWorkspace: entry.remotePath,
          ericai,
          ...(maxSteps === null ? {} : { maxSteps }),
          ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        });
      } catch (err) {
        // Same shape as attachSession's own catch: the refusal belongs to the
        // session being opened, not to the window, so it gets its own
        // short-lived row rather than taking over the screen.
        openFailedRow(entry.remotePath, launch, remoteWorkspaceId, describeFailure(err));
        return;
      }

      // `null` is "no bridge at all" (a plain browser): nothing was started,
      // so the open was never actually in flight.
      if (key === null) {
        set({ openingRemote: null });
        return;
      }

      const bucket = createSessionBucket(key, entry.remotePath, launch, remoteWorkspaceId);
      const runtime = createTauriRuntime(key, (line) => {
        get().pushStderr(key as string, line);
      });
      registerRuntime(runtime);

      const leaving = get().activeKey;
      set((state) => ({
        sessions: { ...state.sessions, [key as string]: bucket },
        order: [...state.order, key as string],
        activeKey: key,
        modal: headForActive(state.pendingModals, key as string),
        panel: null,
        // A session opened into this window replaces what is on screen, so the
        // find bar goes with it. See `FIND_IDLE`.
        ...FIND_IDLE,
        startupProblem: null,
        startupNotice: null,
        // The bucket now exists and its own `connection.phase` (starting at
        // `'connecting'`) takes over announcing the open. The pre-bucket mark
        // is done with, and clearing it here is what hands the toast to the
        // phase-based half of the same selector — no gap, because the bucket
        // lands and the mark clears in one write.
        openingRemote: null,
      }));

      runtime.subscribe((msg) => {
        get().applyRuntimeMessage(key as string, msg);
      });

      void readRuntimeStderr(key).then((early) => {
        for (const line of early) get().pushStderr(key as string, line);
      });

      // The SSH session opened and the remote command started; the protocol
      // handshake (init) is what actually moves `connection.phase` to
      // `'ready'`, through `applyRuntimeMessage` — see its own handling of
      // `init` for a remote bucket. This only records that the process side
      // of starting has happened.
      set((state) => {
        const current = state.sessions[key as string];
        if (!current) return state;
        return {
          sessions: {
            ...state.sessions,
            [key as string]: { ...current, connection: { phase: 'handshaking', problem: null } },
          },
        };
      });

      sendTo(key, { v: 1, t: 'session_list', filter: get().sessionFilter });

      abandonIfUntouched(leaving);
    },

    async installRemoteWorkspace(remoteWorkspaceId) {
      const s = get();
      const entry = s.remoteWorkspaces.find((item) => item.id === remoteWorkspaceId);
      if (!entry) return;
      const host = s.sshHosts.find((item) => item.id === entry.hostId);
      if (!host) return;

      // One request per call, so a progress event arriving late from a
      // superseded attempt (the person pressed install twice) cannot be
      // mistaken for this one's.
      const requestId = `install-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      function patchInstall(patch: Partial<InstallStatus>) {
        set((state) => {
          const current: InstallStatus = state.installStatus[remoteWorkspaceId] ?? {
            stage: 'detecting_platform',
            uploadedEntries: 0,
            totalEntries: 0,
            error: null,
            installedBinary: null,
          };
          return {
            installStatus: {
              ...state.installStatus,
              [remoteWorkspaceId]: { ...current, ...patch },
            },
          };
        });
      }

      patchInstall({
        stage: 'detecting_platform',
        uploadedEntries: 0,
        totalEntries: 0,
        error: null,
        installedBinary: null,
      });

      // Subscribed before the call so the earliest progress events (the
      // platform-detection step can finish before this function's own
      // `await` below yields back here) are not missed — the same ordering
      // concern `installRemoteRuntime`'s own doc calls out.
      const unsubscribe = onInstallProgress((event) => {
        if (event.requestId !== requestId) return;
        patchInstall({
          stage: event.stage,
          uploadedEntries: event.uploadedEntries,
          totalEntries: event.totalEntries,
        });
      });

      try {
        const version = await getAppVersion();
        const installedBinary = await installRemoteRuntime(requestId, {
          host: host.host,
          port: host.port,
          user: host.user,
          identityFiles: host.identityFiles,
          password: host.password ?? null,
          version,
        });
        patchInstall({ stage: 'done', error: null, installedBinary });
        // The whole point of recording the installed path: the next
        // enterRemoteWorkspace call for this entry uses it without anybody
        // having to type it in by hand.
        get().updateRemoteWorkspace(remoteWorkspaceId, { remoteBinary: installedBinary });
      } catch (err) {
        patchInstall({ error: describeFailure(err) });
      } finally {
        unsubscribe();
      }
    },

    async checkConfigSync(hostId) {
      const host = get().sshHosts.find((item) => item.id === hostId);
      if (!host) return;

      const target = {
        host: host.host,
        port: host.port,
        user: host.user,
        identityFiles: host.identityFiles,
        password: host.password ?? null,
      };

      const [remote, local] = await Promise.all([checkRemoteConfig(target), readLocalConfigText()]);

      const baseline = host.configBaselineFingerprint ?? '';
      const localFingerprint = local?.fingerprint ?? null;
      // Mirrors bootstrap.DetectConflict and §9.5's four outcomes, plus the
      // "this is not a question" rules — all in `state/configSync.ts`, so they
      // are assertable without a window. Note `null` for a missing local file:
      // substituting `''` is what made a host with no local config.json flag
      // itself on every open, forever. And two baselines, because a decision is
      // about each side moving away from what was last *seen*, not from the one
      // value the last sync happened to leave behind.
      const decision = decideConfigSync({
        baseline,
        localBaseline: host.configBaselineLocalFingerprint ?? '',
        localFingerprint,
        remoteFingerprint: remote.fingerprint,
        remoteStatus: remote.status,
        policy: host.configPolicy ?? 'ask',
      });

      if (decision.kind === 'nothing') return;

      if (decision.kind === 'adopt-remote') {
        // The remote was not written, so the local file is exactly where it was:
        // recording it as seen is what keeps this same pair from being reported
        // as a change on the next open.
        get().updateSshHost(hostId, {
          configBaselineFingerprint: decision.fingerprint,
          configBaselineLocalFingerprint: localFingerprint ?? '',
        });
        return;
      }

      if (decision.kind === 'upload-local') {
        // `upload-local` is only ever decided with a local file in hand (see
        // `decideConfigSync`), but the null check is what type-narrows it.
        if (local === null) return;
        const newFingerprint = await writeRemoteConfig(target, local.text);
        // Both sides are now the uploaded bytes, so both baselines are it.
        get().updateSshHost(hostId, {
          configBaselineFingerprint: newFingerprint,
          configBaselineLocalFingerprint: newFingerprint,
        });
        return;
      }

      // Only genuinely new information is worth interrupting for — what reached
      // this point has already been filtered by `decideConfigSync`.
      set({
        configSyncPrompt: {
          hostId,
          conflict: decision.conflict,
          firstSync: baseline === '',
          remoteStatus: remote.status,
          localText: local?.text ?? null,
          localFingerprint,
          remoteFingerprint: remote.status === 'missing' ? null : remote.fingerprint,
        },
        // A fresh question is not carrying the previous one's failure.
        configSyncError: null,
      });
    },

    async resolveConfigSync(choice, options) {
      const prompt = get().configSyncPrompt;
      if (!prompt) return;
      // One answer at a time. The write below is a fresh SSH dial plus an SFTP
      // round trip, and a second press landing inside it used to start a second
      // upload against the same remote file.
      if (get().configSyncBusy !== null) return;

      const host = get().sshHosts.find((item) => item.id === prompt.hostId);
      if (!host) {
        set({ configSyncPrompt: null });
        return;
      }

      const target = {
        host: host.host,
        port: host.port,
        user: host.user,
        identityFiles: host.identityFiles,
        password: host.password ?? null,
      };

      // The parked open is taken **before** the write, so a failure below
      // cannot leave it to be resumed a second time by the next answer.
      const resume = get().pendingRemoteOpen;

      set({ configSyncBusy: choice });
      try {
        if (choice === 'use-local') {
          if (prompt.localText !== null) {
            // A failed upload is the answer the person needs: connecting anyway
            // would run the session against the remote file they just chose to
            // replace, which is the opposite of the choice they made.
            const newFingerprint = await writeRemoteConfig(target, prompt.localText);
            // Both sides are the uploaded bytes now, so both baselines are it —
            // which is also what stops this same pair from asking again.
            get().updateSshHost(prompt.hostId, {
              configBaselineFingerprint: newFingerprint,
              configBaselineLocalFingerprint: newFingerprint,
            });
          }
        } else {
          if (prompt.remoteFingerprint !== null) {
            get().updateSshHost(prompt.hostId, { configBaselineFingerprint: prompt.remoteFingerprint });
          }
          // The local file was kept, not written — recording what it is now is
          // the whole point of the answer: "yes, I know these two differ, and I
          // chose the remote". Without it every later open says the same thing.
          get().updateSshHost(prompt.hostId, {
            configBaselineLocalFingerprint: prompt.localFingerprint ?? '',
          });
        }

        // The choice, remembered as the host's own policy (§9.4). Without this
        // there was no way to leave `'ask'` at all: `configPolicy` was read in
        // three places and written by nothing, so a person who answered the same
        // way every time was asked every time. `'sync-local'` is "local always
        // wins", which is exactly what the button says.
        if (options?.remember === true) {
          get().updateSshHost(prompt.hostId, {
            configPolicy: choice === 'use-local' ? 'sync-local' : 'use-remote',
          });
        }
      } catch (err) {
        // The upload refused. **The question stays up, with the reason**, rather
        // than the dialog vanishing and the workspace simply not opening: this is
        // the slow, failure-prone half of the flow (a dial, an SFTP write, a
        // rename on the far side), and a refusal that only ever reached the
        // console was indistinguishable from a dialog that closed for no reason.
        // The open stays parked in `pendingRemoteOpen`, so pressing the same
        // button again retries the write and then resumes it; only the toast's
        // in-flight mark goes, because nothing is connecting while this prompt is
        // still on screen.
        set((state) => ({
          configSyncError: describeFailure(err),
          ...(resume !== null && state.openingRemote === resume ? { openingRemote: null } : {}),
        }));
        // Still re-raised, so a programmatic caller sees the failure the same way
        // every other refusal from this call is seen. The dialog consumes it —
        // the sentence is on screen by then (`configSyncError`).
        throw err;
      } finally {
        // Cleared whatever happened, and **before** the `connectRemoteWorkspace`
        // below: from there on the connecting toast owns the wait, and a busy
        // flag left set would lock the next prompt's buttons.
        set({ configSyncBusy: null });
      }

      // The prompt is over, but the open it was blocking is **not**: the
      // `connectRemoteWorkspace` below still has to run, and it — not this
      // write — clears `openingRemote` once the bucket lands or the open
      // fails. Clearing it here would drop the toast for the whole pre-bucket
      // install stretch that follows the decision.
      set({ configSyncPrompt: null, pendingRemoteOpen: null, configSyncError: null });
      // §9.4's whole point, kept: the decision is made **before** the
      // connection, and this is what finally opens the workspace it was
      // blocking. Skipped when this prompt came from the row's own install
      // button rather than from an open attempt (`pendingRemoteOpen` is null).
      if (resume !== null) {
        await get().connectRemoteWorkspace(resume);
      }
    },

    dismissConfigSync() {
      // A write already in flight is not cancellable, and letting the prompt go
      // mid-write would strand the open it belongs to: `resolveConfigSync`'s
      // finally would still resume it, with nothing on screen having asked for
      // it. Cancel is simply unavailable for that one or two seconds.
      if (get().configSyncBusy !== null) return;
      // A dismissed prompt abandons the open it was blocking, deliberately:
      // Cancel means "not now", and a session silently started against
      // whichever file happened to be there is exactly the outcome the
      // question existed to prevent. The row stays in the sidebar, so the
      // person can press it again and get the question again. The in-flight
      // mark goes with the open it was describing — without this, the
      // connecting toast would say "connecting…" over an open that no longer
      // exists, with nothing to clear it.
      set({ configSyncPrompt: null, pendingRemoteOpen: null, configSyncError: null, openingRemote: null });
    },

    async applyLaunch(next) {
      // The two arguments this panel owns are start-up arguments, so applying
      // them means a new child. The workspace comes from the active session's
      // `init.workspace` — the runtime's own answer about where it is — rather
      // than from a remembered value.
      const current = activeRuntime(get());
      set({
        // Remembered first, and unconditionally: these are the defaults the *next*
        // open uses, and a launch that fails must not silently drop the choice the
        // person just made.
        ericaiDefault: next.ericai,
        maxStepsDefault: next.maxSteps,
      });
      persistPrefs(get());
      const workspace = current?.workspace ?? '';
      await get().attachSession({
        ...(workspace === '' ? {} : { workspace }),
        ericai: next.ericai,
        maxSteps: next.maxSteps ?? undefined,
      });
    },

    toolFacts(name) {
      return lookupToolFacts(activeRuntime(get()), name);
    },
  };
}
