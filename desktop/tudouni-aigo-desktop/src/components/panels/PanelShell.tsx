import { createContext, useContext, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowLeft, X } from 'lucide-react';
import { useT } from '@/i18n/useT';

/**
 * 弹层面板统一外壳。
 *
 * §5：每块需要「标识 + 条数 + 空状态文案」；
 * component-states.md §9：容器 radius-xl + shadow-modal，Esc / 遮罩点击关闭。
 * Radix Dialog 负责 Esc、焦点陷阱与 aria 关系，视觉全部来自设计系统。
 *
 * **The surface context.** The shell is drawn in two places: inside the
 * Radix dialog (`PanelHost`), where the primitives below belong, and inside
 * the status bar's anchored popover (`StatusPopover`), where the same
 * primitives would throw "Missing Dialog.Root" — and where the Esc, the
 * outside-click and the focus return are already the popover's. The default
 * surface is `dialog`, so `PanelHost` needs no wrapper; the popover side
 * provides `PopoverSurface`.
 *
 * **The head is shaped here because it is shared.** Three things a panel's
 * *second* surface needs and its first does not: a `?` beside the title
 * (`info`), a leading way back (`onBack`), and controls of its own (`actions` —
 * "Add a route" belongs to the list, never to the editor opened from it). They
 * are props rather than a second shell, because everything else about the two
 * surfaces is the same: the title, the description, the close button, the body
 * and the footer.
 */
type PanelSurface =
  | { kind: 'dialog' }
  | { kind: 'popover'; close: () => void };

const DIALOG_SURFACE: PanelSurface = { kind: 'dialog' };
const PanelSurfaceContext = createContext<PanelSurface>(DIALOG_SURFACE);

/**
 * Marks the shell as drawn inside a popover: the header's close button is a
 * plain button (no Dialog primitives), and `close` is the popover's own
 * open-state setter — the same state the popover's Esc and outside-click go
 * through, so the three ways out cannot disagree about what is open.
 */
export const PopoverSurface = ({
  close,
  children,
}: {
  close: () => void;
  children: ReactNode;
}) => (
  <PanelSurfaceContext.Provider value={{ kind: 'popover', close }}>
    {children}
  </PanelSurfaceContext.Provider>
);

/** The surface a panel is drawn in.
 *
 *  Exported for panels that live **only inside the status bar's popover**
 *  (the quiet-mode menu): a pick has to close *that* popover — the store's
 *  `panel` is a different thing, and closing it from here would be a no-op
 *  that leaves the menu up. */
export function usePanelSurface(): PanelSurface {
  return useContext(PanelSurfaceContext);
}
export function PanelShell({
  title,
  titleAside,
  titleClass,
  count,
  note,
  info,
  onBack,
  backLabel,
  actions,
  children,
  footer,
}: {
  title: string;
  /** A mark that belongs to the title itself — the route editor's DRAFT chip.
   *  `count` is deliberately not reused for this: a count is a number in the
   *  shared vocabulary, and a draft is a state of the thing being edited. */
  titleAside?: ReactNode;
  /** An extra class on the title element, for the one surface whose title is a
   *  key rather than a sentence (the route editor's mono route name). */
  titleClass?: string;
  count?: ReactNode;
  note?: string;
  /** The `?` beside the title. See `PanelInfo`: a definition, not a control. */
  info?: ReactNode;
  /** Present on a panel's **second surface** — the editor a list row opens —
   *  where the way back has to be a control and not an Escape key. When it is
   *  set the head leads with it, the way the tasks history leads with its own. */
  onBack?: () => void;
  backLabel?: string;
  /** The head's own controls, to the right of the title and left of the close.
   *  Per-surface on purpose: the list surface offers "Add a route", the editor
   *  that opens from it does not. */
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useT();
  const surface = useContext(PanelSurfaceContext);
  // The header's close button: the dialog's own `Close` primitive in the
  // modal case, the popover's `setOpen(false)` when the popover is the surface.
  const onSurfaceClose = surface.kind === 'popover' ? surface.close : undefined;

  const titleNode =
    surface.kind === 'dialog' ? (
      <DialogPrimitive.Title
        className={`dialog-title${info ? ' tk-title' : ''}${titleClass !== undefined ? ` ${titleClass}` : ''}`}
      >
        <span className="dialog-title-text">{title}</span>
        {titleAside}
        {info}
      </DialogPrimitive.Title>
    ) : (
      <span className={`dialog-title${info ? ' tk-title' : ''}${titleClass !== undefined ? ` ${titleClass}` : ''}`}>
        <span className="dialog-title-text">{title}</span>
        {titleAside}
        {info}
      </span>
    );
  const descNode =
    surface.kind === 'dialog' ? (
      note ? (
        <DialogPrimitive.Description className="dialog-desc">{note}</DialogPrimitive.Description>
      ) : (
        <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
      )
    ) : note ? (
      <span className="dialog-desc">{note}</span>
    ) : (
      <span className="sr-only">{title}</span>
    );

  return (
    <>
      <div className="dialog-head tk-head">
        {onBack !== undefined ? (
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={backLabel ?? t('panel.back')}
            title={backLabel ?? t('panel.back')}
            onClick={onBack}
          >
            <ArrowLeft size={15} />
          </button>
        ) : null}
        <div className="grow">
          {titleNode}
          {descNode}
        </div>

        {count !== undefined ? <span className="count">{count}</span> : null}

        {actions}

        {surface.kind === 'dialog' ? (
          <DialogPrimitive.Close asChild>
            <button type="button" className="btn btn-ghost btn-icon" aria-label={t('panel.close')}>
              <X size={14} />
            </button>
          </DialogPrimitive.Close>
        ) : (
          <button type="button" className="btn btn-ghost btn-icon" aria-label={t('panel.close')} onClick={onSurfaceClose}>
            <X size={14} />
          </button>
        )}
      </div>

      {children}
      {footer ? <div className="dialog-foot">{footer}</div> : null}
    </>
  );
}

/** 面板内容区（可滚） */
export function PanelBody({ children }: { children: ReactNode }) {
  return <div className="dialog-body scroll-fade">{children}</div>;
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
