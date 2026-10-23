import { FolderOpen, HelpCircle, Search, Server } from 'lucide-react';
import { remoteConnectionOf, useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';

/**
 * §1·1 Top bar: program name + workspace path + help + the command palette entry.
 *
 * Narrow windows may drop the right-hand side; the brand never shrinks.
 *
 * The help icon sits **immediately left of the palette box**, as the pair of
 * things that answer "what can I type / what can I press". It is the only entry
 * point to the help panel: the first screen used to draw its own keybinding card
 * with a `/help` button in the corner, and that whole block is gone — a person
 * who wants the key table wants it mid-session, from a control that is on screen
 * the whole time, not from a card they scrolled past on the way in.
 *
 * The left rail's toggle is **not** here — it lives in the session bar, to the
 * left of the "Session" label. That bar is now the conversation column's own
 * header (see `SessionBar`), which puts the toggle at the top of the very
 * column the checkbox folds — the window's own bars keep only window-level
 * facts. See `SessionBar` for why it has to be outside the rail itself.
 *
 * There is no language switch here: the interface is English only, matching the
 * runtime, and the protocol carries no locale to switch to.
 */
export function TopBar() {
  const t = useT();
  // The workspace shown is the one the **active session** is in. With several
  // open there is no single answer for the window, and the session bar right
  // below names which conversation this is about.
  const workspace = useSessionField((rt) => rt.session?.workspace ?? rt.workspace, '');
  // **A bare path is not enough to say where this conversation is.** On a
  // remote screen `workspace` is a directory on the other host, and the same
  // string can name a directory on this machine too — a container mount, a WSL
  // share, or simply two projects that both chose `/srv/app`. The rail marks
  // its rows with a `Server` icon and a `user@host` tooltip; without the same
  // fact here, the one place a person confirms *which directory the runtime is
  // in* is the one place the two are indistinguishable. `remoteConnectionOf`
  // answers it the same way the sidebar and the file panel do, and `null` is
  // exactly "this one is local".
  const remote = useApp((s) =>
    remoteConnectionOf(s, s.activeKey),
  );
  const openPanel = useApp((s) => s.openPanel);
  const runtimeExit = useSessionField((rt) => rt.runtimeExit, null);
  const pickWorkspace = useApp((s) => s.pickWorkspace);

  // `user@host:port`, the same triple the rail's remote rows show, so the two
  // surfaces name one machine one way.
  const where =
    remote === null ? '' : `${remote.user}@${remote.host}:${remote.port}`;
  // The tooltip states the whole destination when it is remote, and the plain
  // path when it is not: a local session whose tooltip said "local" would be
  // noise, while a remote one that said only a path is the bug this fixes.
  const tip =
    remote === null
      ? workspace || t('topbar.workspaceTip')
      : t('topbar.workspaceRemoteTip', { where, path: workspace });

  return (
    <header className="topbar">
      <span className="brand">{t('app.name')}</span>

      <Tip label={tip}>
        <button
          type="button"
          className="workspace"
          onClick={() => openPanel('audit')}
          aria-label={tip}
        >
          {remote === null ? <FolderOpen size={11} /> : <Server size={11} />}
          {remote === null ? null : <span className="toppath-host">{where}</span>}
          <span className="truncate">{workspace || '—'}</span>
        </button>
      </Tip>

      {/* Changing the workspace means a different runtime process, so it is
          offered only when there is no runtime to disturb. */}
      {runtimeExit ? (
        <button type="button" className="btn btn-secondary btn-compact" onClick={() => void pickWorkspace()}>
          {t('topbar.pickWorkspace')}
        </button>
      ) : null}

      {/* `.topbar-help` carries the `margin-left: auto` that used to sit on the
          palette trigger — this button now leads the right-hand pair, so it is
          the one that has to absorb the free width. */}
      <Tip label={t('topbar.help')}>
        <button
          type="button"
          className="btn btn-ghost btn-icon topbar-help"
          onClick={() => openPanel('help')}
          aria-label={t('topbar.help')}
        >
          <HelpCircle size={13} />
        </button>
      </Tip>

      <button
        type="button"
        className="palette-trigger"
        onClick={() => openPanel('commands')}
        aria-keyshortcuts="Control+K"
      >
        <Search size={13} className="muted" />
        <span className="pt-label">{t('topbar.palettePlaceholder')}</span>
        <kbd className="kbd">Ctrl K</kbd>
      </button>
    </header>
  );
}
