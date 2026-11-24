import { ArrowLeft, ChevronDown, ChevronUp, FolderTree, GitBranch, Maximize2, Minimize2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { Splitter } from '@/components/ui/Splitter';
import {
  TERM_DEFAULT,
  navigatorRange,
  navigatorWidth,
  terminalHeight,
  terminalRange,
  type DockLayout,
} from '@/state/workspaceDock/budget';
import { regionOfMode, regionState, type DockCapabilities } from '@/state/workspaceDock/capabilities';
import { useActiveWorkspaceKey } from '@/state/workspaceDock/selectors';
import { DOCK_SHORTCUT_ARIA, DOCK_SHORTCUT_LABELS, TERMINAL_FOCUS_ATTR } from '@/state/workspaceDock/shortcuts';
import type { DockMode } from '@/state/workspaceDock/uiState';
import { DockEmpty } from './DockEmpty';
import { DockViewer, ExplorerNavigator, GitNavigator, TerminalDock, type DockModuleProps } from './modules';
import { useElementHeight } from './useDockMeasure';

export interface WorkspaceDockProps {
  /** The derived layout (`planDockLayout`): what is drawn, not what is preferred. */
  layout: DockLayout;
  /**
   * The host's capability table for the active workspace. `undefined`/`null`
   * means "not connected": every region draws that empty state rather than
   * failing. Passed as a prop so the framework does not know where it comes
   * from (see `useDockCapabilities`).
   */
  capabilities?: DockCapabilities | null;
}

const MODES: { mode: DockMode; icon: ReactNode; label: 'dock.mode.explorer' | 'dock.mode.git' }[] = [
  { mode: 'explorer', icon: <FolderTree size={13} />, label: 'dock.mode.explorer' },
  { mode: 'git', icon: <GitBranch size={13} />, label: 'dock.mode.git' },
];

/**
 * The Workspace Dock's content: the mode switch, the Navigator + Viewer pair
 * and the Terminal Dock (docs/design/workspace-dock.md §1.3, §2.1, §2.4).
 *
 * This is the **framework**. It owns the layout, the splitters, the fold and
 * maximize of the terminal area, and the empty states; the module content is
 * plugged in through the four components in `./modules.tsx`. The outer column
 * (its width, overlay or docked) is `App.tsx`'s, because that depends on the
 * rails beside it.
 *
 * The terminal area is independent of the mode: switching Explorer/Git never
 * touches it, and folding or maximizing it is presentation only.
 */
export function WorkspaceDock({ layout, capabilities }: WorkspaceDockProps) {
  const t = useT();
  const workspace = useActiveWorkspaceKey();
  const mode = useApp((s) => s.dockMode);
  const pane = useApp((s) => s.dockPane);
  const navPref = useApp((s) => s.dockNavWidth);
  const termPref = useApp((s) => s.dockTermHeight);
  const termVisible = useApp((s) => s.dockTermVisible);
  const termMaximized = useApp((s) => s.dockTermMaximized);
  const setDockOpen = useApp((s) => s.setDockOpen);
  const setDockMode = useApp((s) => s.setDockMode);
  const setDockNavWidth = useApp((s) => s.setDockNavWidth);
  const setDockTermHeight = useApp((s) => s.setDockTermHeight);
  const setDockTermVisible = useApp((s) => s.setDockTermVisible);
  const setDockTermMaximized = useApp((s) => s.setDockTermMaximized);
  const setDockPane = useApp((s) => s.setDockPane);

  const [rootRef, height] = useElementHeight<HTMLDivElement>();

  const dual = layout.columns === 'dual';
  const hasWorkspace = workspace !== null;
  const upper = regionState(hasWorkspace, capabilities, regionOfMode(mode));
  const term = regionState(hasWorkspace, capabilities, 'terminal');

  // A folded terminal cannot also be the one filling the dock.
  const maximized = termMaximized && termVisible;

  const navRange = navigatorRange(layout.width);
  const navW = navigatorWidth(navPref, layout.width);
  // Before the first measurement the preference is used as it is; clamping
  // against a height of 0 would flash the terminal at its floor.
  const termH = height > 0 ? terminalHeight(termPref, height) : (termPref ?? TERM_DEFAULT);
  const termBounds = terminalRange(height > 0 ? height : Number.POSITIVE_INFINITY);

  const moduleProps: DockModuleProps | null =
    workspace !== null && capabilities
      ? { workspace, capabilities, columns: layout.columns }
      : null;

  const navigator =
    moduleProps === null ? null : mode === 'git' ? <GitNavigator {...moduleProps} /> : <ExplorerNavigator {...moduleProps} />;
  const viewer = moduleProps === null ? null : <DockViewer {...moduleProps} mode={mode} />;

  let upperBody: ReactNode;
  if (upper !== 'ready') {
    upperBody = <DockEmpty state={upper} region={regionOfMode(mode)} />;
  } else if (dual) {
    upperBody = (
      <div className="dock-split">
        <section className="dock-nav" style={{ width: navW }} aria-label={t('dock.nav.label')}>
          {navigator}
        </section>
        <Splitter
          orientation="vertical"
          grow="end"
          value={navW}
          min={navRange.min}
          max={navRange.max}
          label={t('dock.splitter.nav')}
          onChange={setDockNavWidth}
          onReset={() => setDockNavWidth(null)}
        />
        <section className="dock-viewer" aria-label={t('dock.viewer.label')}>
          {viewer}
        </section>
      </div>
    );
  } else if (pane === 'navigator') {
    upperBody = (
      <div className="dock-split">
        <section className="dock-nav is-full" aria-label={t('dock.nav.label')}>
          {navigator}
        </section>
      </div>
    );
  } else {
    upperBody = (
      <div className="dock-split">
        <section className="dock-viewer is-full" aria-label={t('dock.viewer.label')}>
          <div className="dock-viewer-bar">
            <button type="button" className="btn btn-ghost btn-compact" onClick={() => setDockPane('navigator')}>
              <ArrowLeft size={13} />
              {t('dock.back')}
            </button>
          </div>
          <div className="dock-viewer-body">{viewer}</div>
        </section>
      </div>
    );
  }

  const termBody: ReactNode =
    term === 'ready' && moduleProps !== null ? (
      <TerminalDock {...moduleProps} />
    ) : (
      <DockEmpty state={term === 'ready' ? 'not-connected' : term} region="terminal" />
    );

  const termStyle = termVisible && !maximized ? { height: termH } : undefined;

  return (
    <div className="dock" ref={rootRef}>
      <div className="dock-head">
        <div className="dock-modes" role="group" aria-label={t('dock.mode.label')}>
          {MODES.map(({ mode: m, icon, label }) => {
            const key = m === 'git' ? 'git' : 'explorer';
            return (
              <Tip key={m} label={`${t(label)} (${DOCK_SHORTCUT_LABELS[key]})`}>
                <button
                  type="button"
                  className={`dock-mode${mode === m ? ' is-active' : ''}`}
                  aria-pressed={mode === m}
                  aria-keyshortcuts={DOCK_SHORTCUT_ARIA[key]}
                  onClick={() => setDockMode(m)}
                >
                  {icon}
                  {t(label)}
                </button>
              </Tip>
            );
          })}
        </div>
        <Tip label={t('dock.toggle.close')}>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-compact dock-close"
            aria-label={t('dock.toggle.close')}
            onClick={() => setDockOpen(false)}
          >
            <X size={13} />
          </button>
        </Tip>
      </div>

      <div className={`dock-upper${maximized ? ' is-hidden' : ''}`}>{upperBody}</div>

      {termVisible && !maximized ? (
        <Splitter
          orientation="horizontal"
          grow="start"
          value={termH}
          min={termBounds.min}
          max={termBounds.max}
          label={t('dock.splitter.term')}
          onChange={setDockTermHeight}
          onReset={() => setDockTermHeight(null)}
        />
      ) : null}

      <section
        className={`dock-term${termVisible ? '' : ' is-folded'}${maximized ? ' is-maximized' : ''}`}
        style={termStyle}
        aria-label={t('dock.term.title')}
      >
        <div className="dock-term-head">
          <span className="dock-term-title">{t('dock.term.title')}</span>
          <span className="dock-term-actions">
            {termVisible ? (
              <Tip label={maximized ? t('dock.term.restore') : t('dock.term.maximize')}>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-compact"
                  aria-label={maximized ? t('dock.term.restore') : t('dock.term.maximize')}
                  aria-pressed={maximized}
                  onClick={() => setDockTermMaximized(!maximized)}
                >
                  {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                </button>
              </Tip>
            ) : null}
            <Tip label={`${termVisible ? t('dock.term.fold') : t('dock.term.unfold')} (${DOCK_SHORTCUT_LABELS.terminal})`}>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-compact"
                aria-label={termVisible ? t('dock.term.fold') : t('dock.term.unfold')}
                aria-expanded={termVisible}
                aria-keyshortcuts={DOCK_SHORTCUT_ARIA.terminal}
                onClick={() => setDockTermVisible(!termVisible)}
              >
                {termVisible ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
              </button>
            </Tip>
          </span>
        </div>
        {termVisible ? (
          // The attribute is the contract with `useGlobalKeys`: while focus is
          // in here only the Dock's own shortcuts are routed, and every other
          // key belongs to the terminal.
          <div className="dock-term-body" {...{ [TERMINAL_FOCUS_ATTR]: '' }}>
            {termBody}
          </div>
        ) : null}
      </section>
    </div>
  );
}
