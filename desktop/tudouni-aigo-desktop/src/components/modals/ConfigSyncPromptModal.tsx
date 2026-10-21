import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { BusyDots } from '@/components/ui/kit';
import { useApp } from '@/state/store';
import type { ConfigSyncChoice } from '@/state/configSync';
import { useT } from '@/i18n/useT';

/**
 * The `ask` config-sync prompt (§9.4): the local config and the remote one have
 * moved apart since they were last compared, and the saved host's policy is
 * `'ask'` — so a person decides which one wins, rather than either side being
 * silently overwritten.
 *
 * Only the structural facts are shown — the remote status and whether a
 * local file exists at all — never provider names or key values (§9.4:
 * "the UI shows only the necessary provider names and configuration
 * structure, never key values"). This first version keeps that boundary
 * the simplest possible way: it shows nothing about either file's content,
 * only which one is being chosen.
 *
 * **Answering takes a second or two, and the dialog says so.** Each answer
 * opens a fresh SSH connection and speaks SFTP over it (`remote_config.rs`
 * dials per command), so "use local (overwrite remote)" is a real network
 * round trip. Before `configSyncBusy` existed the dialog sat there looking
 * frozen for that whole stretch — the exact "the interface has hung" report
 * this fixes. While an answer is in flight: the buttons are disabled, the
 * chosen one keeps its place and says what it is doing, Cancel is
 * unavailable (the write cannot be cancelled, and abandoning the open
 * mid-write would leave it resuming with nothing on screen having asked),
 * and the dialog refuses to close on Esc or an overlay click.
 *
 * **The reason is named, not assumed.** The old subtitle said both files had
 * changed, which was wrong on a first sync (there is no baseline yet) and
 * wrong again when only the remote moved — and "it asked me again" is
 * unanswerable without knowing which of those it is. `firstSync` plus the
 * conflict is enough to say it exactly.
 *
 * **The answer can be remembered.** `configPolicy` had readers and no
 * writer: every host stayed `'ask'` forever, so a person who answered "use
 * local" ten times was asked an eleventh. Ticking the box stores the answer
 * on the host; unticking it leaves the host asking.
 *
 * **A refusal is shown here, not swallowed.** The upload is the failure-prone
 * half of the flow, and a closed dialog with nothing to read is the worst report
 * of it: the write's own message goes in the dialog body (`configSyncError`) and
 * the buttons stay live to retry it.
 */
export function ConfigSyncPromptModal() {
  const t = useT();
  const prompt = useApp((s) => s.configSyncPrompt);
  const busy = useApp((s) => s.configSyncBusy);
  const error = useApp((s) => s.configSyncError);
  const resolveConfigSync = useApp((s) => s.resolveConfigSync);
  const dismissConfigSync = useApp((s) => s.dismissConfigSync);

  // Remembering is the default: the question is being asked because the two
  // files disagree, and a person who has just said which side they trust is
  // unlikely to want to say it again on the next open. Unticking it is one
  // click, and the host keeps asking.
  const [remember, setRemember] = useState(true);

  // The tick is per answer, not per window: a second prompt is about a different
  // host, and an unticked box left over from the first one would silently change
  // what the second answer means.
  const hostId = prompt?.hostId ?? null;
  useEffect(() => setRemember(true), [hostId]);

  const open = prompt !== null;
  const writing = busy !== null;

  const answer = (choice: ConfigSyncChoice) => {
    // The store re-raises a failed write so programmatic callers see it; here the
    // sentence is already on screen through `configSyncError`, so the rejection is
    // consumed instead of becoming an unhandled one.
    void resolveConfigSync(choice, { remember }).catch(() => {});
  };

  const reason =
    prompt === null
      ? ''
      : prompt.firstSync
        ? t('cfgsync.reason.firstSync')
        : prompt.conflict === 'remote_changed'
          ? t('cfgsync.reason.remoteChanged')
          : prompt.conflict === 'both_changed'
            ? t('cfgsync.reason.bothChanged')
            : t('cfgsync.reason.localChanged');

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        // Esc and the overlay are the same "not now" — refused while a write
        // is in flight, for the reason in this component's doc.
        if (!next && !writing) dismissConfigSync();
      }}
    >
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

          <div className="dialog-body scroll-fade">
            <p className="caption">{reason}</p>
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

            {writing ? (
              <p className="caption muted" role="status">
                <BusyDots />{' '}
                {busy === 'use-local' ? t('cfgsync.writing') : t('cfgsync.reading')}
              </p>
            ) : null}

            {error !== null ? (
              <p className="rw-note is-bad" role="alert">
                <AlertTriangle size={12} /> {error}
              </p>
            ) : null}

            <label className="cfgsync-remember">
              <input
                type="checkbox"
                checked={remember}
                disabled={writing}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span className="cfgsync-remember-text">
                <span>{t('cfgsync.remember')}</span>
                <span className="caption muted">{t('cfgsync.rememberHint')}</span>
              </span>
            </label>
          </div>

          <div className="dialog-foot">
            <span className="grow" />
            <button
              type="button"
              className="btn btn-outline"
              disabled={writing}
              onClick={dismissConfigSync}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-outline"
              disabled={writing || prompt?.remoteStatus === 'missing'}
              onClick={() => answer('use-remote')}
            >
              {busy === 'use-remote' ? <BusyDots /> : null}
              {t('cfgsync.useRemote')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={writing || prompt?.localText === null}
              onClick={() => answer('use-local')}
            >
              {busy === 'use-local' ? <BusyDots /> : null}
              {t('cfgsync.useLocal')}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
