import type { ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useApp, useSessionField, selectAskOn, type SidebarBlockKey } from '@/state/store';
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
  const openSidebarBlock = useApp((s) => s.openSidebarBlock);

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

      <CsItem
        blockKey="jobs"
        label={t('block.jobs')}
        onOpen={openSidebarBlock}
        attention={jobUncollected > 0}
      >
        {jobTotal === 0
          ? '0'
          : `${jobUncollected > 0 ? `${jobUncollected} / ` : ''}${jobTotal}`}
      </CsItem>

      <CsItem blockKey="mcp" label={t('block.mcp')} onOpen={openSidebarBlock}>
        {mcpLoaded} / {snap.mcp.length}
      </CsItem>

      <CsItem blockKey="tasks" label={t('block.tasks')} onOpen={openSidebarBlock}>
        {taskDone} / {snap.todos.length}
      </CsItem>

      <CsItem blockKey="skills" label={t('block.skills')} onOpen={openSidebarBlock}>
        {snap.skills.length}
      </CsItem>

      {/* The collapsed line answers the same question the SSH block's badge
          answers: how many connections are actually live. Ended sessions the
          list still keeps are history, and counting them here would read
          "2 SSH" over shells that are already gone — the same rule the TUI's
          summary segment follows (`internal/frontends/tui/rail.go`). */}
      <CsItem blockKey="ssh" label={t('block.ssh')} onOpen={openSidebarBlock}>
        {snap.ssh.filter((row) => row.status === 'running').length}
      </CsItem>
    </div>
  );
}

/**
 * One clickable summary chip: a label and a figure that used to be a plain
 * span, now a button whose press brings the right rail back **and** unfolds the
 * block it summarises (`openSidebarBlock`). The row stands in for a folded
 * rail, so its chips are the shortest way back into the exact list they count —
 * opening only the rail would leave the person hunting for one of six blocks.
 *
 * `attention` marks the same uncollected-result state the rail's badge and the
 * status bar's jobs button emphasise: colour, never a new word.
 */
function CsItem({
  blockKey,
  label,
  onOpen,
  attention,
  children,
}: {
  blockKey: SidebarBlockKey;
  label: string;
  onOpen: (k: SidebarBlockKey) => void;
  attention?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`cs-item${attention ? ' is-attention' : ''}`}
      onClick={() => onOpen(blockKey)}
      aria-label={label}
    >
      <span>{label}</span>
      <b>{children}</b>
    </button>
  );
}
