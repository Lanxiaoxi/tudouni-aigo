import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Archive, ArchiveRestore, Brain, ChevronDown, ChevronRight, Download, FileJson, FileText, FolderPlus, Folder, GraduationCap, LayoutGrid, ListChecks, MessageSquare, Plus, Search, Server, RefreshCw, Settings, SquareTerminal, Trash2, Wrench, X } from 'lucide-react';
import {
  activeRuntime,
  activeWorkspaceOf,
  railBlocked,
  selectBoardAvailable,
  selectLiveOnlyKey,
  selectLiveSessionIdsKey,
  selectRowStatusKey,
  selectSavedSessions,
  selectWorkspaceAttentionKey,
  useApp,
  type ConnectionPhase,
  type InstallStatus,
  type RowStatus,
} from '@/state/store';
import { SessionDot } from '@/components/sidebar/SessionDot';
import { useT } from '@/i18n/useT';
import { checkWorkspace, chooseWorkspaceDirectory } from '@/runtime/tauri';
import { Logo } from '@/components/ui/Logo';
import { Count, EmptyState, Tip } from '@/components/ui/kit';
import { baseName, formatRelative, samePath } from '@/utils/format';
import { AddRemoteWorkspaceModal } from '@/components/modals/AddRemoteWorkspaceModal';

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
  /**
   * The workspace the active session is actually in — but **only when it is a
   * local one**.
   *
   * A remote session's `init.workspace` is a path on the *remote* host
   * (`/home/tudouni/actions-runner`), and it is not a directory on this machine.
   * This value feeds the **local** workspace list below — the row that means
   * "open this directory on this computer" — so letting a remote path through
   * put a row in the local list that could only ever fail: pressing it called
   * `enterWorkspace('/home/tudouni/actions-runner')`, which asks the local
   * bridge for a directory that does not exist here. It also read as the current
   * workspace, so the rail showed the same place twice at once — once as a local
   * row marked current and once as the remote row it really was.
   *
   * The remote half of "where am I" is answered by `currentRemoteWorkspaceId`
   * below, which keys off the session's own entry rather than off a path — a
   * remote path is not unique across hosts.
   */
  const currentWorkspace =
    rt !== null && rt.remoteWorkspaceId !== null
      ? ''
      : rt?.session?.workspace ?? rt?.workspace ?? '';
  const currentSessionId = rt?.session?.id ?? null;
  /**
   * Whether any session in this workspace has a live child — the board's gate,
   * and **the same value the session bar's board button reads**
   * (`selectBoardAvailable`, which carries the reasoning). Two doors to one
   * view, so the question is asked in one place: a gate written twice here
   * would eventually be written twice *differently*, leaving one door open and
   * the other dead on the same screen.
   */
  const hasLiveChild = useApp(selectBoardAvailable);

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
  // The archive action, next to the rail row's delete. **The gate is the same
  // one the library's row disables by** — a session a live child of this end is
  // holding cannot be archived, because the runtime would rewrite its metadata
  // under that writer (`archiveSession` refuses it again as a backstop; the
  // button just makes the refusal visible with a tooltip instead of hidden).
  // Archive is one press against the delete's two, because it is reversible —
  // pressing it from the rail of a past workspace is the point of having it
  // there.
  //
  // The compact key, not a Set selector: `selectLiveSessionIds` builds a fresh
  // Set on every call, and that unstable snapshot is exactly what looped the
  // library into "Maximum update depth exceeded" (see its comment). The key is
  // a stable primitive; the Set is derived in `useMemo`.
  const archiveSession = useApp((s) => s.archiveSession);
  const liveIdsKey = useApp(selectLiveSessionIdsKey);
  const liveIds = useMemo(
    () => new Set(liveIdsKey === '' ? [] : liveIdsKey.split('\u0001')),
    [liveIdsKey],
  );
  // Each list folds on its own, the other never follows: "where am I" must
  // survive folding the conversation list, and the conversation list must
  // survive folding the place list.
  const sessionsCollapsed = useApp((s) => s.sessionsCollapsed);
  const toggleSessionsCollapsed = useApp((s) => s.toggleSessionsCollapsed);
  const workspacesCollapsed = useApp((s) => s.workspacesCollapsed);
  const toggleWorkspacesCollapsed = useApp((s) => s.toggleWorkspacesCollapsed);
  // The foot's own fold. The seven workbench buttons live in the fold and the
  // head below them is the toggle, so a folded foot is one icon row tall —
  // the same independent, persisted preference the two list sections keep.
  const footCollapsed = useApp((s) => s.footCollapsed);
  const toggleFootCollapsed = useApp((s) => s.toggleFootCollapsed);
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
   *
   * Scoped by the **session's own workspace**, not `currentWorkspace` above.
   * `currentWorkspace` is the local list's value: it blanks a remote path so a
   * directory on another host cannot enter the local workspace rows. The live
   * group has no such need — it only ever compares paths as strings (dedup
   * against the saved list, same-workspace filtering) — and under the blanked
   * value every guard in `selectLiveOnlyKey` switched off: the saved set read
   * back empty and the workspace filter never applied, so a remote workspace
   * drew every open conversation twice, once as "open now" and once with its
   * preview. A remote session is a member of its own (remote) workspace just as
   * a local one is of its.
   */
  const liveWorkspace = rt?.session?.workspace ?? rt?.workspace ?? '';
  const liveKey = useApp((s) => selectLiveOnlyKey(s, liveWorkspace));
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

  // ---- remote workspaces (Workspace Manager, Phase 2) ----
  const remoteWorkspaces = useApp((s) => s.remoteWorkspaces);
  const sshHosts = useApp((s) => s.sshHosts);
  const enterRemoteWorkspace = useApp((s) => s.enterRemoteWorkspace);
  const removeRemoteWorkspace = useApp((s) => s.removeRemoteWorkspace);
  // ---- remote install (Phase 3) ----
  const installStatus = useApp((s) => s.installStatus);
  const installRemoteWorkspace = useApp((s) => s.installRemoteWorkspace);
  const [addRemoteOpen, setAddRemoteOpen] = useState(false);
  // The "add workspace" menu, the section head's Plus popover: local or
  // remote. One menu rather than two buttons, because the two are the same
  // decision ("where should the next workspace come from") — and because the
  // remote list no longer has its own section, so its add button would have
  // had to live somewhere a person would not look.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  /**
   * The workbench's own filter. It is a **local** search, not the command
   * palette: it narrows the seven rows the drawer already holds, which is the
   * only thing a search field inside this drawer can honestly promise. The
   * palette's `Ctrl K` keeps its own job and its own hint elsewhere.
   */
  const [navQuery, setNavQuery] = useState('');
  // Which saved remote workspace, if any, the active session belongs to —
  // the same "where am I" question `currentWorkspace` answers for the local
  // half, read from the session's own `remoteWorkspaceId` rather than
  // compared by path (a remote path is not unique across hosts).
  const currentRemoteWorkspaceId = rt?.remoteWorkspaceId ?? null;

  /**
   * The sessions that were started as workspace-learning runs.
   *
   * **Two lookups, because the rail asks the question two ways.** A learning
   * run is keyed by the bridge's child key in the "open now" group and by the
   * runtime's session id in the saved list below it, and the two are not the
   * same string — the child key is a small integer (`1`, `2`, …) and the
   * session id is a `YYYYMMDD-HHMMSS` timestamp. A single map keyed by the
   * child key therefore answered the live rows and **never** the saved ones:
   * the badge existed in the markup, its rule existed in the stylesheet, and
   * it could not appear on the row a person actually looks at, because the
   * branch tested `sessionId` against a map whose keys are child keys.
   * `null` session ids are still excluded — a child that has not handshaked
   * has no saved row to mark yet.
   *
   * Kept as one compact subscription so the two sets are computed from a
   * single pass and cannot disagree about which sessions are learning runs.
   */
  const learningMarks = useApp((s) => {
    const keys: string[] = [];
    const ids: string[] = [];
    for (const key of s.order) {
      const bucket = s.sessions[key];
      if (bucket?.learning && bucket.sessionId !== null && bucket.sessionId !== '') {
        keys.push(key);
        ids.push(bucket.sessionId);
      }
    }
    return `${keys.join('\u0001')}\u0002${ids.join('\u0001')}`;
  });
  const { keys: learningKeys, ids: learningIds } = useMemo(() => {
    const [keyPart = '', idPart = ''] = learningMarks.split('\u0002');
    return {
      keys: new Set(keyPart === '' ? [] : keyPart.split('\u0001')),
      ids: new Set(idPart === '' ? [] : idPart.split('\u0001')),
    };
  }, [learningMarks]);

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

  async function onAddLocal() {
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

  /**
   * The workbench's seven destinations, in two groups.
   *
   * The order is the drawer's reading order — the workspace's own surfaces
   * first, then the process's settings — rather than the flat list the old foot
   * drew. Grouping is what answers "where am I" inside a menu of destinations:
   * seven equal rows with equal gaps read as seven unrelated buttons.
   *
   * Session board is drawn in the lower group, directly under Tasks, and that
   * placement is the one thing here that is not a gate: the board is a view
   * over the set of sessions rather than one of the workspace's surfaces —
   * Files, Terminal, Learn and Memory are each about *this directory and the
   * child running in it*, while the board is about the conversations at large.
   * Keeping it in the upper group made that block read as five things of one
   * kind; next to Tasks the two "what is happening" views sit together and the
   * workspace rows stay one unbroken block.
   *
   * The gates are unchanged from the row each one replaces (each is the same
   * `openPanel`/`setBoardOpen` call; the disabled reasons are the same ones the
   * old rows carried). What changed is only how they are arranged.
   */
  const navItems: {
    key: string;
    group: 'workspace' | 'settings';
    label: string;
    hint: string;
    icon: ReactNode;
    disabled: boolean;
    active?: boolean;
    run: () => void;
  }[] = [
    {
      key: 'files',
      group: 'workspace',
      label: t('panel.files.title'),
      hint: t('cmd.files.desc'),
      icon: <FileText size={14} />,
      disabled: blocked || !hasSession,
      run: () => openPanel('files'),
    },
    {
      key: 'terminal',
      group: 'workspace',
      label: t('panel.term.title'),
      hint: t('cmd.terminal.desc'),
      icon: <SquareTerminal size={14} />,
      disabled: blocked || !hasSession,
      run: () => openPanel('terminal'),
    },
    {
      key: 'learn',
      group: 'workspace',
      label: t('lb.learn'),
      hint: t('lb.learnHint'),
      icon: <GraduationCap size={14} />,
      disabled: blocked || !hasLiveChild,
      run: () => openPanel('learn'),
    },
    {
      key: 'memory',
      group: 'workspace',
      // The workspace's own surface, next to the browser and the shells — not a
      // setting. Its subject is what *this* workspace has learned, the way the
      // Learn panel's subject is what it can be taught; the settings it also
      // carries are a section **inside** the panel, not the reason it exists.
      label: t('lb.memory'),
      hint: t('lb.memoryHint'),
      icon: <Brain size={14} />,
      // A live session, not merely a workspace: the corpus lives under
      // `<workspace>/.tudouni/memory`, but the code that reads and writes it is the
      // runtime, and there is one of those per open conversation. Same gate as
      // Files and Terminal, and for the same reason.
      disabled: blocked || !hasSession,
      run: () => openPanel('memory'),
    },
    {
      key: 'tasks',
      group: 'settings',
      label: t('lb.task'),
      hint: t('lb.taskHint'),
      icon: <ListChecks size={14} />,
      disabled: blocked,
      run: () => openPanel('tasks'),
    },
    {
      key: 'board',
      // The lower group, next to Tasks — see the note above `navItems` for why
      // this row left the workspace's own four. Only the grouping moved; the
      // gate below is the one it always had.
      group: 'settings',
      label: t('board.title'),
      hint: t('board.openHint'),
      icon: <LayoutGrid size={14} />,
      // The board's gate is the workspace's, not the session's — the same
      // selector the session bar's second door reads (see `SessionBar`).
      disabled: blocked || (!hasLiveChild && !boardOpen),
      active: boardOpen,
      run: () => setBoardOpen(!boardOpen),
    },
    {
      key: 'config',
      group: 'settings',
      label: t('lb.config'),
      hint: t('lb.configHint'),
      icon: <FileJson size={14} />,
      // `blocked` alone, never `hasSession`: configuration is what a child
      // reads at open, so the person who needs it most has no session yet.
      disabled: blocked,
      run: () => openPanel('config'),
    },
    {
      key: 'settings',
      group: 'settings',
      label: t('lb.settings'),
      hint: t('lb.settings'),
      icon: <Settings size={14} />,
      disabled: blocked,
      run: () => openPanel('settings'),
    },
  ];
  const navOrder = new Map(navItems.map((item, index) => [item.key, index]));
  const navFilter = navQuery.trim().toLowerCase();
  const navVisible =
    navFilter === ''
      ? navItems
      : navItems.filter((item) => item.label.toLowerCase().includes(navFilter));
  const navGroups = [
    {
      key: 'workspace' as const,
      label: t('lb.workbench.groupWorkspace'),
      items: navVisible.filter((item) => item.group === 'workspace'),
    },
    {
      key: 'settings' as const,
      label: t('lb.workbench.groupTasks'),
      items: navVisible.filter((item) => item.group === 'settings'),
    },
  ].filter((group) => group.items.length > 0);

  return (
    <aside className="app-leftbar" aria-label={t('lb.workspaces')}>
      <div className="lb-head">
        <Logo size={28} title={t('app.name')} />
        <span className="lb-brand">{t('app.name')}</span>
      </div>

      <div className="lb-new">
        <Tip label={t('lb.newSessionHint')}>
          <button
            type="button"
            className="lb-new-btn"
            disabled={blockedByBoard}
            onClick={() => void openSession(null)}
          >
            <Plus size={15} />
            {t('lb.newSession')}
          </button>
        </Tip>
      </div>

      <div className="lb-scroll scroll">
        {/* ---------------- workspaces ---------------- */}
        <section className="lb-section">
          {/* The session list's fold, applied to the workspace list: the head
              is the toggle, the add button stays in the head so it survives
              the fold — a folded list that loses its only way to grow is a
              dead end. */}
          <div className="lb-section-head">
            <button
              type="button"
              className="lb-section-toggle"
              aria-expanded={!workspacesCollapsed}
              onClick={toggleWorkspacesCollapsed}
            >
              <ChevronRight size={13} className={`caret${workspacesCollapsed ? '' : ' caret-open'}`} />
              <span className="lb-title">{t('lb.workspaces')}</span>
              <span className="sr-only">
                {workspacesCollapsed ? t('lb.unfoldWorkspaces') : t('lb.foldWorkspaces')}
              </span>
            </button>
            <AddWorkspaceMenu
              menuOpen={addMenuOpen}
              onMenuOpenChange={setAddMenuOpen}
              disabled={blocked}
              onLocal={() => void onAddLocal()}
              onRemote={() => setAddRemoteOpen(true)}
            />
          </div>

          {/* The fold. Its content is wrapped in one element (`.lb-fold-inner`)
              so the directional drift below can animate a single child — a
              grid cell animates as a whole, its direct children do not. */}
          <div
            className={`collapse${workspacesCollapsed ? ' is-collapsed' : ''}`}
            inert={workspacesCollapsed}
          >
          <div className="lb-fold-inner">
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

          {rows.length === 0 && remoteWorkspaces.length === 0 ? (
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
                  for. It opens the same local/remote menu as the head's Plus:
                  an empty list has no reason to presume a local directory. */}
              <button
                type="button"
                className="btn btn-outline btn-block lb-empty-add"
                disabled={blocked}
                onClick={() => setAddMenuOpen(true)}
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
              {/* Remote rows, merged into the same list: a remote workspace is
                  the same kind of "where to work" entry as a local one, so it
                  belongs here rather than in a separate section. The `Server`
                  icon and a "Remote" tag on the row are the only visual
                  differences. */}
              {remoteWorkspaces.map((entry) => {
                const host = sshHosts.find((h) => h.id === entry.hostId);
                const isCurrent = currentRemoteWorkspaceId === entry.id;
                // The live session's own connection state, when this is the row
                // on screen — §5.1 of the design: connection state belongs to
                // the session, not to the saved entry, so a *bookmark* that is
                // not currently open has no phase to show at all.
                const connection = isCurrent ? rt?.connection ?? null : null;
                const install = installStatus[entry.id] ?? null;
                const installing = install !== null && install.stage !== 'done';
                return (
                  <div
                    key={entry.id}
                    className={`lb-row${isCurrent ? ' is-current' : ''}`}
                    title={host ? `${host.user}@${host.host}:${host.port} — ${entry.remotePath}` : entry.remotePath}
                  >
                    <Server size={13} className="lb-row-icon" />
                    <button
                      type="button"
                      className="lb-row-main"
                      disabled={blocked || isCurrent}
                      aria-current={isCurrent ? 'true' : undefined}
                      onClick={() => void enterRemoteWorkspace(entry.id)}
                    >
                      <span className="lb-row-name">{entry.label}</span>
                      {/* The "Remote" tag: the small, quiet marker that tells
                          a remote row apart from a local one without taking
                          the row off the card surface — the row already has a
                          `Server` icon for the same purpose, the tag is the
                          *readable* half of that signal. */}
                      <span className="lb-remote-tag">{t('lb.workspaceKind.remote')}</span>
                      {/* The readable half of "not installed yet", said where
                          the name is read — the always-visible install button
                          at the row's end is the action for it. Gone the
                          moment an install has succeeded and written the path
                          back to the entry. */}
                      {entry.remoteBinary.trim() === '' ? (
                        <span className="lb-not-installed-tag" title={t('lb.remote.notInstalledHint')}>
                          {t('lb.remote.notInstalled')}
                        </span>
                      ) : null}
                      {connection !== null && connection.phase !== 'local' ? (
                        <ConnectionBadge phase={connection.phase} problem={connection.problem} />
                      ) : install !== null ? (
                        <InstallBadge status={install} />
                      ) : null}
                      {isCurrent ? (
                        <span className="lb-current" title={t('lb.currentHint')}>
                          {t('lb.current')}
                        </span>
                      ) : null}
                    </button>
                    {/* Always visible while the row has no binary path: a
                        hover-only affordance is how the install feature got
                        lost — a merged list row that looks like every other
                        row does not advertise a hidden button. Once an install
                        has written a path back, it returns to the hover-only
                        rule the rest of the list uses. */}
                    <Tip label={t('lb.remote.install')}>
                      <button
                        type="button"
                        className={`lb-icon lb-row-action${entry.remoteBinary.trim() === '' ? ' is-always-visible' : ''}`}
                        aria-label={t('lb.remote.install')}
                        disabled={blocked || isCurrent || installing}
                        onClick={() => void installRemoteWorkspace(entry.id)}
                      >
                        <Download size={12} />
                      </button>
                    </Tip>
                    {!isCurrent ? (
                      <Tip label={t('lb.forgetHint')}>
                        <button
                          type="button"
                          className="lb-icon lb-row-action"
                          aria-label={t('lb.forget')}
                          disabled={blocked}
                          onClick={() => removeRemoteWorkspace(entry.id)}
                        >
                          <X size={12} />
                        </button>
                      </Tip>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          </div>
        </div>
        </section>

        {/* Outside the fold on purpose: a dialog mounted conditionally inside a
            folded region would be unmounted while it is open. */}
        <AddRemoteWorkspaceModal open={addRemoteOpen} onOpenChange={setAddRemoteOpen} />

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
            <div className="lb-fold-inner">
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
                            <span className="lb-session-preview">
                              {row.id !== '' ? row.id : t('lb.sessionPending')}
                            </span>
                            <span className="lb-session-time">{t('lb.unsaved')}</span>
                          </span>
                          <span className="lb-session-meta">
                            {t('lb.sessionOpen')}
                            {learningKeys.has(row.key) ? (
                              <span className="lb-session-learning" title={t('lb.sessionLearningHint')}>
                                {t('lb.sessionLearning')}
                              </span>
                            ) : null}
                          </span>
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
                  /* The design's empty state: a quiet panel that says what is
                     missing and puts the way forward *inside* it. The old one
                     was two lines of text and left "New session" at the top of
                     the rail, away from the section it fills. */
                  <div className="lb-empty-sessions">
                    <MessageSquare size={18} className="lbes-icon" aria-hidden />
                    <div className="lbes-title">{t('lb.emptySessions.title')}</div>
                    <div className="lbes-hint">{t('lb.emptySessions.hint')}</div>
                    <button
                      type="button"
                      className="lbes-action"
                      disabled={blockedByBoard}
                      onClick={() => void openSession(null)}
                    >
                      <Plus size={12} />
                      {t('lb.newSession')}
                    </button>
                  </div>
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
                          // The runtime's own name for the conversation is still
                          // here, on hover, because it is what a person types at
                          // `/resume`. It used to be a third visible line; the
                          // redesign spends that line on the reader instead, and
                          // the id is exactly the sort of fact that is needed
                          // once — when you go looking for it.
                          title={item.id}
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
                            {/* Two lines, not three. The first is the **topic** —
                                the runtime's preview of the first user message —
                                and the time rides its right edge, because the two
                                are the row's headline facts. A session that never
                                spoke has no topic; it gets the design's fallback
                                ("Untitled") rather than a blank first line. */}
                            <span className="lb-session-preview">
                              {item.preview.trim() !== '' ? item.preview : t('lb.untitled')}
                            </span>
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
                            {learningIds.has(item.id) ? (
                              <span className="lb-session-learning" title={t('lb.sessionLearningHint')}>
                                {t('lb.sessionLearning')}
                              </span>
                            ) : null}
                          </span>
                          {/* Visible to a screen reader, invisible on screen: the
                              id is a footnote, not a title, but it is still the
                              conversation's name and the thing `/resume` takes. */}
                          <span className="lb-session-id sr-only">{item.id}</span>
                        </button>
                        {/* The two per-row actions, **stacked** in a column at
                            the wrap's right edge: archive on top, delete under
                            it — the deliberate one above the irreversible one,
                            on both screens that offer the pair (this rail and
                            the board's menu). Both are `lb-row-action`s, so the
                            hover/focus reveal and the armed styling are the
                            wrap's existing rules applied twice, not a second
                            mechanism; the column only arranges them.
                            Archive is one press because it is reversible; the
                            label carries what the next press will do
                            ("Unarchive" on an archived row), which is also what
                            makes an archived row's button honest without an
                            armed state of its own. Disabled for a live child —
                            the same rule the library's rows disable by, shown
                            by the tooltip (`archiveLive`) rather than hidden. */}
                        <div className="lb-session-actions">
                          <Tip
                            label={
                              liveIds.has(item.id)
                                ? t('panel.resume.archiveLive')
                                : item.archived
                                  ? t('panel.resume.unarchive')
                                  : t('panel.resume.archive')
                            }
                          >
                            <button
                              type="button"
                              className="lb-icon lb-row-action"
                              aria-label={
                                item.archived
                                  ? t('panel.resume.unarchive')
                                  : t('panel.resume.archive')
                              }
                              disabled={blockedByBoard || liveIds.has(item.id)}
                              onClick={() => archiveSession(item.id, !item.archived)}
                            >
                              {item.archived ? (
                                <ArchiveRestore size={12} />
                              ) : (
                                <Archive size={12} />
                              )}
                            </button>
                          </Tip>
                          {/* Delete the file, not the row: the runtime waits
                              for the running turn, then re-sends the list. No
                              optimistic removal — the row goes when the runtime
                              says so. Two presses, because a delete cannot be
                              undone. */}
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
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* The workbench — the rail's drawer of destinations.
          It is one card with a head that is also its handle: folded, the card
          is the handle alone (mark, name, count, arrow); open, the body above
          the handle carries a filter and the seven destinations in two groups.
          The body is folded with `.collapse` rather than unmounted, because an
          element that is not there has no height to animate — and the rows keep
          their stagger, which is what makes opening read as a drawer coming up
          rather than a block appearing. Placement and animation live in
          stream.css (`.lb-workbench*`). */}
      <div className="lb-foot">
        <div className={`lb-workbench${footCollapsed ? ' is-collapsed' : ''}`}>
          <div
            className={`collapse${footCollapsed ? ' is-collapsed' : ''}`}
            inert={footCollapsed}
          >
            {/* A padding-free grid item, like the old foot's `.lb-foot-fold`:
                `.collapse > *` clips the content, but padding sits outside that
                clip, so a padded body would keep the folded card a few pixels
                taller than its own head. */}
            <div className="lb-workbench-fold">
              <div className="lb-workbench-body">
              <div className="lb-workbench-search">
                <Search size={13} className="lb-workbench-search-icon" aria-hidden />
                <input
                  className="lb-workbench-input"
                  value={navQuery}
                  onChange={(e) => setNavQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setNavQuery('');
                  }}
                  placeholder={t('lb.workbench.search')}
                  aria-label={t('lb.workbench.search')}
                  spellCheck={false}
                />
                {navQuery !== '' ? (
                  <button
                    type="button"
                    className="lb-icon"
                    aria-label={t('lb.workbench.clear')}
                    onClick={() => setNavQuery('')}
                  >
                    <X size={12} />
                  </button>
                ) : (
                  /* A legend, not a control: the shortcut is handled globally by
                     `useGlobalKeys` and opens the command palette, which is the
                     surface that can jump anywhere in the window. */
                  <kbd className="lb-workbench-kbd">Ctrl K</kbd>
                )}
              </div>

              {navGroups.length === 0 ? (
                <div className="lb-workbench-empty">{t('lb.workbench.none')}</div>
              ) : (
                navGroups.map((group) => (
                  <div key={group.key} className="lb-workbench-group">
                    <div className="lb-workbench-group-label">{group.label}</div>
                    <div className="lb-workbench-items">
                      {group.items.map((item) => (
                        <Tip key={item.key} label={item.hint}>
                          <button
                            type="button"
                            className={`lb-workbench-item${item.active ? ' is-active' : ''}`}
                            // The stagger is the row's own index in the whole
                            // drawer, not in its group: the two groups open as
                            // one sweep. `--i` is read by the transition-delay
                            // in stream.css.
                            style={{ '--i': navOrder.get(item.key) ?? 0 } as CSSProperties}
                            disabled={item.disabled}
                            aria-pressed={item.active === undefined ? undefined : item.active}
                            onClick={item.run}
                          >
                            <span className="lb-workbench-item-icon">{item.icon}</span>
                            <span className="lb-workbench-item-label">{item.label}</span>
                          </button>
                        </Tip>
                      ))}
                    </div>
                  </div>
                ))
              )}
              </div>
            </div>
          </div>

          {/* The handle. Folded it wears the dark identification tile; open it
              wears the pale green collapse square — the same two objects the
              design draws, and the reason the open state needs no second
              "close" control. The arrow rotates by class, not by swapping the
              glyph, so the two frames are one motion. */}
          <button
            type="button"
            className={`lb-workbench-head${footCollapsed ? ' is-collapsed' : ''}`}
            aria-expanded={!footCollapsed}
            onClick={() => {
              // Closing clears the filter, so reopening shows the drawer rather
              // than whatever was left typed in it.
              if (!footCollapsed) setNavQuery('');
              toggleFootCollapsed();
            }}
          >
            {footCollapsed ? (
              <span className="lb-workbench-mark" aria-hidden>
                <Wrench size={15} />
              </span>
            ) : (
              <span className="lb-workbench-collapse" aria-hidden>
                <ChevronDown size={14} />
              </span>
            )}
            <span className="lb-workbench-title">{t('lb.workbench')}</span>
            <Count value={navItems.length} />
            {footCollapsed ? (
              <span className="lb-workbench-caret" aria-hidden>
                <ChevronDown size={14} />
              </span>
            ) : null}
            <span className="sr-only">
              {footCollapsed ? t('lb.unfoldFoot') : t('lb.foldFoot')}
            </span>
          </button>
        </div>
      </div>
    </aside>
  );
}

/**
 * The workspace list's "add" button: a Plus that opens a small menu with the
 * two ways a workspace can be added — a local directory or a remote (SSH)
 * one. One entry point, two choices, mirroring the composer's plus menu: the
 * remote list used to have its own section and its own add button, which
 * read as two different features rather than two flavours of the same one.
 *
 * A Radix popover with the menu's existing `.plus-menu` / `.plus-item`
 * styles — the same surface as the composer's plus, so the two read as the
 * same kind of control. The popover is owned by the parent (`menuOpen` is
 * lifted out) so nothing here survives a section fold on its own; closing
 * is simply "stop being open" and the parent's state follows.
 */
function AddWorkspaceMenu({
  menuOpen,
  onMenuOpenChange,
  disabled,
  onLocal,
  onRemote,
}: {
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  disabled: boolean;
  onLocal: () => void;
  onRemote: () => void;
}) {
  const t = useT();
  return (
    <PopoverPrimitive.Root open={menuOpen} onOpenChange={onMenuOpenChange}>
      {/* No `Tip` here: the trigger is a Radix popover trigger (`asChild`
          composes onto the button), and wrapping it in a tooltip would put a
          second composed child in between. The `aria-label` is enough — the
          menu, once open, shows both choices with their names anyway. */}
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className="lb-icon"
          aria-label={t('lb.addWorkspace')}
          aria-haspopup="menu"
          disabled={disabled}
        >
          <FolderPlus size={14} />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="plus-menu lb-plus-menu"
          align="end"
          side="bottom"
          sideOffset={4}
          aria-label={t('lb.addWorkspace')}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="plus-menu-list">
            {/* **Each item closes the menu, and that is not cosmetic.** The
                composer's own plus menu does the same (see `PlusMenu`'s
                `close()`), for a reason that shows up here worse than there:
                choosing "Remote" opens a **dialog**, and a popover left mounted
                floats over the sidebar at `--z-dialog`-adjacent stacking —
                on screen it reads as the workspace list being covered by a menu
                that is still waiting for an answer it has already been given.
                Local already closed by accident of opening a native picker;
                relying on that difference would make the two items behave
                differently for no reason a person could see. */}
            <button
              type="button"
              className="plus-item"
              onClick={() => {
                onMenuOpenChange(false);
                onLocal();
              }}
            >
              <Folder size={15} />
              <span className="plus-item-label">{t('lb.workspaceKind.local')}</span>
            </button>
            <button
              type="button"
              className="plus-item"
              onClick={() => {
                onMenuOpenChange(false);
                onRemote();
              }}
            >
              <Server size={15} />
              <span className="plus-item-label">{t('lb.workspaceKind.remote')}</span>
            </button>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * The connection state badge drawn next to a remote workspace row (§5.1 of
 * the design).
 *
 * A small, closed set of short words rather than a free-form status line,
 * because this sits inside a sidebar row that is already crowded with the
 * workspace name, the "current" tag and the attention count — there is room
 * for one word, not a sentence. The sentence, when `problem` carries one,
 * is the tooltip instead.
 *
 * `'local'` is excluded on purpose: this component is only ever reached for
 * a `remoteWorkspaces` row, which never has that phase (see
 * `createSessionBucket`), so there is one fewer case to render pointlessly.
 */
function ConnectionBadge({
  phase,
  problem,
}: {
  phase: Exclude<ConnectionPhase, 'local'>;
  problem: string | null;
}) {
  const t = useT();
  const tone: 'success' | 'warning' | 'destructive' | 'neutral' =
    phase === 'ready'
      ? 'success'
      : phase === 'failed' || phase === 'interrupted'
        ? 'destructive'
        : phase === 'disconnected' || phase === 'closed'
          ? 'neutral'
          : 'warning';
  // A lookup rather than a template literal for the class name — unlike the
  // i18n key below, a dynamically-built class name is exactly what the
  // project's own `class-audit.mjs` cannot verify against the stylesheet
  // (see its `DYNAMIC_PREFIX` allowlist, which `lb-connection-` is not in),
  // so this spells out all four so the audit can actually check them.
  const toneClass =
    tone === 'success'
      ? 'lb-connection-success'
      : tone === 'warning'
        ? 'lb-connection-warning'
        : tone === 'destructive'
          ? 'lb-connection-destructive'
          : 'lb-connection-neutral';
  const label = t(`conn.${phase}` as const);
  return (
    <span className={`lb-connection ${toneClass}`} role="status" title={problem ?? label}>
      {label}
    </span>
  );
}

/**
 * The install progress badge drawn next to a remote workspace row while
 * `installRemoteWorkspace` is running or has just settled (§8 of the
 * design — "install progress" is its own thing, separate from §5.1's
 * connection states, since an install can run before any connection
 * attempt exists at all).
 *
 * Shown only when there is no live connection badge for the row to draw
 * instead (see the call site): a workspace being both installed and
 * connected at once does not happen, since `enterRemoteWorkspace` is a
 * separate, later action from `installRemoteWorkspace`.
 */
function InstallBadge({ status }: { status: InstallStatus }) {
  const t = useT();
  if (status.error !== null) {
    return (
      <span className="lb-connection lb-connection-destructive" role="status" title={status.error}>
        {t('lb.remote.installFailed')}
      </span>
    );
  }
  if (status.stage === 'done') {
    return (
      <span className="lb-connection lb-connection-success" role="status">
        {t('lb.remote.installDone')}
      </span>
    );
  }
  const label =
    status.stage === 'uploading' && status.totalEntries > 0
      ? t('lb.remote.installUploading', { done: status.uploadedEntries, total: status.totalEntries })
      : t(`install.${status.stage}` as const);
  return (
    <span className="lb-connection lb-connection-warning" role="status">
      {label}
    </span>
  );
}
