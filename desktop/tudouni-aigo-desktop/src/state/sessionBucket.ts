/**
 * A fresh session bucket, and quiet mode's starting value.
 *
 * Moving this out of `store.ts` is what lets the type module stay free of the
 * preferences module, and it is also the one place a new session's defaults are
 * written down.
 */
import { LOCAL_CONNECTION_STATE, type LaunchArgs, type QuietMode, type SessionRuntime } from './types';


export function createSessionBucket(
  key: string,
  workspace: string,
  launch: LaunchArgs,
  remoteWorkspaceId: string | null = null,
): SessionRuntime {
  return {
    key,
    sessionId: null,
    workspace,
    openedAt: Date.now(),
    remoteWorkspaceId,
    connection: remoteWorkspaceId === null ? LOCAL_CONNECTION_STATE : { phase: 'connecting', problem: null },
    ready: false,
    problem: null,
    stderrTail: [],
    runtimeExit: null,
    launch,
    runtimeBuild: null,
    session: null,
    learning: false,
    refineTaskId: null,
    refineCandidates: null,
    hasSpoken: false,
    lastTurnMs: null,
    liveCall: null,
    entries: [],
    restoredTurns: 0,
    handshakeNotices: [],
    notesReadCount: 0,
    activeRunId: null,
    lastRunId: null,
    dropped: 0,
    lateDropped: 0,
    unseen: false,
    uiState: null,
    status: null,
    context: null,
    contextMsg: null,
    compaction: null,
    tools: [],
    toolRegistry: [],
    grantedPrefixes: [],
    mcp: [],
    mcpNotes: [],
    mcpPending: [],
    skills: [],
    skillAvailable: [],
    skillActive: [],
    skillCatalog: [],
    skillProblems: [],
    skillShadowed: [],
    models: [],
    modelAliases: [],
    // Terminals belong to the workspace, but "what this child told me" is the
    // only thing a bucket can hold — see the field's own comment.
    terminals: [],
    ssh: [],
    activeTerminalId: null,
    terminalTails: {},
    terminalPending: [],
    terminalClosing: [],
    filesPath: '',
    filesEntries: [],
    filesLoading: false,
    filesProblem: null,
    fileView: null,
    memory: null,
    memoryProblem: null,
    codeintel: null,
    codeintelProblem: null,
    probeEffort: null,
    probeEffortAt: null,
    probeEffortStartedAt: null,
    probeEffortProblem: null,
    draft: '',
    history: [],
    historyCursor: null,
    composerNotice: null,
    pastedImages: [],
    attachedFiles: [],
    quiet: prefsQuietDefault(),
  };
}

/** Quiet mode's starting value for a fresh session. A preference, read once. */
function prefsQuietDefault(): QuietMode {
  try {
    const raw = localStorage.getItem('aigo.prefs');
    if (!raw) return 'off';
    const quiet = (JSON.parse(raw) as { quiet?: unknown }).quiet;
    // Same legacy rule as `prefs.ts`: a boolean record predates the three
    // states, and its `true` meant the mode was on — that is `normal`.
    return quiet === 'normal' || quiet === 'simple' ? quiet : quiet === true ? 'normal' : 'off';
  } catch {
    return 'off';
  }
}
