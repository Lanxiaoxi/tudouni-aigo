import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useT } from '@/i18n/useT';

export interface PendingWorkspaceClose {
  /** What the row is called, for the sentence. */
  name: string;
  /** How many terminals would end. */
  running: number;
}

/**
 * The question asked before a workspace with running terminals is removed from
 * the list (design 9.4: a workspace's terminals are never ended without an
 * explicit act). Same dialog shape as the terminal tab's own confirmation.
 */
export function CloseWorkspaceConfirm({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingWorkspaceClose | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <DialogPrimitive.Root
      open={pending !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content className="dialog">
          <div className="dialog-head">
            <div className="grow">
              <DialogPrimitive.Title className="dialog-title">{t('dock.closeWorkspace.title')}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="dialog-desc">
                {pending === null
                  ? ''
                  : t('dock.closeWorkspace.body', { name: pending.name, n: pending.running })}
              </DialogPrimitive.Description>
            </div>
          </div>
          <div className="dialog-foot">
            <span className="grow" />
            <button type="button" className="btn btn-outline" onClick={onCancel}>
              {t('common.cancel')}
              <kbd className="kbd" style={{ marginLeft: 4 }}>
                Esc
              </kbd>
            </button>
            <button type="button" className="btn btn-destructive" onClick={onConfirm}>
              {t('dock.closeWorkspace.action')}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
