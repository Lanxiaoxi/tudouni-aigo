import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  Undo2,
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
} from '@/ticket/model';
import {
  TICKET_COLUMNS,
  canBindBrief,
  canDrop,
  canResumeAssignment,
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

/** The column head's dot: the session board's palette, one class per column.
 *  Explicit classes rather than a computed name so the class audit sees them. */
function columnDotClass(column: TicketColumn): string {
  switch (column) {
    case 'running':
      return 'is-running';
    case 'needs_you':
      return 'is-asking';
    case 'review':
      return 'is-unseen';
    default:
      return 'is-idle';
  }
}

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

  /** The new-Ticket form is remounted (new `key`) to reset it or to take a
   *  seed; its text lives in the form, so nothing is stored for it here. */
  const [fresh, setFresh] = useState<{ key: number; initial: FormValue }>(() => ({ key: 0, initial: blank('') }));
  /** Where a seeded brief came from, so creating the Ticket can empty that
   *  composer (only if it still holds the text - `clearDraftIf`). */
  const seedOrigin = useRef<{ draftOf: string; seed: string } | null>(null);
  useEffect(() => {
    if (ticketSeed === null) return;
    seedOrigin.current = ticketSeed.draftOf === null ? null : { draftOf: ticketSeed.draftOf, seed: ticketSeed.brief };
    setFresh((prev) => ({ key: prev.key + 1, initial: blank(ticketSeed.brief) }));
    setEditingId(null);
    clearTicketSeed();
    // `blank` closes over the screen's remote id; the seed is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketSeed, clearTicketSeed]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = editingId === null ? null : (tickets.find((row) => row.id === editingId) ?? null);

  const groups = useMemo(() => groupTickets(tickets), [tickets]);
  const [showDone, setShowDone] = useState(false);
  const [showDropped, setShowDropped] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const finished = groups.done.length + groups.dropped.length;

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
    setFresh((prev) => ({ key: prev.key + 1, initial: blank('') }));
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
        <Tip label={t('board.closeHint')}>
          <button type="button" className="lb-icon" aria-label={t('board.close')} onClick={() => setBoard(null)}>
            <X size={15} />
          </button>
        </Tip>
      </header>

      {readOnly ? (
        <p className="tkb-problem" role="alert">
          {t('ticket.readOnly', { reason: readOnlyReason ?? '' })}
        </p>
      ) : null}

      <div className="tkb-newwrap">
        {editing !== null ? (
          <TicketForm
            key={`edit-${editing.id}`}
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
        ) : (
          <TicketForm
            key={`new-${fresh.key}`}
            mode="new"
            initial={fresh.initial}
            disabled={locked}
            localPaths={localPaths}
            remoteLabels={remoteLabels}
            onSubmit={create}
            onCancel={null}
          />
        )}
      </div>

      {!loaded ? (
        <div className="board-loading">{t('ticket.loading')}</div>
      ) : tickets.length === 0 ? (
        <EmptyState title={t('ticket.empty.title')} hint={t('ticket.empty.hint')} />
      ) : (
        <div className="board-cols scroll-fade">
          {TICKET_COLUMNS.map((column) => {
            const isDone = column === 'done';
            const cards = isDone ? (showDone ? groups.done : []) : groups[column];
            const count = isDone ? finished : groups[column].length;
            const renderCard = (ticket: Ticket) => (
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
            return (
              <section
                key={column}
                className={`board-col${isDone && !showDone ? ' tkb-col-folded' : ''}`}
                aria-label={t(`ticket.col.${column}`)}
              >
                <div className="board-col-head">
                  <span className={`board-col-dot ${columnDotClass(column)}`} aria-hidden />
                  <span className="board-col-title">{t(`ticket.col.${column}`)}</span>
                  {isDone ? (
                    <>
                      <Tip label={showDone ? t('ticket.col.hide') : t('ticket.col.show')}>
                        <button
                          type="button"
                          className="lb-icon"
                          aria-expanded={showDone}
                          aria-label={showDone ? t('ticket.col.hide') : t('ticket.col.show')}
                          onClick={() => setShowDone(!showDone)}
                        >
                          {showDone ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                      </Tip>
                      {finished > 0 ? (
                        <Tip label={clearArmed ? t('ticket.clearFinishedConfirm', { n: finished }) : t('ticket.clearFinishedHint')}>
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
                            {clearArmed ? t('ticket.clearFinishedConfirm', { n: finished }) : t('ticket.clearFinished')}
                          </button>
                        </Tip>
                      ) : null}
                    </>
                  ) : null}
                  <span className="board-col-count">{count}</span>
                </div>

                {cards.map(renderCard)}

                {isDone && showDone && groups.dropped.length > 0 ? (
                  <>
                    <button
                      type="button"
                      className="tkb-fold"
                      aria-expanded={showDropped}
                      onClick={() => setShowDropped(!showDropped)}
                    >
                      {showDropped ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      {t('ticket.dropped')}
                      <span className="tkb-fold-count">{groups.dropped.length}</span>
                    </button>
                    {showDropped ? groups.dropped.map(renderCard) : null}
                  </>
                ) : null}

                {cards.length === 0 && !(isDone && !showDone) ? (
                  <div className="board-col-empty">{t('ticket.col.empty')}</div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   The form: new Ticket and edit Ticket are one control.
   ============================================================ */

function TicketForm({
  mode,
  initial,
  disabled,
  localPaths,
  remoteLabels,
  onSubmit,
  onCancel,
}: {
  mode: 'new' | 'edit';
  initial: FormValue;
  disabled: boolean;
  localPaths: string[];
  remoteLabels: Map<string, string>;
  /** `true` when it took (a refused create keeps the typing). */
  onSubmit: (value: FormValue) => boolean;
  /** Edit only: a new-Ticket box has nothing to cancel. */
  onCancel: (() => void) | null;
}) {
  const t = useT();
  const [value, setValue] = useState<FormValue>(initial);
  // Editing shows every field: it is the only way to reach the workspace and
  // the model of an existing Ticket. A new Ticket is one box until asked.
  const [open, setOpen] = useState(mode === 'edit');
  const taRef = useRef<HTMLTextAreaElement>(null);
  // The one limit a person can hit by pasting: `ticket_bind` carries the brief,
  // the runtime refuses an oversized one, and the Ticket would then say Running
  // with no report tool behind it. Said here, while the text is still in the
  // box, rather than after a Start that could not have worked.
  const tooLong = unbindableField({ title: value.title, brief: value.brief });
  const canSubmit = !disabled && value.brief.trim() !== '' && tooLong === null;

  useEffect(() => {
    // A seeded box takes the caret at the end; a plain one stays out of the way.
    if (mode === 'edit' || initial.brief !== '') {
      const el = taRef.current;
      if (el === null) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [mode, initial.brief]);

  function submit(): void {
    if (!canSubmit) return;
    // Cleared by the parent's remount on success; a refusal leaves the text.
    onSubmit(value);
  }

  return (
    <form
      className="tkb-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        // Esc leaves the edit instead of the board: the person is in a form
        // whose fields would be thrown away with the view.
        if (e.key === 'Escape' && onCancel !== null) {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      {mode === 'edit' ? <div className="tkb-form-title">{t('ticket.edit.title')}</div> : null}
      <textarea
        ref={taRef}
        className="cfg-textarea tkb-brief"
        rows={mode === 'edit' ? 6 : 3}
        value={value.brief}
        spellCheck={false}
        disabled={disabled}
        aria-label={t('ticket.field.brief')}
        placeholder={t('ticket.new.placeholder')}
        onChange={(e) => setValue({ ...value, brief: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {tooLong !== null ? (
        <p className="tkb-form-rule" role="alert">
          {tooLong === 'brief'
            ? t('ticket.limit.brief', { n: TICKET_BRIEF_CEILING })
            : t('ticket.limit.title', { n: TICKET_TITLE_CEILING })}
        </p>
      ) : null}
      {open ? (
        <div className="tkb-details">
          <label className="cfg-field">
            <span className="cfg-label">
              {t('ticket.field.title')} <span className="cfg-optional">{t('panel.task.optional')}</span>
            </span>
            <input
              className="cfg-input"
              value={value.title}
              spellCheck={false}
              disabled={disabled}
              placeholder={t('ticket.field.titlePlaceholder')}
              onChange={(e) => setValue({ ...value, title: e.target.value })}
            />
          </label>
          <label className="cfg-field">
            <span className="cfg-label">{t('panel.task.field.workspace')}</span>
            <WorkspacePicker
              value={value.workspace}
              localPaths={localPaths}
              remoteLabels={remoteLabels}
              onChange={(workspace) => setValue({ ...value, workspace })}
            />
          </label>
          <label className="cfg-field">
            <span className="cfg-label">
              {t('panel.task.field.model')} <span className="cfg-optional">{t('panel.task.optional')}</span>
            </span>
            <ModelPicker value={value.model} onChange={(model) => setValue({ ...value, model })} />
          </label>
        </div>
      ) : null}
      <div className="tkb-form-foot">
        {mode === 'new' ? (
          <button type="button" className="btn btn-ghost btn-compact" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {t('ticket.new.details')}
          </button>
        ) : (
          <span className="tkb-form-note">{t('ticket.edit.hint')}</span>
        )}
        <span className="grow" />
        {mode === 'new' ? <span className="tkb-form-note">{t('ticket.new.hint')}</span> : null}
        {onCancel !== null ? (
          <button type="button" className="btn btn-outline btn-compact" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        ) : null}
        <button type="submit" className="btn btn-primary btn-compact" disabled={!canSubmit}>
          {mode === 'new' ? <Plus size={12} /> : <Check size={12} />}
          {mode === 'new' ? t('ticket.new.create') : t('ticket.edit.save')}
        </button>
      </div>
    </form>
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
  // the columns can be several screens from the card whose Start failed 鈥?and
  // the next press anywhere cleared it, which is what made it unreadable rather
  // than merely misplaced.
  const [problem, setProblem] = useState<string | null>(null);

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
    <article
      className={`tkb-card${status === 'needs_you' ? ' is-needs' : ''}${status === 'review' ? ' is-review' : ''}${status === 'done' || status === 'dropped' ? ' is-finished' : ''}`}
    >
      <div className="tkb-card-top">
        <span className="tkb-card-title" title={ticketTitle(ticket)}>
          {ticketTitle(ticket) || t('ticket.untitled')}
        </span>
        {connected ? <SessionDot status={rowStatus} /> : null}
      </div>

      <div className="tkb-card-meta">
        <span className="tkb-card-where" title={where ?? undefined}>
          {where === null ? t('ticket.workspaceMissing') : baseName(where) || where}
        </span>
        {runs > 0 ? (
          <>
            <span aria-hidden>路</span>
            <span>{t('ticket.runCount', { n: runs })}</span>
          </>
        ) : null}
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
        <div className="tkb-card-cause">
          {cause === 'disconnected'
            ? t('ticket.cause.disconnected')
            : cause === 'unreachable'
              ? t('ticket.cause.unreachable')
              : t('ticket.cause.crashed')}
        </div>
      ) : null}

      {report !== null ? (
        asks ? (
          <div className="tkb-card-text is-ask">
            <span className="tkb-card-ask">{t('ticket.asks')}</span> {report.question}
          </div>
        ) : report.summary.trim() !== '' ? (
          <div className="tkb-card-text">{report.summary}</div>
        ) : null
      ) : ticket.title.trim() !== '' ? (
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

        <span className="grow" />

        <Tip label={t('ticket.btn.edit')}>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={t('ticket.btn.edit')} onClick={onEdit}>
            <Pencil size={13} />
          </button>
        </Tip>
        {canDrop(status) ? (
          <Tip label={t('ticket.btn.dropHint')}>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={t('ticket.btn.drop')}
              disabled={cannotSessions}
              onClick={() => {
                setProblem(null);
                dropTicket(ticket.id);
              }}
            >
              <Ban size={13} />
            </button>
          </Tip>
        ) : null}
        {/* Delete keeps the app's two-press arm; leaving the button disarms. */}
        <Tip label={armed ? t('panel.task.deleteConfirm') : t('ticket.btn.delete')}>
          <button
            type="button"
            className={`btn btn-ghost btn-icon${armed ? ' is-armed' : ''}`}
            aria-label={armed ? t('panel.task.deleteConfirm') : t('ticket.btn.delete')}
            disabled={locked}
            onBlur={() => setArmed(false)}
            onMouseLeave={() => setArmed(false)}
            onClick={() => {
              if (armed) removeTicket(ticket.id);
              else setArmed(true);
            }}
          >
            <Trash2 size={13} />
          </button>
        </Tip>
      </div>
    </article>
  );
}
