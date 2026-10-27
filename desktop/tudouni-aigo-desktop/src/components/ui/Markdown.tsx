import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { useT } from '@/i18n/useT';
import { useSessionField } from '@/state/store';
import { copyText } from '@/utils/clipboard';
import { fenceLanguage, fenceLayout } from './fence';
import { MarkdownImage } from './MarkdownImage';
import { imageUrlTransform } from './imageUrl';
import { remarkFilePath } from './remarkFilePath';
import { openFilePath } from '@/runtime/tauri';

/**
 * Markdown rendering.
 *
 * react-markdown + remark-gfm. The renderer emits real React elements — there
 * is no `dangerouslySetInnerHTML` anywhere in the pipeline, so model output is
 * rendered as text nodes by construction and XSS never enters the picture.
 * Components are mapped to the plain tags the `.md` rules in `stream.css`
 * already style, so the switch from the hand-rolled renderer costs no CSS.
 * remark-gfm adds tables, strikethrough and task lists, which the models emit
 * often enough that hand-parsing them was the next item on the same list.
 * rehype-highlight syntax-colors fenced blocks with highlight.js; unknown or
 * unmarked blocks are left alone (`detect: false` is the default, and a
 * language tag that highlight does not know simply does not match). The token
 * colours live in `stream.css` under `.hljs` — the same One Dark hues the
 * terminal ANSI palette already uses, so a highlighted block reads like code
 * in the terminal next to it.
 *
 * **highlight.js is loaded out of band**, by [`useHighlight`], and until it
 * lands the plugin list simply does not include it: a fenced block paints
 * plain and picks up its colours a moment later, which is exactly what a
 * `font-display: swap` face already does for text. Everything else — the
 * `.md` container, tables, the fence bar, images — renders with no waiting,
 * because the find layer walks `.e-answer .md` the moment a row mounts and
 * the tests that assert that contract render this component synchronously.
 */

type Components = Parameters<typeof ReactMarkdown>[0]['components'];
type Highlight = typeof import('rehype-highlight').default;

/** highlight.js, fetched once per app run, off the module-eval path. It is by
 * far the heaviest piece of this stack, and none of it is needed before the
 * first answer with a fenced block is on screen. The loaded module lives in a
 * module-level slot rather than in hook state, so a render that happens after
 * the load sees it on the first pass — which is what the find and fence tests,
 * synchronous `renderToStaticMarkup` renders with no effects, rely on.
 *
 * The promise is memoized so a burst of answers shares one load. */
let highlightLoaded: Highlight | null = null;
let highlightPromise: Promise<void> | null = null;

/** Resolve highlight.js; a no-op once it is in. Exposed because the tests
 * render this component synchronously and need the plugin in place before
 * the render, not one effect after it. */
export function ensureHighlightLoaded(): Promise<void> {
  highlightPromise ??= import('rehype-highlight')
    .then((m) => {
      highlightLoaded = m.default;
    })
    .catch(() => undefined);
  return highlightPromise;
}

function useHighlight(): Highlight | null {
  const [, bump] = useState(0);
  useEffect(() => {
    void ensureHighlightLoaded().then(() => bump((n) => n + 1));
  }, []);
  return highlightLoaded;
}

/**
 * A fenced block: a language bar on top (the tag itself, plus the copy button)
 * over the code. `pre` is the mapping below, so the bar sits above the `<pre>`
 * rather than inside it — a `<pre>` is one scrolling box, and a bar inside it
 * would scroll away with the first line.
 *
 * The button copies the block's own text — `innerText`, not the React children,
 * because that is exactly what the user sees and selects, language tag and all
 * markup gone. `execCommand('copy')` rather than `navigator.clipboard.writeText`:
 * Tauri webviews expose the latter only when the page holds the `user-select:
 * text` permission, which this build does not, while the former works from a
 * user gesture without it.
 *
 * The icon flips to a check for a moment so a press gives visible feedback;
 * without it a successful copy would be indistinguishable from a dead button.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const t = useT();
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const { bar, language } = fenceLayout(fenceLanguage(children));

  const copy = async () => {
    const text = preRef.current?.innerText ?? '';
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const icon = copied ? <Check size={14} /> : <Copy size={14} />;
  const button = (
    <button
      type="button"
      className={`btn btn-ghost btn-icon md-copy-btn${copied ? ' is-copied' : ''}`}
      aria-label={copied ? t('md.codeCopied') : t('md.codeCopy')}
      title={copied ? t('md.codeCopied') : t('md.codeCopy')}
      onClick={() => void copy()}
    >
      {icon}
    </button>
  );

  return (
    <div className="md-codeblock">
      {bar ? (
        <div className="md-lang">
          <span className="md-lang-name">{language}</span>
          {button}
        </div>
      ) : null}
      <pre ref={preRef}>{children}</pre>
      {/* Untagged blocks have no bar to hold the button, so it floats over the
          code there instead (`stream.css`, `.md-codeblock:not(:has(.md-lang))`). */}
      {bar ? null : button}
    </div>
  );
}

