import { FolderOpen, HelpCircle, Search } from 'lucide-react';
import { useApp, useSessionField } from '@/state/store';
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
  const openPanel = useApp((s) => s.openPanel);
  const runtimeExit = useSessionField((rt) => rt.runtimeExit, null);
  const pickWorkspace = useApp((s) => s.pickWorkspace);

  return (
    <header className="topbar">
      <span className="brand">{t('app.name')}</span>

      <Tip label={workspace || t('topbar.workspaceTip')}>
        <button
          type="button"
          className="workspace"
          onClick={() => openPanel('audit')}
          aria-label={t('topbar.workspaceTip')}
        >
          <FolderOpen size={11} />
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
