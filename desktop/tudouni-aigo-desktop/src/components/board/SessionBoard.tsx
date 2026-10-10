import { useMemo } from 'react';
import { MessageCircleQuestion, X } from 'lucide-react';
import {
  activeWorkspaceOf,
  selectRowStatusKey,
  selectSavedSessions,
  useApp,
  type RowStatus,
} from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { EmptyState, Progress, Tip } from '@/components/ui/kit';
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
 * The order is the one the person asked for: Idle first, then Working, then the
 * two columns that want the person (Needs you), and Finished last — so the
 * columns a session passes through while nobody is watching sit on the left,
 * and the one that demands action sits nearest the middle. Inside a column a
 * card keeps its creation order regardless.
 */
const COLUMNS: { id: 'idle' | 'needs' | 'working' | 'finished'; statuses: RowStatus[]; title: TKey }[] = [
  { id: 'idle', statuses: ['idle'], title: 'board.col.idle' },
  { id: 'working', statuses: ['running'], title: 'board.col.working' },
  { id: 'needs', statuses: ['asking', 'broken'], title: 'board.col.needs' },
  { id: 'finished', statuses: ['unseen'], title: 'board.col.finished' },
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
        // `statusByKey` is keyed by **sessionId** (`selectRowStatusKey` builds
        // `sessionId:status`), not by the child key this card is otherwise
        // addressed by — looking the key up directly always missed and dropped
        // every card into Idle, green running dots and all.
        const status = id === null ? ('idle' as const) : (statusByKey.get(id) ?? 'idle');
        // The task tally is read from the child's own `ui(state)` snapshot,
        // never from the saved row. The saved list is rebuilt at turn
        // boundaries only, so its `todos` sentence trails the live list by up
        // to a whole turn — a bar fed from it would show stale progress for
        // exactly the running cards that should be moving. The snapshot is
        // pushed every step (the same source the rail's Tasks block draws),
        // which makes it the one source whose freshness is guaranteed.
        const live = bucket.uiState?.todos ?? [];
        const todoDone = live.filter((task) => task.status === 'completed').length;
        const todoTotal = live.length;
        const todoSentence = row?.todos ?? '';
        return [
          {
            key,
            id,
            status,
            preview: row?.preview ?? '',
            messages: row?.messages ?? null,
            steps: row?.steps ?? null,
            todoDone,
            todoTotal,
            todos: todoSentence,
            model: bucket.session?.model ?? '',
            provider: bucket.session?.provider ?? '',
            modifiedAt: row?.modifiedAt ?? null,
            // The handshake's own "this conversation was started fresh" fact,
            // shown as the card's one flag — the same word the session bar
            // uses (`session.fresh`), never a second vocabulary for it.
            fresh: bucket.session?.resumed === false,
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
                {/* The column's state dot. The palette is the rail's (`lb-dot`
                    is-*), but the component is the board's own `BoardColDot`:
                    a column head labels a state the column always has —
                    including Idle, which the rail's component deliberately
                    draws nothing for. */}
                <BoardColDot status={column.statuses[0]} />
                <span className="board-col-title">{t(column.title)}</span>
                <span className="board-col-count">{column.cards.length}</span>
              </div>
              {/* **Creation order, never re-sorted by status.** The columns may
                  move a card between them — that is the board's whole value —
                  but inside a column a card must not keep reshuffling as its
                  status wobbles, which is the same rule the rail's rows follow. */}
              {column.cards.map((card) => {
                const isCurrent = card.key === activeKey;
                // The Needs-you card owes the reader one more sentence than the
                // others: while the board is up a blocking request is held
                // unrendered (`selectModalVisible`), so the amber dot alone
                // would not say that clicking this card is how it gets answered.
                const isAsking = card.status === 'asking';
                // The progress row renders only for the two states in which a
                // task list means something: the turn in flight, or the turn
                // waiting on a person mid-list. Idle and Finished do not.
                // A bar needs the tally in numbers (`todoDone`/`todoTotal`,
                // the runtime's own counts); the pre-rendered sentence in
                // `todos` is the fallback when the tally has not landed —
                // wrong to parse the sentence for numbers, wrong to show
                // nothing when the fact is on hand.
                const showProgress = card.status === 'running' || isAsking;
                const hasTally = showProgress && card.todoTotal > 0;
                const progressText =
                  showProgress && !hasTally && card.todos !== '' ? card.todos : null;
                return (
                  <button
                    key={card.key}
                    type="button"
                    className={`board-card${isCurrent ? ' is-current' : ''}${isAsking ? ' is-asking' : ''}`}
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
                      {/* The runtime's own name for the conversation, or the
                          honest placeholder while `init` has not landed: a new
                          session's id is minted by the runtime, so inventing one
                          here would name it something it is not. */}
                      <span className="board-card-id">
                        {card.id !== null ? card.id : t('lb.sessionPending')}
                      </span>
                      {/* One flag, and only ever one: the flag names *this
                          card's owner* — "waiting on you" outranks "new", and
                          two flags together say nothing more than the truer
                          one alone. The dot sits on the column head, not on
                          the card, which is where the redesign's own spec put
                          it: the column is the state, the card is the
                          conversation. */}
                      {isAsking ? (
                        <span className="board-card-flag is-asking">
                          {t('board.card.askingTag')}
                        </span>
                      ) : card.fresh ? (
                        <span className="board-card-flag is-new">
                          {t('board.card.newTag')}
                        </span>
                      ) : null}
                    </span>
                    {card.preview !== '' ? (
                      <span className="board-card-preview">{card.preview}</span>
                    ) : (
                      <span className="board-card-preview faint">
                        {card.id === null ? t('lb.sessionPending') : t('board.noPreview')}
                      </span>
                    )}
                    {/* The task progress, only where a list mid-run means
                        something (see `showProgress`). With the tally on hand
                        it is the kit's `Progress` bar plus "n/m" — the same
                        component the rail's Tasks block draws, in the card's
                        own tones (accent for running, amber for asking),
                        because a second bar design would be a second idiom
                        for one fact. Without the tally the runtime's own
                        progress sentence ("2/5 done, now: …") shows verbatim
                        instead — it is what the rail row would read too. */}
                    {hasTally ? (
                      <span className="board-card-progress">
                        <Progress
                          value={card.todoDone}
                          max={card.todoTotal}
                          tone={isAsking ? 'warn' : undefined}
                        />
                        <span className="board-card-progress-count mono">
                          {card.todoDone}/{card.todoTotal}
                        </span>
                      </span>
                    ) : progressText ? (
                      <span className="board-card-progress-text" title={progressText}>
                        {progressText}
                      </span>
                    ) : null}
                    {/* The held prompt, named where it waits. Shown for `asking`
                        only — a card that merely runs needs no call to action. */}
                    {isAsking ? (
                      <span className="board-card-nudge">
                        <MessageCircleQuestion size={12} />
                        {t('board.card.asking')}
                      </span>
                    ) : null}
                    <span className="board-card-foot">
                      {card.model !== '' ? (
                        <span className="board-card-model">
                          {card.provider !== '' ? `${card.provider}/${card.model}` : card.model}
                        </span>
                      ) : null}
                      <span className="board-card-meta">
                        <span className="board-card-meta-counts">
                          {card.messages !== null
                            ? t('panel.resume.messages', { n: card.messages })
                            : t('board.noCounts')}
                          {card.steps !== null
                            ? ` · ${t('panel.resume.steps', { n: card.steps })}`
                            : ''}
                        </span>
                        {card.modifiedAt !== null ? (
                          <span className="board-card-time">
                            {formatRelative(card.modifiedAt * 1000)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                );
              })}
              {/* Finished, rendered honestly: an empty column is not whitespace,
                  it is "nothing here yet" — the dashed placeholder states that
                  instead of reading as a rendering bug. */}
              {column.cards.length === 0 ? (
                <div className="board-col-empty">{t('board.col.empty')}</div>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The column head's status dot.
 *
 * **Not `SessionDot`.** The rail's component implements a contract the board's
 * column head does not have: `idle` draws *nothing* there ("no process, no
 * dot" — a saved session has no state), while a column head is a *label* for a
 * state the column always has, including Idle. So the board draws its own dot,
 * reusing the rail's CSS classes (`lb-dot is-*`) so the two surfaces keep one
 * palette; every state it can show is covered, and the component's colour rules
 * are never the only signal — the uppercase title says the same thing in words.
 */
function BoardColDot({ status }: { status: RowStatus }) {
  // One class per state, including Idle: the column head always draws a mark,
  // and an explicit class beats an absence-based CSS selector (`:not([class*=…])`
  // would silently match any future state that forgot its own rule).
  const cls =
    status === 'broken' || status === 'asking'
      ? 'is-asking'
      : status === 'running'
        ? 'is-running'
        : status === 'unseen'
          ? 'is-unseen'
          : 'is-idle';
  return <span className={`board-col-dot ${cls}`} aria-hidden />;
}
