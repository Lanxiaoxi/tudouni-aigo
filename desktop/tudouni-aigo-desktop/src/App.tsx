import { useEffect } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { useApp } from '@/state/store';
import { useRuntimeBridge } from '@/runtime/useRuntime';
import { useGlobalKeys } from '@/hooks/useGlobalKeys';
import { useFileDrop } from '@/hooks/useFileDrop';
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

  const ready = useApp((s) => s.ready);
  const sidebarVisible = useApp((s) => s.sidebarVisible);
  const leftbarVisible = useApp((s) => s.leftbarVisible);
  const entries = useApp((s) => s.entries);
  const handshakeNotices = useApp((s) => s.handshakeNotices);
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
  const showWelcome = ready && !hasConversation;

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
        {showSummary ? <CollapsedSummary /> : null}

        <div className="app-main">
          {showLeftbar ? <WorkspaceSidebar /> : null}
          <main className="app-stream">
            {/* A start-up failure outranks everything: without a runtime there
                is no session to show, and the reason plus the two ways out are
                the only useful thing on screen. */}
            {startupProblem !== null ? (
              <StartupProblem />
            ) : !ready ? (
              <Booting />
            ) : showWelcome ? (
              <Welcome notices={handshakeNotices} />
            ) : (
              <StreamView />
            )}
          </main>
          {showSidebar ? <Sidebar /> : null}
        </div>

        <StatusBar />
        <Composer />
      </div>

      <PanelHost />
      <PermissionModal />
      <QuestionModal />
      </ErrorBoundary>
    </TooltipPrimitive.Provider>
  );
}
