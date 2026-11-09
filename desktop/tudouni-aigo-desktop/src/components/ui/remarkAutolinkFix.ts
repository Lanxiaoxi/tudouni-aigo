/**
 * A GFM autolink that has swallowed the prose after it.
 *
 * GFM's autolink-literal extends a bare `http://…` to the next **whitespace**;
 * only ASCII punctuation can terminate it early — CJK punctuation (），。)
 * does not. A model replying in Chinese writes
 * `（http://localhost:3000/stats），你验收时…` with no space after the URL,
 * so the whole sentence lands inside one `<a>` and is drawn with the link's
 * accent colour and underline — the sentence looks like part of the link.
 *
 * Legitimate URLs are pure ASCII (RFC 3986; even IDN domains are punycoded in
 * their written form), so a `link` node whose **url** contains a non-ASCII
 * character can only be an autolink that swallowed prose. The label of a
 * GFM autolink is exactly its url, which is what identifies the node: an
 * authored `[label](url)` link keeps its own label and is never touched, as
 * are the `workspace-file:` links `remarkFilePath` synthesises (their urls do
 * not start with `http`).
 *
 * The node is split at the first non-ASCII character: the ASCII prefix stays
 * the link, the swallowed tail becomes a plain `text` sibling. That sibling
 * is re-scanned by `remarkFilePath` later in the plugin chain, so a file path
 * in the tail still becomes clickable.
 */

// Minimal mdast node shapes the visitor touches.
interface MNode {
  type?: string;
  url?: string;
  value?: string;
  children?: MNode[];
}

/** The label a GFM autolink carries: exactly its url, as one text child. */
function linkLabel(node: MNode): string {
  return (node.children ?? []).map((child) => child.value ?? '').join('');
}

function fixTree(tree: MNode): void {
  if (!tree || !Array.isArray(tree.children)) return;

  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i];
    if (child.type === 'link') {
      const url = child.url ?? '';
      // An autolink: an http(s) url that carries the same text as its label.
      if (/^https?:\/\//.test(url) && linkLabel(child) === url) {
        const cut = url.search(/[^\x00-\x7f]/);
        if (cut > 0) {
          child.url = url.slice(0, cut);
          child.children = [{ type: 'text', value: url.slice(0, cut) }];
          // The swallowed tail goes back to being plain prose.
          tree.children.splice(i + 1, 0, { type: 'text', value: url.slice(cut) });
          i += 1;
          continue;
        }
      }
    }
    fixTree(child);
  }
}

/**
 * The remark plugin. Pass it to `ReactMarkdown` after `remarkGfm`, which is
 * what produces the autolink nodes.
 */
export function remarkAutolinkFix(): (tree: MNode) => void {
  return fixTree;
}
