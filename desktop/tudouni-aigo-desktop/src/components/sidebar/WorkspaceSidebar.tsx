import { useMemo, useState } from 'react';
import { ChevronRight, FileText, FolderPlus, Folder, LayoutGrid, PanelLeftClose, Plus, RefreshCw, Settings, SquareTerminal, Trash2, X } from 'lucide-react';
import {
  activeRuntime,
  activeWorkspaceOf,
  railBlocked,
  selectLiveOnlyKey,
  selectRowStatusKey,
  selectSavedSessions,
  selectWorkspaceAttentionKey,
  useApp,
  type RowStatus,
} from '@/state/store';
import { SessionDot } from '@/components/sidebar/SessionDot';
import { useT } from '@/i18n/useT';
import { checkWorkspace, chooseWorkspaceDirectory } from '@/runtime/tauri';
import { Logo } from '@/components/ui/Logo';
import { EmptyState, Tip } from '@/components/ui/kit';
import { baseName, formatRelative, samePath } from '@/utils/format';

/**
 * The left sidebar: **workspace management and session management**.
 *
 * Two sections, in that order, because that is the order of the decision: where
 * the runtime works, then which conversation inside it.
 *
 * Where each fact comes from matters here, and the two halves differ:
 *
 *   - **Workspaces.** The protocol has no workspace list, and it could not
 *     usefully carry one: a workspace *is* the child's working directory, so
 *     changing it is a different process, not a message (§3.2 of the design).
 *     So the list of places is a **front-end preference** (`store.workspaces`),
 *     while "where the runtime actually is" is a **runtime fact**
 *     (`session.workspace`, from `init`). A row is marked current by comparing
 *     the two; a bookmark the runtime is not in is simply not current.
 *   - **Sessions.** Entirely the runtime's: `sessions.items` answers
 *     `session_list`, and `session_load` is what replaces the transcript. This
 *     view never reads a session file and never counts anything itself —
 *     `messages`, `steps`, `todos` and `preview` are all computed by the runtime.
 *
 * What is deliberately **not** here: sign-in, and a plugin market. Neither
 * exists behind this window — there is no account to sign in to and the runtime
 * has no plugin registry; its extensibility is MCP servers and skills, both of
 * which are already the right sidebar's business. Drawing either one would be a
 * control for something that cannot happen.
 */
