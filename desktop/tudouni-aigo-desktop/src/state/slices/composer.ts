/**
 * composer slice.
 *
 * Moved verbatim out of store.ts; the wrapper is all that changed — the
 * shared helpers arrive as `ctx` instead of being closed over.
 */
import type { StoreContext } from '../storeContext';
import type { AppStore } from '../storeShape';
import type { QuietMode } from '../types';
import { nextId } from '@/state/entries';
import { sendTo } from '@/runtime/bus';
import { insertAtCaret, nameOfPath, nextPlaceholder, removePlaceholderFromDraft, restorePastedPaths, type AttachedFile, type PastedImage } from '@/runtime/paste';
import { stashImage, attachRemoteFile } from '@/runtime/tauri';
import { clampRailWidth, persistPrefs } from '../prefs';
import { selectModalVisible } from '../selectors/session';
import { activeRuntime, activeWorkspaceOf } from '../appView';
import { FIND_IDLE } from '../find';
import { releaseImages } from '../runtimeLanding';

export function composerSlice(ctx: StoreContext): Pick<AppStore, 'setDraft' | 'setDragging' | 'setComposerNotice' | 'stashPastedImage' | 'forgetPastedImage' | 'clearPastedImages' | 'attachFilePath' | 'attachFiles' | 'forgetAttachedFile' | 'historyNav' | 'submitDraft' | 'interrupt' | 'openPanel' | 'closePanel' | 'openFilePicker' | 'setSessionFilter' | 'setBoardOpen' | 'toggleBoard' | 'setClosePrompt' | 'setQuiet' | 'toggleQuiet' | 'openFind' | 'closeFind' | 'setFindQuery' | 'setFindIndex' | 'toggleSidebar' | 'setSidebarVisible' | 'setSidebarWidth' | 'setLeftbarWidth' | 'toggleLeftbar' | 'setLeftbarVisible' | 'toggleBlock' | 'openSidebarBlock' | 'toggleSessionsCollapsed' | 'toggleWorkspacesCollapsed' | 'toggleFootCollapsed' | 'toggleReasoning' | 'toggleTool' | 'toggleTurnFold' | 'removeBlock'> {
  const { set, get, patch, patchWith, patchActive, markSavedSessionsPending } = ctx;
  return {
    setDraft(v) {
      patchActive({ draft: v, historyCursor: null });
    },

    setDragging(on) {
      set({ dragging: on });
    },

    setComposerNotice(notice) {
      patchActive({ composerNotice: notice });
    },

    async stashPastedImage(bytes, at) {
      const s = get();
      const key = s.activeKey;
      const current = activeRuntime(s);
      if (key === null || !current) return null;

      // No optimistic chip: the picture does not exist until the bridge has
      // written it, and a chip drawn before that would name a path the runtime
      // cannot resolve. So the order is write, then insert, then remember.
      let stashed;
      try {
        // The key travels with the bytes: the picture has to land in *this*
        // session's workspace, and the bridge refuses rather than guessing.
        stashed = await stashImage(key, bytes);
      } catch (err) {
        // The bridge's own sentence, verbatim. It is already written for a person
        // ("the clipboard's image data is not a PNG, JPEG or GIF…"), and inventing
        // a second wording here would be a second fact.
        patch(key, { composerNotice: { code: 'paste-failed', reason: String(err), tone: 'warn' } });
        return null;
      }

      // The draft is re-read here rather than taken from `current`: awaiting the
      // bridge gave the person time to keep typing, and inserting into the text
      // as it was would silently drop what they wrote. The placeholder is minted
      // against the *same* re-read, so a token the person typed since the paste
      // started cannot be issued twice.
      const fresh = get().sessions[key]?.draft ?? '';
      const placeholder = nextPlaceholder(fresh);
      const { text, caret } = insertAtCaret(fresh, at, placeholder);

      const image: PastedImage = {
        path: stashed.path,
        placeholder,
        name: stashed.name,
        bytes: stashed.bytes,
        mime: stashed.mime,
        // A preview the WebView can render without the asset protocol: the bytes
        // are already here, and `blob:` is in the CSP's `img-src`. The URL is
        // owned by this store, so `forgetPastedImage`/`clearPastedImages` revoke
        // it — a pasted picture that is never sent would otherwise be pinned in
        // memory for the life of the window.
        url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: stashed.mime })),
      };

      patchWith(key, (bucket) => ({
        draft: text,
        historyCursor: null,
        pastedImages: [...bucket.pastedImages, image],
      }));
      return caret;
    },

    forgetPastedImage(path) {
      patchWith(get().activeKey ?? '', (current) => {
        const doomed = current.pastedImages.find((image) => image.path === path);
        if (doomed) URL.revokeObjectURL(doomed.url);
        // The marker in the sentence comes out with the entry: the tray and the
        // draft are two readings of one list, and a token left where the chip was
        // removed would promise a picture no chip stands for.
        return {
          pastedImages: current.pastedImages.filter((image) => image.path !== path),
          draft: doomed ? removePlaceholderFromDraft(current.draft, doomed.placeholder) : current.draft,
          historyCursor: null,
        };
      });
    },

    clearPastedImages() {
      const key = get().activeKey;
      if (key === null) return;
      releaseImages(get().sessions[key]?.pastedImages ?? []);
      patch(key, { pastedImages: [] });
    },

    attachFilePath(path, at) {
      const s = get();
      const key = s.activeKey;
      if (key === null) return null;

      // The file already exists, so there is nothing to write and nothing to
      // wait for: the insertion is synchronous, and the caret answer is exact.
      const fresh = get().sessions[key]?.draft ?? '';
      const placeholder = nextPlaceholder(fresh, 'file');
      const { text, caret } = insertAtCaret(fresh, at, placeholder);

      const file: AttachedFile = {
        path,
        placeholder,
        name: nameOfPath(path),
      };

      patchWith(key, (bucket) => ({
        draft: text,
        historyCursor: null,
        attachedFiles: [...bucket.attachedFiles, file],
      }));
      return caret;
    },

    /**
     * Attach paths that came from the **operating system** — a drop, or the
     * native file dialog behind the plus menu's "choose a file".
     *
     * The two kinds of screen want two different things, and this is where that
     * stops being every caller's problem:
     *
     *   - **A local session.** The path is meaningful as it stands, so it is
     *     inserted and, when it falls outside the workspace, flagged with the
     *     heads-up `useFileDrop` already drew (`drop-outside`). The file tools
     *     refuse an outside path at `SafePath`, but the model can still reach it
     *     through `shell` — so "insert it, say so" is the honest answer.
     *   - **A remote session.** The path is on *this* machine and the workspace
     *     is on the other one. Inserting it would produce a sentence the far
     *     runtime cannot resolve, and the old sentence explaining that ("the
     *     model would go through shell") was **wrong**: the far shell cannot see
     *     this machine's files either. So each file is uploaded into the remote
     *     workspace and the sentence carries the **workspace-relative** path —
     *     exactly what a pasted picture does, and exactly what the far
     *     `SafePath` resolves.
     *
     * The upload is keyed by the child, never by a destination: the bridge owns
     * the host and workspace, and a front end that could name them could upload
     * into a machine the session does not run on.
     *
     * Answers the number of paths it actually attached, so a caller can tell
     * "nothing landed" from "it worked". A failure is said in the composer —
     * that is where the person is looking, and the drop has no other surface.
     */
    async attachFiles(paths, at) {
      const s = get();
      const key = s.activeKey;
      if (key === null || paths.length === 0) return 0;
      const bucket = s.sessions[key];
      if (!bucket) return 0;

      if (bucket.remoteWorkspaceId === null) {
        // The local half is unchanged: insert the paths as the OS gave them.
        // Whether they are inside the workspace is the caller's notice to draw
        // (`partitionDrop`), because only that caller knows this was a drop
        // rather than a dialog.
        //
        // The carets are not returned: `attachFilePath` answers where the cursor
        // went after *that one* insertion, and with several paths the only
        // sensible answer is the last — which the caller does not use, because a
        // drop appends and a dialog has already returned focus to the textarea.
        for (const path of paths) {
          get().attachFilePath(path, at ?? get().sessions[key]?.draft.length ?? 0);
        }
        return paths.length;
      }

      // **Sequential, not `Promise.all`.** Each upload is a fresh SSH dial plus
      // an SFTP round trip, and the name-collision loop has to see the previous
      // one's result: two files with the same name uploaded at once would both
      // be told "free" and one would overwrite the other.
      const failed: string[] = [];
      let reason = '';
      let attached = 0;
      for (const path of paths) {
        try {
          const uploaded = await attachRemoteFile(key, path);
          // Inserted at the end each time rather than at the caller's caret:
          // the draft may have been edited while the upload ran, and an index
          // captured before it would cut a word in half.
          const fresh = get().sessions[key]?.draft ?? '';
          get().attachFilePath(uploaded.path, fresh.length);
          attached += 1;
        } catch (err) {
          failed.push(nameOfPath(path));
          // The bridge's sentence, verbatim — it is already written for a
          // person ("… is a directory — attach a file, or put it in the
          // workspace first"), and a second wording here would be a second fact.
          reason = err instanceof Error ? err.message : String(err);
        }
      }
      if (failed.length > 0) {
        patch(key, {
          composerNotice: { code: 'attach-remote-failed', names: failed, reason, tone: 'warn' },
        });
      } else if (attached > 0) {
        // Nothing to say: the files are in the workspace and the sentence names
        // them. Clearing rather than leaving a previous warning up is the same
        // rule the drop's own "inserted" branch follows.
        patch(key, { composerNotice: null });
      }
      return attached;
    },

    forgetAttachedFile(path) {
      patchWith(get().activeKey ?? '', (current) => {
        const doomed = current.attachedFiles.find((file) => file.path === path);
        // The marker comes out with the entry, exactly as a picture chip's
        // dismissal does: the tray and the draft are two readings of one list.
        return {
          attachedFiles: current.attachedFiles.filter((file) => file.path !== path),
          draft: doomed ? removePlaceholderFromDraft(current.draft, doomed.placeholder) : current.draft,
          historyCursor: null,
        };
      });
    },

    historyNav(dir) {
      const current = activeRuntime(get());
      if (!current) return;
      const { history, historyCursor } = current;
      if (history.length === 0) return;
      let cursor: number | null;
      if (historyCursor === null) {
        if (dir === 1) return; // Already at the newest end.
        cursor = history.length - 1;
      } else {
        cursor = historyCursor + dir;
      }
      if (cursor < 0) {
        patchActive({ historyCursor: 0, draft: history[0] });
        return;
      }
      if (cursor >= history.length) {
        patchActive({ historyCursor: null, draft: '' });
        return;
      }
      patchActive({ historyCursor: cursor, draft: history[cursor] });
    },

    submitDraft() {
      const s = get();
      const key = s.activeKey;
      const current = activeRuntime(s);
      if (key === null || !current) return;
      // The conversation on screen has no process yet (a start-up in flight):
      // there is nothing for a message to reach, so it is not sent rather
      // than queued. The draft stays in the input — typing while the child
      // boots is fine, sending is not.
      if (!current.ready) return;
      // What the person wrote and what the runtime receives are **two strings**.
      // The draft carries placeholders; the sentence that goes out carries paths,
      // because a path in the text is the only image channel the runtime has.
      // The transcript keeps the draft — the placeholder is what the person said,
      // and the chip row above the input already told them the picture was there.
      const sent = restorePastedPaths(current.draft, current.pastedImages, current.attachedFiles).trim();
      const text = current.draft.trim();
      if (sent === '') return;
      // A **visible** modal is blocking: nothing may be sent over the top of
      // one. Asked of visibility rather than of the slot: a request held by a
      // background session has drawn nothing here, and sending into this
      // conversation is exactly what switching away from it permits.
      if (selectModalVisible(s)) return;
      // The pictures have done their job the moment the sentence goes out: what
      // travels is the **path**, and the runtime reads the file itself. So the
      // stash and its preview URLs are released here rather than held — a chip for
      // a message that has already been sent would be a claim about the draft, and
      // the draft is now empty.
      releaseImages(current.pastedImages);
      patchWith(key, (bucket) => ({
        entries: [...bucket.entries, { kind: 'user', id: nextId('user'), text, atMs: Date.now() }],
        draft: '',
        history: [...bucket.history, text].slice(-100),
        historyCursor: null,
        hasSpoken: true,
        pastedImages: [],
        attachedFiles: [],
        // Whatever was said about this input has been answered by sending it.
        composerNotice: null,
      }));
      sendTo(key, { v: 1, t: 'user_message', text: sent });
    },

    interrupt() {
      const key = get().activeKey;
      if (key === null) return;
      sendTo(key, { v: 1, t: 'interrupt' });
    },

    /* ==========================================================
       Panels and preferences
       ========================================================== */
    openPanel(p, focus) {
      // A pick mode is never inherited: only `openFilePicker` turns it on, and
      // any other way into a panel is the plain browser's. ('files' keeps
      // whatever `openFilePicker` just set; everything else clears it.)
      //
      // `fileFocus` is **asked for, never inherited**: only `previewImage` passes
      // `focus`, so a second `openPanel('files')` — the palette, a re-open,
      // anything — is a browser. Inheriting it made the directory listing
      // silently unavailable for the rest of the window's life, which is a worse
      // failure than the layout it fixes.
      set({
        panel: p,
        filePick: p === 'files' ? get().filePick : false,
        fileFocus: p === 'files' && focus === true,
      });
      const key = get().activeKey;
      // **The library borrows the connection's filter.** Its Archived tab draws
      // rows the rail is not supposed to show, and the runtime's list is one
      // per connection — so while this panel is up the connection asks for
      // everything, and `closePanel` hands the steady state back. Sending it
      // through `setSessionFilter` is what keeps the two in step rather than
      // having this one call site remember to restore it.
      if (p === 'resume') get().setSessionFilter('all');
      // Every request a panel makes is about the session being shown, and with
      // several open that is the only one whose answer this panel could mean.
      if (key === null) return;
      if (p === 'resume') {
        // The picker lists the **workspace's** sessions, so what goes back to
        // loading is that workspace's list — not this child's bucket, which no
        // longer holds one. `setSessionFilter` already asked for it.
      }
      if (p === 'skills') {
        sendTo(key, { v: 1, t: 'skills' });
      }
      if (p === 'mcp') {
        // `mcp` is only ever sent because a person asked for it. The front end
        // never sends it on its own initiative — that would make "the config
        // widens itself" possible.
        sendTo(key, { v: 1, t: 'mcp', action: 'list', servers: [] });
      }
      if (p === 'files') {
        // Opens at the workspace root and asks for it in the same breath. The
        // panel draws its loading state immediately, so this never looks like a
        // dead keypress while the runtime reads the directory.
        patch(key, { filesLoading: true });
        sendTo(key, { v: 1, t: 'file_list', path: '' });
      }
      if (p === 'terminal') {
        // The list is already carried on every `ui(state)`, so this is a
        // refresh rather than the only source of it — a front end that never
        // sent this would still show terminals, one snapshot later.
        sendTo(key, { v: 1, t: 'terminal_list' });
      }
      if (p === 'memory') {
        // The snapshot is asked for on open because it is the only source: unlike the
        // terminal list it does not ride on `ui(state)`, since a workspace memory is
        // not something every turn needs to redraw.
        get().requestMemory();
      }
      if (p === 'codeintel') {
        // Same rule as memory: the counts are the panel's own snapshot. The switch is
        // also on `ui(state)`, but "how far behind is it" is not, and that is the
        // question the panel exists to answer.
        get().requestCodeIntel();
      }
      if (p === 'usage') {
        // Same rule again, with one window-level twist: the answer lands outside the
        // session buckets, so it survives a session switch — the ledger counts this
        // user's spend across every workspace, and resetting it on a switch would
        // make the panel contradict what it had just shown.
        get().requestUsage();
      }
    },

    closePanel() {
      const wasLibrary = get().panel === 'resume';
      set({ panel: null, filePick: false, fileFocus: false });
      // Only when the library was the one open: every other panel leaves the
      // filter alone, and asking for a list nobody wants would be a message per
      // panel close.
      if (wasLibrary) get().setSessionFilter('active');
    },

    openFilePicker() {
      // The flag goes down first: `openPanel` reads it (`filePick` survives a
      // transition into 'files' only when it is already raised) so the picker
      // opens with the workspace root listing that `openPanel('files')` sends.
      set({ filePick: true });
      get().openPanel('files');
    },

    setSessionFilter(filter) {
      if (get().sessionFilter === filter) return;
      set({ sessionFilter: filter });
      const key = get().activeKey;
      if (key === null) return;
      // Asked for immediately: the caller just changed which rows should be on
      // screen, and waiting for the next unrelated `session_list` would leave the
      // list showing the previous view under the new tab's label.
      markSavedSessionsPending(
        activeWorkspaceOf(get()),
        get().sessions[key]?.remoteWorkspaceId ?? null,
      );
      sendTo(key, { v: 1, t: 'session_list', filter });
    },

    setBoardOpen(open) {
      // **Closing a panel, not preserving it.** The board is a view and a panel is
      // a dialog; the conversation column can only show one thing, so opening one
      // must put the other away rather than leave a panel stacked over the board.
      if (!open) {
        set({ boardOpen: false });
        return;
      }
      // **An attached shell loses the screen to the board, explicitly.** The
      // view's priority order keeps the terminal above the board — `TerminalView`
      // is the only way out of a shell, so nothing may cover it — which is why
      // merely setting `boardOpen` here was invisible whenever a shell was on
      // screen: the flag flipped, the terminal kept drawing, and the press read
      // as dead until the shell was left by hand. Opening the board is an
      // explicit act, exactly like pressing the detach control, so it detaches
      // the same way — through `attachTerminal(null)`, so the "still running"
      // note is written by the one place that writes it.
      get().attachTerminal(null);
      set({ boardOpen: true, panel: null });
    },

    toggleBoard() {
      get().setBoardOpen(!get().boardOpen);
    },

    setClosePrompt(open) {
      // **It closes no panel, and that is deliberate.** Closing a panel here
      // would be a silent edit to a screen the person put in a particular state,
      // and nothing about the prompt needs the panel gone: it is its own layer.
      set({ closePrompt: open });
    },

    setQuiet(q) {
      const key = get().activeKey;
      if (key === null) return;
      patch(key, { quiet: q });
      // Remembered so a fresh session starts the way the last one was left. The
      // value is passed explicitly rather than read back off the store, because
      // `persistPrefs` is also called from paths where the active session is not
      // what changed.
      persistPrefs(get(), { key, value: q });
    },

    toggleQuiet() {
      // The chip is a menu now, so the keyboard and `/quiet` have no toggle to
      // flip: a bare press **cycles** the three states (off → normal → simple),
      // which keeps the key from becoming dead while still leaving the menu the
      // one place a state can be *chosen*.
      const current = activeRuntime(get());
      if (!current) return;
      const next: QuietMode =
        current.quiet === 'off' ? 'normal' : current.quiet === 'normal' ? 'simple' : 'off';
      get().setQuiet(next);
    },

    openFind() {
      // The needle is kept if the bar is re-raised over the same transcript —
      // which is what `Ctrl+F` after `Esc` should do — and the index with it, so
      // the reader is put back where they were rather than at the first hit. What
      // is always asked for is the keyboard: see `findFocus`.
      set((s) => ({ findOpen: true, findFocus: s.findFocus + 1 }));
    },

    closeFind() {
      set({ ...FIND_IDLE });
    },

    setFindQuery(q) {
      // Back to the first hit: a new needle's third match is not the third match
      // of the old one, and keeping the number would land the reader somewhere
      // arbitrary in the new set.
      set({ findQuery: q, findIndex: 0 });
    },

    setFindIndex(i) {
      set({ findIndex: i < 0 ? 0 : i });
    },

    toggleSidebar() {
      set({ sidebarVisible: !get().sidebarVisible });
      persistPrefs(get());
    },

    setSidebarVisible(v) {
      set({ sidebarVisible: v });
      persistPrefs(get());
    },

    /**
     * The dragged width. Clamped at the single place that remembers it, so a
     * future change to the range re-clamps what is read back, and `null` (no
     * dragging has happened) hands the width back to the stylesheet.
     */
    setSidebarWidth(px) {
      set({ sidebarWidth: px === null ? null : clampRailWidth(px) });
      persistPrefs(get());
    },

    /**
     * The left rail's dragged width — the same clamp, the same persistence and
     * the same `null`-hands-it-back-to-the-stylesheet contract as the right
     * rail's above, so a person who has learned one rail already knows the
     * other. Kept a separate action rather than one taking a side, because the
     * two fields are separate: writing one must not touch the other.
     */
    setLeftbarWidth(px) {
      set({ leftbarWidth: px === null ? null : clampRailWidth(px) });
      persistPrefs(get());
    },

    toggleLeftbar() {
      set({ leftbarVisible: !get().leftbarVisible });
      persistPrefs(get());
    },

    setLeftbarVisible(v) {
      set({ leftbarVisible: v });
      persistPrefs(get());
    },

    toggleBlock(k) {
      // Once a person has touched it, the auto-expand rule never fires again.
      set({
        blockCollapsed: { ...get().blockCollapsed, [k]: !get().blockCollapsed[k] },
        blockTouched: { ...get().blockTouched, [k]: true },
      });
      persistPrefs(get());
    },

    openSidebarBlock(k) {
      // One-directional: the chip is a door back into a folded rail, so the
      // press always opens rather than toggling. Marking the block touched keeps
      // the one-time auto-expand rule from ever rewriting this choice.
      set({
        sidebarVisible: true,
        blockCollapsed: { ...get().blockCollapsed, [k]: false },
        blockTouched: { ...get().blockTouched, [k]: true },
      });
      persistPrefs(get());
    },

    toggleSessionsCollapsed() {
      set({ sessionsCollapsed: !get().sessionsCollapsed });
      persistPrefs(get());
    },

    toggleWorkspacesCollapsed() {
      set({ workspacesCollapsed: !get().workspacesCollapsed });
      persistPrefs(get());
    },

    toggleFootCollapsed() {
      set({ footCollapsed: !get().footCollapsed });
      persistPrefs(get());
    },

    toggleReasoning(id) {
      const cur = get().reasoningOpen;
      set({ reasoningOpen: { ...cur, [id]: !cur[id] } });
    },

    toggleTool(id) {
      const cur = get().toolOpen;
      set({ toolOpen: { ...cur, [id]: !cur[id] } });
    },

    toggleTurnFold(id) {
      const cur = get().turnFolded;
      set({ turnFolded: { ...cur, [id]: !cur[id] } });
    },

    removeBlock(id) {
      const key = get().activeKey;
      if (key === null) return;
      patchWith(key, (current) => ({
        entries: current.entries.filter((e) => !(e.kind === 'block' && e.id === id)),
      }));
    },

    /* ==========================================================
       The two blocking modals
       ========================================================== */
  };
}
