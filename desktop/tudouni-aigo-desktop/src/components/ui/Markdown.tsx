import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { useT } from '@/i18n/useT';
import { copyText } from '@/utils/clipboard';
import { fenceLanguage, fenceLayout } from './fence';

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
 */

type Components = Parameters<typeof ReactMarkdown>[0]['components'];

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
  // Open in the OS browser via the opener plugin. Tauri 2 refuses `window.open`
  // and `target=_blank` navigation by default, so a plain external link would
  // look clickable and do nothing on click — hence the explicit handler.
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) {
          void openUrl(href);
        }
      }}
    >
      {children}
    </a>
  ),
};

export function Markdown({ text }: { text: string }) {
  // react-markdown renders no wrapper of its own: the styled `.md` div is the
  // container, so the flex-gap rules in stream.css apply to its output directly.
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
