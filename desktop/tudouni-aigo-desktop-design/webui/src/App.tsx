import { useEffect } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { useApp } from '@/state/store';
import { useRuntimeBridge } from '@/runtime/useRuntime';
import { useGlobalKeys } from '@/hooks/useGlobalKeys';
import { applyTheme, watchSystemTheme } from '@/theme';

import { TitleBar } from '@/components/chrome/TitleBar';
import { TopBar } from '@/components/chrome/TopBar';
import { SessionBar } from '@/components/chrome/SessionBar';
import { CollapsedSummary } from '@/components/chrome/CollapsedSummary';
import { StatusBar } from '@/components/chrome/StatusBar';
import { Composer } from '@/components/chrome/Composer';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { Welcome } from '@/components/Welcome';
import { Booting } from '@/components/Booting';
import { StreamView } from '@/components/stream/StreamView';
import { PanelHost } from '@/components/panels/PanelHost';
import { PermissionModal } from '@/components/modals/PermissionModal';
import { QuestionModal } from '@/components/modals/QuestionModal';

export function App() {
  useRuntimeBridge();
  useGlobalKeys();

  const themePref = useApp((s) => s.themePref);
  const ready = useApp((s) => s.ready);
  const sidebarVisible = useApp((s) => s.sidebarVisible);
  const entries = useApp((s) => s.entries);

  // 主题：pref 变了就落一次；system 时还要跟着系统走
  useEffect(() => {
    applyTheme(themePref);
  }, [themePref]);

  useEffect(() => {
    if (themePref !== 'system') return;
    return watchSystemTheme(() => applyTheme('system'));
  }, [themePref]);

  // 首屏判定：只有 note（运行期说明）而没有真实对话时，仍算首屏（§7 末句）
  const hasConversation = entries.some((e) => e.kind !== 'note');
  const showWelcome = ready && !hasConversation;

  return (
    <TooltipPrimitive.Provider delayDuration={400} skipDelayDuration={240}>
      <div className="app">
        <TitleBar />
        <TopBar />
        <SessionBar />
        {!sidebarVisible ? <CollapsedSummary /> : null}

        <div className="app-main">
          <main className="app-stream">
            {!ready ? <Booting /> : showWelcome ? <Welcome /> : <StreamView />}
          </main>
          {sidebarVisible ? <Sidebar /> : null}
        </div>

        <StatusBar />
        <Composer />
      </div>

      <PanelHost />
      <PermissionModal />
      <QuestionModal />
    </TooltipPrimitive.Provider>
  );
}
