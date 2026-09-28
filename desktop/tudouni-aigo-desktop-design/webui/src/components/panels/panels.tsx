import { useMemo } from 'react';
import { Bot, Download, Upload } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { useListKeys } from '@/hooks/useListKeys';
import { Badge, Count, EmptyState } from '@/components/ui/kit';
import { PanelBody, PanelRow, PanelShell } from './PanelShell';
import { COMMANDS } from '@/commands';
import { formatDuration, formatPath, formatRelative, formatTokens, oneLine } from '@/utils/format';
import type { ThemePref } from '@/state/store';

const closePanel = () => useApp.setState({ panel: null });

/* ============================================================
   模型选择 —— 同名模型跨路由时必须能区分（§5）
   ============================================================ */
export function ModelPanel() {
  const t = useT();
  const models = useApp((s) => s.models);
  const chooseModel = useApp((s) => s.chooseModel);

  const { active, setActive } = useListKeys({
    count: models.length,
    onClose: closePanel,
    onPick: (i) => models[i] && chooseModel(models[i].name),
  });

  return (
    <PanelShell title={t('panel.model.title')} count={models.length} note={t('cmd.model.desc')}>
      <PanelBody>
        {models.length === 0 ? (
          <EmptyState title={t('panel.resume.empty')} />
        ) : (
          models.map((m, i) => (
            <PanelRow
              key={`${m.name}@${m.route}`}
              index={i + 1}
              active={active === i}
              selected={m.current}
              onHover={() => setActive(i)}
              onPick={() => chooseModel(m.name)}
              aside={
                m.current ? (
                  <Badge tone="success" dot={false}>
                    {t('panel.model.current')}
                  </Badge>
                ) : null
              }
            >
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <span className="mono strong">{m.name}</span>
                <Badge tone="neutral" dot={false}>
                  {t('panel.model.route')} {m.route}
                </Badge>
                <span className="caption faint">
                  {t('panel.model.window')}{' '}
                  {m.context_window === null ? t('common.unknown') : formatTokens(m.context_window)}
                </span>
              </div>
              <div className="caption muted">{m.description}</div>
            </PanelRow>
          ))
        )}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   思考强度 —— 清单随模型变，不许前端写死（§5）
   ============================================================ */
export function EffortPanel() {
  const t = useT();
  const efforts = useApp((s) => s.uiState?.efforts ?? []);
  const current = useApp((s) => s.session?.effort ?? null);
  const chooseEffort = useApp((s) => s.chooseEffort);

  const { active, setActive } = useListKeys({
    count: efforts.length,
    onClose: closePanel,
    onPick: (i) => efforts[i] && chooseEffort(efforts[i].id),
  });

  return (
    <PanelShell
      title={t('panel.effort.title')}
      count={efforts.length}
      note={t('panel.effort.note')}
    >
      <PanelBody>
        {efforts.length === 0 ? (
          <EmptyState title={t('common.loading')} />
        ) : (
          efforts.map((e, i) => (
            <PanelRow
              key={e.id}
              index={i + 1}
              active={active === i}
              selected={e.id === current}
              onHover={() => setActive(i)}
              onPick={() => chooseEffort(e.id)}
              aside={
                e.id === current ? (
                  <Badge tone="success" dot={false}>
                    {t('panel.model.current')}
                  </Badge>
                ) : null
              }
            >
              <div className="row">
                <span className="mono strong">{e.label}</span>
                <span className="caption muted">{e.description}</span>
              </div>
            </PanelRow>
          ))
        )}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   主题
   ============================================================ */
const THEME_ORDER: ThemePref[] = ['system', 'dark', 'light'];

export function ThemePanel() {
  const t = useT();
  const pref = useApp((s) => s.themePref);
  const setThemePref = useApp((s) => s.setThemePref);

  const { active, setActive } = useListKeys({
    count: THEME_ORDER.length,
    onClose: closePanel,
    onPick: (i) => setThemePref(THEME_ORDER[i]),
  });

  return (
    <PanelShell title={t('panel.theme.title')} count={THEME_ORDER.length}>
      <PanelBody>
        {THEME_ORDER.map((p, i) => (
          <PanelRow
            key={p}
            index={i + 1}
            active={active === i}
            selected={p === pref}
            onHover={() => setActive(i)}
            onPick={() => setThemePref(p)}
            aside={
              p === pref ? (
                <Badge tone="success" dot={false}>
                  {t('panel.model.current')}
                </Badge>
              ) : null
            }
          >
            <span>{t(`panel.theme.${p}` as TKey)}</span>
          </PanelRow>
        ))}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   会话选择 —— 预览与进度由运行时算好，前端不读会话文件（§5）
   ============================================================ */
export function ResumePanel() {
  const t = useT();
  const list = useApp((s) => s.sessionList);
  const total = useApp((s) => s.sessionTotal);
  const listed = useApp((s) => s.listedSessions);
  const switchSession = useApp((s) => s.switchSession);
  const currentId = useApp((s) => s.session?.id ?? null);

  const sorted = useMemo(
    () => [...list].sort((a, b) => b.modified_at - a.modified_at),
    [list],
  );

  const { active, setActive } = useListKeys({
    count: sorted.length,
    onClose: closePanel,
    onPick: (i) => sorted[i] && switchSession(sorted[i].id),
  });

  return (
    <PanelShell
      title={t('panel.resume.title')}
      count={`${sorted.length} / ${total}`}
      note={t('cmd.resume.desc')}
    >
      <PanelBody>
        {!listed ? (
          <EmptyState title={t('common.loading')} />
        ) : sorted.length === 0 ? (
          <EmptyState title={t('panel.resume.empty')} />
        ) : (
          sorted.map((s, i) => (
            <PanelRow
              key={s.id}
              index={i + 1}
              active={active === i}
              selected={s.id === currentId}
              onHover={() => setActive(i)}
              onPick={() => switchSession(s.id)}
              aside={formatRelative(s.modified_at)}
            >
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <span className="mono strong">{s.id}</span>
                <span className="caption faint">
                  {t('panel.resume.messages', { n: s.message_count })}
                </span>
                <span className="caption faint">{t('panel.resume.steps', { n: s.step_count })}</span>
                <span className="caption faint">
                  {t('panel.resume.tasks', { done: s.task_done, total: s.task_total })}
                </span>
              </div>
              <div className="caption muted truncate">{s.preview}</div>
            </PanelRow>
          ))
        )}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   MCP —— 三态不可合并（§5）
   ============================================================ */
export function McpPanel() {
  const t = useT();
  const servers = useApp((s) => s.uiState?.mcp ?? []);
  const send = useApp((s) => s.send);

  function toggle(index: number) {
    const s = servers[index];
    if (!s) return;
    if (s.state === 'running') send({ type: 'mcp', action: 'unload', name: s.name });
    else if (s.state === 'configured') send({ type: 'mcp', action: 'load', name: s.name });
    else send({ type: 'mcp', action: 'list' });
  }

  const { active, setActive } = useListKeys({
    count: servers.length,
    onClose: closePanel,
    onPick: toggle,
  });

  return (
    <PanelShell
      title={t('panel.mcp.title')}
      count={servers.length}
      note={t('cmd.mcp.desc')}
    >
      <PanelBody>
        {servers.length === 0 ? (
          <EmptyState title={t('panel.mcp.empty')} hint={t('empty.mcp.hint')} />
        ) : (
          servers.map((s, i) => {
            const tone =
              s.state === 'running' ? 'success' : s.state === 'failed' ? 'destructive' : 'neutral';
            const label =
              s.state === 'running'
                ? t('mcp.running')
                : s.state === 'configured'
                  ? t('mcp.configured')
                  : t('mcp.failed');

            return (
              <PanelRow
                key={s.name}
                index={i + 1}
                active={active === i}
                onHover={() => setActive(i)}
                onPick={() => toggle(i)}
                aside={
                  s.state === 'failed' ? null : (
                    <span className="row" style={{ gap: 'var(--space-1)' }}>
                      {s.state === 'running' ? <Upload size={11} /> : <Download size={11} />}
                      {s.state === 'running' ? t('mcp.unload') : t('mcp.load')}
                    </span>
                  )
                }
              >
                <div className="row" style={{ gap: 'var(--space-2)' }}>
                  <span className="mono strong">{s.name}</span>
                  <Badge tone={tone} dot={false}>
                    {label}
                  </Badge>
                  {s.state !== 'failed' ? (
                    <span className="caption faint">{t('mcp.tools', { n: s.tool_count })}</span>
                  ) : null}
                </div>
                <div className="caption muted truncate mono" title={s.launch}>
                  {s.launch}
                </div>
                {s.error ? <div className="caption" style={{ color: 'var(--destructive)' }}>{s.error}</div> : null}
              </PanelRow>
            );
          })
        )}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   技能 —— 还要能显示被跳过的技能及原因（§5）
   ============================================================ */
export function SkillsPanel() {
  const t = useT();
  const catalog = useApp((s) => s.skillsCatalog);
  const loaded = useApp((s) => s.uiState?.skills ?? []);

  const loadedNames = new Set(loaded.map((s) => s.name));
  const skipped = catalog.filter((s) => s.skipped);

  return (
    <PanelShell
      title={t('panel.skills.title')}
      count={`${loaded.length} / ${catalog.length}`}
      note={t('cmd.skills.desc')}
    >
      <PanelBody>
        {catalog.length === 0 ? (
          <EmptyState title={t('panel.skills.empty')} />
        ) : (
          <>
            {catalog
              .filter((s) => !s.skipped)
              .map((s) => (
                <PanelRow
                  key={s.name}
                  aside={
                    loadedNames.has(s.name) ? (
                      <Badge tone="success" dot={false}>
                        {t('block.skills')}
                      </Badge>
                    ) : null
                  }
                >
                  <div className="row" style={{ gap: 'var(--space-2)' }}>
                    <span className="mono strong">{s.name}</span>
                  </div>
                  <div className="caption muted">{s.description}</div>
                </PanelRow>
              ))}

            {skipped.length > 0 ? (
              <>
                <div className="cmdk-group">{t('panel.skills.skipped')}</div>
                {skipped.map((s) => (
                  <PanelRow
                    key={s.name}
                    aside={
                      <Badge tone="warning" dot={false}>
                        {t('panel.skills.skipped')}
                      </Badge>
                    }
                  >
                    <div className="row" style={{ gap: 'var(--space-2)' }}>
                      <span className="mono muted">{s.name}</span>
                    </div>
                    <div className="caption faint">{s.reason}</div>
                  </PanelRow>
                ))}
              </>
            ) : null}
          </>
        )}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   帮助 —— 命令表 + 快捷键表（§5）
   ============================================================ */
const KEY_ROWS: Array<{ keys: string[]; label: TKey }> = [
  { keys: ['Enter'], label: 'key.send' },
  { keys: ['Shift', 'Enter'], label: 'key.newline' },
  { keys: ['Esc'], label: 'key.esc' },
  { keys: ['Ctrl', 'C'], label: 'key.exit' },
  { keys: ['↑', '↓', 'PgUp', 'PgDn'], label: 'key.move' },
  { keys: ['Ctrl', 'T'], label: 'key.thinking' },
  { keys: ['Ctrl', 'B'], label: 'key.sidebar' },
  { keys: ['Ctrl', 'K'], label: 'key.palette' },
  { keys: ['Ctrl', 'S'], label: 'key.skills' },
  { keys: ['Ctrl', 'A', 'E', 'W', 'U'], label: 'key.edit' },
  { keys: ['1', '9'], label: 'key.pick' },
  { keys: ['Ctrl', '↑', '↓'], label: 'key.history' },
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
            {COMMANDS.map((c, i) => (
              <tr key={c.id}>
                <td className="num">{i + 1}</td>
                <td className="mono strong">{c.name}</td>
                <td className="muted">{t(c.descKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="etb-label" style={{ marginTop: 'var(--space-3)' }}>
          {t('panel.help.keys')}
        </div>
        <table className="table">
          <tbody>
            {KEY_ROWS.map((r) => (
              <tr key={r.label}>
                <td style={{ width: 220 }}>
                  <span className="row" style={{ gap: 3 }}>
                    {r.keys.map((k) => (
                      <kbd className="kbd" key={k}>
                        {k}
                      </kbd>
                    ))}
                  </span>
                </td>
                <td className="muted">{t(r.label)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   子代理明细（§4 末段：状态栏给角标，明细另设入口）
   ============================================================ */
export function SubagentsPanel() {
  const t = useT();
  const snap = useApp((s) => s.uiState);
  const agents = snap?.subagents ?? [];
  const jobs = snap?.background_jobs ?? [];

  const { active, setActive } = useListKeys({
    count: agents.length,
    onClose: closePanel,
    onPick: () => undefined,
  });

  return (
    <PanelShell
      title={t('panel.subagents.title')}
      count={`${agents.length} + ${jobs.length}`}
    >
      <PanelBody>
        <div className="etb-label">{t('status.subagents')}</div>
        {agents.length === 0 ? (
          <EmptyState title={t('panel.subagents.empty')} />
        ) : (
          agents.map((a, i) => (
            <PanelRow
              key={a.id}
              index={i + 1}
              active={active === i}
              onHover={() => setActive(i)}
              aside={formatDuration(Date.now() - a.started_ms)}
            >
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <Bot size={12} className="muted" />
                <span className="strong">{a.label}</span>
                <span className="mono caption faint">
                  {a.model} · depth {a.depth} · {a.calls} calls
                </span>
              </div>
              <div className="caption muted">{a.activity}</div>
            </PanelRow>
          ))
        )}

        <div className="etb-label" style={{ marginTop: 'var(--space-3)' }}>
          {t('block.jobs')}
        </div>
        {jobs.length === 0 ? (
          <EmptyState title={t('empty.jobs.title')} hint={t('empty.jobs.hint')} />
        ) : (
          jobs.map((j) => (
            <PanelRow
              key={j.id}
              aside={
                <>
                  {!j.collected ? (
                    <Badge tone="warning" dot={false}>
                      {t('jobs.uncollected')}
                    </Badge>
                  ) : null}{' '}
                  {formatDuration(j.duration_ms)}
                  {j.exit_code !== null ? ` · ${t('jobs.exit', { n: j.exit_code })}` : ''}
                </>
              }
            >
              <span className="mono">{oneLine(j.command, 72)}</span>
            </PanelRow>
          ))
        )}
      </PanelBody>
    </PanelShell>
  );
}

/* ============================================================
   审计与接线
   ============================================================ */
export function AuditPanel() {
  const t = useT();
  const snap = useApp((s) => s.uiState);
  const workspace = useApp((s) => s.workspace);
  const version = useApp((s) => s.version);
  const dropped = useApp((s) => s.dropped);
  const model = useApp((s) => s.session?.model ?? '—');
  const route = useApp((s) => s.session?.model_route ?? '—');

  return (
    <PanelShell title={t('panel.audit.title')} note={t('cmd.audit.desc')}>
      <PanelBody>
        <dl className="kv">
          <dt>{t('panel.audit.version')}</dt>
          <dd className="mono">v{version}</dd>

          <dt>{t('panel.audit.workspace')}</dt>
          <dd className="mono" title={workspace}>
            {formatPath(workspace, 56)}
          </dd>

          <dt>{t('panel.audit.path')}</dt>
          <dd className="mono" title={snap?.audit_path ?? ''}>
            {formatPath(snap?.audit_path ?? '—', 56)}
          </dd>

          <dt>model</dt>
          <dd className="mono">
            {model} @ {route}
          </dd>

          <dt>{t('panel.audit.dropped')}</dt>
          <dd className="mono">
            <Count value={dropped} attention={dropped > 0} />
            <span className="caption muted" style={{ marginLeft: 8 }}>
              {t('panel.audit.droppedNote')}
            </span>
          </dd>
        </dl>
      </PanelBody>
    </PanelShell>
  );
}
