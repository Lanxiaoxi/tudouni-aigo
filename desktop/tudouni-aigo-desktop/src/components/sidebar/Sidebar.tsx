import type { ReactNode } from 'react';
import { CheckCircle2, ChevronRight, CircleDashed, Loader } from 'lucide-react';
import { NO_SKILLS, useApp, useSessionField, type SidebarBlockKey } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Badge, BusyDots, Count, EmptyState, Progress, Tip } from '@/components/ui/kit';
import { oneLine } from '@/utils/format';
import type { JobState } from '@/protocol/types';
import type { VmGoal, VmJob, VmMcp, VmTask } from '@/runtime/adapt';

/**
 * §3 Sidebar, five blocks, fixed order:
 * Goal → Tasks → Loaded skills → Background jobs → MCP.
 *
 * Each block is: title + count badge + content rows + empty-state text + a
 * pointer.
 *
 * **There is no content cap.** Decision 6 used to put one here — five rows each,
 * with the rest collapsed into `(+N more)` — and it was wrong for this surface,
 * for the reason the TUI's equivalent is right for that one: the reference front
 * end draws a **fixed-height, non-scrolling** column (`internal/frontends/tui/
 * rail.go`, `railMaxRows` / `clipBlock`), so it has to clip or a block becomes
 * unreachable. This rail scrolls (`.sidebar-inner` is `overflow-y: auto`), so
 * clipping here only hides rows the reader could have scrolled to — it was a
 * terminal constraint carried across by mistake.
 *
 * "Never silently truncated" still holds, and now it means something narrower:
 * nothing hides rows with CSS instead of showing them.
 */
