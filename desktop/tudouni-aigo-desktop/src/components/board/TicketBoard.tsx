import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Ban,
  Check,
  CornerDownLeft,
  ExternalLink,
  Folder,
  Inbox,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Play,
  Plus,
  Radar,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Undo2,
  User,
  X,
  Zap,
} from 'lucide-react';
import { activeRuntime, activeWorkspaceOf, selectRowStatus, useApp } from '@/state/store';
import { selectTicketLiveKey, selectTicketTurnRunning } from '@/state/selectors/tickets';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { EmptyState, Tip } from '@/components/ui/kit';
import { SessionDot } from '@/components/sidebar/SessionDot';
import { ModelPicker, WorkspacePicker } from '@/components/panels/TaskPanel';
import { SourcesPanel } from '@/components/board/SourcesPanel';
import { scanSources } from '@/runtime/tauri';
import { describeScan, scanHadProblem } from '@/ticket/sources';
import { workspaceRefLabel, type TaskWorkspaceRef } from '@/task/tasks';
import { currentAssignment } from '@/ticket/machine';
import {
  TICKET_ATTACHMENTS_MAX,
  TICKET_BRIEF_CEILING,
  TICKET_MIN_PROTOCOL,
  TICKET_TITLE_CEILING,
  attachmentsOf,
  ticketTitle,
  unbindableField,
  type Ticket,
  type TicketAttachment,
  type TicketStatus,
} from '@/ticket/model';
import { formatBytes } from '@/ticket/attachments';
import { chooseAttachmentFiles, openTicketAttachment } from '@/runtime/tauri';
import { setDropOverride } from '@/hooks/useFileDrop';
import {
  acceptsDrop,
  canBindBrief,
  canDrop,
  canResumeAssignment,
  columnOf,
  dropTargets,
  dropVerb,
  groupTickets,
  needsYouCause,
  rememberedStartMode,
  staysOnBoard,
  ticketActions,
  ticketAgentBusy,
  ticketRunState,
  type StartMode,
  type TicketColumn,
  type TicketDrop,
  type TicketRunState,
} from '@/ticket/view';
import { baseName } from '@/utils/format';

/**
 * The Ticket board: the work, on one screen.
 *
 * **A view, not a dialog**, for the session board's reasons (`SessionBoard`):
 * the rails must stay usable, a click on a card must not close it, and a
 * request arriving must not wash it out. The two boards share the column and
 * `store.board` keeps them exclusive.
 *
 * **It decides nothing about a Ticket.** The column is the record's status, the
 * buttons are `ticketActions(status)`, and every press is a store action that
 * ends in `machine.apply`. The only things read off sessions are drawn, not
 * stored: the status dot (`selectRowStatus`) and "Not connected", which is
 * "this Ticket is running but its session is not a live child" (design 6.4).
 * Neither is ever written back into the Ticket (invariant 1).
 */

/** The four lanes the overview draws. Done has no permanent column: finished
 *  work is reached through the toolbar's Done filter, where it is one full-width
 *  lane that also owns `dropped`. */
const OVERVIEW_COLUMNS: readonly TicketColumn[] = ['open', 'running', 'needs_you', 'review'];

type LaneTone = 'idle' | 'running' | 'asking' | 'review';

const LANE_TONE: Record<TicketColumn, LaneTone> = {
  open: 'idle',
  running: 'running',
  needs_you: 'asking',
  review: 'review',
  done: 'idle',
};

const STATE_CHIP: Record<TicketStatus, string> = {
  open: 'is-open',
  running: 'is-running',
  needs_you: 'is-asking',
  review: 'is-review',
  done: 'is-done',
  dropped: 'is-done',
};

const STATE_LABEL_KEY: Record<TicketStatus, TKey> = {
  open: 'ticket.col.open',
  running: 'ticket.col.running',
  needs_you: 'ticket.col.needs_you',
  review: 'ticket.col.review',
  done: 'ticket.col.done',
  dropped: 'ticket.dropped',
};

const LANE_EMPTY_TITLE: Record<TicketColumn, TKey> = {
  open: 'ticket.lane.empty.open.title',
  running: 'ticket.lane.empty.running.title',
  needs_you: 'ticket.lane.empty.needs_you.title',
  review: 'ticket.lane.empty.review.title',
  done: 'ticket.lane.empty.done.title',
};

const LANE_EMPTY_HINT: Record<TicketColumn, TKey> = {
  open: 'ticket.lane.empty.open.hint',
  running: 'ticket.lane.empty.running.hint',
  needs_you: 'ticket.lane.empty.needs_you.hint',
  review: 'ticket.lane.empty.review.hint',
  done: 'ticket.lane.empty.done.hint',
};

/** A stable empty list, so the dialog's selector does not repaint every render. */
const NO_ATTACHMENTS: TicketAttachment[] = [];

interface FormValue {
  title: string;
  brief: string;
  workspace: TaskWorkspaceRef;
  model: string;
  /** Files picked in the **new** dialog. There is no Ticket id to copy them
   *  under yet, so they are attached right after `createTicket`. The edit
   *  dialog attaches at once and keeps this empty. */
  attachPaths: string[];
}

