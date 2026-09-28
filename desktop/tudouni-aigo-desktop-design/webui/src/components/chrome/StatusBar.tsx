import { Bot, Boxes, CircleSlash, FolderOpen, Gauge, HardDrive, Layers, Zap } from 'lucide-react';
import { selectPhase, useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { Tip } from '@/components/ui/kit';
import { formatDuration, formatPercent, formatTokens } from '@/utils/format';
import type { Phase } from '@/protocol/types';

/**
 * §1·6 状态栏。
 *
 * 左：阶段 + 当前动作或结算文案 + step n / N
 * 右（按序）：自动放行开关 → 安静模式 → 后台任务角标 → 子代理角标 →
 *            上下文用量 → 缓存命中率 → 本轮耗时/会话跨度 → 审计日志路径
 * 窗口变窄时从右往左砍，所以最右边的元素挂最严的断点。
 */

const PHASE_TONE: Record<Phase, string> = {
  booting: 'var(--info)',
  idle: 'var(--fg-muted)',
  running: 'var(--success)',
  done: 'var(--success)',
  step_limit: 'var(--warning)',
  failed: 'var(--destructive)',
  interrupted: 'var(--warning)',
};

/** Phase 枚举与文案 key 不是 1:1 拼出来的（step_limit ↔ phase.stepLimit），显式映射 */
const PHASE_KEY: Record<Phase, TKey> = {
  booting: 'phase.booting',
  idle: 'phase.idle',
  running: 'phase.running',
  done: 'phase.done',
  step_limit: 'phase.stepLimit',
  failed: 'phase.failed',
  interrupted: 'phase.interrupted',
};

export function StatusBar() {
  const t = useT();
  const phase = useApp(selectPhase);
  const status = useApp((s) => s.status);
  const snap = useApp((s) => s.uiState);
  const scope = useApp((s) => s.permissionScope);
  const quiet = useApp((s) => s.quiet);
  const hasSpoken = useApp((s) => s.hasSpoken);
  const openPanel = useApp((s) => s.openPanel);
  const setAutopilot = useApp((s) => s.setAutopilot);
  const toggleQuiet = useApp((s) => s.toggleQuiet);

  const phaseLabel =
    phase === 'idle' && !hasSpoken ? t('phase.idleNever') : t(PHASE_KEY[phase]);

  const action =
    phase === 'running' || phase === 'booting'
      ? (status?.action ?? null)
      : (status?.last_result ?? null);

  const step = status?.step ?? 0;
  const maxSteps = status?.max_steps ?? snap?.session.max_steps ?? 0;

  const jobs = snap?.background_jobs ?? [];
  const uncollected = jobs.filter((j) => !j.collected).length;
  const subagents = snap?.subagents ?? [];
  const ctx = snap?.context ?? null;
  const cache = snap?.cache_hit_rate ?? null;
  const elapsed = snap?.elapsed_ms ?? null;
  const span = snap?.session_span_ms ?? null;
  const audit = snap?.audit_path ?? '';

  return (
    <footer className="statusbar">
      <div className="st-left">
        <span className="st-phase" style={{ color: PHASE_TONE[phase] }}>
          <svg width="6" height="6" viewBox="0 0 6 6" aria-hidden>
            <circle cx="3" cy="3" r="3" fill="currentColor" />
          </svg>
          {phaseLabel}
        </span>

        {action ? <span className="st-action dim">{action}</span> : null}

        {(phase !== 'booting' || maxSteps > 0) && (
          <span className="st-step">{t('status.step', { n: step, max: maxSteps })}</span>
        )}
      </div>

      <div className="st-right">
        {/* 自动放行开关：这是开关，不是只读事实 */}
        <Tip label={t('status.autopilot')}>
          <button
            type="button"
            className={`st-toggle${scope?.autopilot ? ' is-on' : ''}`}
            onClick={() => setAutopilot(!(scope?.autopilot ?? false))}
            aria-pressed={scope?.autopilot ?? false}
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

        {/* 后台任务：有未收结果时加重 */}
        <Tip label={`${t('block.jobs')} · ${t('status.jobsUncollected')} ${uncollected}`}>
          <button
            type="button"
            className={`st-toggle hide-b900${uncollected > 0 ? ' st-attention' : ''}`}
            onClick={() => openPanel('subagents')}
          >
            <Boxes size={11} />
            <span className="st-metric">
              {uncollected > 0 ? `${uncollected} / ` : ''}
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

        {/* 上下文用量：窗口未知时只报用量，不报百分比（§4） */}
        <Tip
          label={
            ctx
              ? ctx.window === null
                ? t('status.contextUnknown', { used: formatTokens(ctx.used) })
                : `${formatTokens(ctx.used)} / ${formatTokens(ctx.window)} tok`
              : t('status.context')
          }
        >
          <span className="st-chip hide-b980">
            <Gauge size={11} />
            <span className="st-metric">
              {ctx === null
                ? '—'
                : ctx.window === null
                  ? formatTokens(ctx.used)
                  : `${formatPercent(ctx.percent)} · ${formatTokens(ctx.used)}`}
            </span>
          </span>
        </Tip>

        <Tip label={t('status.cache')}>
          <span className="st-chip hide-b1050">
            <HardDrive size={11} />
            <span className="st-metric">{formatPercent(cache)}</span>
          </span>
        </Tip>

        <Tip label={`${t('status.elapsed')} / ${t('status.span')}`}>
          <span className="st-chip hide-b1120">
            <Layers size={11} />
            <span className="st-metric">
              {formatDuration(elapsed)}
              {span !== null ? ` / ${formatDuration(span)}` : ''}
            </span>
          </span>
        </Tip>

        {/* 审计日志：状态栏只放文件名，完整路径交给 tooltip 与 /audit 面板 */}
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
