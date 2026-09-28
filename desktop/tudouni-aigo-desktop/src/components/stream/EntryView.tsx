import {
  AlertTriangle,
  Ban,
  Boxes,
  Brain,
  Camera,
  ChevronRight,
  CircleAlert,
  Info,
  Layers,
  Minus,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Badge, RiskTag } from '@/components/ui/kit';
import { Markdown } from '@/components/ui/Markdown';
import { InBlock } from './InBlock';
import { charCount, type Entry } from '@/state/entries';
import { formatDuration, formatTokens, oneLine } from '@/utils/format';
import type { TKey } from '@/i18n';

/* ============================================================
   One entry, one branch. The twelve kinds are not merged —
   above all, a denial and a failure must be distinguishable at
   a glance (§2).
   ============================================================ */

export function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'turn':
      return <TurnHead entry={entry} />;
    case 'user':
      return <UserEntry entry={entry} />;
    case 'model':
      return <ModelEntry entry={entry} />;
    case 'tool':
      return <ToolEntry entry={entry} />;
    case 'denied':
      return <DeniedEntry entry={entry} />;
    case 'batch':
      return <BatchEntry entry={entry} />;
    case 'perm':
      return <PermEntry entry={entry} />;
    case 'reason':
      return <ReasonEntry entry={entry} />;
    case 'answer':
      return (
        <div className="e-answer">
          <Markdown text={entry.text} />
        </div>
      );
    case 'stream':
      return (
        <div className="e-stream">
          {entry.text}
          {entry.streaming ? <span className="stream-caret" aria-hidden /> : null}
        </div>
      );
    case 'note':
      return <NoteRow entry={entry} />;
    case 'block':
      return <InBlock entry={entry} />;
    default:
      return null;
  }
}

/* ---------------- 1. turn head ---------------- */

/** `run_finished.stop_reason` -> copy. The distinctions are the ones a reader
 *  acts on, so they do not share a word. */
const STOP_KEY: Record<string, TKey> = {
  running: 'entry.turnRunning',
  answered: 'entry.turnDone',
  completed: 'entry.turnDone',
  max_steps: 'entry.turnStepLimit',
  cancelled: 'entry.turnInterrupted',
  model_error: 'entry.turnFailed',
  model_fatal: 'entry.turnFailed',
  empty_response: 'entry.turnEmpty',
};

function TurnHead({ entry }: { entry: Extract<Entry, { kind: 'turn' }> }) {
  const t = useT();
  const running = entry.status === 'running';
  const tone = running
    ? 'success'
    : entry.status === 'model_error' || entry.status === 'model_fatal'
      ? 'destructive'
      : entry.status === 'answered' || entry.status === 'completed'
        ? 'neutral'
        : 'warning';

  const label = t(STOP_KEY[entry.status] ?? 'entry.turnDone');

  // The raw stop reason is shown only when the label does not already carry it.
  // `answered` and `completed` both map to "ended · completed", so printing the
  // raw value beside them would be noise on every ordinary turn — while a
  // `max_steps` or `cancelled` ending is exactly the thing a reader wants named.
  const rawIsInformative =
    !running && !['answered', 'completed'].includes(entry.status);

  return (
    <div className="turn-head">
      <span className="th-num">{t('entry.turn', { n: entry.ordinal })}</span>
      <Badge tone={tone}>{label}</Badge>
      {rawIsInformative ? <span className="faint caption mono">{entry.status}</span> : null}
      <span className="th-step">
        {t('status.step', { n: entry.step, max: entry.maxSteps })}
      </span>
    </div>
  );
}

/* ---------------- 2. user input ---------------- */

function UserEntry({ entry }: { entry: Extract<Entry, { kind: 'user' }> }) {
  const t = useT();
  return (
    <div className="e-user">
      <span className="eu-tag">{t('entry.you')}</span>
      {entry.text}
    </div>
  );
}

/* ---------------- 3. model step ---------------- */

function ModelEntry({ entry }: { entry: Extract<Entry, { kind: 'model' }> }) {
  const t = useT();
  if (entry.retry) {
    return (
      <div className="e-model is-retry">
        <span className="em-rail" />
        <AlertTriangle size={12} />
        <span className="em-retry">{t('entry.modelRetry', { ms: entry.retry.waitMs })}</span>
      </div>
    );
  }

  const hasMetrics = entry.durationMs !== null || entry.inputTokens !== null;
  return (
    <div className="e-model">
      <span className="em-rail" />
      <Sparkles size={12} />
      <span>{t('entry.model')}</span>
      <span className="grow" />
      <span className="eh-metrics">
        {hasMetrics
          ? t('entry.modelMetrics', {
              ms: formatDuration(entry.durationMs),
              input: formatTokens(entry.inputTokens),
              cached: formatTokens(entry.cachedTokens),
            })
          : t('entry.modelNoMetrics')}
      </span>
    </div>
  );
}

