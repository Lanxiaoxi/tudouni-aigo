/**
 * The workspace filter shared by the session board and the Ticket board.
 *
 * **The key is `savedSessionsKey`, not a path.** A local `/srv/app` and a remote
 * `/srv/app` are two places (see `savedSessionsKey.ts`), and a filter keyed by
 * the path string would put both under one option. Using the same key the
 * saved-session map uses means a session card and a Ticket that ran in it can
 * never disagree about which option they belong to.
 *
 * Pure so both boards' options can be asserted without a window.
 */
import { savedSessionsKey } from '@/state/savedSessionsKey';
import type { TaskWorkspaceRef } from '@/task/tasks';
import type { Ticket } from '@/ticket/model';
import { baseName } from '@/utils/format';

/** One workspace as the filter shows it. `title` is the full place, for the
 *  tooltip and for telling two same-named directories apart. */
export interface WorkspaceScope {
  key: string;
  label: string;
  title: string;
}

/** The filter's "no filter" value. Never a real key: `savedSessionsKey` of an
 *  empty path is `''` too, so the empty place is keyed `NO_WORKSPACE` instead. */
export const ALL_WORKSPACES = '*';
const NO_WORKSPACE = '';

/** The scope of a place given as path + machine. An empty path is the
 *  "nowhere yet" scope (a child still waiting for its handshake, or a Ticket
 *  made against an empty screen). */
export function workspaceScopeOf(
  path: string,
  remoteWorkspaceId: string | null,
  remoteLabels: ReadonlyMap<string, string>,
): WorkspaceScope {
  if (remoteWorkspaceId !== null) {
    const label = remoteLabels.get(remoteWorkspaceId) ?? (baseName(path) || path || remoteWorkspaceId);
    return { key: savedSessionsKey(path, remoteWorkspaceId), label, title: path === '' ? label : `${label} · ${path}` };
  }
  if (path.trim() === '') return { key: NO_WORKSPACE, label: '', title: '' };
  return { key: savedSessionsKey(path, null), label: baseName(path) || path, title: path };
}

/**
 * Where a Ticket belongs, for filtering.
 *
 * The latest Assignment wins when it recorded a place: a Ticket written against
 * "the workspace on screen" has no fixed answer of its own, and once it has run
 * somewhere that is where its work is. Before that the ref decides, and
 * `active` means the screen — which is also what the card's own chip says.
 */
export function ticketWorkspaceScope(
  ticket: Ticket,
  screenWorkspace: string,
  screenRemoteId: string | null,
  remoteLabels: ReadonlyMap<string, string>,
): WorkspaceScope {
  const last = ticket.assignments[ticket.assignments.length - 1];
  if (last !== undefined) {
    const { remoteWorkspaceId, workspace } = last.executor;
    if (remoteWorkspaceId !== null) return workspaceScopeOf(workspace ?? '', remoteWorkspaceId, remoteLabels);
    if (workspace !== undefined && workspace.trim() !== '') return workspaceScopeOf(workspace, null, remoteLabels);
  }
  return refScope(ticket.workspace, screenWorkspace, screenRemoteId, remoteLabels);
}

function refScope(
  ref: TaskWorkspaceRef,
  screenWorkspace: string,
  screenRemoteId: string | null,
  remoteLabels: ReadonlyMap<string, string>,
): WorkspaceScope {
  if (ref.kind === 'active') return workspaceScopeOf(screenWorkspace, screenRemoteId, remoteLabels);
  if (ref.kind === 'local') return workspaceScopeOf(ref.path, null, remoteLabels);
  return workspaceScopeOf('', ref.id, remoteLabels);
}

/**
 * The options, one per distinct key, sorted by label. Two options that would
 * read the same (two `app` directories) fall back to their full place, so the
 * list never offers two identical rows that filter differently.
 */
export function workspaceOptions(scopes: readonly WorkspaceScope[]): WorkspaceScope[] {
  const byKey = new Map<string, WorkspaceScope>();
  for (const scope of scopes) if (!byKey.has(scope.key)) byKey.set(scope.key, scope);
  const unique = [...byKey.values()];
  const seen = new Map<string, number>();
  for (const scope of unique) seen.set(scope.label, (seen.get(scope.label) ?? 0) + 1);
  return unique
    .map((scope) => ((seen.get(scope.label) ?? 0) > 1 && scope.title !== '' ? { ...scope, label: scope.title } : scope))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The filter value actually in force: a chosen workspace that no longer has
 *  anything on the board falls back to "all", so a filter can never leave the
 *  board empty with no option on screen that explains why. */
export function effectiveWorkspaceFilter(chosen: string, options: readonly WorkspaceScope[]): string {
  return chosen !== ALL_WORKSPACES && options.some((o) => o.key === chosen) ? chosen : ALL_WORKSPACES;
}
