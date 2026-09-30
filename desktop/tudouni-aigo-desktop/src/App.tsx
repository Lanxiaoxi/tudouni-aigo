import { useEffect } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { activeRuntime, NO_ENTRIES, NO_NOTES, useApp } from '@/state/store';
import { useRuntimeBridge } from '@/runtime/useRuntime';
import { useGlobalKeys } from '@/hooks/useGlobalKeys';
import { useFileDrop } from '@/hooks/useFileDrop';
import { useInputModality } from '@/hooks/useInputModality';
import { useSidebarHiddenByCss } from '@/hooks/useLayout';
import { applySystemTheme, watchSystemTheme } from '@/theme';

import { TitleBar } from '@/components/chrome/TitleBar';
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
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { StreamView } from '@/components/stream/StreamView';
import { PanelHost } from '@/components/panels/PanelHost';
import { PermissionModal } from '@/components/modals/PermissionModal';
import { QuestionModal } from '@/components/modals/QuestionModal';

export function App() {
  useRuntimeBridge();
  useGlobalKeys();
  useFileDrop();
  // Publishes `data-input-mode` on <html>, which is what tells a pointer-driven
  // focus from a keyboard one. `:focus-visible` cannot do it for a text field.
  useInputModality();

  // Everything the transcript draws comes from **the session being shown**, and
  // with several open that is a bucket rather than the store. `activeRuntime` is
  // the one place that says which; a background session's stream keeps landing in
  // its own bucket whether or not anybody is looking at it.
  const rt = useApp(activeRuntime);
  const activeKey = useApp((s) => s.activeKey);
  const ready = rt?.ready ?? false;
  const entries = rt?.entries ?? NO_ENTRIES;
  const handshakeNotices = rt?.handshakeNotices ?? NO_NOTES;
  const sidebarVisible = useApp((s) => s.sidebarVisible);
  const leftbarVisible = useApp((s) => s.leftbarVisible);
  const startupProblem = useApp((s) => s.startupProblem);
  const dragging = useApp((s) => s.dragging);

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
  // Two ways to reach the first screen, and the second one is what keeps closing
  // the last session from parking the window on "Starting the runtime…" with
  // nothing starting. With no session open there is nothing to boot, and the
  // first screen is where a person starts one.
  const showWelcome = activeKey === null || (ready && !hasConversation);

  // The sidebar has two independent off-switches: the person's preference, and
  // the stylesheet's 1024px rule — which is why the summary row cannot be driven
  // by the preference alone. When the CSS hides the sidebar, the summary must
  // take its place, or the two vanish together and the screen goes blank.
  const hiddenByCss = useSidebarHiddenByCss();
  const showSidebar = sidebarVisible && !hiddenByCss;
  const showSummary = !showSidebar;

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
        <SessionBar />
        {/* Folded rather than conditionally rendered, like the rails: the row
            replaces the right rail, so having the rail slide away while this
            snapped into existence read as two unrelated events. `inert` while
            folded rather than `aria-hidden`, because the row is full of buttons. */}
        <div className={`collapse${showSummary ? '' : ' is-collapsed'}`} inert={!showSummary}>
          <div>
            <CollapsedSummary />
          </div>
        </div>

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
            className={`app-rail app-rail-left${showLeftbar ? '' : ' is-collapsed'}`}
            inert={!showLeftbar}
          >
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
          <div className="app-conversation">
            <main className="app-stream">
              {/* A start-up failure outranks everything: without a runtime there
                  is no session to show, and the reason plus the two ways out are
                  the only useful thing on screen.

                  **A missing session outranks "not ready", and the order here
                  is load-bearing.** With nothing open there is no child to boot,
                  so `ready` can never become true and `<Booting />` would be a
                  sentence about a process that does not exist — "Starting the
                  runtime…" over a runtime that nobody started. That is exactly
                  what a launch with no workspace to go back to would show, which
                  is now a normal state rather than an impossible one. */}
              {startupProblem !== null ? (
                <StartupProblem />
              ) : showWelcome ? (
                <Welcome notices={handshakeNotices} />
              ) : !ready ? (
                <Booting />
              ) : (
                <StreamView />
              )}
            </main>

            <Composer />
          </div>

          <div
            className={`app-rail app-rail-right${showSidebar ? '' : ' is-collapsed'}`}
            inert={!showSidebar}
          >
            <Sidebar />
          </div>
        </div>

        <StatusBar />
      </div>

      <PanelHost />
      <PermissionModal />
      <QuestionModal />
      </ErrorBoundary>
    </TooltipPrimitive.Provider>
  );
}
