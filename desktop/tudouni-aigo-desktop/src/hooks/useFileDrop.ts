import { useEffect } from 'react';
import { useApp } from '@/state/store';
import { appendPaths, partitionDrop } from '@/runtime/dragdrop';
import { isHosted } from '@/runtime/tauri';

/**
 * OS drag-and-drop, wired to the draft.
 *
 * This only works because `dragDropEnabled` is **true** in `tauri.conf.json`.
 * The option's name is misleading: `true` (the default) is what makes Tauri take
 * over the OS drop — the WebView then does not navigate to the file, and
 * `onDragDropEvent` hands over real absolute paths. Setting it to `false`
 * switches to HTML5 drag-and-drop events, which on Windows deliberately withhold
 * the path (`DataTransfer.files` gives a `File` object with a name but no
 * location). So `false` made the whole feature impossible, and the config and the
 * missing code were each other's excuse.
 *
 * A drop has exactly one effect: the path goes into the sentence. That is the
 * runtime's only image channel (`internal/runtime/images.go` scans the text for
 * path-shaped words) — there is no upload command and no markup to use instead.
 */
export function useFileDrop(): void {
  useEffect(() => {
    if (!isHosted()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        const mod = await import('@tauri-apps/api/webview');
        const off = await mod.getCurrentWebview().onDragDropEvent((event) => {
          const s = useApp.getState();
          const payload = event.payload;

          if (payload.type === 'enter' || payload.type === 'over') {
            s.setDragging(true);
            return;
          }
          if (payload.type === 'leave') {
            s.setDragging(false);
            return;
          }

          // `drop`
          s.setDragging(false);
          const paths = payload.paths ?? [];
          if (paths.length === 0) return;

          const workspace = s.session?.workspace ?? '';
          const { accepted, rejected, unknownWorkspace } = partitionDrop(paths, workspace);

          if (accepted.length > 0) {
            s.setDraft(appendPaths(s.draft, accepted));
          }
          if (rejected.length > 0) {
            // Said out loud rather than dropped: a path the runtime cannot
            // resolve would sit in the sentence looking like it worked, and the
            // reader would believe their file had been sent.
            s.setDropNotice({
              rejected,
              reason: unknownWorkspace ? 'no-workspace' : 'outside',
            });
          } else if (accepted.length > 0) {
            s.setDropNotice(null);
          }
        });
        // The effect may have been torn down while the import was in flight.
        if (disposed) off();
        else unlisten = off;
      } catch {
        // Not hosted, or the host refused the listener: dropping does nothing
        // rather than navigating away, because `dragDropEnabled: true` keeps the
        // WebView out of it either way.
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
