import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { CommandPalette } from './CommandPalette';
import {
  AuditPanel,
  EffortPanel,
  HelpPanel,
  McpPanel,
  ModelPanel,
  ResumePanel,
  SkillsPanel,
  SubagentsPanel,
} from './panels';

/**
 * §5 Panel host.
 *
 * Every panel shares one container and one interaction model; only the command
 * palette is different — its input sits at the top and it hugs the top of the
 * window. Esc and clicking the overlay close, handled by the dialog primitive.
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
        if (!open) useApp.setState({ panel: null });
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content
          className={`dialog${panel === 'commands' ? ' cmdk' : ''}`}
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
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
