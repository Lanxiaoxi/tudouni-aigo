import type { ReactNode } from 'react';
import type { RiskLevel } from '@/protocol/types';
import { HelpCircle } from 'lucide-react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { useT } from '@/i18n/useT';

/* ============================================================
   Badge —— component-states.md §7
   语义映射：运行中/成功 success、等待/警告 warning、错误 destructive、
   信息 info、默认 fg-muted。翻转只改色，禁止呼吸灯。
   ============================================================ */

export type BadgeTone = 'success' | 'warning' | 'destructive' | 'info' | 'neutral' | 'outline';

export function Badge({
  tone = 'neutral',
  dot = true,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot ? <i className="dot" /> : null}
      {children}
    </span>
  );
}

/** 计数角标。attention = 有需要一眼看到的项目（未收结果等） */
export function Count({ value, attention }: { value: number | string; attention?: boolean }) {
  return (
    <span className={`count${attention ? ' count-attention' : ''}`}>{value}</span>
  );
}

/** 风险等级。MEDIUM / HIGH 在流里要突出 */
export function RiskTag({ level }: { level: RiskLevel }) {
  const t = useT();
  return <span className={`risk risk-${level.toLowerCase()}`}>{t(`risk.${level}`)}</span>;
}

/**
 * 只读事实标签。
 * desktop-ui-spec.md §9.5：权限范围、风险标签这类是事实展示，
 * 不要画成可操作控件 —— 所以这里用虚线边 + cursor: default，不做 hover 反馈。
 */
export function Fact({
  children,
  mono,
  title,
}: {
  children: ReactNode;
  mono?: boolean;
  title?: string;
}) {
  return (
    <span className={`fact${mono ? ' fact-mono' : ''}`} title={title}>
      {children}
    </span>
  );
}

/* ============================================================
   Tooltip —— hover 延迟 400ms（由 Provider 统一设置）
   ============================================================ */

export function Tip({
  label,
  children,
  side = 'bottom',
}: {
  label: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  if (!label) return <>{children}</>;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content className="tooltip" side={side} sideOffset={6}>
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/**
 * 信息图标。面板里把长说明从行内挪出来的配套件：标题行放一个 `?`，
 * 细节留给悬停/聚焦时再看 —— 行内只留一句话，主次才分得开。
 * 复用 Tooltip 的 Provider 与 400ms 延迟，和 `Tip` 同一套行为。
 */
export function Info({ label, side = 'top' }: { label: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  if (!label) return null;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>
        <button
          type="button"
          className="info-ic"
          aria-label={typeof label === 'string' ? label : 'More'}
        >
          <HelpCircle size={13} />
        </button>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content className="tooltip" side={side} sideOffset={6}>
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* ============================================================
   键位提示
   ============================================================ */

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/* ============================================================
   进度条
   ============================================================ */

export function Progress({
  value,
  max,
  tone,
}: {
  value: number;
  max: number;
  tone?: 'warn' | 'danger';
}) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="progress">
      <div
        className={`progress-fill${tone ? ` is-${tone}` : ''}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ============================================================
   空状态（每块都要：说明 + 引导）
   ============================================================ */

export function EmptyState({
  icon,
  title,
  hint,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="sb-empty">
        <div className="se-title">{title}</div>
        {hint ? <div className="se-hint">{hint}</div> : null}
      </div>
    );
  }
  return (
    <div className="list-empty">
      {icon ? <div className="muted">{icon}</div> : null}
      <div className="le-title">{title}</div>
      {hint ? <div className="le-hint">{hint}</div> : null}
    </div>
  );
}

/** 处理态：原地禁用 + 文字替换，不用 spinner（component-states §0 Loading） */
export function BusyDots() {
  return (
    <span className="dots" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  );
}

export { TooltipPrimitive };
