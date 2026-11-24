/**
 * The window's one `TerminalHostManager`, wired to the real host registry, the
 * real xterm and the interface copy. Outside React: nothing here is created or
 * torn down by a component.
 */
import { makeT } from '@/i18n';
import { TerminalHostManager, workspaceHosts } from '@/workspaceHost';
import { createXtermView } from './xtermView';

const t = makeT();

export const terminalHosts = new TerminalHostManager({
  clientFor: (target) => workspaceHosts.clientFor(target),
  createView: createXtermView,
  notices: {
    gap: () => t('dock.term.note.gap'),
    exited: (code) => (code === null ? t('dock.term.note.exitedNoCode') : t('dock.term.note.exited', { code })),
    hostLost: () => t('dock.term.note.hostLost'),
  },
});
