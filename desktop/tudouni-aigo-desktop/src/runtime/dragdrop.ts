/**
 * Dropped files, decided as pure functions.
 *
 * The whole drop feature rests on one fact about this runtime: **a path is the
 * only channel a picture travels on.** `internal/runtime/images.go` scans the
 * user's sentence for path-shaped words (`content.FindImagePaths`), stores what
 * resolves, and attaches it. There is no upload command and no markup, so a drop
 * can only ever do one thing — put the path into the sentence.
 *
 * Why "inside the workspace" is checked here at all: the file tools' boundary is
 * the workspace (`paths.WorkspaceDir()`), so a path outside it is one the runtime
 * cannot resolve. Inserting it would put a word in the sentence that quietly does
 * nothing, and the reader would believe their file was sent.
 */

/** The workspace boundary, as the file tools understand it. */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Is `path` the workspace itself, or under it?
 *
 * Case-insensitive because this app ships for windows/amd64 and linux/amd64, and
 * the Windows filesystem is case-insensitive — refusing `C:\Work\a.png` when the
 * workspace is `c:\work` would be a false rejection of a file the runtime can
 * read perfectly well. The cost of the loose direction is bounded: a path that
 * slips through is inserted as *text*, and the runtime treats an unresolvable
 * word as a word (`images.go`: it is "a word in a sentence until it resolves").
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
  /** Paths the runtime can resolve from this workspace, in drop order. */
  accepted: string[];
  /** Paths it cannot, kept so the reason can name them. */
  rejected: string[];
  /** True when there was no workspace to compare against. */
  unknownWorkspace: boolean;
}

export function partitionDrop(paths: string[], workspace: string): DropOutcome {
  const accepted: string[] = [];
  const rejected: string[] = [];
  if (normalize(workspace) === '') {
    return { accepted, rejected: paths, unknownWorkspace: true };
  }
  for (const path of paths) {
    if (isInsideWorkspace(path, workspace)) accepted.push(path);
    else rejected.push(path);
  }
  return { accepted, rejected, unknownWorkspace: false };
}

/**
 * Add the accepted paths to the draft.
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
