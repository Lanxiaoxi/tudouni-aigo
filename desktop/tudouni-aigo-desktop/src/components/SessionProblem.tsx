import { FolderOpen, RefreshCw, TriangleAlert } from 'lucide-react';
import { NO_STRINGS, useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';

/**
 * "This session would not start", for the session that is on screen.
 *
 * The counterpart of `StartupProblem`, and the reason it exists is that the two
 * are **not** the same failure. That one covers the window: there is no runtime
 * at all, so there is nothing else to show. This one is about one session's
 * child refusing to start while the window is perfectly healthy — which is what
 * happens when somebody opens a second conversation in a directory the runtime
 * will not take. Taking over the screen with a window-level error there would
 * hide a conversation that is still running.
 *
 * **`SessionRuntime.problem` used to be written and never read.** The store set
 * it on every failed attach (`attachSession`'s `catch`) and nothing in the
 * interface subscribed to it, so the failure was invisible twice over: no
 * sentence, and the phase stuck at `booting` because `ready` never became true —
 * "Starting the runtime…" over a process that had already given up. That is the
 * shape of "I clicked New session and nothing happened", and this panel is the
 * fix.
 *
 * The reasons come from the Rust side and are written for a reader ("the
 * workspace … cannot be used (it is the home directory): the runtime refuses
 * it"), so they are displayed verbatim rather than re-worded here.
 */
export function SessionProblem() {
  const t = useT();
  const key = useApp((s) => s.activeKey);
  // The tail comes from whichever session is open, because that is whose child
  // printed it.
  const problem = useSessionField((rt) => rt.problem, null);
  const stderrTail = useSessionField((rt) => rt.stderrTail, NO_STRINGS);
  const retrySession = useApp((s) => s.retrySession);
  const pickWorkspace = useApp((s) => s.pickWorkspace);

  if (!problem) return null;

  // Diagnostics, not session content: what the child printed on its way out, and
  // the only explanation when it died before it could send a `notice`.
  const tail = stderrTail.slice(-20);

  return (
    <div className="startup-problem" role="alert">
      <div className="sp-head">
        <TriangleAlert size={14} />
        <h2>{t('problem.title')}</h2>
      </div>

      <div className="sp-reason mono">{problem}</div>

      <div className="sp-actions">
        <button
          type="button"
          className="btn btn-secondary btn-compact"
          onClick={() => {
            if (key !== null) void retrySession(key);
          }}
        >
          <RefreshCw size={11} />
          <span>{t('startup.retry')}</span>
        </button>
        {/* The other way out, and the one that is usually right: a directory the
            runtime refuses is not fixed by trying again, it is fixed by picking
            a different one. */}
        <button
          type="button"
          className="btn btn-secondary btn-compact"
          onClick={() => void pickWorkspace()}
        >
          <FolderOpen size={11} />
          <span>{t('topbar.pickWorkspace')}</span>
        </button>
      </div>

      {tail.length > 0 ? (
        <>
          <div className="sp-tail-label">{t('startup.stderr')}</div>
          <pre className="terminal mono sp-tail">{tail.join('\n')}</pre>
        </>
      ) : null}
    </div>
  );
}
