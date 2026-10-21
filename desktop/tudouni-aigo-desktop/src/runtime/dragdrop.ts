/**
 * Dropped files, decided as pure functions.
 *
 * The whole drop feature rests on one fact about this runtime: **a path is the
 * only channel a picture travels on.** `internal/runtime/images.go` scans the
 * user's sentence for path-shaped words (`content.FindImagePaths`), stores what
 * resolves, and attaches it. There is no upload command and no markup, so a drop
 * can only ever do one thing — put the path into the sentence.
 *
 * Every path is inserted, inside or outside the workspace. The outside ones are
 * **flagged, not refused**: a path outside the workspace is still text the model
 * can use — the file tools (`SafePath`) refuse it, but the model can reach it
 * through `shell`, which goes through the approval gate. Refusing the drop
 * outright would throw away a path the user deliberately put here, and the
 * runtime's own picture channel would have swallowed it silently anyway — the
 * flag exists so the reader knows the direct read will not work.
 */

/** The workspace boundary, as the file tools understand it. */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Is `path` the workspace itself, or under it?
 *
 * Case-insensitive because this app ships for windows/amd64 and linux/amd64, and
 * the Windows filesystem is case-insensitive — flagging `C:\Work\a.png` when the
 * workspace is `c:\work` would be a false warning about a file the runtime can
 * read perfectly well.
 */
export function isInsideWorkspace(path: string, workspace: string): boolean {
  const w = normalize(workspace);
  if (w === '') return false;
  const p = normalize(path);
  if (p === '') return false;
  const a = p.toLowerCase();
  const b = w.toLowerCase();
  return a === b || a.startsWith(`${b}/`);
}

export interface DropOutcome {
  /** All dropped paths, in drop order. */
  inserted: string[];
  /** The ones outside the workspace, kept so the notice can name them. */
  outside: string[];
  /** True when there was no workspace to compare against. */
  unknownWorkspace: boolean;
}

export function partitionDrop(paths: string[], workspace: string): DropOutcome {
  const inserted = [...paths];
  if (normalize(workspace) === '') {
    return { inserted, outside: paths, unknownWorkspace: true };
  }
  const outside = paths.filter((path) => !isInsideWorkspace(path, workspace));
  return { inserted, outside, unknownWorkspace: false };
}

/**
 * Add the dropped paths to the draft.
 *
 * Appended rather than inserted at the caret: the textarea holds the caret and
 * this runs from an event that has no access to it, and a path is a complete
 * token — putting it at the end cannot cut a word in half. Separated by a space
 * so it stays one word to the runtime's own path scanner.
 */
export function appendPaths(draft: string, paths: string[]): string {
  if (paths.length === 0) return draft;
  const joined = paths.join(' ');
  if (draft === '') return `${joined} `;
  return /\s$/.test(draft) ? `${draft}${joined} ` : `${draft} ${joined} `;
}
