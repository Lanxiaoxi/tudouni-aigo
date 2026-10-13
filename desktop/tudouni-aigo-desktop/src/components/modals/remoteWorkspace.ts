/**
 * The add-remote-workspace wizard's decisions, as pure functions.
 *
 * The wizard itself is a React dialog, and most of what is worth asserting about
 * it is *not* visible on the screen:
 *
 *   - **which saved host a new workspace should reuse** rather than duplicate —
 *     two records for one machine look identical in the sidebar and drift apart
 *     the moment one is edited;
 *   - **what a new `Host` block's fields are**, and specifically that a password
 *     is not among them: `Password` is this project's own extension rather than
 *     an OpenSSH keyword, so writing it would break the person's own `ssh` with
 *     `Bad configuration option: password` on **every** connection;
 *   - **whether a directory may be opened as a workspace at all** — the runtime
 *     refuses the home directory and the root, and it refuses them by exiting
 *     with code 2 *after* an SSH connection, an install and a spawn;
 *   - **what a row is labelled**, which falls back to the path's own name.
 *
 * Keeping these here rather than inline in the component is what makes them
 * assertable without a window — and this file is imported by both, so the
 * wizard cannot drift from what is tested.
 */

/** The host the wizard is about to connect to, before it has a saved id. */
export interface PendingHost {
  /** The name written in `~/.ssh/config` — also what a row is labelled with. */
  alias: string;
  /** The address a dial actually goes to. */
  host: string;
  port: number;
  user: string;
  identityFiles: string[];
}

/** The fields a saved host carries, as far as reuse is concerned. */
export interface SavedHostLike {
  id: string;
  host: string;
  port: number;
  user: string;
}

/**
 * Which saved host a workspace being added right now should point at, or `null`
 * when this is a host that has not been saved before.
 *
 * **Matched on `user@host:port`, not on the alias.** The alias is a label a
 * person chose, and the same machine is routinely reachable under two of them
 * (`prod` and `10.0.1.5`, say) — keying on it would save the host twice, and two
 * records for one machine drift the moment either is edited. The connection
 * triple is what a dial actually uses, so that is what identifies it.
 *
 * The port is compared numerically rather than as a string: `22` and `'22'` are
 * the same destination, and a form field handing back a string is exactly how a
 * duplicate gets created.
 */
export function findReusableHost(
  hosts: readonly SavedHostLike[],
  pending: Pick<PendingHost, 'host' | 'port' | 'user'>,
): SavedHostLike | null {
  const host = pending.host.trim();
  const user = pending.user.trim();
  return (
    hosts.find(
      (item) =>
        item.host.trim() === host &&
        item.user.trim() === user &&
        Number(item.port) === Number(pending.port),
    ) ?? null
  );
}

/**
 * The `Host` block written into `~/.ssh/config` for a new host.
 *
 * Returns the block's **lines**, so the caller (and this file's tests) can see
 * exactly what would be written rather than comparing one concatenated string
 * whose whitespace is an accident.
 *
 * Four rules, each of which is a way the person's own configuration could be
 * damaged or made unusable:
 *
 *   1. **No `Password` line, ever.** `Password` is not an OpenSSH keyword;
 *      writing it makes `ssh` fail to start at all, on every connection to every
 *      host in the file — not merely this one. A password this application needs
 *      is kept in its own preferences instead.
 *   2. **`Port` only when it is not 22.** The default is what OpenSSH already
 *      assumes, and a line that restates a default is a line somebody has to
 *      read to discover it says nothing.
 *   3. **One `IdentityFile` per line.** OpenSSH accumulates them across lines;
 *      several values on one line is not a form it reads the same way.
 *   4. **Nothing is written for an empty field.** A blank `User` that emitted
 *      `User ` would be a block whose meaning depends on a parser's whitespace
 *      handling.
 */
export function buildHostBlock(pending: PendingHost): string[] {
  const lines: string[] = [`Host ${pending.alias.trim()}`, `    HostName ${pending.host.trim()}`];
  if (Number(pending.port) !== 22) {
    lines.push(`    Port ${Number(pending.port)}`);
  }
  const user = pending.user.trim();
  if (user !== '') {
    lines.push(`    User ${user}`);
  }
  for (const key of pending.identityFiles) {
    const trimmed = key.trim();
    if (trimmed !== '') {
      lines.push(`    IdentityFile ${trimmed}`);
    }
  }
  return lines;
}

/**
 * A workspace row's label: the host's own name and the directory's last
 * segment, which is the most a sidebar row can say and still be readable.
 *
 * The path's last segment rather than the whole path, because a path is long
 * and a sidebar row is not — and the whole path is in the row's tooltip anyway.
 *
 * Two edge cases, both of which produce a label ending in a bare colon if they
 * are not handled, which reads as a truncated row:
 *
 *   - a path that ends in a slash (a trailing separator somebody typed) is the
 *     same directory, so the slash is trimmed before the segment is taken;
 *   - the root itself (`/`, or a path of nothing but slashes) has no last
 *     segment at all, so the path is used as the name. `host:/` is the honest
 *     label for "the whole filesystem", which is in any case refused as a
 *     workspace.
 */
export function workspaceLabel(alias: string, remotePath: string): string {
  const trimmed = remotePath.trim().replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  const name = index === -1 ? trimmed : trimmed.slice(index + 1);
  return `${alias.trim()}:${name === '' ? remotePath.trim() : name}`;
}

/**
 * Why the wizard's manual form cannot be submitted, as a **code** rather than a
 * sentence — the component turns it into words, because this project's interface
 * copy lives in one catalogue and a string built here would be a second one.
 *
 * The same validation is done again on the Rust side before anything is written;
 * this is a UI affordance (so the button can be disabled while the fields are
 * still incomplete), not the authority.
 */
export type NewHostProblem = 'incomplete' | 'badPort' | 'badName';

export function newHostProblem(draft: {
  alias: string;
  hostname: string;
  port: string;
  user: string;
}): NewHostProblem | null {
  if (draft.alias.trim() === '' || draft.hostname.trim() === '' || draft.user.trim() === '') {
    return 'incomplete';
  }
  const port = Number.parseInt(draft.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return 'badPort';
  }
  // A name that is not a usable `Host` pattern would be written into the file
  // and then either match nothing or match too much — `*` alone would apply the
  // block to every host in the file, which is a configuration change nobody
  // asked for.
  const alias = draft.alias.trim();
  if (/\s/.test(alias) || /[*?!#]/.test(alias)) {
    return 'badName';
  }
  return null;
}
