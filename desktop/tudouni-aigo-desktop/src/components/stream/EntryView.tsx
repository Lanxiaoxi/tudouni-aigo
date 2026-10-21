import { memo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Boxes,
  Brain,
  Camera,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  FileCheck,
  GitFork,
  Info,
  Layers,
  Minus,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import { useTurnClock } from '@/hooks/useTurnClock';
import { copyText } from '@/utils/clipboard';
import { Badge, RiskTag } from '@/components/ui/kit';
import { Markdown } from '@/components/ui/Markdown';
import { InBlock } from './InBlock';
import { DeliverableCards } from './DeliverableCards';
import { charCount, type Entry, type FrontMessage } from '@/state/entries';
import type { TurnPhase } from '@/streamBlocks';
import { formatDuration, formatTokens, oneLine, tokPerSecond } from '@/utils/format';
import type { TKey } from '@/i18n';

/* ============================================================
   One entry, one branch. The twelve kinds are not merged —
   above all, a denial and a failure must be distinguishable at
   a glance (§2).
   ============================================================ */

/**
 * One row of the transcript, and the reason the stream does not slow down as
 * the conversation grows.
 *
 * **`memo`, and it is load-bearing rather than an optimisation.** Every delta
 * produces a new `entries` array and a new row list, so without this every row
 * of the transcript re-rendered on every chunk of every answer — and an `answer`
 * row renders `<Markdown>`, which re-parses its whole text and rebuilds its
 * element tree on each render. The cost of one chunk therefore grew with the
 * length of the conversation: measured, a streamed delta was ~10ms on an empty
 * session and ~100ms on one with 80 turns of history, with the store update
 * itself flat at ~0.04ms. That is the same defect the TUI front end carries a
 * render cache for (`internal/frontends/tui/transcript.go`, `markdownResults`),
 * and it is fixed at the same place: the boundary where a row's input stops
 * changing.
 *
 * It is safe because the reducer never edits an entry in place — every update
 * builds a new object (`entries.ts`, the `{ ...target, text: … }` spreads), so
 * an entry that did not change keeps its identity and the shallow prop compare
 * sees it. That in turn is what makes the parsing honest: `model_call` replaces
 * a streamed block with the complete text, and that *is* a new object, so the
 * row redraws.
 *
 * Note what this does **not** cut off: a row's own store subscriptions
 * (`toolOpen`, `reasoningOpen`, the quiet flag) still work, because zustand
 * notifies a subscribed component directly. `memo` only stops the parent from
 * re-rendering a row whose props are unchanged.
 *
 * The one row that does keep re-rendering is the one currently streaming, which
 * is the point.
 */
export const EntryView = memo(function EntryView({
  entry,
  phase = null,
}: {
  entry: Entry;
  /**
   * What a **turn head** says its body is doing, handed down by the section that
   * owns both (`StreamView`'s `TurnFold`, through `streamSections`).
   *
   * It is a prop rather than something the head works out for itself because it
   * is a fact about the head's *body*: computing it here would mean scanning the
   * transcript from every head, which is quadratic in the number of turns and
   * happens on every streamed chunk. Null on every other kind of row, and on a
   * head drawn without its section.
   */
  phase?: TurnPhase | null;
}) {
  switch (entry.kind) {
    case 'turn':
      return <TurnHead entry={entry} phase={phase} />;
    case 'user':
      return <UserEntry entry={entry} />;
    case 'model':
      return <ModelEntry entry={entry} />;
    case 'tool':
      return <ToolEntry entry={entry} />;
    case 'denied':
      return <DeniedEntry entry={entry} />;
    case 'batch':
      return <BatchEntry entry={entry} />;
    case 'perm':
      return <PermEntry entry={entry} />;
    case 'reason':
      return <ReasonEntry entry={entry} />;
    case 'answer':
      return <AnswerEntry entry={entry} />;
    case 'stream':
      return (
        <div className="e-stream" data-entry={entry.id}>
          {entry.text}
          {entry.streaming ? <span className="stream-caret" aria-hidden /> : null}
        </div>
      );
    case 'note':
      return <NoteRow entry={entry} />;
    case 'block':
      return <InBlock entry={entry} />;
    default:
      return null;
  }
});

/* ---------------- 1. turn head ---------------- */

/** `run_finished.stop_reason` -> copy. The distinctions are the ones a reader
 *  acts on, so they do not share a word. */
const STOP_KEY: Record<string, TKey> = {
  running: 'entry.turnRunning',
  answered: 'entry.turnDone',
  completed: 'entry.turnDone',
  max_steps: 'entry.turnStepLimit',
  cancelled: 'entry.turnInterrupted',
  model_error: 'entry.turnFailed',
  model_fatal: 'entry.turnFailed',
  empty_response: 'entry.turnEmpty',
};

/** What a running turn is doing, in the one word the folded head has room for. */
const PHASE_KEY: Record<TurnPhase, TKey> = {
  thinking: 'entry.turnPhaseThinking',
  model: 'entry.turnPhaseModel',
  tool: 'entry.turnPhaseTool',
  reply: 'entry.turnPhaseReply',
};

/**
 * The turn head: the number, how the turn stands, and its step, in one row.
 *
 * It is also **the control that folds the turn's work away** — the button on the
 * left is the only way in — and, folded, the row is the live status the middle of
 * a turn used to occupy: the badge says what the turn is doing right now
 * (`thinking · 4.2s`) or how it ended and how long that took, and the answer is
 * drawn below it like a chat message. What the fold removes is the thinking, the
 * model call cards and the tools, never the reply.
 *
 * The fold is the store's (`turnFolded`), like the tool and reasoning folds, so
 * the head and the work it hides cannot disagree: `StreamView` reads the same map
 * to put `is-collapsed` on the runs. The head keeps `data-anchor` in either
 * state, which is what keeps the turn rail able to land on a folded turn.
 */
function TurnHead({
  entry,
  phase,
}: {
  entry: Extract<Entry, { kind: 'turn' }>;
  phase: TurnPhase | null;
}) {
  const t = useT();
  const running = entry.status === 'running';
  const folded = useApp((s) => s.turnFolded[entry.id] === true);
  const toggleFold = useApp((s) => s.toggleTurnFold);
  // The live figure is on screen **only while folded**, so the clock ticks for
  // exactly that case: an expanded head has no number to advance, and a timer
  // behind it would repaint a running turn's row once a second to redraw nothing.
  const now = useTurnClock(running && folded);

  const tone = running
    ? 'success'
    : entry.status === 'model_error' || entry.status === 'model_fatal'
      ? 'destructive'
      : entry.status === 'answered' || entry.status === 'completed'
        ? 'neutral'
        : 'warning';

  const label = t(STOP_KEY[entry.status] ?? 'entry.turnDone');

  // The raw stop reason is shown only when the label does not already carry it.
  // `answered` and `completed` both map to "ended · completed", so printing the
  // raw value beside them would be noise on every ordinary turn — while a
  // `max_steps` or `cancelled` ending is exactly the thing a reader wants named.
  const rawIsInformative =
    !running && !['answered', 'completed'].includes(entry.status);

  /**
   * The figure beside the badge, and the only duration a turn may state:
   *
   *   - **while it runs**, this window's own clock against the stamp the reducer
   *     took at `run_started` — the runtime sends no duration until the turn
   *     ends, so a live number can only be measured here;
   *   - **once it ends**, `run_finished.duration_ms`, which the reducer keeps on
   *     this head. `null` is "nobody measured it" (the runtime went away, or a
   *     `run_finished` written without one) and is omitted rather than drawn as
   *     an em dash, which would read as a zero.
   */
  const elapsedMs = running
    ? folded
      ? Math.max(0, now - entry.startedAt)
      : null
    : entry.durationMs;

  // Folded, the badge becomes the summary the fold exists to leave behind:
  // what is happening now, or how it ended, and how long it took. Expanded, it
  // keeps saying only how the turn stands — the body says the rest.
  const badgeLabel = folded ? (running && phase !== null ? t(PHASE_KEY[phase]) : label) : label;
  const badgeDetail = folded && elapsedMs !== null ? formatDuration(elapsedMs) : null;

  return (
    // `data-anchor` is how the turn rail finds this row to scroll to it. It is
    // the **entry's id** rather than its ordinal or its index: quiet mode merges
    // tool rows into one `.quiet-rollup` row, so a child index is not an entry
    // index, and an ordinal is a display number (the one on the badge) rather
    // than an address. See `turnRail.ts` and `TurnRail.tsx`.
    <div className="turn-head" data-anchor={entry.id}>
      {/* A `<button>`, not the row, and that is the one place this head differs
          from the tool and reasoning heads. Those are `role="button"` rows
          because the whole row is theirs; this one is a heading whose text a
          reader may want to select, so the control is a real button beside it —
          focusable, announced with its state, and inert to a drag. */}
      <button
        type="button"
        className="caret th-fold"
        aria-expanded={!folded}
        aria-label={folded ? t('entry.turnUnfold') : t('entry.turnFold')}
        title={folded ? t('entry.turnUnfold') : t('entry.turnFold')}
        onClick={() => toggleFold(entry.id)}
      >
        <ChevronRight size={13} className={folded ? '' : 'caret-open'} />
      </button>
      <span className="th-num">{t('entry.turn', { n: entry.ordinal })}</span>
      <Badge tone={tone}>
        {badgeLabel}
        {/* A **running** turn's figure is hidden from the accessibility tree, and
            that is not an oversight: this row lives inside the transcript's
            `aria-live="polite"` log, so an announced counter would speak once a
            second for as long as a folded turn runs. The phase is the live fact;
            the seconds are for the eye. A settled turn's figure does not tick, so
            it stays announced like every other number in the row. */}
        {badgeDetail === null ? null : running ? (
          <span aria-hidden> · {badgeDetail}</span>
        ) : (
          ` · ${badgeDetail}`
        )}
      </Badge>
      {rawIsInformative ? <span className="faint caption mono">{entry.status}</span> : null}
      <span className="th-step">
        {t('status.step', { n: entry.step, max: entry.maxSteps })}
      </span>
    </div>
  );
}

/* ---------------- 2. user input ---------------- */

/**
 * The copy affordance drawn under both the user's bubble and the model's reply.
 *
 * It owns its own "copied" flag rather than lifting one to the row: the two rows
 * copy different text, and a shared flag would flash the check on a row nobody
 * clicked. The two names arrive as props because a screen reader should hear
 * what is being copied — a prompt and a reply are not the same thing.
 */
function CopyButton({
  text,
  copyLabel,
  copiedLabel,
}: {
  text: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  // Copies the text exactly as the runtime stored it, not the rendered row —
  // the same words plus whatever chrome the row grows.
  const onCopy = async () => {
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      className={`entry-copy${copied ? ' is-copied' : ''}`}
      aria-label={copied ? copiedLabel : copyLabel}
      title={copied ? copiedLabel : copyLabel}
      onClick={() => void onCopy()}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function UserEntry({ entry }: { entry: Extract<Entry, { kind: 'user' }> }) {
  const t = useT();
  return (
    // The second kind of rail anchor. A turn restored by `session_load` has no
    // `turn` head — the stored message list carries no turn boundary — so those
    // marks scroll to the prompt they are named after instead. The anchor sits on
    // the row rather than the bubble so the rail's landing offset applies to the
    // whole row, the way it does for `.turn-head`.
    //
    // `data-entry` stays on the bubble: the find layer's rule is that a row's
    // `data-entry` element **is** its own content container, and a prompt is the
    // one row shape shaped that way. The row is a column — the bubble, then the
    // copy button **under** it — so the button is outside the bubble and outside
    // the searched text.
    <div className="e-user-row" data-anchor={entry.id}>
      <div className="e-user" data-entry={entry.id}>
        {entry.text}
      </div>
      <CopyButton
        text={entry.text}
        copyLabel={t('entry.userCopy')}
        copiedLabel={t('entry.userCopied')}
      />
    </div>
  );
}

/* ---------------- 2b. model reply ---------------- */

/**
 * The fork affordance beside the reply's copy button: "start a new
 * conversation that continues from this reply."
 *
 * It names the reply by its own text plus `userBefore`, the number of user
 * rows drawn above it. Those two facts are what this row can state about
 * itself — the runtime's `Fork` matches on them and cuts on the turn
 * boundary the reply ends, so a mid-turn reply forks to the end of that
 * turn rather than leaving `tool_calls` without results.
 *
 * There is deliberately no optimistic UI: the screen changes when the
 * runtime's opening triple lands (the fork mounts its copy), and a refused
 * fork leaves the transcript exactly as it was, with the reason on the
 * notice line. That is the same no-optimistic-update rule the session
 * list's delete and archive keep.
 *
 * **Gated on the runtime's protocol number.** `session_fork` is a protocol
 * 7 message, and a runtime below it answers an unknown inbound message with
 * nothing at all — a silent no-op. A button that does that is a promise the
 * runtime behind it cannot keep (a remote workspace may run an older binary),
 * so the control is only drawn once the handshake says 7 or better.
 */
function ForkButton({
  text,
  userBefore,
  label,
}: {
  text: string;
  userBefore: number;
  label: string;
}) {
  const forkSession = useApp((s) => s.forkSession);
  // The number the runtime reported at handshake; 0 until it lands, which
  // gates the button off during the boot gap for free.
  const protocol = useSessionField((rt) => rt.session?.protocol ?? 0, 0);
  if (protocol < 7) return null;
  return (
    <button
      type="button"
      className="entry-fork"
      aria-label={label}
      title={label}
      onClick={() => forkSession(text, userBefore)}
    >
      <GitFork size={13} />
    </button>
  );
}

function AnswerEntry({ entry }: { entry: Extract<Entry, { kind: 'answer' }> }) {
  const t = useT();
  return (
    // The mirror of the user's row, on the other side and without a bubble: the
    // reply, then its buttons **under** it, flush with the text's own left
    // edge.
    //
    // `data-entry` stays on `.e-answer`, which is the find layer's
    // `.e-answer .md` container (`find/matches.ts`): a hit is found as an offset
    // into a row's text, and the only honest way back to a live `Text` node is an
    // attribute this front end writes down itself. The buttons are siblings, so
    // they are outside the searched text.
    <div className="e-answer-row">
      <div className="e-answer" data-entry={entry.id}>
        <Markdown text={entry.text} />
      </div>
      <span className="e-answer-actions">
        <CopyButton
          text={entry.text}
          copyLabel={t('entry.answerCopy')}
          copiedLabel={t('entry.answerCopied')}
        />
        <ForkButton
          text={entry.text}
          userBefore={entry.userBefore}
          label={t('entry.fork')}
        />
      </span>
    </div>
  );
}

/* ---------------- 3. model step ---------------- */

function ModelEntry({ entry }: { entry: Extract<Entry, { kind: 'model' }> }) {
  const t = useT();
  if (entry.retry) {
    return (
      <div className="e-model is-retry">
        <span className="em-rail" />
        <AlertTriangle size={12} />
        <span className="em-retry">{t('entry.modelRetry', { ms: entry.retry.waitMs })}</span>
      </div>
    );
  }

  const hasMetrics = entry.durationMs !== null || entry.inputTokens !== null;
  // The rate rides only where there is a measurement: no completion tokens (a
  // tool-only call) and no duration are the same statement — omit the figure
  // rather than print 0.0.
  const rate = tokPerSecond(entry.completionTokens, entry.durationMs);
  return (
    <div className="e-model">
      <span className="em-rail" />
      <Sparkles size={12} />
      <span>{t('entry.model')}</span>
      <span className="grow" />
      <span>
        {hasMetrics
          ? t('entry.modelMetrics', {
              ms: formatDuration(entry.durationMs),
              input: formatTokens(entry.inputTokens),
              cached: formatTokens(entry.cachedTokens),
            }) + (rate !== null ? ` · ${t('entry.modelOut', { n: rate })}` : '')
          : t('entry.modelNoMetrics')}
      </span>
    </div>
  );
}

/* ---------------- 4. tool call, with its result ---------------- */

function resultLabel(status: string, t: ReturnType<typeof useT>): string {
  if (status === 'ok') return t('entry.toolResultOk');
  if (status === 'invalid_args') return t('entry.toolResultInvalid');
  if (status === 'denied') return t('entry.toolResultDenied');
  if (status === 'interrupted') return t('entry.toolResultInterrupted');
  return t('entry.toolResultError');
}

function resultTone(status: string): 'success' | 'destructive' | 'warning' {
  if (status === 'ok') return 'success';
  if (status === 'denied') return 'warning';
  // Warning, not destructive: nothing went wrong. A stop is an outcome the person
  // asked for, and painting it like a failure would send them looking for a bug.
  if (status === 'interrupted') return 'warning';
  return 'destructive';
}

function ToolEntry({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }) {
  const t = useT();
  const open = useApp((s) => s.toolOpen[entry.id] === true);
  const toggleTool = useApp((s) => s.toggleTool);
  const elevated = entry.risk === 'medium' || entry.risk === 'high';
  // A declaration is the one tool result that is drawn **outside** the fold.
  //
  // That is the whole point of the tool: `present` produces no work to inspect —
  // no command, no diff, no output — and folding its result away would hide the
  // only thing it made. The cards are the result, so they sit under the row where
  // a reader already is, and the disclosure triangle still opens the call's
  // arguments for anyone checking what was declared.
  const files = entry.result?.deliverables ?? [];

  return (
    <div
      className={`e-tool${entry.risk === 'medium' ? ' is-medium' : ''}${
        entry.risk === 'high' ? ' is-high' : ''
      }${files.length > 0 ? ' has-deliverables' : ''}`}
    >
      <div
        className="et-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => toggleTool(entry.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleTool(entry.id);
          }
        }}
      >
        <ChevronRight size={13} className={`caret${open ? ' caret-open' : ''}`} />
        <span className="seq">{entry.index}</span>
        {files.length > 0 ? (
          <FileCheck size={12} color="var(--accent)" aria-hidden />
        ) : (
          <Wrench size={12} className="muted" />
        )}
        <span className="et-name">{entry.tool}</span>
        <span className="et-params">{entry.arguments ? oneLine(entry.arguments, 120) : ''}</span>

        {elevated && entry.risk ? <RiskTag level={entry.risk} /> : null}

        {entry.result ? (
          <Badge tone={resultTone(entry.result.status)} dot={false}>
            {resultLabel(entry.result.status, t)}
          </Badge>
        ) : null}

        {entry.result ? (
          <span>
            {t('entry.toolDuration', { ms: formatDuration(entry.result.durationMs) })}
            {entry.result.exitCode !== null
              ? ` · ${t('entry.toolExit', { n: entry.result.exitCode })}`
              : ''}
          </span>
        ) : null}
      </div>

      {files.length > 0 ? <DeliverableCards files={files} /> : null}

      {/* Kept mounted and folded, not conditionally rendered: an element that
          appears and disappears between frames has nothing to transition. The
          wrapper is *outside* `ToolBody` rather than inside it, because quiet
          mode reuses `ToolBody` and would otherwise get the fold too.
          `inert` while folded keeps this body out of the tab order as well as the
          accessibility tree — the tool body holds no controls today, but the
          reasoning body's neighbours do and the two must not differ in kind. */}
      <div className={`collapse${open ? '' : ' is-collapsed'}`} inert={!open}>
        <div>
          <ToolBody entry={entry} />
        </div>
      </div>
    </div>
  );
}

/**
 * The detail body. Quiet mode reuses it, since that mode already draws its own
 * one-line brief and must not repeat the card header.
 */
export function ToolBody({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }) {
  const t = useT();
  // No entrance animation of its own: the fold wrapper at the call site owns the
  // reveal, and this body is kept mounted, so a `reveal` here would fire once on
  // page load for every tool row and never again.
  return (
    <div className="e-tool-body">
      <div className="etb-label">{t('entry.params')}</div>
      <div className="terminal">{entry.arguments || '—'}</div>

      <div className="row caption" style={{ gap: 'var(--space-2)' }}>
        {/* Every one of these is a registry fact looked up by name, so an
            unanswered lookup reads "unknown" rather than defaulting to a
            comfortable value. */}
        <span className="faint">
          {entry.external === null
            ? t('entry.unknown')
            : entry.external
              ? t('entry.external')
              : t('entry.builtin')}
        </span>
        <span className="sep" />
        <span className="faint">{entry.risk ? t(`risk.${entry.risk}` as TKey) : t('entry.unknown')}</span>
        <span className="sep" />
        <span className="faint">
          {entry.parallelSafe === null
            ? t('entry.unknown')
            : `${entry.parallelSafe ? '✓' : '✗'} ${t('entry.parallelSafe')}`}
        </span>
        <span className="sep" />
        <span className="faint">
          {entry.interactive === null
            ? t('entry.unknown')
            : `${entry.interactive ? '✓' : '✗'} ${t('entry.occupiesInput')}`}
        </span>
      </div>

      {entry.result ? (
        <>
          <div className="etb-label">{t('entry.output')}</div>
          {/* The audit keeps a character count, not the body: a tool result is
              routinely hundreds of thousands of characters and copying it here
              would make the log a second copy of the conversation. What the
              runtime does send since the `preview` field is one flattened line
              from the head — enough to answer "what did it actually do"
              without the body. */}
          {entry.result.preview ? (
            <div className="terminal etb-preview">{entry.result.preview}</div>
          ) : null}
          <div className="terminal">
            <span className="tl-dim">
              {t('entry.toolChars', { n: formatTokens(entry.result.chars) })} ·{' '}
              {t('entry.toolDuration', { ms: formatDuration(entry.result.durationMs) })}
              {entry.result.exitCode !== null
                ? ` · ${t('entry.toolExit', { n: entry.result.exitCode })}`
                : ''}
              {entry.result.parallel ? ' · parallel' : ''}
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ---------------- 6. denial, its own row ---------------- */

function DeniedEntry({ entry }: { entry: Extract<Entry, { kind: 'denied' }> }) {
  const t = useT();
  return (
    <div className="e-denied">
      <Ban size={12} />
      <span className="seq">{entry.index}</span>
      <span className="mono">{entry.tool}</span>
      {/* The audit records the verdict, not a reason sentence, so the line says
          what is true rather than inventing a cause. */}
      <span className="ed-text">{t('entry.denied')}</span>
    </div>
  );
}

/* ---------------- 7. concurrent batch ---------------- */

function BatchEntry({ entry }: { entry: Extract<Entry, { kind: 'batch' }> }) {
  const t = useT();
  return (
    <div className="e-batch">
      <Boxes size={12} />
      <span>{t('entry.batch', { count: entry.calls, ms: entry.wallMs })}</span>
    </div>
  );
}

/* ---------------- 8. permission record ---------------- */

function PermEntry({ entry }: { entry: Extract<Entry, { kind: 'perm' }> }) {
  const t = useT();
  const tone =
    entry.outcome === 'user_denied' || entry.outcome === 'policy_denied'
      ? 'destructive'
      : entry.outcome === 'autopilot' || entry.outcome === 'auto_allowed'
        ? 'warning'
        : 'success';

  // The outcome is the fact; `decision` is only the gate's verdict.
  const outcomeLabel =
    entry.outcome === 'autopilot'
      ? t('entry.permAuto')
      : entry.outcome === 'user_denied'
        ? t('perm.action.deny')
        : entry.outcome === 'rule_allowed' ||
            entry.outcome === 'command_allowed' ||
            entry.outcome === 'approved'
          ? t('perm.action.allow')
          : entry.outcome || entry.decision;

  return (
    <div className="e-perm">
      <ShieldCheck size={12} />
      <span>{t('entry.perm')}</span>
      <Badge tone={tone} dot={false}>
        {outcomeLabel}
      </Badge>
      <span className="mono">{entry.tool}</span>
      {/* `waited_ms` is present only when a person was actually asked — a
          verdict is written for every call. Its absence is the signal. */}
      <span className="faint">
        {entry.waitedMs !== null
          ? t('entry.permWaited', { ms: formatDuration(entry.waitedMs) })
          : t('entry.permNoWait')}
      </span>
      {entry.rule ? (
        <span className="ep-rule">{t('entry.permRule', { rule: entry.rule })}</span>
      ) : entry.remembered.length > 0 ? (
        <span className="ep-rule">
          {t('entry.permRemembered', { rules: entry.remembered.join(', ') })}
        </span>
      ) : null}
    </div>
  );
}

/* ---------------- 9. reasoning block, folded by default ---------------- */

function ReasonEntry({ entry }: { entry: Extract<Entry, { kind: 'reason' }> }) {
  const t = useT();
  const quiet = useSessionField((rt) => rt.quiet, false);
  const manual = useApp((s) => s.reasoningOpen[entry.id]);
  const toggle = useApp((s) => s.toggleReasoning);
  // While streaming it is forced open and updates live; once the stream stops it
  // returns to the person's own choice, which defaults to folded.
  //
  // **Quiet is the exception, and that is the whole point of the mode.** Quiet
  // mode folds tool calls into a one-line brief so a long turn stays readable,
  // and a block that opens itself the moment the model starts thinking puts a
  // wall of text back on screen — the one thing the mode exists to prevent. The
  // TUI folds its thinking line in quiet mode for exactly this reason
  // (`internal/frontends/tui/view.go`, `thinkingFolded`), and the two front ends
  // are meant to read the same.
  //
  // The forced-open rule stays for normal mode: there, watching the reasoning
  // arrive line by line is the point. Under quiet, a person who *does* want to
  // read it still can — `Ctrl+T`, or a press on the head — because the manual
  // choice is consulted in both modes.
  const open = quiet ? manual === true : entry.streaming ? true : manual === true;

  return (
    // `data-entry` marks the **row**, not the body: the body is inside the fold
    // below, and a jump has to be able to walk up from a hit to the row it is
    // drawn in (see `find/engine.ts`).
    <div className="e-reason" data-entry={entry.id}>
      <div
        className="er-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => toggle(entry.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle(entry.id);
          }
        }}
      >
        <ChevronRight size={13} className={`caret${open ? ' caret-open' : ''}`} />
        <Brain size={12} />
        <span>
          {entry.streaming
            ? t('entry.reasonLive', { n: charCount(entry.text) })
            : t('entry.reasonCollapsed', { n: charCount(entry.text) })}
        </span>
        <span className="er-count">Ctrl T</span>
      </div>

      {/* Same kept-mounted fold as the tool body above. The reasoning text is the
          one that benefits most: it is forced open while streaming and folds when
          the stream stops, so the transition is what makes "it just collapsed"
          legible rather than looking like the text vanished. */}
      <div className={`collapse${open ? '' : ' is-collapsed'}`} inert={!open}>
        <div>
          <div className="e-reason-body scroll-fade">{entry.text}</div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 12. attached / system rows ---------------- */

/**
 * The colour a note's tone earns it, where it has one of its own.
 *
 * `warn` and `error` used to be missing from this list, so a failure was drawn in
 * the same `--fg-faint` grey as every ordinary notice around it: the icon changed
 * and nothing else did. That is worst exactly where notes cluster — a
 * `subagent problem` row landed between two "started/finished" rows that looked
 * identical to it. The two colours are the ones the design system gives the same
 * meanings everywhere else (`component-states.md`, the badge mapping).
 */
const NOTE_TONE_CLASS: Record<string, string> = {
  degraded: ' is-degraded',
  compacted: ' is-compacted',
  image: ' is-image',
  warn: ' is-warn',
  error: ' is-error',
};

/**
 * Exported because the first screen renders notices too: they are session
 * content, and the design is explicit that the first screen must not squeeze
 * them out. One implementation, so the two places cannot drift.
 */
export function NoteRow({ entry }: { entry: Extract<Entry, { kind: 'note' }> }) {
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

  const cls = NOTE_TONE_CLASS[entry.tone] ?? '';

  return (
    <div className={`e-note${cls}`} data-code={entry.code}>
      {icon}
      {/* **Two sources, and they are not interchangeable.** A runtime notice
          carries the runtime's own sentence and is displayed verbatim —
          translating it would invent a second source for the same fact. A
          sentence *this window* is saying arrives as a code (`entry.message`)
          and is worded here, from i18n, because the store has no business
          holding English.

          Exactly one of the two is set; the fallback order is what makes a note
          with neither render as nothing rather than as a blank row that looks
          like a layout bug. */}
      <span className="en-text">
        {entry.message ? frontMessageText(t, entry.message) : entry.text}
      </span>
    </div>
  );
}

/**
 * One sentence this front end is saying, as words.
 *
 * A function with an exhaustive `switch` and no `default`, like
 * `Composer.tsx`'s `noticeText`: a new code has to be given a sentence, and the
 * exhaustiveness check is what enforces that rather than a fallback that would
 * print an empty row.
 */
export function frontMessageText(
  t: ReturnType<typeof useT>,
  message: FrontMessage,
): string {
  switch (message.code) {
    case 'terminalEnded':
      // The three endings stay three sentences. `killed` is not "exited with
      // code null": a killed shell did not choose an exit status, so printing a
      // number for it would invent one.
      if (message.reason === 'killed') return t('note.term.endedKilled', { id: message.id });
      if (message.exitCode === null) return t('note.term.ended', { id: message.id });
      return t('note.term.endedCode', { id: message.id, code: message.exitCode });
    case 'terminalDetached':
      return t('note.term.detached', { id: message.id });
    case 'refineApplied':
      // Zero is the honest outcome of an answer that named nothing
      // recognisable, and it gets its own sentence: "1 applied" with zero
      // chosen would be a report the transcript contradicts.
      if (message.applied === 0) return t('note.refine.appliedNone');
      return t('note.refine.applied', { n: message.applied });
  }
}
