import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';

/**
 * The `ask` config-sync prompt (§9.4): a local config and a remote one have
 * both changed since the last synced baseline, and the saved host's policy
 * is `'ask'` — so a person decides which one wins, rather than either side
 * being silently overwritten.
 *
 * Only the structural facts are shown — the remote status and whether a
 * local file exists at all — never provider names or key values (§9.4:
 * "the UI shows only the necessary provider names and configuration
 * structure, never key values"). This first version keeps that boundary
 * the simplest possible way: it shows nothing about either file's content,
 * only which one is being chosen.
 */
export function ConfigSyncPromptModal() {
  const t = useT();
  const prompt = useApp((s) => s.configSyncPrompt);
  const resolveConfigSync = useApp((s) => s.resolveConfigSync);
  const dismissConfigSync = useApp((s) => s.dismissConfigSync);

  const open = prompt !== null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) dismissConfigSync(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content className="dialog">
          <div className="dialog-head">
            <div className="grow">
              <DialogPrimitive.Title className="dialog-title">{t('cfgsync.title')}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="dialog-desc">
                {t('cfgsync.subtitle')}
              </DialogPrimitive.Description>
            </div>
          </div>

          <div className="dialog-body scroll">
            <p className="caption muted">
              {prompt?.localText === null ? t('cfgsync.noLocal') : t('cfgsync.hasLocal')}
            </p>
            <p className="caption muted">
              {prompt?.remoteStatus === 'missing'
                ? t('cfgsync.remoteMissing')
                : prompt?.remoteStatus === 'valid'
                  ? t('cfgsync.remoteValid')
                  : t('cfgsync.remoteOther')}
            </p>
          </div>

          <div className="dialog-foot">
            <span className="grow" />
            <button type="button" className="btn btn-outline" onClick={dismissConfigSync}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-outline"
              disabled={prompt?.remoteStatus === 'missing'}
              onClick={() => void resolveConfigSync('use-remote')}
            >
              {t('cfgsync.useRemote')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={prompt?.localText === null}
              onClick={() => void resolveConfigSync('use-local')}
            >
              {t('cfgsync.useLocal')}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
