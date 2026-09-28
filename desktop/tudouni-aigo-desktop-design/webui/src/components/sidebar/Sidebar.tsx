import type { ReactNode } from 'react';
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  CircleSlash,
  Loader,
} from 'lucide-react';
import { useApp, type SidebarBlockKey } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Badge, Count, EmptyState, Progress, Tip } from '@/components/ui/kit';
import { formatDuration, oneLine } from '@/utils/format';
import type {
  BackgroundJob,
  Goal,
  JobStatus,
  McpServer,
  TaskStatus,
} from '@/protocol/types';

/**
 * §3 侧栏 5 区块，顺序固定：Goal → Tasks → Loaded skills → Background jobs → MCP。
 *
 * 每块都是：标题 + 计数角标 + 内容行 + 空状态说明 + 空状态引导。
 * 装不下时**从底部丢弃并标注 (+N more)**，不许静默截断。
 * 折叠状态由 store 持久化，用户手动收起后不会被状态刷新弹回来。
 */
export function Sidebar() {
  const t = useT();
  const snap = useApp((s) => s.uiState);

  if (!snap) {
    return (
      <aside className="app-sidebar">
        <div className="sidebar-inner">
          <div className="caption" style={{ padding: 'var(--space-3) var(--space-2)' }}>
            {t('common.loading')}
          </div>
        </div>
      </aside>
    );
  }

  const caps = snap.caps;
  const doneTasks = snap.tasks.filter((x) => x.status === 'done').length;
  const uncollected = snap.background_jobs.filter((j) => !j.collected).length;
  const mcpRunning = snap.mcp.filter((m) => m.state === 'running').length;

  return (
    <aside className="app-sidebar">
      <div className="sidebar-inner scroll">
        {/* 1 · Goal */}
        <Block
          blockKey="goal"
          title={t('block.goal')}
          count={snap.goal ? snap.goal.turn : 0}
          isEmpty={snap.goal === null}
          emptyTitle={t('empty.goal.title')}
          emptyHint={t('empty.goal.hint')}
        >
          {snap.goal ? <GoalBody goal={snap.goal} /> : null}
        </Block>

        {/* 2 · Tasks */}
        <Block
          blockKey="tasks"
          title={t('block.tasks')}
          count={`${doneTasks}/${snap.tasks.length}`}
          isEmpty={snap.tasks.length === 0}
          emptyTitle={t('empty.tasks.title')}
          emptyHint={t('empty.tasks.hint')}
        >
          <div className="sb-progress">
            <Progress value={doneTasks} max={snap.tasks.length} />
            <span className="sbr-aside mono">
              {t('tasks.progress', { done: doneTasks, total: snap.tasks.length })}
            </span>
          </div>
          {snap.tasks.slice(0, caps.tasks).map((task) => (
            <div
              key={task.id}
              className={`sb-row${task.status === 'done' ? ' is-done' : ''}`}
            >
              <TaskMark status={task.status} />
              <span className="sbr-main" title={task.text}>
                {task.text}
              </span>
            </div>
          ))}
          <More count={snap.tasks.length - caps.tasks} />
        </Block>

        {/* 3 · Loaded skills */}
        <Block
          blockKey="skills"
          title={t('block.skills')}
          count={snap.skills.length}
          isEmpty={snap.skills.length === 0}
          emptyTitle={t('empty.skills.title')}
          emptyHint={t('empty.skills.hint')}
        >
          {snap.skills.slice(0, caps.skills).map((sk) => (
            <div key={sk.name} className="sb-row">
              <span className="sbr-main" title={sk.description}>
                <span className="mono">{sk.name}</span>
              </span>
            </div>
          ))}
          <More count={snap.skills.length - caps.skills} />
        </Block>

        {/* 4 · Background jobs */}
        <Block
          blockKey="jobs"
          title={t('block.jobs')}
          count={
            uncollected > 0
              ? `${uncollected} / ${snap.background_jobs.length}`
              : `${snap.background_jobs.length}`
          }
          countAttention={uncollected > 0}
          isEmpty={snap.background_jobs.length === 0}
          emptyTitle={t('empty.jobs.title')}
          emptyHint={t('empty.jobs.hint')}
        >
          {snap.background_jobs.slice(0, caps.jobs).map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
          <More count={snap.background_jobs.length - caps.jobs} />
        </Block>

        {/* 5 · MCP */}
        <Block
          blockKey="mcp"
          title={t('block.mcp')}
          count={`${mcpRunning} / ${snap.mcp.length}`}
          isEmpty={snap.mcp.length === 0}
          emptyTitle={t('empty.mcp.title')}
          emptyHint={t('empty.mcp.hint')}
        >
          {snap.mcp.slice(0, caps.mcp).map((srv) => (
            <McpRow key={srv.name} srv={srv} />
          ))}
          <More count={snap.mcp.length - caps.mcp} />
        </Block>
      </div>
    </aside>
  );
}

/* ---------------- 区块外壳 ---------------- */

function Block({
  blockKey,
  title,
  count,
  countAttention,
  isEmpty,
  emptyTitle,
  emptyHint,
  children,
}: {
  blockKey: SidebarBlockKey;
  title: string;
  count: number | string;
  countAttention?: boolean;
  isEmpty: boolean;
  emptyTitle: string;
  emptyHint: string;
  children?: ReactNode;
}) {
  const collapsed = useApp((s) => s.blockCollapsed[blockKey]);
  const toggleBlock = useApp((s) => s.toggleBlock);
  const t = useT();

  return (
    <section className="sb-block">
      <div
        className="sb-block-head"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => toggleBlock(blockKey)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleBlock(blockKey);
          }
        }}
      >
        <ChevronRight size={13} className={`caret${collapsed ? '' : ' caret-open'}`} />
        <span className="sbh-title">{title}</span>
        <Count value={count} attention={countAttention} />
        <span className="sr-only">{collapsed ? t('block.expand') : t('block.collapse')}</span>
      </div>

      {!collapsed ? (
        isEmpty ? (
          <EmptyState compact title={emptyTitle} hint={emptyHint} />
        ) : (
          <div className="sb-block-body">{children}</div>
        )
      ) : null}
    </section>
  );
}

