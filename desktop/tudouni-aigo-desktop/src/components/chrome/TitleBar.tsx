import { useEffect, useState } from 'react';
import { Minus, Square, X } from 'lucide-react';
import { useT } from '@/i18n/useT';

/**
 * The self-drawn title bar (36px), per `docs/tauri-native-spec.md` §3.
 *
 * `data-tauri-drag-region` goes on the container **only** — every control inside
 * is separately clickable, and adding the attribute to them would eat the click.
 * Double-clicking the drag region does not maximize by itself in Tauri, so it is
 * handled here.
 *
 * Outside a Tauri host (a plain browser during development) the window API is
 * simply absent; the buttons then do nothing rather than throwing.
 */

type WindowApi = {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
};

async function windowApi(): Promise<WindowApi | null> {
  if (typeof window === 'undefined') return null;
  // The Tauri IPC bridge is injected by the host; absent in a browser.
  if (!('__TAURI_INTERNALS__' in window)) return null;
  try {
    const mod = await import('@tauri-apps/api/window');
    const win = mod.getCurrentWindow();
    return {
      minimize: () => win.minimize(),
      toggleMaximize: () => win.toggleMaximize(),
      close: () => win.close(),
      isMaximized: () => win.isMaximized(),
    };
  } catch {
    return null;
  }
}

export function TitleBar() {
  const t = useT();
  const [maximized, setMaximized] = useState(false);

  // Track the maximized state so the middle button can show the right glyph.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      if (!('__TAURI_INTERNALS__' in window)) return;
      try {
        const mod = await import('@tauri-apps/api/window');
        const win = mod.getCurrentWindow();
        if (cancelled) return;
        setMaximized(await win.isMaximized());
        unlisten = await win.onResized(async () => {
          setMaximized(await win.isMaximized());
        });
      } catch {
        /* Not hosted: the bar is decorative. */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function onDoubleClick() {
    // Tauri does not maximize the window on a double-click of the drag region
    // the way a native title bar does, so it is done here. One call, because
    // `toggleMaximize` is what the name says — the previous version asked
    // `isMaximized()` and then ran the same branch either way, which read as
    // though it were deciding something.
    const api = await windowApi();
    await api?.toggleMaximize();
  }

  return (
    <div className="titlebar" data-tauri-drag-region onDoubleClick={onDoubleClick}>
      <span className="tb-mark" data-tauri-drag-region aria-hidden />
      <span className="tb-title" data-tauri-drag-region>
        tudouni-aigo
      </span>

      <div className="wincontrols">
        <button
          type="button"
          className="wc"
          aria-label={t('titlebar.minimize')}
          onClick={() => void windowApi().then((api) => api?.minimize())}
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          className="wc"
          aria-label={maximized ? t('titlebar.restore') : t('titlebar.maximize')}
          onClick={() => void windowApi().then((api) => api?.toggleMaximize())}
        >
          <Square size={11} />
        </button>
        <button
          type="button"
          className="wc wc-close"
          aria-label={t('titlebar.close')}
          onClick={() => void windowApi().then((api) => api?.close())}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
