import { useT } from '@/i18n/useT';

/**
 * 自绘标题栏（tauri-native-spec.md §3，高 36px）。
 *
 * 在浏览器里是纯展示；在 Tauri 壳里容器上的 data-tauri-drag-region 会生效。
 * 窗口控制按钮刻意保持 cursor: default（与系统一致），不参与 web 交互。
 */
export function TitleBar() {
  const t = useT();
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="tb-mark" aria-hidden />
      <span className="tb-title">{t('app.name')}</span>
      <span className="tb-sub">— agent runtime</span>

      <div className="wincontrols">
        <span className="wc" title={isTauri ? undefined : '最小化（由桌面壳处理）'}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </span>
        <span className="wc" title={isTauri ? undefined : '最大化（由桌面壳处理）'}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
          </svg>
        </span>
        <span className="wc wc-close" title={isTauri ? undefined : '关闭（由桌面壳处理）'}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </span>
      </div>
    </div>
  );
}