function More({ count }: { count: number }) {
  const t = useT();
  if (count <= 0) return null;
  // 从底部丢弃并标注，不许静默截断（§3 行为规则）
  return <div className="list-more">{t('block.more', { n: count })}</div>;
}

/* ---------------- Goal ---------------- */

function GoalBody({ goal }: { goal: Goal }) {
  const t = useT();
  return (
    <div className="sb-goal">
      <div className="sg-text" title={goal.text}>
        {goal.text}
      </div>
      {goal.truncated ? <div className="caption faint">{t('goal.truncated')}</div> : null}

      <div className="sg-meta">
        <Badge tone={goal.armed ? 'success' : 'neutral'} dot={false}>
          {goal.armed ? t('goal.armed') : t('goal.disarmed')}
        </Badge>
        <span className="caption faint">{goal.phase}</span>
        <span className="caption faint">{t('goal.turn', { n: goal.turn })}</span>
      </div>

      {goal.blocked_reason ? (
        <div className="sg-blocked">{t('goal.blocked', { reason: goal.blocked_reason })}</div>
      ) : null}
    </div>
  );
}

/* ---------------- Tasks ---------------- */

function TaskMark({ status }: { status: TaskStatus }) {
  const t = useT();
  const map: Record<TaskStatus, ReactNode> = {
    done: <CheckCircle2 size={12} color="var(--accent)" />,
    in_progress: <Loader size={12} color="var(--info)" />,
    pending: <CircleDashed size={12} color="var(--fg-faint)" />,
    blocked: <CircleSlash size={12} color="var(--warning)" />,
  };
  const label = {
    done: t('tasks.done'),
    in_progress: t('tasks.inProgress'),
    pending: t('tasks.pending'),
    blocked: t('tasks.blocked'),
  }[status];

  return (
    <Tip label={label}>
      <span style={{ display: 'inline-flex', flex: 'none' }} aria-label={label}>
        {map[status]}
      </span>
    </Tip>
  );
}

/* ---------------- Background jobs ---------------- */

const JOB_TONE: Record<JobStatus, 'success' | 'warning' | 'destructive' | 'neutral'> = {
  running: 'success',
  done: 'neutral',
  failed: 'destructive',
  killed: 'warning',
};

function JobRow({ job }: { job: BackgroundJob }) {
  const t = useT();
  const statusLabel: Record<JobStatus, string> = {
    running: t('jobs.running'),
    done: t('jobs.done'),
    failed: t('jobs.failed'),
    killed: t('jobs.killed'),
  };

  // 窄侧栏下这行放不下「名字 + 全部明细」，明细允许被省略，
  // 完整文本挂 title，hover 可看全。未收结果用 is-uncollected 着色 + 文案双重标记。
  const aside = `${!job.collected ? `${t('jobs.uncollected')} · ` : ''}${formatDuration(job.duration_ms)}${
    job.exit_code !== null ? ` · ${t('jobs.exit', { n: job.exit_code })}` : ''
  }`;

  return (
    <div className={`sb-row${job.collected ? '' : ' is-uncollected'}`}>
      <Badge tone={JOB_TONE[job.status]} dot={false}>
        {statusLabel[job.status]}
      </Badge>
      <span className="sbr-main" title={job.command}>
        <span className="mono">{oneLine(job.command, 40)}</span>
      </span>
      <span className="sbr-aside" title={aside}>
        {aside}
      </span>
    </div>
  );
}

/* ---------------- MCP ---------------- */

function McpRow({ srv }: { srv: McpServer }) {
  const t = useT();
  const tone = srv.state === 'running' ? 'success' : srv.state === 'failed' ? 'destructive' : 'neutral';
  // 三态不可合并（§5），所以文案与着色都分开
  const label =
    srv.state === 'running'
      ? t('mcp.running')
      : srv.state === 'configured'
        ? t('mcp.configured')
        : t('mcp.failed');

  return (
    <div className="sb-row">
      <Bot size={12} className="muted" />
      <span className="sbr-main" title={srv.launch}>
        <span className="mono">{srv.name}</span>
        {srv.state === 'failed' && srv.error ? (
          <span className="faint"> · {oneLine(srv.error, 28)}</span>
        ) : null}
      </span>
      <span className="sbr-aside">
        {srv.state === 'failed' ? '' : t('mcp.tools', { n: srv.tool_count })}
      </span>
      <Badge tone={tone} dot={false}>
        {label}
      </Badge>
    </div>
  );
}
