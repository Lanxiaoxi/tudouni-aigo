/**
 * The composer's two readings of one draft: the **string** the store holds and
 * the **document** the editor shows.
 *
 * The store keeps the draft as plain text with placeholder tokens (`⟦pimg-0⟧`),
 * and everything downstream — the upload bookkeeping, the restore at submit, the
 * history — reads that string. The editor draws each token as a chip. These
 * functions are the only translation between the two, so they are pure and
 * tested (`tests/composer-doc.test.ts`): a round trip that lost a character, or a
 * caret that landed one position off, would read as a broken editor.
 *
 * The document is deliberately poor: paragraphs of text and token chips, nothing
 * else. One paragraph is one line of the draft, joined by `\n`.
 */
import { Node, type JSONContent } from '@tiptap/core';
import type { Fragment, Node as PMNode } from '@tiptap/pm/model';
import { TOKEN_PATTERN } from '@/runtime/paste';

export const TOKEN_NODE = 'token';

/**
 * One placeholder token as an inline, indivisible node. `atom` is what makes a
 * chip delete as a unit and keeps the caret out of it. The React view is added
 * by the composer (`.extend({ addNodeView })`); the schema half lives here so the
 * conversions can be tested without a DOM.
 */
export const TokenNode = Node.create({
  name: TOKEN_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      token: {
        default: '',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-token') ?? '',
        renderHTML: (attributes: Record<string, unknown>) => ({ 'data-token': String(attributes.token) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-token]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, String(HTMLAttributes['data-token'] ?? '')];
  },
  renderText({ node }) {
    return String(node.attrs.token);
  },
});

/** The draft as editor content: one paragraph per line, tokens as chips. */
export function draftToContent(draft: string): JSONContent {
  return {
    type: 'doc',
    content: draft.split('\n').map((line) => {
      const content = lineContent(line);
      return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
    }),
  };
}

function lineContent(line: string): JSONContent[] {
  const out: JSONContent[] = [];
  let from = 0;
  for (const match of line.matchAll(TOKEN_PATTERN)) {
    const at = match.index ?? 0;
    if (at > from) out.push({ type: 'text', text: line.slice(from, at) });
    out.push({ type: TOKEN_NODE, attrs: { token: match[0] } });
    from = at + match[0].length;
  }
  if (from < line.length) out.push({ type: 'text', text: line.slice(from) });
  return out;
}

/** How many draft characters one inline node stands for. */
function leafLength(node: PMNode): number {
  if (node.isText) return node.text?.length ?? 0;
  if (node.type.name === TOKEN_NODE) return String(node.attrs.token).length;
  return 0;
}

function leafText(node: PMNode): string {
  if (node.isText) return node.text ?? '';
  if (node.type.name === TOKEN_NODE) return String(node.attrs.token);
  return '';
}

function inlineText(block: PMNode): string {
  let text = '';
  block.forEach((child) => {
    text += leafText(child);
  });
  return text;
}

/**
 * A fragment back to draft text. Blocks become lines; a fragment of bare inline
 * nodes (a copied part of one line) is just their text.
 */
export function fragmentToDraft(fragment: Fragment): string {
  const lines: string[] = [];
  let inline = '';
  let sawBlock = false;
  fragment.forEach((node) => {
    if (node.isBlock) {
      sawBlock = true;
      lines.push(inlineText(node));
    } else {
      inline += leafText(node);
    }
  });
  return sawBlock ? lines.join('\n') : inline;
}

export function docToDraft(doc: PMNode): string {
  return fragmentToDraft(doc.content);
}

/**
 * A draft offset as a document position.
 *
 * An offset that falls **inside** a token's text (which the string allows and
 * the editor does not) lands after the chip: the store only ever hands over
 * offsets at token edges, and "after" is where a caret following an insertion
 * belongs.
 */
export function offsetToPos(doc: PMNode, offset: number): number {
  let remaining = Math.max(0, offset);
  let result: number | null = null;
  doc.forEach((block, blockPos) => {
    if (result !== null) return;
    let pos = blockPos + 1;
    block.forEach((child) => {
      if (result !== null) return;
      const length = leafLength(child);
      if (child.isText) {
        if (remaining <= length) {
          result = pos + remaining;
          return;
        }
      } else if (remaining < length) {
        result = remaining === 0 ? pos : pos + child.nodeSize;
        return;
      }
      remaining -= length;
      pos += child.nodeSize;
    });
    if (result !== null) return;
    if (remaining === 0) {
      result = pos;
      return;
    }
    // The line break between this paragraph and the next.
    remaining -= 1;
  });
  return result ?? Math.max(1, doc.content.size - 1);
}

/** A document position as a draft offset. */
export function posToOffset(doc: PMNode, pos: number): number {
  let offset = 0;
  let result: number | null = null;
  doc.forEach((block, blockPos) => {
    if (result !== null) return;
    const start = blockPos + 1;
    const end = blockPos + block.nodeSize - 1;
    if (pos > end) {
      offset += inlineText(block).length + 1;
      return;
    }
    if (pos <= start) {
      result = offset;
      return;
    }
    let at = start;
    let chars = offset;
    block.forEach((child) => {
      if (result !== null) return;
      const length = leafLength(child);
      if (pos <= at + child.nodeSize) {
        result = chars + (child.isText ? pos - at : pos === at ? 0 : length);
        return;
      }
      at += child.nodeSize;
      chars += length;
    });
    if (result === null) result = chars;
  });
  return result ?? Math.max(0, offset - 1);
}
