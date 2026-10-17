import { useState } from 'react';
import {
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
import { openDeliverable, isHosted } from '@/runtime/tauri';
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
 *     anything the runtime can read as UTF-8 text.
 *   - **open** hands the absolute path to the OS default application, through
 *     `deliverable_open` (Rust re-checks the boundary — see that command's own
 *     note). This is the one that works for a `.docx`, and the one this whole
 *     capability exists for.
 *
 * The whole card is the preview target and the open control sits beside it, on
 * purpose: a card whose only affordance is "open in Word" is useless for the
 * `.md` a person wants to read first, and one whose only affordance is a text
 * preview is useless for the spreadsheet that is the actual deliverable.
 */
export function DeliverableCards({ files }: { files: Deliverable[] }) {
  const t = useT();
  const workspace = useSessionField((rt) => rt.workspace, '');
  // Per file, keyed by path: two cards in one turn are two independent gestures.
  const [phase, setPhase] = useState<Record<string, 'opening' | 'error'>>({});
  const [problem, setProblem] = useState<Record<string, string>>({});

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
    setPhase((current) => ({ ...current, [file.path]: 'opening' }));
    try {
      await openDeliverable(workspace, file.path);
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
    } catch (err) {
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
 * Send one declared file to the workspace browser and open it there.
 *
 * The two store actions are called in this order for a reason: opening the panel
 * asks the runtime for the root listing, and reading the file right after only
 * sets the viewer's own state — so the panel comes up with a listing behind the
 * file rather than an empty one. Reversed, the panel would be built after the
 * read and would list the workspace root over a viewer that is already showing
 * something else.
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
 */
function previewFile(path: string) {
  const store = useApp.getState();
  store.openPanel('files');
  // **A picture takes a different door.** `readFile` speaks the runtime's
  // `file_read`, which refuses anything that is not UTF-8 — so pressing a card
  // for a PNG used to open the panel onto "not UTF-8 text, so it cannot be shown
  // here". That is a true sentence about the wrong question: the runtime was
  // never able to draw it. `previewImage` reads the bytes through the desktop's
  // own command and hands the panel a `data:` URL instead.
  if (isPicturePath(path)) {
    store.previewImage(path);
    return;
  }
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
