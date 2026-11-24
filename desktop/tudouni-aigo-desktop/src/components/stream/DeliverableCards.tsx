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
import { useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { baseName } from '@/utils/format';
import { useDeliverableOpen } from '@/hooks/useDeliverableOpen';
import { revealWorkspaceFile } from '@/components/dock/dockActions';
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
  // The remote half also decides what the control *looks like* (a download
  // before the copy exists), so it is read here as well as inside the hook.
  const remoteWorkspaceId = useSessionField((rt) => rt.remoteWorkspaceId, null);
  // Per file, keyed by path: two cards in one turn are two independent gestures.
  const { phase, problem, copied, open, dismiss } = useDeliverableOpen();

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
              onClick={() => previewFile(file, open)}
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
 * Show one declared file in the Workspace Dock's Explorer (the old modal files
 * panel is gone): the Dock opens in Explorer mode with the file selected and
 * its parent directories expanded, and the Explorer's own viewer draws it, text
 * and pictures alike.
 *
 * The card holds whatever path the model wrote, absolute or workspace-relative;
 * `revealWorkspaceFile` converts it against the active workspace root. A file
 * **outside** the workspace has no row to select, so the card keeps the
 * behaviour it has for files that are not the workspace's to browse: the same
 * "open" door the button beside it uses (the OS default application, after a
 * download for a remote session).
 *
 * Exported so the routing can be asserted without a renderer.
 */
export function previewFile(file: Deliverable, openExternally: (file: Deliverable) => void) {
  if (revealWorkspaceFile(file.path)) return;
  openExternally(file);
}

/** The face of a card, chosen by extension. Exported because the rail's file
 *  row draws the same glyph — one file type should not have two icons depending
 *  on which surface happens to be showing it. */
export function FileGlyph({ path, size = 18 }: { path: string; size?: number }) {
  const ext = extensionOf(path);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return <FileImage size={size} />;
  if (['csv', 'tsv', 'xls', 'xlsx', 'ods'].includes(ext)) return <FileSpreadsheet size={size} />;
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return <Presentation size={size} />;
  if (
    ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'go', 'py', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'ps1', 'json', 'yaml', 'yml', 'toml'].includes(
      ext,
    )
  ) {
    return <FileCode size={size} />;
  }
  return <FileText size={size} />;
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
 *
 * Exported beside {@link FileGlyph}: the rail's file row falls back to the same
 * words for the same reason.
 */
export function extensionLabel(name: string, t: ReturnType<typeof useT>): string {
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
