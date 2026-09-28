import { FolderOpen, Search } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { formatPath } from '@/utils/format';

/**
 * §1·1 Top bar: program name + workspace path + the command palette entry.
 *
 * Narrow windows may drop the right-hand side; the brand never shrinks.
 *
 * There is no language switch here: the interface is English only, matching the
 * runtime, and the protocol carries no locale to switch to.
 */
export function TopBar() {
  const t = useT();
  const workspace = useApp((s) => s.session?.workspace ?? '');
  const openPanel = useApp((s) => s.openPanel);
  const runtimeExit = useApp((s) => s.runtimeExit);
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
          <span className="truncate">{workspace ? formatPath(workspace, 48) : '—'}</span>
        </button>
      </Tip>

      {/* Changing the workspace means a different runtime process, so it is
          offered only when there is no runtime to disturb. */}
      {runtimeExit ? (
        <button type="button" className="btn btn-secondary btn-compact" onClick={() => void pickWorkspace()}>
          {t('topbar.pickWorkspace')}
        </button>
      ) : null}

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
