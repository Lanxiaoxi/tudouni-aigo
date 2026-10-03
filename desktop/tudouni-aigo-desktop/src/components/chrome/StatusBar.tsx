import { Boxes, Bot, CircleSlash, FolderOpen, Gauge, HardDrive, Layers, Zap } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import {
  NO_JOBS,
  NO_SUBAGENTS,
  selectPhase,
  selectTurnMs,
  selectUsage,
  useApp,
  useSessionField,
  type AppStore,
  type UsageView,
} from '@/state/store';
import { useTurnClock } from '@/hooks/useTurnClock';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { Tip } from '@/components/ui/kit';
import { formatDuration, formatPercent, formatTokens } from '@/utils/format';
import type { Phase } from '@/runtime/adapt';

/**
 * §1·6 The status bar.
 *
 * Left: phase + what is happening (or how the last turn settled) + the
 * conversation's cumulative steps.
 * Right, in order: autopilot → quiet → jobs badge → subagent badge → context
 * usage → cache hit rate → turn elapsed → audit log path. Narrow windows cut
 * from the right, so the rightmost elements carry the tightest breakpoints.
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
  const quiet = useSessionField((rt) => rt.quiet, false);
  const hasSpoken = useSessionField((rt) => rt.hasSpoken, false);
  const runtimeExit = useSessionField((rt) => rt.runtimeExit, null);
  const openPanel = useApp((s) => s.openPanel);
  const setAutopilot = useApp((s) => s.setAutopilot);
  const toggleQuiet = useApp((s) => s.toggleQuiet);

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
  // the one `store.ts` states above `selectAskOn`, and the three other call
  // sites that need it (`CollapsedSummary`, `SessionBar`, `EffortPanel`) already
  // follow it.
  const usage: UsageView = useApp(useShallow((s) => selectUsage(s, key)));

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

        <Tip label={t('status.quiet')}>
          <button
            type="button"
            className={`st-toggle${quiet ? ' is-on' : ''}`}
            onClick={toggleQuiet}
            aria-pressed={quiet}
          >
            <CircleSlash size={11} />
            <span className="hide-b860">{t('status.quiet')}</span>
          </button>
        </Tip>

        {/* Jobs: emphasised when a result is still uncollected. */}
        <Tip label={`${t('block.jobs')} · ${t('status.jobsUncollected')} ${uncollected}`}>
          <button
            type="button"
            className={`st-toggle hide-b900${uncollected > 0 ? ' st-attention' : ''}`}
            onClick={() => openPanel('subagents')}
          >
            <Boxes size={11} />
            <span className="st-metric">
              {outstanding > 0 ? `${outstanding} / ` : ''}
              {jobs.length}
            </span>
          </button>
        </Tip>

        <Tip label={`${t('status.subagents')} ${subagents.length}`}>
          <button
            type="button"
            className={`st-toggle hide-b940${subagents.length > 0 ? ' is-on' : ''}`}
            onClick={() => openPanel('subagents')}
          >
            <Bot size={11} />
            <span className="st-metric">{subagents.length}</span>
          </button>
        </Tip>

        {/* What the last request actually sent. With an unknown window, the
            amount only — a wrong percentage is worse than no percentage. The
            context layer's local estimate is a *different fact* and gets its
            own chip below; showing it here would label an estimate as a
            measurement. */}
        <Tip
          label={
            usage.used === null
              ? t('status.contextNoPrompt')
              : usage.window === null
                ? t('status.contextUnknown', { used: formatTokens(usage.used) })
                : `${formatTokens(usage.used)} / ${formatTokens(usage.window)} tok`
          }
        >
          <span className="st-chip hide-b980">
            <Gauge size={11} />
            <span className="st-metric">
              {usage.used === null
                ? '—'
                : usage.window === null
                  ? formatTokens(usage.used)
                  : `${formatPercent(usage.percent)} · ${formatTokens(usage.used)}`}
            </span>
          </span>
        </Tip>

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

        <Tip label={t('status.elapsed')}>
          <span className="st-chip hide-b1120">
            <Layers size={11} />
            <span className="st-metric">{formatDuration(turnMs)}</span>
          </span>
        </Tip>

        {/* Audit log: the file name only; the full path is in the tooltip and
            in the /audit panel. */}
        <Tip label={audit || undefined}>
          <button
            type="button"
            className="st-toggle hide-b1200"
            onClick={() => openPanel('audit')}
            disabled={!audit}
          >
            <FolderOpen size={11} />
            <span className="st-path">{audit ? audit.split(/[\\/]/).pop() : '—'}</span>
          </button>
        </Tip>
      </div>
    </footer>
  );
}
