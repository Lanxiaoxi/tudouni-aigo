import { useState } from 'react';
import { FolderPlus, Folder, PanelLeftClose, Plus, RefreshCw, X } from 'lucide-react';
import { useApp } from '@/state/store';
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
  const currentWorkspace = useApp((s) => s.session?.workspace ?? '');
  const sessionList = useApp((s) => s.sessionList);
  const listed = useApp((s) => s.listedSessions);
  const currentSessionId = useApp((s) => s.session?.id ?? null);
  const modal = useApp((s) => s.modal);

  const enterWorkspace = useApp((s) => s.enterWorkspace);
  const addWorkspace = useApp((s) => s.addWorkspace);
  const removeWorkspace = useApp((s) => s.removeWorkspace);
  const switchSession = useApp((s) => s.switchSession);
  const requestSessionList = useApp((s) => s.requestSessionList);
  const setSidebarVisible = useApp((s) => s.setSidebarVisible);

  /** Why the last workspace that was offered could not be taken. Local: nothing
   *  about it reached the runtime, and it is a statement about this list. */
  const [refusal, setRefusal] = useState<string | null>(null);

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
            onClick={() => setSidebarVisible(false)}
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
            onClick={() => switchSession(null)}
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
            <span className="lb-title">{t('lb.sessions')}</span>
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
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`lb-session${isCurrent ? ' is-current' : ''}`}
                    disabled={blocked || isCurrent}
                    aria-current={isCurrent ? 'true' : undefined}
                    onClick={() => switchSession(item.id)}
                  >
                    <span className="lb-session-top">
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
                );
              })}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
