/**
 * Syntax highlighting for the file preview, through the same `rehype-highlight`
 * (highlight.js) the transcript's code blocks use — no second highlighter.
 *
 * The plugin is a hast transformer, so a one-block tree is handed to it directly
 * and the highlighted `<code>` children are turned into React elements here.
 * That keeps the line-number gutter ours (a gutter inside the highlighted
 * output would have to split spans that cross lines) and avoids importing
 * packages this project does not declare (`lowlight`, `hast-util-*`).
 *
 * Loaded on first use, like `Markdown.tsx` does: it is the heaviest piece of
 * the stack and nothing needs it before a code file is opened.
 */
import { createElement, type ReactNode } from 'react';

type Plugin = typeof import('rehype-highlight').default;
type Tree = Parameters<ReturnType<Plugin>>[0];

/** Text longer than this is shown plain: highlighting is synchronous. */
export const HIGHLIGHT_MAX_CHARS = 400_000;

let pluginPromise: Promise<Plugin | null> | null = null;
function loadPlugin(): Promise<Plugin | null> {
  pluginPromise ??= import('rehype-highlight').then((m) => m.default).catch(() => null);
  return pluginPromise;
}

interface LooseNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: LooseNode[];
}

function toReact(node: LooseNode, key: number): ReactNode {
  if (node.type === 'text') return node.value ?? '';
  if (node.type !== 'element' || !node.tagName) return null;
  const className = Array.isArray(node.properties?.className)
    ? (node.properties.className as unknown[]).map(String).join(' ')
    : undefined;
  return createElement(
    node.tagName,
    { key, className },
    ...(node.children ?? []).map((child, i) => toReact(child, i)),
  );
}

/** The highlighted children of the code, or `null` when it could not be done
 *  (the caller keeps showing plain text). */
export async function highlightToReact(code: string, language: string): Promise<ReactNode[] | null> {
  const plugin = await loadPlugin();
  if (plugin === null) return null;
  try {
    const codeEl: LooseNode = {
      type: 'element',
      tagName: 'code',
      properties: { className: [`language-${language}`] },
      children: [{ type: 'text', value: code }],
    };
    const tree = {
      type: 'root',
      children: [{ type: 'element', tagName: 'pre', properties: {}, children: [codeEl] }],
    } as unknown as Tree;
    const run = plugin() as unknown as (tree: Tree, file: { message: () => void }) => void;
    run(tree, { message: () => undefined });
    return (codeEl.children ?? []).map((child, i) => toReact(child, i));
  } catch {
    return null;
  }
}
