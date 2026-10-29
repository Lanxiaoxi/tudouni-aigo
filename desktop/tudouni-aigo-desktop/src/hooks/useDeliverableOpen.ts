import { useState } from 'react';
import { useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import {
  downloadDeliverable,
  isHosted,
  openDeliverable,
  openLocalDeliverable,
} from '@/runtime/tauri';
import type { Deliverable } from '@/state/entries';

/** What an open gesture for one file is doing right now. */
export type DeliverablePhase = 'opening' | 'error';

export interface DeliverableOpener {
  /** Per file, keyed by path. Absent means "not doing anything". */
  phase: Record<string, DeliverablePhase>;
  /** The failure sentence, per file. Only present while `phase[path] === 'error'`. */
  problem: Record<string, string>;
  /**
   * The local copy of a **remote** file, per path, once it has been pulled
   * down. `undefined` (absent) is "not downloaded yet", which is what turns the
   * control into a download rather than an open.
   */
  copied: Record<string, string | null>;
  /** Open one file in the OS default application, downloading it first if remote. */
  open: (file: Deliverable) => void;
  /** Drop this file's state — a dismissal, or the end of a success. */
  dismiss: (file: Deliverable) => void;
}

/**
 * The one gesture both surfaces share: **open this file in its default app**.
 *
 * The transcript's card and the rail's file row are two ways to ask the same
 * question, so they go through the same door rather than each re-deciding what
 * "open" means. That door has three cases, and only the first is obvious:
 *
 *   - **local** — hand the absolute path to `deliverable_open`; Rust re-checks
 *     the workspace boundary (see that command's own note).
 *   - **remote** — there is no path on this machine yet, so pull the file down
 *     (`deliverable_download`, keyed by the child) and open the local copy. The
 *     second press serves the cache instead of downloading again.
 *   - **no Tauri host** — the state is knowable up front, so it is asked up
 *     front and the sentence says what a person can still do (preview here),
 *     rather than showing a `TypeError` about `invoke` written for whoever
 *     maintains this file.
 *
 * State is per **component instance**, keyed by path: a card group and the rail
 * block are independent surfaces, and two files in either are independent
 * gestures.
 */
export function useDeliverableOpen(): DeliverableOpener {
  const t = useT();
  const workspace = useSessionField((rt) => rt.workspace, '');
  // A non-null id is the split that decides which door the open uses: the
  // session's own field, never a guess from the shape of `workspace` (a remote
  // path can look like a local one, and the rule the connection state follows
  // is that the UI does not re-derive "is this remote").
  const remoteWorkspaceId = useSessionField((rt) => rt.remoteWorkspaceId, null);
  // The child's key, for the remote doors: they are keyed by the child rather
  // than by connection parameters, so the destination is the one the bridge
  // started the session through.
  const childKey = useSessionField((rt) => rt.key, '');
  const [phase, setPhase] = useState<Record<string, DeliverablePhase>>({});
  const [problem, setProblem] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<Record<string, string | null>>({});

  async function openCopy(file: Deliverable, localPath: string) {
    setPhase((current) => ({ ...current, [file.path]: 'opening' }));
    try {
      await openLocalDeliverable(localPath);
      clear(file);
    } catch (err) {
      fail(file, err);
    }
  }

  function open(file: Deliverable) {
    void (async () => {
      if (!isHosted()) {
        fail(file, t('deliverable.noHost'));
        return;
      }
      // Remote door: download first, open the copy second. The two are one
      // gesture here — the control means "get me the file" — and the copied map
      // is what turns the second press into an instant open.
      if (remoteWorkspaceId !== null) {
        const existing = copied[file.path];
        if (existing !== null && existing !== undefined) {
          await openCopy(file, existing);
          return;
        }
        setPhase((current) => ({ ...current, [file.path]: 'opening' }));
        try {
          const downloaded = await downloadDeliverable(childKey, file.path);
          setCopied((current) => ({ ...current, [file.path]: downloaded.path }));
          await openCopy(file, downloaded.path);
        } catch (err) {
          fail(file, err);
        }
        return;
      }
      setPhase((current) => ({ ...current, [file.path]: 'opening' }));
      try {
        await openDeliverable(workspace, file.path);
        clear(file);
      } catch (err) {
        fail(file, err);
      }
    })();
  }

  function fail(file: Deliverable, err: unknown) {
    // The failure **stays on the surface** rather than becoming a toast: it is
    // about this file, and a sentence that floats away leaves the control
    // looking like a button that does nothing.
    //
    // The message is passed through **verbatim**: it comes from Rust, it names
    // the file, and it is the one sentence that can say *why*.
    setPhase((current) => ({ ...current, [file.path]: 'error' }));
    setProblem((current) => ({ ...current, [file.path]: String(err) }));
  }

  function clear(file: Deliverable) {
    // Success clears in place. There is no success sentence to show: the OS
    // brought a window forward, and saying "opened" would be telling the person
    // about something they are already looking at.
    forget(file);
  }

  function forget(file: Deliverable) {
    setPhase((current) => {
      const next = { ...current };
      delete next[file.path];
      return next;
    });
    setProblem((current) => {
      const next = { ...current };
      delete next[file.path];
      return next;
    });
  }

  return { phase, problem, copied, open, dismiss: forget };
}
