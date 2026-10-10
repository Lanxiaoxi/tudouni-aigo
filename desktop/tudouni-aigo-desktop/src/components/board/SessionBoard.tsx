import { useMemo } from 'react';
import { X } from 'lucide-react';
import {
  activeWorkspaceOf,
  selectRowStatusKey,
  selectSavedSessions,
  useApp,
  type RowStatus,
} from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { SessionDot } from '@/components/sidebar/SessionDot';
import { EmptyState, Tip } from '@/components/ui/kit';
import { formatRelative } from '@/utils/format';

/**
 * The session board: what every session in this workspace is doing, on one
 * screen, at one moment.
 *
 * **It is a view, not a dialog.** The reasons are all in `store.boardOpen`, and
 * they are the three mechanisms a Radix panel would have fought: `body`'s
 * inherited `pointer-events: none` (the left rail goes dead), `focusSession`
 * clearing `panel` (clicking a card would close the board), and `enqueueModal`
 * clearing `panel` (an approval arriving would close the one surface that shows
 * other sessions are waiting too).
 *
 * **It reads no session file and counts nothing itself.** Every number on a card
 * is either the runtime's (`sessions.items`, via `selectSavedSessions`) or this
 * end's own live bucket (`entries`, `session`) — the same two sources the left
 * rail already draws from. The status is `selectRowStatus`, unchanged, which is
 * what makes the dot on a card mean exactly what the dot on a rail row means.
 *
 * **Most cards are `idle`, and that is the honest picture.** `SessionDot`'s
 * fourth rule — "no process, no dot" — is a fact, not a limitation: a saved
 * session nobody has open has no `entries` to read a state from. So the Idle
 * column is the longest one by construction, and the board is deliberately not
 * designed as "a complete picture of the workspace" — that is the library
 * (`/resume`). What the board is for is the two-to-four sessions that are
 * actually running.
 */

/**
 * The columns, and why each one is a column.
 *
 * The five `RowStatus` values are merged into four, because five columns would
 * be three-quarters empty on a real workspace (two to four cards is the usual
 * load) and because the split that matters is the one the workspace badge
 * already uses: `asking` and `broken` both mean **a person has to do something**,
 * while `running` and `unseen` do not.
 *
 * The order is by who needs the person first — the same order `selectRowStatus`
 * ranks its own conditions in, so a card's column and its dot never disagree.
 */
const COLUMNS: { id: 'needs' | 'working' | 'finished' | 'idle'; statuses: RowStatus[]; title: TKey }[] = [
  { id: 'needs', statuses: ['asking', 'broken'], title: 'board.col.needs' },
  { id: 'working', statuses: ['running'], title: 'board.col.working' },
  { id: 'finished', statuses: ['unseen'], title: 'board.col.finished' },
  { id: 'idle', statuses: ['idle'], title: 'board.col.idle' },
];

