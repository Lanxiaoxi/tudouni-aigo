import { useEffect } from 'react';
import { selectRunningCount, useApp } from '@/state/store';
import { awakeForRunningCount, setKeepAwake } from '@/runtime/keepAwake';

/**
 * Hold the screen awake while any open session is running a turn.
 *
 * The count is the store's `selectRunningCount` — the same fact the status
 * bar draws — so this cannot drift from what the interface reports. It is a
 * window-level concern (the OS flag has no per-session form of its own),
 * which is why the hook lives here rather than in a session component:
 * exactly one subscription, re-asserting the OS state whenever the count
 * crosses zero in either direction.
 *
 * The assertion also runs on mount, so a session resumed into a turn from
 * the moment the window opens is covered from the first frame.
 */
export function useKeepAwake(): void {
  const running = useApp(selectRunningCount);

  useEffect(() => {
    void setKeepAwake(awakeForRunningCount(running));
  }, [running]);
}
