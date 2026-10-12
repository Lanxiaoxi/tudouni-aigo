import { useEffect } from 'react';
import { selectBoardAvailable, selectModalVisible, useApp } from '@/state/store';
import { onTrayCommand } from '@/runtime/tauri';

/**
 * Act on the tray menu's two session commands.
 *
 * The Rust side has already shown the window by the time an event arrives (see
 * `tray://command`), so what is left here is the act itself — and the guards,
 * which live here and nowhere else because the store's selectors are the one
 * authority on both:
 *
 *   - **A blocking modal really blocks.** `new-session` switches sessions,
 *     and a switch abandons every pending request the runtime is holding —
 *     including a fail-closed approval the runtime waits on by id. The same
 *     rule the global keys follow (`useGlobalKeys`): while a prompt is on
 *     screen, neither act runs. The window is up either way, so the prompt is
 *     visible and answerable — the click has not vanished, it has been
 *     answered by the thing that owns the screen.
 *   - **The board's own gate.** `open-board` asks `selectBoardAvailable`, the
 *     same question the SessionBar button and the rail's foot draw: a
 *     workspace with no child has no conversations for the board to be about.
 *     Clicking the menu item then reads as inert, exactly like the disabled
 *     buttons do — and for the same reason.
 *
 * `new-session` deliberately goes through `openSession(null)`, the same entry
 * the `/new` command and the rail's button take. The board being up does not
 * block it here, unlike the rail: a tray click is an explicit act, not a
 * stray press over a live board, so the board is closed first (`setBoardOpen`
 * sends nothing, so nothing in flight is disturbed) and the new session opens.
 */
export function useTrayCommands(): void {
  useEffect(() => {
    return onTrayCommand((command) => {
      const s = useApp.getState();
      switch (command.action) {
        case 'new-session': {
          if (selectModalVisible(s)) return;
          if (s.boardOpen) s.setBoardOpen(false);
          void s.openSession(null);
          return;
        }
        case 'open-board': {
          if (selectModalVisible(s)) return;
          if (!s.boardOpen && !selectBoardAvailable(s)) return;
          s.setBoardOpen(true);
          return;
        }
      }
    });
  }, []);
}
