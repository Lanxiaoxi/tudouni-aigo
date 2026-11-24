/**
 * What each Dock region may draw, decided from the capability table
 * (docs/design/workspace-dock.md §8.1, stage 5 "empty states by capability").
 *
 * The Dock never asks the host whether something works and then reports an
 * error: a missing capability is a *state of the region*, drawn as an empty
 * state. One pure function so the three modules cannot invent three different
 * answers for "not connected".
 */

/** The three booleans the framework looks at. The host's full table is
 *  structurally assignable to this, so callers pass it as it is. */
export interface DockCapabilities {
  files: boolean;
  git: boolean;
  terminal: boolean;
}

export type DockRegion = 'files' | 'git' | 'terminal';

/**
 * - `ready`          draw the module.
 * - `no-workspace`   no session is open, so there is nothing to bind to.
 * - `not-connected`  there is a workspace but no capability table: the host
 *                    has not answered (or has gone away).
 * - `unsupported`    connected, and this host says it cannot do this.
 */
export type RegionState = 'ready' | 'no-workspace' | 'not-connected' | 'unsupported';

export function regionState(
  hasWorkspace: boolean,
  capabilities: DockCapabilities | null | undefined,
  region: DockRegion,
): RegionState {
  if (!hasWorkspace) return 'no-workspace';
  if (!capabilities) return 'not-connected';
  return capabilities[region] === true ? 'ready' : 'unsupported';
}

/** Which capability the upper half needs in each mode. */
export function regionOfMode(mode: 'explorer' | 'git'): DockRegion {
  return mode === 'git' ? 'git' : 'files';
}
