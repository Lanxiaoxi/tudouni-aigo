import { Boxes, Bot, CircleSlash, FolderOpen, Gauge, HardDrive, Layers, Zap } from 'lucide-react';
import { selectPhase, useApp, useUsage, type AppStore } from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { Tip } from '@/components/ui/kit';
import { formatDuration, formatPercent, formatTokens } from '@/utils/format';
import type { Phase } from '@/runtime/adapt';

/**
 * §1·6 The status bar.
 *
 * Left: phase + what is happening (or how the last turn settled) + `step n / N`.
 * Right, in order: autopilot → quiet → jobs badge → subagent badge → context
 * usage → cache hit rate → turn elapsed → audit log path. Narrow windows cut
 * from the right, so the rightmost elements carry the tightest breakpoints.
 *
 * Where the right-hand numbers come from matters (decision 5): usage and the
 * cache rate are **not** in `ui(state)`. They live in `ui(status)`, which is
 * fetched once when a turn ends and, throttled, while something is outstanding.
 * `status` reads the audit log, so it must never become a heartbeat.
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
export function selectAction(s: AppStore): string | null {
  const phase = selectPhase(s);

  if (phase === 'running') {
    for (let i = s.entries.length - 1; i >= 0; i -= 1) {
      const entry = s.entries[i];
      if (entry.kind === 'tool') return entry.tool;
      if (entry.kind === 'model') return 'model call';
    }
    return null;
  }

  if (!s.ready) return null;

  // Only the phases whose name is not self-explanatory get a second line.
  if (phase === 'empty') return 'the model returned no text';
  if (phase === 'runtime_gone') {
    return s.runtimeExit === null
      ? 'the runtime process ended'
      : `the runtime process ended (code ${s.runtimeExit.code})`;
  }
  return null;
}

export function StatusBar() {
  const t = useT();
  const phase = useApp(selectPhase);
  const action = useApp(selectAction);
  const session = useApp((s) => s.session);
  const snap = useApp((s) => s.uiState);
  const autopilot = useApp((s) => s.uiState?.autopilot ?? false);
  const quiet = useApp((s) => s.quiet);
  const hasSpoken = useApp((s) => s.hasSpoken);
  const runtimeExit = useApp((s) => s.runtimeExit);
  const lastTurnMs = useApp((s) => s.lastTurnMs);
  const openPanel = useApp((s) => s.openPanel);
  const setAutopilot = useApp((s) => s.setAutopilot);
  const toggleQuiet = useApp((s) => s.toggleQuiet);

  const usage = useUsage();

  // "Never spoken" and "idle" are two different labels.
  const phaseLabel =
    phase === 'idle' && !hasSpoken ? t('phase.idleNever') : t(PHASE_KEY[phase]);

  const step = session?.steps ?? 0;
  const maxSteps = session?.maxSteps ?? 0;

  const jobs = snap?.jobs ?? [];
  const outstanding = jobs.filter((job) => job.outstanding).length;
  const uncollected = jobs.filter((job) => job.uncollected).length;
  const subagents = snap?.subagents ?? [];
  const audit = session?.auditPath ?? '';

  return (
    <footer className="statusbar">
      <div className="st-left">
        <span className="st-phase" style={{ color: PHASE_TONE[phase] }}>
          <svg width="6" height="6" viewBox="0 0 6 6" aria-hidden>
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

        {maxSteps > 0 ? (
          <span className="st-step">{t('status.step', { n: step, max: maxSteps })}</span>
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

        <Tip label={t('status.cache')}>
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
            <span className="st-metric">{formatDuration(lastTurnMs)}</span>
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
