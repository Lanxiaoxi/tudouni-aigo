import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Check,
  CornerDownLeft,
  ExternalLink,
  Folder,
  Inbox,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  User,
  X,
  Zap,
} from 'lucide-react';
import { activeRuntime, activeWorkspaceOf, selectRowStatus, useApp } from '@/state/store';
import { selectTicketLiveKey } from '@/state/selectors/tickets';
import { useT } from '@/i18n/useT';
import type { TKey } from '@/i18n';
import { EmptyState, Tip } from '@/components/ui/kit';
import { SessionDot } from '@/components/sidebar/SessionDot';
import { ModelPicker, WorkspacePicker } from '@/components/panels/TaskPanel';
import { workspaceRefLabel, type TaskWorkspaceRef } from '@/task/tasks';
import { currentAssignment } from '@/ticket/machine';
import {
  TICKET_BRIEF_CEILING,
  TICKET_MIN_PROTOCOL,
  TICKET_TITLE_CEILING,
  ticketTitle,
  unbindableField,
  type Ticket,
  type TicketStatus,
} from '@/ticket/model';
import {
  canBindBrief,
  canDrop,
  canResumeAssignment,
  columnOf,
  groupTickets,
  needsYouCause,
  ticketActions,
  type TicketColumn,
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

interface FormValue {
  title: string;
  brief: string;
  workspace: TaskWorkspaceRef;
  model: string;
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

  /** The toolbar's status filter. `all` draws the four live lanes; anything
   *  else draws that one lane, full width, with a way back. */
  const [filter, setFilter] = useState<'all' | TicketColumn>('all');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

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
    return (
      <TicketCard
        key={ticket.id}
        ticket={ticket}
        label={labelOf(ticket.workspace)}
        remoteLabels={remoteLabels}
        remoteIds={remoteIds}
        locked={locked}
        onEdit={() => setEditingId(ticket.id)}
      />
    );
  }

  function renderLane(column: TicketColumn) {
    const single = filter !== 'all';
    const cards = cardsOf(column);
    const tone = LANE_TONE[column];
    return (
      <section
        key={column}
        className={`tkb-lane${single ? ' is-single' : ''}`}
        data-tone={tone}
        aria-label={t(`ticket.col.${column}` as TKey)}
      >
        <div className="tkb-lane-head">
          <span className={`tkb-lane-dot is-${tone}`} aria-hidden />
          <span className="tkb-lane-title">{t(`ticket.col.${column}` as TKey)}</span>
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

        {cards.length === 0 ? (
          <div className="tkb-lane-empty">
            <Inbox size={16} />
            <b>{t(LANE_EMPTY_TITLE[column])}</b>
            <span>{t(LANE_EMPTY_HINT[column])}</span>
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
          }}
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
        <div className="tkb-lanes scroll-fade">{columns.map(renderLane)}</div>
      )}
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
  disabled,
  localPaths,
  remoteLabels,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  mode: 'new' | 'edit';
  initial: FormValue;
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
   One card.
   ============================================================ */

function TicketCard({
  ticket,
  label,
  remoteLabels,
  remoteIds,
  locked,
  onEdit,
}: {
  ticket: Ticket;
  /** What the Ticket's workspace ref names today, or `null` when it names
   *  nothing this window knows (a forgotten bookmark, a deleted host). */
  label: string | null;
  remoteLabels: Map<string, string>;
  remoteIds: ReadonlySet<string>;
  locked: boolean;
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
        // and the card moves to Running by itself.
        if (key !== null && !runNow) closeBoard();
        return key !== null;
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

  return (
    <>
      <article
        className={`tkb-card${status === 'needs_you' ? ' is-needs' : ''}${status === 'review' ? ' is-review' : ''}${status === 'done' || status === 'dropped' ? ' is-finished' : ''}`}
        aria-labelledby={`tkb-title-${ticket.id}`}
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
          {ticket.origin.kind === 'source' ? (
            <span className="tkb-chip is-origin" title={t('ticket.inbox.originHint', { file: ticket.origin.file })}>
              <Inbox size={11} />
              <span className="txt">{t('ticket.inbox.origin', { source: ticket.origin.source })}</span>
            </span>
          ) : null}
          <span className="tkb-avatar" title={t('ticket.requester')}>
            <User size={11} />
          </span>
          {connected ? <SessionDot status={rowStatus} /> : null}
        </div>

        {placeMissing || !canBindBrief(ticket) || (status === 'running' && !connected) || oldRuntime ? (
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
                        !canGo
                          ? t('ticket.workspaceMissing')
                          : action === 'open'
                            ? t('ticket.btn.openHint')
                            : t('ticket.btn.continueHint')
                      }
                    >
                      <button
                        type="button"
                        className={`btn btn-compact ${action === 'continue' && status === 'running' ? 'btn-primary' : 'btn-outline'}`}
                        disabled={busy || !canGo}
                        onClick={() => void act.open()}
                      >
                        <ExternalLink size={12} />
                        {action === 'open' ? t('ticket.btn.open') : t('ticket.btn.continue')}
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
                    <Tip key={action} label={t('ticket.btn.acceptHint')}>
                      <button
                        type="button"
                        className="btn btn-primary btn-compact"
                        disabled={cannotSessions}
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
