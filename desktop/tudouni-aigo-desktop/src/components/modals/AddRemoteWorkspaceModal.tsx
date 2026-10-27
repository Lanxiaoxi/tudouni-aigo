import { useCallback, useEffect, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronUp,
  Folder,
  FolderPlus,
  Server,
  Terminal,
  X,
} from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { BusyDots, Tip } from '@/components/ui/kit';
import {
  appendSshHost,
  browseRemoteDirectory,
  createRemoteDirectory,
  probeRemoteHost,
  readSshConfig,
  type RemoteProbe,
  type RemoteProbeTarget,
  type SshConfigDocument,
} from '@/runtime/tauri';
import {
  buildHostBlock,
  findReusableHost,
  newHostProblem,
  workspaceLabel,
  type PendingHost,
} from './remoteWorkspace';

/**
 * Adding a remote workspace, as three steps that each answer one question.
 *
 * # Why this replaced a single form
 *
 * The first version asked for a host, a port, a user, key paths, a password, a
 * workspace directory and a runtime binary path — nine fields, all at once —
 * and saved them **without connecting**. Everything wrong with that is visible
 * from what the form could not tell the person filling it in:
 *
 *   - it could not say whether the credentials work, so a typo was discovered
 *     later, as a dead session;
 *   - it asked for a workspace directory as **free text**, which meant guessing
 *     an absolute path on a machine you are not sitting at — and finding out it
 *     was wrong only after connecting;
 *   - it asked where the runtime binary was, a question with no sensible answer
 *     before connecting, because whether one is installed is a fact about the
 *     far end;
 *   - it asked for a host's address and key paths by hand even though OpenSSH
 *     already knows them.
 *
 * All of that is answerable **by the remote host**, so the flow now asks in the
 * order the answers arrive:
 *
 *   1. **Which host** — a dropdown of the hosts in `~/.ssh/config`, which is
 *      where a host is already configured, plus "add a new one" for the case
 *      where there is none: that writes a `Host` block into the same file, so
 *      the person's own `ssh` gets it too (`appendSshHost`).
 *   2. **Connect** — one dial, and the far end reports its home, its platform,
 *      whether the Runtime is installed and at which version, and whether it has
 *      a usable `config.json`. A failure is a sentence here, while the form is
 *      still in front of the person, rather than a session that dies later.
 *   3. **Which directory** — a browser over the real directories on that host,
 *      starting at its home, with "new folder" for one that does not exist yet.
 *      Only then is anything saved or opened.
 *
 * # Why nothing is saved before step 3
 *
 * Saving a workspace is what makes a row in the sidebar, and a row that was
 * created from a host that turned out not to accept the key would be a bookmark
 * for a place that cannot be reached. So the host and the workspace are written
 * **together**, at the end, once both are known to be real. The consequence is
 * that abandoning the wizard leaves nothing behind — which is the ordinary
 * expectation of a Cancel button.
 *
 * # The password, and why it is not in `~/.ssh/config`
 *
 * `Password` is this project's own extension, not an OpenSSH keyword: writing it
 * into `~/.ssh/config` would break the person's own `ssh` with
 * `Bad configuration option: password` on every connection (see
 * `ssh_config::append_host`). It is therefore asked for at connect time and kept
 * in this application's own preferences, which is the existing, documented
 * trade-off (a plain file the desktop owns, `~/.tudouni/desktop.json`, not an
 * OS keychain) rather than a new one.
 */
