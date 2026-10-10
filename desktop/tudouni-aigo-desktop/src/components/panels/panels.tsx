import { useMemo, useState } from 'react';
import { Archive, ArchiveRestore, ArrowUp, Bot, Download, Folder, Plus, Search, Upload, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { notesByServer } from '@/runtime/adapt';
import {
  NO_ALIASES,
  NO_FILE_ENTRIES,
  NO_JOBS,
  NO_MCP_ROWS,
  NO_MODEL_ROWS,
  NO_SKILLS,
  NO_STRINGS,
  NO_SUBAGENTS,
  NO_TERMINALS,
  activeWorkspaceOf,
  selectAskOn,
  selectEffortLevels,
  selectLiveSessionIdsKey,
  selectSavedSessions,
  useApp,
  useSessionField,
} from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { useListKeys } from '@/hooks/useListKeys';
import { Badge, EmptyState, Info, RiskTag, Tip } from '@/components/ui/kit';
import { InBlock } from '@/components/stream/InBlock';
import { PanelBody, PanelRow, PanelShell } from './PanelShell';
import { COMMANDS } from '@/commands';
import { formatDuration, formatPath, formatRelative, formatTokens, oneLine } from '@/utils/format';
import { formatBytes } from '@/runtime/paste';
import type { FileEntry } from '@/protocol/types';

// Through the store's action rather than `setState({ panel: null })`: the
// library borrows the connection's session filter while it is open, and this is
// what gives it back. Every panel close in this file goes through here, so none
// of them has to remember. See `AppStore.closePanel`.
const closePanel = () => useApp.getState().closePanel();

/* ============================================================
   Model selection.
   Two routes can carry the same model name, so `provider/model` is
   what actually gets sent — the palette must be able to tell them apart.
   ============================================================ */
export function ModelPanel() {
  const t = useT();
  // The catalogue belongs to the session's child — it is read from that child's
  // configuration at open — so it comes from the session being shown.
  const models = useSessionField((rt) => rt.models, NO_MODEL_ROWS);
  const aliases = useSessionField((rt) => rt.modelAliases, NO_ALIASES);
  const chooseModel = useApp((s) => s.chooseModel);

  const rows = models;
  const { active, setActive } = useListKeys({
    count: rows.length,
    onClose: closePanel,
    onPick: (i) => {
      const row = rows[i];
      // `set_model` requires an exact name and does no fuzzy matching, so the
      // qualified form is what is sent when a name exists on several routes.
      if (row) chooseModel(row.provider ? `${row.provider}/${row.id}` : row.id);
    },
  });

  return (
    <PanelShell title={t('panel.model.title')} count={rows.length} note={t('cmd.model.desc')}>
      <PanelBody>
        {rows.length === 0 ? (
          <EmptyState title={t('common.loading')} />
        ) : (
          rows.map((model, i) => (
            <PanelRow
              key={`${model.provider}/${model.id}`}
              index={i + 1}
              active={active === i}
              selected={model.current}
              onHover={() => setActive(i)}
              onPick={() => chooseModel(`${model.provider}/${model.id}`)}
              aside={
                model.current ? (
                  <Badge tone="success" dot={false}>
                    {t('panel.model.current')}
                  </Badge>
                ) : null
              }
            >
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <span className="mono strong">{model.label || model.id}</span>
                <Badge tone="neutral" dot={false}>
                  {t('panel.model.route')} {model.provider}
                </Badge>
                <span className="caption faint">
                  {t('panel.model.window')}{' '}
                  {/* Null means the catalogue does not name a window. */}
                  {model.window === null ? t('common.unknown') : formatTokens(model.window)}
                </span>
                {model.vision ? (
                  <Badge tone="info" dot={false}>
                    {t('panel.model.vision')}
                  </Badge>
                ) : null}
                {model.effort ? (
                  <span className="caption faint">
                    {t('session.effort')} {model.effort}
                  </span>
                ) : null}
              </div>
              {model.summary || model.note ? (
                <div className="caption muted">{model.summary || model.note}</div>
              ) : null}
            </PanelRow>
          ))
        )}

        {/* Aliases are names the runtime accepts that are not in the list. They
            are data, not an answer: shown and labelled rather than hidden. */}
        {aliases.length > 0 ? (
          <>
            <div className="cmdk-group">{t('panel.model.aliases')}</div>
            {aliases.map((alias) => (
              <PanelRow key={alias.id} aside={<Badge tone="neutral" dot={false}>{t('panel.model.alias')}</Badge>}>
                <div className="row" style={{ gap: 'var(--space-2)' }}>
                  <span className="mono muted">{alias.id}</span>
                  <span className="caption faint">→ {alias.of}</span>
                </div>
              </PanelRow>
            ))}
          </>
        ) : null}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   Reasoning effort.
   The list is `string[]` from the runtime and changes with the model;
   the labels are this layer's job, the levels are not.
   ============================================================ */
export function EffortPanel() {
  const t = useT();
  // The shared empty constant keeps the snapshot's identity while the data is
  // missing; a fresh `[]` here would re-render forever.
  const levels = useApp(
    useShallow((s) =>
      selectEffortLevels(s, s.activeKey),
    ),
  );
  const current = useSessionField((rt) => rt.session?.effort ?? '', '');
  const thinking = useSessionField((rt) => rt.session?.thinking ?? false, false);
  const chooseEffort = useApp((s) => s.chooseEffort);

  const { active, setActive } = useListKeys({
    count: levels.length,
    onClose: closePanel,
    onPick: (i) => levels[i] && chooseEffort(levels[i]),
  });

  return (
    <PanelShell
      title={t('panel.effort.title')}
      count={levels.length}
      note={t('panel.effort.note')}
    >
      <PanelBody>
        {levels.length === 0 ? (
          <EmptyState title={t('common.loading')} />
        ) : (
          levels.map((level, i) => (
            <PanelRow
              key={level}
              index={i + 1}
              active={active === i}
              selected={level === current}
              onHover={() => setActive(i)}
              onPick={() => chooseEffort(level)}
              aside={
                level === current ? (
                  <Badge tone="success" dot={false}>
                    {t('panel.model.current')}
                  </Badge>
                ) : null
              }
            >
              <span className="mono strong">{level}</span>
            </PanelRow>
          ))
        )}

        {/* Thinking can be off while an effort is still recorded — that is the
            user's intent, so it is stated rather than corrected. */}
        {!thinking ? (
          <div className="caption faint" style={{ padding: 'var(--space-2) var(--space-3)' }}>
            {t('session.thinking')}: {t('session.thinkingOff')} —{' '}
            {t('cmd.thinking.desc')}
          </div>
        ) : null}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   Session picker.
   Preview and progress are computed by the runtime; this view never
   reads a session file.
   ============================================================ */
/**
 * The library: every session this workspace has, active or archived.
 *
 * **Two tabs, not two panels.** "Active" is the list the rail shows; "Archived"
 * is what the rail deliberately does not. They are two views of one fact — the
 * workspace's saved sessions — so a tab strip is the honest shape, and the
 * archive action lives on the rows rather than in a separate "manage" screen.
 *
 * **The connection's filter follows the tab.** The runtime's list is one per
 * connection and its cap is fifty rows, so the desktop asks for `active` in its
 * steady state and switches to `all` while this panel is open (see
 * `AppStore.sessionFilter`). That is why the search below filters the rows it was
 * given rather than asking the runtime: the rows are already the union of both
 * tabs.
 *
 * **Archiving is reversible; deleting is not.** Archive moves a row to the other
 * tab and back; delete (the rail's action, `Ctrl+Del`) is not offered here, so
 * the destructive one keeps its single, deliberate home.
 */
export function ResumePanel() {
  const t = useT();
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [q, setQ] = useState('');
  // The picker shows the **workspace's** saved sessions, so it reads the same
  // window-level list the left rail does — one source, so the two can never
  // disagree about what exists (see `SavedSessions`).
  const saved = useApp((s) => selectSavedSessions(s, activeWorkspaceOf(s)));
  const listed = saved.listed;
  const openSession = useApp((s) => s.openSession);
  const archiveSession = useApp((s) => s.archiveSession);
  // The compact key, not the Set: `selectLiveSessionIds` builds a fresh Set on
  // every call, and a zustand selection that is a new reference on every read
  // loops the panel into "Maximum update depth exceeded". The key is a stable
  // primitive; the Set is derived from it and rebuilt only when the ids do.
  const liveIdsKey = useApp(selectLiveSessionIdsKey);
  const liveIds = useMemo(() => new Set(liveIdsKey === '' ? [] : liveIdsKey.split('\u0001')), [liveIdsKey]);
  const currentId = useSessionField((rt) => rt.session?.id ?? null, null);

  /** Field-level match: the topic and the session id, in that order.
   *  Not fuzzy and not the metadata — `preview` is the topic the runtime
   *  computed, and `id` is the name `/resume` itself uses, so these are the two
   *  strings a person could actually have typed. */
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const byTab = saved.items.filter((row) => (tab === 'archived' ? row.archived : !row.archived));
    if (needle === '') return byTab;
    return byTab.filter(
      (row) => row.preview.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle),
    );
  }, [saved.items, tab, q]);

  const { active, setActive } = useListKeys({
    count: list.length,
    onClose: closePanel,
    onPick: (i) => list[i] && void openSession(list[i].id),
  });

  const archivedCount = useMemo(() => saved.items.filter((r) => r.archived).length, [saved.items]);
  const activeCount = saved.items.length - archivedCount;

  return (
    <PanelShell title={t('panel.resume.title')} count={list.length} note={t('cmd.resume.desc')}>
      <div className="cmdk-head">
        <Search size={14} className="muted" />
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            // The cursor must not stay on a row the new query hid — it would
            // select the wrong conversation on Enter.
            setActive(0);
          }}
          placeholder={t('panel.resume.search')}
          title={t('panel.resume.searchHint')}
          aria-label={t('panel.resume.search')}
          spellCheck={false}
        />
      </div>
      <div className="panel-tabs" role="tablist">
        {(['active', 'archived'] as const).map((which) => (
          <button
            key={which}
            type="button"
            role="tab"
            aria-selected={tab === which}
            className={`panel-tab${tab === which ? ' is-on' : ''}`}
            onClick={() => {
              setTab(which);
              setActive(0);
            }}
          >
            {t(which === 'active' ? 'panel.resume.tab.active' : 'panel.resume.tab.archived')}
            <span className="count">{which === 'active' ? activeCount : archivedCount}</span>
          </button>
        ))}
      </div>
      <PanelBody>
        {!listed ? (
          <EmptyState title={t('common.loading')} />
        ) : list.length === 0 ? (
          <EmptyState
            title={
              q.trim() !== ''
                ? t('panel.resume.noMatch')
                : tab === 'archived'
                  ? t('panel.resume.archivedEmpty')
                  : t('panel.resume.empty')
            }
          />
        ) : (
          list.map((item, i) => {
            // A live child holds this id, so archiving would edit a session file
            // something else is still writing. The button is disabled rather than
            // hidden: "why can't I archive this one" has an answer, and the
            // tooltip is it. `archiveSession` refuses the same case again — this
            // is the visible half of one rule, not the only half.
            const live = liveIds.has(item.id);
            const target = item.archived ? false : true;
            return (
              <PanelRow
                key={item.id}
                index={i + 1}
                active={active === i}
                selected={item.id === currentId}
                onHover={() => setActive(i)}
                onPick={() => void openSession(item.id)}
                aside={
                  item.modifiedAt === null
                    ? t('common.unknown')
                    : formatRelative(item.modifiedAt * 1000)
                }
              >
                <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
                  <span className="truncate grow">{item.preview}</span>
                  {item.archived ? (
                    <Badge tone="neutral">{t('panel.resume.archivedTag')}</Badge>
                  ) : null}
                  <Tip label={live && !item.archived ? t('panel.resume.archiveLive') : ''}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      aria-label={
                        target ? t('panel.resume.archive') : t('panel.resume.unarchive')
                      }
                      disabled={live && !item.archived}
                      // The row is itself a button; without this the click would
                      // also pick the row and open the session.
                      onClick={(e) => {
                        e.stopPropagation();
                        archiveSession(item.id, target);
                      }}
                    >
                      {target ? <Archive size={13} /> : <ArchiveRestore size={13} />}
                    </button>
                  </Tip>
                </div>
                <div className="row" style={{ gap: 'var(--space-2)' }}>
                  {/* The id is a footnote now, not the title: it is a timestamp
                      (`YYYYMMDD-HHMMSS`) and the topic above is what identifies the
                      conversation. It stays because it is the name `/resume` and the
                      rail's own row use. */}
                  <span className="mono faint">{item.id}</span>
                  <span className="caption faint">{t('panel.resume.messages', { n: item.messages })}</span>
                  <span className="caption faint">{t('panel.resume.steps', { n: item.steps })}</span>
                  {/* `todos` is ready-made progress text; an empty string means
                      there is no task list, which is not the same as zero. */}
                  {item.todos ? <span className="caption faint">{item.todos}</span> : null}
                </div>
              </PanelRow>
            );
          })
        )}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   MCP. The three states are three different questions.
   ============================================================ */
export function McpPanel() {
  const t = useT();
  // Mounting is per session: each child connects its own servers, so the list
  // below is that session's and a load in one conversation does not show in
  // another's panel.
  const servers = useSessionField((rt) => rt.mcp, NO_MCP_ROWS);
  const notes = useSessionField((rt) => rt.mcpNotes, NO_STRINGS);
  const requestMcp = useApp((s) => s.requestMcp);

  // A server that would not connect has no state of its own on the wire — the
  // runtime says it in a sentence, under `mcp_notes`. Attaching that sentence to
  // the row it names is what stops "configured, never loaded" and "we tried and
  // it failed" from looking identical here.
  const perServer = useMemo(() => notesByServer(servers, notes), [servers, notes]);
  const unattached = notes.filter((note) => ![...perServer.values()].some((list) => list.includes(note)));

  function toggle(index: number) {
    const server = servers[index];
    if (!server) return;
    if (server.state === 'loaded') requestMcp('unload', [server.name]);
    else if (server.state === 'unload') requestMcp('load', [server.name]);
    // A failed server is not silently retried: asking again is a decision, and
    // the reason is already on the row.
  }

  const { active, setActive } = useListKeys({
    count: servers.length,
    onClose: closePanel,
    onPick: toggle,
  });

  return (
    <PanelShell title={t('panel.mcp.title')} count={servers.length} note={t('cmd.mcp.desc')}>
      <PanelBody>
        {servers.length === 0 ? (
          <EmptyState title={t('panel.mcp.empty')} hint={t('empty.mcp.hint')} />
        ) : (
          servers.map((server, i) => {
            const tone =
              server.state === 'loaded'
                ? 'success'
                : server.state === 'failed'
                  ? 'destructive'
                  : 'neutral';
            const label =
              server.state === 'loaded'
                ? t('mcp.loaded')
                : server.state === 'unload'
                  ? t('mcp.unload')
                  : t('mcp.failed');

            return (
              <PanelRow
                key={server.name}
                index={i + 1}
                active={active === i}
                onHover={() => setActive(i)}
                onPick={() => toggle(i)}
                aside={
                  server.state === 'failed' ? null : (
                    <span className="row" style={{ gap: 'var(--space-1)' }}>
                      {server.state === 'loaded' ? <Upload size={11} /> : <Download size={11} />}
                      {server.state === 'loaded' ? t('mcp.unloadAction') : t('mcp.load')}
                    </span>
                  )
                }
              >
                <div className="row" style={{ gap: 'var(--space-2)' }}>
                  <span className="mono strong">{server.name}</span>
                  <Badge tone={tone} dot={false}>
                    {label}
                  </Badge>
                  {server.state === 'failed' ? null : (
                    <span className="caption faint">{t('mcp.tools', { n: server.tools })}</span>
                  )}
                </div>
                {/* `where` reaches `scheme://host` for remote servers only: a URL
                    can carry a token, and this row is drawn and logged. */}
                <div className="caption muted truncate mono" title={server.where}>
                  {server.where}
                </div>
                {server.error ? (
                  <div className="caption" style={{ color: 'var(--destructive)' }}>
                    {server.error}
                  </div>
                ) : null}
                {/* The runtime's own sentence about *this* server, shown on the
                    row it belongs to. It is what distinguishes "configured, never
                    loaded" from "we tried and it failed" — the two carry the same
                    `state` on the wire. */}
                {(perServer.get(server.name) ?? []).map((note, n) => (
                  <div key={`n-${n}`} className="caption" style={{ color: 'var(--warning)' }}>
                    {note}
                  </div>
                ))}
              </PanelRow>
            );
          })
        )}

        {/* Notes that name no configured server (a bad `mcp.json`, a server that
            is not in the list) stay in their own group rather than being
            attached to the nearest row. The runtime wrote them whole; they are
            shown as-is. */}
        {unattached.length > 0 ? (
          <>
            <div className="cmdk-group">{t('panel.mcp.notes')}</div>
            {unattached.map((note, i) => (
              <PanelRow key={`note-${i}`}>
                <span className="caption muted">{note}</span>
              </PanelRow>
            ))}
          </>
        ) : null}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   Skills. Four facts, two lists.
   `ui(skills).skills` is what this session **can load**; `active` is what is
   **loaded**. The digest and the description come from `ui(state)`, which is
   the only message carrying them. The store merges them (`mergeSkills`), so
   this view reads two ready lists rather than re-deriving the split.
   ============================================================ */
export function SkillsPanel() {
  const t = useT();
  const loaded = useSessionField((rt) => rt.skills, NO_SKILLS);
  const available = useSessionField((rt) => rt.skillAvailable, NO_SKILLS);
  const problems = useSessionField((rt) => rt.skillProblems, NO_STRINGS);
  const shadowed = useSessionField((rt) => rt.skillShadowed, NO_STRINGS);
  const requestSkills = useApp((s) => s.requestSkills);

  const total = loaded.length + available.length;

  return (
    <PanelShell
      title={t('panel.skills.title')}
      count={`${loaded.length} / ${total}`}
      note={t('cmd.skills.desc')}
    >
      <PanelBody>
        {/* Group head = the group's label plus a `?` carrying the sentence the
            row itself cannot carry. The row is name-first now (strong, no badge
            in the middle): the badge moved to `aside`, where it cannot break
            the name out of the first visual slot. */}
        <div className="panel-group-head">
          <span>{t('panel.skills.loaded')}</span>
          <Info label={t('panel.skills.hint')} />
        </div>
        {loaded.length === 0 ? (
          <EmptyState title={t('panel.skills.empty')} hint={t('empty.skills.hint')} />
        ) : (
          loaded.map((skill) => (
            <PanelRow key={skill.name} aside={<Badge tone="success" dot={false}>{t('panel.skills.loaded')}</Badge>}>
              <div className="skill-row-main">
                <span className="mono strong">{skill.name}</span>
                {/* Empty means the runtime did not send a digest for this one —
                    unknown, not "no digest". */}
                {skill.digest !== '' ? <span className="caption faint mono">{skill.digest}</span> : null}
              </div>
              <div className="caption muted clamp-2">
                {skill.description ?? t('common.unknown')}
              </div>
            </PanelRow>
          ))
        )}

        {/* What is left is what a person could still load — the difference
            between the catalogue and the loaded set. The plain `.cmdk-group`
            rule (no weight, fainter colour) is the second tier: the loaded
            group's head is bold and one shade up. */}
        {available.length > 0 ? (
          <>
            <div className="cmdk-group">{t('panel.skills.available')}</div>
            {available.map((row) => (
              <PanelRow key={row.name}>
                <div className="skill-row-main">
                  <span className="mono">{row.name}</span>
                </div>
                {row.description ? <div className="caption faint clamp-2">{row.description}</div> : null}
              </PanelRow>
            ))}
          </>
        ) : null}

        {problems.length > 0 ? (
          <>
            <div className="cmdk-group">{t('panel.skills.problems')}</div>
            {problems.map((problem, i) => (
              <PanelRow key={`p-${i}`}>
                <span className="caption" style={{ color: 'var(--warning)' }}>
                  {problem}
                </span>
              </PanelRow>
            ))}
          </>
        ) : null}

        {shadowed.length > 0 ? (
          <>
            <div className="cmdk-group">{t('panel.skills.shadowed')}</div>
            {shadowed.map((line, i) => (
              <PanelRow key={`s-${i}`}>
                <span className="caption faint">{line}</span>
              </PanelRow>
            ))}
          </>
        ) : null}

        <button
          type="button"
          className="btn btn-ghost btn-compact"
          style={{ margin: 'var(--space-3)' }}
          onClick={requestSkills}
        >
          {t('panel.skills.refresh')}
        </button>
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   Help: the command table plus the key table.
   ============================================================ */
const KEY_ROWS: Array<{ keys: string[]; label: TKey }> = [
  { keys: ['Enter'], label: 'key.send' },
  { keys: ['Shift', 'Enter'], label: 'key.newline' },
  { keys: ['Esc'], label: 'key.esc' },
  { keys: ['↑', '↓', 'PgUp', 'PgDn'], label: 'key.move' },
  { keys: ['Ctrl', 'T'], label: 'key.thinking' },
  { keys: ['Ctrl', 'B'], label: 'key.sidebar' },
  { keys: ['Ctrl', 'L'], label: 'key.leftbar' },
  { keys: ['Ctrl', 'K'], label: 'key.palette' },
  { keys: ['Ctrl', 'S'], label: 'key.skills' },
  { keys: ['Ctrl', '\\'], label: 'key.quiet' },
  { keys: ['Ctrl', 'A', 'E', 'W', 'U'], label: 'key.edit' },
  { keys: ['1', '9'], label: 'key.pick' },
];

export function HelpPanel() {
  const t = useT();
  return (
    <PanelShell
      title={t('panel.help.title')}
      count={`${COMMANDS.length}`}
      note={`${t('panel.help.commands')} · ${t('panel.help.keys')}`}
    >
      <PanelBody>
        <div className="etb-label">{t('panel.help.commands')}</div>
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('panel.help.commands')}</th>
              <th>{t('inblock.note')}</th>
            </tr>
          </thead>
          <tbody>
            {COMMANDS.map((command, i) => (
              <tr key={command.id}>
                <td className="num">{i + 1}</td>
                <td className="mono strong">{command.name}</td>
                <td className="muted">{t(command.descKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="etb-label" style={{ marginTop: 'var(--space-3)' }}>
          {t('panel.help.keys')}
        </div>
        <table className="table">
          <tbody>
            {KEY_ROWS.map((row) => (
              <tr key={row.label}>
                <td style={{ width: 220 }}>
                  <span className="row" style={{ gap: 3 }}>
                    {row.keys.map((key) => (
                      <kbd className="kbd" key={key}>
                        {key}
                      </kbd>
                    ))}
                  </span>
                </td>
                <td className="muted">{t(row.label)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   Subagents and background jobs.
   The status bar carries the badge; this is where the detail lives.
   ============================================================ */
export function SubagentsPanel() {
  const t = useT();
  // Delegations and background jobs belong to one session's turn.
  const agents = useSessionField((rt) => rt.uiState?.subagents ?? NO_SUBAGENTS, NO_SUBAGENTS);
  const jobs = useSessionField((rt) => rt.uiState?.jobs ?? NO_JOBS, NO_JOBS);

  const { active, setActive } = useListKeys({
    count: agents.length,
    onClose: closePanel,
    onPick: () => undefined,
  });

  return (
    <PanelShell title={t('panel.subagents.title')} count={`${agents.length} / ${jobs.length}`}>
      <PanelBody>
        <div className="etb-label">{t('status.subagents')}</div>
        {agents.length === 0 ? (
          <EmptyState title={t('panel.subagents.empty')} />
        ) : (
          agents.map((agent, i) => (
            <PanelRow
              key={agent.id}
              index={i + 1}
              active={active === i}
              onHover={() => setActive(i)}
              aside={formatDuration(agent.seconds * 1000)}
            >
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <Bot size={12} className="muted" />
                <span className="strong">{agent.label}</span>
                {/* `provider` is shown next to the model because a name can exist
                    on more than one route. */}
                <span className="mono caption faint">
                  {agent.provider}/{agent.model} · depth {agent.depth} · {agent.steps} steps ·{' '}
                  {agent.toolCalls} calls
                </span>
              </div>
              <div className="caption muted">{agent.activity}</div>
            </PanelRow>
          ))
        )}

        <div className="etb-label" style={{ marginTop: 'var(--space-3)' }}>
          {t('block.jobs')}
        </div>
        {jobs.length === 0 ? (
          <EmptyState title={t('empty.jobs.title')} hint={t('empty.jobs.hint')} />
        ) : (
          jobs.map((job) => (
            <PanelRow
              key={job.id}
              aside={
                <>
                  {job.uncollected ? (
                    <Badge tone="warning" dot={false}>
                      {t('jobs.uncollected')}
                    </Badge>
                  ) : null}{' '}
                  {formatDuration(job.seconds * 1000)}
                  {job.exitCode !== null ? ` · ${t('jobs.exit', { n: job.exitCode })}` : ''}
                </>
              }
            >
              <span className="mono">{oneLine(job.command, 72)}</span>
            </PanelRow>
          ))
        )}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   Files. A browser, not a picker: Enter on a directory walks down.
   ============================================================ */
export function FilesPanel() {
  const t = useT();
  // The listing is per **session**, because it is what that child answered —
  // and the child is what holds the workspace boundary the paths are relative
  // to. Two sessions in different workspaces have unrelated trees.
  const path = useSessionField((rt) => rt.filesPath, '');
  const entries = useSessionField((rt) => rt.filesEntries, NO_FILE_ENTRIES);
  const loading = useSessionField((rt) => rt.filesLoading, false);
  const problem = useSessionField((rt) => rt.filesProblem, null);
  const view = useSessionField((rt) => rt.fileView, null);
  const listFiles = useApp((s) => s.listFiles);
  const readFile = useApp((s) => s.readFile);

  function open(entry: FileEntry) {
    // A directory is **listed**; a file is **read**. Which one this is comes
    // from the runtime's own `type`, never from a guess about the name — a
    // symlink to a directory is reported as a directory, and a name with a dot
    // in it is not evidence of anything.
    if (entry.type === 'directory') listFiles(entry.path);
    else readFile(entry.path);
  }

  const { active, setActive } = useListKeys({
    count: entries.length,
    onClose: closePanel,
    onPick: (i) => entries[i] && open(entries[i]),
  });

  // The parent step is the same arithmetic the runtime's own paths use: the
  // empty string is the workspace root, and it is also its own parent. Walking
  // up from the root stays put rather than producing `..`, which the runtime
  // would refuse — a button that generates a refusal is a button that looks
  // broken.
  const parent = parentPath(path);

  return (
    <PanelShell
      title={t('panel.files.title')}
      count={entries.length}
      note={path === '' ? t('panel.files.root') : path}
    >
      <PanelBody>
        {path !== '' ? (
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            style={{ margin: '0 var(--space-3) var(--space-2)' }}
            onClick={() => listFiles(parent)}
          >
            <ArrowUp size={12} />
            {t('panel.files.parent')}
          </button>
        ) : null}

        {/* **Three states, not two.** "Loading", "empty" and "the runtime
            refused" are three different statements, and the third had no
            representation at all: a refusal arrives as a `notice` rather than a
            `ui(files)`, so nothing cleared `loading` and the panel sat on
            "Reading the directory…" for ever — while the sentence explaining it
            was written into the transcript this panel is covering.

            The refusal is the runtime's own wording, unaltered: it is the
            authority on why it will not read a path. */}
        {loading ? (
          <EmptyState title={t('panel.files.loading')} />
        ) : problem !== null ? (
          <EmptyState title={t('panel.files.failed')} hint={problem} />
        ) : entries.length === 0 ? (
          <EmptyState title={t('panel.files.empty')} />
        ) : (
          entries.map((entry, i) => (
            <PanelRow
              key={entry.path}
              index={i + 1}
              active={active === i}
              onHover={() => setActive(i)}
              onPick={() => open(entry)}
              aside={
                entry.type === 'directory' ? (
                  <Folder size={12} className="muted" />
                ) : (
                  <span className="caption faint mono">{formatBytes(entry.size)}</span>
                )
              }
            >
              <span className={entry.type === 'directory' ? 'strong' : 'mono'}>
                {entry.name}
                {entry.type === 'directory' ? '/' : ''}
              </span>
            </PanelRow>
          ))
        )}
      </PanelBody>

      {/* **The viewer, in the panel's own lower half.**

          It has to be here rather than only in the transcript: the panel is a
          modal layer drawn *over* the transcript, so a `file_read` answer landing
          in the stream was invisible — pressing Enter on a file changed nothing
          on screen, and a person could not tell a slow read from a dead button.
          The comparison is right next door: `TerminalPanel` closes itself before
          attaching for exactly this reason.

          It draws the **same component** the transcript draws (`InBlock` →
          `FileBlock`), so the two cannot drift into describing one answer two
          ways. The block is also still appended to the stream, because that is
          where a file read belongs in arrival order and where a person reads it
          once the panel is closed. */}
      {view !== null ? (
        <div className="files-view">
          {view.problem !== null ? (
            <div className="files-view-problem" role="alert">
              {view.problem}
            </div>
          ) : view.answer === null ? (
            <div className="files-view-head caption faint">
              <span className="mono">{view.path}</span> · {t('panel.files.reading')}
            </div>
          ) : (
            <InBlock
              entry={{
                kind: 'block',
                id: 'files-preview',
                block: 'file',
                payload: view.answer,
              }}
            />
          )}
        </div>
      ) : null}
    </PanelShell>
  );
}

/**
 * The directory one level up, in the runtime's own vocabulary.
 *
 * The empty string is the workspace root **and** its own parent, so walking up
 * from the top stays put. That is the boundary rule expressed as arithmetic on
 * this side; the runtime refuses an escape anyway, and a front end that
 * generated one would be inviting a refusal notice for a button that should
 * simply stop.
 */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') return '';
  const at = trimmed.lastIndexOf('/');
  return at < 0 ? '' : trimmed.slice(0, at);
}

/* There used to be a second `formatBytes` right here, and it disagreed with the
   one in `runtime/paste.ts` about the same byte counts: `1.5 KB` here versus
   `1.5MB` there, spaces and rounding both different. The two are drawn on **one
   screen** — the files panel lists sizes while the composer reports an oversized
   paste — so the same file could be described two ways in two lines a person is
   reading at once. The paste module's own comment says it exists so a file is
   not "1.5MB in one sentence and 1536KB in the next"; the panel is now held to
   the same rule by importing it. */

/* ============================================================
   Terminals. The list, and the one thing a client owns about a terminal.
   ============================================================ */
export function TerminalPanel() {
  const t = useT();
  const terminals = useSessionField((rt) => rt.terminals, NO_TERMINALS);
  const attachedId = useSessionField((rt) => rt.activeTerminalId, null);
  const pending = useSessionField((rt) => rt.terminalPending, NO_STRINGS);
  const createTerminal = useApp((s) => s.createTerminal);
  const killTerminal = useApp((s) => s.killTerminal);
  const attachTerminal = useApp((s) => s.attachTerminal);
  const [armed, setArmed] = useState<string | null>(null);

  const { active, setActive } = useListKeys({
    count: terminals.length,
    onClose: closePanel,
    // Enter **attaches**, and closing the panel is what makes the attach
    // visible: the terminal view is the composer's replacement, so a panel left
    // open over it would hide the thing that just changed.
    onPick: (i) => {
      const row = terminals[i];
      if (!row) return;
      attachTerminal(row.id);
      closePanel();
    },
  });

  return (
    <PanelShell
      title={t('panel.term.title')}
      count={terminals.length}
      note={t('panel.term.outline')}
    >
      <PanelBody>
        {/* **Disabled while a create is in flight.** Two quick presses used to
            send two `terminal_create` messages, which the runtime answered with
            two real shells — and because the reply attaches the view to the
            newest one, the first was left as a tab nobody remembered asking
            for. The sentinel `'new'` is released by `terminal_created` on
            success and by `ui(terminals)` on a refusal, so a refused create
            cannot leave this button dead. */}
        <button
          type="button"
          className="btn btn-outline btn-block"
          style={{ margin: '0 var(--space-3) var(--space-2)' }}
          disabled={pending.includes('new')}
          onClick={() => createTerminal()}
        >
          <Plus size={13} />
          {t('panel.term.new')}
        </button>

        {terminals.length === 0 ? (
          <EmptyState title={t('panel.term.empty')} />
        ) : (
          terminals.map((row, i) => (
            <PanelRow
              key={row.id}
              index={i + 1}
              active={active === i}
              selected={row.id === attachedId}
              onHover={() => setActive(i)}
              onPick={() => {
                attachTerminal(row.id);
                closePanel();
              }}
              aside={
                <>
                  {/* The status comes from the runtime and from nowhere else.
                      Three endings read three ways, and the third is why this
                      cannot be a lookup: `killed`, `exited` with a code, and
                      `exited` with no code are different facts — a killed shell
                      did not choose an exit status, so printing 0 next to it
                      would invent one. */}
                  {row.status === 'running' ? (
                    <Badge tone="success" dot={false}>
                      {t('panel.term.running')}
                    </Badge>
                  ) : row.status === 'killed' ? (
                    <Badge tone="warning" dot={false}>
                      {t('panel.term.killed')}
                    </Badge>
                  ) : (
                    <Badge tone="neutral" dot={false}>
                      {row.exit_code === null || row.exit_code === undefined
                        ? t('panel.term.exitedNoCode')
                        : t('panel.term.exited', { code: row.exit_code })}
                    </Badge>
                  )}{' '}
                  {/* End it. Two presses, like deleting a session: a kill takes
                      down a whole process tree and cannot be undone. */}
                  <button
                    type="button"
                    className={`btn btn-ghost btn-icon btn-compact${armed === row.id ? ' is-armed' : ''}`}
                    aria-label={
                      armed === row.id ? t('panel.term.killConfirm') : t('panel.term.kill')
                    }
                    disabled={row.status !== 'running' || pending.includes(row.id)}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (armed === row.id) {
                        setArmed(null);
                        killTerminal(row.id);
                      } else {
                        setArmed(row.id);
                      }
                    }}
                    onMouseLeave={() => {
                      if (armed === row.id) setArmed(null);
                    }}
                  >
                    <X size={12} />
                  </button>
                </>
              }
            >
              <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'baseline' }}>
                <span className="mono strong">{row.id}</span>
                <span className="caption faint">
                  {row.cwd === '' ? t('panel.term.cwdRoot') : row.cwd}
                </span>
                <span className="caption faint mono">{row.shell}</span>
              </div>
            </PanelRow>
          ))
        )}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   Audit and wiring: the facts that explain "why did that not take effect".
   ============================================================ */
export function AuditPanel() {
  const t = useT();
  // Everything here except the two version numbers is a fact about **one**
  // session: its audit path, its permission scope, its counts, its own decoder
  // tally. The versions are window-level and read from the store.
  const key = useApp((s) => s.activeKey);
  const session = useSessionField((rt) => rt.session, null);
  const snap = useSessionField((rt) => rt.uiState, null);
  const desktopVersion = useApp((s) => s.desktopVersion);
  const runtimeVersion = useApp((s) => s.runtimeVersion);
  const dropped = useSessionField((rt) => rt.dropped, 0);
  const lateDropped = useSessionField((rt) => rt.lateDropped, 0);
  const status = useSessionField((rt) => rt.status, null);
  const askOn = useApp(useShallow((s) => selectAskOn(s, key)));
  // Two different facts, deliberately not merged:
  //   - `init.permissions` is the **config-level scope** — what `auto_approve`,
  //     `auto_approve_tools`, `shell_allow` say in the config file. It is fixed
  //     for the life of the process.
  //   - `ui(state).permission` is what the runtime has **decided live** —
  //     `granted_tools` / `granted_prefixes` grow as a person presses "always
  //     allow". It carries no config-level scope at all, which is why reading
  //     the config rows from it showed "none" over a configured file.
  const configured = session?.permissions;
  const live = snap?.permission;
  const configuredRows = configured
    ? [
        configured.auto_approve?.length
          ? `auto_approve: ${configured.auto_approve.join(',')}`
          : '',
        configured.auto_approve_tools?.length
          ? `auto_approve_tools: ${configured.auto_approve_tools.join(',')}`
          : '',
        configured.deny_tools?.length ? `deny_tools: ${configured.deny_tools.join(',')}` : '',
        configured.shell_allow?.length ? `shell_allow: ${configured.shell_allow.join(',')}` : '',
      ].filter((part) => part !== '')
    : [];

  return (
    <PanelShell title={t('panel.audit.title')} note={t('cmd.audit.desc')}>
      <PanelBody>
        <dl className="kv">
          <dt>{t('panel.audit.desktopVersion')}</dt>
          <dd className="mono">v{desktopVersion}</dd>

          {/* `dev` is shown as-is: a build without ldflags is a dev build, and
              prettifying it would hide which binary is actually running. */}
          <dt>{t('panel.audit.runtimeVersion')}</dt>
          <dd className="mono">{runtimeVersion ?? '—'}</dd>

          <dt>{t('panel.audit.protocol')}</dt>
          <dd className="mono">v{session?.protocol ?? '—'}</dd>

          <dt>{t('panel.audit.workspace')}</dt>
          <dd className="mono" title={session?.workspace ?? ''}>
            {formatPath(session?.workspace ?? '—', 56)}
          </dd>

          <dt>{t('panel.audit.path')}</dt>
          <dd className="mono" title={session?.auditPath ?? ''}>
            {formatPath(session?.auditPath || '—', 56)}
          </dd>

          <dt>model</dt>
          <dd className="mono">
            {session?.model || '—'} @ {session?.provider || '—'}
          </dd>

          <dt>{t('panel.audit.contextWindow')}</dt>
          <dd className="mono">
            {session?.contextTokens === null || session?.contextTokens === undefined
              ? t('common.unknown')
              : formatTokens(session.contextTokens)}
          </dd>

          <dt>{t('session.permScope')}</dt>
          <dd className="mono">
            {askOn.length === 0 ? t('common.none') : askOn.join(', ')}
            {snap?.autopilot ? ` · ${t('session.permAuto')}` : ''}
          </dd>

          {/* Config-level scope. Read from `init`, which is the message that
              carries it (`ui(state)` never does) — the panel used to read the
              live snapshot here and reported "none" over a configured file. */}
          <dt>{t('panel.audit.permissions')}</dt>
          <dd className="mono">
            {configured ? configuredRows.join(' · ') || t('panel.audit.none') : t('common.unknown')}
          </dd>

          {/* Live authorization: what the runtime has released since start-up.
              Separate rows, because "written in the config file" and "allowed
              while this session ran" are different facts. */}
          <dt>{t('panel.audit.granted')}</dt>
          <dd className="mono">
            {live
              ? [
                  live.grantedTools.length > 0
                    ? `granted_tools: ${live.grantedTools.join(',')}`
                    : '',
                  live.grantedPrefixes.length > 0
                    ? `granted_prefixes: ${live.grantedPrefixes.join(',')}`
                    : '',
                  live.deniedTools.length > 0 ? `denied_tools: ${live.deniedTools.join(',')}` : '',
                ]
                  .filter((part) => part !== '')
                  .join(' · ') || t('panel.audit.none')
              : t('common.unknown')}
          </dd>

          {status?.meta?.catalog ? (
            <>
              <dt>catalogue</dt>
              <dd className="mono" title={status.meta.catalog}>
                {formatPath(status.meta.catalog, 56)}
              </dd>
            </>
          ) : null}

          {/* Two counters, because they are two facts. Summing them under one
              label made every delegation look like an ordering problem: those
              records carry the *child's* id, so they were "late" against the
              parent's turn and the count climbed with nothing actually late. */}
          <dt>{t('panel.audit.dropped')}</dt>
          <dd className="mono">
            {dropped}
            <span className="caption muted" style={{ marginLeft: 8 }}>
              {t('panel.audit.droppedNote')}
            </span>
          </dd>

          <dt>{t('panel.audit.late')}</dt>
          <dd className="mono">
            {lateDropped}
            <span className="caption muted" style={{ marginLeft: 8 }}>
              {t('panel.audit.lateNote')}
            </span>
          </dd>
        </dl>

        {snap && snap.agentsMd.length > 0 ? (
          <>
            <div className="etb-label">{t('panel.audit.agentsMd')}</div>
            <table className="table">
              <tbody>
                {snap.agentsMd.map((row) => (
                  <tr key={row.path}>
                    <td className="mono">{row.path}</td>
                    <td className="mono num">{row.lines}</td>
                    <td>
                      <Badge
                        tone={row.status === 'loaded' ? 'success' : row.status === 'ignored' ? 'warning' : 'destructive'}
                        dot={false}
                      >
                        {row.status}
                      </Badge>
                    </td>
                    <td className="caption muted">{row.problem ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}

        {snap && snap.riskScope.length > 0 ? (
          <>
            <div className="etb-label">{t('session.permScope')}</div>
            <table className="table">
              <tbody>
                {snap.riskScope.map((row) => (
                  <tr key={row.risk}>
                    <td style={{ width: 90 }}>
                      <RiskTag level={row.risk} />
                    </td>
                    <td>
                      <Badge tone={row.disposition === 'auto' ? 'success' : 'warning'} dot={false}>
                        {row.disposition === 'auto' ? t('inblock.auto') : t('inblock.ask')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </PanelBody>
    </PanelShell>
  );
}
