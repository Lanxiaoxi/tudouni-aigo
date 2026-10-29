import { useMemo, type ReactNode } from 'react';
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Download,
  ExternalLink,
  Loader,
} from 'lucide-react';
import {
  NO_ENTRIES,
  NO_SKILLS,
  NO_SUBAGENTS_DONE,
  useApp,
  useSessionField,
  type SidebarBlockKey,
} from '@/state/store';
import { useT } from '@/i18n/useT';
import { Badge, BusyDots, Count, EmptyState, Progress, Tip } from '@/components/ui/kit';
import { baseName, oneLine } from '@/utils/format';
import { useDeliverableOpen } from '@/hooks/useDeliverableOpen';
import { extensionLabel, FileGlyph } from '@/components/stream/DeliverableCards';
import { presentedFiles, type Deliverable } from '@/state/entries';
import type { JobState, SshRow } from '@/protocol/types';
import type { VmGoal, VmJob, VmMcp, VmSubagentDone, VmTask } from '@/runtime/adapt';

/**
 * §3 Sidebar, seven blocks, fixed order:
 * Goal → Presented files → Tasks → Background jobs → Loaded skills → MCP →
 * SSH sessions.
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
  // Background delegations: the block answers "what is running in the
  // background", and a background subagent is that too — it outlives the turn
  // that started it, exactly like a background command. `subagentsDone` is the
  // background-only list, so every row in it belongs here.
  const subagentsDone = useSessionField(
    (rt) => rt.uiState?.subagentsDone ?? NO_SUBAGENTS_DONE,
    NO_SUBAGENTS_DONE,
  );
  // The files block is fed by the transcript, not by the snapshot: a `present`
  // result carries the declaration, and `entries` is the one record of them. The
  // memo is what keeps the derivation off every unrelated render — `entries` is a
  // stable array between messages.
  const entries = useSessionField((rt) => rt.entries, NO_ENTRIES);
  const presented = useMemo(() => presentedFiles(entries), [entries]);

  if (!snap) {
    return (
      <aside className="app-sidebar">
        <RailHead />
        <div className="sidebar-inner">
          <div className="caption" style={{ padding: 'var(--space-3) var(--space-2)' }}>
            {t('common.loading')}
          </div>
        </div>
      </aside>
    );
  }

  const doneTasks = snap.todos.filter((todo) => todo.status === 'completed').length;
  // A background delegation counts the same way its command counterpart does:
  // `running` and `uncollected` are the two states that mean somebody still has
  // to look at it, and "uncollected" is the warning case that colours the badge.
  const subagentUncollected = subagentsDone.filter(
    (agent) => agent.state === 'uncollected',
  ).length;
  const subagentOutstanding = subagentsDone.length;
  const uncollected =
    snap.jobs.filter((job) => job.uncollected).length + subagentUncollected;
  const outstanding =
    snap.jobs.filter((job) => job.outstanding).length + subagentOutstanding;
  const mcpLoaded = snap.mcp.filter((server) => server.state === 'loaded').length;
  // The badge is the live count only: ended sessions the list still keeps are
  // history, not load, and a denominator that included them would make "how
  // many remote shells am I actually logged into" a subtraction — the same
  // rule the TUI's SSH block badge follows (`internal/frontends/tui/rail.go`).
  const sshLive = snap.ssh.filter((row) => row.status === 'running').length;

  return (
    <aside className="app-sidebar">
      <RailHead />
      <div className="sidebar-inner scroll-fade">
        {/* 1 · Goal. The count badge stays muted grey while the block is empty
            ("0" beside "No goal" would just say the same thing twice in a
            louder voice), and takes the accent as soon as a goal is set — a
            set goal is live state, not furniture. */}
        <Block
          blockKey="goal"
          title={t('block.goal')}
          count={snap.goal.roundsText || (snap.goal.present ? '—' : '0')}
          countActive={snap.goal.present}
          isEmpty={!snap.goal.present}
          emptyTitle={t('empty.goal.title')}
          emptyHint={t('empty.goal.hint')}
        >
          <GoalBody goal={snap.goal} />
        </Block>

        {/* 2 · Presented files. The conversation's own outputs: every file a
            `present` call declared, in the order it was first declared. Each row
            opens the file in the OS default application — the same door the
            transcript card's open control uses, through the same hook — because
            "what did this conversation give me" is answered by getting the file,
            not by reading its name again. */}
        <Block
          blockKey="files"
          title={t('block.files')}
          count={presented.length}
          countActive={presented.length > 0}
          isEmpty={presented.length === 0}
          emptyTitle={t('empty.files.title')}
          emptyHint={t('empty.files.hint')}
        >
          <PresentedFiles files={presented} />
        </Block>

        {/* 3 · Tasks */}
        <Block
          blockKey="tasks"
          title={t('block.tasks')}
          count={`${doneTasks}/${snap.todos.length}`}
          countActive={snap.todos.length > 0}
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

        {/* 4 · Background jobs. The block holds both kinds of background work —
            commands sent to the background and background delegations — because
            it answers one question: what is still running after the turn moved
            on. A background subagent outlives its turn exactly like a
            background command, so it gets a row here, not only in the /subagents
            panel and the status bar. */}
        <Block
          blockKey="jobs"
          title={t('block.jobs')}
          count={
            outstanding > 0
              ? `${outstanding} / ${snap.jobs.length + subagentsDone.length}`
              : `${snap.jobs.length + subagentsDone.length}`
          }
          countAttention={uncollected > 0}
          countActive={snap.jobs.length + subagentsDone.length > 0}
          isEmpty={snap.jobs.length === 0 && subagentsDone.length === 0}
          emptyTitle={t('empty.jobs.title')}
          emptyHint={t('empty.jobs.hint')}
        >
          {snap.jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
          {subagentsDone.map((agent) => (
            <SubagentRow key={agent.id} agent={agent} />
          ))}
        </Block>

        {/* 5 · Loaded skills.
            `snap.skills` is `ui(state).skills`, which is pointers for whatever
            the snapshot happened to record; the merged store list is what
            `ui(skills).active` says is actually loaded. The sidebar shows the
            loaded set, so it reads the latter. */}
        <Block
          blockKey="skills"
          title={t('block.skills')}
          count={loadedSkills.length}
          countActive={loadedSkills.length > 0}
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

        {/* 6 · MCP */}
        <Block
          blockKey="mcp"
          title={t('block.mcp')}
          count={`${mcpLoaded} / ${snap.mcp.length}`}
          countActive={snap.mcp.length > 0}
          isEmpty={snap.mcp.length === 0}
          emptyTitle={t('empty.mcp.title')}
          emptyHint={t('empty.mcp.hint')}
        >
          {snap.mcp.map((server) => (
            <McpRow key={server.name} server={server} />
          ))}
        </Block>

        {/* 7 · SSH sessions. Display only — the operations stay with the
            `ssh_*` tools, so unlike the MCP rows above there is no action
            button here. The badge counts live sessions; ended rows stay on
            the list so "what was I connected to" keeps an answer. `active`
            while a session is up, so "1" beside a live connection reads as
            load (accent) instead of furniture (muted grey) — the same rule
            the Goal block applies to a set goal. */}
        <Block
          blockKey="ssh"
          title={t('block.ssh')}
          count={sshLive}
          countActive={sshLive > 0}
          isEmpty={snap.ssh.length === 0}
          emptyTitle={t('empty.ssh.title')}
          emptyHint={t('empty.ssh.hint')}
        >
          {snap.ssh.map((row) => (
            <SshSessionRow key={row.id} row={row} />
          ))}
        </Block>
      </div>
    </aside>
  );
}

