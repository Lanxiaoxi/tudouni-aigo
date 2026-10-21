import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, MessageCircleQuestion, Trash2, X } from 'lucide-react';
import {
  selectModalVisible,
  selectRowStatusKey,
  useApp,
  type RowStatus,
} from '@/state/store';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { useTurnClock } from '@/hooks/useTurnClock';
import { EmptyState, Progress, Tip } from '@/components/ui/kit';
import { formatDuration, formatPercent, formatRelative, formatTokens, normPath } from '@/utils/format';

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
 * is either the runtime's (`sessions.items`, out of `savedSessions` — the map of
 * saved lists, read per card in **that card's own workspace**, because the cards
 * span workspaces while the rail draws only one) or this end's own live bucket
 * (`entries`, `session`) — the same two sources the left rail already draws
 * from. The status is `selectRowStatus`, unchanged, which is what makes the dot
 * on a card mean exactly what the dot on a rail row means.
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

  /**
   * The card context menu, open state.
   *
   * **It is hand-rolled, deliberately not a Radix popover**, for the same three
   * reasons the board itself is a view and not a dialog: the board sits outside
   * the Radix namespace this window's dialogs live in (`body`'s inherited
   * `pointer-events: none` would not apply to it — the board is not inside a
   * closed panel), and a context menu over a *view* needs coordinates, not
   * anchoring. A fixed scrim closes it, which also folds "click elsewhere"
   * and "scroll elsewhere" into one mechanism — plus an Escape that must be
   * *heard before the board's own* Esc closes the whole view, which is why the
   * listener below is a capture listener that stops propagation: the global
   * window keydown (`useGlobalKeys`) is a bubble listener, and capture on
   * window — the first handler in the path — takes the key out from under it.
   */
  const [menu, setMenu] = useState<
    { key: string; id: string; archived: boolean; armed?: boolean; x: number; y: number } | null
  >(null);

  useEffect(() => {
    if (menu === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // **A visible prompt is still above the menu.** The window's global
      // handler answers Esc as modal → panel → board; the menu is a fourth,
      // *underneath* the first. When a request is on screen it keeps its own
      // Esc (its buttons are the answer), and the menu stays where it is.
      if (selectModalVisible(useApp.getState())) return;
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [menu]);

  /**
   * Run one menu act, routed through the card's own child.
   *
   * Every card here is a **live child**, and archive over an appender is the
   * race the desktop's gate exists to prevent — so the store's gate would
   * refuse every row this surface could name. That gate is not bypassed so
   * much as *satisfied on the route*: the menu sends through the session's own
   * connection (`via`), and the runtime — which has now seen this shape —
   * **waits the mounted session's own turn out** (`Server.archiveSession` joins
   * the turn, exactly as `deleteSession` always has) before rewriting the
   * metadata. The holder's writes are quiesced by coupling them to the archive;
   * any *other* holder is still refused by the store, as it always was.
   *
   * What this buys over closing the card first is the person's turn: a running
   * session can be archived without ending its turn, and a delete travels one
   * route with one answer. Delete keeps the two-press arm (first press only
   * arms, see the item's own handler); archive is one press, as everywhere.
   */
  function menuAct(what: 'archive' | 'unarchive' | 'delete') {
    if (menu === null) return;
    const { key, id } = menu;
    setMenu(null);
    if (what === 'delete') useApp.getState().deleteSession(id, key);
    else useApp.getState().archiveSession(id, what === 'archive', key);
  }

  // Every live session, in the order the rail draws them. `order` is the store's
  // own list of child keys, so this is "the conversations that are open right
  // now" — which is the board's whole subject.
  const order = useApp((s) => s.order);
  // The saved-session lists of **every** workspace this end holds. `savedSessions`
  // is a map keyed by `normPath(workspace)`, and its rows are read per card
  // below by *that card's own* workspace — the board's cards span workspaces
  // (`order` is all open sessions), so a single focused-workspace list would
  // leave the others' cards with no row at all: their preview, counts and time
  // would drop to the "nothing said yet" fallbacks whenever the focus moved
  // away from their directory, and back when it came. The whole map is a stable
  // reference while nothing writes it, so subscribing is safe under zustand's
  // identity comparison.
  const savedSessions = useApp((s) => s.savedSessions);
  const currentWorkspace = useApp((s) => {
    const rt = s.sessions[s.activeKey ?? ''];
    return rt ? rt.session?.workspace ?? rt.workspace : '';
  });
  // Per-workspace lookups, rebuilt only when a list is written: one source per
  // directory, so a card's preview and that directory's rail row can never
  // disagree.
  const rowsByIdByWorkspace = useMemo(
    () =>
      new Map(
        Object.values(savedSessions).map((list) => [
          normPath(list.workspace),
          new Map(list.items.map((row) => [row.id, row])),
        ]),
      ),
    [savedSessions],
  );

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
  // id — in **this session's own workspace's** list, so the card keeps its row
  // no matter which workspace the person is focused on — and its preview and
  // counts are the runtime's rather than a second guess.
  const buckets = useApp((s) => s.sessions);

  const cards = useMemo(
    () =>
      order.flatMap((key) => {
        const bucket = buckets[key];
        if (!bucket) return [];
        const id = bucket.sessionId;
        // The same workspace precedence the cards' live facts use: the
        // handshake's own answer first, the child's start directory while it
        // is still waiting for one. Either is the key that row's list is filed
        // under, so the lookup and the write cannot disagree about a directory.
        const ownWorkspace = bucket.session?.workspace ?? bucket.workspace;
        const row =
          id === null || ownWorkspace.trim() === ''
            ? undefined
            : rowsByIdByWorkspace.get(normPath(ownWorkspace))?.get(id);
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
        // Context usage, read the same way the status bar reads it (`selectUsage`):
        // the last successful call's prompt tokens against the window, off the same
        // three fields. One source keeps the card's ring and the bar from ever
        // disagreeing. Null is "no measurement", never 0.
        const liveCall = bucket.liveCall;
        const ctxUsed = liveCall ? liveCall.promptTokens : (bucket.status?.lastPromptTokens ?? null);
        const ctxWindow = bucket.status?.window ?? bucket.uiState?.modelWindow ?? null;
        const ctxPercent =
          ctxUsed !== null && ctxWindow !== null && ctxWindow > 0 ? ctxUsed / ctxWindow : null;
        // For a running card, the in-flight turn's own start stamp, so the card's
        // foot can time the turn the way the status bar does (`now - startedAt`).
        let turnStartedAt: number | null = null;
        if (status === 'running') {
          for (let i = bucket.entries.length - 1; i >= 0; i -= 1) {
            const e = bucket.entries[i];
            if (e.kind === 'turn' && e.status === 'running') {
              turnStartedAt = e.startedAt;
              break;
            }
          }
        }
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
            ctxPercent,
            ctxUsed,
            ctxWindow,
            turnStartedAt,
            // The handshake's own "this conversation was started fresh" fact,
            // shown as the card's one flag — the same word the session bar
            // uses (`session.fresh`), never a second vocabulary for it.
            fresh: bucket.session?.resumed === false,
            // The saved row's own fact, carried whole: the menu's verb depends
            // on it ("Archive" or "Unarchive"), and the saved lists are already
            // subscribed via `rowsByIdByWorkspace` — reading it here costs nothing.
            archived: row?.archived ?? false,
          },
        ];
      }),
    [order, buckets, rowsByIdByWorkspace, statusByKey],
  );

  const columns = useMemo(
    () =>
      COLUMNS.map((column) => ({
        ...column,
        cards: cards.filter((card) => column.statuses.includes(card.status)),
      })),
    [cards],
  );

  // A running card times its in-flight turn like the status bar does (`now -
  // startedAt`), and the runtime sends no duration until the turn ends — so the
  // board needs the same ticking clock, active only while some card is running.
  // An idle board has nothing to recount, and a clock left on would repaint the
  // whole board every second for a figure that cannot change.
  const anyRunning = cards.some((card) => card.status === 'running');
  const now = useTurnClock(anyRunning);

  /**
   * The FLIP slide for a card that changes column.
   *
   * A card is a child of whichever column its status names, so a status
   * change re-parents it: React unmounts the button from the old column and
   * mounts a fresh one in the new column, and a fresh mount has nothing to
   * animate from — which is why a move currently reads as a blink. FLIP
   * supplies the missing half. Every layout pass each card reports where it
   * is; a card that sat somewhere else on the previous pass is first placed
   * back at its old spot for one frame (inverted) and then released onto its
   * real position under a transform transition (played), so the travel is
   * composited instead of the card blinking into its new column.
   *
   * The rectangles are compensated for the two scroll containers a card
   * lives in (its own lane's `overflow-y` and the board's row scroll), so a
   * scroll between the two frames reads as "the card did not move" rather
   * than a spurious vertical slide. A card with no previous frame — the
   * board just opened, or a session that appeared — has nothing to travel
   * from and is left to its plain mount.
   *
   * Only `transform` is played. The card's own height can change with the
   * move (the progress row appears or disappears), and that jump is a line
   * or two; animating it would mean measuring every card's box, not worth
   * one line. `prefers-reduced-motion` needs no special case: the global
   * rule (global.css) zeroes the transition's duration, so the slide lands
   * in one frame, and `transitionend` still fires to release the inline
   * style.
   */
  const cardEls = useRef(new Map<string, HTMLButtonElement>());
  const cardPos = useRef(new Map<string, { x: number; y: number; col: string }>());

  useLayoutEffect(() => {
    const prev = cardPos.current;
    const next = new Map<string, { x: number; y: number; col: string }>();
    for (const [key, el] of cardEls.current) {
      const rect = el.getBoundingClientRect();
      // The card's position in its own layout, not the viewport: add the
      // scroll offsets of both containers back in, so scrolling alone does
      // not register as the card moving.
      const x = rect.left + (el.closest<HTMLElement>('.board-cols')?.scrollLeft ?? 0);
      const y = rect.top + (el.closest<HTMLElement>('.board-col')?.scrollTop ?? 0);
      const col = el.closest<HTMLElement>('.board-col')?.getAttribute('aria-label') ?? '';
      next.set(key, { x, y, col });
      const old = prev.get(key);
      if (!old) continue;
      // **A column change, not a lane shift.** The slide is for the state
      // move itself. Inside a column a card can also be displaced vertically
      // when a neighbour's progress row appears or disappears (the lane
      // reflows) — playing that would make an unrelated card drift every
      // time some other card ticks over.
      if (old.col === col) continue;
      const dx = old.x - x;
      const dy = old.y - y;
      if (dx === 0 && dy === 0) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      // Commit the inverted position before the play, or the browser
      // coalesces the two writes and slides nothing.
      void el.getBoundingClientRect();
      el.style.transition = 'transform var(--motion-base) var(--ease-standard)';
      el.style.transform = '';
      // Release the inline transition once the slide is done, so the card's
      // stylesheet rules (the hover lift) own `transform` again. The target
      // check matters: the card's context ring runs its own
      // `stroke-dashoffset` transition, and a `transitionend` from a child
      // bubbles up and would release this one early.
      const release = (ev: TransitionEvent) => {
        if (ev.target !== el) return;
        el.style.transition = '';
        el.removeEventListener('transitionend', release);
      };
      el.addEventListener('transitionend', release);
    }
    cardPos.current = next;
  });

  // `listed` false means no runtime has answered for **the focused** workspace
  // yet, which is a different statement from "no sessions are open" — so the
  // two are drawn differently rather than both as an empty board. Only the
  // focused workspace's list matters here: a card without its own row already
  // falls back to honest placeholders (see `row` above), so the loading screen
  // is about the directory on screen, not about every directory in the map.
  const loading =
    order.length === 0 &&
    (currentWorkspace.trim() === '' ||
      savedSessions[normPath(currentWorkspace)]?.listed !== true);

  return (
    <div className="board">
      <header className="board-head">
        <div>
          <h2 className="board-title">
            {t('board.title')}
            {/* The board's subject is "the conversations that are open right
                now", and every one of those is a live child process — this is
                the one number the title cannot say by itself. `order` is the
                store's own list of child keys (the same source the cards are
                built from, so the count can never disagree with the board), and
                it is already subscribed above, so this costs nothing. Same chip
                idiom as the column heads' counts. */}
            <span className="board-title-count">{order.length}</span>
          </h2>
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
        <div className="board-cols scroll-fade">
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
                {/* The count is a **quantity**, not a second state mark: the dot
                    beside it says which column this is, and the number says how
                    many cards are in it. Colouring the chip with the dot's token
                    made a quiet "0" in an amber or blue column the loudest thing
                    on the board — the redesign keeps the state in the dot and
                    the chip in the rail's muted tag. */}
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
                    ref={(el) => {
                      // The FLIP effect above reads these. A re-parented card
                      // is a *new* DOM node, so the callback runs with the old
                      // node (clear it) and the new one (register it) in the
                      // same commit — the map never holds a dead reference.
                      if (el === null) cardEls.current.delete(card.key);
                      else cardEls.current.set(card.key, el);
                    }}
                    className={`board-card${isCurrent ? ' is-current' : ''}${isAsking ? ' is-asking' : ''}${card.status === 'running' ? ' is-running' : ''}`}
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
                    // The card's third exit is a right-click: archive and
                    // delete, on the card itself. Offered only when the card
                    // names a session — a card still waiting for `init` has no
                    // id, and a menu that names nothing is where a disabled
                    // item goes to be ignored (the browser's default menu
                    // simply stays).
                    onContextMenu={(e) => {
                      if (card.id === null) return;
                      e.preventDefault();
                      // Clamped so the menu never opens off the window edge:
                      // ~the menu's own footprint in each axis.
                      setMenu({
                        key: card.key,
                        id: card.id,
                        archived: card.archived,
                        // The delete item's two-press arm starts closed, like
                        // the rail row's.
                        armed: false,
                        x: Math.min(e.clientX, window.innerWidth - 200),
                        y: Math.min(e.clientY, window.innerHeight - 110),
                      });
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
                      <span className="board-card-modelrow">
                        {card.model !== '' ? (
                          <span className="board-card-model">
                            {card.provider !== '' ? `${card.provider}/${card.model}` : card.model}
                          </span>
                        ) : null}
                        {/* Context usage, the status bar's own numbers read off
                            this card's own session (`ctxPercent` is built from the
                            same three fields `selectUsage` reads), drawn as a
                            small ring plus percentage at the model chip's right
                            edge. Null is "no measurement" — nothing drawn, never
                            a fake 0%. */}
                        {card.ctxPercent !== null ? (
                          <span
                            className={`board-card-ctx${card.ctxPercent >= 0.9 ? ' is-danger' : ''}`}
                            title={
                              card.ctxWindow !== null
                                ? `${formatTokens(card.ctxUsed)} / ${formatTokens(card.ctxWindow)} tok`
                                : formatTokens(card.ctxUsed)
                            }
                          >
                            <ContextRing value={card.ctxPercent} />
                            <span className="board-card-ctx-pct mono">{formatPercent(card.ctxPercent)}</span>
                          </span>
                        ) : null}
                      </span>
                      <span className="board-card-meta">
                        <span className="board-card-meta-counts">
                          {card.messages !== null
                            ? t('panel.resume.messages', { n: card.messages })
                            : t('board.noCounts')}
                          {card.steps !== null
                            ? ` · ${t('panel.resume.steps', { n: card.steps })}`
                            : ''}
                        </span>
                        {card.status === 'running' && card.turnStartedAt !== null ? (
                          // A running card replaces the relative "xx ago" with the
                          // turn's elapsed time — the same number the status bar
                          // draws (`now - startedAt`, ticked by the board's own
                          // `useTurnClock`). No stamp (a turn in flight whose head
                          // is missing) falls back to the ordinary time.
                          <span className="board-card-time is-turn">{formatDuration(now - card.turnStartedAt)}</span>
                        ) : card.modifiedAt !== null ? (
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

      {/* The card's context menu: fixed at the right-click's coordinates, over
          a full-viewport scrim that folds "click elsewhere" into one mechanism.
          **Act, don't gate**: every card is a live child, so a disabled archive
          row here would be permanently disabled — the menu instead sends
          through the card's own connection (`via`), which the runtime answers
          by waiting that session's own turn out before rewriting. Two rows
          only, with archive above delete — the same order the rail's stacked
          buttons read; delete keeps its rail rule (two presses; the first only
          arms, and leaves the menu up about it). */}
      {menu !== null ? (
        <div
          className="board-menu-scrim"
          onClick={() => setMenu(null)}
          // A right-click on the scrim itself re-opens the browser's menu
          // unless it is claimed here — and claiming it reads as "nothing
          // here either", so it closes the menu instead.
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(null);
          }}
        >
          <div
            className="board-menu"
            role="menu"
            aria-label={t('board.menu.title')}
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              type="button"
              role="menuitem"
              className="board-menu-item"
              onClick={() => menuAct(menu.archived ? 'unarchive' : 'archive')}
            >
              {menu.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
              {menu.archived ? t('panel.resume.unarchive') : t('panel.resume.archive')}
            </button>
            <button
              type="button"
              role="menuitem"
              className={`board-menu-item is-destructive${menu.armed ? ' is-armed' : ''}`}
              aria-label={menu.armed ? t('lb.deleteConfirm') : t('lb.deleteSession')}
              title={menu.armed ? t('lb.deleteConfirm') : t('board.menu.deleteArm')}
              onClick={() => {
                if (menu.armed) {
                  menuAct('delete');
                } else {
                  // Arms, and stays: the next press is the delete. Anything
                  // else — the scrim, Escape, another card — closes the menu
                  // and disarms with it, so a stray first press costs nothing.
                  setMenu({ ...menu, armed: true });
                }
              }}
            >
              {menu.armed ? <X size={13} /> : <Trash2 size={13} />}
              {menu.armed ? t('lb.deleteConfirm') : t('board.menu.delete')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The state → colour class map, used by a column head's dot.
 *
 * The dot is the one mark that carries the column's state. The count beside it
 * is a quantity and stays in the rail's muted tag colour, so a quiet "0" in the
 * amber column is not painted as the loudest thing on the board. The mapping is
 * spelled out rather than built from `:not([class*=…])`, because an absence-based
 * selector would silently match whatever `RowStatus` is added next.
 */
function statusClass(status: RowStatus): string {
  return status === 'broken' || status === 'asking'
    ? 'is-asking'
    : status === 'running'
      ? 'is-running'
      : status === 'unseen'
        ? 'is-unseen'
        : 'is-idle';
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
  // and an explicit class beats an absence-based CSS selector (see
  // `statusClass`), which is also what keeps the dot and the count in step.
  return <span className={`board-col-dot ${statusClass(status)}`} aria-hidden />;
}

/**
 * A tiny circular gauge for a card's context usage.
 *
 * **A ring, deliberately not the kit's linear `Progress`**, because the card's
 * foot has one short horizontal row and a bar would fight the model chip for the
 * same width; a 14px ring sits at the row's right edge and the percentage reads
 * beside it. The geometry is one circle's circumference: the fill is
 * `strokeDasharray = C` and `strokeDashoffset = C * (1 - value)`, so the drawn
 * arc is exactly `value` of the loop. The colour comes from the parent's
 * `currentColor` — neutral up to 90% of the window, then the card's own
 * `is-danger` class turns it `--destructive` — because "the window is nearly
 * full" is the one reading a bare green would lie about.
 */
function ContextRing({ value }: { value: number }) {
  const R = 5.5;
  const C = 2 * Math.PI * R;
  const pct = Math.min(1, Math.max(0, value));
  return (
    <svg className="board-card-ctx-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle className="board-card-ctx-track" cx="7" cy="7" r={R} fill="none" strokeWidth="2.5" />
      <circle
        className="board-card-ctx-arc"
        cx="7"
        cy="7"
        r={R}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={C * (1 - pct)}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
}
