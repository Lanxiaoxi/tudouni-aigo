import { RefreshCw, FolderOpen, TriangleAlert } from 'lucide-react';
import { NO_STRINGS, useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';

/**
 * "The runtime would not start", with a way out (§4).
 *
 * Three things fail here and all three used to fail silently: the binary is not
 * packaged, the workspace is one the runtime refuses, and the protocol versions
 * do not match. Each leaves the screen on "Starting the runtime…" forever, so
 * the two buttons matter as much as the sentence — a person who cannot retry or
 * pick another workspace has no way forward at all.
 *
 * The reasons come from the Rust side and are written for a reader ("the
 * runtime binary (tudouni-aigo.exe) was not found next to the application"), so
 * they are displayed verbatim rather than re-worded here.
 */
export function StartupProblem() {
  const t = useT();
  const problem = useApp((s) => s.startupProblem);
  // The tail comes from whichever session is open, because that is whose child
  // printed it. A window-level refusal (no binary at all) is preceded by a
  // session, so this is normally that session's own diagnostics.
  const stderrTail = useSessionField((rt) => rt.stderrTail, NO_STRINGS);
  const retryStartup = useApp((s) => s.retryStartup);
  const pickWorkspace = useApp((s) => s.pickWorkspace);

  if (!problem) return null;

  // The tail is diagnostics, not session content: it is what the child printed
  // on its way out, and it is the only explanation when it died before it could
  // send a `notice`.
  const tail = stderrTail.slice(-20);

  return (
    <div className="startup-problem" role="alert">
      <div className="sp-head">
        <TriangleAlert size={14} />
        <h2>{t('startup.title')}</h2>
      </div>

      <div className="sp-reason mono">{problem}</div>

      <div className="sp-actions">
        <button type="button" className="btn btn-secondary btn-compact" onClick={() => void retryStartup()}>
          <RefreshCw size={11} />
          <span>{t('startup.retry')}</span>
        </button>
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