type WizardStep = 'host' | 'connect' | 'workspace';

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
  const enterRemoteWorkspace = useApp((s) => s.enterRemoteWorkspace);

  const [step, setStep] = useState<WizardStep>('host');

  // ---- ~/.ssh/config ----
  const [sshConfig, setSshConfig] = useState<SshConfigDocument | null>(null);
  /** Which listed host is chosen: an alias, or `NEW` for the manual form. */
  const [selected, setSelected] = useState('');
  /** The manual form's fields, used only when `selected === NEW`. */
  const [draft, setDraft] = useState({
    alias: '',
    hostname: '',
    port: '22',
    user: '',
    identityFiles: '',
  });
  const [writingHost, setWritingHost] = useState(false);
  const [hostProblem, setHostProblem] = useState<string | null>(null);

  // ---- the connect step ----
  const [pending, setPending] = useState<PendingHost | null>(null);
  const [password, setPassword] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectProblem, setConnectProblem] = useState<string | null>(null);

  // ---- the workspace step ----
  const [probe, setProbe] = useState<RemoteProbe | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [browseProblem, setBrowseProblem] = useState<string | null>(null);
  /** A path typed rather than clicked, and the "new folder" field. */
  const [typedPath, setTypedPath] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const reset = useCallback(() => {
    setStep('host');
    setSshConfig(null);
    setSelected('');
    setDraft({ alias: '', hostname: '', port: '22', user: '', identityFiles: '' });
    setWritingHost(false);
    setHostProblem(null);
    setPending(null);
    setPassword('');
    setConnecting(false);
    setConnectProblem(null);
    setProbe(null);
    setBrowsing(false);
    setBrowseProblem(null);
    setTypedPath('');
    setNewFolder('');
    setCreating(false);
    setSaving(false);
  }, []);

  // The file is read when the dialog opens, and re-read after a host is added —
  // the list is the file, so once the file changes the list has to follow.
  const loadConfig = useCallback(async () => {
    const doc = await readSshConfig();
    setSshConfig(doc);
    return doc;
  }, []);

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

  /**
   * Go to the connect step with a host in hand.
   *
   * Skipping a host the file marks unselectable, and saying so rather than
   * silently doing nothing: the block names a field this program refuses to
   * ignore, so the connection would fail for a reason the person can act on.
   */
  function chooseHost(alias: string): void {
    const entry = sshConfig?.hosts.find((item) => item.alias === alias);
    if (!entry) return;
    if (entry.refused !== null) {
      setHostProblem(entry.refused);
      return;
    }
    setHostProblem(null);
    setPending({
      alias: entry.alias,
      host: entry.hostname,
      port: entry.port,
      user: entry.user,
      identityFiles: entry.identityFiles,
    });
    setConnectProblem(null);
    setStep('connect');
  }

  /** Write the manual form into `~/.ssh/config`, then carry on with it. */
  async function saveNewHost(): Promise<void> {
    const alias = draft.alias.trim();
    const hostname = draft.hostname.trim();
    const user = draft.user.trim();
    const port = Number.parseInt(draft.port, 10);

    // Validated by the shared rule the tests cover, so the button's disabled
    // state and this refusal cannot disagree about what "complete" means. The
    // rule answers with a **code**; the words come from the catalogue.
    const problem = newHostProblem(draft);
    if (problem !== null) {
      setHostProblem(t(`rw.newHost.${problem}` as const));
      return;
    }

    const identityFiles = draft.identityFiles
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

    setWritingHost(true);
    setHostProblem(null);
    try {
      // The block is built by the same function the tests assert on, so what
      // lands in the person's config is what was reviewed — and it carries no
      // password, which `appendSshHost` itself also enforces.
      await appendSshHost({ alias, hostname, port, user, identityFiles });
      // Re-read rather than trusting what was just written: the list on screen
      // is the file, and this is what keeps the two from being different.
      await loadConfig();
      setSelected(alias);
      setPending({ alias, host: hostname, port, user, identityFiles });
      setConnectProblem(null);
      setStep('connect');
    } catch (err) {
      setHostProblem(describe(err));
    } finally {
      setWritingHost(false);
    }
  }

  /** Step 2's one act: connect and learn what is on the far end. */
  async function connect(): Promise<void> {
    if (!pending) return;
    setConnecting(true);
    setConnectProblem(null);
    try {
      const target: RemoteProbeTarget = {
        host: pending.host,
        port: pending.port,
        user: pending.user,
        identityFiles: pending.identityFiles,
        password: password.trim() === '' ? null : password,
      };
      const result = await probeRemoteHost(target);
      setProbe(result);
      setTypedPath('');
      setBrowseProblem(null);
      setNewFolder('');
      setStep('workspace');
    } catch (err) {
      setConnectProblem(describe(err));
    } finally {
      setConnecting(false);
    }
  }

  /** List another directory on the same host, reusing this connection's target. */
  const targetFor = useCallback((): RemoteProbeTarget | null => {
    if (!pending) return null;
    return {
      host: pending.host,
      port: pending.port,
      user: pending.user,
      identityFiles: pending.identityFiles,
      password: password.trim() === '' ? null : password,
    };
  }, [pending, password]);

  const browse = useCallback(
    async (path: string) => {
      const target = targetFor();
      // The listing must not re-pay the probe: a click in the browser is a
      // directory question, and the host's facts (platform, runtime, config)
      // were answered by `connect` and do not change while the person moves.
      if (!target || probe === null) return;
      setBrowsing(true);
      setBrowseProblem(null);
      try {
        const listing = await browseRemoteDirectory(target, path);
        setProbe({
          ...probe,
          path: listing.path,
          parent: listing.parent,
          workspaceProblem: listing.workspaceProblem,
          entries: listing.entries,
        });
        setTypedPath('');
      } catch (err) {
        setBrowseProblem(describe(err));
      } finally {
        setBrowsing(false);
      }
    },
    [targetFor, probe],
  );

  async function makeFolder(): Promise<void> {
    const target = targetFor();
    if (!target || !probe || newFolder.trim() === '') return;
    setCreating(true);
    setBrowseProblem(null);
    try {
      // The name is a single segment under the directory on screen; a path with
      // a separator in it is still fine (mkdir is recursive), so this only
      // refuses the one thing that cannot be meant.
      const name = newFolder.trim();
      const full = name.startsWith('/') ? name : `${probe.path.replace(/\/$/, '')}/${name}`;
      const created = await createRemoteDirectory(target, full);
      setNewFolder('');
      await browse(created);
    } catch (err) {
      setBrowseProblem(describe(err));
    } finally {
      setCreating(false);
    }
  }

  /**
   * Step 3's one act: remember the host and the workspace, then open it.
   *
   * The host is written first and the workspace second, because the workspace
   * references the host by id — and both together at the end is what keeps a
   * cancelled wizard from leaving a row behind.
   *
   * **An already-saved host is reused, not duplicated.** Matching on
   * `user@host:port` rather than on the alias means a host that was picked from
   * `~/.ssh/config` under the same name twice is one record, so editing it later
   * is one edit rather than two that can drift.
   */
  async function openWorkspace(): Promise<void> {
    if (!probe || !pending) return;
    const remotePath = probe.path;
    if (probe.workspaceProblem !== null) return;

    setSaving(true);
    try {
      const existing = findReusableHost(useApp.getState().sshHosts, pending);
      const hostId =
        existing?.id ??
        addSshHost({
          label: pending.alias,
          host: pending.host,
          port: pending.port,
          user: pending.user,
          identityFiles: pending.identityFiles,
          ...(password.trim() === '' ? {} : { password: password.trim() }),
        });
      // A host that was reused keeps its stored fields, but a password typed in
      // this session is how the connection actually worked — recording it is
      // what saves the person from typing it again next time.
      if (existing && password.trim() !== '' && useApp.getState().sshHosts.find((h) => h.id === existing.id)?.password !== password.trim()) {
        useApp.getState().updateSshHost(existing.id, { password: password.trim() });
      }

      const workspaceId = addRemoteWorkspace({
        hostId,
        remotePath,
        // Empty means "not installed", which is a valid bookmark: opening it
        // installs the runtime and connects, and the path is written back. See
        // `enterRemoteWorkspace`.
        remoteBinary: probe.runtimeBinary ?? '',
        label: workspaceLabel(pending.alias, remotePath),
      });

      reset();
      onOpenChange(false);
      // Not awaited: the modal is gone, and the session reports its own failure
      // in its own row (`enterRemoteWorkspace` builds a `failed-…` bucket) —
      // waiting here would hold a closed dialog open over a download that can
      // take a minute.
      void enterRemoteWorkspace(workspaceId);
    } catch (err) {
      setBrowseProblem(describe(err));
      setSaving(false);
    }
  }

  /**
   * The exact `Host` block the manual form would append, for the preview above
   * the button. Empty until the form names something, so the preview never shows
   * a half-typed block that could not be written.
   */
  const previewLines = (() => {
    if (draft.alias.trim() === '' || draft.hostname.trim() === '') return [] as string[];
    return buildHostBlock({
      alias: draft.alias,
      host: draft.hostname,
      port: Number.parseInt(draft.port, 10) || 22,
      user: draft.user,
      identityFiles: draft.identityFiles
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    });
  })();

  const canCreate = probe !== null && newFolder.trim() !== '' && !creating && !browsing;

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
        <DialogPrimitive.Content className="dialog rw-dialog" data-step={step}>
          <div className="dialog-head">
            <div className="grow">
              <DialogPrimitive.Title className="dialog-title">
                {t('rw.title')}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="dialog-desc">
                {t(`rw.step.${step}.desc` as const)}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <button type="button" className="lb-icon" aria-label={t('common.cancel')}>
                <X size={13} />
              </button>
            </DialogPrimitive.Close>
          </div>

          {/* The three steps, named. A wizard that does not say how much is left
              reads as a form that keeps growing. */}
          <ol className="rw-steps" aria-label={t('rw.steps')}>
            {(['host', 'connect', 'workspace'] as const).map((name, index) => {
              const order: WizardStep[] = ['host', 'connect', 'workspace'];
              const current = order.indexOf(step);
              const state = index < current ? 'done' : index === current ? 'current' : 'next';
              return (
                <li key={name} className={`rw-step is-${state}`}>
                  <span className="rw-step-no">{state === 'done' ? <Check size={11} /> : index + 1}</span>
                  <span className="rw-step-name">{t(`rw.step.${name}.name` as const)}</span>
                </li>
              );
            })}
          </ol>

          <div className="dialog-body scroll-fade">
            {/* ---------------- 1. the host ---------------- */}
            {step === 'host' && (
              <>
                {sshConfig === null ? (
                  <p className="rw-note muted">
                    <BusyDots /> {t('rw.host.reading')}
                  </p>
                ) : (
                  <>
                    {/* The file's own hosts first, because that is where a host
                        is already configured — picking one is the whole point
                        of reading the file. */}
                    {sshConfig.hosts.length > 0 ? (
                      <div className="rw-hosts scroll-fade" role="radiogroup" aria-label={t('rw.host.list')}>
                        {sshConfig.hosts.map((entry) => {
                          const refused = entry.refused !== null;
                          return (
                            <button
                              key={entry.alias}
                              type="button"
                              role="radio"
                              aria-checked={selected === entry.alias}
                              className={`rw-host${selected === entry.alias ? ' is-selected' : ''}${refused ? ' is-refused' : ''}`}
                              onClick={() => {
                                setSelected(entry.alias);
                                setHostProblem(null);
                                chooseHost(entry.alias);
                              }}
                            >
                              <Server size={14} className="rw-host-icon" />
                              <span className="rw-host-body">
                                <span className="rw-host-name mono">{entry.alias}</span>
                                <span className="rw-host-addr caption muted">
                                  {entry.user}@{entry.hostname}
                                  {entry.port !== 22 ? `:${entry.port}` : ''}
                                </span>
                              </span>
                              {refused ? (
                                <Tip label={entry.refused ?? ''}>
                                  <span className="rw-host-tag is-warn">
                                    {t('rw.host.unsupported')}
                                  </span>
                                </Tip>
                              ) : (
                                <Check size={13} className="rw-host-check" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="rw-note muted">
                        {sshConfig.exists
                          ? t('rw.host.noHosts', { path: sshConfig.path })
                          : t('rw.host.noFile', { path: sshConfig.path })}
                      </p>
                    )}

                    {/* The file's own state, as a fact about the file — never a
                        claim that a host is reachable. */}
                    {sshConfig.problem !== null ? (
                      <p className="rw-note is-warn">
                        <AlertTriangle size={12} /> {sshConfig.problem}
                      </p>
                    ) : null}
                    <p className="rw-caption caption muted">
                      {t('rw.host.file', { path: sshConfig.path })}
                    </p>
                  </>
                )}

                {hostProblem !== null ? (
                  <p className="rw-note is-bad" role="alert">
                    <AlertTriangle size={12} /> {hostProblem}
                  </p>
                ) : null}

                {/* Adding a host writes to `~/.ssh/config` rather than to a
                    private list, so the person's own `ssh` gets it too. */}
                <details className="rw-new" open={sshConfig !== null && sshConfig.hosts.length === 0}>
                  <summary>{t('rw.host.addNew')}</summary>
                  <p className="rw-caption caption muted">{t('rw.host.addNewHint')}</p>
                  <div className="rw-grid">
                    <label className="rw-field">
                      <span className="etb-label">{t('rw.field.alias')}</span>
                      <input
                        className="input"
                        value={draft.alias}
                        placeholder="myserver"
                        onChange={(e) => setDraft({ ...draft, alias: e.target.value })}
                      />
                    </label>
                    <label className="rw-field">
                      <span className="etb-label">{t('rw.field.hostname')}</span>
                      <input
                        className="input"
                        value={draft.hostname}
                        placeholder="192.168.1.10"
                        onChange={(e) => setDraft({ ...draft, hostname: e.target.value })}
                      />
                    </label>
                    <label className="rw-field is-narrow">
                      <span className="etb-label">{t('rw.field.port')}</span>
                      <input
                        className="input"
                        inputMode="numeric"
                        value={draft.port}
                        onChange={(e) => setDraft({ ...draft, port: e.target.value })}
                      />
                    </label>
                    <label className="rw-field">
                      <span className="etb-label">{t('rw.field.user')}</span>
                      <input
                        className="input"
                        value={draft.user}
                        placeholder="root"
                        onChange={(e) => setDraft({ ...draft, user: e.target.value })}
                      />
                    </label>
                  </div>
                  <label className="rw-field">
                    <span className="etb-label">{t('rw.field.identity')}</span>
                    <textarea
                      className="input"
                      rows={2}
                      value={draft.identityFiles}
                      placeholder="/home/me/.ssh/id_ed25519"
                      onChange={(e) => setDraft({ ...draft, identityFiles: e.target.value })}
                    />
                  </label>
                  <p className="rw-caption caption muted">{t('rw.field.identityHint')}</p>

                  {/* **What will actually be written**, shown before it is. This
                      is somebody's own `~/.ssh/config`, often hand-edited and
                      often old, and a wizard that appends to it without showing
                      the block is asking for trust it has not earned. The preview
                      is the same function the test asserts on, so this is the
                      block — not a description of one. */}
                  {previewLines.length > 0 ? (
                    <div className="rw-preview">
                      <div className="rw-preview-label">{t('rw.host.preview')}</div>
                      <pre className="rw-preview-body mono">{previewLines.join('\n')}</pre>
                      <div className="rw-preview-path caption muted">
                        {t('rw.host.previewWhere', { path: sshConfig?.path ?? '~/.ssh/config' })}
                      </div>
                    </div>
                  ) : null}

                  <div className="rw-actions">
                    <button
                      type="button"
                      className="btn btn-outline"
                      disabled={writingHost}
                      onClick={() => void saveNewHost()}
                    >
                      {writingHost ? <BusyDots /> : null}
                      {t('rw.host.saveToConfig')}
                    </button>
                  </div>
                </details>
              </>
            )}

            {/* ---------------- 2. connect ---------------- */}
            {step === 'connect' && pending !== null && (
              <>
                <div className="rw-target">
                  <Server size={15} className="rw-host-icon" />
                  <span className="rw-host-body">
                    <span className="rw-host-name mono">{pending.alias}</span>
                    <span className="rw-host-addr caption muted">
                      {pending.user}@{pending.host}
                      {pending.port !== 22 ? `:${pending.port}` : ''}
                    </span>
                  </span>
                </div>

                <label className="rw-field">
                  <span className="etb-label">{t('rw.password')}</span>
                  <input
                    className="input"
                    type="password"
                    value={password}
                    autoComplete="off"
                    placeholder={t('rw.passwordPlaceholder')}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !connecting) void connect();
                    }}
                  />
                </label>
                <p className="rw-caption caption muted">{t('rw.passwordHint')}</p>

                {connectProblem !== null ? (
                  <p className="rw-note is-bad" role="alert">
                    <AlertTriangle size={12} /> {connectProblem}
                  </p>
                ) : null}

                {connecting ? (
                  <p className="rw-note muted">
                    <BusyDots /> {t('rw.connecting')}
                  </p>
                ) : null}
              </>
            )}

            {/* ---------------- 3. the workspace ---------------- */}
            {step === 'workspace' && probe !== null && (
              <>
                {/* What the far end said, as facts. The Runtime's own version is
                    shown because "is it installed, and which one" is exactly what
                    decides whether opening this workspace has to download
                    something first. */}
                <div className="rw-facts">
                  <span className="fact">
                    <Terminal size={11} /> {probe.os}/{probe.arch}
                  </span>
                  <span className="fact">{t('rw.fact.home')} {probe.home}</span>
                  {probe.runtimeBinary !== null ? (
                    <span className="fact">
                      {t('rw.fact.runtime')} {probe.runtimeVersion ?? t('rw.fact.runtimeUnknown')}
                    </span>
                  ) : probe.supported ? (
                    <span className="fact is-warn">{t('rw.fact.noRuntime')}</span>
                  ) : null}
                  {probe.configStatus === 'missing' || probe.configStatus === 'empty_template' ? (
                    <span className="fact is-warn">{t('rw.fact.noConfig')}</span>
                  ) : null}
                </div>

                {!probe.supported && probe.platformProblem !== null ? (
                  <p className="rw-note is-bad" role="alert">
                    <AlertTriangle size={12} /> {probe.platformProblem}
                  </p>
                ) : null}

                {/* The browser. The breadcrumb row is the path, the up row is
                    the way out, and the list is what is actually there. */}
                <div className="rw-browse">
                  <div className="rw-browse-head">
                    <Tip label={t('rw.up')}>
                      <button
                        type="button"
                        className="lb-icon"
                        aria-label={t('rw.up')}
                        disabled={probe.parent === null || browsing}
                        onClick={() => {
                          if (probe.parent !== null) void browse(probe.parent);
                        }}
                      >
                        <ChevronUp size={13} />
                      </button>
                    </Tip>
                    <span className="rw-path mono" title={probe.path}>
                      {probe.path}
                    </span>
                    {browsing ? <BusyDots /> : null}
                  </div>

                  <div className="rw-dirs scroll-fade">
                    {probe.entries.length === 0 ? (
                      <p className="rw-caption caption muted">{t('rw.noSubdirs')}</p>
                    ) : (
                      probe.entries.map((entry) => (
                        <button
                          key={entry.path}
                          type="button"
                          className="rw-dir"
                          disabled={browsing}
                          onClick={() => void browse(entry.path)}
                        >
                          <Folder size={13} className="rw-dir-icon" />
                          <span className="rw-dir-name">{entry.name}</span>
                        </button>
                      ))
                    )}
                  </div>

                  {/* Creating is a separate command from browsing, so looking
                      around a host cannot leave anything on it. */}
                  <div className="rw-newdir">
                    <FolderPlus size={13} className="muted" />
                    <input
                      className="input"
                      value={newFolder}
                      placeholder={t('rw.newFolderPlaceholder')}
                      onChange={(e) => setNewFolder(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && canCreate) void makeFolder();
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-outline btn-compact"
                      disabled={!canCreate}
                      onClick={() => void makeFolder()}
                    >
                      {t('rw.newFolder')}
                    </button>
                  </div>
                </div>

                {/* A path typed rather than clicked — for a directory the list
                    cannot show (a dot-directory, or one that does not exist
                    yet), which is also how a missing directory gets created
                    deliberately rather than by a failed browse. */}
                <label className="rw-field">
                  <span className="etb-label">{t('rw.pathLabel')}</span>
                  <input
                    className="input"
                    value={typedPath}
                    placeholder={probe.path}
                    onChange={(e) => setTypedPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && typedPath.trim() !== '') void browse(typedPath.trim());
                    }}
                  />
                </label>
                <p className="rw-caption caption muted">{t('rw.pathHint')}</p>

                {browseProblem !== null ? (
                  <p className="rw-note is-bad" role="alert">
                    <AlertTriangle size={12} /> {browseProblem}
                  </p>
                ) : null}

                {/* The runtime refuses the home directory and the filesystem
                    root as workspaces. Saying so here, next to the directory the
                    person is looking at, is the difference between a disabled
                    button with a reason and a session that dies on start-up. */}
                {probe.workspaceProblem !== null ? (
                  <p className="rw-note is-warn" role="status">
                    <AlertTriangle size={12} /> {t('rw.notAWorkspace')} {probe.workspaceProblem}.
                  </p>
                ) : (
                  <p className="rw-note is-ok" role="status">
                    <Check size={12} /> {t('rw.willUse')} <span className="mono">{probe.path}</span>
                  </p>
                )}
              </>
            )}
          </div>

          <div className="dialog-foot">
            {step !== 'host' ? (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={connecting || saving}
                onClick={() => {
                  setConnectProblem(null);
                  setBrowseProblem(null);
                  setStep(step === 'workspace' ? 'connect' : 'host');
                }}
              >
                <ArrowLeft size={13} />
                {t('common.back')}
              </button>
            ) : null}
            <span className="grow" />
            <DialogPrimitive.Close asChild>
              <button type="button" className="btn btn-outline">
                {t('common.cancel')}
              </button>
            </DialogPrimitive.Close>

            {step === 'connect' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={connecting}
                onClick={() => void connect()}
              >
                {connecting ? <BusyDots /> : null}
                {t('rw.connect')}
              </button>
            ) : null}

            {step === 'workspace' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving || browsing || probe?.workspaceProblem !== null}
                onClick={() => void openWorkspace()}
              >
                {saving ? <BusyDots /> : null}
                {probe?.runtimeBinary === null ? t('rw.installAndOpen') : t('rw.open')}
              </button>
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** An error as a sentence. `Error` already carries one from the Rust side; a
 *  non-`Error` throw is described rather than dropped. */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}
