import { useApp } from '@/state/store';
import type { TKey } from '@/i18n';

/**
 * 命令表（desktop-ui-spec.md §8，18 条，顺序即学习顺序）。
 *
 * 顺序固定在这里，UI 不要自己重排 —— 这个顺序就是学习顺序。
 * 「能力清单」里的键位不是命令，走 hooks/useGlobalKeys.ts 与各面板自己处理。
 */

export interface CommandDef {
  id: string;
  /** 字面命令名，永远是 / 开头 */
  name: string;
  /** 说明 key */
  descKey: TKey;
  /** 是否能在同一处补参数（§5 命令面板） */
  takesArg?: boolean;
  /** 参数提示，仅用于展示 */
  argHint?: string;
}

export const COMMANDS: CommandDef[] = [
  { id: 'new', name: '/new', descKey: 'cmd.new.desc' },
  { id: 'resume', name: '/resume', descKey: 'cmd.resume.desc' },
  { id: 'audit', name: '/audit', descKey: 'cmd.audit.desc' },
  { id: 'exit', name: '/exit', descKey: 'cmd.exit.desc' },
  { id: 'help', name: '/help', descKey: 'cmd.help.desc' },
  { id: 'theme', name: '/theme', descKey: 'cmd.theme.desc', takesArg: true, argHint: 'system|dark|light' },
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
    argHint: 'deepseek-chat|reasoner|gpt-5.1|…',
  },
  { id: 'thinking', name: '/thinking', descKey: 'cmd.thinking.desc', takesArg: true, argHint: 'on|off' },
  {
    id: 'effort',
    name: '/effort',
    descKey: 'cmd.effort.desc',
    takesArg: true,
    argHint: 'low|medium|high|…',
  },
  { id: 'mcp', name: '/mcp', descKey: 'cmd.mcp.desc', takesArg: true, argHint: 'load <name>|unload <name>' },
  { id: 'goal', name: '/goal', descKey: 'cmd.goal.desc' },
];

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

/** 前缀过滤（非模糊）—— §5 命令面板明确要求前缀，不要改成模糊匹配 */
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
   执行
   ============================================================ */

export function runCommand(id: string, arg?: string): void {
  const s = useApp.getState();
  s.openPanel(null);

  switch (id) {
    case 'new':
      s.switchSession('__new__');
      break;

    case 'resume':
      s.openPanel('resume');
      break;

    case 'audit':
      s.openPanel('audit');
      break;

    case 'exit':
      s.send({ type: 'shutdown' });
      break;

    case 'help':
      s.openPanel('help');
      break;

    case 'theme':
      if (arg === 'dark' || arg === 'light' || arg === 'system') {
        s.setThemePref(arg);
      } else {
        s.openPanel('theme');
      }
      break;

    case 'skills':
      s.openPanel('skills');
      break;

    case 'autopilot':
      s.setAutopilot(!(s.permissionScope?.autopilot ?? false));
      break;

    case 'quiet':
      s.toggleQuiet();
      break;

    case 'status':
      s.requestStreamBlock('status');
      break;

    case 'tools':
      s.requestStreamBlock('tools');
      break;

    case 'context':
      s.requestStreamBlock('context');
      break;

    case 'compact':
      s.requestStreamBlock('compact');
      break;

    case 'model':
      if (arg) s.chooseModel(arg);
      else s.openPanel('model');
      break;

    case 'thinking':
      if (arg === 'on' || arg === 'off') s.setThinking(arg === 'on');
      else s.setThinking(!(s.session?.thinking ?? false));
      break;

    case 'effort':
      if (arg) s.chooseEffort(arg);
      else s.openPanel('effort');
      break;

    case 'mcp':
      if (arg) {
        const [action, name] = arg.split(/\s+/);
        if ((action === 'load' || action === 'unload') && name) {
          s.send({ type: 'mcp', action, name });
          return;
        }
      }
      s.openPanel('mcp');
      break;

    case 'goal': {
      // /goal 是「查看/控制长期目标」：把侧栏唤出来并保证目标块是展开的
      s.setSidebarVisible(true);
      if (s.blockCollapsed.goal) s.toggleBlock('goal');
      break;
    }

    default:
      break;
  }
}
