import { useEffect, useMemo, useRef, useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import {
  AlertTriangle,
  Bell,
  Camera,
  CircleAlert,
  Info,
  Layers,
  Minus,
} from 'lucide-react';
import { useApp } from '@/state/store';
import { activeRuntime } from '@/state/appView';
import { selectNoticeCenter, type NoticeCenterView } from '@/state/selectors/session';
import { frontMessageText } from '@/components/stream/frontMessageText';
import { useT } from '@/i18n/useT';
import type { Entry, NoteEntry, NoteTone } from '@/state/entries';

/**
 * The notice center: every note entry the session holds, gathered into one
 * floating capsule instead of scattered across the transcript floor.
 *
 * The notes stay in `entries` — the eight creation sites are untouched — and
 * the capsule is only a second **reader** of them. What changed is who draws
 * them: nothing does, inline. The capsule is the one surface, which is also
 * what makes the unread ledger honest — a note inside a folded turn or under
 * the board view used to be effectively invisible; now it is a badge.
 *
 * The store half is this function and nothing more; the capsule itself is
 * `NoticeCapsule` below, which takes the read model as a prop. The split is
 * what makes the render assertable: a zustand hook answers a server render
 * from the store's *initial* state, so a component that reads the store can
 * only be exercised in a window, while one that takes its view as a prop can
 * be rendered statically (the `notice-center` suite does).
 */
export function NoticeCenter() {
  // Two subscriptions, not one selector object: `entries` and `notesReadCount`
  // are stable references the store replaces only when they change, so the
  // capsule does not re-render on every store write. The read model is derived
  // in `useMemo` off exactly those two.
  const entries = useApp((s) => activeRuntime(s)?.entries ?? NO_ENTRIES);
  const readCount = useApp((s) => activeRuntime(s)?.notesReadCount ?? 0);
  const view = useMemo(() => selectNoticeCenter(entries, readCount), [entries, readCount]);

  return <NoticeCapsule view={view} />;
}

const NO_ENTRIES: Entry[] = [];

export function NoticeCapsule({ view }: { view: NoticeCenterView }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Opening reads everything, and so does anything that arrives while it is
  // open — the list is on screen, so "unread" would be a lie about notes the
  // person is looking at.
  useEffect(() => {
    if (open) useApp.getState().markNotesRead();
  }, [open, view.notes.length]);

  // Newest sits at the bottom (arrival order, like the transcript); an open
  // lands on what just happened rather than on the session's first diagnostic.
  //
  // The scroll is deferred a frame, not run in the effect body: Radix's
  // Portal commits the list a tick after `open` flips, so reading the ref
  // synchronously usually catches it still `null` and silently no-ops — which
  // is exactly why the panel used to reopen at the top every time.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const list = listRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [open, view.notes.length]);

  // The guard lives here rather than in the caller: a capsule with nothing to
  // show is not a smaller capsule, it is no capsule, and the mount site should
  // not have to know the condition.
  if (view.notes.length === 0) return null;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <div className="nc-dock">
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            className="nc-capsule"
            aria-label={t('noticeCenter.aria', { n: view.notes.length, unread: view.unread })}
          >
            <Bell size={13} aria-hidden />
            <span className="nc-label">{t('noticeCenter.label')}</span>
            {view.unread > 0 ? (
              <span className={view.hasWarnUnread ? 'nc-badge is-warn' : 'nc-badge'}>
                {view.unread}
              </span>
            ) : null}
          </button>
        </PopoverPrimitive.Trigger>
      </div>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="nc-popover"
          side="top"
          align="start"
          sideOffset={10}
          aria-label={t('noticeCenter.label')}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="nc-head">
            {t('noticeCenter.label')}
            <span className="nc-total">{view.notes.length}</span>
          </div>
          <div className="nc-list" ref={listRef}>
            {view.notes.map((note) => (
              <NoticeRow key={note.id} entry={note} />
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * One note in the popover — the row the transcript floor used to draw, moved
 * here whole. The two-source rule came with it: a runtime notice is the
 * runtime's own sentence and is displayed verbatim; a sentence this window
 * composed arrives as a code and is worded from i18n.
 */
const NOTE_TONE_CLASS: Record<NoteTone, string> = {
  degraded: ' is-degraded',
  compacted: ' is-compacted',
  image: ' is-image',
  warn: ' is-warn',
  error: ' is-error',
  info: '',
};

export function NoticeRow({ entry }: { entry: NoteEntry }) {
  const t = useT();
  const icon =
    entry.tone === 'degraded' ? (
      <Layers size={11} />
    ) : entry.tone === 'compacted' ? (
      <Minus size={11} />
    ) : entry.tone === 'image' ? (
      <Camera size={11} />
    ) : entry.tone === 'error' ? (
      <CircleAlert size={11} />
    ) : entry.tone === 'warn' ? (
      <AlertTriangle size={11} />
    ) : (
      <Info size={11} />
    );

  return (
    <div className={`nc-row${NOTE_TONE_CLASS[entry.tone] ?? ''}`} data-code={entry.code}>
      {icon}
      <span className="nc-text">
        {entry.message ? frontMessageText(t, entry.message) : entry.text}
      </span>
    </div>
  );
}
