import { FolderOpen } from 'lucide-react';
import { useApp, type StartupNotice } from '@/state/store';
import { useT } from '@/i18n/useT';

/**
 * One `StartupNotice` as a sentence.
 *
 * A code-to-words step rather than a stored string, for the same reason
 * `ComposerNotice` is a code: the store has no business holding English, and the
 * translation is what owns the punctuation.
 *
 * The switch is exhaustive with no `default`, so a second notice kind is a type
 * error here rather than a blank line on the screen.
 */
export function StartupNoticeLine({ notice }: { notice: StartupNotice }) {
  const t = useT();
  switch (notice.code) {
    case 'last-workspace-gone':
      return (
        <>
          {t('notice.lastWorkspaceGone', { path: notice.path, reason: notice.reason })}{' '}
          {t('notice.pickWorkspace')}
        </>
      );
    case 'no-workspace':
      return <>{t('notice.noWorkspace')}</>;
  }
}

/**
 * The one action that resolves both notices.
 *
 * The sentence states a fact — "the runtime has nowhere to work" — and a fact
 * with no action beside it is how a screen ends up with no visible way forward.
 * That was the real defect behind "I clicked New session and nothing happened":
 * the notice said *choose one below*, and whether anything was below depended on
 * the left rail being visible, unfolded and not scrolled past.
 *
 * It opens the directory picker rather than pointing at the workspace list,
 * because the list is not always on screen — the rail can be folded away or
 * hidden outright by a narrow window — and this works from every state.
 */
export function ChooseWorkspaceButton() {
  const t = useT();
  const pickWorkspace = useApp((s) => s.pickWorkspace);
  return (
    <button
      type="button"
      className="btn btn-secondary btn-compact"
      onClick={() => void pickWorkspace()}
    >
      <FolderOpen size={11} />
      <span>{t('notice.chooseWorkspace')}</span>
    </button>
  );
}
