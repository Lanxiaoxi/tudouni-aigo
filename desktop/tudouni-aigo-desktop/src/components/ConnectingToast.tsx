import { useApp } from '@/state/store';
import { useShallow } from 'zustand/react/shallow';
import { Server } from 'lucide-react';
import { BusyDots } from '@/components/ui/kit';
import { selectConnectingToast } from '@/connectingToast';
import { useT } from '@/i18n/useT';

/**
 * The "Connecting to <workspace>…" toast.
 *
 * A remote workspace's first open takes several seconds — a config check over
 * SSH, a possible runtime install, the dial, the handshake — and until now
 * that whole stretch was invisible except for a badge on the sidebar row. This
 * is the sentence the person is meant to read: what is being opened, and that
 * it is still being opened.
 *
 * **Window-level, not session-level.** The wait belongs to the *open*, and an
 * open can outlive the session it is being opened into (the pre-bucket stretch
 * has no session at all). It therefore reads the store through
 * `selectConnectingToast` rather than through a session's bucket, and it
 * sits in the window's overlay layer next to the modals rather than inside
 * the conversation column.
 *
 * There is no close control: the toast either serves its purpose (the
 * handshake lands and it goes) or the open failed and the session's own
 * problem surface says so. A dismiss button on a status is a control that
 * does nothing.
 */
export function ConnectingToast() {
  const t = useT();
  // `useShallow`: the selector builds a small object, and a plain subscription
  // would re-render on every store write rather than on an actual change.
  const toast = useApp(useShallow(selectConnectingToast));

  if (toast === null) return null;

  return (
    <div className="connecting-toast" role="status" aria-live="polite">
      <Server size={13} className="ct-icon" aria-hidden />
      <span className="ct-text">{t('conn.toast.connecting', { name: toast.name })}</span>
      <BusyDots />
    </div>
  );
}