/* ---------------- 4. tool call, with its result ---------------- */

function resultLabel(status: string, t: ReturnType<typeof useT>): string {
  if (status === 'ok') return t('entry.toolResultOk');
  if (status === 'invalid_args') return t('entry.toolResultInvalid');
  if (status === 'denied') return t('entry.toolResultDenied');
  return t('entry.toolResultError');
}

function resultTone(status: string): 'success' | 'destructive' | 'warning' {
  if (status === 'ok') return 'success';
  if (status === 'denied') return 'warning';
  return 'destructive';
}

function ToolEntry({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }) {
  const t = useT();
  const open = useApp((s) => s.toolOpen[entry.id] === true);
  const toggleTool = useApp((s) => s.toggleTool);
  const elevated = entry.risk === 'medium' || entry.risk === 'high';

  return (
    <div
      className={`e-tool${entry.risk === 'medium' ? ' is-medium' : ''}${
        entry.risk === 'high' ? ' is-high' : ''
      }`}
    >
      <div
        className="et-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => toggleTool(entry.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleTool(entry.id);
          }
        }}
      >
        <ChevronRight size={13} className={`caret${open ? ' caret-open' : ''}`} />
        <span className="seq">{entry.index}</span>
        <Wrench size={12} className="muted" />
        <span className="et-name">{entry.tool}</span>
        <span className="et-params">{entry.arguments ? oneLine(entry.arguments, 120) : ''}</span>

        {elevated && entry.risk ? <RiskTag level={entry.risk} /> : null}

        {entry.result ? (
          <Badge tone={resultTone(entry.result.status)} dot={false}>
            {resultLabel(entry.result.status, t)}
          </Badge>
        ) : null}

        {entry.result ? (
          <span className="eh-metrics">
            {t('entry.toolDuration', { ms: formatDuration(entry.result.durationMs) })}
            {entry.result.exitCode !== null
              ? ` · ${t('entry.toolExit', { n: entry.result.exitCode })}`
              : ''}
          </span>
        ) : null}
      </div>

      {open ? <ToolBody entry={entry} /> : null}
    </div>
  );
}

/**
 * The detail body. Quiet mode reuses it, since that mode already draws its own
 * one-line brief and must not repeat the card header.
 */
