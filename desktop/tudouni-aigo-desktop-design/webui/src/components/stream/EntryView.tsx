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
import type { PermissionDecision, ToolResultStatus } from '@/protocol/types';

/* ============================================================
   单条目渲染。12 类各走一个分支，互不合并 ——
   尤其「拒绝行」与「跑失败」必须一眼可分（§2）。
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
      return <NoteEntry entry={entry} />;
    case 'block':
      return <InBlock entry={entry} />;
    default:
      return null;
  }
}

/* ---------------- 1. 回合头 ---------------- */

function TurnHead({ entry }: { entry: Extract<Entry, { kind: 'turn' }> }) {
  const t = useT();
  const statusKey = {
    running: 'entry.turnRunning',
    completed: 'entry.turnDone',
    failed: 'entry.turnFailed',
    interrupted: 'entry.turnInterrupted',
    step_limit: 'entry.turnStepLimit',
  } as const;
  const tone =
    entry.status === 'running'
      ? 'success'
      : entry.status === 'failed'
        ? 'destructive'
        : entry.status === 'completed'
          ? 'neutral'
          : 'warning';

  return (
    <div className="turn-head">
      <span className="th-num">{t('entry.turn', { n: entry.turn })}</span>
      <Badge tone={tone}>{t(statusKey[entry.status])}</Badge>
      <span className="th-step">
        {t('status.step', { n: entry.step, max: entry.maxSteps })}
      </span>
    </div>
  );
}

/* ---------------- 2. 用户输入 ---------------- */

function UserEntry({ entry }: { entry: Extract<Entry, { kind: 'user' }> }) {
  const t = useT();
  return (
    <div className="e-user">
      <span className="eu-tag">{t('entry.you')}</span>
      {entry.text}
    </div>
  );
}

/* ---------------- 3. 模型步 ---------------- */