/**
 * The `a` renderer: handles two kinds of links.
 *
 * - `workspace-file:<path>` — synthesised by `remarkFilePath` for file paths
 *   detected in the model's prose. Clicking opens the file in the OS default
 *   application via the Rust `open_file_path` command. The workspace is read
 *   from session state (the same fold `MarkdownImage` uses) so a relative path
 *   is resolved against the right root. The Rust side re-checks the path
 *   against the real filesystem, so a string the model wrote is never handed
 *   to the OS without verification.
 *
 * - everything else — an ordinary URL. Opened in the OS browser via the
 *   opener plugin, exactly as before. Tauri 2 refuses `window.open`/
 *   `target=_blank` by default, so the explicit handler is what makes a
 *   link that looks clickable actually click.
 *
 * `workspace-file:` URLs never reach the browser: `preventDefault` stops the
 * default navigation before the bridge is called.
 */
function FilePathLink({ href, children }: { href?: string; children?: ReactNode }) {
  const workspace = useSessionField((rt) => rt.session?.workspace ?? rt.workspace, '');

  const isFile = href?.startsWith('workspace-file:');

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href) return;
    e.preventDefault();
    if (isFile) {
      // Strip the `workspace-file:` scheme to get the raw path.
      const path = href.slice('workspace-file:'.length);
      void openFilePath(workspace, path).catch((err) => {
        // The Rust command returns a sentence written for the person reading
        // the reply; the console is the only place to put it from here.
        console.warn('could not open file path:', err);
      });
    } else {
      void openUrl(href);
    }
  };

  return (
    <a
      href={isFile ? undefined : href}
      onClick={handleClick}
      className={isFile ? 'md-filepath' : undefined}
    >
      {children}
    </a>
  );
}

const components: Components = {
  // react-markdown defaults headings to the raw tag; cap the visual level so
  // `##`-heavy answers keep the same hierarchy the old renderer produced.
  h1: ({ children }) => <h1>{children}</h1>,
  h2: ({ children }) => <h2>{children}</h2>,
  h3: ({ children }) => <h3>{children}</h3>,
  h4: ({ children }) => <h3>{children}</h3>,
  h5: ({ children }) => <h3>{children}</h3>,
  h6: ({ children }) => <h3>{children}</h3>,
  // A fenced block is the only place `pre` appears in this renderer (inline
  // `code` has no `pre` ancestor), so the bar and the copy button land on
  // exactly the things they apply to.
  pre: CodeBlock,
  // A model ending text with two spaces used to force a line break the old
  // renderer silently dropped; keep that behaviour visible here too.
  // Two kinds of link pass through here:
  //   - ordinary URLs (`http(s)`, `mailto`) → open in the OS browser via the
  //     opener plugin. Tauri 2 refuses `window.open`/`target=_blank` by
  //     default, so a plain external link would look clickable and do nothing
  //     on click — hence the explicit handler.
  //   - `workspace-file:<path>` links synthesised by `remarkFilePath` → open
  //     the file in the OS default application via the Rust `open_file_path`
  //     command. `FilePathLink` reads the workspace from session state (the
  //     same fold `MarkdownImage` uses) and calls the bridge; the Rust side
  //     re-checks the path against the filesystem.
  a: FilePathLink,
  // A picture is the one place this renderer reaches outside the DOM: the
  // destination is a **path** the model wrote, and a WebView cannot load one.
  // `MarkdownImage` decides what the string means and, for a workspace path,
  // has the bridge read the bytes. It never resolves a filesystem path here —
  // that decision belongs to the Rust side's boundary, not to the renderer.
  // See its own module doc for why the resolution is a command rather than the
  // `asset:` protocol.
  img: ({ src, alt }) => (
    <MarkdownImage src={typeof src === 'string' ? src : ''} alt={alt ?? ''} />
  ),
};

export function Markdown({ text }: { text: string }) {
  const highlight = useHighlight();
  // react-markdown renders no wrapper of its own: the styled `.md` div is the
  // container, so the flex-gap rules in stream.css apply to its output directly.
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkFilePath]}
        rehypePlugins={highlight ? [highlight] : []}
        components={components}
        urlTransform={imageUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
