import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { activeRuntime, NO_ENTRIES, NO_NOTES, useApp } from '@/state/store';
import { draggedRailWidth, type RailSide } from '@/railWidth';
import { conversationView, showsComposer, showsTranscript } from '@/conversationView';
import { useRuntimeBridge } from '@/runtime/useRuntime';
import { useGlobalKeys } from '@/hooks/useGlobalKeys';
import { useKeepAwake } from '@/hooks/useKeepAwake';
import { useNotifications } from '@/hooks/useNotifications';
import { useTrayCommands } from '@/hooks/useTrayCommands';
import { useWindowClose } from '@/hooks/useWindowClose';
import { useFileDrop } from '@/hooks/useFileDrop';
import { useInputModality } from '@/hooks/useInputModality';
import { useSidebarHiddenByCss } from '@/hooks/useLayout';
import { applySystemTheme, watchSystemTheme } from '@/theme';

import { TitleBar } from '@/components/chrome/TitleBar';
import { useT } from '@/i18n/useT';
import { TopBar } from '@/components/chrome/TopBar';
import { SessionBar } from '@/components/chrome/SessionBar';
import { CollapsedSummary } from '@/components/chrome/CollapsedSummary';
import { StatusBar } from '@/components/chrome/StatusBar';
import { Composer } from '@/components/chrome/Composer';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { WorkspaceSidebar } from '@/components/sidebar/WorkspaceSidebar';
import { Welcome } from '@/components/Welcome';
import { Booting } from '@/components/Booting';
import { StartupProblem } from '@/components/StartupProblem';
import { SessionProblem } from '@/components/SessionProblem';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { StreamView } from '@/components/stream/StreamView';
import { TerminalView } from '@/components/terminal/TerminalView';
import { SessionBoard } from '@/components/board/SessionBoard';
import { PanelHost } from '@/components/panels/PanelHost';
import { PermissionModal } from '@/components/modals/PermissionModal';
import { QuestionModal } from '@/components/modals/QuestionModal';
import { QuestionMinimizedPill } from '@/components/modals/QuestionMinimizedPill';
import { CloseConfirm } from '@/components/modals/CloseConfirm';
import { ConfigSyncPromptModal } from '@/components/modals/ConfigSyncPromptModal';
import { ConnectingToast } from '@/components/ConnectingToast';

