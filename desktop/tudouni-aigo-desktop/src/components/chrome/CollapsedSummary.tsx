import { useShallow } from 'zustand/react/shallow';
import { useApp, useSessionField, selectAskOn } from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';

/**
 * §1·5 The collapsed summary row.
 *
 * One line standing in for the right rail while it is folded: which risks will
 * be asked about, background jobs, MCP, tasks, skills. Rendered only when that
 * rail is folded, so the two never say the same thing twice.
 *
 * **It is the conversation column's second header, not a window-level strip.**
 * It sits inside `.app-conversation`, directly under `.sessionbar`, so it is
 * exactly as wide as the row above it — everything on it (jobs, MCP, tasks,
 * skills) is a fact about the conversation beside it, and a bar spanning under
 * both rails read as a third piece of window chrome belonging to no column.
 *
 * **There is no "Sidebar hidden" text and no `Show` button here any more.**
 * Both existed to announce the fold and to undo it, and both were the second
 * half of the mistake the two in-rail collapse buttons made: the row that
 * replaces a rail is the *worst* place to put the control that brings it back,
 * because it is only on screen once the rail is gone. The way back is the
 * right-hand toggle at the trailing edge of `SessionBar`, which is on screen in
 * both states. A row whose only job is the values keeps reading as a statement
 * rather than as an apology for the missing rail.
 */
export function CollapsedSummary() {
  const t = useT();
  const key = useApp((s) => s.activeKey);
  const snap = useSessionField((rt) => rt.uiState, null);
  const autopilot = useSessionField((rt) => rt.uiState?.autopilot ?? false, false);
  const askOn = useApp(useShallow((s) => selectAskOn(s, key)));

  // Before the handshake there is nothing to report. The row is still drawn —
  // it is the fold the session bar's toggle animates — but it carries no
  // placeholder text: an empty strip is honest, and "Sidebar hidden" was a
  // sentence about the chrome rather than about the session.
  if (!snap) return <div className="collapsed-summary" />;

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

      {/* The collapsed line answers the same question the SSH block's badge
          answers: how many connections are actually live. Ended sessions the
          list still keeps are history, and counting them here would read
          "2 SSH" over shells that are already gone — the same rule the TUI's
          summary segment follows (`internal/frontends/tui/rail.go`). */}
      <span className="cs-item">
        <span>{t('block.ssh')}</span>
        <b>{snap.ssh.filter((row) => row.status === 'running').length}</b>
      </span>
    </div>
  );
}
