import { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { useT } from '@/i18n/useT';
import { useSessionField } from '@/state/store';
import { inlineImage } from '@/runtime/tauri';

/**
 * A picture in model output.
 *
 * ## What this is for
 *
 * A model that generates a picture hands back a **path** — the runtime has no
 * other channel for one (see `image_stash` in `src-tauri`). Before this
 * component the chat could only print that path: a WebView cannot load
 * `C:\…\out.png` as an `<img>`, so the person was told *where* the picture was
 * instead of being shown it. That is the one thing a chat window is for, so the
 * path is now resolved to bytes and drawn.
 *
 * ## Why it resolves through Rust rather than trusting the URL
 *
 * The address the model wrote is a **claim**. Only the `inline_image` command
 * decides what may be read: it takes the workspace, canonicalizes the target
 * against it, and refuses anything that escapes. So this component classifies
 * the destination first (see `imageIntent`) and hands a workspace-relative path
 * to that command — it never resolves a filesystem path itself.
 *
 * ## Why `data:` and not an object URL
 *
 * The command already has the bytes and base64 is what travels over IPC; turning
 * them into a `blob:` URL would add a second lifetime to manage (revoke on
 * unmount, and again on every re-render that re-resolves) for no gain. The CSP
 * allows both, and a `data:` URL survives being copied out of the window.
 *
 * ## The cache
 *
 * A resolved picture is remembered by (workspace, path) for the life of the
 * window. Entries are re-rendered constantly — scrolling, the turn rail, a
 * re-parse of the whole message text — and each unmount would otherwise ask for
 * the same base64 again, which for a five megabyte picture means moving it
 * across the IPC once per scroll. The bytes cannot change under a path without
 * the model writing the file again, and a stale picture is a far smaller problem
 * than a chat that stalls while scrolling past one.
 */

/** How a destination should be treated, decided from the string alone. */
type ImageIntent =
  /** A remote, inline, or already-resolved URL: draw it as authored. */
  | { kind: 'direct'; src: string }
  /** A workspace path: ask the bridge for the bytes. */
  | { kind: 'workspace'; path: string }
  /** Not drawable at all; `label` is what to show in its place, `''` for nothing. */
  | { kind: 'refused'; label: string; reason: 'unsupported' | 'empty' };

/**
 * Classify one authored Markdown image destination.
 *
 * All three arms are decided here rather than split between this function and
 * the component, because the interesting question — *what does the person see
 * when this cannot be drawn?* — depends on the same facts. Two of those facts
 * are not obvious:
 *
 * **A `file:` destination is refused, not resolved.** It names an absolute path
 * on this machine, which is exactly what the boundary exists to keep out of the
 * render path. It falls through to the refused arm, which shows the path as text
 * — the person can then decide what to do about it, and the model is not handed
 * a way to read the disk through the renderer.
 *
 * **A `data:` URL is refused unless it is an image type.** Nothing executes from
 * an `<img src>`, so this is belt and braces — but an `img` element is not the
 * place for a model-authored string of arbitrary media type.
 *
 * The display label is chosen by *usefulness*, not by availability: a path is
 * something a person can act on (open the workspace, ask again), while a
 * multi-kilobyte `data:` URL is noise — so the alt text wins there and the path
 * wins for the refusals that have one.
 */
function imageIntent(destination: string, alt: string): ImageIntent {
  const raw = destination.trim();
  const name = alt.trim();
  if (raw === '' && name === '') return { kind: 'refused', label: '', reason: 'empty' };
  if (raw === '') return { kind: 'refused', label: name, reason: 'empty' };

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    switch (scheme) {
      case 'data':
        return /^data:image\//i.test(raw)
          ? { kind: 'direct', src: raw }
          : { kind: 'refused', label: name || 'data:', reason: 'unsupported' };
      case 'blob':
        return { kind: 'direct', src: raw };
      default:
        // `file:` and every other scheme. The path still gets shown, because it
        // is the actionable half of this refusal.
        return { kind: 'refused', label: name && raw === '' ? name : raw, reason: 'unsupported' };
    }
  }

  // No scheme: it is a path, relative or absolute-provided-by-us. An absolute
  // one is left to the bridge, which is where the workspace boundary lives —
  // deciding it here would be a second copy of a rule that must not drift.
  const path = decodePath(raw) || name;
  if (path === '' || path.includes('\0')) {
    return { kind: 'refused', label: name, reason: 'unsupported' };
  }
  return { kind: 'workspace', path };
}

/**
 * Decode the percent-escapes a Markdown destination may carry.
 *
 * `out%20one.png` is one file whose name contains a space, and a path with a
 * literal `#` is written `%23` — the renderer has already split the fragment
 * off, so what is left is the path and nothing else. A malformed escape means
 * the destination is not a path this program can read, so it is refused rather
 * than passed through half-decoded.
 */
