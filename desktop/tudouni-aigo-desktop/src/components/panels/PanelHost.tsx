import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
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

/**
 * §5 Panel host.
 *
 * Every panel shares one container and one interaction model; only the command
 * palette is different — its input sits at the top and it hugs the top of the
 * window. Esc and clicking the overlay close, handled by the dialog primitive.
 *
 * Four panels take the wide container (`dialog-wide`): the configuration
 * editor, whose field grid needs the room; the task panel, whose rows carry a
 * name, a description, a workspace · model line and a fixed action slot across
 * one line — at 640px the action slot and the meta line collide, which is the
 * whole reason the task design puts them at opposite edges; Learn this
 * workspace, which is the same two-column editor shape as the task panel's; and
 * Settings, whose form and read-out card are columns rather than a form with a
 * side note. Usage joins them with its own reason: a year's heatmap is
 * fifty-three week columns, and every column squeezed below that width is a
 * month nobody can point at.
 *
 * Terminals are on the same rung for the task row's own reason: a terminal row
 * carries an id, a status badge, a cwd path, a shell and an action slot on one
 * line, and the cwd is the fact the list is scanned by — squeezed to 640px it
 * truncates before the shell is named.
 *
 * Workspace memory has a rung of its own (`dialog-memory`, 1000px): it is the one
 * panel that is two real columns rather than a form with a side card, and the
 * review card stops fitting beside the tuning rows below ~1000px.
 *
 * There is no theme panel: the theme follows the system and there is no in-app
 * switch (decision 4), so the command that used to open one is gone too.
 */
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
            panel === 'learn' ||
            panel === 'usage' ||
            panel === 'terminal' ||
            panel === 'settings'
              ? ' dialog-wide'
              : ''
          }${panel === 'files' ? ' dialog-files' : ''}${
            panel === 'memory' ? ' dialog-memory dialog-split' : ''
          }${panel === 'codeintel' ? ' dialog-memory' : ''}`}
          aria-label={t('topbar.commands')}
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
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