export function App() {
  useRuntimeBridge();
  useGlobalKeys();
  // The OS's screen lock does not know a session is running, so a long turn
  // ends at an arbitrary wall-clock moment. This holds the display awake
  // while any open session has a turn in flight, and releases it otherwise.
  useKeepAwake();
  useFileDrop();
  // Publishes `data-input-mode` on <html>, which is what tells a pointer-driven
  // focus from a keyboard one. `:focus-visible` cannot do it for a text field.
  useInputModality();
  // The X button now means two things, so it asks — unless a previous answer was
  // remembered. Window-level: one question, asked once, about the whole window.
  useWindowClose();
  // Say something when a session behind this window wants a person: a blocking
  // request, a failure, or a turn that ended while nobody was looking. Window
  // level because it is about every session at once, and it is the one place
  // that can see a background session change status.
  useNotifications();
  // The tray menu's two session acts ("New session", "Session board"): the
  // window half is the Rust side's, the act itself lands here.
  useTrayCommands();

  // Everything the transcript draws comes from **the session being shown**, and
  // with several open that is a bucket rather than the store. `activeRuntime` is
  // the one place that says which; a background session's stream keeps landing in
  // its own bucket whether or not anybody is looking at it.
  const rt = useApp(activeRuntime);
  const activeKey = useApp((s) => s.activeKey);
  const ready = rt?.ready ?? false;
  // **Why this session's child would not start**, when that is why it is not on
  // screen. It is read here and nowhere else, and it has to be read *before*
  // `!ready` is tested: a session whose child failed never becomes ready, so the
  // order below is the difference between "here is what went wrong" and
  // "Starting the runtime…" over a process that already gave up.
  const problem = rt?.problem ?? null;
  const entries = rt?.entries ?? NO_ENTRIES;
  const handshakeNotices = rt?.handshakeNotices ?? NO_NOTES;
  const sidebarVisible = useApp((s) => s.sidebarVisible);
  const leftbarVisible = useApp((s) => s.leftbarVisible);
  const boardOpen = useApp((s) => s.boardOpen);
  const sidebarWidth = useApp((s) => s.sidebarWidth);
  const leftbarWidth = useApp((s) => s.leftbarWidth);
  // Live while a rail-width drag is in flight, and naming **which** rail: only
  // that rail drops its width transition (so it tracks the pointer instead of
  // easing behind it) and only its handle paints the drag colour.
  const resizing = useApp((s) => s.resizing);
  const startupProblem = useApp((s) => s.startupProblem);
  const dragging = useApp((s) => s.dragging);
  // Which terminal this session's view is attached to, if any. It is read from
  // the **session on screen** rather than from the window, because it is a
  // per-session choice: attaching in one conversation must not take the
  // keyboard away from another one's composer.
  const attachedTerminalId = rt?.activeTerminalId ?? null;

  // One theme source: the system. Nothing to select, nothing to persist.
  useEffect(() => {
    applySystemTheme();
    return watchSystemTheme();
  }, []);

  // The first screen shows only when there is no real conversation yet. Runtime
  // notices are not conversation — but they **are** session content, and the
  // design is explicit that they must not be squeezed out by it: "runtime
  // notices below the first screen belong to session content, they cannot be
  // pushed out" (§7). So they are handed to the first screen rather than being
  // dropped along with the stream. A workspace whose runtime could not start
  // would otherwise show a friendly greeting and nothing about why.
  //
  // They come from their own store field rather than being filtered out of the
  // stream, because `session_load` rebuilds the stream the moment after `init`
  // and would take them with it.
  const hasConversation = entries.some((entry) => entry.kind !== 'note');

  // **Which of the six things the column is showing, decided in one place.**
  // The priority order is a real ordering rather than a set of independent
  // conditions, and that distinction is the whole reason this is a function:
  // the terminal and the composer used to be answered by two separate
  // expressions, which let them disagree — a shell with no composer and no
  // terminal, and no control on screen that could detach. See
  // `conversationView.ts` for the order and for the defect.
  const view = conversationView({
    startupProblem: startupProblem !== null,
    sessionProblem: problem !== null,
    attachedTerminalId,
    boardOpen,
    // No session open means nothing to boot: `ready` can never become true, so
    // "starting the runtime…" would be a sentence about a process nobody
    // started. Closing the last session is how that state is reached.
    hasSession: activeKey !== null,
    ready,
    hasConversation,
  });

  // The hand-off half of the board's card exit: a card press focuses its
  // session *under the board*, the board closes when the card's exit ends
  // (`SessionBoard`), and this is the moment the column comes back — so the
  // whole conversation column rises in over the stream one time. The flag is
  // cleared by the animation's own end (`.app-conversation`'s
  // `onAnimationEnd`), so it costs one re-render on the way out. **The board is
  // the only source:** sidebar switches keep `.app-conversation` mounted and
  // merely swap the transcript, and animating those would flash a full-column
  // fade on an ordinary row click. The stream is freshly mounted when the board
  // closes, so there is nothing to distinguish a board return from a plain
  // boot-up that never saw a board — and a boot-up plays the same rise, which
  // is right: it is a view arrival either way.
  const [streamLift, setStreamLift] = useState(false);
  const prevView = useRef(view);
  useEffect(() => {
    if (prevView.current === 'board' && view === 'stream') setStreamLift(true);
    prevView.current = view;
  }, [view]);

  // The sidebar has two independent off-switches: the person's preference, and
  // the stylesheet's 1024px rule — which is why the summary row cannot be driven
  // by the preference alone. When the CSS hides the sidebar, the summary must
  // take its place, or the two vanish together and the screen goes blank.
  //
  // **A third reason, and it is derived rather than remembered.** The board
  // takes the right rail's place while it is up — the rail reports on the
  // conversation on screen, and with the board up there is no conversation on
  // screen. It is `&& !boardOpen` rather than a written preference because
  // `sidebarVisible` is the person's setting: writing it would mean the rail did
  // not come back when the board closed, and that the change survived a restart
  // they never asked for. Nothing is stored, so there is nothing to restore.
  const hiddenByCss = useSidebarHiddenByCss();
  const showSidebar = sidebarVisible && !hiddenByCss && !boardOpen;
  // The summary row says "the conversation on screen is in this phase, with this
  // much usage" — so it must not take the rail's place while the board is up: it
  // would be talking about a conversation nobody is looking at. `|| boardOpen`
  // suppresses it; without this it appears the instant the rail folds, which is
  // the same "two things vanished" shape the CSS rule above exists to prevent.
  const showSummary = !showSidebar && !boardOpen;

  // The left sidebar has its own off-switch, and one more rule on top: a
  // blocking prompt takes the whole screen's attention, and every action in that
  // rail either abandons the pending request or restarts the process under it.
  // The controls are disabled rather than the rail removed, so the workspace and
  // the session stay readable while the prompt is up.
  const showLeftbar = leftbarVisible && !hiddenByCss;

  return (
    <TooltipPrimitive.Provider delayDuration={400} skipDelayDuration={240}>
      {/* Around everything: a throw anywhere below would otherwise unmount the
          tree and leave a white window with a live runtime behind it and
          nothing on screen to explain it. */}
      <ErrorBoundary>
      <div className={`app${dragging ? ' is-dragging' : ''}`}>
        <TitleBar />
        <TopBar />

        <div className="app-main">
          {/* Each rail sits inside a clipping wrapper that owns the width, so
              collapsing is a transition rather than an unmount.
              **A conditionally rendered element has nothing to transition** — it
              appears and disappears between frames — which is why the rails are
              now always mounted and only their wrapper's width changes. The inner
              element keeps its full width so its text does not reflow on the way
              out; the wrapper's `overflow: hidden` is what slides it out of view.

              `inert` when collapsed is not decoration: the controls are still in
              the DOM, so without it Tab would walk into a rail nobody can see. */}
          <div
            className={`app-rail app-rail-left${showLeftbar ? '' : ' is-collapsed'}${resizing === 'left' ? ' is-resizing' : ''}`}
            inert={!showLeftbar}
            // The same custom property the right rail reads, written on **this**
            // element: each rail resolves it on itself, so one name shared by
            // two rails is not a collision. The cast is React's usual bridge for
            // a custom property, and the name is asserted by the stylesheet it
            // feeds (`--rail-w-dragged` in global.css).
            style={
              leftbarWidth !== null
                ? ({ '--rail-w-dragged': `${leftbarWidth}px` } as CSSProperties)
                : undefined
            }
          >
            {showLeftbar ? <RailDragHandle rail="left" /> : null}
            <WorkspaceSidebar />
          </div>

          {/* The conversation column: the transcript **and the composer**. They
              are one region, not two. A composer is where you speak into the
              conversation, so it belongs to it — and putting it outside meant
              the input box was as wide as the window while the text it was
              continuing was 980px in the middle of it.

              The status bar is deliberately *not* in here: it reports on the
              whole application (phase, autopilot, usage, the audit log), not on
              this column, so it stays a sibling and spans the window. */}
          {/* The session bar is **the conversation column's** header, not the
              window's. Every fact on it names the conversation on screen — with
              several sessions open the rail heads next to it name theirs, and a
              window-wide bar read all four columns as one session's. Its width
              follows `.app-conversation`, so the two sidebars reach the top of
              this row; the facts they would have shown are theirs to draw. */}
          <div
            className={`app-conversation${streamLift ? ' is-lifting' : ''}`}
            // The rise is one play, so the class must come off when the
            // animation ends or a later return from the board would find no
            // animation left to run (a class that is already applied does not
            // restart). The event is the animation's own, not a timer — and
            // `animationend` **bubbles**, so the name check is what keeps a
            // one-shot animation playing somewhere in the transcript (a step
            // sliding in, the fold row revealing) from clearing the class
            // mid-rise and popping the column back to its final frame.
            onAnimationEnd={(e) => {
              if (streamLift && e.animationName === 'stream-rise') setStreamLift(false);
            }}
          >
            <SessionBar canFind={showsTranscript(view)} />
            {/* The summary row stands in for the right rail once it is folded,
                so it is drawn **under the session bar and inside the
                conversation column** — the same width as the row above it,
                rather than a window-wide strip. It used to be a sibling of
                `.app-main`, which made it span under both rails: it read as a
                third chrome bar belonging to the window while everything on it
                (jobs, MCP, tasks) is a fact about the conversation beside it.

                Folded rather than conditionally rendered, like the rails: the
                row replaces the right rail, so having the rail slide away while
                this snapped into existence read as two unrelated events.
                `inert` while folded rather than `aria-hidden`, because the row
                is full of buttons. */}
            <div className={`collapse${showSummary ? '' : ' is-collapsed'}`} inert={!showSummary}>
              <div>
                <CollapsedSummary />
              </div>
            </div>
            <main className="app-stream">
              {/* Six occupants, one order, and **the order is the decision** —
                  see `conversationView.ts`, where it is written down and
                  asserted. It used to be a chain of ternaries here, and the two
                  that mattered most were the two that were swapped: an attached
                  terminal was tested *after* the first screen, so opening a
                  shell in a workspace with no conversation drew the greeting
                  over it and hid the only control that could leave. */}
              {view === 'startup-problem' ? (
                <StartupProblem />
              ) : view === 'session-problem' ? (
                <SessionProblem />
              ) : view === 'terminal' ? (
                <TerminalView />
              ) : view === 'board' ? (
                <SessionBoard />
              ) : view === 'welcome' ? (
                <Welcome notices={handshakeNotices} />
              ) : view === 'booting' ? (
                <Booting />
              ) : (
                <StreamView />
              )}
            </main>

            {/* The composer is the conversation's, and it is **not drawn while a
                terminal has the screen**: every keystroke in that state belongs
                to the shell (see `TerminalView`), so a text box sitting under
                the output would be a control that cannot accept input. Its `+`
                and its send button would each be a gesture that does nothing.

                **Asked of the same decision as the view above, not of the
                attach.** Two expressions answered one question, so they could
                disagree — and when they did, the bug was invisible in the worst
                way: the composer was gone *and* nothing had replaced it. */}
            {showsComposer(view) ? <Composer /> : null}
          </div>

          <div
            className={`app-rail app-rail-right${showSidebar ? '' : ' is-collapsed'}${resizing === 'right' ? ' is-resizing' : ''}`}
            inert={!showSidebar}
            // React's CSSProperties does not declare custom properties; the
            // cast is the usual bridge, and the variable name is asserted by
            // the stylesheet it feeds (`--rail-w-dragged` in global.css).
            style={
              sidebarWidth !== null
                ? ({ '--rail-w-dragged': `${sidebarWidth}px` } as CSSProperties)
                : undefined
            }
          >
            {showSidebar ? <RailDragHandle rail="right" /> : null}
            <Sidebar />
          </div>
        </div>

        <StatusBar />
      </div>

      <PanelHost />
      <PermissionModal />
      <QuestionModal />
      {/* The way back from a minimized question. Its own overlay beside the
          modals, because a minimized prompt is a state the modal itself no
          longer draws — see the component. */}
      <QuestionMinimizedPill />
      {/* The remote-open status: window-level, because the wait belongs to the
          *open* — and its first stretch (config check, install) has no session
          on screen at all. It says nothing a modal needs to block, so it sits
          beside them rather than inside any of them. */}
      <ConnectingToast />
      {/* After the two blocking modals, and it is the last thing raised: it is
          the newest question and the only one that is about the window rather
          than about a session. It cannot stack with them in practice — the
          title bar is above every overlay, so X is reachable while a prompt is
          up, but a close request does not disturb a pending approval (minimize
          leaves it, and close ends the session it belongs to). */}
      <CloseConfirm />
      <ConfigSyncPromptModal />
      </ErrorBoundary>
    </TooltipPrimitive.Provider>
  );
}

