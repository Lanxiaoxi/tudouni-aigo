import { useMemo } from 'react';
import { Clock } from 'lucide-react';
import {
  activeWorkspaceOf,
  selectSavedSessions,
  useApp,
  useSessionField,
} from '@/state/store';
import { useT } from '@/i18n/useT';
import { mottoOfDay } from '@/i18n';
import { StartupNoticeLine, ChooseWorkspaceButton } from '@/components/StartupNotice';
import { Logo } from '@/components/ui/Logo';
import { NoteRow } from '@/components/stream/EntryView';
import type { Entry } from '@/state/entries';
import { formatPath, formatRelative } from '@/utils/format';

/**
 * §7 The first screen. Two blocks, not two pages:
 *   1. identity: mark, greeting (with the OS user name), version, model +
 *      workspace, and the day's motto
 *   2. recent sessions: by last modified, at most 4, with empty slots
 *
 * The keybinding card that used to be the third block is **gone**. Eight
 * keycaps on the first screen is a manual nobody reads twice, and the same
 * table — longer, and with the command list beside it — is one click away in
 * the help panel. That entry point moved to the top bar's help icon, which is
 * where a person looks for it *after* the first screen, when the question
 * ("what was the key for this?") actually comes up. See `TopBar`.
 *
 * Content priority when the window is short: spare recent rows go first, then
 * all but the identity block's first lines. Runtime notices are handed in and
 * rendered **below** all of it — they belong to the session, and the design is
 * explicit that they are not squeezed out by this screen. A workspace whose
 * runtime failed to start would otherwise show a friendly greeting and no
 * reason why.
 *
 * Decision 1: the identity block shows **both** versions — the desktop's own,
 * and the runtime's, read back from `--version` at start-up. Decision 3: the
 * greeting carries the OS user name, and omits it entirely when unavailable
 * rather than saying "unknown".
 */

const MAX_RECENT = 4;

/** Notices only: the first screen renders system rows, not the conversation. */
type NoteEntry = Extract<Entry, { kind: 'note' }>;

export function Welcome({ notices }: { notices: NoteEntry[] }) {
  const t = useT();
  const userName = useApp((s) => s.userName);
  const desktopVersion = useApp((s) => s.desktopVersion);
  const runtimeVersion = useApp((s) => s.runtimeVersion);
  const startupNotice = useApp((s) => s.startupNotice);
  const session = useSessionField((rt) => rt.session, null);
  // The list is the **workspace's**, read from the window-level record rather
  // than from whichever child is focused — see `SavedSessions`.
  // `active`: the first screen's "recent" slots are the same list the rail
  // shows, and an archived conversation does not belong on it.
  const sessionList = useApp((s) => selectSavedSessions(s, activeWorkspaceOf(s)).active);
  const openSession = useApp((s) => s.openSession);
  const openPanel = useApp((s) => s.openPanel);

  const recent = useMemo(
    () => [...sessionList].sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0)).slice(0, MAX_RECENT),
    [sessionList],
  );

  const slots: Array<(typeof recent)[number] | null> = [...recent];
  while (slots.length < MAX_RECENT) slots.push(null);

  return (
    <div className="welcome scroll">
      <div className="welcome-inner">
        {/* 1 · identity */}
        <section className="welcome-id">
          <div className="wi-logo">
            <Logo size={30} />
            <h1>
              {userName
                ? t('welcome.greeting', { name: userName })
                : t('welcome.greetingAnon')}
            </h1>
          </div>

          <div className="wi-meta">
            {/* Both versions, labelled. `dev` is shown as-is: a build without
                ldflags is a dev build and prettifying it would be a lie. */}
            <span className="mono">
              {t('welcome.meta', {
                desktop: desktopVersion,
                runtime: runtimeVersion ?? '—',
              })}
            </span>
          </div>

          <div className="wi-meta">
            <span className="mono">
              {t('welcome.where', {
                model: session?.model ?? '—',
                workspace: session?.workspace ? formatPath(session.workspace, 40) : '—',
              })}
            </span>
          </div>

          {/* Why nothing is open, when that needs saying.
           *
           * It takes the motto's slot rather than sitting beside it: when no
           * workspace is open, why that is matters more than a maxim, and the
           * first screen should not open with two unrelated paragraphs.
           *
           * The button is not decoration, and it is not the sentence's
           * direction either. The line used to end with "choose one below",
           * which is true only while the workspace list is actually visible
           * below — the rail can be folded away or hidden outright by a narrow
           * window. So the direction moved out of the wording and into this
           * control, which works from every state. */}
          {startupNotice ? (
            <div className="wi-start wi-notice" role="status">
              <span className="wi-notice-text">
                <StartupNoticeLine notice={startupNotice} />
              </span>
              <ChooseWorkspaceButton />
            </div>
          ) : (
            <div className="wi-start wi-motto">{mottoOfDay(t)}</div>
          )}
        </section>

        {/* 2 · recent sessions */}
        <section className="welcome-block welcome-recent-block">
          <div className="wb-head">
            <Clock size={13} className="muted" />
            <h2>{t('welcome.recent')}</h2>
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              style={{ marginLeft: 'auto' }}
              onClick={() => openPanel('resume')}
            >
              /resume
            </button>
          </div>

          <div className="welcome-recent">
            {slots.map((item, index) =>
              item ? (
                <button
                  key={item.id}
                  type="button"
                  className="recent-slot"
                  // Opening a saved conversation from the first screen is the
                  // same act as from the rail: focus the child that already has
                  // it, or start one on it. It is not a switch of the running
                  // session, which is why the name changed with the mechanism.
                  onClick={() => void openSession(item.id)}
                >
                  {/* The topic leads and the id follows — the same order the
                      rail's rows use. This card is the same decision made from
                      a different screen, and two orders for one fact is one
                      order too many. */}
                  <span className="rs-preview clamp-2">{item.preview}</span>
                  <span className="rs-foot">
                    {/* The same pair as the rail's last line: the runtime's own
                        name for the conversation, and when it was last touched.
                        The time used to sit on the topic's line here too, which
                        cost the preview a fixed ~40px on each of the two lines
                        it is clamped to — the card is half the content pane, so
                        it pays for that more dearly than the rail does.
                        `modified_at` is epoch seconds; null means the file could
                        not be read, and then there is no time to show. */}
                    <span className="rs-id">{item.id}</span>
                    <span className="rs-time">
                      {item.modifiedAt === null ? t('common.unknown') : formatRelative(item.modifiedAt * 1000)}
                    </span>
                  </span>
                </button>
              ) : (
                <div key={`empty-${index}`} className="recent-slot is-empty">
                  <span className="faint caption">{t('welcome.slotEmpty')}</span>
                </div>
              ),
            )}
          </div>
        </section>

        {/* Runtime notices. Session content, so they sit below the two blocks
            and are never dropped — the words are the runtime's own, verbatim. */}
        {notices.length > 0 ? (
          <section className="welcome-notices">
            {notices.map((entry) => (
              <NoteRow key={entry.id} entry={entry} />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}
