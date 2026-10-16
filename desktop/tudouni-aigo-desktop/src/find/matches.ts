/**
 * Find in the conversation: the parts that are not the DOM.
 *
 * Three pieces of this feature are ordinary text work — which offsets a query
 * hits, and how an offset in a row's concatenated text turns into a real
 * `Range` — and they are kept here, away from the painting, so they can be
 * asserted in Node. The prototype (`scripts/find-proto.mjs`) measured what the
 * rest costs and what it has to be careful of; the numbers it printed are quoted
 * where they decide something.
 *
 * ### What is searched, and what is deliberately not
 *
 * The allowlist below is the decision: a search looks at the **conversation
 * text** of a row and never at the row. Chrome — `You`, `Model call`, `params`,
 * `Output`, a duration, a token count — is not something anybody searches a
 * conversation for, and a find that reported a hit on the word "params" would be
 * answering a question about the interface rather than about what was said.
 *
 * It is a claim about the class vocabulary of `EntryView.tsx`, which is why it is
 * exported and asserted rather than written inline at the walk: a new row kind
 * that wants to be searchable has to be added **here** and to carry
 * `data-entry`, and `tests/find.test.tsx` fails if either half is missing.
 */
export const FIND_CONTENT_SELECTORS = [
  /** 2. what the person said. */
  '.e-user',
  /** 11. the live body, before the final answer supersedes it. */
  '.e-stream',
  /** 9. the thinking, inside a fold that may be shut. */
  '.e-reason-body',
  /** 10. the answer, as `react-markdown` rendered it. */
  '.e-answer .md',
] as const;

/**
 * The attribute that says "this row is this entry".
 *
 * It is **not** `data-anchor`, which already exists on two row kinds: an anchor
 * is a place the turn rail may scroll to, and only a turn head or a restored
 * prompt qualifies. This one means "everything drawn for this entry is in here",
 * and every searchable row has it because the paint layer has to get from a
 * match back to a live `Text` node — and the only honest link between the model
 * and the DOM is one this front end writes down itself.
 */
export const FIND_ROW_ATTRIBUTE = 'data-entry';

/**
 * One text node's slice of a row's concatenated text.
 *
 * Offsets are into the concatenation, not into the node: a query is allowed to
 * span two nodes (that is what makes `the **find** layer` findable at all), and
 * the mapping back is what `locateRange` does.
 */
export interface Segment {
  node: Text;
  /** First offset in the concatenated text that belongs to this node. */
  start: number;
  /** One past the last. */
  end: number;
}

/**
 * Every occurrence of `needle` in `text`, case-insensitively, by offset.
 *
 * Overlaps are reported, like a browser's own find: `aa` occurs twice in `aaa`,
 * and hiding the second one would make the count disagree with the reader's eye.
 *
 * **Case folding is done in a way that preserves offsets, and the fallback says
 * so.** `toLowerCase` is not length-preserving for every character — `İ` folds
 * to two code points — and offsets taken from a folded string would then point
 * one place to the left of where the mark belongs, at every occurrence after it.
 * So the folded string is used only when its length still matches, which is the
 * whole of ordinary text; otherwise the comparison is done code point by code
 * point against the original, which keeps every offset exact at the cost of
 * matching those particular characters only case-sensitively. A missed hit in
 * Turkish is a smaller wrong than a highlight painted over the wrong word.
 */
export function findAll(text: string, needle: string): number[] {
  if (needle === '' || text === '') return [];
  const offsets: number[] = [];
  const foldedText = text.toLowerCase();
  const foldedNeedle = needle.toLowerCase();

  if (foldedText.length === text.length && foldedNeedle.length === needle.length) {
    let at = foldedText.indexOf(foldedNeedle);
    while (at >= 0) {
      offsets.push(at);
      at = foldedText.indexOf(foldedNeedle, at + 1);
    }
    return offsets;
  }

  for (let i = 0; i + needle.length <= text.length; i += 1) {
    let ok = true;
    for (let k = 0; k < needle.length; k += 1) {
      if (text[i + k]?.toLowerCase() !== needle[k]?.toLowerCase()) {
        ok = false;
        break;
      }
    }
    if (ok) offsets.push(i);
  }
  return offsets;
}

/**
 * The `Range` boundaries for a match at `start` of `length`, or `null` when the
 * match is not one a highlight can draw.
 *
 * Two ways that happens, and both are the separator's doing:
 *
 *   - the match **runs past the last text node** (a truncated row);
 *   - the match **straddles a separator**. The walk inserts one `\n` between
 *     block-level elements so that a query cannot be answered by the end of one
 *     paragraph and the start of the next. A query cannot contain a `\n` — the
 *     box is a single-line input — so a match that spans a separator is a match
 *     nobody typed, and it is dropped rather than drawn across two paragraphs.
 *
 * The walk is a coverage check rather than a lookup of the two ends, because
 * both ends can be inside real text while a separator sits between them.
 */
export function locateRange(
  segs: readonly Segment[],
  start: number,
  length: number,
): { start: { node: Text; offset: number }; end: { node: Text; offset: number } } | null {
  if (length <= 0) return null;
  const end = start + length - 1;

  let i = 0;
  while (i < segs.length && segs[i].end <= start) i += 1;
  // The match begins in a separator, or past everything there is.
  if (i >= segs.length || segs[i].start > start) return null;

  const first = i;
  let covered = start;
  while (i < segs.length && covered <= end) {
    if (segs[i].start > covered) return null;
    covered = Math.max(covered, segs[i].end);
    i += 1;
  }
  if (covered <= end) return null;

  const head = segs[first];
  const tail = segs[i - 1];
  return {
    start: { node: head.node, offset: start - head.start },
    end: { node: tail.node, offset: end - tail.start + 1 },
  };
}
