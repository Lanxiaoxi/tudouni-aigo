import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { useT } from '@/i18n/useT';
import { activeMark, HEADING_BAND_PX, type RailTurn } from '@/turnRail';

/**
 * The transcript's turn rail: one dash per turn down the right edge, each a jump
 * target, with the prompt and the answer on hover.
 *
 * ### It is a lane, not an overlay
 *
 * The rail is a flex item beside the transcript (`StreamView` puts both in
 * `.stream-body`), not something floated over it. An overlay would have to be
 * positioned in the gutter the centred transcript leaves, and that gutter
 * disappears the moment the window is narrow or a rail is widened — at which
 * point the dashes sit **on the text**. Reserving the lane instead makes the
 * collision impossible rather than unlikely: it costs 36px of transcript width
 * and needs no breakpoint, no `:has`, and no assumption about how wide the rails
 * are today. The measured alternative is in `stream.css`.
 *
 * ### What follows what
 *
 * Three pieces of state, and each has one owner:
 *
 *   - **which turn the reader is in** — measured from the transcript's own scroll
 *     position, because that is the only thing that knows;
 *   - **which mark the pointer or the keyboard is on** — the rail's own, and it
 *     wins over the first while it is set;
 *   - **where the rail itself is scrolled** — only so the hover card can be
 *     positioned against the mark it belongs to.
 *
 * ### Why the marks are `memo`'d on primitives
 *
 * `turnRail` rebuilds its array on every change to `entries`, and during
 * streaming that is every chunk. Every `RailTurn` object is therefore new each
 * time, so a mark that took the object as a prop would re-render all N of them
 * per chunk — on a session where `app.css` measures one chunk at 1.2ms of layout
 * for the whole transcript. Passing the fields separately is what lets `memo`
 * bail out on every mark but the one that is actually streaming.
 */

/** Fixed pitch between neighbouring marks, in px. */
const PITCH = 10;
/** The marks box's own vertical padding, so the ends do not touch the frame. */
const INSET = 2;
/** The tallest the frame gets, before its marks scroll inside it. */
const MAX_FRAME_PX = 420;

/** The height the marks box needs. */
const marksHeight = (count: number): number => count * PITCH + INSET * 2;
/** Where a mark's centre sits inside the marks box. */
const markCentre = (index: number): number => INSET + index * PITCH + PITCH / 2;

interface MarkProps {
  index: number;
  anchor: string;
  /** The turn's own number, for the accessible name. */
  n: number;
  running: boolean;
  active: boolean;
  previewing: boolean;
  /** The one tab stop. */
  tabbable: boolean;
  previewId: string;
  onJump: (anchor: string) => void;
  onHover: (index: number) => void;
  onEnter: (index: number) => void;
  onLeave: () => void;
  register: (index: number, el: HTMLButtonElement | null) => void;
}

const TurnMark = memo(function TurnMark({
  index,
  anchor,
  n,
  running,
  active,
  previewing,
  tabbable,
  previewId,
  onJump,
  onHover,
  onEnter,
  onLeave,
  register,
}: MarkProps) {
  const t = useT();
  return (
    <button
      ref={(el) => register(index, el)}
      type="button"
      className={`turn-rail-mark${active ? ' is-active' : ''}${running ? ' is-running' : ''}${
        previewing ? ' is-preview' : ''
      }`}
      style={{ top: `${INSET + index * PITCH}px` }}
      tabIndex={tabbable ? 0 : -1}
      aria-label={t('rail.jump', { n })}
      aria-current={active ? 'true' : undefined}
      // The running mark breathes, and this is the reason `component-states.md` §0
      // keeps a carve-out for it: "a turn is in flight right now" is a continuing
      // condition, not a state flip. The colour and the accessible name carry it
      // too, so the animation is never the only signal.
      aria-busy={running ? 'true' : undefined}
      aria-describedby={previewing ? previewId : undefined}
      onPointerMove={() => onHover(index)}
      onFocus={() => onEnter(index)}
      onBlur={onLeave}
      onClick={() => onJump(anchor)}
    />
  );
});