/**
 * A rail's drag handle: a narrow strip on the rail's **inner** edge — the edge
 * that faces the conversation — which resizes the rail with pointer events.
 * Both rails wear one; `rail` says which, and the two differ in exactly two
 * places: which store field the width lands in, and the sign of the drag delta.
 *
 * A live drag goes to `document`, not to the strip: crossing the strip's own
 * edge mid-sweep would otherwise drop the pointermove stream. The listeners
 * are removed on `pointerup`, which for a captured pointer is the gesture's
 * own end — a drag that ends outside the window still releases there.
 *
 * The width is clamped through the rail's own setter, so the same range governs
 * the drag, the persisted value read back on load, and any future caller. A
 * double-click hands the width back to the stylesheet (`null`), the same way
 * other rails' toggles restore rather than merely hide.
 */
function RailDragHandle({ rail }: { rail: RailSide }) {
  const t = useT();

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Capture keeps the pointermove stream aimed here even when the pointer
    // leaves the strip mid-sweep; the document listeners below are what keep
    // the width tracking, because the capture only fixes the *target*, and the
    // move handler has to live somewhere that survives crossing the strip's
    // own edge.
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    // The rail is the strip's offset parent, so its current width is the
    // starting point the deltas are measured against — read here, once, rather
    // than from the store on every move.
    const startW = e.currentTarget.offsetParent
      ? (e.currentTarget.offsetParent as HTMLElement).getBoundingClientRect().width
      : 0;
    const move = (ev: PointerEvent) => {
      // Dragging the inner edge **outward** — away from the rail, into the
      // conversation — must widen it. Which way that is differs per rail, and
      // the geometry (with the sign's history) is written down in
      // `railWidth.ts` rather than inlined here, so both rails' directions are
      // asserted by a test instead of by eye.
      const width = draggedRailWidth(rail, startW, ev.clientX - startX);
      if (rail === 'right') useApp.getState().setSidebarWidth(width);
      else useApp.getState().setLeftbarWidth(width);
    };
    const stop = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
      document.body.classList.remove('is-resizing');
      useApp.setState({ resizing: null });
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
    document.body.classList.add('is-resizing');
    useApp.setState({ resizing: rail });
  };

  return (
    <div
      className="rail-drag"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('rail.drag')}
      onPointerDown={onPointerDown}
      onDoubleClick={() =>
        rail === 'right'
          ? useApp.getState().setSidebarWidth(null)
          : useApp.getState().setLeftbarWidth(null)
      }
    />
  );
}
