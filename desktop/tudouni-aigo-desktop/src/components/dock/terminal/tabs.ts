/**
 * Small pure rules of the tab strip, kept out of the component so they can be
 * asserted without rendering.
 */
import type { TerminalInfo } from '@/workspaceHost';

/** The file name of a shell path, either separator (`C:\Windows\pwsh.exe` → `pwsh.exe`). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

/** What a tab is called: the person's own name, else the shell plus the id so
 *  two shells of one kind can be told apart. */
export function tabName(info: Pick<TerminalInfo, 'id' | 'customName' | 'title' | 'shell'>): string {
  if (info.customName !== null) return info.customName;
  const base = baseName(info.title !== '' ? info.title : info.shell);
  return base === '' ? info.id : `${base} ${info.id}`;
}

/**
 * Which tab is active once `closing` is gone: unchanged when something else was
 * active; otherwise the neighbour to its right, else to its left, else none.
 */
export function pickAfterClose(
  terminals: readonly { id: string }[],
  closing: string,
  active: string | null,
): string | null {
  if (active !== closing) return active;
  const index = terminals.findIndex((x) => x.id === closing);
  const rest = terminals.filter((x) => x.id !== closing);
  if (rest.length === 0) return null;
  return (rest[Math.min(index, rest.length - 1)] ?? rest[rest.length - 1]!).id;
}
