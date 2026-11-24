/**
 * The Workspace Host client: protocol types, one client per workspace, and the
 * per-workspace connection store. Import from here, not from the files.
 */
export * from './protocol';
export { decodeBase64, encodeBase64 } from './base64';
export {
  IDLE_CONNECTION,
  type HostConnectionParams,
  type HostConnectionState,
  type HostExitInfo,
  type WorkspaceConnection,
  type WorkspaceTarget,
} from './connection';
export {
  HostRequestError,
  WorkspaceHostClient,
  type FsReadBytesResult,
  type HostClientOptions,
  type HostDisconnectInfo,
  type RequestOptions,
  type TermAttachResult,
  type TermExitEvent,
  type TermGapEvent,
  type TermOutputEvent,
} from './client';
export {
  WorkspaceHostRegistry,
  createWorkspaceHostStore,
  selectConnection,
  useWorkspaceConnection,
  workspaceHosts,
  workspaceHostStore,
  type WorkspaceHostState,
  type WorkspaceHostStore,
  type WorkspaceHostRegistryOptions,
} from './registry';
export { TermStream, noticeLine, type ByteSink, type OutputOutcome } from './termStream';
export {
  TerminalHostManager,
  type TermHostClient,
  type TermNotices,
  type TermSize,
  type TermView,
  type TerminalHostManagerOptions,
  type TerminalInfo,
  type ViewFactory,
} from './terminalHostManager';
export { activeHostTarget, activeWorkspaceIdOf, hostTargetOfSession } from './target';
export { localWorkspaceId, workspaceIdOf } from './workspaceId';
export { isHostAvailable } from './tauri';
export type { HostAttachRequest, HostAttachResponse, HostLineHandlers, HostTransport } from './transport';
