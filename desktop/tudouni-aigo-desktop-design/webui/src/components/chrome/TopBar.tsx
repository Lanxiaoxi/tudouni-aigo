import { Folder, Languages, Search } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { formatPath } from '@/utils/format';

/**
 * §1·1 顶部栏：程序名 + 工作区路径 + 命令面板入口。
 * 窗口变窄时可只留左半 —— palette-trigger 在窄屏收窄，品牌区不缩。
 */
export function TopBar() {
  const t = useT();
  const workspace = useApp((s) => s.workspace);
  const openPanel = useApp((s) => s.openPanel);
  const locale = useApp((s) => s.locale);
  const setLocale = useApp((s) => s.setLocale);

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
          <Folder size={11} />
          <span className="truncate">{workspace ? formatPath(workspace, 48) : '—'}</span>
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

      <Tip label={locale === 'zh' ? 'Switch to English' : '切换为中文'}>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
          aria-label="locale"
        >
          <Languages size={14} />
          <span className="sr-only">locale</span>
        </button>
      </Tip>
    </header>
  );
}
