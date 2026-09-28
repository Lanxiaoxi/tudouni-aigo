import { useShallow } from 'zustand/react/shallow';
import { useApp, selectAskOn } from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';

/**
 * §1·5 The collapsed summary row.
 *
 * One line standing in for the sidebar while it is hidden: which risks will be
 * asked about, background jobs, MCP, tasks, skills. Rendered only when the
 * sidebar is hidden, so the two never say the same thing twice.
 */
export function CollapsedSummary() {
  const t = useT();
  const snap = useApp((s) => s.uiState);
  const autopilot = useApp((s) => s.uiState?.autopilot ?? false);
  const askOn = useApp(useShallow(selectAskOn));
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

  const jobTotal = snap.jobs.length;
  const jobUncollected = snap.jobs.filter((job) => job.uncollected).length;
  const mcpLoaded = snap.mcp.filter((server) => server.state === 'loaded').length;
  const taskDone = snap.todos.filter((todo) => todo.status === 'completed').length;

  const ask = autopilot
    ? t('session.permAuto')
    : askOn.length === 0
      ? t('session.permNone')
      : askOn.map((risk) => t(`risk.${risk}` as TKey)).join('+');

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
          {mcpLoaded} / {snap.mcp.length}
        </b>
      </span>

      <span className="cs-item">
        <span>{t('block.tasks')}</span>
        <b>
          {taskDone} / {snap.todos.length}
        </b>
      </span>

      <span className="cs-item">
        <span>{t('block.skills')}</span>
        <b>{snap.skills.length}</b>
      </span>
    </div>
  );
}
