import { useMemo, useState } from 'react';
import { ChevronRight, FolderPlus, Folder, PanelLeftClose, Plus, RefreshCw, Settings, Trash2, X } from 'lucide-react';
import {
  activeRuntime,
  NO_SESSION_LIST,
  selectRowStatusKey,
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
  const currentWorkspace = rt?.session?.workspace ?? rt?.workspace ?? '';
  const sessionList = rt?.sessionList ?? NO_SESSION_LIST;
  const listed = rt?.listedSessions ?? false;
  const currentSessionId = rt?.session?.id ?? null;
  const modal = useApp((s) => s.modal);

  const enterWorkspace = useApp((s) => s.enterWorkspace);
  const addWorkspace = useApp((s) => s.addWorkspace);
  const removeWorkspace = useApp((s) => s.removeWorkspace);
  const openSession = useApp((s) => s.openSession);
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
  const blocked = modal !== null;

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
            disabled={blocked}
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
            <EmptyState
              compact
              title={t('lb.emptyWorkspaces.title')}
              hint={t('lb.emptyWorkspaces.hint')}
            />
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
              {!listed ? (
                <div className="lb-note">{t('common.loading')}</div>
              ) : sessionList.length === 0 ? (
                <EmptyState
                  compact
                  title={t('lb.emptySessions.title')}
                  hint={t('lb.emptySessions.hint')}
                />
              ) : (
                <div className="lb-rows">
                  {sessionList.map((item) => {
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
                            <span className="lb-session-id">{item.id}</span>
                            {/* `modified_at` is epoch **seconds**; null means the file
                                could not be read, and then there is no time to show. */}
                            <span className="lb-session-time">
                              {item.modifiedAt === null
                                ? t('common.unknown')
                                : formatRelative(item.modifiedAt * 1000)}
                            </span>
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
                          <span className="lb-session-preview">{item.preview}</span>
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
                            disabled={blocked}
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
          kind of decision (what the runtime process is), and the palette's
          seventeen commands are a fixed, load-ordered set — `commands.ts`
          spells the number out and a test asserts it. Adding an eighteenth entry
          there would rewrite a sentence whose whole point is that it is exact. */}
      <div className="lb-foot">
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
