import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Trash2 } from 'lucide-react';
import { useApp, type SshHostConfig } from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { Tip } from '@/components/ui/kit';

/**
 * The saved hosts, and the two things that had no surface at all.
 *
 * **A host record is not a workspace.** It is the account — user, address, port,
 * key or password — and several saved remote workspaces can sit on one. The
 * wizard writes them as a side effect of adding a workspace, and until this
 * dialog there was no way to look at the result:
 *
 *   - `removeSshHost` existed with its whole refusal rule ("still referenced by
 *     a saved workspace") and **zero callers**, so a host that had been mistyped
 *     once lived in `aigo.prefs` for ever;
 *   - `configPolicy` (§9.4) was written by the sync prompt's "remember" and read
 *     by the check, and nothing could show or change it. A host left on
 *     `use-remote` kept that answer silently, which is the kind of one-way state
 *     a person has no way to discover.
 *
 * Both live here rather than in the wizard, because both are about a host that
 * already exists: the wizard's job is to create one.
 *
 * **Deleting is refused, not cascaded.** Removing a host out from under a
 * workspace that names it would leave that workspace unable to say where it
 * lives — `removeSshHost`'s own rule, and the reason its answer is a boolean
 * rather than a silent success. The row says which workspaces are in the way
 * instead of just greying the button out.
 */
export function ManageHostsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const hosts = useApp((s) => s.sshHosts);
  const remoteWorkspaces = useApp((s) => s.remoteWorkspaces);
  const updateSshHost = useApp((s) => s.updateSshHost);
  const removeSshHost = useApp((s) => s.removeSshHost);

  /** The policies, in the order they are drawn: the default first, because
   *  "ask" is the one that can always be returned to. */
  const POLICIES: { value: NonNullable<SshHostConfig['configPolicy']>; label: TKey; hint: TKey }[] = [
    { value: 'ask', label: 'hosts.policy.ask', hint: 'hosts.policy.askHint' },
    { value: 'sync-local', label: 'hosts.policy.syncLocal', hint: 'hosts.policy.syncLocalHint' },
    { value: 'use-remote', label: 'hosts.policy.useRemote', hint: 'hosts.policy.useRemoteHint' },
  ];

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content className="dialog dialog-wide">
          <div className="dialog-head">
            <div className="grow">
              <DialogPrimitive.Title className="dialog-title">
                {t('hosts.title')}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="dialog-desc">
                {t('hosts.note')}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <button type="button" className="btn btn-ghost btn-compact" aria-label={t('common.close')}>
                {t('common.close')}
              </button>
            </DialogPrimitive.Close>
          </div>

          <div className="dialog-body scroll-fade">
            {hosts.length === 0 ? (
              <p className="set-hint">{t('hosts.empty')}</p>
            ) : (
              <div className="tk-list">
                {hosts.map((host) => {
                  // What references it, by label — the refusal's own reason, so
                  // the disabled button says *which* workspaces are in the way
                  // rather than only that something is.
                  const usedBy = remoteWorkspaces.filter((entry) => entry.hostId === host.id);
                  const policy = host.configPolicy ?? 'ask';
                  return (
                    <div key={host.id} className="host-row">
                      <div className="host-main">
                        <div className="host-title">
                          <span className="host-name">{host.label || host.host}</span>
                          <span className="host-address mono">
                            {host.user}@{host.host}:{host.port}
                          </span>
                        </div>
                        <div className="host-meta">
                          {host.identityFiles.length > 0
                            ? t('hosts.authKey', { n: host.identityFiles.length })
                            : host.password !== undefined
                              ? t('hosts.authPassword')
                              : t('hosts.authAgent')}
                          {usedBy.length > 0 ? (
                            <>
                              {' · '}
                              {t('hosts.usedBy', { names: usedBy.map((entry) => entry.label).join(', ') })}
                            </>
                          ) : null}
                        </div>
                      </div>

                      {/* The policy. Three radios rather than a select: a select
                          hides two thirds of the state behind a click, and this
                          is a setting whose *consequence* differs per option —
                          the hint under it changes with the choice. */}
                      <div className="host-policy" role="radiogroup" aria-label={t('hosts.policy')}>
                        {POLICIES.map((option) => (
                          <Tip key={option.value} label={t(option.hint)}>
                            <button
                              type="button"
                              role="radio"
                              aria-checked={policy === option.value}
                              className={`host-policy-option${policy === option.value ? ' is-on' : ''}`}
                              onClick={() => updateSshHost(host.id, { configPolicy: option.value })}
                            >
                              {t(option.label)}
                            </button>
                          </Tip>
                        ))}
                      </div>

                      <Tip
                        label={
                          usedBy.length > 0
                            ? t('lb.remote.forgetHostInUse')
                            : t('hosts.removeHint')
                        }
                      >
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon btn-compact"
                          aria-label={t('hosts.remove', { name: host.label || host.host })}
                          disabled={usedBy.length > 0}
                          onClick={() => {
                            removeSshHost(host.id);
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </Tip>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
