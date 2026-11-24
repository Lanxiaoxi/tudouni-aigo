import { Ban, FolderX, Unplug } from 'lucide-react';
import type { TKey } from '@/i18n';
import { useT } from '@/i18n/useT';
import { EmptyState } from '@/components/ui/kit';
import type { DockRegion, RegionState } from '@/state/workspaceDock/capabilities';
import { reconnectActiveHost } from './useDockCapabilities';

const UNSUPPORTED: Record<DockRegion, TKey> = {
  files: 'dock.empty.unsupported.files',
  git: 'dock.empty.unsupported.git',
  terminal: 'dock.empty.unsupported.terminal',
};

/**
 * What a region shows instead of its module when it may not draw: no workspace,
 * a host that has not answered, or a capability the host says it lacks. An empty
 * state, never an error — the missing thing is a fact about the workspace, not a
 * failure of the window.
 */
export function DockEmpty({ state, region }: { state: Exclude<RegionState, 'ready'>; region: DockRegion }) {
  const t = useT();
  if (state === 'no-workspace') {
    return (
      <div className="dock-empty">
        <EmptyState
          icon={<FolderX size={18} />}
          title={t('dock.empty.noWorkspace.title')}
          hint={t('dock.empty.noWorkspace.hint')}
        />
      </div>
    );
  }
  if (state === 'not-connected') {
    return (
      <div className="dock-empty">
        <EmptyState
          icon={<Unplug size={18} />}
          title={t('dock.empty.notConnected.title')}
          hint={t('dock.empty.notConnected.hint')}
        />
        <button type="button" className="btn" onClick={reconnectActiveHost}>
          {t('dock.empty.notConnected.retry')}
        </button>
      </div>
    );
  }
  return (
    <div className="dock-empty">
      <EmptyState
        icon={<Ban size={18} />}
        title={t(UNSUPPORTED[region])}
        hint={t('dock.empty.unsupported.hint')}
      />
    </div>
  );
}
