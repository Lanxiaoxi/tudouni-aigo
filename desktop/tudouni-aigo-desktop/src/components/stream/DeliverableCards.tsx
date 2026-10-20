import { useState } from 'react';
import {
  Download,
  ExternalLink,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Loader,
  Presentation,
  X,
} from 'lucide-react';
import { useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { baseName } from '@/utils/format';
import { isHosted, openDeliverable, openLocalDeliverable, downloadDeliverable } from '@/runtime/tauri';
import { isPicturePath } from '@/components/panels/panels';
import type { Deliverable } from '@/state/entries';

/**
 * The files a turn declared as its result, drawn as cards.
 *
 * **The card is a path, and it says so by doing nothing until it is pressed.**
 * `present` copies no content: what the runtime recorded is where the file is,
 * so the card can show a name and the model's own one-line note and nothing else.
 * Every fact about the bytes — size, line count, whether it is even text — is
 * whatever is true at the moment somebody opens it, which is why none of them are
 * on this component's props.
 *
 * Two actions, and they are genuinely different:
 *
 *   - **preview** opens the file in the workspace browser, which draws it through
 *     the same `FileBlock` the transcript uses. This is the one that works for
 *     anything the runtime can read as UTF-8 text — including, for a remote
 *     session, through the runtime's own `file_read`, which runs on the far
 *     host and therefore reaches remote files as well.
 *   - **open** hands the absolute path to the OS default application, through
 *     `deliverable_open` (Rust re-checks the boundary — see that command's own
 *     note). This is the one that works for a `.docx`, and the one this whole
 *     capability exists for.
 *
 * For a **remote** session the open is a two-step act the button absorbs:
 * first it pulls the file down (`deliverable_download` — the boundary is a
 * local `canonicalize`, which cannot reach the far host), and once the copy is
 * on this machine the button becomes "open the copy" (a second press serves
 * the cache without re-downloading, and a refresh control re-pulls it). The
 * card's single affordance stays "get me the file" — the two steps are an
 * implementation detail of *where* the file is, not a second thing to learn.
 *
 * The whole card is the preview target and the open control sits beside it, on
 * purpose: a card whose only affordance is "open in Word" is useless for the
 * `.md` a person wants to read first, and one whose only affordance is a text
 * preview is useless for the spreadsheet that is the actual deliverable.
 */
export function DeliverableCards({ files }: { files: Deliverable[] }) {
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
  // Per file, keyed by path: two cards in one turn are two independent gestures.
  const [phase, setPhase] = useState<Record<string, 'opening' | 'error'>>({});
  const [problem, setProblem] = useState<Record<string, string>>({});
  // The remote half, per file: where the local copy is, once it exists. `null`
  // (absent) means "not downloaded yet", which the button renders as a
  // download rather than as an open.
  const [copied, setCopied] = useState<Record<string, string | null>>({});

  async function open(file: Deliverable) {
    // **Checked before the call, not inferred from the failure.** With no Tauri
    // host the IPC import resolves to nothing and the throw is a `TypeError`
    // about `invoke` — a sentence written for whoever maintains this file, shown
    // to somebody who pressed a button. The state is knowable up front, so it is
    // asked up front and the card says what a person can do about it.
    if (!isHosted()) {
      setPhase((current) => ({ ...current, [file.path]: 'error' }));
      setProblem((current) => ({ ...current, [file.path]: t('deliverable.noHost') }));
      return;
    }
    // Remote door: download first, open the copy second. The two are one
    // gesture here — the button the person pressed means "get me the file" —
    // and the copied map is what turns the second press into an instant open.
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
  }

  /** The second half of a remote open: hand the local copy to the OS. */
  async function openCopy(file: Deliverable, localPath: string) {
    setPhase((current) => ({ ...current, [file.path]: 'opening' }));
    try {
      await openLocalDeliverable(localPath);
      clear(file);
    } catch (err) {
      fail(file, err);
    }
  }

  function fail(file: Deliverable, err: unknown) {
    // The failure **stays on the card** rather than becoming a toast. It is
    // about this file, and a sentence that floats away leaves the card looking
    // like a button that does nothing.
    //
    // The message is passed through **verbatim**: it comes from Rust, it names
    // the file, and it is the one sentence here that can say *why* — a sentence
    // this window composed instead would be a second opinion about a fact it
    // does not have.
    setPhase((current) => ({ ...current, [file.path]: 'error' }));
    setProblem((current) => ({ ...current, [file.path]: String(err) }));
  }

  function clear(file: Deliverable) {
    // Success clears in place. There is no success sentence to show: the OS
    // brought a window forward, and a card that also said "opened" would be
    // telling the person about something they are already looking at.
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

  function dismiss(file: Deliverable) {
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

  return (
    <ul className="dl-list" aria-label={t('deliverable.label')}>
      {files.map((file) => {
        const state = phase[file.path];
        const name = baseName(file.path);
        // The description is the model's note, and it is optional. When it is
        // absent the row falls back to the file type — which is the only other
        // thing actually known at declaration time, and is more useful than an
        // empty line.
        const note = file.description !== '' ? file.description : extensionLabel(name, t);
        return (
          <li key={file.path} className="dl-card">
            <button
              type="button"
              className="dl-face"
              // The full path, not just the name: the card shows a basename, and
              // "which one is this" is the question a hover is asking.
              title={file.path}
              aria-label={t('deliverable.preview', { name })}
              onClick={() => previewFile(file.path)}
            >
              <span className="dl-icon" aria-hidden>
                <FileGlyph path={file.path} />
              </span>
              <span className="dl-body">
                <span className="dl-name">{name}</span>
                <span className="dl-note" data-error={state === 'error' ? '' : undefined}>
                  {state === 'error' ? problem[file.path] : note}
                </span>
              </span>
            </button>

            {state === 'opening' ? (
              <span className="dl-busy" aria-hidden>
                <Loader size={12} className="dl-spin" />
              </span>
            ) : remoteWorkspaceId !== null && copied[file.path] === undefined ? (
              <Tip label={t('deliverable.download', { name })}>
                <button
                  type="button"
                  className="dl-open"
                  aria-label={t('deliverable.download', { name })}
                  onClick={() => void open(file)}
                >
                  <Download size={13} />
                </button>
              </Tip>
            ) : (
              <Tip label={t('deliverable.open', { name })}>
                <button
                  type="button"
                  className="dl-open"
                  aria-label={t('deliverable.open', { name })}
                  onClick={() => void open(file)}
                >
                  <ExternalLink size={13} />
                </button>
              </Tip>
            )}

            {state === 'error' ? (
              <Tip label={t('deliverable.dismiss')}>
                <button
                  type="button"
                  className="dl-dismiss"
                  aria-label={t('deliverable.dismiss')}
                  onClick={() => dismiss(file)}
                >
                  <X size={12} />
                </button>
              </Tip>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Send one declared file to the files panel and open it there, **in focus
 * mode** either way the file is drawn.
 *
 * The card is a request for one file, so the panel must not answer with a
 * browser: a card for a `.html` or a `.md` used to open onto the workspace's
 * directory listing above the file, the text twin of the picture regression
 * the focus flag exists to suppress. Both doors therefore ask for the flag;
 * the panel is opened by the callee, not here, because `openPanel` clears
 * `fileFocus` for any route that is not the one setting it — opening the panel
 * first and setting the flag afterwards left the flag false and drew the
 * directory listing anyway.
 *
 * **The doors differ in what they read, not in how they open.** `readFile`
 * speaks the runtime's `file_read`, which refuses anything that is not UTF-8 —
 * a PNG sent down it opens the panel onto "not UTF-8 text, so it cannot be
 * shown here", a true sentence about the wrong question: the runtime was never
 * able to draw it. `previewImage` reads the bytes through the desktop's own
 * command and hands the panel a `data:` URL instead.
 *
 * The path is sent **verbatim**, as the runtime spelled it. This window never
 * rewrites a path on its way to a `file_read`: the boundary and the normalisation
 * both belong to the process that holds them.
 *
 * The panel is a modal layer drawn over the transcript, so pressing this hides
 * the card until the panel is closed. That is the same trade the Files panel
 * already makes for every file it opens, and the read also lands in the stream as
 * a block — so the answer is still there afterwards, not only while the panel is
 * up.
 *
 * Exported for the test that pins the focus flag on the text door.
 */
export function previewFile(path: string) {
  const store = useApp.getState();
  if (isPicturePath(path)) {
    store.previewImage(path);
    return;
  }
  store.openPanel('files', true);
  store.readFile(path);
}

/** The face of a card, chosen by extension. */
function FileGlyph({ path }: { path: string }) {
  const ext = extensionOf(path);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return <FileImage size={18} />;
  if (['csv', 'tsv', 'xls', 'xlsx', 'ods'].includes(ext)) return <FileSpreadsheet size={18} />;
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return <Presentation size={18} />;
  if (
    ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'go', 'py', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'ps1', 'json', 'yaml', 'yml', 'toml'].includes(
      ext,
    )
  ) {
    return <FileCode size={18} />;
  }
  return <FileText size={18} />;
}

function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * The fallback note: what kind of file this is, as a person would say it.
 *
 * Not the raw extension in capitals. `MD` and `JSON` are identifiers a developer
 * reads fluently and a person who asked for "the report" does not, and this row
 * is the one place the card has to say *something* when the model wrote no note.
 * Known extensions get a word; anything else keeps its own name, because
 * inventing a category for an unknown extension would be guessing.
 */
function extensionLabel(name: string, t: ReturnType<typeof useT>): string {
  const ext = extensionOf(name);
  switch (ext) {
    case 'md':
    case 'markdown':
      return t('deliverable.kind.markdown');
    case 'pdf':
      return t('deliverable.kind.pdf');
    case 'csv':
    case 'tsv':
    case 'xls':
    case 'xlsx':
      return t('deliverable.kind.sheet');
    case 'doc':
    case 'docx':
      return t('deliverable.kind.document');
    case 'ppt':
    case 'pptx':
      return t('deliverable.kind.slides');
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
      return t('deliverable.kind.image');
    case '':
      return t('deliverable.kind.file');
    default:
      return ext.toUpperCase();
  }
}