export function Sidebar() {
  const t = useT();
  // The right rail describes **this conversation**: its goal, its tasks, its
  // loaded skills, its background jobs, its MCP servers. Every one of those is a
  // property of a session rather than of the window, so the whole rail follows
  // the session on screen.
  const snap = useSessionField((rt) => rt.uiState, null);
  // The merged loaded set (from `ui(skills).active` + `ui(state)` pointers),
  // not the snapshot's own pointer list.
  const loadedSkills = useSessionField((rt) => rt.skills, NO_SKILLS);

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

  const doneTasks = snap.todos.filter((todo) => todo.status === 'completed').length;
  const uncollected = snap.jobs.filter((job) => job.uncollected).length;
  const outstanding = snap.jobs.filter((job) => job.outstanding).length;
  const mcpLoaded = snap.mcp.filter((server) => server.state === 'loaded').length;

  return (
    <aside className="app-sidebar">
      <div className="sidebar-inner scroll">
        {/* 1 · Goal */}
        <Block
          blockKey="goal"
          title={t('block.goal')}
          count={snap.goal.roundsText || (snap.goal.present ? '—' : '0')}
          isEmpty={!snap.goal.present}
          emptyTitle={t('empty.goal.title')}
          emptyHint={t('empty.goal.hint')}
        >
          <GoalBody goal={snap.goal} />
        </Block>

        {/* 2 · Tasks */}
        <Block
          blockKey="tasks"
          title={t('block.tasks')}
          count={`${doneTasks}/${snap.todos.length}`}
          isEmpty={snap.todos.length === 0}
          emptyTitle={t('empty.tasks.title')}
          emptyHint={t('empty.tasks.hint')}
        >
          <div className="sb-progress">
            <Progress value={doneTasks} max={snap.todos.length} />
            <span className="sbr-aside mono">
              {t('tasks.progress', { done: doneTasks, total: snap.todos.length })}
            </span>
          </div>
          {snap.todos.map((task, index) => (
            <TaskRow key={`${task.content}-${index}`} task={task} />
          ))}
        </Block>

        {/* 3 · Loaded skills.
            `snap.skills` is `ui(state).skills`, which is pointers for whatever
            the snapshot happened to record; the merged store list is what
            `ui(skills).active` says is actually loaded. The sidebar shows the
            loaded set, so it reads the latter. */}
        <Block
          blockKey="skills"
          title={t('block.skills')}
          count={loadedSkills.length}
          isEmpty={loadedSkills.length === 0}
          emptyTitle={t('empty.skills.title')}
          emptyHint={t('empty.skills.hint')}
        >
          {loadedSkills.map((skill) => (
            <div key={skill.name} className="sb-row">
              {/* The description only exists in the first snapshot's catalog, so
                  it may legitimately be null. */}
              <span className="sbr-main" title={skill.description ?? undefined}>
                <span className="mono">{skill.name}</span>
              </span>
            </div>
          ))}
        </Block>

        {/* 4 · Background jobs */}
        <Block
          blockKey="jobs"
          title={t('block.jobs')}
          count={
            outstanding > 0 ? `${outstanding} / ${snap.jobs.length}` : `${snap.jobs.length}`
          }
          countAttention={uncollected > 0}
          isEmpty={snap.jobs.length === 0}
          emptyTitle={t('empty.jobs.title')}
          emptyHint={t('empty.jobs.hint')}
        >
          {snap.jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </Block>

        {/* 5 · MCP */}
        <Block
          blockKey="mcp"
          title={t('block.mcp')}
          count={`${mcpLoaded} / ${snap.mcp.length}`}
          isEmpty={snap.mcp.length === 0}
          emptyTitle={t('empty.mcp.title')}
          emptyHint={t('empty.mcp.hint')}
        >
          {snap.mcp.map((server) => (
            <McpRow key={server.name} server={server} />
          ))}
        </Block>
      </div>
    </aside>
  );
}

/* ---------------- block shell ---------------- */

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

      {/* The body is **kept mounted** and folded with `.collapse`, rather than
          being conditionally rendered. A conditionally rendered element has
          nothing to transition — it is there in one frame and gone in the next —
          so an expand/collapse animation requires the element to stay and only
          its height to change.

          `inert` while folded, not `aria-hidden`: these bodies contain buttons
          (and, for a block, a whole list), and `aria-hidden` over focusable
          content is the "aria-hidden-focus" violation — a screen reader is told
          to ignore something the Tab key still reaches. `inert` removes it from
          both the accessibility tree and the tab order, which is what "folded"
          actually means. */}
      <div className={`collapse${collapsed ? ' is-collapsed' : ''}`} inert={collapsed}>
        <div>
          {isEmpty ? (
            <EmptyState compact title={emptyTitle} hint={emptyHint} />
          ) : (
            <div className="sb-block-body">{children}</div>
          )}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Goal ---------------- */

function GoalBody({ goal }: { goal: VmGoal }) {
  const t = useT();
  return (
    <div className="sb-goal">
      <div className="sg-text" title={goal.objective}>
        {goal.objective}
      </div>

      <div className="sg-meta">
        <Badge tone={goal.armed ? 'success' : 'neutral'} dot={false}>
          {goal.armed ? t('goal.armed') : t('goal.disarmed')}
        </Badge>
        {goal.phase ? <span className="caption faint">{goal.phase}</span> : null}
        {goal.roundsText ? (
          <span className="caption faint">{t('goal.rounds', { text: goal.roundsText })}</span>
        ) : null}
        {goal.limitReached ? (
          <Badge tone="warning" dot={false}>
            {t('goal.limitReached')}
          </Badge>
        ) : null}
      </div>

      {/* The blocked reason is the one thing a person has to act on, so it is
          rendered from whichever field the runtime filled in. */}
      {goal.blockedMessage || goal.blockedCode ? (
        <div className="sg-blocked">
          {t('goal.blocked', { reason: goal.blockedMessage || goal.blockedCode })}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- Tasks ---------------- */

function TaskRow({ task }: { task: VmTask }) {
  const t = useT();
  const icon: ReactNode =
    task.status === 'completed' ? (
      <CheckCircle2 size={12} color="var(--accent)" />
    ) : task.status === 'in_progress' ? (
      <Loader size={12} color="var(--info)" className="sb-spinner" aria-hidden />
    ) : (
      <CircleDashed size={12} color="var(--fg-faint)" />
    );
  const label =
    task.status === 'completed'
      ? t('tasks.done')
      : task.status === 'in_progress'
        ? t('tasks.inProgress')
        : t('tasks.pending');

  return (
    <div className={`sb-row${task.status === 'completed' ? ' is-done' : ''}`}>
      <Tip label={label}>
        <span style={{ display: 'inline-flex', flex: 'none' }} aria-label={label}>
          {icon}
        </span>
      </Tip>
      <span className="sbr-main" title={task.content}>
        {task.content}
      </span>
    </div>
  );
}

/* ---------------- Background jobs ---------------- */

const JOB_TONE: Record<JobState, 'success' | 'warning' | 'destructive' | 'neutral'> = {
  running: 'success',
  uncollected: 'warning',
  done: 'neutral',
  killed: 'destructive',
};

function JobRow({ job }: { job: VmJob }) {
  const t = useT();
  const label =
    job.state === 'running'
      ? t('jobs.running')
      : job.state === 'uncollected'
        ? t('jobs.uncollected')
        : job.state === 'killed'
          ? t('jobs.killed')
          : t('jobs.done');

  // A narrow rail cannot hold the name and every detail, so details may be
  // dropped — the full text stays in `title`. "Uncollected" is signalled by
  // colour *and* by wording, never by colour alone.
  const aside = `${t('jobs.seconds', { n: job.seconds })}${
    job.exitCode !== null ? ` · ${t('jobs.exit', { n: job.exitCode })}` : ''
  }`;

  return (
    <div className={`sb-row${job.uncollected ? ' is-uncollected' : ''}`}>
      <Badge tone={JOB_TONE[job.state]} dot={false}>
        {label}
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

/**
 * One MCP server in the rail — with the action on the row.
 *
 * Load/unload used to be reachable only through `/mcp` (the panel, or typing the
 * command). But this block already answers "what is configured, what is
 * running", and the next question — "then start it" — was a command away. So the
 * button is here.
 *
 * **This row shows less than the panel's version of the same server, on
 * purpose.** It is 233px wide, and 201px once the window narrows below 1180
 * (the rail goes to 236px there). Measured with the real stylesheet: the panel's
 * wording for the not-running state ("configured, not running") is 131px of the
 * row on its own and the row **already** overflowed at 1180 before anything was
 * added; with a button next to it, keeping the tools count too squeezes that
 * count to 2px — invisible. So the tools count stays in `/mcp`, where there is
 * room for it, and the state uses its short form.
 *
 * The short form is not a second vocabulary: `mcp.not_loaded` is the runtime's
 * own word for this state (`internal/i18n/en.go`), and it names the same fact.
 */
function McpRow({ server }: { server: VmMcp }) {
  const t = useT();
  // Whether *this* front end has a request out for this server — not whether it
  // is up. The badge below is the only thing that answers that, and it comes
  // from `ui(state)` alone.
  // Per session: an in-flight mount belongs to the session that asked for it,
  // and a request sent from one conversation must not grey out another's row.
  const pending = useSessionField((rt) => rt.mcpPending.includes(server.name), false);
  const requestMcp = useApp((s) => s.requestMcp);

  const tone =
    server.state === 'loaded' ? 'success' : server.state === 'failed' ? 'destructive' : 'neutral';
  // The three states are three different questions and must not be merged.
  const label =
    server.state === 'loaded'
      ? t('mcp.loaded')
      : server.state === 'unload'
        ? t('mcp.notLoaded')
        : t('mcp.failed');

  const loaded = server.state === 'loaded';
  // `failed` is tolerated on the wire but this runtime never sends it (see
  // `McpState`), and it gets no button — the same choice the panel makes: asking
  // again is a decision, and the reason is already on the row.
  const actionable = server.state === 'loaded' || server.state === 'unload';
  // The action word is the *other* state's answer: a running server is one you
  // unload. Kept as the visible text, with the server named in the accessible
  // name — a column of bare "Load"s reads as nothing to a screen reader.
  const action = loaded ? t('mcp.unloadAction') : t('mcp.load');
  const what = loaded
    ? t('mcp.unloadServer', { name: server.name })
    : t('mcp.loadServer', { name: server.name });

  return (
    <div className="sb-row">
      <span className="sbr-main" title={server.where}>
        <span className="mono">{server.name}</span>
        {server.state === 'failed' && server.error ? (
          <span className="faint"> · {oneLine(server.error, 28)}</span>
        ) : null}
      </span>
      <Badge tone={tone} dot={false}>
        {label}
      </Badge>
      {actionable ? (
        <button
          type="button"
          className="btn btn-ghost btn-compact mcp-act"
          // Disabled while the request is out: mounting waits the running turn
          // out and then connects, which is seconds, and a second press on a
          // server already coming up is not a second decision. Busy dots rather
          // than a spinner (component-states §0 Loading), and the accessible
          // name says what is being waited for.
          disabled={pending}
          aria-label={pending ? t('mcp.pending', { name: server.name }) : what}
          onClick={() => requestMcp(loaded ? 'unload' : 'load', [server.name])}
        >
          {pending ? <BusyDots /> : action}
        </button>
      ) : null}
    </div>
  );
}
