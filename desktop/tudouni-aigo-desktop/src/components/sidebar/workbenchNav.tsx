import { useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import {
  Activity,
  Bot,
  Brain,
  FileJson,
  FileText,
  GraduationCap,
  LayoutGrid,
  ListChecks,
  Network,
  Settings,
  Search,
  SquareTerminal,
  Ticket as TicketIcon,
  Webhook,
  X,
} from 'lucide-react';
import { terminalHosts } from '@/components/dock/terminal/hostManager';
import { selectTicketAttention } from '@/state/selectors/tickets';
import {
  activeRuntime,
  railBlocked,
  selectBoardAvailable,
  useApp,
} from '@/state/store';
import { useActiveWorkspaceKey } from '@/state/workspaceDock/selectors';
import { useT } from '@/i18n/useT';
import type { Translate } from '@/i18n';

/**
 * The workbench's destinations, shared by the two surfaces that draw them.
 *
 * The left rail's foot is one of them; the other is the floating dock
 * (`WorkbenchDock`), which stands in for the drawer when the rail itself is
 * folded away — a control inside the thing it opens cannot do that job (the
 * rail is `inert` while collapsed). The nav items are the **data** of that
 * drawer, and they must not be written twice: every row's gate (`blocked`,
 * `hasSession`, `hasLiveChild`, the board's availability) and badge is a
 * decision about the workspace and the runtime, and a second copy here would
 * disagree with the rail's copy the first time one gate changed.
 *
 * So the row list, its attention count and its grouping all live in this hook
 * and its helpers, and the two drawers read from the same source the way the
 * session bar's two doors read the same board selector.
 */

export interface WorkbenchNavItem {
  key: string;
  group: 'workspace' | 'settings';
  label: string;
  hint: string;
  icon: ReactNode;
  disabled: boolean;
  active?: boolean;
  badge?: { value: number; tone: 'active' | 'attention' };
  run: () => void;
}

export function useWorkbenchNav(): {
  items: WorkbenchNavItem[];
  /** The two things a folded workbench can usefully count: running shells
   *  (work in progress the person may want to get back to) and pending
   *  memory candidates (a decision the runtime is holding). The sum is the
   *  figure the rail's folded head and the floating dock's badge show — a
   *  number that means "things in this workspace want attention" rather than
   *  the old `navItems.length`, which was always the same number and said
   *  nothing. */
  attention: number;
} {
  const t = useT();
  const rt = useApp(activeRuntime);
  // A blocking modal makes every destination inert: the reasons each row
  // carries (`blocked`, `hasSession`, …) are all read from the same
  // `railBlocked` the rail's rows have always used. See `WorkspaceSidebar`.
  const blocked = useApp(railBlocked);
  const board = useApp((s) => s.board);
  const openPanel = useApp((s) => s.openPanel);
  const toggleBoard = useApp((s) => s.toggleBoard);
  // The board's gate is the **workspace's**, not the conversation's — the same
  // selector the session bar's board button reads.
  const hasLiveChild = useApp(selectBoardAvailable);
  const ticketAttention = useApp(selectTicketAttention);

  const hasSession = rt !== null && rt.ready;
  const boardOpen = board === 'sessions';

  // The workspace's terminals are the Dock's now (the window-level terminal
  // manager), so the count comes from there, not from this session's bucket.
  const dockWorkspaceId = useActiveWorkspaceKey()?.workspaceId ?? '';
  const dockTerminals = useSyncExternalStore(
    terminalHosts.subscribe,
    () => terminalHosts.terminals(dockWorkspaceId),
    () => terminalHosts.terminals(dockWorkspaceId),
  );
  const terminalsRunning = dockTerminals.filter((term) => term.state === 'running').length;
  // The badge's number comes from the state snapshot's `memory_pending`, not
  // from the panel snapshot: the model's `memory_propose` is a tool, and the
  // only snapshot a tool result re-states is `ui(state)`. The panel snapshot
  // (`rt.memory`) arrives only when the panel is open or an action is taken —
  // which is why the badge used to stay empty until a person opened the panel.
  // `null` (a runtime below protocol 8) falls back to the panel snapshot,
  // never to zero: "the runtime did not say" is not "the queue is empty".
  const memoryPending =
    rt?.uiState?.memoryPending ?? rt?.memory?.candidates.length ?? 0;

  /**
   * The order is the drawer's reading order — the workspace's own surfaces
   * first, then the process's settings — rather than the flat list the old
   * foot drew. Grouping is what answers "where am I" inside a menu of
   * destinations: seven equal rows with equal gaps read as seven unrelated
   * buttons.
   *
   * Session board is drawn in the lower group, directly under Tasks, and that
   * placement is the one thing here that is not a gate: the board is a view
   * over the set of sessions rather than one of the workspace's surfaces.
   *
   * **Per-item badges.** Terminal wears the count of running shells in the
   * `active` tone (accent — "something is alive here"), and Memory wears the
   * count of pending candidates in the `attention` tone (warning — "a decision
   * is waiting"). Both are omitted when their count is zero: a badge that is
   * always present says nothing.
   */
  const items: WorkbenchNavItem[] = [
    {
      key: 'files',
      group: 'workspace',
      label: t('panel.files.title'),
      hint: t('cmd.files.desc'),
      icon: <FileText size={14} />,
      disabled: blocked || !hasSession,
      // The Explorer in the Workspace Dock (the old modal browser is gone).
      run: () => useApp.getState().setDockMode('explorer'),
    },
    {
      key: 'terminal',
      group: 'workspace',
      label: t('panel.term.title'),
      hint: t('cmd.terminal.desc'),
      icon: <SquareTerminal size={14} />,
      disabled: blocked || !hasSession,
      badge: terminalsRunning > 0 ? { value: terminalsRunning, tone: 'active' } : undefined,
      run: () => {
        const s = useApp.getState();
        s.setDockOpen(true);
        s.setDockTermVisible(true);
      },
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
      label: t('lb.memory'),
      hint: t('lb.memoryHint'),
      icon: <Brain size={14} />,
      // A live session, not merely a workspace: the corpus lives under
      // `<workspace>/.tudouni/memory`, but the code that reads and writes it is
      // the runtime, and there is one of those per open conversation. Same
      // gate as Files and Terminal, and for the same reason.
      disabled: blocked || !hasSession,
      badge: memoryPending > 0 ? { value: memoryPending, tone: 'attention' } : undefined,
      run: () => openPanel('memory'),
    },
    {
      key: 'codeintel',
      group: 'workspace',
      label: t('lb.codeintel'),
      hint: t('lb.codeintelHint'),
      icon: <Network size={14} />,
      // A live session, like Files / Terminal / Memory: the index is per
      // workspace but the code that builds it is the runtime, and there is one
      // of those per open conversation.
      disabled: blocked || !hasSession,
      run: () => openPanel('codeintel'),
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
      key: 'subagentPresets',
      group: 'settings',
      label: t('lb.subagentPresets'),
      hint: t('lb.subagentPresetsHint'),
      icon: <Bot size={14} />,
      // `blocked` alone, like Config: the presets are read when a session
      // starts, so the person setting them up may have no session yet.
      disabled: blocked,
      run: () => openPanel('subagentPresets'),
    },
    {
      key: 'hooks',
      group: 'settings',
      label: t('lb.hooks'),
      hint: t('lb.hooksHint'),
      icon: <Webhook size={14} />,
      // A live session, unlike Config: the panel's subject includes which
      // hooks the session loaded and how their scripts have done, and only the
      // runtime knows.
      disabled: blocked || !hasSession,
      run: () => openPanel('hooks'),
    },
    {
      key: 'board',
      // The lower group, next to Tasks: the board is about the conversations
      // at large, not this workspace's own surfaces.
      group: 'settings',
      label: t('board.title'),
      hint: t('board.openHint'),
      icon: <LayoutGrid size={14} />,
      disabled: blocked || (!hasLiveChild && !boardOpen),
      active: boardOpen,
      run: () => toggleBoard('sessions'),
    },
    {
      key: 'tickets',
      group: 'settings',
      label: t('board.tickets.title'),
      hint: t('board.tickets.openHint'),
      icon: <TicketIcon size={14} />,
      // `blocked` alone, like Tasks: tickets outlive every session, so the
      // board must open with no child running at all.
      disabled: blocked,
      active: board === 'tickets',
      // needs_you + review: the two states that are waiting on the person.
      badge: ticketAttention > 0 ? { value: ticketAttention, tone: 'attention' } : undefined,
      run: () => toggleBoard('tickets'),
    },
    {
      key: 'usage',
      group: 'settings',
      // The one row whose subject is the **user**, not this workspace: the
      // ledger lives beside config.json in the home directory and counts every
      // workspace's spend.
      label: t('lb.usage'),
      hint: t('lb.usageHint'),
      icon: <Activity size={14} />,
      disabled: blocked || !hasSession,
      run: () => openPanel('usage'),
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

  return { items, attention: terminalsRunning + memoryPending };
}

/**
 * Filter the destinations by the drawer's own search and split them into the
 * two labelled groups. A pure helper rather than part of the hook because the
 * query is each drawer's own local state — the rail's and the floating dock's
 * must not share a box.
 */
export function workbenchGroups(
  items: WorkbenchNavItem[],
  query: string,
  t: Translate,
): { key: 'workspace' | 'settings'; label: string; items: WorkbenchNavItem[] }[] {
  const navFilter = query.trim().toLowerCase();
  const navVisible =
    navFilter === ''
      ? items
      : items.filter((item) => item.label.toLowerCase().includes(navFilter));
  return [
    {
      key: 'workspace' as const,
      label: t('lb.workbench.groupWorkspace'),
      items: navVisible.filter((item) => item.group === 'workspace'),
    },
    {
      key: 'settings' as const,
      label: t('lb.workbench.groupRuntime'),
      items: navVisible.filter((item) => item.group === 'settings'),
    },
  ].filter((group) => group.items.length > 0);
}

export type WorkbenchGroups = ReturnType<typeof workbenchGroups>;

/**
 * The drawer's body: the filter and the destinations in their two groups.
 *
 * It is a **separate component** from the hook because the same body is drawn
 * in two places — the rail's foot and the floating dock's popover (below) —
 * and the markup must not be written twice. The filter is each drawer's own
 * local state (`query`/`onQuery`): the rail's and the dock's must not share a
 * box, but the way a query narrows the rows is one rule, so it is applied
 * here by `workbenchGroups` rather than at the call sites.
 */
export function WorkbenchDrawerBody({
  items,
  query,
  onQuery,
}: {
  items: WorkbenchNavItem[];
  query: string;
  onQuery: (value: string) => void;
}) {
  const t = useT();
  const groups = workbenchGroups(items, query, t);
  // The row's index in the whole drawer, not its group: the two groups open as
  // one sweep (`--i` is read by the transition-delay in lb-sessions.css).
  const navOrder = new Map(items.map((item, index) => [item.key, index]));

  return (
    <>
      <div className="lb-workbench-search">
        <Search size={13} className="lb-workbench-search-icon" aria-hidden />
        <input
          className="lb-workbench-input"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onQuery('');
          }}
          placeholder={t('lb.workbench.search')}
          aria-label={t('lb.workbench.search')}
          spellCheck={false}
        />
        {query !== '' ? (
          <button
            type="button"
            className="lb-icon"
            aria-label={t('lb.workbench.clear')}
            onClick={() => onQuery('')}
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

      {groups.length === 0 ? (
        <div className="lb-workbench-empty">{t('lb.workbench.none')}</div>
      ) : (
        groups.map((group) => (
          <div key={group.key} className="lb-workbench-group">
            <div className="lb-workbench-group-label">{group.label}</div>
            <div className="lb-workbench-items">
              {group.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`lb-workbench-item${item.active ? ' is-active' : ''}`}
                  style={{ '--i': navOrder.get(item.key) ?? 0 } as CSSProperties}
                  disabled={item.disabled}
                  aria-pressed={item.active === undefined ? undefined : item.active}
                  aria-label={item.hint}
                  onClick={item.run}
                >
                  <span className="lb-workbench-item-icon">{item.icon}</span>
                  <span className="lb-workbench-item-label">{item.label}</span>
                  {item.badge ? (
                    <span
                      className={`lb-workbench-item-badge${item.badge.tone === 'attention' ? ' is-attention' : ''}`}
                      aria-label={
                        item.badge.tone === 'attention'
                          ? t('lb.attention', { n: item.badge.value })
                          : undefined
                      }
                    >
                      {item.badge.value}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ))
      )}
    </>
  );
}