export function WorkspaceSidebar() {
  const t = useT();
  const workspaces = useApp((s) => s.workspaces);
  // "Where am I" is answered by the session on screen: with several open there
  // is no single workspace for the window, and this rail's first row names the
  // one the transcript below belongs to.
  const rt = useApp(activeRuntime);
  // The session list is the **workspace's**, so it is read from the store's
  // window-level record keyed by the workspace on screen — not from the focused
  // child's bucket. Reading it per child is what made the list appear to change
  // when the person clicked another row: `focusSession` sends nothing, so the
  // rail simply switched to another child's frozen copy of the same files.
  //
  // The selector returns either the stored entry or the shared empty constant,
  // so its identity only changes when the list actually does.
  const savedSessions = useApp((s) => selectSavedSessions(s, activeWorkspaceOf(s)));
  // Whether there is a child to talk to at all. Both workspace capabilities
  // need one: a terminal belongs to a workspace the runtime is *in*, and a file
  // listing is answered by that child against that child's boundary. With no
  // session there is nothing to ask, so the two affordances are disabled rather
  // than offered and then refused.
  const hasSession = rt !== null && rt.ready;
  const currentWorkspace = rt?.session?.workspace ?? rt?.workspace ?? '';
  const currentSessionId = rt?.session?.id ?? null;
  /**
   * Whether any session in this workspace has a live child.
   *
   * **Not `hasSession`.** That asks "is the session on screen ready", which is
   * the right gate for Files and Terminal — both act on the conversation you are
   * looking at. The board is about all of them, so it must still open in the one
   * case the other two cannot: the session on screen is the one whose child
   * failed, and the others are running fine. What it actually needs is a child to
   * answer `session_list` for this workspace, and this is that question asked of
   * the whole workspace rather than of the focused bucket.
   *
   * A child whose own workspace is not known yet (`init` has not landed) counts
   * as live: it is in the store because this end just started it, and refusing
   * the board until the handshake arrives would be a button that is dead for the
   * first second of every session.
   */
  const hasLiveChild = useApp((s) =>
    s.order.some((key) => {
      const bucket = s.sessions[key];
      if (!bucket) return false;
      const own = bucket.session?.workspace ?? bucket.workspace;
      if (currentWorkspace === '' || own === '') return true;
      return samePath(own, currentWorkspace);
    }),
  );

  const enterWorkspace = useApp((s) => s.enterWorkspace);
  const addWorkspace = useApp((s) => s.addWorkspace);
  const removeWorkspace = useApp((s) => s.removeWorkspace);
  const openSession = useApp((s) => s.openSession);
  // Focusing a session that is already open sends **nothing** — it only decides
  // which transcript is drawn. That is why a row in the "open now" group below is
  // a plain `focusSession` rather than an `openSession`: its child already exists.
  const focusSession = useApp((s) => s.focusSession);
  const activeKey = useApp((s) => s.activeKey);
  const requestSessionList = useApp((s) => s.requestSessionList);
  const deleteSession = useApp((s) => s.deleteSession);
  // The session list folds on its own; the workspace list above it does not
  // follow, because "where am I" must survive folding the conversation list.
  const sessionsCollapsed = useApp((s) => s.sessionsCollapsed);
  const toggleSessionsCollapsed = useApp((s) => s.toggleSessionsCollapsed);
  // The **left** rail's setter. This button used to call `setSidebarVisible`,
  // which is the right-hand rail's — so hiding the workspace list hid the goal /
  // tasks / skills / jobs / MCP rail instead and left this one on screen. The two
  // rails are deliberately separate preferences (`store.ts`), and this is exactly
  // the mistake that separation is there to make impossible.
  const setLeftbarVisible = useApp((s) => s.setLeftbarVisible);
  // The settings panel. It lives at the foot of this rail because what it holds
  // is the same kind of decision as the workspace above it — what the runtime
  // process *is* — rather than a per-turn control like the status bar's.
  const openPanel = useApp((s) => s.openPanel);
  // The session board is a **view**, not a panel (`store.boardOpen`), so it is
  // reached through its own action rather than `openPanel`.
  const setBoardOpen = useApp((s) => s.setBoardOpen);

  /**
   * The status of every live session, keyed by the runtime's own session id.
   *
   * A `Map` built from a compact string, for the same reason the selector
   * returns a string: the saved list is keyed by id and the store is keyed by
   * child key, and rebuilding the map on every render of this rail is fine — the
   * *string* is what decides whether there is a render at all.
   */
  const statusKey = useApp(selectRowStatusKey);
  const statusBySessionId = useMemo(() => {
    const out = new Map<string, RowStatus>();
    for (const part of statusKey.split(',')) {
      if (part === '') continue;
      const at = part.lastIndexOf(':');
      out.set(part.slice(0, at), part.slice(at + 1) as RowStatus);
    }
    return out;
  }, [statusKey]);

  /**
   * How many sessions in each workspace want attention.
   *
   * This is the session dot's answer at a coarser grain, and it exists because
   * of what a dot cannot say: **a dot in a workspace you are not looking at.**
   * Somebody working in B has no way to notice that A finished something, or is
   * waiting on an approval — the session rows for A are not even on screen.
   */
  const attentionKey = useApp(selectWorkspaceAttentionKey);
  const attentionByWorkspace = useMemo(() => {
    const out = new Map<string, number>();
    if (attentionKey === '') return out;
    for (const part of attentionKey.split('\u0001')) {
      const at = part.lastIndexOf('\u0000');
      out.set(part.slice(0, at), Number(part.slice(at + 1)));
    }
    return out;
  }, [attentionKey]);

  /**
   * The sessions that are **open and not on disk yet**, in rail order.
   *
   * The rail's list comes from `sessions.items`, which the runtime builds by
   * reading session files — and a conversation that has not run a turn has no
   * file. So without this, a new session appears in **no list at all**: measured
   * on the release build, pressing "New session" from the first screen left the
   * transcript, the four recent-session slots and every rail row byte-identical,
   * with only the session bar's id moving. A press with no visible result gets
   * pressed again, which is how one workspace accumulated four children in
   * sixteen seconds.
   *
   * Drawn as its own group rather than merged into the saved list, because the
   * two are different facts: the runtime is the authority on what is *saved*,
   * and this end is the authority on what is *open*. A conversation in both is
   * drawn once, from the saved list, which carries its message count and preview.
   */
  const liveKey = useApp((s) => selectLiveOnlyKey(s, currentWorkspace));
  const liveOnly = useMemo(() => {
    const out: { key: string; id: string; status: RowStatus }[] = [];
    if (liveKey === '') return out;
    for (const part of liveKey.split('\u0001')) {
      const [key, id, status] = part.split('\u0000');
      if (!key) continue;
      out.push({ key, id, status: (status ?? 'idle') as RowStatus });
    }
    return out;
  }, [liveKey]);

  /** Why the last workspace that was offered could not be taken. Local: nothing
   *  about it reached the runtime, and it is a statement about this list. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The session row whose delete button is armed. One press arms it, a second
   *  press within the row confirms; anything else disarms. Delete is
   *  irreversible, so a single misclick must not be enough. */
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  // A blocking modal is blocking. Switching a session abandons every pending
  // request the runtime is holding (`server.go: switchSession` →
  // `pending.abandonAll()`), so an approval prompt that is on screen would be
  // lost — and the runtime waits on that id forever. The same goes for
  // restarting the child under a prompt. So every action here is inert while one
  // is up, exactly as the global keys are.
  //
  // **`railBlocked` rather than `modal !== null`, and that is a fix rather than a
  // tidy-up.** Every panel is a Radix dialog, and Radix puts
  // `pointer-events: none` on `body` while one is open — inherited, so the whole
  // rail inherits it and the browser stops delivering clicks to it. Testing
  // `modal` alone left every control here looking available and behaving dead
  // whenever a panel was up, which is one of the two ways "New session" was
  // reported as a button that does nothing. See `railBlocked`.
  const blocked = useApp(railBlocked);
  const boardOpen = useApp((s) => s.boardOpen);
  /**
   * The two actions the session board forbids: **creating and destroying a
   * session.**
   *
   * The board is not a modal, so the rail stays usable while it is up — switching
   * workspace and switching session are allowed, because they send nothing and
   * disturb no pending request. What the board does forbid is the pair that
   * changes *which conversations exist*: starting one, or erasing one. The board
   * is a statement about the set of sessions, and a control that adds to or
   * subtracts from that set under it is the same shape of problem a blocking
   * modal has — the screen's subject is being edited out from under it.
   *
   * Read separately from `blocked` rather than folded into it, because folding
   * would also disable the row buttons, and those are exactly what §3.4 keeps
   * alive. A control that is enabled must be genuinely usable and one that is
   * disabled must say why; the two conditions are different questions.
   */
  const blockedByBoard = blocked || boardOpen;

  async function onAdd() {
    if (blocked) return;
    const picked = await chooseWorkspaceDirectory();
    if (picked === null) return;
    // Checked before it becomes a row. The runtime refuses home, a volume root
    // and an ancestor of home, and it refuses by exiting with code 2 after
    // writing to a stderr nobody reads — so without this the row would look
    // perfectly usable and pressing it would replace the screen with a start-up
    // failure.
    const problem = await checkWorkspace(picked);
    if (problem !== null) {
      setRefusal(problem);
      return;
    }
    setRefusal(null);
    addWorkspace(picked);
  }

  // The current workspace is always a row, bookmarked or not: "where am I" is
  // the first question this sidebar answers, and a list of places that omits the
  // one place you are in is answering a different one.
  const rows = currentWorkspace !== '' && !workspaces.some((p) => samePath(p, currentWorkspace))
    ? [currentWorkspace, ...workspaces]
    : workspaces;

  return (
    <aside className="app-leftbar" aria-label={t('lb.workspaces')}>
      <div className="lb-head">
        <Logo size={20} title={t('app.name')} />
        <span className="lb-brand">{t('app.name')}</span>
        <Tip label={t('lb.collapse')}>
          <button
            type="button"
            className="lb-icon"
            aria-label={t('lb.collapse')}
            onClick={() => setLeftbarVisible(false)}
          >
            <PanelLeftClose size={15} />
          </button>
        </Tip>
      </div>

      <div className="lb-new">
        <Tip label={t('lb.newSessionHint')}>
          <button
            type="button"
            className="btn btn-outline btn-block"
            disabled={blockedByBoard}
            onClick={() => void openSession(null)}
          >
            <Plus size={13} />
            {t('lb.newSession')}
          </button>
        </Tip>
      </div>

      <div className="lb-scroll scroll">
        {/* ---------------- workspaces ---------------- */}
        <section className="lb-section">
          <div className="lb-section-head">
            <span className="lb-title">{t('lb.workspaces')}</span>
            <Tip label={t('lb.addWorkspace')}>
              <button
                type="button"
                className="lb-icon"
                aria-label={t('lb.addWorkspace')}
                disabled={blocked}
                onClick={() => void onAdd()}
              >
                <FolderPlus size={14} />
              </button>
            </Tip>
          </div>

          {refusal !== null ? (
            <div className="lb-refusal" role="alert">
              <span className="lb-refusal-text">{refusal}</span>
              <button
                type="button"
                className="lb-icon"
                aria-label={t('common.close')}
                onClick={() => setRefusal(null)}
              >
                <X size={12} />
              </button>
            </div>
          ) : null}

          {rows.length === 0 ? (
            <>
              <EmptyState
                compact
                title={t('lb.emptyWorkspaces.title')}
                hint={t('lb.emptyWorkspaces.hint')}
              />
              {/* **A named button, not only the icon in the section head.**
                  With no workspace listed this rail has exactly one useful
                  control, and it used to be a bare `FolderPlus` glyph with no
                  label — while the first screen's notice said "choose one below,
                  or add a directory" over a list that was empty. That is a screen
                  whose only way forward is a small icon nobody was told to look
                  for. */}
              <button
                type="button"
                className="btn btn-outline btn-block lb-empty-add"
                disabled={blocked}
                onClick={() => void onAdd()}
              >
                <FolderPlus size={13} />
                {t('lb.addWorkspace')}
              </button>
            </>
          ) : (
            <div className="lb-rows">
              {rows.map((path) => {
                const isCurrent = currentWorkspace !== '' && samePath(currentWorkspace, path);
                const bookmarked = workspaces.some((p) => samePath(p, path));
                const attention = attentionByWorkspace.get(path) ?? 0;
                return (
                  <div
                    key={path}
                    className={`lb-row${isCurrent ? ' is-current' : ''}`}
                    title={path}
                  >
                    <Folder size={13} className="lb-row-icon" />
                    <button
                      type="button"
                      className="lb-row-main"
                      disabled={blocked || isCurrent}
                      aria-current={isCurrent ? 'true' : undefined}
                      onClick={() => void enterWorkspace(path)}
                    >
                      <span className="lb-row-name">{baseName(path)}</span>
                      {/* The count of sessions in this workspace that want a
                          person — asking, broken, or finished and unlooked-at.
                          It is the session dots' answer at a coarser grain, and
                          it exists for what a dot cannot do: a dot in a
                          workspace nobody is looking at is invisible, which is
                          exactly the case with two workspaces open. Running
                          sessions are deliberately excluded: they need nothing. */}
                      {attention > 0 ? (
                        <span
                          className="lb-attention"
                          role="img"
                          aria-label={t('lb.attention', { n: attention })}
                          title={t('lb.attention', { n: attention })}
                        >
                          {attention}
                        </span>
                      ) : null}
                      {isCurrent ? (
                        <span className="lb-current" title={t('lb.currentHint')}>
                          {t('lb.current')}
                        </span>
                      ) : null}
                    </button>
                    {bookmarked && !isCurrent ? (
                      <Tip label={t('lb.forgetHint')}>
                        <button
                          type="button"
                          className="lb-icon lb-row-action"
                          aria-label={t('lb.forget')}
                          disabled={blocked}
                          onClick={() => removeWorkspace(path)}
                        >
                          <X size={12} />
                        </button>
                      </Tip>
                    ) : !bookmarked ? (
                      // The directory the app happened to start in is a real
                      // workspace but not yet a place in the list; one press
                      // makes it one.
                      <Tip label={t('lb.addWorkspace')}>
                        <button
                          type="button"
                          className="lb-icon lb-row-action"
                          aria-label={t('lb.addWorkspace')}
                          disabled={blocked}
                          onClick={() => addWorkspace(path)}
                        >
                          <Plus size={12} />
                        </button>
                      </Tip>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ---------------- sessions ---------------- */}
        <section className="lb-section">
          <div className="lb-section-head">
            <button
              type="button"
              className="lb-section-toggle"
              aria-expanded={!sessionsCollapsed}
              onClick={toggleSessionsCollapsed}
            >
              <ChevronRight size={13} className={`caret${sessionsCollapsed ? '' : ' caret-open'}`} />
              <span className="lb-title">{t('lb.sessions')}</span>
              <span className="sr-only">
                {sessionsCollapsed ? t('lb.unfoldSessions') : t('lb.foldSessions')}
              </span>
            </button>
            <Tip label={t('lb.refreshSessions')}>
              <button
                type="button"
                className="lb-icon"
                aria-label={t('lb.refreshSessions')}
                disabled={blocked}
                onClick={requestSessionList}
              >
                <RefreshCw size={13} />
              </button>
            </Tip>
          </div>

          {/* Folded like the right rail's blocks: kept mounted, only the height
              changes, and `inert` keeps Tab out of what nobody can see. The list
              is not dismounted on fold, so folding never re-reads anything. */}
          <div
            className={`collapse${sessionsCollapsed ? ' is-collapsed' : ''}`}
            inert={sessionsCollapsed}
          >
            <div>
              {/* **The group that made "New session" look dead.**
                  A conversation that has been opened but has not run a turn has
                  no file on disk, and the runtime's `sessions.items` is built by
                  reading those files — so it used to appear in no list at all,
                  and pressing the button changed nothing a person could see. It
                  is drawn **above** the saved list because it is what is
                  happening now, and it is a separate group because "open" and
                  "saved" are two different facts: the runtime owns the second,
                  this end owns the first.

                  What is in here is therefore a conversation with something in
                  it and no file yet — a turn that has not been written down, a
                  draft, a shell. A session that never became one at all is
                  **closed** when the screen moves off it rather than listed
                  (`isUntouchedSession`), which is what keeps the session a launch
                  opens from sitting here for the life of the window.

                  No delete button: there is no file to delete, and closing a
                  conversation is `detachSession`, which is a different act from
                  erasing one. The row is still a way to switch to it, which is
                  what makes a second and third session reachable at all. */}
              {liveOnly.length > 0 ? (
                <div className="lb-rows lb-live-rows">
                  {liveOnly.map((row) => {
                    const isCurrent = row.key === activeKey;
                    return (
                      <div key={row.key} className="lb-session-wrap">
                        <button
                          type="button"
                          className={`lb-session${isCurrent ? ' is-current' : ''}`}
                          disabled={blocked || isCurrent}
                          aria-current={isCurrent ? 'true' : undefined}
                          onClick={() => focusSession(row.key)}
                        >
                          <span className="lb-session-top">
                            <SessionDot status={row.status} />
                            {/* The id is the runtime's own, so it is the same name
                                the row will carry once the session is saved. Until
                                `init` lands there is no id yet, and the honest
                                label for that moment is the runtime's, not an
                                invented one. */}
                            <span className="lb-session-id">
                              {row.id !== '' ? row.id : t('lb.sessionPending')}
                            </span>
                            <span className="lb-session-time">{t('lb.unsaved')}</span>
                          </span>
                          <span className="lb-session-meta">{t('lb.sessionOpen')}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {!savedSessions.listed ? (
                <div className="lb-note">{t('common.loading')}</div>
              ) : savedSessions.active.length === 0 ? (
                // Only when there is nothing open either: with a live row above,
                // "no past session" is a statement about files and the screen
                // already has a conversation on it.
                liveOnly.length > 0 ? null : (
                  <EmptyState
                    compact
                    title={t('lb.emptySessions.title')}
                    hint={t('lb.emptySessions.hint')}
                  />
                )
              ) : (
                <div className="lb-rows">
                  {savedSessions.active.map((item) => {
                    const isCurrent = item.id === currentSessionId;
                    const armed = armedDelete === item.id;
                    return (
                      <div key={item.id} className="lb-session-wrap">
                        <button
                          type="button"
                          className={`lb-session${isCurrent ? ' is-current' : ''}`}
                          disabled={blocked || isCurrent}
                          aria-current={isCurrent ? 'true' : undefined}
                          onClick={() => void openSession(item.id)}
                        >
                          <span className="lb-session-top">
                            {/* The dot is **leftmost**, not on the right: the
                                right edge of this row holds the delete button,
                                and a status mark sharing a corner with a
                                destructive control is one misread away from
                                deleting a conversation. The left is free — a
                                session row carries no icon, unlike a workspace
                                row. */}
                            <SessionDot status={statusBySessionId.get(item.id) ?? 'idle'} />
                            {/* The first line is the **topic** — the runtime's preview
                                of the first user message — because that is what a
                                person recognizes a conversation by. The id is a
                                timestamp (`YYYYMMDD-HHMMSS`), so a list led by ids is
                                a column of twelve-digit numbers that all look alike;
                                it moved to the row's last line instead. An empty
                                preview means the session never spoke, and then this
                                line is only the dot.

                                The topic owns this whole line: the time used to ride
                                its right edge, and that cost the preview a fixed ~40px
                                on each of the two lines it is clamped to — the topic
                                is the row's longest text and the only one that scales
                                with the message it came from. */}
                            <span className="lb-session-preview">{item.preview}</span>
                          </span>
                          {/* Both computed by the runtime. `todos` is ready-made
                              progress text, and an empty string means there is no task
                              list — not zero of something. */}
                          <span className="lb-session-meta">
                            {t('panel.resume.messages', { n: item.messages })}
                            {' · '}
                            {t('panel.resume.steps', { n: item.steps })}
                            {item.todos ? ` · ${item.todos}` : ''}
                          </span>
                          {/* The id, last and faintest. It is still the runtime's own
                              name for this conversation and the thing a person types
                              at `/resume`, so it stays on the row — just not in front
                              of the topic. The time rides this line rather than the
                              topic's: the two are the same kind of fact — the
                              runtime's name for the conversation and when it was last
                              touched — while the topic above is prose and is the only
                              line here that wants every column it can get.

                              `modified_at` is epoch **seconds**; null means the file
                              could not be read, and then there is no time to show. */}
                          <span className="lb-session-foot">
                            <span className="lb-session-id">{item.id}</span>
                            <span className="lb-session-time">
                              {item.modifiedAt === null
                                ? t('common.unknown')
                                : formatRelative(item.modifiedAt * 1000)}
                            </span>
                          </span>
                        </button>
                        {/* Delete the file, not the row: the runtime waits for the
                            running turn, then re-sends the list. No optimistic
                            removal — the row goes when the runtime says so. Two
                            presses, because a delete cannot be undone. */}
                        <Tip label={armed ? t('lb.deleteConfirm') : t('lb.deleteSession')}>
                          <button
                            type="button"
                            className={`lb-icon lb-row-action${armed ? ' is-armed' : ''}`}
                            aria-label={
                              armed ? t('lb.deleteConfirm') : t('lb.deleteSession')
                            }
                            disabled={blockedByBoard}
                            onClick={() => {
                              if (armed) {
                                setArmedDelete(null);
                                deleteSession(item.id);
                              } else {
                                setArmedDelete(item.id);
                              }
                            }}
                            onMouseLeave={() => {
                              if (armedDelete === item.id) setArmedDelete(null);
                            }}
                          >
                            {armed ? <X size={12} /> : <Trash2 size={12} />}
                          </button>
                        </Tip>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* The settings affordance, at the foot of the rail rather than in the
          command palette. Two reasons, and the second is the load-bearing one:
          it sits next to the workspace list because what it holds is the same
          kind of decision (what the runtime process is), and the workspace's own
          two capabilities sit beside it for the same reason — where the runtime
          works is one decision, and what it can do there is the next. */}
      <div className="lb-foot">
        {/* Files and Terminal. The design's left rail lists exactly these three
            (§20: Chat / Files / Terminal), and this build's "Chat" is the
            transcript that is already the main view — so these two rows are the
            two ways **out** of it. Both are disabled with no session: a terminal
            belongs to a workspace the runtime is in, so with no child there is
            no workspace to open one in, and a button that could only produce a
            refusal would be worse than one that is plainly unavailable. */}
        <Tip label={t('cmd.files.desc')}>
          <button
            type="button"
            className="lb-foot-btn"
            disabled={blocked || !hasSession}
            onClick={() => openPanel('files')}
          >
            <FileText size={14} />
            <span>{t('panel.files.title')}</span>
          </button>
        </Tip>
        <Tip label={t('cmd.terminal.desc')}>
          <button
            type="button"
            className="lb-foot-btn"
            disabled={blocked || !hasSession}
            onClick={() => openPanel('terminal')}
          >
            <SquareTerminal size={14} />
            <span>{t('panel.term.title')}</span>
          </button>
        </Tip>
        {/* The session board. It sits with the other two because it is the same
            kind of thing — a way *out* of the transcript — but its gate is
            deliberately **not** `hasSession`, which is what Files and Terminal
            use. Those two key off "the session on screen is ready"; the board is
            about the whole workspace, so it must open in exactly the case they
            cannot: when the session on screen was the one that failed to start
            and the others are running fine. What it needs instead is **some live
            child in this workspace** to answer for the list. */}
        <Tip label={t('board.openHint')}>
          <button
            type="button"
            className={`lb-foot-btn${boardOpen ? ' is-active' : ''}`}
            disabled={blocked || (!hasLiveChild && !boardOpen)}
            aria-pressed={boardOpen}
            onClick={() => setBoardOpen(!boardOpen)}
          >
            <LayoutGrid size={14} />
            <span>{t('board.title')}</span>
          </button>
        </Tip>
        <Tip label={t('lb.settings')}>
          <button
            type="button"
            className="lb-foot-btn"
            disabled={blocked}
            onClick={() => openPanel('settings')}
          >
            <Settings size={14} />
            <span>{t('lb.settings')}</span>
          </button>
        </Tip>
      </div>
    </aside>
  );
}