export function TurnRail({
  turns,
  scrollRef,
}: {
  turns: RailTurn[];
  /** The transcript's scroll container — what a mark navigates. */
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const [active, setActive] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [railScroll, setRailScroll] = useState(0);
  const [railViewport, setRailViewport] = useState(0);

  const scroller = useRef<HTMLDivElement | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const pointerInside = useRef(false);
  /**
   * The anchor rows, by entry id. Rebuilt when the mark set changes rather than
   * on every scroll: during streaming the transcript's `entries` array is new on
   * every chunk, so a rebuild keyed on it would run a `querySelectorAll` and a
   * rect read per chunk — the exact shape of the defect `app.css` measures at
   * 14ms.
   */
  const anchors = useRef(new Map<string, HTMLElement>());
  /** The marks as last rendered, for the callbacks that must not re-bind. */
  const latest = useRef(turns);
  const previewId = useId();

  useEffect(() => {
    latest.current = turns;
  });

  /** The transcript's anchor rows, by entry id. */
  const indexAnchors = (root: HTMLElement): Map<string, HTMLElement> => {
    const index = new Map<string, HTMLElement>();
    for (const el of root.querySelectorAll<HTMLElement>('[data-anchor]')) {
      const id = el.dataset.anchor;
      if (id !== undefined) index.set(id, el);
    }
    return index;
  };

  const measure = useCallback(() => {
    const root = scrollRef.current;
    if (root === null) return;
    // Self-repair, and it is not belt-and-braces: the map is rebuilt when the
    // mark set's signature moves, and a signature can always be one change
    // behind the DOM — that is what `marks` below documents. `Map.has` costs
    // nothing next to the rect reads that follow, and a *missing* entry is not a
    // small error here: `offset` becomes `Infinity`, the turn is never counted as
    // scrolled past, and the rail quietly highlights the turn before the reader's.
    let index = anchors.current;
    if (latest.current.some((turn) => !index.has(turn.anchor))) {
      index = indexAnchors(root);
      anchors.current = index;
    }
    const origin = root.getBoundingClientRect().top;
    const offsets = latest.current.map((turn) => {
      const el = index.get(turn.anchor);
      return el === undefined ? Number.POSITIVE_INFINITY : el.getBoundingClientRect().top - origin;
    });
    const next = activeMark(offsets, HEADING_BAND_PX);
    setActive((current) => (current === next ? current : next));
  }, [scrollRef]);

  /**
   * The mark set's identity: how many, and where they begin **and end**.
   *
   * Growth shows up in the count and a wholesale replacement — `session_load`
   * rebuilds every row with a fresh id — shows up at the front. The last anchor
   * is the one that is easy to leave out and the one that actually bit: a live
   * turn is anchored on its **echo** until its head arrives (`turnRail.ts`), and
   * that swap changes neither the count nor the first anchor. With only the first
   * two fields the signature stood still across the swap, the map was never
   * rebuilt, and the turn the reader was *in* — the one that had just started —
   * was the one missing from it. Measured in `scripts/turn-rail-check.mjs`: with
   * 60 turns, the last mark's id was absent from the map, `measure` read it as
   * `Infinity`, and the rail highlighted turn 59 while the transcript was parked
   * on turn 60.
   *
   * Nothing during streaming moves any of the three, which is what keeps the
   * rebuild off the chunk path.
   */
  const marks =
    turns.length === 0
      ? ''
      : `${turns.length}:${turns[0]?.anchor ?? ''}:${turns[turns.length - 1]?.anchor ?? ''}`;

  useEffect(() => {
    const root = scrollRef.current;
    if (root !== null) anchors.current = indexAnchors(root);
    measure();
  }, [marks, measure, scrollRef]);

  useEffect(() => {
    const root = scrollRef.current;
    if (root === null) return;
    // Coalesced to one read per frame: the transcript fires a scroll event per
    // frame while it is being scrolled, and this reads a rect per turn.
    let frame = 0;
    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    root.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      root.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [measure, scrollRef]);

  useEffect(() => {
    const el = scroller.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setRailViewport(el.clientHeight));
    observer.observe(el);
    setRailViewport(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Keep the reader's own turn inside the frame. Instant rather than smooth: this
  // follows a scroll, and `component-states.md` §0 bans an animation that chases
  // the reader's position. It is a different scroller from the transcript, so
  // nothing here moves under the pointer — except when the pointer is on the rail
  // itself, which is why that case is skipped rather than merely unlikely.
  useEffect(() => {
    const el = scroller.current;
    if (el === null || active === null || pointerInside.current) return;
    const viewport = el.clientHeight;
    const total = marksHeight(turns.length);
    if (viewport <= 0 || total <= viewport) return;
    const target = Math.max(0, Math.min(total - viewport, markCentre(active) - viewport / 2));
    if (Math.abs(el.scrollTop - target) < 1) return;
    el.scrollTop = target;
  }, [active, turns.length]);

  /**
   * Scroll the transcript to a mark's row.
   *
   * `scrollIntoView` rather than arithmetic on `offsetTop`: every transcript row
   * carries `content-visibility: auto` (`app.css`), so a row nobody has scrolled
   * past contributes an **estimate** rather than its real height, and adding up
   * `offsetTop` would be arithmetic on numbers that are known to be
   * approximations.
   *
   * **`scrollIntoView` alone is not enough either, and this is the measurement
   * `app.css` says it was waiting for.** That comment rejects "re-assert the
   * scroll on the next frame" for the *follow* path, correctly: the follow writes
   * `scrollTop = scrollHeight`, which the estimate cannot disturb (measured, 0px
   * gap over 150 chunks). A jump is the other case, and the estimate breaks it
   * outright: when the rows past the viewport have never been seen, their 120px
   * fallback makes the document **shorter than it is**, so the target's position
   * clamps at the current bottom and the jump lands short — `scripts/turn-rail-check.mjs`
   * measured a click on the last mark of a 60-turn session leaving its turn head
   * **15,561px below the top**, with the transcript not moving at all from the
   * previous jump. Re-aiming in a loop does not fix it: `scrollIntoView` is
   * compositor-async, so every pass in the same task reads the same pre-scroll
   * position, and the rows that would have to be laid out to extend the document
   * are the ones still off screen. Re-aiming on the next frame does not fix it
   * either — one frame lays out one viewport, so a long jump would need one frame
   * per screen of history.
   *
   * So the estimate is lifted for the length of the jump instead: `is-landing`
   * turns `content-visibility` off for the transcript's rows, the forced read
   * below pays for the real layout once, and the scroll then lands exactly.
   * Removing the class does not undo that — `contain-intrinsic-size: auto 120px`
   * means a row's estimate *becomes* its real height the first time it is
   * rendered, which is the whole reason the `auto` keyword is there — so this is
   * paid once per session, on a click, and never on the streaming path.
   */
  const onJump = useCallback(
    (anchor: string) => {
      const root = scrollRef.current;
      if (!root) return;
      // A **fresh** lookup rather than `anchors.current`. The map is an
      // optimisation for the per-frame path and is allowed to lag the DOM for a
      // commit (that lag is what `marks` documents, and `measure` repairs it when
      // it next runs) — but a click has no next run to be repaired by, and the
      // turn that has just started is exactly the one a reader is most likely to
      // click. Measured: clicking the last mark of a 60-turn session did nothing
      // at all, because the map was built one commit earlier, while that turn was
      // still anchored on its echo.
      const el = root.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(anchor)}"]`);
      if (!el) return;
      root.classList.add('is-landing');
      // Read a layout property to force the layout that `is-landing` asked for.
      // `scrollIntoView` would force it anyway, but only for the rows it decides
      // to touch — and the point is the document's height, which is the sum.
      void root.scrollHeight;
      el.scrollIntoView({ block: 'start' });
      root.classList.remove('is-landing');
    },
    [scrollRef],
  );

  const onHover = useCallback((index: number) => setHover(index), []);
  const onEnter = useCallback((index: number) => setFocus(index), []);
  const onLeave = useCallback(() => setFocus(null), []);
  const register = useCallback((index: number, el: HTMLButtonElement | null) => {
    buttons.current[index] = el;
  }, []);

  const preview = focus ?? hover;
  const cursor = focus ?? active ?? 0;

  /**
   * The rail's cursor, as one tab stop.
   *
   * A rail of 300 marks must not put 300 stops between the transcript and the
   * composer, so exactly one mark is tabbable — the reader's own turn — and the
   * arrows move within the rail from there. Handled on the `nav` rather than on
   * `window` (as `useListKeys` does for panels), because these keys belong to the
   * rail only while it has focus; a global listener would take the arrow keys away
   * from the composer's history.
   */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    let target: number | null = null;
    if (e.key === 'ArrowDown') target = Math.min(turns.length - 1, cursor + 1);
    else if (e.key === 'ArrowUp') target = Math.max(0, cursor - 1);
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = turns.length - 1;
    if (target === null) return;
    e.preventDefault();
    buttons.current[target]?.focus();
  };

  const total = marksHeight(turns.length);
  const limit = railViewport <= 0 ? MAX_FRAME_PX : Math.min(MAX_FRAME_PX, railViewport);
  const scrolling = total > limit;
  const fade = [
    scrolling && railScroll > 1 ? 'is-top' : '',
    scrolling && railScroll < total - limit - 1 ? 'is-bottom' : '',
  ]
    .filter((name) => name !== '')
    .join(' ');

  const shown = preview === null ? undefined : turns[preview];

  return (
    <nav
      className="turn-rail"
      aria-label={t('rail.label')}
      onKeyDown={onKeyDown}
      onPointerEnter={() => {
        pointerInside.current = true;
      }}
      onPointerLeave={() => {
        pointerInside.current = false;
        setHover(null);
      }}
    >
      <div
        ref={scroller}
        className={`turn-rail-scroll${fade === '' ? '' : ` ${fade}`}`}
        onScroll={(e) => setRailScroll(e.currentTarget.scrollTop)}
      >
        <div className="turn-rail-marks" style={{ height: `${total}px` }}>
          {turns.map((turn, index) => (
            <TurnMark
              key={turn.anchor}
              index={index}
              anchor={turn.anchor}
              n={turn.turn}
              running={turn.running}
              active={index === active}
              previewing={index === preview}
              tabbable={index === cursor}
              previewId={previewId}
              onJump={onJump}
              onHover={onHover}
              onEnter={onEnter}
              onLeave={onLeave}
              register={register}
            />
          ))}
        </div>
      </div>

      {shown !== undefined && preview !== null ? (
        <div
          id={previewId}
          role="tooltip"
          className="turn-rail-preview"
          // The card follows the mark it belongs to, which is a position inside
          // the rail's own scroll — so the rail's scroll offset enters here and
          // the clamp lives in the stylesheet.
          style={
            { '--rail-preview-centre': `${markCentre(preview) - railScroll}px` } as CSSProperties
          }
        >
          <div className="turn-rail-prompt">
            {shown.prompt === '' ? t('entry.turn', { n: shown.turn }) : shown.prompt}
          </div>
          {shown.response === '' ? null : (
            <div className="turn-rail-response">{shown.response}</div>
          )}
        </div>
      ) : null}
    </nav>
  );
}
