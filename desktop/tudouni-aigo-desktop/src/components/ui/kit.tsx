import type { ReactNode } from 'react';
import type { RiskLevel } from '@/protocol/types';
import { HelpCircle, Info as InfoGlyph } from 'lucide-react';
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

/**
 * 计数角标。
 * attention = 有需要一眼看到的项目（未收结果等），warning 色。
 * active = 该块有内容且值得留意（如 goal 已设置的轮次计数），accent 色；
 * 两者都未设时保持 muted 灰——「空的 list 显示灰色 0」是这个默认状态。
 */
export function Count({
  value,
  attention,
  active,
}: {
  value: number | string;
  attention?: boolean;
  active?: boolean;
}) {
  return (
    <span className={`count${attention ? ' count-attention' : active ? ' count-active' : ''}`}>
      {value}
    </span>
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
  className,
}: {
  children: ReactNode;
  mono?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <span className={`fact${mono ? ' fact-mono' : ''}${className ? ` ${className}` : ''}`} title={title}>
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

/**
 * The `?` beside a panel's title: what the panel *is*, kept out of the one-line
 * subtitle.
 *
 * A native `title` rather than `Tip`, deliberately. `Tip` is a Radix tooltip, and
 * this one is mounted **the instant a panel opens** — on the element the pointer
 * is most likely to already be over, since the header sits where the dialog's own
 * top edge is. A tooltip that announces itself before anybody has asked is worse
 * than no tooltip: it covers the row it is supposed to be explaining. The native
 * attribute has no such failure mode, and what is behind it is a definition, not
 * an interaction.
 *
 * It lives here rather than in one panel because three panels now put it in the
 * same place — the tasks shelf, Configuration and Learn this workspace — and a
 * header control that means the same thing everywhere should be one component.
 */
export function PanelInfo({ label }: { label: string }) {
  return (
    <button type="button" className="info-ic" aria-label={label} title={label}>
      <InfoGlyph size={13} />
    </button>
  );
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
