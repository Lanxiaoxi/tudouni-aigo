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
import { expandAnnotations, insertAtCaret, nameOfPath, nextPlaceholder, removePlaceholderFromDraft, restorePastedPaths, referencedFiles, referencedImages, type Annotation, type AttachedFile, type PastedImage, type PendingFile, type PendingImage } from '@/runtime/paste';
import { stashImages, attachRemoteFiles, type AttachedRemoteFile, type StashedImage } from '@/runtime/tauri';
import { clampRailWidth, persistPrefs } from '../prefs';
import { promptHistoryKey, rememberablePrompt } from '../promptHistory';
import { rememberPrompt } from '../promptStore';
import { selectModalVisible } from '../selectors/session';
import { activeRuntime, activeWorkspaceOf } from '../appView';
import { FIND_IDLE } from '../find';
import { releaseImages } from '../runtimeLanding';
import { landPersonReplied } from '../ticketLanding';

export function composerSlice(ctx: StoreContext): Pick<AppStore, 'setDraft' | 'applySuggestion' | 'setDragging' | 'setComposerNotice' | 'pasteImages' | 'forgetImage' | 'clearPastedImages' | 'attachFilePath' | 'attachFiles' | 'forgetAttachedFile' | 'forgetPendingFile' | 'addAnnotation' | 'forgetAnnotation' | 'historyNav' | 'submitDraft' | 'interrupt' | 'openPanel' | 'closePanel' | 'openFilePicker' | 'setSessionFilter' | 'setBoard' | 'toggleBoard' | 'setClosePrompt' | 'setQuiet' | 'toggleQuiet' | 'openFind' | 'closeFind' | 'setFindQuery' | 'setFindIndex' | 'toggleSidebar' | 'setSidebarVisible' | 'setSidebarWidth' | 'setLeftbarWidth' | 'toggleLeftbar' | 'setLeftbarVisible' | 'toggleBlock' | 'openSidebarBlock' | 'toggleSessionsCollapsed' | 'toggleWorkspacesCollapsed' | 'toggleFootCollapsed' | 'setTicketStartMode' | 'toggleReasoning' | 'toggleTool' | 'toggleTurnFold' | 'removeBlock'> {
  const { set, get, patch, patchWith, patchActive, markSavedSessionsPending } = ctx;

  /**
   * One remote upload at a time **per session**.
   *
   * The name-collision loop on the host is a `stat` followed by a `create`, which
   * is not atomic: two uploads in flight at once could both be told that
   * `report.pdf` is free, and the second would overwrite the first. Chips are
   * drawn the moment a drop happens, so a second drop while the first is still
   * uploading is now an ordinary thing to do — it simply waits its turn, with its
   * chips already on screen.
   *
   * The stored tail never rejects, so a failed job cannot wedge the queue.
   */
  const uploadTails = new Map<string, Promise<void>>();
  function enqueueUpload<T>(key: string, job: () => Promise<T>): Promise<T> {
    const before = uploadTails.get(key) ?? Promise.resolve();
    const run = before.then(job);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    uploadTails.set(key, tail);
    void tail.then(() => {
      if (uploadTails.get(key) === tail) uploadTails.delete(key);
    });
    return run;
  }

  return {
    setDraft(v) {
      patchActive({ draft: v, historyCursor: null });
    },

    applySuggestion(text, fill) {
      const reply = text.trim();
      if (reply === '') return;
      // Put in the draft either way, then — for a plain click — sent through
      // `submitDraft`, so a clicked reply takes exactly the path a typed one
      // does: the readiness and modal checks, the echo, the history, the same
      // `user_message`. A second send path is how the two drift apart.
      // The buttons are only drawn over an empty draft, so nothing is lost.
      patchActive({ draft: reply, historyCursor: null });
      if (!fill) get().submitDraft();
    },

    setDragging(on) {
      set({ dragging: on });
    },

    setComposerNotice(notice) {
      patchActive({ composerNotice: notice });
    },

    async pasteImages(pictures, at) {
      const s = get();
      const key = s.activeKey;
      const current = activeRuntime(s);
      if (key === null || !current || pictures.length === 0) return null;

      // The tokens are minted and inserted **here and now**, in one write, before
      // the bridge is asked for anything: the chips are the promise, and the
      // promise must not wait for a remote upload to be drawn. Inserting over a
      // local copy of the text keeps three pictures in the order they arrived and
      // lets the caret follow once, at the end.
      const fresh = get().sessions[key]?.draft ?? '';
      let text = fresh;
      let caret = at;
      const pending: PendingImage[] = [];
      for (const picture of pictures) {
        const placeholder = nextPlaceholder(text);
        const placed = insertAtCaret(text, caret, placeholder);
        text = placed.text;
        caret = placed.caret;
        pending.push({
          placeholder,
          bytes: picture.bytes.length,
          mime: picture.mime,
          // The clipboard's bytes are already in this window, so the thumbnail
          // does not wait for the write either. The URL is owned by this store:
          // every path that drops a chip revokes it.
          url: URL.createObjectURL(new Blob([picture.bytes as BlobPart], { type: picture.mime })),
        });
      }

      patchWith(key, (bucket) => ({
        draft: text,
        historyCursor: null,
        pendingImages: [...bucket.pendingImages, ...pending],
      }));

      let stashed: StashedImage[];
      try {
        // The key travels with the gesture: the pictures have to land in *this*
        // session's workspace, and the bridge refuses rather than guessing.
        stashed = await stashImages(
          key,
          pictures.map((picture) => picture.bytes),
        );
        // The answer is one path per picture, in order. A shorter answer would
        // leave chips that can never be promoted — a chip saying "Uploading…"
        // for ever, and a send refused for ever — so it is treated as the
        // failure it is rather than quietly accepted.
        if (stashed.length !== pictures.length) {
          throw new Error(
            `the bridge answered for ${stashed.length} of ${pictures.length} pictures`,
          );
        }
      } catch (err) {
        // The bridge refused, or the link did. Nothing was written — the Rust
        // side validates the whole frame before its first byte — so the chips go
        // back out with the sentence that says why: a pending chip left on screen
        // would promise a picture that is not coming, which is this feature's
        // worst failure. The bridge's sentence is already written for a person
        // ("the clipboard's image data is not a PNG, JPEG or GIF…"), so it is
        // passed through rather than re-worded.
        const doomed = new Set(pending.map((entry) => entry.placeholder));
        const here = get().sessions[key];
        if (here) {
          const leaving = here.pendingImages.filter((entry) => doomed.has(entry.placeholder));
          releaseImages(leaving);
          let draft = here.draft;
          for (const entry of leaving) draft = removePlaceholderFromDraft(draft, entry.placeholder);
          patch(key, {
            draft,
            pendingImages: here.pendingImages.filter((entry) => !doomed.has(entry.placeholder)),
            composerNotice: { code: 'paste-failed', reason: String(err), tone: 'warn' },
          });
        }
        return null;
      }

      // The write landed: the same chips become ordinary stashed pictures, in
      // the order the paste made them. A chip the person dismissed while the
      // upload ran is simply absent from the bucket, so nothing is promoted for
      // it — the file stays in staging and the runtime's own sweep forgets it.
      patchWith(key, (bucket) => {
        const answers = new Map<string, StashedImage>();
        pending.forEach((entry, index) => {
          const answer = stashed[index];
          if (answer) answers.set(entry.placeholder, answer);
        });
        const promoted: PastedImage[] = [];
        const staying: PendingImage[] = [];
        for (const entry of bucket.pendingImages) {
          const answer = answers.get(entry.placeholder);
          if (!answer) {
            staying.push(entry);
            continue;
          }
          promoted.push({
            path: answer.path,
            placeholder: entry.placeholder,
            name: answer.name,
            bytes: answer.bytes,
            mime: answer.mime,
            url: entry.url,
          });
        }
        return {
          pendingImages: staying,
          pastedImages: [...bucket.pastedImages, ...promoted],
          // A send pressed while this was in flight was refused with a notice;
          // the sentence it refused is sendable now, so that notice goes with
          // it. Any other notice is about something else and stays.
          composerNotice:
            bucket.composerNotice?.code === 'paste-pending' ? null : bucket.composerNotice,
        };
      });
      return caret;
    },

    forgetImage(placeholder) {
      patchWith(get().activeKey ?? '', (current) => {
        const pending = current.pendingImages.find((image) => image.placeholder === placeholder);
        const stashed = current.pastedImages.find((image) => image.placeholder === placeholder);
        const url = pending?.url ?? stashed?.url;
        if (url) URL.revokeObjectURL(url);
        // The marker in the sentence comes out with the entry: the tray and the
        // draft are two readings of one list, and a token left where the chip was
        // removed would promise a picture no chip stands for.
        return {
          pendingImages: current.pendingImages.filter((image) => image.placeholder !== placeholder),
          pastedImages: current.pastedImages.filter((image) => image.placeholder !== placeholder),
          draft: removePlaceholderFromDraft(current.draft, placeholder),
          historyCursor: null,
        };
      });
    },

    clearPastedImages() {
      const key = get().activeKey;
      if (key === null) return;
      const bucket = get().sessions[key];
      releaseImages(bucket?.pastedImages ?? []);
      // In flight as well: the write will settle into nothing, because the
      // promotion only rewrites entries the bucket still holds.
      releaseImages(bucket?.pendingImages ?? []);
      patch(key, { pastedImages: [], pendingImages: [] });
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
     * **The chips are drawn before the upload, as a pasted picture's are.** Each
     * path gets a token in the sentence and a chip (`pendingFiles`) in the same
     * synchronous write; the chip stops saying "uploading" when the host answers.
     * The send is refused while a *referenced* pending chip exists, and the one
     * call carries the whole drop, so the host is dialled once.
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

      // **The chips come first**, exactly as for a pasted picture. An upload is
      // measured in seconds (up to 64MB per file), and a drop that shows nothing
      // for that long reads as a dropped event — and, worse, leaves a window in
      // which the person presses send and the message goes out without the file,
      // after which the path lands in a draft that was already emptied.
      //
      // So the tokens are minted and inserted here, synchronously, in one write,
      // over a local copy of the text (three files keep the order they arrived
      // in, and the caret follows once). The caret is honoured now that the
      // insertion is synchronous: the old "append, because the draft may change
      // while the upload runs" was a consequence of inserting *after* the wait.
      const fresh = bucket.draft;
      let text = fresh;
      let caret = at ?? fresh.length;
      const pending: PendingFile[] = [];
      for (const path of paths) {
        const placeholder = nextPlaceholder(text, 'file');
        const placed = insertAtCaret(text, caret, placeholder);
        text = placed.text;
        caret = placed.caret;
        pending.push({ id: nextId('upload'), placeholder, name: nameOfPath(path) });
      }
      patchWith(key, (current) => ({
        draft: text,
        historyCursor: null,
        pendingFiles: [...current.pendingFiles, ...pending],
      }));

      // **One call for the whole gesture, and one gesture at a time per
      // session** (`enqueueUpload`): the Rust side dials once for every file in
      // the call, and the queue keeps two calls from racing the host's
      // stat-then-create name check.
      type Answer = { file: AttachedRemoteFile } | { error: string };
      const answers = await enqueueUpload(key, async () => {
        const settled = new Map<string, Answer>();
        // A chip dismissed while this gesture waited its turn is not uploaded at
        // all: nothing has started for it, so there is nothing to sweep later.
        const alive = new Set((get().sessions[key]?.pendingFiles ?? []).map((entry) => entry.id));
        const wanted = pending
          .map((entry, index) => ({ entry, path: paths[index] }))
          .filter(({ entry }) => alive.has(entry.id));
        if (wanted.length === 0) return settled;
        try {
          const outcomes = await attachRemoteFiles(
            key,
            wanted.map(({ path }) => path),
          );
          // A shorter answer would leave chips that can never be promoted — a
          // chip saying "uploading" for ever and a send refused for ever — so it
          // is the failure it is rather than something quietly accepted.
          if (outcomes.length !== wanted.length) {
            throw new Error(`the bridge answered for ${outcomes.length} of ${wanted.length} files`);
          }
          wanted.forEach(({ entry }, index) => {
            const outcome = outcomes[index];
            settled.set(
              entry.id,
              outcome.file !== null
                ? { file: outcome.file }
                : { error: outcome.error ?? 'the file was not uploaded' },
            );
          });
        } catch (err) {
          // The call as a whole failed (the session is gone, or the link is):
          // every file of it shares the sentence.
          const message = err instanceof Error ? err.message : String(err);
          for (const { entry } of wanted) settled.set(entry.id, { error: message });
        }
        return settled;
      });

      // Settle the chips. Matched by **id**, not by token: `⟦file-0⟧` is minted
      // again for the next message, and a late answer for the first must not be
      // promoted onto the second's chip. A chip the person dismissed (or a
      // message they sent) while the upload ran is simply absent from the
      // bucket, so nothing is promoted for it — the file stays in staging and
      // the runtime's own sweep forgets it.
      const failed: string[] = [];
      let reason = '';
      let attached = 0;
      patchWith(key, (current) => {
        const staying: PendingFile[] = [];
        const promoted: AttachedFile[] = [];
        let draft = current.draft;
        for (const entry of current.pendingFiles) {
          const answer = answers.get(entry.id);
          if (!answer) {
            staying.push(entry);
            continue;
          }
          if ('file' in answer) {
            promoted.push({
              path: answer.file.path,
              placeholder: entry.placeholder,
              // The name the host chose: a taken name comes back numbered.
              name: answer.file.name,
            });
            attached += 1;
          } else {
            // A chip that will never ship comes out with its token — a pending
            // chip left on screen would promise a file that is not coming.
            draft = removePlaceholderFromDraft(draft, entry.placeholder);
            failed.push(entry.name);
            // The bridge's sentence, verbatim — it is already written for a
            // person ("… is a directory — attach a file, or put it in the
            // workspace first"), and a second wording here would be a second fact.
            reason = answer.error;
          }
        }
        const stale =
          current.composerNotice?.code === 'attach-pending' ||
          current.composerNotice?.code === 'attach-remote-failed';
        return {
          draft,
          pendingFiles: staying,
          attachedFiles: [...current.attachedFiles, ...promoted],
          composerNotice:
            failed.length > 0
              ? { code: 'attach-remote-failed', names: failed, reason, tone: 'warn' }
              : // A send held back while this was in flight is sendable now, so
                // that notice goes with it, and so does a warning about an
                // earlier drop. Any other notice is about something else.
                attached > 0 && stale
                ? null
                : current.composerNotice,
        };
      });
      return attached;
    },

    forgetPendingFile(placeholder) {
      patchWith(get().activeKey ?? '', (current) => ({
        // The upload cannot be cancelled once it has started, but a file the
        // person removed must not reappear as a chip when it lands: the answer
        // is matched against this list, and the entry is gone from it.
        pendingFiles: current.pendingFiles.filter((entry) => entry.placeholder !== placeholder),
        draft: removePlaceholderFromDraft(current.draft, placeholder),
        historyCursor: null,
      }));
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

    addAnnotation(quote, note) {
      const key = get().activeKey;
      if (key === null || quote.trim() === '' || note.trim() === '') return;
      patchWith(key, (bucket) => {
        // Appended at the end, like "add to input": the person was reading the
        // transcript, not editing the draft, so there is no caret to honour.
        const placeholder = nextPlaceholder(bucket.draft, 'note');
        const { text } = insertAtCaret(bucket.draft, bucket.draft.length, placeholder);
        const annotation: Annotation = { placeholder, quote: quote.trim(), note: note.trim() };
        return {
          draft: text,
          historyCursor: null,
          // A token recycled after its chip was dismissed must not find the old
          // entry still in the list.
          annotations: [...bucket.annotations.filter((a) => a.placeholder !== placeholder), annotation],
        };
      });
    },

    forgetAnnotation(placeholder) {
      patchWith(get().activeKey ?? '', (current) => ({
        annotations: current.annotations.filter((a) => a.placeholder !== placeholder),
        draft: removePlaceholderFromDraft(current.draft, placeholder),
        historyCursor: null,
      }));
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
      // A picture that is still being written has **no path yet**. Sending now
      // would put its token in the sentence — prose where a picture should be,
      // and a picture that silently never arrives. So the send waits for the
      // write and says why, rather than dropping either half.
      if (referencedImages(current.draft, current.pendingImages).length > 0) {
        patch(key, { composerNotice: { code: 'paste-pending', tone: 'info' } });
        return;
      }
      // The same rule for a dropped file still being uploaded: it has no path on
      // the host yet, and a token that went out would be prose. Without this the
      // message left without the file, and the path then landed in a draft that
      // had already been emptied.
      if (referencedFiles(current.draft, current.pendingFiles).length > 0) {
        patch(key, { composerNotice: { code: 'attach-pending', tone: 'info' } });
        return;
      }
      // What the person wrote and what the runtime receives are **two strings**.
      // The draft carries placeholders; the sentence that goes out carries paths,
      // because a path in the text is the only image channel the runtime has.
      // The transcript keeps the draft — the placeholder is what the person said,
      // and the chip row above the input already told them the picture was there.
      // Annotations are expanded first: a quote is text, and a path-shaped word
      // inside it must not be mistaken for an attachment's token.
      const sent = restorePastedPaths(
        expandAnnotations(current.draft, current.annotations),
        current.pastedImages,
        current.attachedFiles,
      ).trim();
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
      //
      // Pending ones go too, and there is at most a dismissed marker's worth of
      // them here: a *referenced* pending picture refuses the send above, so
      // anything left is a chip whose token the person already deleted.
      releaseImages(current.pastedImages);
      releaseImages(current.pendingImages);
      patchWith(key, (bucket) => ({
        entries: [...bucket.entries, { kind: 'user', id: nextId('user'), text, atMs: Date.now() }],
        draft: '',
        history: [...bucket.history, text].slice(-100),
        historyCursor: null,
        hasSpoken: true,
        pastedImages: [],
        pendingImages: [],
        attachedFiles: [],
        // Like the pending pictures, at most a dismissed marker's worth: a
        // *referenced* pending file refused the send above. Clearing the list is
        // also what makes a late answer for it land on nothing.
        pendingFiles: [],
        annotations: [],
        // Whatever was said about this input has been answered by sending it.
        composerNotice: null,
        // The quick replies answered the previous turn; anything sent — typed or
        // clicked — makes them about the wrong one.
        suggestions: null,
      }));
      // **The sentence is remembered for the workspace, not the session.** The
      // history is a habit of the directory — a new session in the same place
      // should offer the phrase back. The attachment paths come out first
      // (`rememberablePrompt`): what is worth completing is the prose, while an
      // absolute path is noise and may name a file the runtime has swept. Fire
      // and forget: a history file that refused is not a reason to hold a send.
      const remembered = rememberablePrompt(sent, [
        ...current.pastedImages.map((image) => image.path),
        ...current.attachedFiles.map((file) => file.path),
      ]);
      const workspace = activeWorkspaceOf(s);
      if (remembered !== '' && workspace !== '') {
        rememberPrompt(promptHistoryKey(workspace, current.remoteWorkspaceId), remembered);
      }
      sendTo(key, { v: 1, t: 'user_message', text: sent });
      // The person speaking in a session is the answer a `needs_you` Ticket is
      // waiting for. This is the one door a typed or clicked message goes
      // through; a Ticket's own messages (`speak`) are not the person replying.
      landPersonReplied(ctx, key);
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
      if (p === 'hooks') {
        // Asked for on open, and not carried on `ui(state)`: which hooks a session
        // loaded and how their scripts have done is not something every turn needs
        // to redraw.
        get().requestHooks();
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

    setBoard(next) {
      // **Closing a panel, not preserving it.** The board is a view and a panel is
      // a dialog; the conversation column can only show one thing, so opening one
      // must put the other away rather than leave a panel stacked over the board.
      // Opening one board replaces the other for the same reason: `board` holds
      // one value, so the exclusion needs no code here.
      if (next === null) {
        set({ board: null });
        return;
      }
      // **An attached shell loses the screen to the board, explicitly.** The
      // view's priority order keeps the terminal above the board — `TerminalView`
      // is the only way out of a shell, so nothing may cover it — which is why
      // merely setting `board` here was invisible whenever a shell was on
      // screen: the flag flipped, the terminal kept drawing, and the press read
      // as dead until the shell was left by hand. Opening the board is an
      // explicit act, exactly like pressing the detach control, so it detaches
      // the same way — through `attachTerminal(null)`, so the "still running"
      // note is written by the one place that writes it.
      get().attachTerminal(null);
      set({ board: next, panel: null });
    },

    toggleBoard(kind) {
      get().setBoard(get().board === kind ? null : kind);
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

    setTicketStartMode(mode) {
      set({ ticketStartMode: mode });
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
