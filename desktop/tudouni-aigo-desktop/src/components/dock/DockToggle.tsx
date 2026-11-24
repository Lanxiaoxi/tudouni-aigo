import { FolderTree } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { DOCK_SHORTCUT_ARIA, DOCK_SHORTCUT_LABELS } from '@/state/workspaceDock/shortcuts';

/**
 * The Workspace Dock's master switch.
 *
 * It lives in the top bar, **outside the dock**, for the reason the rail
 * toggles live in the session bar: a control inside the thing it hides cannot
 * bring it back (docs/design/workspace-dock.md §2.3).
 */
export function DockToggle() {
  const t = useT();
  const open = useApp((s) => s.dockOpen);
  const toggleDock = useApp((s) => s.toggleDock);
  const label = open ? t('dock.toggle.close') : t('dock.toggle.open');
  return (
    <Tip label={`${label} (${DOCK_SHORTCUT_LABELS.dock})`}>
      <button
        type="button"
        className={`btn btn-ghost btn-icon dock-toggle${open ? ' is-active' : ''}`}
        aria-label={label}
        aria-expanded={open}
        aria-keyshortcuts={DOCK_SHORTCUT_ARIA.dock}
        onClick={toggleDock}
      >
        <FolderTree size={14} />
      </button>
    </Tip>
  );
}