export function ToolBody({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }) {
  const t = useT();
  return (
    <div className="e-tool-body reveal">
      <div className="etb-label">{t('entry.params')}</div>
      <div className="terminal">{entry.arguments || '—'}</div>

      <div className="row caption" style={{ gap: 'var(--space-2)' }}>
        {/* Every one of these is a registry fact looked up by name, so an
            unanswered lookup reads "unknown" rather than defaulting to a
            comfortable value. */}
        <span className="faint">
          {entry.external === null
            ? t('entry.unknown')
            : entry.external
              ? t('entry.external')
              : t('entry.builtin')}
        </span>
        <span className="sep" />
        <span className="faint">{entry.risk ? t(`risk.${entry.risk}` as TKey) : t('entry.unknown')}</span>
        <span className="sep" />
        <span className="faint">
          {entry.parallelSafe === null
            ? t('entry.unknown')
            : `${entry.parallelSafe ? '✓' : '✗'} ${t('entry.parallelSafe')}`}
        </span>
        <span className="sep" />
        <span className="faint">
          {entry.interactive === null
            ? t('entry.unknown')
            : `${entry.interactive ? '✓' : '✗'} ${t('entry.occupiesInput')}`}
        </span>
      </div>

      {entry.result ? (
        <>
          <div className="etb-label">{t('entry.output')}</div>
          {/* The audit keeps a character count, not the body: a tool result is
              routinely hundreds of thousands of characters and copying it here
              would make the log a second copy of the conversation. */}
          <div className="terminal">
            <span className="tl-dim">
              {t('entry.toolChars', { n: formatTokens(entry.result.chars) })} ·{' '}
              {t('entry.toolDuration', { ms: formatDuration(entry.result.durationMs) })}
              {entry.result.exitCode !== null
                ? ` · ${t('entry.toolExit', { n: entry.result.exitCode })}`
                : ''}
              {entry.result.parallel ? ' · parallel' : ''}
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ---------------- 6. denial, its own row ---------------- */

function DeniedEntry({ entry }: { entry: Extract<Entry, { kind: 'denied' }> }) {
  const t = useT();
  return (
    <div className="e-denied">
      <Ban size={12} />
      <span className="seq">{entry.index}</span>
      <span className="mono">{entry.tool}</span>
      {/* The audit records the verdict, not a reason sentence, so the line says
          what is true rather than inventing a cause. */}
      <span className="ed-text">{t('entry.denied')}</span>
    </div>
  );
}

/* ---------------- 7. concurrent batch ---------------- */

function BatchEntry({ entry }: { entry: Extract<Entry, { kind: 'batch' }> }) {
  const t = useT();
  return (
    <div className="e-batch">
      <Boxes size={12} />
      <span>{t('entry.batch', { count: entry.calls, ms: entry.wallMs })}</span>
    </div>
  );
}

/* ---------------- 8. permission record ---------------- */

function PermEntry({ entry }: { entry: Extract<Entry, { kind: 'perm' }> }) {
  const t = useT();
  const tone =
    entry.outcome === 'user_denied' || entry.outcome === 'policy_denied'
      ? 'destructive'
      : entry.outcome === 'autopilot' || entry.outcome === 'auto_allowed'
        ? 'warning'
        : 'success';

  // The outcome is the fact; `decision` is only the gate's verdict.
  const outcomeLabel =
    entry.outcome === 'autopilot'
      ? t('entry.permAuto')
      : entry.outcome === 'user_denied'
        ? t('perm.action.deny')
        : entry.outcome === 'rule_allowed' ||
            entry.outcome === 'command_allowed' ||
            entry.outcome === 'approved'
          ? t('perm.action.allow')
          : entry.outcome || entry.decision;

  return (
    <div className="e-perm">
      <ShieldCheck size={12} />
      <span>{t('entry.perm')}</span>
      <Badge tone={tone} dot={false}>
        {outcomeLabel}
      </Badge>
      <span className="mono">{entry.tool}</span>
      {/* `waited_ms` is present only when a person was actually asked — a
          verdict is written for every call. Its absence is the signal. */}
      <span className="faint">
        {entry.waitedMs !== null
          ? t('entry.permWaited', { ms: formatDuration(entry.waitedMs) })
          : t('entry.permNoWait')}
      </span>
      {entry.rule ? (
        <span className="ep-rule">{t('entry.permRule', { rule: entry.rule })}</span>
      ) : entry.remembered.length > 0 ? (
        <span className="ep-rule">
          {t('entry.permRemembered', { rules: entry.remembered.join(', ') })}
        </span>
      ) : null}
    </div>
  );
}

/* ---------------- 9. reasoning block, folded by default ---------------- */

function ReasonEntry({ entry }: { entry: Extract<Entry, { kind: 'reason' }> }) {
  const t = useT();
  const manual = useApp((s) => s.reasoningOpen[entry.id]);
  const toggle = useApp((s) => s.toggleReasoning);
  // While streaming it is forced open and updates live; once the stream stops it
  // returns to the person's own choice, which defaults to folded.
  const open = entry.streaming ? true : manual === true;

  return (
    <div className="e-reason">
      <div
        className="er-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => toggle(entry.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle(entry.id);
          }
        }}
      >
        <ChevronRight size={13} className={`caret${open ? ' caret-open' : ''}`} />
        <Brain size={12} />
        <span>
          {entry.streaming
            ? t('entry.reasonLive', { n: charCount(entry.text) })
            : t('entry.reasonCollapsed', { n: charCount(entry.text) })}
        </span>
        <span className="er-count">Ctrl T</span>
      </div>

      {open ? <div className="e-reason-body">{entry.text}</div> : null}
    </div>
  );
}

/* ---------------- 12. attached / system rows ---------------- */

/**
 * Exported because the first screen renders notices too: they are session
 * content, and the design is explicit that the first screen must not squeeze
 * them out. One implementation, so the two places cannot drift.
 */
export function NoteRow({ entry }: { entry: Extract<Entry, { kind: 'note' }> }) {
  const icon =
    entry.tone === 'degraded' ? (
      <Layers size={11} />
    ) : entry.tone === 'compacted' ? (
      <Minus size={11} />
    ) : entry.tone === 'image' ? (
      <Camera size={11} />
    ) : entry.tone === 'error' ? (
      <CircleAlert size={11} />
    ) : entry.tone === 'warn' ? (
      <AlertTriangle size={11} />
    ) : (
      <Info size={11} />
    );

  const cls =
    entry.tone === 'degraded'
      ? ' is-degraded'
      : entry.tone === 'compacted'
        ? ' is-compacted'
        : entry.tone === 'image'
          ? ' is-image'
          : '';

  return (
    <div className={`e-note${cls}`} data-code={entry.code}>
      {icon}
      {/* The runtime's own sentence, displayed verbatim. Translating it would
          invent a second source for the same fact. */}
      <span className="en-text">{entry.text}</span>
    </div>
  );
}
