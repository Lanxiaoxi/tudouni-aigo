import { useMemo } from 'react';
import { Bot, Download, Upload } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { notesByServer } from '@/runtime/adapt';
import {
  NO_ALIASES,
  NO_JOBS,
  NO_MCP_ROWS,
  NO_MODEL_ROWS,
  NO_SESSION_LIST,
  NO_SKILLS,
  NO_STRINGS,
  NO_SUBAGENTS,
  selectAskOn,
  selectEffortLevels,
  useApp,
  useSessionField,
} from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { useListKeys } from '@/hooks/useListKeys';
import { Badge, EmptyState, RiskTag } from '@/components/ui/kit';
import { PanelBody, PanelRow, PanelShell } from './PanelShell';
import { COMMANDS } from '@/commands';
import { formatDuration, formatPath, formatRelative, formatTokens, oneLine } from '@/utils/format';

const closePanel = () => useApp.setState({ panel: null });

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
export function ResumePanel() {
  const t = useT();
  const list = useSessionField((rt) => rt.sessionList, NO_SESSION_LIST);
  const listed = useSessionField((rt) => rt.listedSessions, false);
  const openSession = useApp((s) => s.openSession);
  const currentId = useSessionField((rt) => rt.session?.id ?? null, null);

  const { active, setActive } = useListKeys({
    count: list.length,
    onClose: closePanel,
    onPick: (i) => list[i] && void openSession(list[i].id),
  });

  return (
    <PanelShell title={t('panel.resume.title')} count={list.length} note={t('cmd.resume.desc')}>
      <PanelBody>
        {!listed ? (
          <EmptyState title={t('common.loading')} />
        ) : list.length === 0 ? (
          <EmptyState title={t('panel.resume.empty')} />
        ) : (
          list.map((item, i) => (
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
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <span className="mono strong">{item.id}</span>
                <span className="caption faint">{t('panel.resume.messages', { n: item.messages })}</span>
                <span className="caption faint">{t('panel.resume.steps', { n: item.steps })}</span>
                {/* `todos` is ready-made progress text; an empty string means
                    there is no task list, which is not the same as zero. */}
                {item.todos ? <span className="caption faint">{item.todos}</span> : null}
              </div>
              <div className="caption muted truncate">{item.preview}</div>
            </PanelRow>
          ))
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
        <div className="cmdk-group">{t('panel.skills.loaded')}</div>
        {loaded.length === 0 ? (
          <EmptyState title={t('panel.skills.empty')} hint={t('empty.skills.hint')} />
        ) : (
          loaded.map((skill) => (
            <PanelRow key={skill.name} aside={<Badge tone="success" dot={false}>{t('panel.skills.loaded')}</Badge>}>
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <span className="mono strong">{skill.name}</span>
                {/* Empty means the runtime did not send a digest for this one —
                    unknown, not "no digest". */}
                {skill.digest !== '' ? <span className="caption faint mono">{skill.digest}</span> : null}
              </div>
              <div className="caption muted">
                {skill.description ?? t('common.unknown')}
              </div>
            </PanelRow>
          ))
        )}

        {/* What is left is what a person could still load — the difference
            between the catalogue and the loaded set. */}
        {available.length > 0 ? (
          <>
            <div className="cmdk-group">{t('panel.skills.available')}</div>
            {available.map((row) => (
              <PanelRow key={row.name}>
                <span className="mono muted">{row.name}</span>
                <div className="caption faint">{row.description ?? ''}</div>
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
  { keys: ['Ctrl', 'C'], label: 'key.exit' },
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
                      <Badge tone={row.status === 'loaded' ? 'success' : 'destructive'} dot={false}>
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