function ModelEntry({ entry }: { entry: Extract<Entry, { kind: 'model' }> }) {
  const t = useT();
  if (entry.retry) {
    return (
      <div className="e-model is-retry">
        <span className="em-rail" />
        <AlertTriangle size={12} />
        <span className="em-retry">
          {t('entry.modelRetry', { attempt: entry.retry.attempt, ms: entry.retry.waitMs })}
        </span>
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

/* ---------------- 4. 工具调用（含结果明细） ---------------- */

const RESULT_TONE: Record<ToolResultStatus, 'success' | 'destructive' | 'warning'> = {
  ok: 'success',
  error: 'destructive',
  denied: 'warning',
};

function ToolEntry({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }) {
  const t = useT();
  const open = useApp((s) => s.toolOpen[entry.id] === true);
  const toggleTool = useApp((s) => s.toggleTool);
  const elevated = entry.risk === 'MEDIUM' || entry.risk === 'HIGH';

  return (
    <div
      className={`e-tool${entry.risk === 'MEDIUM' ? ' is-medium' : ''}${
        entry.risk === 'HIGH' ? ' is-high' : ''
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
        <span className="et-params">
          {entry.params ? oneLine(entry.params, 120) : ''}
        </span>

        {elevated ? <RiskTag level={entry.risk} /> : null}

        {entry.result ? (
          <Badge tone={RESULT_TONE[entry.result.status]} dot={false}>
            {entry.result.status === 'ok'
              ? t('entry.toolResultOk')
              : entry.result.status === 'error'
                ? t('entry.toolResultError')
                : t('entry.toolResultDenied')}
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
 * 工具调用的明细体。quiet 模式下由 QuietGroup 单独复用 ——
 * 那边已经有「一行一次调用」的简报头了，不该再画一遍卡片头。
 */
export function ToolBody({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }) {
  const t = useT();
  return (
    <div className="e-tool-body reveal">
      <div className="etb-label">{t('entry.params')}</div>
      <div className="terminal">{entry.params || '—'}</div>

      <div className="row caption" style={{ gap: 'var(--space-2)' }}>
        <span className="faint">{entry.builtin ? t('entry.builtin') : t('entry.external')}</span>
        <span className="sep" />
        <span className="faint">{t(`risk.${entry.risk}`)}</span>
        <span className="sep" />
        <span className="faint">
          {entry.parallelSafe ? `✓ ${t('entry.parallelSafe')}` : `✗ ${t('entry.parallelSafe')}`}
        </span>
        <span className="sep" />
        <span className="faint">
          {entry.occupiesInput ? `✓ ${t('entry.occupiesInput')}` : `✗ ${t('entry.occupiesInput')}`}
        </span>
      </div>

      {entry.result ? (
        <>
          <div className="etb-label">{t('entry.output')}</div>
          <div className="terminal">
            {entry.result.preview || '—'}
            {'\n'}
            <span className="tl-dim">
              {t('entry.toolChars', { n: formatTokens(entry.result.chars) })} ·{' '}
              {t('entry.toolDuration', { ms: formatDuration(entry.result.durationMs) })}
              {entry.result.exitCode !== null
                ? ` · ${t('entry.toolExit', { n: entry.result.exitCode })}`
                : ''}
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ---------------- 6. 拒绝行（独立条目） ---------------- */

function DeniedEntry({ entry }: { entry: Extract<Entry, { kind: 'denied' }> }) {
  const t = useT();
  return (
    <div className="e-denied">
      <Ban size={12} />
      <span className="seq">{entry.index}</span>
      <span className="mono">{entry.tool}</span>
      <span className="ed-text">
        {entry.reason
          ? t('entry.denied', { reason: oneLine(entry.reason, 90) })
          : t('entry.deniedNoReason')}
      </span>
    </div>
  );
}

/* ---------------- 7. 并发批次 ---------------- */

function BatchEntry({ entry }: { entry: Extract<Entry, { kind: 'batch' }> }) {
  const t = useT();
  return (
    <div className="e-batch">
      <Boxes size={12} />
      <span>
        {t('entry.batch', { count: entry.count, ms: entry.wallMs })}
      </span>
    </div>
  );
}

/* ---------------- 8. 权限记录 ---------------- */

const DECISION_TONE: Record<PermissionDecision, 'success' | 'destructive' | 'warning' | 'info'> = {
  allow: 'success',
  deny: 'destructive',
  always: 'info',
  autopilot: 'warning',
};

function PermEntry({ entry }: { entry: Extract<Entry, { kind: 'perm' }> }) {
  const t = useT();
  return (
    <div className="e-perm">
      <ShieldCheck size={12} />
      <span>{t('entry.perm')}</span>
      <Badge tone={DECISION_TONE[entry.decision]} dot={false}>
        {entry.decision === 'autopilot'
          ? t('entry.permAuto')
          : entry.decision === 'allow'
            ? t('perm.action.allow')
            : entry.decision === 'deny'
              ? t('perm.action.deny')
              : t('perm.action.always')}
      </Badge>
      <span className="mono">{entry.tool}</span>
      <span className="faint">
        {entry.waited ? t('entry.permWaited', { ms: formatDuration(entry.waitedMs) }) : t('entry.permNoWait')}
      </span>
      {entry.rule ? (
        <span className="ep-rule">{t('entry.permRule', { rule: entry.rule })}</span>
      ) : null}
    </div>
  );
}

/* ---------------- 9. 思考块（默认折叠） ---------------- */

function ReasonEntry({ entry }: { entry: Extract<Entry, { kind: 'reason' }> }) {
  const t = useT();
  const manual = useApp((s) => s.reasoningOpen[entry.id]);
  const toggle = useApp((s) => s.toggleReasoning);
  // 流式时强制展开并实时更新；流式结束后回到用户的手动选择（默认折叠）
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

/* ---------------- 12. 附加 / 系统行 ---------------- */

function NoteEntry({ entry }: { entry: Extract<Entry, { kind: 'note' }> }) {
  const t = useT();

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

  const text =
    entry.key !== null
      ? t(entry.key as Parameters<typeof t>[0], entry.params)
      : (entry.text ?? '');

  return (
    <div className={`e-note${cls}`}>
      {icon}
      <span className="en-text">{text}</span>
    </div>
  );
}