export function TicketBoard() {
  const t = useT();
  const setBoard = useApp((s) => s.setBoard);
  const tickets = useApp((s) => s.tickets);
  const loaded = useApp((s) => s.ticketsLoaded);
  const readOnly = useApp((s) => s.ticketsReadOnly);
  const readOnlyReason = useApp((s) => s.ticketsProblem);
  const loadTickets = useApp((s) => s.loadTickets);
  const createTicket = useApp((s) => s.createTicket);
  const updateTicketDraft = useApp((s) => s.updateTicketDraft);
  const clearFinishedTickets = useApp((s) => s.clearFinishedTickets);
  const scanTicketInbox = useApp((s) => s.scanTicketInbox);
  const ticketSeed = useApp((s) => s.ticketSeed);
  const clearTicketSeed = useApp((s) => s.clearTicketSeed);
  const workspaces = useApp((s) => s.workspaces);
  const remoteWorkspaces = useApp((s) => s.remoteWorkspaces);
  const workspace = useApp(activeWorkspaceOf);
  const screenRemoteId = useApp((s) => activeRuntime(s)?.remoteWorkspaceId ?? null);

  // Idempotent: the start-up already asked, and a board opened before the file
  // came back should not be a board that never fills.
  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  const locked = !loaded || readOnly;

  /**
   * One inbox drain per time the board is opened.
   *
   * **On open, not on a timer.** A poll would make the app feel like something
   * is always running in the background, and this board's whole premise is that
   * it acts when a person looks at it. Opening the board is the moment somebody
   * is asking "what is there to do", which is exactly when the question should
   * be answered.
   *
   * Gated on `loaded`: the drain decides "already handled" against the Tickets
   * in memory, so running it before the file was read would treat every old
   * drop as new. Gated on `locked` too — a read-only file must not offer a
   * scan whose every drop would be refused.
   */
  const scanned = useRef(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  useEffect(() => {
    if (!loaded || locked || scanned.current) return;
    scanned.current = true;
    void (async () => {
      setScanning(true);
      try {
        const result = await scanTicketInbox();
        if (result !== null && result.created > 0) {
          setScanNote(t('ticket.inbox.created', { n: result.created }));
        }
      } finally {
        setScanning(false);
      }
    })();
  }, [loaded, locked, scanTicketInbox, t]);

  async function scanNow(): Promise<void> {
    setScanning(true);
    setScanNote(null);
    try {
      const result = await scanTicketInbox();
      if (result === null) return;
      if (result.created > 0) {
        setScanNote(t('ticket.inbox.created', { n: result.created }));
      } else if (result.empty.length > 0) {
        setScanNote(t('ticket.inbox.emptyFiles', { names: result.empty.join(', ') }));
      } else {
        setScanNote(t('ticket.inbox.nothing'));
      }
    } finally {
      setScanning(false);
    }
  }

  /**
   * Ticket sources: a separate button with a separate note.
   *
   * **It never touches the inbox.** A scan only writes files into it; turning
   * them into Tickets is "Check inbox", a second press, so the person sees what
   * arrived before it lands on the board. The two notes are separate states for
   * the same reason: one scan's sentence must not overwrite the other's.
   */
  const [sourcesScanning, setSourcesScanning] = useState(false);
  const [sourcesNote, setSourcesNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  async function scanSourcesNow(): Promise<void> {
    setSourcesScanning(true);
    setSourcesNote(null);
    try {
      const report = await scanSources();
      setSourcesNote({ text: describeScan(report, t), bad: scanHadProblem(report) });
    } catch (err) {
      // Includes "a scan is already running".
      const error = err instanceof Error ? err.message : String(err);
      setSourcesNote({ text: t('ticket.sources.note.scanFailed', { error }), bad: true });
    } finally {
      setSourcesScanning(false);
    }
  }

  const localPaths = useMemo(() => {
    const set = new Set(workspaces);
    if (workspace !== '') set.add(workspace);
    return [...set];
  }, [workspaces, workspace]);
  const remoteLabels = useMemo(
    () => new Map(remoteWorkspaces.map((entry) => [entry.id, entry.label])),
    [remoteWorkspaces],
  );
  const remoteIds = useMemo(() => new Set(remoteWorkspaces.map((entry) => entry.id)), [remoteWorkspaces]);

  /** A new Ticket starts where the screen is, the way "New session" does: on a
   *  remote screen that is the remote workspace itself. */
  const blank = (brief: string): FormValue => ({
    title: '',
    brief,
    workspace: screenRemoteId !== null ? { kind: 'remote', id: screenRemoteId } : { kind: 'active' },
    model: '',
    attachPaths: [],
  });

  /**
   * The new-Ticket dialog, or `null` when it is shut.
   *
   * **A dialog, not a box drawn above the columns.** The board used to open
   * with a composer-shaped form pinned to its top: it pushed the four columns
   * down by its own height on every visit, it was drawn even when nobody was
   * adding anything, and the "Details" disclosure hid the three fields that
   * decide *where the work runs* behind a second click — so the destination, the
   * part a person most needs to get right, was the part most likely never to be
   * seen. Creating a Ticket is one act with a beginning and an end; a dialog
   * says so, and the board goes back to being a board.
   *
   * `key` remounts the form to reset it or to take a seed; its text lives in
   * the form, so nothing is stored here.
   */
  const [composing, setComposing] = useState<{ key: number; initial: FormValue } | null>(null);
  /** Where a seeded brief came from, so creating the Ticket can empty that
   *  composer (only if it still holds the text - `clearDraftIf`). */
  const seedOrigin = useRef<{ draftOf: string; seed: string } | null>(null);
  useEffect(() => {
    if (ticketSeed === null) return;
    seedOrigin.current = ticketSeed.draftOf === null ? null : { draftOf: ticketSeed.draftOf, seed: ticketSeed.brief };
    // A seed opens the dialog: "save this as a Ticket" arrives from the composer
    // or a selection menu, and the person's next act is to read the brief and
    // finish it. Opening the board and leaving a blank form collapsed would be
    // the same as dropping the text.
    setComposing((prev) => ({ key: (prev?.key ?? 0) + 1, initial: blank(ticketSeed.brief) }));
    setEditingId(null);
    clearTicketSeed();
    // `blank` closes over the screen's remote id; the seed is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketSeed, clearTicketSeed]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = editingId === null ? null : (tickets.find((row) => row.id === editingId) ?? null);

  const groups = useMemo(() => groupTickets(tickets), [tickets]);
  const [clearArmed, setClearArmed] = useState(false);

  /* ---------------- dragging a card into another lane ---------------- */

  /**
   * A card that has been let go and whose command is still running.
   *
   * **The board never moves a card optimistically.** `start` opens a session
   * first and only then writes `running` (`ticketRuns.ts`), so a card that slid
   * into Running the instant it was released could sit there with no session
   * behind it if the open was refused — a lie the person would find out about
   * minutes later. The placeholder says "moving" and is replaced by the real card
   * when the store says the status changed, or removed when the command fails.
   */
  const [landing, setLanding] = useState<{ ticketId: string; column: TicketColumn } | null>(null);
  /** What the last drop did, for the screen reader (and the visible note). */
  const [dropNote, setDropNote] = useState<string | null>(null);

  /**
   * The start question, when a drop had to ask.
   *
   * Component state rather than a store field, for the reason `TicketDialog`
   * gives: the question exists only while the board is open and nothing else in
   * the window has a use for it. `remember` is the box's *proposed* answer — it
   * is only written when the dialog is confirmed.
   */
  const [startAsk, setStartAsk] = useState<{ ticket: Ticket; mode: StartMode } | null>(null);

  const startTicket = useApp((s) => s.startTicket);
  const acceptTicket = useApp((s) => s.acceptTicket);
  const setTicketStartMode = useApp((s) => s.setTicketStartMode);
  const ticketStartMode = useApp((s) => s.ticketStartMode);

  /** Cards whose send-back box a drop asked for. */
  const [feedbackFor, setFeedbackFor] = useState<string | null>(null);

  /** Run a Ticket's start for a drop, keeping the board in front of it. */
  const beginFromDrop = useCallback(
    async (ticket: Ticket, mode: StartMode): Promise<void> => {
      setLanding({ ticketId: ticket.id, column: 'running' });
      setDropNote(null);
      try {
        const key = await startTicket(ticket.id, { runNow: mode === 'run_now' });
        if (key === null) {
          setDropNote(t('ticket.problem.start'));
          return;
        }
        // **The one line this whole feature is about.** `staysOnBoard('drag', …)`
        // is true whatever the mode, so a drop — attended or not — leaves the
        // person where they were, watching the card move. Asking the rule rather
        // than omitting the call is what keeps the two paths honest: `act.start`
        // below asks the same function with `'card'` and does close the board, and
        // a future third entry point has an obvious thing to copy.
        if (!staysOnBoard('drag', mode === 'run_now')) setBoard(null);
        setDropNote(
          t(mode === 'run_now' ? 'ticket.drop.announce.begin.run_now' : 'ticket.drop.announce.begin.start', {
            title: ticketTitle(ticket) || ticket.id,
          }),
        );
      } finally {
        setLanding(null);
      }
    },
    [setBoard, startTicket, t],
  );

  /**
   * What letting go means, applied through the **same store actions the card's
   * buttons call** — the drag adds a gesture, never a verb.
   */
  const applyDrop = useCallback(
    (ticket: Ticket, drop: TicketDrop): void => {
      const title = ticketTitle(ticket) || ticket.id;
      switch (drop.kind) {
        case 'begin': {
          const remembered = rememberedStartMode(ticketStartMode);
          if (remembered === null) {
            // Asked, not guessed: the two answers cost differently.
            setStartAsk({ ticket, mode: 'run_now' });
            return;
          }
          void beginFromDrop(ticket, remembered);
          return;
        }
        case 'accept': {
          // Synchronous: the machine answers in the same tick, so there is
          // nothing for a "moving" placeholder to cover.
          const result = acceptTicket(ticket.id);
          setDropNote(
            result.ok
              ? t('ticket.drop.announce.accept', { title })
              : result.reason === 'agent_busy'
                ? t('ticket.problem.agentBusy')
                : t('ticket.problem.refused'),
          );
          return;
        }
        case 'reopen': {
          const result = useApp.getState().dispatchTicket(ticket.id, { type: 'reopen' });
          setDropNote(
            result.ok ? t('ticket.drop.announce.reopen', { title }) : t('ticket.problem.refused'),
          );
          return;
        }
        case 'sendBack': {
          // Sending back needs an opinion, and the opinion lives on the card.
          // A lane cannot type it, so the drop opens the card's own feedback box
          // rather than refusing with no way forward.
          setFeedbackFor(ticket.id);
          setDropNote(t('ticket.btn.sendBackHint'));
          return;
        }
      }
    },
    [acceptTicket, beginFromDrop, t, ticketStartMode],
  );

  /** The toolbar's status filter. `all` draws the four live lanes; anything
   *  else draws that one lane, full width, with a way back.
   *
   *  Declared above the drag because the gesture reads it: a single-lane board
   *  has nowhere to drop, so its cards do not lift at all. */
  const [filter, setFilter] = useState<'all' | TicketColumn>('all');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  const { drag, lanesRef, onPointerDown } = useTicketDrag(
    useCallback(
      (ticketId: string, drop: TicketDrop) => {
        const ticket = useApp.getState().tickets.find((row) => row.id === ticketId);
        if (ticket === undefined) return;
        applyDrop(ticket, drop);
      },
      [applyDrop],
    ),
    filter === 'all',
  );

  const counts: Record<TicketColumn, number> = {
    open: groups.open.length,
    running: groups.running.length,
    needs_you: groups.needs_you.length,
    review: groups.review.length,
    // Done owns `dropped`, the way it owns the folded region in the model.
    done: groups.done.length + groups.dropped.length,
  };

  function create(value: FormValue): boolean {
    const id = createTicket({
      title: value.title.trim(),
      brief: value.brief,
      workspace: value.workspace,
      model: value.model,
    });
    if (id === null) return false;
    if (value.attachPaths.length > 0) {
      // After the record exists: the copies are kept under its id. A file that
      // could not be copied is said on the board, since the dialog is closing.
      void (async () => {
        const { failed } = await useApp.getState().addTicketAttachments(id, value.attachPaths);
        if (failed.length > 0) {
          setScanNote(t('ticket.attach.failed', { list: failed.map((f) => `${baseName(f.path) || f.path} (${f.error})`).join('; ') }));
        }
      })();
    }
    if (seedOrigin.current !== null) {
      useApp.getState().clearDraftIf(seedOrigin.current.draftOf, seedOrigin.current.seed);
      seedOrigin.current = null;
    }
    // Closed on success only: a refused create keeps the dialog — and the
    // typing in it — so the refusal has something to be about.
    setComposing(null);
    return true;
  }

  function save(ticket: Ticket, value: FormValue): boolean {
    const result = updateTicketDraft(ticket.id, {
      title: value.title.trim(),
      brief: value.brief,
      workspace: value.workspace,
      model: value.model,
    });
    if (!result.ok) return false;
    setEditingId(null);
    return true;
  }

  const labelOf = (ref: TaskWorkspaceRef): string | null =>
    workspaceRefLabel(ref, workspace, localPaths, remoteLabels);

  /** A card is visible when it is in the chosen lane and matches the search. */
  function matches(ticket: Ticket): boolean {
    if (filter !== 'all' && columnOf(ticket.status) !== filter) return false;
    if (needle === '') return true;
    const where = labelOf(ticket.workspace) ?? '';
    const hay = [
      ticketTitle(ticket),
      ticket.brief,
      where,
      ticket.model,
      ticket.lastReport?.summary ?? '',
      ticket.lastReport?.question ?? '',
      ticket.origin.kind === 'source' ? ticket.origin.source : '',
      ticket.origin.kind === 'source' ? ticket.origin.thread : '',
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(needle);
  }

  function cardsOf(column: TicketColumn): Ticket[] {
    const cards = column === 'done' ? [...groups.done, ...groups.dropped] : groups[column];
    return cards.filter(matches);
  }

  const visibleCount = tickets.filter(matches).length;
  const laneLabel = filter === 'all' ? '' : t(`ticket.col.${filter}` as TKey);
  const countTail =
    filter === 'all' ? t('ticket.result.ofAll', { total: tickets.length }) : t('ticket.result.in', { lane: laneLabel });

  const columns: TicketColumn[] = filter === 'all' ? [...OVERVIEW_COLUMNS] : [filter];

  const segments: { key: 'all' | TicketColumn; label: string; n: number }[] = [
    { key: 'all', label: t('ticket.filter.all'), n: tickets.length },
    ...OVERVIEW_COLUMNS.map((column) => ({
      key: column,
      label: t(`ticket.col.${column}` as TKey),
      n: counts[column],
    })),
    { key: 'done', label: t('ticket.col.done'), n: counts.done },
  ];

  function renderCard(ticket: Ticket) {
    const dragging = drag?.ticketId === ticket.id;
    return (
      <TicketCard
        key={ticket.id}
        ticket={ticket}
        label={labelOf(ticket.workspace)}
        remoteLabels={remoteLabels}
        remoteIds={remoteIds}
        locked={locked}
        dragging={dragging}
        feedbackRequested={feedbackFor === ticket.id}
        onFeedbackDone={() => setFeedbackFor((current) => (current === ticket.id ? null : current))}
        onDragStart={onPointerDown}
        onMove={(drop) => applyDrop(ticket, drop)}
        onAskStart={() => setStartAsk({ ticket, mode: rememberedStartMode(ticketStartMode) ?? 'run_now' })}
        onEdit={() => setEditingId(ticket.id)}
      />
    );
  }

  /**
   * One lane.
   *
   * **A lane says what it would do while a card is over it, and does nothing
   * otherwise.** The `is-target` state is `acceptsDrop`, which is the very
   * function the drop itself consults — so the highlight can never promise a
   * move the release would refuse. A lane that will not take the card is left
   * exactly as it looks when nothing is being dragged: dimming it would make the
   * board unreadable at the moment a person most wants to read it.
   */
  function renderLane(column: TicketColumn) {
    const single = filter !== 'all';
    const cards = cardsOf(column);
    const tone = LANE_TONE[column];
    const target = drag !== null && acceptsDrop(drag.status, column);
    const landingHere = landing !== null && landing.column === column;
    return (
      <section
        key={column}
        className={`tkb-lane${single ? ' is-single' : ''}${target ? ' is-target' : ''}`}
        data-tone={tone}
        data-lane={column}
        aria-label={t(`ticket.col.${column}` as TKey)}
      >
        <div className="tkb-lane-head">
          <span className={`tkb-lane-dot is-${tone}`} aria-hidden />
          <span className="tkb-lane-title">{t(`ticket.col.${column}` as TKey)}</span>
          {target && drag !== null ? (
            // The verb the release would run, in the lane head: said before the
            // finger is lifted, not after.
            <span className="tkb-lane-verb">
              {(() => {
                const drop = dropTargets(drag.status)[column];
                if (drop === undefined) return null;
                // `begin` has no fixed verb until the start question answers;
                // the lane names the act ("start") and the dialog unnamed.
                return drop.kind === 'begin'
                  ? t('ticket.drop.verb.begin.start')
                  : t(`ticket.drop.verb.${dropVerb(drop)}` as TKey);
              })()}
            </span>
          ) : null}
          {single ? (
            <button
              type="button"
              className="tkb-lane-back"
              aria-label={t('ticket.lane.all')}
              onClick={() => setFilter('all')}
            >
              <ArrowLeft size={11} />
              {t('ticket.lane.all')}
            </button>
          ) : null}
          <span className="grow" />
          {column === 'done' && counts.done > 0 ? (
            <Tip label={clearArmed ? t('ticket.clearFinishedConfirm', { n: counts.done }) : t('ticket.clearFinishedHint')}>
              <button
                type="button"
                className={`btn btn-ghost btn-compact tkb-clear${clearArmed ? ' is-armed' : ''}`}
                disabled={locked}
                onBlur={() => setClearArmed(false)}
                onMouseLeave={() => setClearArmed(false)}
                onClick={() => {
                  if (!clearArmed) {
                    setClearArmed(true);
                    return;
                  }
                  setClearArmed(false);
                  clearFinishedTickets();
                }}
              >
                {clearArmed ? t('ticket.clearFinishedConfirm', { n: counts.done }) : t('ticket.clearFinished')}
              </button>
            </Tip>
          ) : null}
          <span className="tkb-lane-count">{counts[column]}</span>
        </div>

        {/* A card in flight over this lane, before anything has been written:
            the placeholder is the only thing on the board that says "moving"
            (never "moved"), and it is replaced by the real card the moment the
            store's status changes. */}
        {landingHere ? (
          <div className="tkb-landing" role="status">
            <span className="tkb-landing-dot" aria-hidden />
            {t('ticket.drop.moving')}
          </div>
        ) : null}

        {cards.length === 0 ? (
          <div className={`tkb-lane-empty${target ? ' is-target' : ''}`}>
            {target && drag !== null ? (
              <>
                <CornerDownLeft size={16} />
                <b>{t('ticket.drop.verb.begin.start')}</b>
              </>
            ) : (
              <>
                <Inbox size={16} />
                <b>{t(LANE_EMPTY_TITLE[column])}</b>
                <span>{t(LANE_EMPTY_HINT[column])}</span>
              </>
            )}
          </div>
        ) : (
          <div className="tkb-card-list">{cards.map(renderCard)}</div>
        )}
      </section>
    );
  }

  return (
    <div className="board">
      <header className="board-head">
        <div>
          <h2 className="board-title">
            {t('board.tickets.title')}
            <span className="board-title-count">{tickets.length}</span>
          </h2>
          <p className="board-sub">{t('board.tickets.subtitle')}</p>
        </div>
        {/* **The one way in.** Adding a Ticket is a deliberate act with a form
            behind it, so it is a button in the head rather than a box that is
            always open: the board's own subject is the work already written
            down, and a form drawn over the first column competes with it.

            Disabled with the board (`locked`), because creating one writes
            `tickets.json` — a read-only file must not offer a button whose
            press can only fail. */}
        <div className="tkb-head-actions">
          <Tip label={t('ticket.inbox.scanHint')}>
            <button
              type="button"
              className="btn btn-ghost btn-compact tkb-inbox"
              disabled={locked || scanning}
              onClick={() => void scanNow()}
            >
              <Inbox size={13} />
              {t('ticket.inbox.scan')}
            </button>
          </Tip>
          {/* Sources write into the inbox; they are not part of the Tickets
              file, so they stay available when the board is read-only. */}
          <Tip label={t('ticket.sources.scanHint')}>
            <button
              type="button"
              className="btn btn-ghost btn-compact tkb-inbox"
              disabled={sourcesScanning}
              onClick={() => void scanSourcesNow()}
            >
              <Radar size={13} />
              {t('ticket.sources.scan')}
            </button>
          </Tip>
          <Tip label={t('ticket.sources.settingsHint')}>
            <button
              type="button"
              className="lb-icon"
              aria-label={t('ticket.sources.settings')}
              onClick={() => setSourcesOpen(true)}
            >
              <Settings size={15} />
            </button>
          </Tip>
          <button
            type="button"
            className="btn btn-primary btn-compact tkb-new"
            disabled={locked}
            onClick={() => setComposing({ key: (composing?.key ?? 0) + 1, initial: blank('') })}
          >
            <Plus size={13} />
            {t('ticket.new.open')}
          </button>
          <Tip label={t('board.closeHint')}>
            <button type="button" className="lb-icon" aria-label={t('board.close')} onClick={() => setBoard(null)}>
              <X size={15} />
            </button>
          </Tip>
        </div>
      </header>

      {readOnly ? (
        <p className="tkb-problem" role="alert">
          {t('ticket.readOnly', { reason: readOnlyReason ?? '' })}
        </p>
      ) : null}

      {/* What the last drain did. It says what arrived, never that work began:
          a drop becomes an Open Ticket and the person still presses Start. */}
      {scanNote !== null ? (
        <p className="tkb-inbox-note" role="status">
          {scanNote}
        </p>
      ) : null}
      {sourcesNote !== null ? (
        <p
          className={`tkb-inbox-note tkb-src-note${sourcesNote.bad ? ' is-bad' : ''}`}
          role={sourcesNote.bad ? 'alert' : 'status'}
        >
          {sourcesNote.text}
        </p>
      ) : null}
      {sourcesOpen ? <SourcesPanel onClose={() => setSourcesOpen(false)} /> : null}

      {/* Search and the status filter. The filter does not remove the other
          columns from the world — it changes the board to one full-width lane
          and leaves a way back, so a filter never reads as a deletion. */}
      {loaded ? (
        <div className="tkb-toolbar">
          <div className={`tkb-search${query !== '' ? ' has-value' : ''}`}>
            <Search size={13} />
            <input
              type="search"
              value={query}
              placeholder={t('ticket.toolbar.search')}
              aria-label={t('ticket.toolbar.search')}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="button"
              className="tkb-search-clear"
              aria-label={t('ticket.search.clear')}
              onClick={() => setQuery('')}
            >
              <X size={12} />
            </button>
          </div>
          <div className="tkb-seg" role="group" aria-label={t('ticket.filter.label')}>
            {segments.map((segment) => (
              <button
                key={segment.key}
                type="button"
                aria-pressed={filter === segment.key}
                onClick={() => setFilter(segment.key)}
              >
                {segment.label}
                <span className="tkb-seg-n">{segment.n}</span>
              </button>
            ))}
          </div>
          <span className="tkb-result-count" aria-live="polite">
            <b>{visibleCount}</b> {countTail}
          </span>
        </div>
      ) : null}

      {/* The two dialogs, both about a Ticket and both belonging to this board:
          new and edit are one component, so the fields a person fills in are
          the same fields they later correct. They stay component state rather
          than store fields for the reason `IdleCloseConfirm` gives — the
          question exists only while the board is open, and nothing else in the
          window has a use for it. */}
      {composing !== null ? (
        <TicketDialog
          key={`new-${composing.key}`}
          open
          mode="new"
          initial={composing.initial}
          ticketId={null}
          disabled={locked}
          localPaths={localPaths}
          remoteLabels={remoteLabels}
          onSubmit={create}
          onCancel={() => setComposing(null)}
        />
      ) : null}
      {editing !== null ? (
        <TicketDialog
          key={`edit-${editing.id}`}
          open
          mode="edit"
          initial={{
            title: editing.title,
            brief: editing.brief,
            workspace: editing.workspace,
            model: editing.model,
            attachPaths: [],
          }}
          ticketId={editing.id}
          disabled={locked}
          localPaths={localPaths}
          remoteLabels={remoteLabels}
          onSubmit={(value) => save(editing, value)}
          onCancel={() => setEditingId(null)}
        />
      ) : null}

      {!loaded ? (
        <div className="tkb-lanes" aria-busy="true">
          {OVERVIEW_COLUMNS.map((column) => (
            <LaneSkeleton key={column} column={column} />
          ))}
        </div>
      ) : tickets.length === 0 ? (
        <EmptyState title={t('ticket.empty.title')} hint={t('ticket.empty.hint')} />
      ) : (
        <div className="tkb-lanes scroll-fade" ref={lanesRef}>
          {columns.map(renderLane)}
        </div>
      )}

      {/* What the last drop did. Polite and dismissible, because a drag is
          silent otherwise: the card's own move is the only evidence it
          happened, and that evidence is off screen once the lane scrolls. */}
      {dropNote !== null ? (
        <div className="tkb-drop-note" role="status" aria-live="polite">
          <span>{dropNote}</span>
          <button type="button" aria-label={t('common.close')} onClick={() => setDropNote(null)}>
            <X size={11} />
          </button>
        </div>
      ) : null}

      {/* **The card in flight.** A fixed clone at the pointer's own position,
          sized once at pickup so it does not reflow as it crosses lanes of a
          different width, and `inert` so it cannot take a click mid-gesture.

          Portalled to the body, and that is load-bearing: `.board` carries an
          entrance `animation` whose keyframes end in `transform: none`, but an
          *animated* element keeps a stacking context for the animation's
          duration — and a `position: fixed` child of a transformed ancestor is
          positioned against that ancestor, not the viewport. Rendering it here
          would make the clone jump by the board's offset for the first 200ms of
          a drag. */}
      {drag !== null
        ? createPortal(
            <div
              className="tkb-drag-ghost"
              aria-hidden
              style={{
                width: drag.width,
                transform: `translate3d(${drag.x + 12}px, ${drag.y + 10}px, 0)`,
              }}
            >
              <span className="tkb-drag-title">{drag.title}</span>
              <span className="tkb-drag-hint">
                {drag.over !== null && acceptsDrop(drag.status, drag.over)
                  ? (() => {
                      const drop = dropTargets(drag.status)[drag.over];
                      return drop === undefined
                        ? ''
                        : drop.kind === 'begin'
                          ? t('ticket.drop.verb.begin.start')
                          : t(`ticket.drop.verb.${dropVerb(drop)}` as TKey);
                    })()
                  : t('ticket.drop.overNone')}
              </span>
            </div>,
            document.body,
          )
        : null}

      {/* The start question a drop asked. Mounted here so its `key` renews the
          radio state with the Ticket it belongs to. */}
      {startAsk !== null ? (
        <StartDialog
          key={`start-${startAsk.ticket.id}`}
          ticket={startAsk.ticket}
          initial={startAsk.mode}
          remember={ticketStartMode !== 'ask'}
          onSubmit={(mode, remember) => {
            setStartAsk(null);
            // Remembering is a separate act from starting: ticking the box says
            // "stop asking", not "and do it this time too".
            if (remember) setTicketStartMode(mode);
            else if (ticketStartMode !== 'ask') setTicketStartMode('ask');
            void beginFromDrop(startAsk.ticket, mode);
          }}
          onCancel={() => {
            setStartAsk(null);
            setDropNote(t('ticket.drop.cancelled'));
          }}
        />
      ) : null}
    </div>
  );
}

/* ============================================================
   Loading: static blocks, no shimmer.
   ============================================================ */

function LaneSkeleton({ column }: { column: TicketColumn }) {
  const t = useT();
  const tone = LANE_TONE[column];
  return (
    <section className="tkb-lane" data-tone={tone} aria-label={t(`ticket.col.${column}` as TKey)}>
      <div className="tkb-lane-head">
        <span className={`tkb-lane-dot is-${tone}`} aria-hidden />
        <span className="tkb-lane-title">{t(`ticket.col.${column}` as TKey)}</span>
        <span className="grow" />
        <span className="tkb-lane-count">—</span>
      </div>
      {[0, 1].map((index) => (
        <div className="tkb-sk-card" key={index}>
          <span className="tkb-sk tkb-sk-line w80" />
          <span className="tkb-sk tkb-sk-chip" />
          <span className="tkb-sk tkb-sk-line w60" />
        </div>
      ))}
    </section>
  );
}

/* ============================================================
   The dialog: new Ticket and edit Ticket are one control.
   ============================================================ */

/**
 * Writing down a Ticket — the new one, and the correction to an existing one.
 *
 * ## Why it is a dialog
 *
 * It used to be a form pinned to the top of the board, always open on the way
 * in. Three things were wrong with that, and only the third is about looks:
 *
 *   - **It cost the board its height on every visit.** Four columns of work,
 *     pushed down by a text box nobody had asked for yet.
 *   - **It hid the fields that matter most.** The workspace and the model — the
 *     two answers that decide *where the work runs* — sat behind a "Details"
 *     disclosure that started shut, so the default (`wherever the screen is`)
 *     was the only one most Tickets ever got. A dialog has room to show all
 *     four fields at once, and nothing is behind a second click.
 *   - **It read as a composer**, i.e. as something to type a message into,
 *     when creating a Ticket is a deliberate act with a beginning and an end.
 *     The button that opens it is in the head, where the board's other verbs
 *     live.
 *
 * ## What it keeps from the old shape
 *
 * The brief is still the only required field, `Ctrl+Enter` still submits, and
 * the ceiling the runtime would refuse at `ticket_bind` is still said **while
 * the text is in the box** (`unbindableField`) rather than after a Start that
 * could not have worked.
 *
 * Dismissal is a real answer — Esc, the overlay and Cancel all close it — for
 * the reason `IdleCloseConfirm` gives: a prompt with no way out turns one stray
 * click into a forced choice. A refusal does **not** close it: the typing is
 * the thing the refusal is about.
 */
function TicketDialog({
  open,
  mode,
  initial,
  ticketId,
  disabled,
  localPaths,
  remoteLabels,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  mode: 'new' | 'edit';
  initial: FormValue;
  /** The record being edited, or `null` for a new Ticket. An edit attaches at
   *  once (the copy goes under this id); a new Ticket holds the picked paths
   *  in `value.attachPaths` until it exists. */
  ticketId: string | null;
  disabled: boolean;
  localPaths: string[];
  remoteLabels: Map<string, string>;
  /** `true` when it took (a refused save keeps the typing and the dialog). */
  onSubmit: (value: FormValue) => boolean;
  onCancel: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState<FormValue>(initial);
  const titleRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // The one limit a person can hit by pasting: `ticket_bind` carries the brief,
  // the runtime refuses an oversized one, and the Ticket would then say Running
  // with no report tool behind it. Said here, while the text is still in the
  // box, rather than after a Start that could not have worked.
  const tooLong = unbindableField({ title: value.title, brief: value.brief });
  const canSubmit = !disabled && value.brief.trim() !== '' && tooLong === null;
  const briefLength = value.brief.length;
  const counterClass =
    briefLength > TICKET_BRIEF_CEILING
      ? 'tkb-counter is-over'
      : briefLength > TICKET_BRIEF_CEILING * 0.9
        ? 'tkb-counter is-near'
        : 'tkb-counter';

  function submit(): void {
    if (!canSubmit) return;
    // Closed by the parent on success; a refusal leaves the dialog and its text.
    onSubmit(value);
  }

  /* ---------------- attachments ---------------- */
  const stored = useApp((s) =>
    ticketId === null ? NO_ATTACHMENTS : (s.tickets.find((row) => row.id === ticketId)?.attachments ?? NO_ATTACHMENTS),
  );
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const attachCount = ticketId === null ? value.attachPaths.length : stored.length;

  /**
   * One gesture's paths, from the button or a drop. An edit copies them at
   * once; a new Ticket keeps them on the form (deduplicated by path) until the
   * record exists, because the copies are kept under its id.
   */
  async function addPaths(paths: string[]): Promise<void> {
    if (paths.length === 0 || disabled) return;
    setAttachNote(null);
    if (ticketId === null) {
      const fresh = paths.filter((p) => !value.attachPaths.includes(p));
      const room = TICKET_ATTACHMENTS_MAX - value.attachPaths.length;
      if (fresh.length > room) setAttachNote(t('ticket.attach.full', { n: TICKET_ATTACHMENTS_MAX }));
      const taken = fresh.slice(0, Math.max(0, room));
      if (taken.length > 0) setValue((v) => ({ ...v, attachPaths: [...v.attachPaths, ...taken] }));
      return;
    }
    setAttachBusy(true);
    try {
      const { failed } = await useApp.getState().addTicketAttachments(ticketId, paths);
      if (failed.length > 0) {
        setAttachNote(
          t('ticket.attach.failed', {
            list: failed.map((f) => `${baseName(f.path) || f.path} (${f.error})`).join('; '),
          }),
        );
      }
    } finally {
      setAttachBusy(false);
    }
  }
  // The latest `addPaths` for the drop handler, which is registered once.
  const addRef = useRef(addPaths);
  addRef.current = addPaths;

  // While the dialog is up, an OS drop is aimed at it, not at the composer
  // underneath — anywhere on the window, highlighted over the brief.
  useEffect(() => {
    if (!open) return;
    setDropOverride({
      onDragging: setDropHover,
      onDrop: (paths) => void addRef.current(paths),
    });
    return () => setDropOverride(null);
  }, [open]);

  async function browse(): Promise<void> {
    const picked = await chooseAttachmentFiles();
    await addPaths(picked);
  }

  function removeAttachment(name: string, path: string | null): void {
    if (ticketId === null) {
      setValue((v) => ({ ...v, attachPaths: v.attachPaths.filter((p) => p !== path) }));
      return;
    }
    void useApp.getState().removeTicketAttachment(ticketId, name);
  }

  const chips: { key: string; name: string; size: string | null; path: string | null; stored: TicketAttachment | null }[] =
    ticketId === null
      ? value.attachPaths.map((path) => ({ key: path, name: baseName(path) || path, size: null, path, stored: null }))
      : stored.map((item) => ({ key: item.name, name: item.name, size: formatBytes(item.bytes), path: null, stored: item }));

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content
          className="dialog"
          onOpenAutoFocus={(event) => {
            // The name is the first field on the sheet, so an empty one takes
            // the caret — the first thing to fill in is the first thing under
            // the cursor. When a name is already there (an edit, or a seeded
            // ticket), the brief takes it instead: that is what the dialog
            // opened for, and a seeded brief starts at its end, because the
            // person's next act is to add to what is already written.
            event.preventDefault();
            const title = titleRef.current;
            if (title !== null && value.title === '') {
              title.focus();
              return;
            }
            const el = taRef.current;
            if (el === null) return;
            el.focus();
            if (value.brief !== '') el.setSelectionRange(el.value.length, el.value.length);
          }}
        >
          <div className="dialog-head">
            <div className="grow">
              <DialogPrimitive.Title className="dialog-title">
                {mode === 'new' ? t('ticket.new.title') : t('ticket.edit.title')}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="dialog-desc">
                {mode === 'new' ? t('ticket.new.note') : t('ticket.edit.hint')}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <button type="button" className="btn btn-ghost btn-compact" aria-label={t('common.close')}>
                <X size={14} />
              </button>
            </DialogPrimitive.Close>
          </div>

          <form
            className="tkb-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="dialog-body scroll-fade">
              <section className="tkb-fgroup" aria-labelledby="tkb-dialog-work">
                <div className="tkb-fgroup-head">
                  <h3 className="tkb-fgroup-title" id="tkb-dialog-work">
                    <MessageSquare size={13} />
                    {t('ticket.form.work')}
                  </h3>
                  <span className="tkb-fgroup-hint">{t('ticket.form.workHint')}</span>
                </div>

                {/* The name comes first on the sheet; the brief, which is the
                    Ticket itself, follows it. The order is the order a person
                    fills them in — label, then the work — and it also puts the
                    optional field where an optional field is looked for. */}
                <label className="cfg-field">
                  <span className="cfg-label">
                    {t('ticket.field.title')}
                    <span className="cfg-optional">{t('panel.task.optional')}</span>
                  </span>
                  <input
                    ref={titleRef}
                    className="cfg-input"
                    value={value.title}
                    spellCheck={false}
                    disabled={disabled}
                    placeholder={t('ticket.field.titlePlaceholder')}
                    aria-invalid={tooLong === 'title'}
                    aria-describedby={tooLong === 'title' ? 'tkb-title-error' : undefined}
                    onChange={(e) => setValue({ ...value, title: e.target.value })}
                  />
                </label>
                {tooLong === 'title' ? (
                  <p className="tkb-form-rule" id="tkb-title-error" role="alert">
                    {t('ticket.limit.title', { n: TICKET_TITLE_CEILING })}
                  </p>
                ) : null}

                <label className="cfg-field">
                  <span className="tkb-label-row">
                    <span className="cfg-label">
                      {t('ticket.field.brief')}
                      <span className="cfg-required" aria-hidden>
                        *
                      </span>
                      <span className="sr-only">{t('ticket.required')}</span>
                    </span>
                    <span className={counterClass}>
                      {briefLength} / {TICKET_BRIEF_CEILING}
                    </span>
                  </span>
                  <textarea
                    ref={taRef}
                    className="cfg-textarea tkb-brief"
                    rows={6}
                    value={value.brief}
                    spellCheck={false}
                    disabled={disabled}
                    placeholder={t('ticket.new.placeholder')}
                    aria-invalid={tooLong === 'brief'}
                    aria-describedby={tooLong === 'brief' ? 'tkb-brief-error' : 'tkb-brief-hint'}
                    onChange={(e) => setValue({ ...value, brief: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        submit();
                      }
                    }}
                  />
                  <span className="cfg-hint" id="tkb-brief-hint">
                    {t('ticket.form.briefHint')}
                  </span>
                </label>
                {tooLong === 'brief' ? (
                  <p className="tkb-form-rule" id="tkb-brief-error" role="alert">
                    {t('ticket.limit.brief', { n: TICKET_BRIEF_CEILING })}
                  </p>
                ) : null}

                {/* Attachments: a button, or a drop anywhere on the window while
                    the dialog is up (highlighted here). */}
                <div
                  className={`tkb-attach${dropHover ? ' is-drop' : ''}`}
                  aria-busy={attachBusy || undefined}
                >
                  <div className="tkb-label-row">
                    <span className="cfg-label">
                      <Paperclip size={12} /> {t('ticket.attach.title')}
                      <span className="cfg-optional">{t('panel.task.optional')}</span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-outline btn-compact"
                      disabled={disabled || attachBusy || attachCount >= TICKET_ATTACHMENTS_MAX}
                      onClick={() => void browse()}
                    >
                      <Plus size={12} />
                      {attachBusy ? t('ticket.attach.busy') : t('ticket.attach.add')}
                    </button>
                  </div>
                  {dropHover ? (
                    <p className="cfg-hint">{t('ticket.attach.drop')}</p>
                  ) : chips.length === 0 ? (
                    <p className="cfg-hint">{t('ticket.attach.hint')}</p>
                  ) : (
                    <ul className="tkb-attach-list" aria-label={t('ticket.attach.title')}>
                      {chips.map((chip) => (
                        <li key={chip.key} className="tkb-chip tkb-attach-chip" title={chip.path ?? chip.name}>
                          {chip.stored !== null && ticketId !== null ? (
                            <button
                              type="button"
                              className="tkb-attach-name"
                              aria-label={t('ticket.attach.open', { name: chip.name })}
                              onClick={() => void openTicketAttachment(ticketId, chip.name).catch(() => undefined)}
                            >
                              {chip.name}
                            </button>
                          ) : (
                            <span className="tkb-attach-name">{chip.name}</span>
                          )}
                          {chip.size !== null ? <span className="muted">{chip.size}</span> : null}
                          <button
                            type="button"
                            className="tkb-attach-drop"
                            aria-label={t('ticket.attach.remove', { name: chip.name })}
                            disabled={disabled}
                            onClick={() => removeAttachment(chip.name, chip.path)}
                          >
                            <X size={11} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {ticketId === null && chips.length > 0 ? (
                    <p className="cfg-hint">{t('ticket.attach.pendingNote')}</p>
                  ) : null}
                  {attachNote !== null ? (
                    <p className="tkb-form-rule" role="alert">
                      {attachNote}
                    </p>
                  ) : null}
                </div>
              </section>

              {/* All three, always. They were behind a disclosure that started
                  shut, which made "where this runs" the field people never saw —
                  and it is the one answer a wrong default cannot recover from. */}
              <section className="tkb-fgroup" aria-labelledby="tkb-dialog-where">
                <div className="tkb-fgroup-head">
                  <h3 className="tkb-fgroup-title" id="tkb-dialog-where">
                    <Folder size={13} />
                    {t('ticket.form.where')}
                  </h3>
                  <span className="tkb-fgroup-hint">{t('ticket.form.whereHint')}</span>
                </div>

                <div className="tkb-field-grid">
                  <label className="cfg-field">
                    <span className="cfg-label">{t('panel.task.field.workspace')}</span>
                    <WorkspacePicker
                      value={value.workspace}
                      localPaths={localPaths}
                      remoteLabels={remoteLabels}
                      onChange={(next) => setValue({ ...value, workspace: next })}
                    />
                  </label>
                  <label className="cfg-field">
                    <span className="cfg-label">
                      {t('panel.task.field.model')}
                      <span className="cfg-optional">{t('panel.task.optional')}</span>
                    </span>
                    <ModelPicker value={value.model} onChange={(model) => setValue({ ...value, model })} />
                  </label>
                </div>
              </section>
            </div>

            <div className="dialog-foot">
              <span className="tkb-form-note">
                <CornerDownLeft size={12} />
                {t('ticket.new.hint')}
              </span>
              <span className="grow" />
              <button type="button" className="btn btn-outline" onClick={onCancel}>
                {t('common.cancel')}
                <kbd className="kbd" style={{ marginLeft: 4 }}>
                  Esc
                </kbd>
              </button>
              <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
                {mode === 'new' ? <Plus size={13} /> : <Check size={13} />}
                {mode === 'new' ? t('ticket.new.create') : t('ticket.edit.save')}
              </button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* ============================================================
   The drag: one controller for the lane list.
   ============================================================ */

/**
 * One card in flight.
 *
 * `pointerId` is what makes this cancellable at all: the gesture belongs to the
 * pointer that started it, and `pointercancel` / a lost capture both arrive
 * with the same id (a window that loses focus, a touch that turns into a
 * scroll).
 */
interface DragState {
  ticketId: string;
  pointerId: number;
  /** The pointer's current client position, for the floating clone. */
  x: number;
  y: number;
  /** The card's size when it was picked up: the clone must not resize as it
   *  crosses a lane of a different width. */
  width: number;
  /** The lane under the pointer, or `null` over dead space. */
  over: TicketColumn | null;
  /** The card's own status, so the drop targets do not need a lookup. */
  status: TicketStatus;
  title: string;
}

/** How far the pointer travels before a press becomes a drag. Below this it is
 *  still a click, so a card can be pressed to focus it without lifting off. */
const DRAG_THRESHOLD = 5;

/** How close to a scroller's edge the pointer has to be to auto-scroll it. */
const EDGE_PX = 48;
/** Pixels per frame at the edge. Slow enough to aim, fast enough to cross four
 *  lanes without lifting. */
const EDGE_SPEED = 14;

/**
 * The board's drag gesture.
 *
 * **Pointer events, not HTML5 drag-and-drop.** The board is a `view` inside a
 * WebView, where a `dragstart` payload is shared with the OS file-drop channel
 * and carries no coordinates worth trusting; it also has no touch support and
 * cannot report where the pointer is *between* drops. Pointer events give the
 * clone a position per frame, which is the whole interaction.
 *
 * **The gesture decides nothing.** It produces a `TicketDrop` and hands it to
 * the caller; the caller runs the same store action the card's own button runs.
 * That is the rule this feature lives or dies by — a lane can mean what a button
 * means, never more.
 */
function useTicketDrag(
  onDrop: (ticketId: string, drop: TicketDrop) => void,
  /** Whether any lane other than the card's own is on screen. */
  enabled: boolean,
) {
  const [drag, setDrag] = useState<DragState | null>(null);
  /** The pointer is down but has not travelled far enough yet. Refs, because a
   *  press that does not become a drag must leave no React state behind. */
  const pending = useRef<{
    pointerId: number;
    ticketId: string;
    status: TicketStatus;
    title: string;
    x: number;
    y: number;
    width: number;
  } | null>(null);
  const lanesRef = useRef<HTMLDivElement>(null);

  /** The lane whose rectangle holds a point. Read off the DOM because the lanes
   *  are laid out by flex, not by anything this hook knows. */
  const laneAt = useCallback((x: number, y: number): TicketColumn | null => {
    const root = lanesRef.current;
    if (root === null) return null;
    for (const lane of root.querySelectorAll<HTMLElement>('[data-lane]')) {
      const box = lane.getBoundingClientRect();
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
        return lane.dataset.lane as TicketColumn;
      }
    }
    return null;
  }, []);

  /**
   * Keep the scroller under the pointer turning while the card is near it.
   *
   * Twice over: `.tkb-lanes` scrolls sideways, so without this a card could not
   * be carried from Open to Review on a narrow window without being put down
   * first; and each lane scrolls its own cards, so reach the bottom of a long
   * lane. Driven by `pointermove` — a pointer held perfectly still at the edge
   * does not scroll, which is the behaviour a person expects from a drag they
   * are aiming.
   */
  const autoScroll = useCallback((x: number, y: number) => {
    const root = lanesRef.current;
    if (root === null) return;
    const box = root.getBoundingClientRect();
    if (y >= box.top && y <= box.bottom) {
      if (x - box.left < EDGE_PX) root.scrollLeft -= EDGE_SPEED;
      else if (box.right - x < EDGE_PX) root.scrollLeft += EDGE_SPEED;
    }
    for (const lane of root.querySelectorAll<HTMLElement>('[data-lane]')) {
      const laneBox = lane.getBoundingClientRect();
      if (x < laneBox.left || x > laneBox.right) continue;
      if (y - laneBox.top < EDGE_PX) lane.scrollTop -= EDGE_SPEED;
      else if (laneBox.bottom - y < EDGE_PX) lane.scrollTop += EDGE_SPEED;
    }
  }, []);

  /** A press that might become a drag. Nothing is captured yet: capturing here
   *  would swallow the click a person means to make. */
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, ticket: Ticket) => {
      // Primary button and one pointer only. A second finger must not start a
      // second card.
      if (event.button !== 0 || pending.current !== null) return;
      // A filtered board draws one lane, so every other lane is off screen and
      // there is nowhere to drop. Lifting the card would be a gesture whose only
      // possible outcome is a release over nothing.
      if (!enabled) return;
      // Pressing a control inside the card is pressing that control: the card's
      // sentence, its buttons, and its menu all keep their own gestures.
      if ((event.target as HTMLElement).closest('button, a, input, textarea, select, [role="menu"]') !== null) {
        return;
      }
      const box = event.currentTarget.getBoundingClientRect();
      pending.current = {
        pointerId: event.pointerId,
        ticketId: ticket.id,
        status: ticket.status,
        title: ticketTitle(ticket) || ticket.id,
        x: event.clientX,
        y: event.clientY,
        width: box.width,
      };
    },
    [enabled],
  );

  /** Movement: promote a press into a drag once it has travelled far enough. */
  useEffect(() => {
    function move(event: PointerEvent): void {
      const start = pending.current;
      if (start !== null && start.pointerId === event.pointerId) {
        const far =
          Math.abs(event.clientX - start.x) >= DRAG_THRESHOLD ||
          Math.abs(event.clientY - start.y) >= DRAG_THRESHOLD;
        if (!far) return;
        pending.current = null;
        // Only some Tickets can go anywhere. The others never lift, which is
        // the honest feedback: there is nothing this gesture could do.
        if (Object.keys(dropTargets(start.status)).length === 0) return;
        // The press may already have selected the card's text. Clear it: the
        // gesture has become a move, and a half-selected brief dragged across
        // the board says the wrong thing about what is happening.
        window.getSelection()?.removeAllRanges();
        setDrag({
          ticketId: start.ticketId,
          pointerId: start.pointerId,
          x: event.clientX,
          y: event.clientY,
          width: start.width,
          over: null,
          status: start.status,
          title: start.title,
        });
        return;
      }
      setDrag((current) => {
        if (current === null || current.pointerId !== event.pointerId) return current;
        const over = laneAt(event.clientX, event.clientY);
        return { ...current, x: event.clientX, y: event.clientY, over };
      });
      // Outside the updater: scrolling is a side effect of the pointer moving,
      // not something a render pass may redo.
      autoScroll(event.clientX, event.clientY);
    }

    function up(event: PointerEvent): void {
      if (pending.current !== null && pending.current.pointerId === event.pointerId) {
        // A press that never became a drag: it was a click, and the card's own
        // handlers saw it. Nothing to do.
        pending.current = null;
        return;
      }
      // **The drop is decided before any state is written.** Reading the card in
      // flight out of a `setDrag` updater would run the command inside React's
      // render phase — and an updater may be invoked more than once (StrictMode,
      // a re-render while it is queued), which would fire `start` twice. `dragRef`
      // is the same object the render is drawing, read directly.
      const current = dragRef.current;
      if (current === null || current.pointerId !== event.pointerId) return;
      setDrag(null);
      const lane = laneAt(event.clientX, event.clientY);
      if (lane === null) return;
      const drop = dropTargets(current.status)[lane];
      // `drop` is only non-undefined for a lane `acceptsDrop` returns true for,
      // so an illegal lane releases silently — the highlight already said so.
      if (drop !== undefined) onDrop(current.ticketId, drop);
    }

    function cancel(event: PointerEvent): void {
      if (pending.current?.pointerId === event.pointerId) {
        pending.current = null;
        return;
      }
      setDrag((current) => (current !== null && current.pointerId === event.pointerId ? null : current));
    }

    function key(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      if (pending.current === null && dragRef.current === null) return;
      // Capture, and stop it: the window's Esc closes the board, and an
      // in-flight card is the nearer thing to cancel.
      event.preventDefault();
      event.stopPropagation();
      pending.current = null;
      setDrag(null);
    }

    /**
     * The window going away ends the gesture.
     *
     * `pointerup` outside the window never arrives, so a card would stay in
     * flight — a floating clone following a pointer that is now somewhere else,
     * with the board's next click landing on a drop target. The window losing
     * focus is the one signal that always precedes that.
     */
    function blur(): void {
      pending.current = null;
      // Only clear if something is actually in flight, so the ordinary window
      // blur (clicking the other app) costs no render.
      if (dragRef.current !== null) setDrag(null);
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
    };
  }, [autoScroll, laneAt, onDrop]);

  // Read inside the key handler, which is registered once.
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  return { drag, lanesRef, onPointerDown };
}

/* ============================================================
   The start dialog: the one question a drop into Running asks.
   ============================================================ */

/**
 * Start an Open Ticket — attended, or right now.
 *
 * **Why a drop asks at all.** The gesture "drag this card to Running" states
 * that the work should begin; it does not state whether the brief should be sent
 * unattended. Those cost differently (one parks the brief in the session's input
 * box, the other turns autopilot on and spends tokens with nobody watching), so
 * the answer is a choice — remembered only when the person ticks the box, and
 * `'ask'` by default (`rememberedStartMode`).
 *
 * `Ctrl+Enter` submits, Esc cancels, and the chosen mode is the one the radio
 * shows rather than a hidden default.
 */
function StartDialog({
  ticket,
  initial,
  remember,
  onSubmit,
  onCancel,
}: {
  ticket: Ticket;
  /** The mode the radio starts on: the remembered one, or `run_now` when there
   *  is nothing remembered (the gesture meant "go"). */
  initial: StartMode;
  /** Whether the remember box starts ticked. */
  remember: boolean;
  onSubmit: (mode: StartMode, remember: boolean) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<StartMode>(initial);
  const [keep, setKeep] = useState(remember);
  const okRef = useRef<HTMLButtonElement>(null);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content
          className="dialog tkb-start"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            okRef.current?.focus();
          }}
        >
          <div className="dialog-head">
            <div className="grow">
              <DialogPrimitive.Title className="dialog-title">
                {t('ticket.start.title', { title: ticketTitle(ticket) || ticket.id })}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="dialog-desc">
                {t('ticket.start.note')}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <button type="button" className="btn btn-ghost btn-compact" aria-label={t('common.close')}>
                <X size={14} />
              </button>
            </DialogPrimitive.Close>
          </div>

          <div className="dialog-body scroll-fade tkb-start-body">
            <label className="tk-choice-row tkb-start-choice">
              <input
                type="radio"
                name="tkb-start-mode"
                checked={mode === 'start'}
                onChange={() => setMode('start')}
              />
              <span className="tkb-start-copy">
                <span className="tkb-start-name">
                  <Play size={12} />
                  {t('ticket.start.mode.start')}
                </span>
                <span className="tkb-start-hint">{t('ticket.start.mode.startHint')}</span>
              </span>
            </label>

            <label className="tk-choice-row tkb-start-choice">
              <input
                type="radio"
                name="tkb-start-mode"
                checked={mode === 'run_now'}
                onChange={() => setMode('run_now')}
              />
              <span className="tkb-start-copy">
                <span className="tkb-start-name">
                  <Zap size={12} />
                  {t('ticket.start.mode.run_now')}
                </span>
                <span className="tkb-start-hint">{t('ticket.start.mode.run_nowHint')}</span>
              </span>
            </label>

            <label className="cfg-check tkb-start-remember">
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
              <span className="tkb-start-copy">
                <span>{t('ticket.start.remember')}</span>
                <span className="tkb-start-hint">{t('ticket.start.rememberHint')}</span>
              </span>
            </label>          </div>

          <div className="dialog-foot">
            <span className="tkb-form-note">
              <CornerDownLeft size={12} />
              {t('ticket.new.hint')}
            </span>
            <span className="grow" />
            <button type="button" className="btn btn-outline" onClick={onCancel}>
              {t('ticket.start.cancel')}
            </button>
            <button
              ref={okRef}
              type="button"
              className="btn btn-primary"
              onClick={() => onSubmit(mode, keep)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  onSubmit(mode, keep);
                }
              }}
            >
              {mode === 'run_now' ? <Zap size={13} /> : <Play size={13} />}
              {t('ticket.start.confirm')}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* ============================================================
   One card.
   ============================================================ */

function TicketCard({
  ticket,
  label,
  remoteLabels,
  remoteIds,
  locked,
  dragging,
  feedbackRequested,
  onFeedbackDone,
  onDragStart,
  onMove,
  onAskStart,
  onEdit,
}: {
  ticket: Ticket;
  /** What the Ticket's workspace ref names today, or `null` when it names
   *  nothing this window knows (a forgotten bookmark, a deleted host). */
  label: string | null;
  remoteLabels: Map<string, string>;
  remoteIds: ReadonlySet<string>;
  locked: boolean;
  /** This card is the one in flight: drawn as a placeholder, not lifted twice. */
  dragging: boolean;
  /** A drop asked this card to say what should change (send back). */
  feedbackRequested: boolean;
  /** The drop's request has been answered or dropped (the box closed). */
  onFeedbackDone: () => void;
  onDragStart: (event: React.PointerEvent<HTMLElement>, ticket: Ticket) => void;
  /** The menu's "Move to…": the same command the drop would run. */
  onMove: (drop: TicketDrop) => void;
  /** The menu's "Start options…": the only way back to the dialog once a mode
   *  has been remembered (ticking the box suppresses it). */
  onAskStart: () => void;
  onEdit: () => void;
}) {
  const t = useT();
  const setBoard = useApp((s) => s.setBoard);
  const startTicket = useApp((s) => s.startTicket);
  const restartTicket = useApp((s) => s.restartTicket);
  const openTicketSession = useApp((s) => s.openTicketSession);
  const acceptTicket = useApp((s) => s.acceptTicket);
  const dropTicket = useApp((s) => s.dropTicket);
  const sendBackTicket = useApp((s) => s.sendBackTicket);
  const dispatchTicket = useApp((s) => s.dispatchTicket);
  const removeTicket = useApp((s) => s.removeTicket);

  // The session behind the current Assignment, read as primitives so a card
  // does not repaint on every token of every session in the window.
  const liveKey = useApp((s) => selectTicketLiveKey(s, ticket));
  const rowStatus = useApp((s) => (liveKey === null ? 'idle' : selectRowStatus(s, liveKey)));
  const protocol = useApp((s) => (liveKey === null ? null : (s.sessions[liveKey]?.session?.protocol ?? null)));

  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');

  // A drop into Running came here to have something typed: open the box, and
  // tell the board it may forget the request so a later re-render does not
  // reopen what the person just closed.
  useEffect(() => {
    if (!feedbackRequested) return;
    setFeedbackOpen(true);
    onFeedbackDone();
  }, [feedbackRequested, onFeedbackDone]);
  // **On the card, not on the board.** A refusal belongs beside the button that
  // produced it: the board is a horizontal scroller, so a sentence drawn above
  // the columns can be several screens from the card whose Start failed — and
  // the next press anywhere cleared it, which is what made it unreadable rather
  // than merely misplaced.
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * The card's housekeeping menu: edit, drop, delete.
   *
   * **The three verbs live behind one ⋯, not on a row of their own.** They are
   * housekeeping, not the work the card is about, and on the four-lane
   * overview a 40px icon row under "Open session" was the widest thing on a
   * narrow card — a second button row for actions nobody presses on most
   * visits. One trigger costs a single icon; the menu also gives the same
   * verbs to a right-click, so the card has both the discoverable and the
   * habitual way in.
   *
   * Hand-rolled for `SessionBoard`'s reasons: a menu over a *view* wants
   * coordinates, not anchoring, and a fixed scrim folds "click elsewhere" and
   * Escape into one mechanism. The items are the record's own — drop is
   * offered only where `canDrop` allows it, and every press ends in a store
   * action that goes through `machine.apply`.
   */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  function closeMenu(): void {
    setMenu(null);
    setArmed(false);
  }

  /** Open at a point, clamped so the menu never hangs off the window edge. */
  function openMenuAt(x: number, y: number): void {
    setArmed(false);
    setMenu({
      x: Math.max(8, Math.min(x, window.innerWidth - 208)),
      y: Math.max(8, Math.min(y, window.innerHeight - 150)),
    });
  }

  useEffect(() => {
    if (menu === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Capture, and stop it: the window's own Esc closes the board, and the
      // menu is the nearer thing to close.
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
      setArmed(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [menu]);

  const assignment = currentAssignment(ticket);
  const connected = liveKey !== null;
  const resumable = canResumeAssignment(ticket, assignment, remoteIds);
  const status = ticket.status;
  const live = status === 'running' || status === 'needs_you' || status === 'review';
  const cause = needsYouCause(ticket);
  const report = status === 'open' ? null : ticket.lastReport;
  const asks = report?.status === 'blocked' && (report.question ?? '') !== '';
  const runs = ticket.assignments.length;
  // Where it runs: the Assignment's own place when it has one (a Ticket made
  // against "the workspace on screen" has no other fixed answer), the ref's
  // otherwise.
  const where =
    assignment === null
      ? label
      : assignment.executor.remoteWorkspaceId !== null
        ? (remoteLabels.get(assignment.executor.remoteWorkspaceId) ?? assignment.executor.workspace ?? null)
        : (assignment.executor.workspace ?? label);
  const startBlocked = label === null;
  const placeMissing = status === 'open' ? startBlocked : live && !connected && !resumable && startBlocked;
  const oldRuntime = live && protocol !== null && protocol > 0 && protocol < TICKET_MIN_PROTOCOL;
  // A brief the runtime would refuse at `ticket_bind`, or an empty one: either
  // way there is nothing to start. Both are refused at the source (the form and
  // `createTicket`), so this is the third guard, for a record that predates
  // them or arrived from a hand-edited file.
  const cannotStart = startBlocked || ticket.brief.trim() === '' || !canBindBrief(ticket);

  async function run(work: () => Promise<boolean>, failure: TKey): Promise<void> {
    setProblem(null);
    setBusy(true);
    try {
      if (!(await work())) setProblem(t(failure));
    } finally {
      setBusy(false);
    }
  }

  const closeBoard = () => setBoard(null);
  const act = {
    start: (runNow: boolean) =>
      run(async () => {
        const key = await startTicket(ticket.id, { runNow });
        // A prefilled brief is waiting to be read and added to, so the person
        // is taken to it. "Run now" has nothing to wait for: the board stays,
        // and the card moves to Running by itself. A **drag** never leaves the
        // board either way, which is why that rule lives in `staysOnBoard`
        // rather than here (see `applyDrop`).
        if (key !== null && !staysOnBoard('card', runNow)) closeBoard();        return key !== null;
      }, 'ticket.problem.start'),
    restart: () =>
      run(async () => {
        const key = await restartTicket(ticket.id);
        if (key !== null) closeBoard();
        return key !== null;
      }, 'ticket.problem.start'),
    open: () =>
      run(async () => {
        const key = await openTicketSession(ticket.id);
        if (key !== null) closeBoard();
        return key !== null;
      }, 'ticket.problem.open'),
    sendBack: () =>
      run(async () => {
        const result = await sendBackTicket(ticket.id, feedback);
        if (result.ok) {
          setFeedback('');
          setFeedbackOpen(false);
          return true;
        }
        if (result.reason !== 'session_unavailable') {
          setProblem(t('ticket.problem.refused'));
          return true; // already said
        }
        return false;
      }, 'ticket.problem.sendBack'),
  };

  const actions = ticketActions(status, connected);
  const canGo = connected || resumable;
  const cannotSessions = busy || locked;

  /** The lanes this card can be sent to, from the same table the drop uses. */
  const moveEntries = Object.entries(dropTargets(status)) as [TicketColumn, TicketDrop][];

  /**
   * What this Assignment's session is doing, derived from the bucket.
   *
   * `start` writes `running` before anything is sent, so this is what stops the
   * card claiming work is under way when the brief is still parked in the input
   * box (or when the handshake has not landed). Read as primitives so the card
   * does not repaint on every token — the same reason as `rowStatus`.
   */
  const runReady = useApp((s) => (liveKey === null ? false : (s.sessions[liveKey]?.ready ?? false)));
  const runDraft = useApp((s) => (liveKey === null ? '' : (s.sessions[liveKey]?.draft ?? '')));
  const runSpoke = useApp((s) => (liveKey === null ? false : (s.sessions[liveKey]?.hasSpoken ?? false)));
  const runState: TicketRunState = ticketRunState({
    status,
    live: connected,
    ready: runReady,
    draft: runDraft,
    hasSpoken: runSpoke,
    brief: ticket.brief,
  });
  // A boolean, so the card repaints when a turn starts or ends and not per token.
  const turnRunning = useApp((s) => selectTicketTurnRunning(s, liveKey));
  const agentBusy = ticketAgentBusy({ status, live: connected, turnRunning });

  return (
    <>
      <article
        className={`tkb-card${status === 'needs_you' ? ' is-needs' : ''}${status === 'review' ? ' is-review' : ''}${status === 'done' || status === 'dropped' ? ' is-finished' : ''}${dragging ? ' is-dragging' : ''}${runState === 'awaiting_send' ? ' is-parked' : ''}`}
        aria-labelledby={`tkb-title-${ticket.id}`}
        // **The drag starts here and nowhere else.** A press on the card's body
        // may become one; a press on a control inside it does not (the hook
        // checks), and a right-click is the menu's.
        onPointerDown={
          locked
            ? undefined
            : (e) => {
                // A right-click or a second pointer is not a drag.
                if (e.button !== 0) return;
                onDragStart(e, ticket);
              }
        }
        // The card's second way into the menu, at the pointer's own place. A
        // right-click inside a text field keeps the native menu: that is where
        // "copy" and "paste" live, and the housekeeping verbs are not what a
        // person selected text for.
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('textarea, input') !== null) return;
          e.preventDefault();
          openMenuAt(e.clientX, e.clientY);
        }}
      >
        <div className="tkb-card-top">
          <h3 className="tkb-card-title" id={`tkb-title-${ticket.id}`} title={ticketTitle(ticket)}>
            {ticketTitle(ticket) || t('ticket.untitled')}
          </h3>
          <span className={`tkb-state-chip ${STATE_CHIP[status]}`}>{t(STATE_LABEL_KEY[status])}</span>
          {/* The housekeeping verbs, behind one ⋯ in the card's top corner.
              They are not the work the card is about, and on the four-lane
              overview a row of three icons under "Open session" was the widest
              thing on a narrow card. The menu is also on right-click. */}
          <Tip label={t('ticket.menu.more')}>
            <button
              ref={moreRef}
              type="button"
              className="tkb-card-more"
              aria-label={t('ticket.menu.more')}
              aria-haspopup="menu"
              aria-expanded={menu !== null}
              onClick={() => {
                const rect = moreRef.current?.getBoundingClientRect();
                if (rect === undefined) return;
                // Right-edged with the trigger, so the menu opens under the
                // dots it belongs to.
                openMenuAt(rect.right - 200, rect.bottom + 4);
              }}
            >
              <MoreHorizontal size={14} />
            </button>
          </Tip>
        </div>

        <div className="tkb-card-meta">
          <span className={`tkb-chip${label === null ? ' is-missing' : ''}`} title={where ?? undefined}>
            <Folder size={11} />
            <span className="txt">{where === null ? t('ticket.workspaceMissing') : baseName(where) || where}</span>
          </span>
          {runs > 0 ? (
            <span className="tkb-chip">
              <RotateCcw size={11} />
              <span className="txt">{t('ticket.runCount', { n: runs })}</span>
            </span>
          ) : null}
          {ticket.model !== '' ? (
            <span className="tkb-chip" title={ticket.model}>
              <Sparkles size={11} />
              <span className="txt">{ticket.model}</span>
            </span>
          ) : null}
          {attachmentsOf(ticket).length > 0 ? (
            <span
              className="tkb-chip"
              title={attachmentsOf(ticket)
                .map((item) => `${item.name} (${formatBytes(item.bytes)})`)
                .join('\n')}
            >
              <Paperclip size={11} />
              <span className="txt">{t('ticket.attach.count', { n: attachmentsOf(ticket).length })}</span>
            </span>
          ) : null}
          {ticket.origin.kind === 'source' ? (
            <span className="tkb-chip is-origin" title={t('ticket.inbox.originHint', { file: ticket.origin.file })}>
              <Inbox size={11} />
              <span className="txt">{t('ticket.inbox.origin', { source: ticket.origin.source })}</span>
            </span>
          ) : null}
          {/* The way back to where the drop came from (a PR, a commit). A
              separate chip rather than making the origin one clickable, so a
              click aimed at the card's menu or drag cannot open a browser. */}
          {ticket.origin.kind === 'source' && ticket.origin.url !== undefined ? (
            <button
              type="button"
              className="tkb-chip is-link"
              title={ticket.origin.url}
              aria-label={t('ticket.inbox.openLink', { url: ticket.origin.url })}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const url = ticket.origin.kind === 'source' ? ticket.origin.url : undefined;
                if (url !== undefined) void openUrl(url).catch(() => undefined);
              }}
            >
              <ExternalLink size={11} />
              <span className="txt">{t('ticket.inbox.link')}</span>
            </button>
          ) : null}
          <span className="tkb-avatar" title={t('ticket.requester')}>
            <User size={11} />
          </span>
          {connected ? <SessionDot status={rowStatus} /> : null}
        </div>

        {placeMissing ||
        !canBindBrief(ticket) ||
        (status === 'running' && !connected) ||
        runState === 'connecting' ||
        runState === 'awaiting_send' ||
        agentBusy ||
        oldRuntime ? (
          <div className="tkb-card-badges">
            {placeMissing ? <span className="badge badge-warning">{t('ticket.workspaceMissing')}</span> : null}
            {!canBindBrief(ticket) ? (
              <span className="badge badge-warning" title={t('ticket.btn.cannotStartHint')}>
                {t('ticket.tooLong')}
              </span>
            ) : null}
            {status === 'running' && !connected ? (
              <span className="badge badge-neutral" title={t('ticket.notConnectedHint')}>
                {t('ticket.notConnected')}
              </span>
            ) : null}
            {/* `running` is written when the session is opened, so these two say
                what the lane cannot: nothing is working yet. Both are read from
                the session, never written to the Ticket. */}
            {runState === 'connecting' ? (
              <span className="badge badge-neutral" title={t('ticket.run.connectingHint')}>
                {t('ticket.run.connecting')}
              </span>
            ) : null}
            {runState === 'awaiting_send' ? (
              <span className="badge badge-info" title={t('ticket.run.awaitingSendHint')}>
                {t('ticket.run.awaitingSend')}
              </span>
            ) : null}
            {agentBusy ? (
              <span className="badge badge-info" title={t('ticket.run.agentBusyHint')}>
                {t('ticket.run.agentBusy')}
              </span>
            ) : null}
            {oldRuntime ? (
              <span className="badge badge-warning" title={t('ticket.runtimeOldHint')}>
                {t('ticket.runtimeOld')}
              </span>
            ) : null}
          </div>
        ) : null}

        {cause === 'disconnected' || cause === 'crashed' || cause === 'unreachable' ? (
          <p className="tkb-card-note">
            <AlertTriangle size={12} />
            <span>
              {cause === 'disconnected'
                ? t('ticket.cause.disconnected')
                : cause === 'unreachable'
                  ? t('ticket.cause.unreachable')
                  : t('ticket.cause.crashed')}
            </span>
          </p>
        ) : null}

        {report !== null && asks ? (
          <div className="tkb-card-ask">
            <span className="tkb-ask-label">{t('ticket.asks')}</span> {report.question}
          </div>
        ) : report !== null && report.summary.trim() !== '' ? (
          <div className="tkb-card-text">{report.summary}</div>
        ) : ticket.brief.trim() !== '' ? (
          <div className="tkb-card-text is-brief">{ticket.brief}</div>
        ) : null}

        {/* The refusal sits directly above the buttons that produced it. */}
        {problem !== null ? (
          <p className="tkb-card-problem" role="alert">
            {problem}
          </p>
        ) : null}

        {feedbackOpen ? (
          <div className="tkb-sendback">
            <textarea
              className="cfg-textarea tkb-sendback-text"
              rows={3}
              autoFocus
              value={feedback}
              spellCheck={false}
              aria-label={t('ticket.btn.sendBackHint')}
              placeholder={t('ticket.btn.sendBackPlaceholder')}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setFeedbackOpen(false);
                } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && feedback.trim() !== '') {
                  e.preventDefault();
                  void act.sendBack();
                }
              }}
            />
            <div className="tkb-sendback-foot">
              <button type="button" className="btn btn-outline btn-compact" onClick={() => setFeedbackOpen(false)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-compact"
                disabled={cannotSessions || feedback.trim() === ''}
                onClick={() => void act.sendBack()}
              >
                <Undo2 size={12} />
                {t('ticket.btn.sendBackSend')}
              </button>
            </div>
          </div>
        ) : null}

        <div className="tkb-card-foot">
          <div className="tkb-card-actions">
            {actions.map((action) => {
              switch (action) {
                case 'start':
                  return (
                    <Tip key={action} label={cannotStart ? t('ticket.btn.cannotStartHint') : t('ticket.btn.startHint')}>
                      <button
                        type="button"
                        className="btn btn-primary btn-compact"
                        disabled={cannotSessions || cannotStart}
                        onClick={() => void act.start(false)}
                      >
                        <Play size={12} />
                        {t('ticket.btn.start')}
                      </button>
                    </Tip>
                  );
                case 'runNow':
                  return (
                    <Tip key={action} label={cannotStart ? t('ticket.btn.cannotStartHint') : t('ticket.btn.runNowHint')}>
                      <button
                        type="button"
                        className="btn btn-outline btn-compact"
                        disabled={cannotSessions || cannotStart}
                        onClick={() => void act.start(true)}
                      >
                        <Zap size={12} />
                        {t('ticket.btn.runNow')}
                      </button>
                    </Tip>
                  );
                case 'open':
                case 'continue':
                  return (
                    <Tip
                      key={action}
                      label={
                        runState === 'awaiting_send'
                          ? t('ticket.btn.sendBriefHint')
                          : !canGo
                            ? t('ticket.workspaceMissing')
                            : action === 'open'
                              ? t('ticket.btn.openHint')
                              : t('ticket.btn.continueHint')
                      }
                    >
                      <button
                        type="button"
                        // A parked brief is the one reason this button is the
                        // primary action of the card: the work is waiting on the
                        // person, and pressing Enter is all that is left.
                        className={`btn btn-compact ${
                          runState === 'awaiting_send' || (action === 'continue' && status === 'running')
                            ? 'btn-primary'
                            : 'btn-outline'
                        }`}
                        disabled={busy || !canGo}
                        onClick={() => void act.open()}
                      >
                        <ExternalLink size={12} />
                        {runState === 'awaiting_send'
                          ? t('ticket.btn.sendBrief')
                          : action === 'open'
                            ? t('ticket.btn.open')
                            : t('ticket.btn.continue')}
                      </button>
                    </Tip>
                  );
                case 'restart':
                  return (
                    <Tip key={action} label={cannotStart ? t('ticket.btn.cannotStartHint') : t('ticket.btn.restartHint')}>
                      <button
                        type="button"
                        className="btn btn-outline btn-compact"
                        disabled={cannotSessions || cannotStart}
                        onClick={() => void act.restart()}
                      >
                        <RotateCcw size={12} />
                        {t('ticket.btn.restart')}
                      </button>
                    </Tip>
                  );
                case 'accept':
                  return (
                    <Tip key={action} label={agentBusy ? t('ticket.btn.acceptBusyHint') : t('ticket.btn.acceptHint')}>
                      <button
                        type="button"
                        className="btn btn-primary btn-compact"
                        disabled={cannotSessions || agentBusy}
                        onClick={() => {
                          setProblem(null);
                          acceptTicket(ticket.id);
                        }}
                      >
                        <Check size={12} />
                        {t('ticket.btn.accept')}
                      </button>
                    </Tip>
                  );
                case 'sendBack':
                  return (
                    <Tip key={action} label={t('ticket.btn.sendBackHint')}>
                      <button
                        type="button"
                        className="btn btn-outline btn-compact"
                        disabled={cannotSessions || !(canGo || label !== null)}
                        aria-expanded={feedbackOpen}
                        onClick={() => setFeedbackOpen(!feedbackOpen)}
                      >
                        <Undo2 size={12} />
                        {t('ticket.btn.sendBack')}
                      </button>
                    </Tip>
                  );
                case 'reopen':
                  return (
                    <Tip key={action} label={t('ticket.btn.reopenHint')}>
                      <button
                        type="button"
                        className="btn btn-outline btn-compact"
                        disabled={cannotSessions}
                        onClick={() => {
                          setProblem(null);
                          dispatchTicket(ticket.id, { type: 'reopen' });
                        }}
                      >
                        <RotateCcw size={12} />
                        {t('ticket.btn.reopen')}
                      </button>
                    </Tip>
                  );
              }
            })}
          </div>
        </div>
      </article>

      {/* The housekeeping menu. Edit is always there; drop only on a status that
          can be given up; delete keeps the app's two-press arm, and `armed`
          resets when the menu closes, so a stray first press costs nothing. */}
      {menu !== null ? (
        <div
          className="tkb-menu-scrim"
          onClick={closeMenu}
          onContextMenu={(e) => {
            e.preventDefault();
            closeMenu();
          }}
        >
          <div
            className="tkb-menu"
            role="menu"
            aria-label={t('ticket.menu.title')}
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="tkb-menu-item"
              aria-label={t('ticket.btn.edit')}
              disabled={locked}
              onClick={() => {
                closeMenu();
                onEdit();
              }}
            >
              <Pencil size={13} />
              {t('ticket.menu.edit')}
            </button>
            {/* **The way back from a remembered answer.** Ticking "do this from
                now on" suppresses this dialog, so without an entry that always
                opens it, a remembered mode could never be changed — and the
                dialog's own hint would be pointing at a screen that no longer
                appears. Open tickets only: it is the card a start belongs to. */}
            {status === 'open' ? (
              <button
                type="button"
                role="menuitem"
                className="tkb-menu-item"
                title={t('ticket.menu.startOptionsHint')}
                disabled={cannotSessions || cannotStart}
                onClick={() => {
                  closeMenu();
                  onAskStart();
                }}
              >
                <Play size={13} />
                {t('ticket.menu.startOptions')}
              </button>
            ) : null}
            {canDrop(status) ? (
              <button
                type="button"
                role="menuitem"
                className="tkb-menu-item"
                title={t('ticket.btn.dropHint')}
                disabled={cannotSessions}
                onClick={() => {
                  closeMenu();
                  setProblem(null);
                  dropTicket(ticket.id);
                }}
              >
                <Ban size={13} />
                {t('ticket.btn.drop')}
              </button>
            ) : null}
            {/* **The keyboard and menu equal of the drag.** Dragging is a
                second way to say what a lane does, so it must never be the only
                one: these items come from the very table the drop consults, so
                the two cannot drift. Hidden when no lane would take the card
                (running, needs_you) — an item whose press can only refuse is
                worse than no item. */}
            {moveEntries.length > 0 ? (
              <>
                <span className="tkb-menu-sep" role="separator" />
                <span className="tkb-menu-label">{t('ticket.menu.move')}</span>
                {moveEntries.map(([column, drop]) => (
                  <button
                    key={column}
                    type="button"
                    role="menuitem"
                    className="tkb-menu-item"
                    disabled={cannotSessions}
                    onClick={() => {
                      closeMenu();
                      onMove(drop);
                    }}
                  >
                    <ArrowRight size={13} />
                    {drop.kind === 'begin'
                      ? t('ticket.menu.moveTo.running')
                      : t(`ticket.menu.moveTo.${column}` as TKey)}
                  </button>
                ))}
              </>
            ) : null}
            <Tip label={armed ? t('panel.task.deleteConfirm') : t('ticket.btn.delete')}>
              <button
                type="button"
                role="menuitem"
                className={`tkb-menu-item is-destructive${armed ? ' is-armed' : ''}`}
                aria-label={armed ? t('panel.task.deleteConfirm') : t('ticket.btn.delete')}
                disabled={locked}
                onClick={() => {
                  if (armed) {
                    closeMenu();
                    removeTicket(ticket.id);
                  } else {
                    // Arms, and stays up about it: the next press is the
                    // delete, and anything else closes the menu and disarms.
                    setArmed(true);
                  }
                }}
              >
                {armed ? <X size={13} /> : <Trash2 size={13} />}
                {armed ? t('panel.task.deleteConfirm') : t('ticket.menu.delete')}
              </button>
            </Tip>
          </div>
        </div>
      ) : null}
    </>
  );
}