function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

const loadCache = new Map<string, string>();
/** Requests already in flight, so two rows asking at once share one read. */
const inFlight = new Map<string, Promise<string>>();

function cacheKey(workspace: string, path: string): string {
  // JSON rather than a separator that could appear in either half: a Windows
  // path contains a colon and may contain any character a filename allows.
  return JSON.stringify([workspace, path]);
}

function loadImage(workspace: string, path: string): Promise<string> {
  const key = cacheKey(workspace, path);
  const cached = loadCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;

  const request = inlineImage(workspace, path)
    .then((image) => {
      loadCache.set(key, image.url);
      return image.url;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

type LoadState =
  | { kind: 'waiting' }
  | { kind: 'ready'; src: string }
  /** Nothing to draw and nothing worth naming: `![]()` renders no element. */
  | { kind: 'empty' }
  /** Not drawable; `label` is the path (or name) worth showing, `reason` the why. */
  | { kind: 'unreadable'; label: string; reason: string };

/**
 * One picture, from a destination string to pixels.
 *
 * The three failure states are drawn differently on purpose:
 *
 * - **waiting** shows the alt text quietly, like a picture still loading;
 * - **unreadable** shows an icon and the path, because "the model said it made
 *   this and it is not there" is something the person can act on — they can ask
 *   for it again, or open the workspace;
 * - a picture that *is* readable but huge, or one whose format the renderer
 *   accepts but the bridge does not, lands in unreadable with the bridge's own
 *   sentence, which names the reason.
 */
export function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const t = useT();
  // The workspace the path is relative to. `session.workspace` is the runtime's
  // own `init.workspace`; before the handshake lands, `workspace` is the value
  // the front end started the child with, and either is a better answer than
  // guessing — an empty one makes every path unresolvable for that moment.
  const workspace = useSessionField((rt) => rt.session?.workspace ?? rt.workspace, '');
  const intent = imageIntent(src, alt);

  const [state, setState] = useState<LoadState>(() => {
    switch (intent.kind) {
      case 'refused':
        return intent.reason === 'empty'
          ? { kind: 'empty' }
          : { kind: 'unreadable', label: intent.label, reason: t('md.imageUnsupported') };
      case 'direct':
        return { kind: 'ready', src: intent.src };
      case 'workspace': {
        const cached = loadCache.get(cacheKey(workspace, intent.path));
        return cached === undefined ? { kind: 'waiting' } : { kind: 'ready', src: cached };
      }
    }
  });

  const destination = intent.kind === 'workspace' ? intent.path : null;

  useEffect(() => {
    if (destination === null) return;
    // A cached picture was already handled by the initial state; re-asking would
    // be the very round trip this check exists to avoid.
    if (loadCache.has(cacheKey(workspace, destination))) return;
    if (workspace === '') {
      setState({
        kind: 'unreadable',
        label: destination,
        reason: t('md.imageNoWorkspace'),
      });
      return;
    }

    let live = true;
    loadImage(workspace, destination).then(
      (resolved) => {
        if (live) setState({ kind: 'ready', src: resolved });
      },
      (error: unknown) => {
        if (!live) return;
        setState({
          kind: 'unreadable',
          label: destination,
          // The bridge's refusals are written for a person and name the reason,
          // so they are shown as they are. Anything else is this layer's own.
          reason: error instanceof Error && error.message !== ''
            ? error.message
            : t('md.imageFailed'),
        });
      },
    );
    return () => {
      live = false;
    };
  }, [workspace, destination, t]);

  if (state.kind === 'empty') return null;

  if (state.kind === 'ready') {
    return (
      <img
        className="md-img"
        src={state.src}
        alt={alt}
        // Decoded off the main thread: a pasted screenshot can be several
        // thousand pixels wide, and decoding it on the paint path stalls the
        // stream behind it.
        decoding="async"
        // No `loading="lazy"`: these are `data:` URLs already in memory, so
        // laziness saves no request, and it would let a picture stay blank until
        // it scrolled close to the viewport — including one the person is
        // looking at, right after it arrived.
        onError={() => {
          setState({ kind: 'unreadable', label: alt.trim(), reason: t('md.imageFailed') });
        }}
      />
    );
  }

  if (state.kind === 'waiting') {
    return alt.trim() === '' ? null : (
      <span className="md-img-alt">{alt}</span>
    );
  }

  return (
    <span className="md-img-broken" title={state.reason}>
      <ImageOff size={12} aria-hidden />
      <span className="md-img-broken-path">{state.label || alt.trim() || src}</span>
    </span>
  );
}
