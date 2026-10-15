import { isValidElement, type ReactNode } from 'react';

/**
 * Which fenced blocks get a language bar, and what the bar says.
 *
 * Split out of `Markdown.tsx` and kept free of React state so the two halves
 * can be asserted in Node: the language is read out of the element tree
 * `react-markdown` builds, and a `<pre>` has no attribute that carries it — the
 * class lands on the inner `<code>` (`language-go`, written before
 * `rehype-highlight` touches it). What the tree looks like is
 * `react-markdown`'s business rather than this file's, so it is pinned by a
 * test that feeds the real renderer (`tests/markdown-fence.test.ts`) instead of
 * by trusting this reading of it.
 */

/**
 * Placed on the `<code>` element by `react-markdown` / `rehype-highlight`:
 * `class="hljs language-go"`. Names may carry `+`, `#`, `.` and `-`
 * (`c++`, `c#`, `objective-c`, `dockerfile.build`), so the character class is
 * wider than `\w`.
 */
const FENCE_CLASS = /(?:^|\s)language-([\w+#.-]+)/;

/**
 * Names that mean "no language was given". `text` is written by this codebase's
 * own fallback path and `plaintext` is what some highlighters normalise a bare
 * fence to; neither is a language and neither belongs printed in a bar.
 */
const NOT_A_LANGUAGE = new Set(['plaintext', 'text']);

/**
 * The language of a fenced block, from the children `react-markdown` hands to
 * the `pre` mapping.
 *
 * `null` means "no tag", which is the case the caller draws without a bar.
 * A tag is returned **as written** — `C++` is the model's own spelling, and
 * uppercasing it for the bar is the stylesheet's job (`text-transform`), not a
 * rewrite of what the model said.
 */
export function fenceLanguage(children: ReactNode): string | null {
  const nodes = Array.isArray(children) ? children : [children];
  for (const node of nodes) {
    if (!isValidElement(node)) continue;
    const { className } = node.props as { className?: string };
    const match = FENCE_CLASS.exec(className ?? '');
    if (match && !NOT_A_LANGUAGE.has(match[1].toLowerCase())) return match[1];
  }
  return null;
}

/** What one fenced block should be drawn as. */
export interface FenceLayout {
  /** Whether the block gets a language bar above the code. */
  bar: boolean;
  /** The tag shown in the bar, or `null` when there is no bar. */
  language: string | null;
}

/**
 * The layout decision, in one place: a tagged fence gets a bar, an untagged one
 * does not. An empty strip carrying only a copy button reads as a mistake, and
 * the floating button is what this renderer did before the bar existed — so the
 * untagged case keeps that.
 */
export function fenceLayout(language: string | null): FenceLayout {
  return { bar: language !== null, language };
}
