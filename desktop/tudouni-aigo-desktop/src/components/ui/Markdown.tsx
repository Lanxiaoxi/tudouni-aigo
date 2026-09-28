import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
 */

type Components = Parameters<typeof ReactMarkdown>[0]['components'];

const components: Components = {
  // react-markdown defaults headings to the raw tag; cap the visual level so
  // `##`-heavy answers keep the same hierarchy the old renderer produced.
  h1: ({ children }) => <h1>{children}</h1>,
  h2: ({ children }) => <h2>{children}</h2>,
  h3: ({ children }) => <h3>{children}</h3>,
  h4: ({ children }) => <h3>{children}</h3>,
  h5: ({ children }) => <h3>{children}</h3>,
  h6: ({ children }) => <h3>{children}</h3>,
  // A model ending text with two spaces used to force a line break the old
  // renderer silently dropped; keep that behaviour visible here too.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
};

export function Markdown({ text }: { text: string }) {
  // react-markdown renders no wrapper of its own: the styled `.md` div is the
  // container, so the flex-gap rules in stream.css apply to its output directly.
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
