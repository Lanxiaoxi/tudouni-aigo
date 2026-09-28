import { useMemo } from 'react';
import { Clock, Sparkles, Terminal } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Kbd } from '@/components/ui/kit';
import { NoteRow } from '@/components/stream/EntryView';
import type { Entry } from '@/state/entries';
import { formatPath, formatRelative } from '@/utils/format';

/**
 * §7 The first screen. Three blocks, not three pages:
 *   1. identity: mark, greeting (with the OS user name), version, model +
 *      workspace, and one line on where to start
 *   2. recent sessions: by last modified, at most 4, with empty slots
 *   3. keybindings card
 *
 * Content priority when the window is short: the keybinding card goes first,
 * then spare rows, then all but the identity block's first lines. Runtime
 * notices are handed in and rendered **below** all of it — they belong to the
 * session, and the design is explicit that they are not squeezed out by this
 * screen. A workspace whose runtime failed to start would otherwise show a
 * friendly greeting and no reason why.
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
  const session = useApp((s) => s.session);
  const sessionList = useApp((s) => s.sessionList);
  const switchSession = useApp((s) => s.switchSession);
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
            <span className="wi-mark" aria-hidden>
              <Sparkles size={17} />
            </span>
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

          <div className="wi-start">{t('welcome.start')}</div>
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
                  onClick={() => switchSession(item.id)}
                >
                  <span className="rs-top">
                    <span className="rs-id">{item.id}</span>
                    {/* `modified_at` is epoch seconds; null means the file
                        could not be read, and then there is no time to show. */}
                    <span className="rs-time">
                      {item.modifiedAt === null ? t('common.unknown') : formatRelative(item.modifiedAt * 1000)}
                    </span>
                  </span>
                  <span className="rs-preview clamp-2">{item.preview}</span>
                </button>
              ) : (
                <div key={`empty-${index}`} className="recent-slot is-empty">
                  <span className="faint caption">{t('welcome.slotEmpty')}</span>
                </div>
              ),
            )}
          </div>
        </section>

        {/* 3 · keybindings */}
        <section className="welcome-block welcome-keys-block">
          <div className="wb-head">
            <Terminal size={13} className="muted" />
            <h2>{t('welcome.keys')}</h2>
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              style={{ marginLeft: 'auto' }}
              onClick={() => openPanel('help')}
            >
              /help
            </button>
          </div>

          {/* The same key names the help panel writes: "Enter" and "Shift
              Enter", not the `⏎`/`⇧` glyphs. Two spellings for one key in one
              application is a small thing that still costs the reader a moment
              of "is this the same key?" — and this card is the first thing a
              new person reads. */}
          <div className="keycaps">
            <KeyCap keys={['Ctrl', 'K']} label={t('key.palette')} />
            <KeyCap keys={['Enter']} label={t('key.send')} />
            <KeyCap keys={['Shift', 'Enter']} label={t('key.newline')} />
            <KeyCap keys={['Ctrl', 'B']} label={t('key.sidebar')} />
            <KeyCap keys={['Ctrl', 'T']} label={t('key.thinking')} />
            <KeyCap keys={['Ctrl', 'S']} label={t('key.skills')} />
            <KeyCap keys={['Esc']} label={t('key.esc')} />
            <KeyCap keys={['1', '…', '9']} label={t('key.pick')} />
          </div>
        </section>

        {/* Runtime notices. Session content, so they sit below the three blocks
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

function KeyCap({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="keycap">
      <span className="kc-keys">
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </span>
      <span>{label}</span>
    </div>
  );
}