export function SessionBoard() {
  const t = useT();
  const setBoardOpen = useApp((s) => s.setBoardOpen);
  const focusSession = useApp((s) => s.focusSession);
  const activeKey = useApp((s) => s.activeKey);

  // Every live session, in the order the rail draws them. `order` is the store's
  // own list of child keys, so this is "the conversations that are open right
  // now" — which is the board's whole subject.
  const order = useApp((s) => s.order);
  // The workspace's saved rows, read the same way the rail reads them: one
  // source, so a card's preview and a row's preview can never disagree.
  const saved = useApp((s) => selectSavedSessions(s, activeWorkspaceOf(s)));

  // A compact string, subscribed instead of the buckets, for the reason
  // `selectRowStatusKey` documents: subscribing to `sessions` re-renders on every
  // streaming token, while this changes only when a status really does.
  const statusKey = useApp(selectRowStatusKey);
  const statusByKey = useMemo(() => {
    const out = new Map<string, RowStatus>();
    for (const part of statusKey.split(',')) {
      if (part === '') continue;
      const at = part.lastIndexOf(':');
      out.set(part.slice(0, at), part.slice(at + 1) as RowStatus);
    }
    return out;
  }, [statusKey]);

  // The cards, built once per render from the two sources above. A live session
  // whose file already exists is matched to its saved row by the runtime's own
  // id, so its preview and counts are the runtime's rather than a second guess.
  const buckets = useApp((s) => s.sessions);
  const byId = useMemo(() => {
    const out = new Map(saved.items.map((row) => [row.id, row]));
    return out;
  }, [saved.items]);

  const cards = useMemo(
    () =>
      order.flatMap((key) => {
        const bucket = buckets[key];
        if (!bucket) return [];
        const id = bucket.sessionId;
        const row = id === null ? undefined : byId.get(id);
        return [
          {
            key,
            id,
            status: statusByKey.get(key) ?? 'idle',
            preview: row?.preview ?? '',
            messages: row?.messages ?? null,
            steps: row?.steps ?? null,
            todos: row?.todos ?? '',
            model: bucket.session?.model ?? '',
            provider: bucket.session?.provider ?? '',
            modifiedAt: row?.modifiedAt ?? null,
          },
        ];
      }),
    [order, buckets, byId, statusByKey],
  );

  const columns = useMemo(
    () =>
      COLUMNS.map((column) => ({
        ...column,
        cards: cards.filter((card) => column.statuses.includes(card.status)),
      })),
    [cards],
  );

  // `listed` false means no runtime has answered for this workspace yet, which is
  // a different statement from "no sessions are open" — so the two are drawn
  // differently rather than both as an empty board.
  const loading = !saved.listed && order.length === 0;

  return (
    <div className="board">
      <header className="board-head">
        <div>
          <h2 className="board-title">{t('board.title')}</h2>
          <p className="board-sub">{t('board.subtitle')}</p>
        </div>
        {/* Leaving is a first-class control, like `TerminalView`'s — the board
            replaced the transcript, so it must own the way back rather than
            leaving Esc as the only exit. */}
        <Tip label={t('board.closeHint')}>
          <button
            type="button"
            className="lb-icon"
            aria-label={t('board.close')}
            onClick={() => setBoardOpen(false)}
          >
            <X size={15} />
          </button>
        </Tip>
      </header>

      {loading ? (
        <div className="board-loading">{t('common.loading')}</div>
      ) : cards.length === 0 ? (
        <EmptyState title={t('board.empty.title')} hint={t('board.empty.hint')} />
      ) : (
        <div className="board-cols scroll">
          {columns.map((column) => (
            <section key={column.id} className="board-col" aria-label={t(column.title)}>
              <div className="board-col-head">
                <span className="board-col-title">{t(column.title)}</span>
                <span className="board-col-count">{column.cards.length}</span>
              </div>
              {/* **Creation order, never re-sorted by status.** The columns may
                  move a card between them — that is the board's whole value —
                  but inside a column a card must not keep reshuffling as its
                  status wobbles, which is the same rule the rail's rows follow. */}
              {column.cards.map((card) => {
                const isCurrent = card.key === activeKey;
                return (
                  <button
                    key={card.key}
                    type="button"
                    className={`board-card${isCurrent ? ' is-current' : ''}`}
                    aria-current={isCurrent ? 'true' : undefined}
                    // Clicking a card is the board's second exit and the more
                    // useful one: it focuses that conversation's chat and closes
                    // the board. Focusing also clears that session's `unseen`,
                    // which is exactly the natural end of "it finished and I had
                    // not looked" — see `focusSession`.
                    onClick={() => {
                      focusSession(card.key);
                      setBoardOpen(false);
                    }}
                  >
                    <span className="board-card-top">
                      <SessionDot status={card.status} />
                      {/* The runtime's own name for the conversation, or the
                          honest placeholder while `init` has not landed: a new
                          session's id is minted by the runtime, so inventing one
                          here would name it something it is not. */}
                      <span className="board-card-id">
                        {card.id !== null ? card.id : t('lb.sessionPending')}
                      </span>
                    </span>
                    {card.preview !== '' ? (
                      <span className="board-card-preview">{card.preview}</span>
                    ) : (
                      <span className="board-card-preview faint">
                        {card.id === null ? t('lb.sessionPending') : t('board.noPreview')}
                      </span>
                    )}
                    <span className="board-card-meta">
                      {card.messages !== null
                        ? t('panel.resume.messages', { n: card.messages })
                        : t('board.noCounts')}
                      {card.steps !== null ? ` · ${t('panel.resume.steps', { n: card.steps })}` : ''}
                      {card.todos ? ` · ${card.todos}` : ''}
                    </span>
                    {card.model !== '' ? (
                      <span className="board-card-model">
                        {card.provider !== '' ? `${card.provider}/${card.model}` : card.model}
                      </span>
                    ) : null}
                    {card.modifiedAt !== null ? (
                      <span className="board-card-time">
                        {formatRelative(card.modifiedAt * 1000)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
