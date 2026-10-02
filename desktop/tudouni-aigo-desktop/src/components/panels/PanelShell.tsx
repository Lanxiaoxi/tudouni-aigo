import type { ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useT } from '@/i18n/useT';

/**
 * 弹层面板统一外壳。
 *
 * §5：每块需要「标识 + 条数 + 空状态文案」；
 * component-states.md §9：容器 radius-xl + shadow-modal，Esc / 遮罩点击关闭。
 * Radix Dialog 负责 Esc、焦点陷阱与 aria 关系，视觉全部来自设计系统。
 */
export function PanelShell({
  title,
  count,
  note,
  children,
  footer,
}: {
  title: string;
  count?: ReactNode;
  note?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useT();
  return (
    <>
      <div className="dialog-head">
        <div className="grow">
          <DialogPrimitive.Title className="dialog-title">{title}</DialogPrimitive.Title>
          {note ? (
            <DialogPrimitive.Description className="dialog-desc">
              {note}
            </DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">
              {title}
            </DialogPrimitive.Description>
          )}
        </div>

        {count !== undefined ? <span className="count">{count}</span> : null}

        <DialogPrimitive.Close asChild>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={t('panel.close')}>
            <X size={14} />
          </button>
        </DialogPrimitive.Close>
      </div>

      {children}
      {footer ? <div className="dialog-foot">{footer}</div> : null}
    </>
  );
}

/** 面板内容区（可滚） */
export function PanelBody({ children }: { children: ReactNode }) {
  return <div className="dialog-body scroll">{children}</div>;
}

/** 一行列表项。标记当前项、右侧提示与序号 */
export function PanelRow({
  active,
  selected,
  index,
  onPick,
  onHover,
  children,
  aside,
}: {
  active?: boolean;
  selected?: boolean;
  index?: number;
  onPick?: () => void;
  onHover?: () => void;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div
      className={`cmdk-item${active ? '' : ''}`}
      data-active={active === true}
      data-selected={selected === true}
      role={onPick ? 'button' : undefined}
      tabIndex={onPick ? 0 : undefined}
      onClick={onPick}
      onMouseEnter={onHover}
      onKeyDown={(e) => {
        if (!onPick) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          // **`stopPropagation`, and it is load-bearing.** Every panel's keys go
          // through `useListKeys`, whose listener is on `window` — so a focused
          // row meant one `Enter` reached both handlers and the row's action ran
          // **twice**. Idempotent requests hid it (`file_list` sent twice,
          // `attachTerminal` called twice), but `ResumePanel`'s `openSession` is
          // not idempotent: two `session_switch` messages for one keypress. This
          // is the narrower of the two paths (it needs the row to have focus),
          // so it is the one that yields.
          e.stopPropagation();
          onPick();
        }
      }}
      style={selected ? { borderLeft: '2px solid var(--accent)' } : undefined}
    >
      {index !== undefined ? <span className="seq">{index}</span> : null}
      <span className="grow">{children}</span>
      {aside ? <span className="cmd-hint">{aside}</span> : null}
    </div>
  );
}
