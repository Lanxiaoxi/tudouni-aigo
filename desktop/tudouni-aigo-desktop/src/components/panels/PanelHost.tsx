import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { selectMenuIsOpen } from '@/components/ui/Select';
import { CommandPalette } from './CommandPalette';
import {
  AuditPanel,
  ContextPanel,
  EffortPanel,
  FilesPanel,
  HelpPanel,
  McpPanel,
  ModelPanel,
  ResumePanel,
  SkillsPanel,
  SubagentsPanel,
  TerminalPanel,
  TimingPanel,
} from './panels';
import { LearnPanel } from './LearnPanel';
import { MemoryPanel } from './MemoryPanel';
import { CodeIntelPanel } from './CodeIntelPanel';
import { UsagePanel } from './UsagePanel';
import { SettingsPanel } from './SettingsPanel';
import { ConfigPanel } from './ConfigPanel';
import { TaskPanel } from './TaskPanel';
import { SubagentPresetsPanel } from './SubagentPresetsPanel';
import { HooksPanel } from './HooksPanel';

/**
 * §5 Panel host.
 *
 * Every panel shares one container and one interaction model; only the command
 * palette is different — its input sits at the top and it hugs the top of the
 * window. Esc and clicking the overlay close, handled by the dialog primitive.
 *
 * **`wb-panel` is the workbench family's width.** `design/workbench-light-v2/`
 * draws its eleven panels edge to edge at one proportion (92% of the canvas,
 * 1180px at the window's 1280 default), so the rungs that used to separate them
 * — 820 for the task editor, 1000 for memory, 1180 for the route page — no longer
 * describe anything. The panels the sheets do not draw keep the rung they had:
 * a model picker and a session picker are lists, and a 1180px list of one-line
 * rows is a worse list, not a better one.
 *
 * Terminals and Usage stay on `dialog-wide` for their own reasons (a terminal row
 * carries an id, a status badge, a cwd path, a shell and an action slot on one
 * line; a year's heatmap is fifty-three week columns).
 *
 * There is no theme panel: the theme follows the system and there is no in-app
 * switch (decision 4), so the command that used to open one is gone too.
 */
const WORKBENCH_PANELS: ReadonlySet<string> = new Set([
  'config',
  'tasks',
  'subagentPresets',
  'hooks',
  'learn',
  'settings',
  'memory',
  'codeintel',
]);

export function PanelHost() {
  const t = useT();
  const panel = useApp((s) => s.panel);

  return (
    <DialogPrimitive.Root
      open={panel !== null}
      onOpenChange={(open) => {
        // Through the store action, not `setState`: the library borrows the
        // connection's session filter while it is open and closing is where it
        // is handed back. Esc and the overlay are two of the ways out, and this
        // is the only path they have. See `AppStore.closePanel`.
        if (!open) useApp.getState().closePanel();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content
          className={`dialog${panel === 'commands' ? ' cmdk' : ''}${
            panel === 'config' ||
            panel === 'tasks' ||
            panel === 'subagentPresets' ||
            panel === 'hooks' ||
            panel === 'learn' ||
            panel === 'usage' ||
            panel === 'terminal' ||
            panel === 'settings'
              ? ' dialog-wide'
              : ''
          }${panel !== null && WORKBENCH_PANELS.has(panel) ? ' wb-panel' : ''}${
            panel === 'files' ? ' dialog-files' : ''
          }${panel === 'memory' ? ' dialog-memory dialog-split' : ''}${
            panel === 'codeintel' ? ' dialog-memory' : ''
          }`}
          aria-label={t('topbar.commands')}
          // Esc with a dropdown menu up closes the menu, not the panel. Radix
          // sees the key first (capture on `document`), so it has to be told.
          onEscapeKeyDown={(e) => {
            if (selectMenuIsOpen()) e.preventDefault();
          }}
        >
          {panel === 'commands' ? <CommandPalette /> : null}
          {panel === 'model' ? <ModelPanel /> : null}
          {panel === 'effort' ? <EffortPanel /> : null}
          {panel === 'resume' ? <ResumePanel /> : null}
          {panel === 'mcp' ? <McpPanel /> : null}
          {panel === 'skills' ? <SkillsPanel /> : null}
          {panel === 'help' ? <HelpPanel /> : null}
          {panel === 'subagents' ? <SubagentsPanel /> : null}
          {panel === 'audit' ? <AuditPanel /> : null}
          {panel === 'context' ? <ContextPanel /> : null}
          {panel === 'timing' ? <TimingPanel /> : null}
          {panel === 'settings' ? <SettingsPanel /> : null}
          {panel === 'config' ? <ConfigPanel /> : null}
          {panel === 'files' ? <FilesPanel /> : null}
          {panel === 'terminal' ? <TerminalPanel /> : null}
          {panel === 'learn' ? <LearnPanel /> : null}
          {panel === 'tasks' ? <TaskPanel /> : null}
          {panel === 'memory' ? <MemoryPanel /> : null}
          {panel === 'codeintel' ? <CodeIntelPanel /> : null}
          {panel === 'usage' ? <UsagePanel /> : null}
          {panel === 'subagentPresets' ? <SubagentPresetsPanel /> : null}
          {panel === 'hooks' ? <HooksPanel /> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
