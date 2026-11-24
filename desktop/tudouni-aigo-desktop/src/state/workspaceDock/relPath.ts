/**
 * Turning a path somebody handed us (a deliverable card's, a transcript link)
 * into the workspace-relative form the Dock's Explorer is keyed by.
 *
 * Pure and string-only, like `normPath`: a workspace is a string the person
 * picked, and the runtime reports the same directory back possibly with the
 * other separator or another case, so the prefix test is made on the same
 * normal form. A path that does not end up inside the root answers `null`, and
 * the caller keeps whatever it did before the Dock existed (system open).
 */

/** `C:/x`, `C:\x`, `/x`, `\\host\share`: anything the OS would call absolute. */
function isAbsolute(p: string): boolean {
  return /^([a-zA-Z]:)?\//.test(p);
}

/** Resolve `.` and `..` segments; `null` when the path climbs above its start. */
function resolveSegments(rel: string): string | null {
  const out: string[] = [];
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/**
 * `path` relative to `root`, `/`-separated, or `null` when it is outside the
 * workspace or names the root itself (a directory, not a file to show).
 */
export function workspaceRelativePath(path: string, root: string): string | null {
  const p = path.trim().replace(/\\/g, '/');
  if (p === '') return null;

  let rel: string;
  if (isAbsolute(p)) {
    const r = root.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (r === '' && !root.trim().startsWith('/')) return null;
    const lowerP = p.toLowerCase();
    const prefix = `${r.toLowerCase()}/`;
    if (!lowerP.startsWith(prefix)) return null;
    rel = p.slice(prefix.length);
  } else {
    rel = p;
  }

  const resolved = resolveSegments(rel);
  return resolved === null || resolved === '' ? null : resolved;
}
