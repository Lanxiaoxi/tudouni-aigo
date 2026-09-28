import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';

/**
 * §1·5 折叠摘要行。
 *
 * 侧栏隐去时的一行摘要：哪些会问 / 后台任务 / MCP / 任务 / 技能。
 * 侧栏可见时不渲染（由 App 控制），避免与侧栏重复。
 */
export function CollapsedSummary() {
  const t = useT();
  const snap = useApp((s) => s.uiState);
  const scope = useApp((s) => s.permissionScope);
  const setSidebarVisible = useApp((s) => s.setSidebarVisible);

  if (!snap) {
    return (
      <div className="collapsed-summary">
        <span className="cs-item">{t('common.sidebarHidden')}</span>
        <button
          type="button"
          className="btn btn-ghost btn-compact"
          onClick={() => setSidebarVisible(true)}
        >
          {t('common.show')}
        </button>
      </div>
    );
  }

  const jobTotal = snap.background_jobs.length;
  const jobUncollected = snap.background_jobs.filter((j) => !j.collected).length;
  const mcpRunning = snap.mcp.filter((m) => m.state === 'running').length;
  const taskDone = snap.tasks.filter((x) => x.status === 'done').length;
  const ask = scope
    ? scope.autopilot
      ? t('session.permAuto')
      : scope.ask_on.map((r) => t(`risk.${r}`)).join('+')
    : '—';

  return (
    <div className="collapsed-summary">
      <button
        type="button"
        className="btn btn-ghost btn-compact"
        onClick={() => setSidebarVisible(true)}
        title={t('common.show')}
      >
        {t('common.sidebarHidden')}
      </button>

      <span className="cs-item">
        <span>{t('session.permScope')}</span>
        <b>{ask}</b>
      </span>

      <span className="cs-item">
        <span>{t('block.jobs')}</span>
        <b>
          {jobTotal === 0
            ? '0'
            : `${jobUncollected > 0 ? `${jobUncollected} / ` : ''}${jobTotal}`}
        </b>
      </span>

      <span className="cs-item">
        <span>{t('block.mcp')}</span>
        <b>
          {mcpRunning} / {snap.mcp.length}
        </b>
      </span>

      <span className="cs-item">
        <span>{t('block.tasks')}</span>
        <b>
          {taskDone} / {snap.tasks.length}
        </b>
      </span>

      <span className="cs-item">
        <span>{t('block.skills')}</span>
        <b>{snap.skills.length}</b>
      </span>
    </div>
  );
}
