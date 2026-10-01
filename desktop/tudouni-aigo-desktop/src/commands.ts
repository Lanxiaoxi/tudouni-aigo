/**
 * The command table.
 *
 * **19 commands**, in learning order — that order is fixed here and the UI must
 * not re-sort it.
 *
 * It is not 20 because `/theme` is gone (decision 4): the native spec requires
 * exactly one theme source with no in-app switch, and `init` carries no theme
 * list either. The runtime's `--theme` flag is the *TUI's* colour scheme and has
 * nothing to do with this window; it is deliberately not wired in.
 *
 * The two workspace commands come last because they are the newest things a
 * person can ask for, and the order above them is the order people learned.
 *
 * The "capability list" (keys) is not a command table: those live in
 * `hooks/useGlobalKeys.ts` and in each panel.
 */

import { activeRuntime, useApp } from '@/state/store';
import type { TKey } from '@/i18n';
export interface CommandDef {
  id: string;
  /** The literal name, always leading with `/`. */
  name: string;
  descKey: TKey;
  /** Whether an argument can be supplied in the palette itself. */
  takesArg?: boolean;
  /** Display-only hint for the argument. */
  argHint?: string;
}

export const COMMANDS: CommandDef[] = [
  { id: 'new', name: '/new', descKey: 'cmd.new.desc' },
  { id: 'resume', name: '/resume', descKey: 'cmd.resume.desc' },
  { id: 'audit', name: '/audit', descKey: 'cmd.audit.desc' },
  { id: 'exit', name: '/exit', descKey: 'cmd.exit.desc' },
  { id: 'help', name: '/help', descKey: 'cmd.help.desc' },
  { id: 'skills', name: '/skills', descKey: 'cmd.skills.desc' },
  { id: 'autopilot', name: '/autopilot', descKey: 'cmd.autopilot.desc' },
  { id: 'quiet', name: '/quiet', descKey: 'cmd.quiet.desc' },
  { id: 'status', name: '/status', descKey: 'cmd.status.desc' },
  { id: 'tools', name: '/tools', descKey: 'cmd.tools.desc' },
  { id: 'context', name: '/context', descKey: 'cmd.context.desc' },
  { id: 'compact', name: '/compact', descKey: 'cmd.compact.desc' },
  {
    id: 'model',
    name: '/model',
    descKey: 'cmd.model.desc',
    takesArg: true,
    argHint: 'provider/model',
  },
  { id: 'thinking', name: '/thinking', descKey: 'cmd.thinking.desc', takesArg: true, argHint: 'on|off' },
  { id: 'effort', name: '/effort', descKey: 'cmd.effort.desc', takesArg: true, argHint: 'low|medium|high|…' },
  {
    id: 'mcp',
    name: '/mcp',
    descKey: 'cmd.mcp.desc',
    takesArg: true,
    argHint: 'load <name>|unload <name>',
  },
  { id: 'goal', name: '/goal', descKey: 'cmd.goal.desc', takesArg: true, argHint: 'pause|resume|clear' },
  { id: 'files', name: '/files', descKey: 'cmd.files.desc' },
  { id: 'terminal', name: '/terminal', descKey: 'cmd.terminal.desc' },
];

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

/** Prefix filter, not fuzzy: the palette's contract is a prefix match. */
export function filterCommands(input: string): CommandDef[] {
  const q = input.trim().replace(/^\//, '').toLowerCase();
  if (q === '') return COMMANDS;
  return COMMANDS.filter((c) => c.name.slice(1).toLowerCase().startsWith(q));
}

export function lookup(input: string): { cmd: CommandDef; arg: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const [head, ...rest] = trimmed.split(/\s+/);
  const cmd = BY_NAME.get(head);
  if (!cmd) return null;
  return { cmd, arg: rest.join(' ').trim() };
}

/* ============================================================
   Dispatch
   ============================================================ */

export function runCommand(id: string, arg?: string): void {
  const s = useApp.getState();
  s.openPanel(null);

  switch (id) {
    case 'new':
      // No sentinel: a missing session id *is* "a new session". With one
      // process per conversation this **opens** one rather than switching a
      // running session, so whatever is already working keeps working.
      void s.openSession(null);
      break;

    case 'resume':
      s.openPanel('resume');
      break;

    case 'audit':
      s.openPanel('audit');
      break;

    case 'exit':
      // The same path as `Ctrl+C`: the bridge's shutdown, which marks the exit
      // as requested and then closes the window. A bare `shutdown` protocol
      // message left `requested` false, so quitting reported itself to the
      // person as a red "Runtime exited (code 0)" crash.
      void s.quit();
      break;

    case 'help':
      s.openPanel('help');
      break;

    case 'skills':
      s.openPanel('skills');
      break;

    case 'autopilot':
      // Absolute state, never a toggle sent blind: read the runtime's answer —
      // for **this** session, since autopilot is one of the flags a session
      // carries rather than a mode the window is in.
      s.setAutopilot(!(activeRuntime(s)?.uiState?.autopilot ?? false));
      break;

    case 'quiet':
      s.toggleQuiet();
      break;

    case 'status':
      s.requestBlock('status');
      break;

    case 'tools':
      s.requestBlock('tools');
      break;

    case 'context':
      s.requestBlock('context');
      break;

    case 'compact':
      s.requestBlock('compact');
      break;

    case 'model':
      if (arg) s.chooseModel(arg);
      else s.openPanel('model');
      break;

    case 'thinking':
      if (arg === 'on' || arg === 'off') s.setThinking(arg === 'on');
      else s.setThinking(!(activeRuntime(s)?.session?.thinking ?? false));
      break;

    case 'effort':
      if (arg) s.chooseEffort(arg);
      else s.openPanel('effort');
      break;

    case 'mcp': {
      if (arg) {
        const [action, name] = arg.split(/\s+/);
        if ((action === 'load' || action === 'unload') && name) {
          // The servers to act on go in an array, not a single `name`.
          s.requestMcp(action, [name]);
          return;
        }
      }
      s.openPanel('mcp');
      break;
    }

    case 'goal': {
      if (arg === 'pause' || arg === 'resume' || arg === 'clear') {
        s.goalAction(arg);
        return;
      }
      // No argument: show the state, and make sure the goal block is visible
      // and open so the answer is actually on screen.
      s.goalAction();
      s.setSidebarVisible(true);
      if (s.blockCollapsed.goal) s.toggleBlock('goal');
      break;
    }

    case 'files':
      // No argument form. The panel is a browser whose path is a **state** it
      // walks, not a parameter: `/files src/main.go` would have to decide
      // whether it names a directory to list or a file to open, and the runtime
      // answers that question better than a guess here (a path that is a file
      // produces a visible refusal from `file_list`).
      s.openPanel('files');
      break;

    case 'terminal':
      s.openPanel('terminal');
      break;

    default:
      break;
  }
}