/**
 * One block's body **without the block shell** — the same rows the rail draws
 * for it, plus the same empty state when there is nothing to draw.
 *
 * The rail's `Block` renders its body through its own head (count badge, fold,
 * emptiness), so it keeps its inline copy; this component exists for a **second
 * surface**: the collapsed summary's hover popover, which has no block head to
 * hang the emptiness on and needs the whole thing — rows or empty state — as
 * one answer. It reads the same fields from the same session the rail does, so
 * the two can never disagree about what a block says.
 */
export function SidebarBlockContent({ blockKey }: { blockKey: SidebarBlockKey }) {
  const t = useT();
  const snap = useSessionField((rt) => rt.uiState, null);
  const loadedSkills = useSessionField((rt) => rt.skills, NO_SKILLS);
  const subagentsDone = useSessionField(
    (rt) => rt.uiState?.subagentsDone ?? NO_SUBAGENTS_DONE,
    NO_SUBAGENTS_DONE,
  );
  const entries = useSessionField((rt) => rt.entries, NO_ENTRIES);
  const presented = useMemo(() => presentedFiles(entries), [entries]);

  if (!snap) return null;

  switch (blockKey) {
    case 'goal':
      return snap.goal.present ? (
        <GoalBody goal={snap.goal} />
      ) : (
        <EmptyState compact title={t('empty.goal.title')} hint={t('empty.goal.hint')} />
      );

    case 'files':
      return presented.length > 0 ? (
        <PresentedFiles files={presented} />
      ) : (
        <EmptyState compact title={t('empty.files.title')} hint={t('empty.files.hint')} />
      );

    case 'tasks': {
      if (snap.todos.length === 0) {
        return (
          <EmptyState compact title={t('empty.tasks.title')} hint={t('empty.tasks.hint')} />
        );
      }
      const doneTasks = snap.todos.filter((todo) => todo.status === 'completed').length;
      return (
        <>
          <div className="sb-progress">
            <Progress value={doneTasks} max={snap.todos.length} />
            <span className="sbr-aside mono">
              {t('tasks.progress', { done: doneTasks, total: snap.todos.length })}
            </span>
          </div>
          {snap.todos.map((task, index) => (
            <TaskRow key={`${task.content}-${index}`} task={task} />
          ))}
        </>
      );
    }

    case 'jobs':
      if (snap.jobs.length === 0 && subagentsDone.length === 0) {
        return (
          <EmptyState compact title={t('empty.jobs.title')} hint={t('empty.jobs.hint')} />
        );
      }
      return (
        <>
          {snap.jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
          {subagentsDone.map((agent) => (
            <SubagentRow key={agent.id} agent={agent} />
          ))}
        </>
      );

    case 'skills':
      if (loadedSkills.length === 0) {
        return (
          <EmptyState compact title={t('empty.skills.title')} hint={t('empty.skills.hint')} />
        );
      }
      return (
        <>
          {loadedSkills.map((skill) => (
            <div key={skill.name} className="sb-row">
              {/* The description only exists in the first snapshot's catalog, so
                  it may legitimately be null. */}
              <span className="sbr-main" title={skill.description ?? undefined}>
                <span className="mono">{skill.name}</span>
              </span>
            </div>
          ))}
        </>
      );

    case 'mcp':
      if (snap.mcp.length === 0) {
        return (
          <EmptyState compact title={t('empty.mcp.title')} hint={t('empty.mcp.hint')} />
        );
      }
      return (
        <>
          {snap.mcp.map((server) => (
            <McpRow key={server.name} server={server} />
          ))}
        </>
      );

    case 'ssh':
      if (snap.ssh.length === 0) {
        return (
          <EmptyState compact title={t('empty.ssh.title')} hint={t('empty.ssh.hint')} />
        );
      }
      return (
        <>
          {snap.ssh.map((row) => (
            <SshSessionRow key={row.id} row={row} />
          ))}
        </>
      );
  }
  return null;
}

/* ---------------- the rail's own head ---------------- */

/**
 * The right rail's head: **what this rail is**.
 *
 * Its 42px band keeps the height the left rail's first row (the "new session"
 * button) draws at, so the two rails still flank the transcript as one pair
 * rather than as two unrelated designs. It carries no collapse control: the rail
 * is folded from the session bar's toggle, which is the only place a control can
 * be *and still be reachable after the fold*. A button inside the rail it hides
 * is a button that disappears with the act of pressing it (see `SessionBar`).
 *
 * **No mark here either.** The window's top bar carries the application icon
 * beside the app's name; the right rail repeats the app's name in words
 * ("Session runtime"), which is all this rail needs — a second copy of the mark
 * two inches from the top bar's read as decoration, not as information.
 */
function RailHead() {
  const t = useT();

  return (
    <div className="rb-head">
      <span className="rb-title">{t('rail.head')}</span>
    </div>
  );
}

/* ---------------- block shell ---------------- */

function Block({
  blockKey,
  title,
  count,
  countAttention,
  countActive,
  isEmpty,
  emptyTitle,
  emptyHint,
  children,
}: {
  blockKey: SidebarBlockKey;
  title: string;
  count: number | string;
  countAttention?: boolean;
  countActive?: boolean;
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
        <Count value={count} attention={countAttention} active={countActive} />
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

/* ---------------- Presented files ---------------- */

/**
 * The files this conversation declared, one row each, **opening on press**.
 *
 * The row is the rail-sized twin of the transcript's deliverable card, and it
 * differs from that card in exactly one decision. On a card, the face is a
 * *preview* and the open control beside it is the real act, because a card has
 * room for two targets. A 200px rail row has room for one, and the question
 * this block answers — "where is the thing I asked for" — is answered by the
 * file opening, not by its name being drawn again. So the whole row is the open.
 *
 * Everything else is shared: the glyph and the fallback note come from the card
 * (`FileGlyph`, `extensionLabel`) so a `.pptx` looks the same in both places,
 * and the open itself goes through `useDeliverableOpen`, which is the single
 * place that knows about remote downloads and the missing-Tauri-host case. A
 * failure stays **on the row** that failed (the sentence comes from Rust
 * verbatim), and pressing it again is the retry.
 *
 * Exported for the test that pins the rail's row labels and fallback note.
 */
export function PresentedFiles({ files }: { files: Deliverable[] }) {
  const t = useT();
  const remoteWorkspaceId = useSessionField((rt) => rt.remoteWorkspaceId, null);
  // Per block, keyed by path: two files in one list are two independent gestures.
  const { phase, problem, copied, open } = useDeliverableOpen();

  return (
    <ul className="sb-files" aria-label={t('block.files')}>
      {files.map((file) => {
        const state = phase[file.path];
        const name = baseName(file.path);
        // The note is the model's own, or — when it wrote none — the kind of
        // file, the same fallback the transcript card uses.
        const note = file.description !== '' ? file.description : extensionLabel(name, t);
        return (
          <li key={file.path} className="sb-file">
            <button
              type="button"
              className="sb-file-face"
              // The full path: the row shows a basename, and "which one is this"
              // is the question a hover is asking.
              title={file.path}
              aria-label={t('deliverable.open', { name })}
              onClick={() => open(file)}
            >
              <span className="sb-file-icon" aria-hidden>
                <FileGlyph path={file.path} size={14} />
              </span>
              <span className="sb-file-body">
                <span className="sb-file-name">{name}</span>
                <span className="sb-file-note" data-error={state === 'error' ? '' : undefined}>
                  {state === 'error' ? problem[file.path] : note}
                </span>
              </span>
              <span className="sb-file-trail" aria-hidden>
                {state === 'opening' ? (
                  <Loader size={12} className="sb-spin" />
                ) : remoteWorkspaceId !== null && copied[file.path] === undefined ? (
                  // The remote door's first half is a download. The icon says
                  // which act the press is about to perform, rather than
                  // promising an open that cannot happen yet.
                  <Download size={12} />
                ) : (
                  <ExternalLink size={12} />
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
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

  const aside = `${t('jobs.seconds', { n: job.seconds })}${
    job.exitCode !== null ? ` · ${t('jobs.exit', { n: job.exitCode })}` : ''
  }`;

  return (
    <div className={`sb-row${job.uncollected ? ' is-uncollected' : ''}`}>
      <Badge tone={JOB_TONE[job.state]} dot={false}>
        {label}
      </Badge>
      {/* The command is the material a person matches against the transcript,
          so it is shown whole: it wraps instead of being cut, and the row
          grows to hold it. "Uncollected" is signalled by colour *and* by
          wording, never by colour alone. */}
      <span className="sbr-main sbr-wrap">
        <span className="mono">{job.command}</span>
      </span>
      <span className="sbr-aside" title={aside}>
        {aside}
      </span>
    </div>
  );
}

/**
 * One background delegation in the rail, beside its command counterparts.
 *
 * The row answers the block's question the same way `JobRow` does: state
 * first, then a name a person can match against the transcript (`label` is
 * what the model passed as the delegation's description), then the detail.
 * A foreground delegation never appears here — it ends with its turn, so it
 * is the turn's business, not the rail's.
 */
function SubagentRow({ agent }: { agent: VmSubagentDone }) {
  const t = useT();
  const label =
    agent.state === 'running'
      ? t('jobs.running')
      : agent.state === 'uncollected'
        ? t('jobs.uncollected')
        : t('jobs.done');

  // The aside is the run's total, like a job's elapsed time: seconds and,
  // once the child ended, how — `stop_reason` is the runtime's own word.
  const aside = `${t('jobs.seconds', { n: agent.seconds })}${
    agent.stopReason !== '' ? ` · ${agent.stopReason}` : ''
  }`;

  return (
    <div className={`sb-row${agent.state === 'uncollected' ? ' is-uncollected' : ''}`}>
      {/* The state, and only the state — the same badge grammar `JobRow` above
          uses, because both kinds answer one question ("is this still going?").
          This row used to read `bg/uncollected`, where the `bg` repeated the block
          title it already sits under and the slash made the pair read as a ratio.
          The bot is what says "delegation" instead of "command"; the block heading
          says the rest, so the icon is decoration and stays out of the a11y tree. */}
      <Badge tone={agent.state === 'running' ? 'success' : 'warning'} dot={false}>
        {label}
      </Badge>
      <Bot size={11} className="muted" aria-hidden />
      <span className="sbr-main" title={agent.label}>
        <span className="mono">{oneLine(agent.label, 40)}</span>
      </span>
      <span className="sbr-aside" title={aside}>
        {aside}
      </span>
    </div>
  );
}

/* ---------------- SSH sessions ---------------- */

const SSH_TONE: Record<SshRow['status'], 'success' | 'warning' | 'destructive' | 'neutral'> = {
  running: 'success',
  exited: 'neutral',
  killed: 'destructive',
  timed_out: 'warning',
};

/**
 * One SSH remote session in the rail — display only.
 *
 * The row mirrors the TUI's SSH block rows (`internal/frontends/tui/rail.go`):
 * the name is the alias when the model asked for one and it differs from where
 * the connection actually resolved; "tudouni — tudouni" is one fact drawn
 * twice. The badge answers "is this live" before the text does, and an ended
 * row says how it ended — `timed_out` gets its own word because it invites
 * reconnecting, while `killed` does not (the runtime keeps them separate for
 * the same reason, `internal/ssh/session.go`).
 */
function SshSessionRow({ row }: { row: SshRow }) {
  const t = useT();

  const name = row.alias !== '' && row.alias !== row.destination
    ? `${row.alias} — ${row.destination}`
    : row.destination;

  const label =
    row.status === 'running'
      ? t('ssh.live')
      : row.exit_code !== null
        ? t('ssh.ended', { why: row.status })
        : t('ssh.noCode');

  // A live row has nothing to add beyond its shot at reading "still up"; the
  // badge already says it. An ended row's aside is the exit code when the
  // runtime carried one — inventing a number for one that exited without a
  // code would say "clean" where nothing was learned — and the runtime's own
  // status word when it did not (`timed_out` especially, which invites
  // reconnecting rather than mourning).
  const aside =
    row.exit_code !== null
      ? t('jobs.exit', { n: row.exit_code })
      : row.status === 'running'
        ? null
        : row.status;

  return (
    <div className="sb-row">
      <Badge tone={SSH_TONE[row.status] ?? 'neutral'} dot={row.status === 'running'}>
        {label}
      </Badge>
      <span className="sbr-main" title={name}>
        <span className="mono">{oneLine(name, 40)}</span>
      </span>
      {aside !== null ? (
        <span className="sbr-aside" title={aside}>
          {aside}
        </span>
      ) : null}
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
