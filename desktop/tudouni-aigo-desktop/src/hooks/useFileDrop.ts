import { useEffect } from 'react';
import { activeRuntime, useApp } from '@/state/store';
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
 *
 * **Every path is inserted, inside or outside the workspace.** The file tools
 * refuse an outside path at `SafePath`, but that is the model's problem, not the
 * composer's: the model can still reach the file through `shell`, which is the
 * channel that carries the approval gate. The outside paths only earn a notice —
 * a heads-up that the direct read will not work, not a refusal of the path itself.
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

          // The workspace and the draft both belong to the session on screen:
          // the path is inserted into *that* conversation's sentence, and
          // whether it is inside the workspace is a question only that session's
          // child can answer.
          const rt = activeRuntime(s);
          const workspace = rt?.session?.workspace ?? rt?.workspace ?? '';
          const { inserted, outside, unknownWorkspace } = partitionDrop(paths, workspace);

          if (inserted.length > 0) {
            s.setDraft(appendPaths(rt?.draft ?? '', inserted));
          }
          if (outside.length > 0) {
            // A heads-up, not a refusal: the path is in the sentence, but the
            // file tools will not read it — the model would have to go through
            // shell (which asks), and a picture channel would swallow it
            // silently. The reader deserves the line.
            s.setComposerNotice(
              unknownWorkspace
                ? { code: 'drop-no-workspace', names: outside, tone: 'warn' }
                : { code: 'drop-outside', names: outside, tone: 'warn' },
            );
          } else if (inserted.length > 0) {
            s.setComposerNotice(null);
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
