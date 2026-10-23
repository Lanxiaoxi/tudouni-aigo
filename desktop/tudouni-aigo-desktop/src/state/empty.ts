/**
 * Shared empty values.
 *
 * zustand compares a selector's output by identity, so a selector that returns
 * `x ?? []` allocates a new array on every read, never compares equal, and
 * re-renders for ever without committing — a blank screen rather than an error.
 * These constants are the stable fallbacks; every one of them is read-only by
 * convention (never push into one).
 */
import type { Entry, NoteEntry } from '@/state/entries';
import type { VmInitTool, VmMcp, VmModel, VmSkill } from '@/runtime/adapt';
import type { AttachedFile, PastedImage } from '@/runtime/paste';
import type { FileEntry, ModelAlias, TerminalRow } from '@/protocol/types';
import type { SavedSessions } from './store';


export const NO_ENTRIES: Entry[] = [];
export const NO_NOTES: NoteEntry[] = [];
export const NO_STRINGS: string[] = [];
/**
 * The saved-session list for a workspace nothing has been heard about yet.
 *
 * A shared constant for the usual reason: `selectSavedSessions` returns an
 * object, and a fresh `{ items: [] }` per call never compares equal under
 * zustand's identity comparison — the rail would re-render forever and never
 * commit, which shows up as an empty screen rather than an error.
 *
 * `listed: false` is the honest value: no runtime has answered for this
 * workspace, and that is a different statement from "this workspace has no saved
 * sessions", which is `listed: true` with an empty list.
 */
export const NO_SAVED_SESSIONS: SavedSessions = {
  workspace: '',
  remoteWorkspaceId: null,
  items: [],
  active: [],
  listed: false,
};
/** The empty terminal list, for the same reason: a selector's fallback must be
 *  a stable reference or every render of an empty workspace is a new frame. */
export const NO_TERMINALS: TerminalRow[] = [];
/** No file listing yet. Same rule as above. */
export const NO_FILE_ENTRIES: FileEntry[] = [];
/** No terminal output yet. Same rule as above. */
export const NO_OUTPUT: string[] = [];
export const NO_SKILLS: VmSkill[] = [];
export const NO_MCP_ROWS: VmMcp[] = [];
export const NO_PASTED: PastedImage[] = [];
export const NO_ATTACHED: AttachedFile[] = [];
export const NO_INIT_TOOLS: VmInitTool[] = [];
export const NO_MODEL_ROWS: VmModel[] = [];
export const NO_ALIASES: ModelAlias[] = [];
