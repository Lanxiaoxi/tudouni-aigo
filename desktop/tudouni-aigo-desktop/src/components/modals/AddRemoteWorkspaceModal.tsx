import { useEffect, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { readSshConfig, type SshConfigDocument } from '@/runtime/tauri';

/**
 * The form for saving a new remote workspace: a host and the directory on it.
 *
 * This is a **local** decision, like `CloseConfirm` — nothing here is a
 * request the runtime is waiting on, so it is a plain `DialogPrimitive`
 * rather than one of the two blocking modals in `modal/`. Saving a host and a
 * workspace is also two separate acts in the store (`addSshHost`,
 * `addRemoteWorkspace`), kept as one form here because a person adding their
 * first remote workspace has no host to pick yet — a two-step flow (go add a
 * host, then come back and add a workspace) would ask them to context-switch
 * for information they already have in front of them.
 *
 * **No connection is attempted here.** Saving an entry is exactly as local an
 * act as `addWorkspace` for a local directory (see that method's own doc):
 * the form validates that the fields are not empty and nothing more.
 * Whether the host is reachable, the key authenticates, and the binary
 * exists at that path are all questions `enterRemoteWorkspace` answers when
 * the row is actually opened — asking them here would make saving a
 * workspace description depend on being connected to the network right now,
 * which is not a requirement "bookmark this place" should carry.
 *
 * **The host picker reads `~/.ssh/config` for prefill only.** OpenSSH is
 * where a person has already written down exactly what this form asks for —
 * the destination, the port, the user, the keys — so re-typing it is asking
 * for the same fact twice. The picker therefore lists the file's concrete
 * `Host` blocks and filling the form from one is still an *editable*
 * suggestion: every field it writes can be changed, Save validates nothing
 * about reachability, and a block the Go side's own dial rules refuse
 * (`ProxyJump` and friends) is listed but marked, not silently dropped —
 * dropping it would be the form answering a question only the person can
 * answer ("do you still want this host?"). The file is read when the dialog
 * opens; a missing file is an ordinary state and the manual fields simply
 * work as before.
 *
 * Identity files are entered as one path per line rather than a repeating
 * field group, because the ordinary case is one key and the design (§ dial.go
 * `loadIdentityFiles`) already tries several in order when there is more than
 * one — a text area is the simplest control that still expresses "a list,
 * tried in order" without inventing add/remove row chrome for the uncommon
 * case.
 */
export function AddRemoteWorkspaceModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const addSshHost = useApp((s) => s.addSshHost);
  const addRemoteWorkspace = useApp((s) => s.addRemoteWorkspace);

  const [hostLabel, setHostLabel] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('');
  const [identityFilesText, setIdentityFilesText] = useState('');
  const [password, setPassword] = useState('');
  const [remotePath, setRemotePath] = useState('');
  const [remoteBinary, setRemoteBinary] = useState('');
  const [workspaceLabel, setWorkspaceLabel] = useState('');
  // The picker: the file's own hosts, read once when the dialog opens.
  // `null` = not read yet (or not hosted, where it stays null and the
  // manual fields are the whole form).
  const [sshConfig, setSshConfig] = useState<SshConfigDocument | null>(null);
  // Which host the fields are currently filled from: an alias, or `''`
  // for "the person typed these" (manual). Re-synced back to `''` the
  // moment any host field is edited by hand, so the select never claims
  // a prefill the fields have since moved away from.
  const [selectedAlias, setSelectedAlias] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void readSshConfig().then((doc) => {
      if (!cancelled) setSshConfig(doc);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  /** Fill the host fields from one listed block. An *editable* prefill:
   *  every value lands in the form's own state and Save validates it, so
   *  this writes nothing the person cannot correct before saving. */
  function applyPicked(alias: string): void {
    const picked = sshConfig?.hosts.find((entry) => entry.alias === alias);
    if (!picked) return;
    setSelectedAlias(alias);
    setHost(picked.hostname);
    setPort(String(picked.port));
    setUser(picked.user);
    setIdentityFilesText(picked.identityFiles.join('\n'));
    // A block the file gives a name to gets that name, and nothing is
    // written over a label the person has already chosen themselves.
    setHostLabel((current) => (current.trim() !== '' ? current : alias));
  }

  /** Any hand edit of a host field ends the prefill's claim on it. */
  function manualHostEdit(field: 'host' | 'port' | 'user' | 'identityFiles', next: string): void {
    if (field === 'host') setHost(next);
    else if (field === 'port') setPort(next);
    else if (field === 'user') setUser(next);
    else setIdentityFilesText(next);
    setSelectedAlias('');
  }

  function reset() {
    setHostLabel('');
    setHost('');
    setPort('22');
    setUser('');
    setIdentityFilesText('');
    setPassword('');
    setRemotePath('');
    setRemoteBinary('');
    setWorkspaceLabel('');
    setSshConfig(null);
    setSelectedAlias('');
  }

  const portNumber = Number.parseInt(port, 10);
  const canSave =
    host.trim() !== '' &&
    user.trim() !== '' &&
    Number.isInteger(portNumber) &&
    portNumber > 0 &&
    portNumber <= 65535 &&
    remotePath.trim() !== '' &&
    remoteBinary.trim() !== '';

  function save() {
    if (!canSave) return;
    const identityFiles = identityFilesText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const hostId = addSshHost({
      label: hostLabel.trim() !== '' ? hostLabel.trim() : `${user.trim()}@${host.trim()}`,
      host: host.trim(),
      port: portNumber,
      user: user.trim(),
      identityFiles,
      ...(password.trim() !== '' ? { password: password.trim() } : {}),
    });
    addRemoteWorkspace({
      hostId,
      remotePath: remotePath.trim(),
      remoteBinary: remoteBinary.trim(),
      label: workspaceLabel.trim() !== '' ? workspaceLabel.trim() : remotePath.trim(),
    });
    reset();
    onOpenChange(false);
  }

  /** The picker's caption, for the states a list does not cover: the file
   *  exists but names no concrete host, a `Match` block refuses the whole
   *  file, or the file could not be read. Each is a fact about the file,
   *  not a form error — the manual fields stay fully usable. */
  const pickerCaption: string | null =
    sshConfig?.problem ??
    (sshConfig !== null && sshConfig.exists && sshConfig.hosts.length === 0
      ? t('lb.remote.picker.noHosts', { path: sshConfig.path })
      : null);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content className="dialog">
          <div className="dialog-head">
            <div className="grow">
              <DialogPrimitive.Title className="dialog-title">
                {t('lb.addRemoteWorkspace')}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="dialog-desc">
                {t('lb.addRemoteWorkspaceHint')}
              </DialogPrimitive.Description>
            </div>
          </div>

          <div className="dialog-body scroll">
            {/* The host picker: the file's own Host blocks, as a prefill.
                Shown only when there is at least one concrete host to
                offer — an empty list is the manual form, and a caption for
                the "file read, nothing usable" states below it. */}
            {sshConfig !== null && (sshConfig.hosts.length > 0 || pickerCaption !== null) && (
              <div style={{ marginBottom: 'var(--space-3)' }}>
                {sshConfig.hosts.length > 0 && (
                  <>
                    <div className="etb-label">{t('lb.remote.picker.title')}</div>
                    <select
                      className="input"
                      style={{ display: 'block', width: '100%', marginTop: 4 }}
                      value={selectedAlias}
                      onChange={(e) => {
                        const alias = e.target.value;
                        setSelectedAlias(alias);
                        if (alias !== '') applyPicked(alias);
                      }}
                    >
                      <option value="">{t('lb.remote.picker.manual')}</option>
                      {sshConfig.hosts.map((entry) => (
                        <option key={entry.alias} value={entry.alias} disabled={entry.refused !== null}>
                          {entry.alias}
                          {entry.refused !== null ? ` — ${t('lb.remote.picker.unsupported')}` : ''}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                <p className="caption muted" style={{ marginTop: 4 }}>
                  {pickerCaption ?? t('lb.remote.picker.caption', { path: sshConfig.path })}
                </p>
              </div>
            )}

            <div className="etb-label">{t('lb.remote.hostLabel')}</div>
            <input
              className="input"
              style={{ display: 'block', width: '100%', marginTop: 4, marginBottom: 'var(--space-3)' }}
              value={hostLabel}
              onChange={(e) => setHostLabel(e.target.value)}
              placeholder={t('lb.remote.hostLabelPlaceholder')}
            />

            <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'flex-start' }}>
              <div className="grow">
                <div className="etb-label">{t('lb.remote.host')}</div>
                <input
                  className="input"
                  style={{ display: 'block', width: '100%', marginTop: 4 }}
                  value={host}
                  onChange={(e) => manualHostEdit('host', e.target.value)}
                  placeholder="example.com"
                />
              </div>
              <div style={{ width: 80 }}>
                <div className="etb-label">{t('lb.remote.port')}</div>
                <input
                  className="input"
                  style={{ display: 'block', width: '100%', marginTop: 4 }}
                  value={port}
                  onChange={(e) => manualHostEdit('port', e.target.value)}
                  inputMode="numeric"
                />
              </div>
            </div>

            <div className="etb-label" style={{ marginTop: 'var(--space-3)' }}>
              {t('lb.remote.user')}
            </div>
            <input
              className="input"
              style={{ display: 'block', width: '100%', marginTop: 4 }}
              value={user}
              onChange={(e) => manualHostEdit('user', e.target.value)}
            />

            <div className="etb-label" style={{ marginTop: 'var(--space-3)' }}>
              {t('lb.remote.identityFiles')}
            </div>
            <textarea
              className="input"
              style={{ display: 'block', width: '100%', marginTop: 4, minHeight: 48, resize: 'vertical' }}
              rows={2}
              value={identityFilesText}
              onChange={(e) => manualHostEdit('identityFiles', e.target.value)}
              placeholder="/home/me/.ssh/id_ed25519"
            />

            <div className="etb-label" style={{ marginTop: 'var(--space-3)' }}>
              {t('lb.remote.password')}
            </div>
            <input
              className="input"
              style={{ display: 'block', width: '100%', marginTop: 4 }}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="caption muted" style={{ marginTop: 4 }}>
              {t('lb.remote.passwordWarning')}
            </p>

            <div className="etb-label" style={{ marginTop: 'var(--space-3)' }}>
              {t('lb.remote.remoteBinary')}
            </div>
            <input
              className="input"
              style={{ display: 'block', width: '100%', marginTop: 4 }}
              value={remoteBinary}
              onChange={(e) => setRemoteBinary(e.target.value)}
              placeholder="/opt/tudouni-aigo/bin/tudouni-aigo"
            />

            <div className="etb-label" style={{ marginTop: 'var(--space-3)' }}>
              {t('lb.remote.remotePath')}
            </div>
            <input
              className="input"
              style={{ display: 'block', width: '100%', marginTop: 4 }}
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              placeholder="/srv/app"
            />

            <div className="etb-label" style={{ marginTop: 'var(--space-3)' }}>
              {t('lb.remote.workspaceLabel')}
            </div>
            <input
              className="input"
              style={{ display: 'block', width: '100%', marginTop: 4 }}
              value={workspaceLabel}
              onChange={(e) => setWorkspaceLabel(e.target.value)}
              placeholder={remotePath.trim() !== '' ? remotePath : undefined}
            />
          </div>

          <div className="dialog-foot">
            <span className="grow" />
            <DialogPrimitive.Close asChild>
              <button type="button" className="btn btn-outline">
                <X size={13} />
                {t('common.cancel')}
              </button>
            </DialogPrimitive.Close>
            <button type="button" className="btn btn-primary" disabled={!canSave} onClick={save}>
              {t('lb.remote.save')}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
