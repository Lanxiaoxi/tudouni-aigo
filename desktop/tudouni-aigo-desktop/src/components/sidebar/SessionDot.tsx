import type { RowStatus } from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';

/**
 * One session's status, as a dot at the left edge of its row.
 *
 * **This is what makes several sessions usable rather than merely possible.**
 * With one conversation on screen and another working in the background, the
 * rail is the only place that answers "is anything waiting for me" — and without
 * an answer, opening a second session is a way to lose track of it.
 *
 * Five states, and the fourth is the one a three-colour scheme cannot express:
 * a background session that **finished** is not running, is not asking and has
 * not failed, so green/amber/red alone would draw nothing at exactly the moment
 * "it is done, come and look" is the most useful thing to know.
 *
 * Four rules, each of which has a way of going wrong that is invisible:
 *
 * 1. **Colour is never the only signal.** The design system settled this for the
 *    workspace row ("Marked by colour **and** by the word 'current', never by
 *    colour alone"), and it matters more here: `--success` and `--destructive`
 *    are `#16A34A` and `#DC2626` in light mode, which is not a pair to ask a
 *    reader to separate. So every dot carries an accessible name saying what it
 *    means.
 *
 * 2. **No pulse.** `component-states.md` §7 forbids expressing a state change
 *    with a breathing animation, and the status bar's own `.is-working` has a
 *    specific justification — "a turn is in flight **right now**" is a
 *    continuing condition, not a transition. Several dots breathing at once
 *    destroys that argument and pulls attention off the conversation. A change
 *    of state changes the colour and nothing else.
 *
 * 3. **Idle draws nothing.** Fifty grey dots read as "everything is fine" while
 *    saying nothing at all.
 *
 * 4. **No process, no dot.** A row for a session that is only a file on disk has
 *    no `entries` to read, so its status is `idle` — which is not a limitation
 *    but the fact: there is nothing running to have a state.
 */
export function SessionDot({ status }: { status: RowStatus }) {
  const t = useT();

  // `idle` is the absence of a dot rather than a grey one.
  if (status === 'idle') return null;

  const key: TKey =
    status === 'asking'
      ? 'lb.dot.asking'
      : status === 'broken'
        ? 'lb.dot.broken'
        : status === 'running'
          ? 'lb.dot.running'
          : 'lb.dot.unseen';

  return (
    <span
      className={`lb-dot is-${status}`}
      // The accessible name is the statement; the colour is a second reading of
      // it. `role="img"` because a bare `<span>` has no name of its own.
      role="img"
      aria-label={t(key)}
      title={t(key)}
    />
  );
}
