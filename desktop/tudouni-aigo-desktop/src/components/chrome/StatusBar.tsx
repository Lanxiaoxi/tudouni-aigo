import { useEffect, useState, type ReactNode } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import {
  Boxes,
  Bot,
  CircleSlash,
  Cpu,
  FolderOpen,
  Gauge,
  HardDrive,
  Layers,
  SquareTerminal,
  Zap,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import {
  NO_JOBS,
  NO_SUBAGENTS,
  NO_TERMINALS,
  selectPhase,
  selectTurnMs,
  selectUsage,
  useApp,
  useSessionField,
  type AppStore,
  type UsageView,
} from '@/state/store';
import { useTurnClock } from '@/hooks/useTurnClock';
import { useResourceUsage } from '@/hooks/useResourceUsage';
import { useListKeys } from '@/hooks/useListKeys';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { Tip } from '@/components/ui/kit';
import { formatBytes, formatCpu, formatDuration, formatPercent, formatTokens } from '@/utils/format';
import type { Phase } from '@/runtime/adapt';
import type { QuietMode } from '@/state/store';
import {
  AuditPanel,
  ContextPanel,
  SubagentsPanel,
  TimingPanel,
} from '@/components/panels/panels';
import { PanelBody, PanelRow, PanelShell, PopoverSurface, usePanelSurface } from '@/components/panels/PanelShell';

/**
 * §1·6 The status bar.
 *
 * Left: phase + what is happening (or how the last turn settled) + the
 * conversation's cumulative steps.
 * Right, in order: autopilot → quiet → **terminals badge** → jobs badge →
 * subagent badge → context usage → token rate → cache hit rate → turn elapsed
 * → audit log path. Narrow windows cut from the right, so the rightmost elements carry the
 * tightest breakpoints — including the terminals badge, which is the fourth from
 * the right and therefore the fourth to go.
 *
 * The terminals badge is next to `quiet` on purpose, which is where it was asked
 * for: both answer "what is running in this session", and the two are the only
 * toggles on the row. It is derived from `terminals` — the same list the panel
 * and the tab strip draw — rather than from anything of its own, because the
 * runtime is the only source of truth for whether a terminal exists.
 *
 * Where the right-hand numbers come from (decision 5, revised): the **live**
 * figures come from the `model_call` events as they arrive, so they move per
 * step. They used to come only from `ui(status)`, which is requested when a turn
 * ends — so a long turn showed the previous turn's numbers and then jumped, and
 * a turn that grew to 300k tokens showed the whole jump at once. `ui(status)`
 * still supplies the session totals and is the fallback for a session whose calls
 * this window never saw (a `/resume`d conversation, whose transcript is rebuilt
 * from the session file rather than replayed as events). **`status` is not
 * requested any more often**: it reads the audit log and must never become a
 * heartbeat.
 */

const PHASE_TONE: Record<Phase, string> = {
  booting: 'var(--info)',
  idle: 'var(--fg-muted)',
  running: 'var(--success)',
  done: 'var(--success)',
  step_limit: 'var(--warning)',
  failed: 'var(--destructive)',
  interrupted: 'var(--warning)',
  empty: 'var(--warning)',
  runtime_gone: 'var(--destructive)',
};

const PHASE_KEY: Record<Phase, TKey> = {
  booting: 'phase.booting',
  idle: 'phase.idle',
  running: 'phase.running',
  done: 'phase.done',
  step_limit: 'phase.stepLimit',
  failed: 'phase.failed',
  interrupted: 'phase.interrupted',
  empty: 'phase.empty',
  runtime_gone: 'phase.runtimeGone',
};

/**
 * What the runtime is doing right now, or how the last turn settled.
 *
 * Design §7.4 asks for "the current action **or** the settlement wording", and
 * only the first half existed: the last line was `s.session?.model ? null :
 * null`, which is `null` either way, so a finished turn left this slot empty and
 * the phase chip alone had to carry the outcome.
 *
 * The settlement cases are the ones a reader actually wonders about — a turn
 * that ended without text, or because the child died — and they are exactly the
 * ones the phase word cannot explain on its own.
 */
export function selectAction(s: AppStore, key: string | null): string | null {
  const phase = selectPhase(s, key);
  const bucket = key === null ? null : (s.sessions[key] ?? null);

  if (phase === 'running') {
    for (let i = (bucket?.entries.length ?? 0) - 1; i >= 0; i -= 1) {
      const entry = bucket!.entries[i];
      if (entry.kind === 'tool') return entry.tool;
      if (entry.kind === 'model') return 'model call';
    }
    return null;
  }

  if (!bucket?.ready) return null;

  // Only the phases whose name is not self-explanatory get a second line.
  if (phase === 'empty') return 'the model returned no text';
  if (phase === 'runtime_gone') {
    return bucket.runtimeExit === null
      ? 'the runtime process ended'
      : `the runtime process ended (code ${bucket.runtimeExit.code})`;
  }
  return null;
}

export function StatusBar() {
  const t = useT();
  // **The whole row is a statement about one conversation**, so every cell comes
  // from the session being shown. That includes the usage numbers on the right:
  // they are read per session, and a row that kept the first session's figures
  // while the transcript changed under it would be the most misleading thing on
  // screen — it would look perfectly normal.
  const key = useApp((s) => s.activeKey);
  const phase = useApp((s) => selectPhase(s, key));
  const action = useApp((s) => selectAction(s, key));
  const session = useSessionField((rt) => rt.session, null);
  const snap = useSessionField((rt) => rt.uiState, null);
  const autopilot = useSessionField((rt) => rt.uiState?.autopilot ?? false, false);
  const quiet = useSessionField((rt) => rt.quiet, 'off');
  // The workspace's shells, and which one this session's view is attached to.
  // Both come from the session on screen for the reason stated above: with two
  // conversations open, a count that kept the first one's shells would be a
  // number about a process this row is not describing.
  const terminals = useSessionField((rt) => rt.terminals, NO_TERMINALS);
  const attachedTerminalId = useSessionField((rt) => rt.activeTerminalId, null);
  const hasSpoken = useSessionField((rt) => rt.hasSpoken, false);
  const runtimeExit = useSessionField((rt) => rt.runtimeExit, null);
  const setAutopilot = useApp((s) => s.setAutopilot);
  const setQuiet = useApp((s) => s.setQuiet);
  const toggleTerminalView = useApp((s) => s.toggleTerminalView);

  // The turn's elapsed time. The runtime sends no duration until a turn ends, so
  // a running turn is timed against a local clock — which is why this reads the
  // clock at all, and why the clock ticks **only** while one is in flight (see
  // `useTurnClock`). A finished turn's duration is frozen on `run_finished`.
  const now = useTurnClock(phase === 'running');
  const turnMs = useApp((s) => selectTurnMs(s, key, now));

  // `useShallow`, because `selectUsage` **builds a new object** on every call.
  // zustand compares snapshots by identity, so a bare `useApp((s) =>
  // selectUsage(s, key))` never compares equal: the store re-renders forever,
  // React gives up with "Maximum update depth exceeded", and the error boundary
  // takes the whole tree down — the window renders nothing at all. The rule is
  // the one `store.ts` states above `selectAskOn`, and the other call sites
  // that need it (`CollapsedSummary`, `EffortPanel`) already follow it.
  const usage: UsageView = useApp(useShallow((s) => selectUsage(s, key)));

  // The whole application's CPU and memory, sampled by the host every two
  // seconds. **Process-scoped, deliberately not session-scoped**: the question
  // it answers — "is this application heavy" — has no per-session reading, so
  // the chip keeps one number while the transcript changes under it.
  const resources = useResourceUsage();

  // "Never spoken" and "idle" are two different labels.
  const phaseLabel =
    phase === 'idle' && !hasSpoken ? t('phase.idleNever') : t(PHASE_KEY[phase]);

  // Cumulative only. The cap is read from `session.maxSteps` — but deliberately
  // not drawn here: it is a per-turn budget, and pairing it with a cumulative
  // count is the mistake `status.steps` describes.
  const step = session?.steps ?? 0;

  const jobs = snap?.jobs ?? NO_JOBS;
  const outstanding = jobs.filter((job) => job.outstanding).length;
  const uncollected = jobs.filter((job) => job.uncollected).length;
  const subagents = snap?.subagents ?? NO_SUBAGENTS;
  // Finished background delegations nobody has read. They badge the same cell
  // as the running count because they are the same subject — work the session
  // is owed — and the distinction the cell has to carry is "how many are still
  // working" vs "how many are done and waiting".
  const subagentUncollected = (snap?.subagentsDone ?? []).filter(
    (row) => row.state === 'uncollected',
  ).length;
  const audit = session?.auditPath ?? '';

  return (
    <footer className="statusbar">
      <div className="st-left">
        <span className="st-phase" style={{ color: PHASE_TONE[phase] }}>
          {/* The dot breathes **only while the phase is running**, and that is the
              distinction component-states §7 draws: it forbids a breathing light
              as a way of showing that a badge's *state* changed ("运行中→完成只改
              色"), which is a transition a person misses if it animates and
              misreads if it loops. "A turn is in flight right now" is not a state
              change, it is a continuing condition, and the only other sign of it
              is text that reads the same at 0s and at 60s. */}
          <svg width="6" height="6" viewBox="0 0 6 6" aria-hidden className={phase === 'running' ? 'is-working' : undefined}>
            <circle cx="3" cy="3" r="3" fill="currentColor" />
          </svg>
          {phaseLabel}
        </span>

        {runtimeExit && !runtimeExit.requested ? (
          <span className="st-action" style={{ color: 'var(--destructive)' }}>
            {t('status.runtimeGone', { code: runtimeExit.code })}
          </span>
        ) : action ? (
          <span className="st-action dim">{action}</span>
        ) : null}

        {/* The conversation's **cumulative** step count, with no denominator.
            See `status.steps` for why: the numerator is every assistant message
            in the session and the denominator is this turn's budget, so a
            fraction of the two reads `step 497 / 120`. The turn's own progress
            is on the turn head, where both numbers come from the same entry. */}
        {step > 0 ? (
          <span className="st-step">{t('status.steps', { n: step })}</span>
        ) : null}

        {/* The whole application's CPU and memory (this shell plus every
            runtime it has started), on the **left** because that is where it
            was asked for: next to the phase it describes the application
            rather than this conversation, the way the phase does.
            A `null` sample draws nothing: before the first reading exists a
            chip reading "0.0%" would be a measurement of zero, and "no
            measurement" and "zero" are different statements. */}
        {resources !== null ? (
          <Tip
            label={
              <>
                {t('status.resourcesCpu', {
                  shellCpu: formatCpu(resources.shellCpu),
                  runtimesCpu: formatCpu(resources.runtimesCpu),
                })}
                <br />
                {t('status.resourcesMem', {
                  shellMem: formatBytes(resources.shellMem),
                  runtimesMem: formatBytes(resources.runtimesMem),
                  webviewMem: formatBytes(resources.webviewMem),
                })}
                <br />
                {t('status.resourcesSystem', {
                  systemUsed: formatBytes(resources.systemMemUsed),
                  systemTotal: formatBytes(resources.systemMemTotal),
                })}
              </>
            }
          >
            <span className="st-chip">
              <Cpu size={11} />
              <span className="st-metric">
                {t('status.resources', {
                  cpu: formatCpu(resources.shellCpu + resources.runtimesCpu),
                  // The webview has no CPU of its own on this line: its render
                  // process is the UI, and the shell is the application.
                  mem: formatBytes(
                    resources.shellMem + resources.runtimesMem + resources.webviewMem,
                  ),
                })}
              </span>
            </span>
          </Tip>
        ) : null}
      </div>

      <div className="st-right">
        {/* Autopilot is a switch, not a read-only fact — but its displayed state
            comes from the runtime, never from the click that asked for it. */}
        <Tip label={t('status.autopilot')}>
          <button
            type="button"
            className={`st-toggle${autopilot ? ' is-on' : ''}`}
            onClick={() => setAutopilot(!autopilot)}
            aria-pressed={autopilot}
          >
            <Zap size={11} />
            <span>{t('status.autopilot')}</span>
          </button>
        </Tip>

        {/* Quiet is a **menu**, not a toggle: the chip lifts a popover with the
            three states (normal / simple / off), and the row shows which one is
            in force. The pressed state marks the whole cluster "on" — the two
            modes are both quieter than the default, so the chip's own label is
            the mode name, which is the state a glance needs. */}
        <StatusPopover
          label={t('status.quiet')}
          content={<QuietModeMenu mode={quiet} onPick={setQuiet} />}
        >
          <button
            type="button"
            className={`st-toggle${quiet !== 'off' ? ' is-on' : ''}`}
            aria-pressed={quiet !== 'off'}
          >
            <CircleSlash size={11} />
            <span className="hide-b860">
              {t(
                quiet === 'normal'
                  ? 'quiet.mode.normal'
                  : quiet === 'simple'
                    ? 'quiet.mode.simple'
                    : 'status.quiet',
              )}
            </span>
          </button>
        </StatusPopover>

        {/* **The terminals badge**, and it is where it is because that is where
            it was asked for: directly to the right of `quiet`. It answers the
            question the tab strip answers only from *inside* the terminal view —
            "how many shells have I got" — and pressing it is the way in.

            **The count is the number of terminals, not the number running**, and
            that is the same rule the panel and the tab strip follow: a row that
            has ended stays in the list, because it is what answers "what was I
            running", and its exit code would go with it. Counting only the live
            ones would make a killed shell's row quietly uncounted here and
            counted everywhere else.

            **Disabled when there is nothing to attach to.** A press has no
            nothing-state to fall into: `toggleTerminalView` cannot invent a
            shell, and an enabled control whose press does nothing is the thing
            this build keeps refusing to draw. `is-on` marks the attached state
            rather than the count, because "this page is the terminal" is the
            fact the button toggles. */}
        <Tip
          label={
            terminals.length === 0
              ? t('status.terminalsNone')
              : `${t('status.terminals')} ${terminals.length}${
                  attachedTerminalId !== null ? ` · ${t('panel.term.leave')}` : ''
                }`
          }
        >
          <button
            type="button"
            className={`st-toggle hide-b880${attachedTerminalId !== null ? ' is-on' : ''}`}
            onClick={toggleTerminalView}
            disabled={terminals.length === 0}
            aria-pressed={attachedTerminalId !== null}
          >
            <SquareTerminal size={11} />
            <span className="st-metric">{terminals.length}</span>
          </button>
        </Tip>

        {/* Jobs: emphasised when a result is still uncollected. */}
        <StatusPopover
          label={`${t('block.jobs')} · ${t('status.jobsUncollected')} ${uncollected}`}
          content={<SubagentsPanel />}
        >
          <button
            type="button"
            className={`st-toggle hide-b900${uncollected > 0 ? ' st-attention' : ''}`}
          >
            <Boxes size={11} />
            <span className="st-metric">
              {outstanding > 0 ? `${outstanding} / ` : ''}
              {jobs.length}
            </span>
          </button>
        </StatusPopover>

        {/* The label mirrors the jobs chip's above — the subject plus the number
            the chip's left-hand figure is — because `1✓ / 2` on its own does not
            say what the ✓ counts. Both figures describe the same set: a delegation
            the runtime reports in flight, and how many of those ended with an
            answer nobody has read yet. */}
        <StatusPopover
          label={`${t('status.subagents')} · ${t('status.jobsUncollected')} ${subagentUncollected}`}
          content={<SubagentsPanel />}
        >
          <button
            type="button"
            className={`st-toggle hide-b940${subagents.length > 0 ? ' is-on' : ''}${
              subagentUncollected > 0 ? ' st-attention' : ''
            }`}
          >
            <Bot size={11} />
            <span className="st-metric">
              {subagentUncollected > 0 ? `${subagentUncollected}✓ / ` : ''}
              {subagents.length}
            </span>
          </button>
        </StatusPopover>

        {/* What the last request actually sent. With an unknown window, the
            amount only — a wrong percentage is worse than no percentage. The
            context layer's local estimate is a *different fact* and gets its
            own chip below; showing it here would label an estimate as a
            measurement.

            A button, not a read-only chip: pressing it opens the context
            panel, which asks the runtime for `ui(context)` and shows the same
            ledger the /context command draws — a dialog, not a block dropped
            into the transcript behind it. Disabled while no prompt has been
            measured, so the click can never be a lie. */}
        <StatusPopover
          label={
            usage.used === null
              ? t('status.contextNoPrompt')
              : usage.window === null
                ? t('status.contextUnknown', { used: formatTokens(usage.used) })
                : `${formatTokens(usage.used)} / ${formatTokens(usage.window)} tok · ${t('cmd.context.desc')}`
          }
          content={<ContextPanel />}
        >
          <button
            type="button"
            className="st-toggle hide-b980"
            disabled={usage.used === null}
          >
            <Gauge size={11} />
            <span className="st-metric">
              {usage.used === null
                ? '—'
                : usage.window === null
                  ? formatTokens(usage.used)
                  : `${formatPercent(usage.percent)} · ${formatTokens(usage.used)}`}
            </span>
          </button>
        </StatusPopover>

        {/* The context ledger's own estimate. Labelled as an estimate and never
            merged into the chip above. */}
        {usage.estimated !== null ? (
          <Tip
            label={t('status.contextEstimate', {
              used: formatTokens(usage.estimated),
              percent: formatPercent(usage.estimatedPercent),
            })}
          >
            <span className="st-chip hide-b1050">
              <Layers size={11} />
              <span className="st-metric faint">~{formatTokens(usage.estimated)}</span>
            </span>
          </Tip>
        ) : null}

        <Tip
          label={t(
            usage.cacheScope === 'session'
              ? 'status.cacheSession'
              : usage.cacheScope === 'call'
                ? 'status.cacheCall'
                : // No rate to describe: the plain noun, never a claim about which
                  // scope a figure that does not exist came from.
                  'status.cache',
          )}
        >
          <span className="st-chip hide-b1050">
            <HardDrive size={11} />
            {/* An em dash, never 0%: no lookup has happened yet and "the cache
                is broken" are different statements. */}
            <span className="st-metric">{formatPercent(usage.cacheHitRate)}</span>
          </span>
        </Tip>

        {/* The last successful call's average output rate, moving per step with
            the live record. Null — a tool-only call, or a call that reported no
            usage — omits the chip: `0.0 tok/s` would read as a measurement of
            zero, and the model rows tell the same story per step. */}
        {usage.outputRate !== null ? (
          <Tip label={t('status.outputRate', { rate: usage.outputRate })}>
            <span className="st-chip hide-b1120">
              <Zap size={11} />
              <span className="st-metric">{t('status.outputRate', { rate: usage.outputRate })}</span>
            </span>
          </Tip>
        ) : null}

        {/* The turn's wall time, and the door into its breakdown. A button
            rather than a chip: the number is a total, and what a person wants
            from a total is the split beneath it (model / tools / approval /
            human / backoff), which is more than one hover can carry. It is
            never disabled — the panel answers even for a new session, with
            "no turn has run yet" as the true answer. */}
        <StatusPopover
          label={`${t('status.elapsed')} · ${t('panel.timing.desc')}`}
          content={<TimingPanel />}
        >
          <button
            type="button"
            className="st-toggle hide-b1120"
          >
            <Layers size={11} />
            <span className="st-metric">{formatDuration(turnMs)}</span>
          </button>
        </StatusPopover>

        {/* Audit log: the file name only; the full path is in the tooltip and
            in the /audit panel. */}
        <StatusPopover
          label={audit || undefined}
          content={<AuditPanel />}
        >
          <button
            type="button"
            className="st-toggle hide-b1200"
            disabled={!audit}
          >
            <FolderOpen size={11} />
            <span className="st-path">{audit ? audit.split(/[\\/]/).pop() : '—'}</span>
          </button>
        </StatusPopover>
      </div>
    </footer>
  );
}

/**
 * The status bar's floating panels.
 *
 * The chips that used to raise a centered dialog (`openPanel('audit')` and
 * friends) now raise the same panel content anchored **above their own
 * button**: a click lifts it, and the same click — or Esc, or a click
 * anywhere else — puts it back. The open state is local to this component,
 * not the store's `panel`: the dialog is the window's one panel, and this is
 * one chip's own menu, so the two never share a state field. They stay
 * mutually exclusive in both directions — lifting a popover closes a dialog
 * that is open (the `onOpenChange` below), and a dialog opening from a
 * command drops every popover (the effect that watches `s.panel`).
 *
 * The content is the **same panel components** the dialog draws, wrapped in
 * `PopoverSurface` so `PanelShell` renders plain elements instead of the
 * Radix dialog primitives (which would throw outside a `Dialog.Root`) and so
 * the header's close button goes to this popover's open state.
 */
/**
 * The quiet chip's menu: the three states, one row each, in the order a bare
 * `Ctrl+\` cycles them (normal → simple → off), with the current one marked.
 *
 * A `PanelShell` inside the status bar's popover — the same pair the jobs and
 * subagents chips use — so the head, the rows and the keyboard behave like
 * every other panel, and picking a row closes the popover through the
 * popover's own open state rather than the store's `panel`.
 */
function QuietModeMenu({ mode, onPick }: { mode: QuietMode; onPick: (m: QuietMode) => void }) {
  const t = useT();
  const surface = usePanelSurface();
  // The menu is drawn only while the popover is up (its content is mounted
  // by Radix), so its own keys are always live — and closing is the
  // popover's close, which `PopoverSurface` hands out for exactly this.
  const close = surface.kind === 'popover' ? surface.close : () => useApp.getState().closePanel();
  const options: { value: QuietMode; label: TKey }[] = [
    { value: 'normal', label: 'quiet.mode.normal' },
    { value: 'simple', label: 'quiet.mode.simple' },
    { value: 'off', label: 'quiet.mode.off' },
  ];
  const { active, setActive } = useListKeys({
    count: options.length,
    onClose: close,
    onPick: (i) => {
      const option = options[i];
      if (!option) return;
      onPick(option.value);
      close();
    },
  });
  return (
    <PanelShell title={t('status.quiet')} note={t('quiet.menu.note')}>
      <PanelBody>
        {options.map((option, i) => (
          <PanelRow
            key={option.value}
            index={i + 1}
            active={active === i}
            selected={mode === option.value}
            onHover={() => setActive(i)}
            onPick={() => {
              onPick(option.value);
              close();
            }}
          >
            {t(option.label)}
          </PanelRow>
        ))}
      </PanelBody>
    </PanelShell>
  );
}

function StatusPopover({
  label,
  content,
  children,
}: {
  label: ReactNode;
  content: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const storePanel = useApp((s) => s.panel);

  // A dialog opening drops this popover: the two are two ways of showing a
  // panel, and only one can be up. In practice a modal dialog blocks the
  // click that would lift this (Radix takes `pointer-events` off the body),
  // so this mostly covers the keyboard paths — `Ctrl+K`, a command.
  useEffect(() => {
    if (storePanel !== null) setOpen(false);
  }, [storePanel]);

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (next) useApp.getState().closePanel();
        setOpen(next);
      }}
    >
      {/* The chip's own button is the trigger **and** the anchor (no custom
          Anchor, so Radix wraps the trigger as one). `Tip` wraps the
          *outside*, not the inside: a plain function component in the
          `asChild` chain would swallow the ref and the click the trigger
          needs to merge into the button. The press toggles on purpose —
          the second press is the "close it", and Esc / a click elsewhere
          go through the popover's own dismissal. */}
      {/* The tooltip stays a constant label, even while the panel is up:
          dropping it to `undefined` would change `Tip`'s own tree and
          remount the chip mid-session. Sides never collide either — the
          tooltip sits below the chip, the panel above it. */}
      <Tip label={label}>
        <PopoverPrimitive.Trigger asChild>{children}</PopoverPrimitive.Trigger>
      </Tip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="st-popover"
          side="top"
          align="end"
          sideOffset={6}
          aria-label={typeof label === 'string' ? label : undefined}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <PopoverSurface close={() => setOpen(false)}>
            {content}
          </PopoverSurface>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
