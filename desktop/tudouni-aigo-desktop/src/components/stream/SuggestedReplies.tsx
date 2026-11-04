import { CornerDownLeft } from 'lucide-react';
import { useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';

/**
 * Quick replies under the last answer (protocol 17).
 *
 * Drawn only while the offer is still about the turn on screen: the replies
 * belong to the last finished run, nothing is running, and the draft is empty
 * — a person who has started typing has made their own choice, and when the
 * draft is cleared again the offer comes back (it is still about the same
 * answer). Any send clears them in the store.
 *
 * A click is the person sending that sentence through the same path as Enter;
 * Ctrl/Cmd/Alt-click only fills the draft, for editing first. Neither is an
 * approval of anything: what the sentence asks for is approved as usual.
 */
export function SuggestedReplies() {
  const t = useT();
  const suggestions = useSessionField((rt) => rt.suggestions, null);
  const lastRunId = useSessionField((rt) => rt.lastRunId, null);
  const running = useSessionField((rt) => rt.activeRunId !== null, false);
  const draftEmpty = useSessionField((rt) => rt.draft.trim() === '', true);
  const enabled = useApp((s) => s.suggestionsEnabled);
  const applySuggestion = useApp((s) => s.applySuggestion);

  if (
    !visibleSuggestions({ enabled, suggestions, lastRunId, running, draftEmpty })
  ) {
    return null;
  }
  return (
    <div className="suggested-replies" role="group" aria-label={t('stream.suggestions.label')}>
      {suggestions!.replies.map((reply) => (
        <button
          key={reply}
          type="button"
          className="suggested-reply"
          title={t('stream.suggestions.hint')}
          aria-label={t('stream.suggestions.send', { reply })}
          onClick={(e) => applySuggestion(reply, e.ctrlKey || e.metaKey || e.altKey)}
        >
          <CornerDownLeft size={12} aria-hidden />
          <span>{reply}</span>
        </button>
      ))}
    </div>
  );
}

/** The drawing rule, pure so it can be pinned without a window. */
export function visibleSuggestions(input: {
  enabled: boolean;
  suggestions: { runId: string; replies: string[] } | null;
  lastRunId: string | null;
  running: boolean;
  draftEmpty: boolean;
}): boolean {
  const { enabled, suggestions, lastRunId, running, draftEmpty } = input;
  return (
    enabled &&
    suggestions !== null &&
    suggestions.replies.length > 0 &&
    suggestions.runId === lastRunId &&
    !running &&
    draftEmpty
  );
}
