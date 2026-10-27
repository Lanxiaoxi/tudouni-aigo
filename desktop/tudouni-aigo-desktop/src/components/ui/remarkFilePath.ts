/**
 * A remark plugin that detects **file paths** in the model's reply text and
 * wraps them in link nodes, so they render as clickable elements that open the
 * file in the OS default application.
 *
 * ## What it matches
 *
 * A token in plain text is treated as a file path when:
 *
 * 1. It contains at least one path separator (`/` or `\`) — this excludes
 *    bare filenames like `README.md` to avoid false positives on package
 *    names (`node.js`), version strings (`v2.0.pdf` without a directory), and
 *    ordinary words that happen to end with a short extension.
 * 2. It ends with one of the extensions in {@link CLICKABLE_EXTENSIONS}.
 * 3. It is not a URL (does not start with `scheme://`).
 *
 * ## How it links
 *
 * Matched paths become `link` nodes with the URL `workspace-file:<path>`. The
 * `workspace-file:` scheme is a marker the front end recognises: the
 * `urlTransform` lets it through, and the `a` component in `Markdown.tsx`
 * calls `openFilePath` instead of `openUrl`.
 *
 * ## What it does not touch
 *
 * - Text inside existing link nodes (no nested links).
 * - Text inside code blocks or inline code (those are `code` / `inlineCode`
 *   nodes, not `text` nodes, so the visitor never sees them).
 */

// ---------------------------------------------------------------------------
// Extension set
// ---------------------------------------------------------------------------

/**
 * File extensions whose paths should be clickable in model replies.
 *
 * Kept as a `Set` for O(1) lookup and sorted into the regex alternation
 * longest-first so that `docx` is tried before `doc` and `jpeg` before `jpg`.
 */
const CLICKABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg',
  // documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'rtf',
  // data
  'json', 'csv', 'xml', 'yaml', 'yml', 'toml', 'tsv',
  // code
  'js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
  'sh', 'sql', 'html', 'css',
  // other
  'log',
]);

// ---------------------------------------------------------------------------
// Path detection
// ---------------------------------------------------------------------------

/**
 * A URL scheme at the start of the string: `https://`, `ftp://`, etc.
 * A Windows drive letter (`C:/`) is **not** a scheme because it lacks `//`.
 */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Check whether a plain token (no surrounding whitespace or punctuation) is a
 * file path that should be made clickable.
 */
function isClickablePath(token: string): boolean {
  // Must contain at least one path separator.
  if (!/[\\/]/.test(token)) return false;
  // Must not be a URL (scheme://).
  if (URL_SCHEME_RE.test(token)) return false;
  // Must end with a supported extension.
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const ext = token.slice(dot + 1).toLowerCase();
  return CLICKABLE_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Text splitting
// ---------------------------------------------------------------------------

/**
 * Match runs of characters that can appear in a file path: letters, digits,
 * dots, hyphens, underscores, slashes, backslashes, colons (drive letters),
 * tildes, and plus signs.  Everything else — whitespace, brackets, quotes,
 * commas, semicolons — acts as a delimiter.
 */
const TOKEN_RE = /[a-zA-Z0-9._\-/\\:~+]+/g;

/** Minimal mdast node shapes the splitter produces. */
interface TextNode {
  type: 'text';
  value: string;
}
interface LinkNode {
  type: 'link';
  url: string;
  data?: { hProperties?: { className?: string[] } };
  children: TextNode[];
}

/**
 * Split a text node's value into a sequence of text and link nodes, wrapping
 * every clickable file path in a `workspace-file:` link.
 *
 * Returns `null` when the text contains no file paths, so the caller can leave
 * the original node untouched and avoid creating a spurious replacement.
 */
function splitFilePaths(text: string): Array<TextNode | LinkNode> | null {
  TOKEN_RE.lastIndex = 0;
  const result: Array<TextNode | LinkNode> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let found = false;

  while ((match = TOKEN_RE.exec(text)) !== null) {
    const token = match[0];
    const start = match.index;

    // Preserve any delimiter text before this token.
    if (start > lastIndex) {
      result.push({ type: 'text', value: text.slice(lastIndex, start) });
    }

    if (isClickablePath(token)) {
      found = true;
      result.push({
        type: 'link',
        url: `workspace-file:${token}`,
        data: { hProperties: { className: ['md-filepath'] } },
        children: [{ type: 'text', value: token }],
      });
    } else {
      result.push({ type: 'text', value: token });
    }

    lastIndex = start + token.length;
  }

  // Preserve trailing delimiter text.
  if (lastIndex < text.length) {
    result.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return found ? result : null;
}

// ---------------------------------------------------------------------------
// Tree visitor
// ---------------------------------------------------------------------------

interface MNode {
  type?: string;
  value?: string;
  children?: MNode[];
  data?: unknown;
}

/**
 * Walk the mdast tree depth-first.  When a `text` child of a non-`link` parent
 * contains clickable file paths, replace it in place with the split result.
 */
function transformTree(tree: MNode): void {
  if (!tree || !Array.isArray(tree.children)) return;

  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i];

    if (
      child.type === 'text' &&
      typeof child.value === 'string' &&
      tree.type !== 'link' // don't nest links inside existing links
    ) {
      const parts = splitFilePaths(child.value);
      if (parts && parts.length > 0) {
        tree.children.splice(i, 1, ...parts);
        // Adjust index for the inserted nodes (minus the one we removed).
        i += parts.length - 1;
      }
      continue; // text nodes have no children to recurse into
    }

    // Recurse into non-text children.
    transformTree(child);
  }
}

/**
 * The remark plugin.  Pass it to `ReactMarkdown` via `remarkPlugins`.
 */
export function remarkFilePath(): (tree: MNode) => void {
  return transformTree;
}
