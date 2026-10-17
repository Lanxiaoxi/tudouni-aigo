/**
 * The painting half of find-in-conversation: walk the transcript, build the
 * ranges, draw them, and jump to one.
 *
 * ### Why this does not touch the DOM
 *
 * The marks are drawn with the **CSS Custom Highlight API** — `CSS.highlights`
 * plus a `Highlight` of live `Range`s — rather than by wrapping matches in
 * `<mark>`. That is the whole reason this feature can exist without disturbing
 * the stream: the transcript's rows are `memo`'d precisely so that a streamed
 * chunk re-renders one row instead of all of them (`EntryView.tsx`), and a layer
 * that inserted elements into those rows would either fight React over them or
 * force every row through a re-render on every keystroke. A highlight is a paint
 * instruction, not markup, so React never sees it.
 *
 * ### What `scripts/find-proto.mjs` measured, and what follows from it
 *
 *   - A full pass over a 548,188-character, 164-row transcript took **8.2ms**, and
 *     cost **no layout** (`scrollHeight` identical before and after). Scanning one
 *     row took 0–0.1ms. So a pass is affordable, and a per-row pass is free.
 *   - **React rewrites a text node rather than mutating it**, so a commit that
 *     changes a row's text leaves every `Range` over that row empty: the range's
 *     boundary is moved to the ancestor that held the node, `range.collapsed`
 *     becomes true, and the mark silently stops being drawn — while
 *     `CSS.highlights.get(...).size` and `Range.startContainer.isConnected` both
 *     keep reporting it as healthy. **Liveness is `!range.collapsed`**, and for
 *     the same reason the hit count the reader sees must come from the hits this
 *     module built, never read back off the registry.
 *   - A commit that rewrites one row **leaves the other rows' ranges alive**
 *     (measured 80 of 80). That is what makes the cache below correct rather than
 *     merely fast: only rows whose entry object changed have to be re-read, and
 *     no `MutationObserver` is needed to find out which those are, because the
 *     entry model already knows.
 */

import { findAll, locateRange, FIND_CONTENT_SELECTORS, FIND_ROW_ATTRIBUTE } from './matches';
import type { Segment } from './matches';
import { landOn } from '@/scrollLanding';

/** The registry names. The stylesheet matches them in `stream.css`. */
const HIGHLIGHT_ALL = 'find-match';
const HIGHLIGHT_CURRENT = 'find-current';

/** One row's text, and the hits found in it for the query they were found for. */
interface RowCache {
  /**
   * The entry object the text was read from, **by identity**.
   *
   * This is the invalidation signal, and it is exact rather than approximate:
   * `EntryView` is memoised on that identity, and the reducer never edits an
   * entry in place, so a row whose object is unchanged is a row React did not
   * touch — and therefore a row whose text nodes are still the nodes its ranges
   * point at.
   */
  entry: unknown;
  text: string;
  segs: Segment[];
  /** The first text node, for the connectivity check below. */
  anchor: Text | null;
  /** The query `ranges` was found for. `null` means "not found yet" — a real
   *  query is never `null`, so the empty box cannot be mistaken for one that has
   *  already been searched. */
  query: string | null;
  ranges: { offset: number; range: Range }[];
}

const cache = new Map<string, RowCache>();

export interface FindHit {
  /** The entry whose row holds the hit — `data-entry`'s value. */
  entryId: string;
  range: Range;
}

export interface FindScan {
  hits: FindHit[];
  /** Rows whose text had to be read again (the entry object moved, or its nodes
   *  left the document). */
  reread: number;
  /** Rows whose offsets had to be found again for this query. */
  refound: number;
  /** Milliseconds spent, for the check script to quote. */
  ms: number;
}

/** Is the highlight API there at all? WebView2 is Chromium 105+; this is the
 *  belt for a build that is older than the app expects. */
export function findPaintSupported(): boolean {
  return typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
}

/**
 * One row's text as a single string, plus the segments that map it back.
 *
 * A separator is inserted where the walk crosses from one block-level element to
 * the next, so a query cannot be answered by the tail of one paragraph and the
 * head of the following one. `getComputedStyle` is read per element and cached,
 * which is the honest test and — measured — costs nothing that matters: it does
 * **not** force the layout `content-visibility: auto` exists to avoid (the
 * prototype's phase C: `scrollHeight` 38,240 before and after a full scan).
 *
 * The coarser alternative is "a separator whenever the text node's parent
 * changes". It is 2.7x faster (3.0ms against 8.2ms) and finds the same hits on
 * ordinary prose, and it is **not** used, because it cannot match a phrase that
 * spans inline markup: in an answer, `the **find** layer` is three text nodes
 * under two elements, and that rule would refuse to find what the reader can
 * plainly see.
 */
function concatText(root: Element): { text: string; segs: Segment[]; anchor: Text | null } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const displays = new Map<Element, string>();
  const segs: Segment[] = [];
  let text = '';
  let anchor: Text | null = null;

  const blockOf = (start: Element): Element => {
    let el: Element | null = start;
    while (el !== null && el !== root) {
      let display = displays.get(el);
      if (display === undefined) {
        display = getComputedStyle(el).display;
        displays.set(el, display);
      }
      if (display !== 'inline' && display !== 'inline-block' && display !== 'contents') return el;
      el = el.parentElement;
    }
    return root;
  };

  let lastBlock: Element | null = null;
  let node = walker.nextNode();
  while (node !== null) {
    const textNode = node as Text;
    const parent = textNode.parentElement;
    const block = parent === null ? root : blockOf(parent);
    if (lastBlock !== null && block !== lastBlock) text += '\n';
    lastBlock = block;
    const value = textNode.nodeValue ?? '';
    if (value !== '') {
      if (anchor === null) anchor = textNode;
      segs.push({ node: textNode, start: text.length, end: text.length + value.length });
      text += value;
    }
    node = walker.nextNode();
  }
  return { text, segs, anchor };
}

/**
 * The searched container inside a row, or `null` when the row has none.
 *
 * `matches` **before** `querySelector`, and that order is the whole point: a
 * prompt's row *is* its own content container (`<div class="e-user" data-entry>`),
 * and `querySelector` only looks at descendants — so testing descendants first
 * found nothing for every user row, which is the one row kind people search the
 * transcript for most. A hit in the prompt was silently uncountable: the engine
 * skipped the row, and the counter had nothing to disagree with.
 */
function contentOf(row: Element): Element | null {
  for (const selector of FIND_CONTENT_SELECTORS) {
    if (row.matches(selector)) return row;
    const found = row.querySelector(selector);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Read the transcript: one hit per occurrence of `query`, in the order the rows
 * are drawn.
 *
 * `entriesById` is what ties the model to the DOM. A row is only read when the
 * model still has its entry — a `stream` row whose entry the final answer
 * superseded is gone from both — and a row is only re-read when the entry object
 * it was read for is no longer the current one, or when the nodes that text came
 * from have left the document (a quiet-mode rewrite, a session switch).
 *
 * **The per-row cache is why a streaming chunk costs 0.1ms instead of 8ms.** The
 * prototype measured both ends: a full pass over 548,188 characters took 8.2ms,
 * and re-reading the one row that changed took 0–0.1ms. A chunk changes exactly
 * one row's text, so a pass that re-finds the offsets for every row would spend
 * the whole transcript's worth of `indexOf` to discover that 163 rows say what
 * they said last time. Each row therefore keeps the hits found in it *and the
 * query they were found for*, and only a changed row, a changed query, or a row
 * whose ranges have gone dead does any work.
 */
export function scanTranscript(entriesById: ReadonlyMap<string, unknown>, query: string): FindScan {
  const started = performance.now();
  const hits: FindHit[] = [];
  let reread = 0;
  let refound = 0;

  const rows = new Map<string, Element>();
  for (const row of document.querySelectorAll(`[${FIND_ROW_ATTRIBUTE}]`)) {
    const id = row.getAttribute(FIND_ROW_ATTRIBUTE);
    if (id !== null) rows.set(id, row);
  }

  // The order is the **model's**, not the DOM's. They agree today; when they do
  // not, "next hit" has to walk the conversation the reader is reading, and the
  // transcript's own row order is a layout fact (`streamBlocks` regroups rows)
  // rather than an editorial one.
  for (const [id, entry] of entriesById) {
    const row = rows.get(id);
    if (row === undefined) continue;
    let cached = cache.get(id);

    // A dead range is the one failure this cache could hide: React rewrites a
    // text node rather than mutating it, and a `Range` over the old node is moved
    // to the ancestor that held it and left empty. `collapsed` is the test —
    // `isConnected` and the registry's own `size` both report those ranges as
    // healthy (measured), so neither can be used here.
    const dead =
      cached !== undefined && cached.ranges.length > 0 && cached.ranges[0].range.collapsed;
    if (
      cached === undefined ||
      cached.entry !== entry ||
      cached.anchor === null ||
      !cached.anchor.isConnected ||
      dead
    ) {
      const content = contentOf(row);
      if (content === null) {
        cache.delete(id);
        continue;
      }
      const { text, segs, anchor } = concatText(content);
      cached = { entry, text, segs, anchor, query: null, ranges: [] };
      cache.set(id, cached);
      reread += 1;
    }

    if (cached.query !== query) {
      cached.ranges = [];
      for (const offset of findAll(cached.text, query)) {
        const located = locateRange(cached.segs, offset, query.length);
        if (located === null) continue;
        const range = document.createRange();
        range.setStart(located.start.node, located.start.offset);
        range.setEnd(located.end.node, located.end.offset);
        cached.ranges.push({ offset, range });
      }
      cached.query = query;
      refound += 1;
    }

    for (const found of cached.ranges) hits.push({ entryId: id, range: found.range });
  }

  // Rows that are no longer on screen must not keep their text alive: a session's
  // worth of deleted entries would otherwise sit in this map for the life of the
  // window.
  for (const id of [...cache.keys()]) {
    if (!rows.has(id)) cache.delete(id);
  }

  return { hits, reread, refound, ms: Number((performance.now() - started).toFixed(2)) };
}

/** Draw the hits, with one of them marked as the current one. */
export function paintHits(hits: readonly FindHit[], current: number): void {
  if (!findPaintSupported()) return;
  CSS.highlights.set(
    HIGHLIGHT_ALL,
    new Highlight(...hits.map((hit) => hit.range)),
  );
  const at = hits[current];
  if (at === undefined) CSS.highlights.delete(HIGHLIGHT_CURRENT);
  else CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(at.range));
}

/** Take both sets off the registry. Called when the bar closes. */
export function clearPaint(): void {
  if (!findPaintSupported()) return;
  CSS.highlights.delete(HIGHLIGHT_ALL);
  CSS.highlights.delete(HIGHLIGHT_CURRENT);
}

/** The row element a hit is drawn in. */
function rowOf(range: Range): HTMLElement | null {
  const parent = range.startContainer.parentElement;
  if (parent === null) return null;
  return parent.closest<HTMLElement>(`[${FIND_ROW_ATTRIBUTE}]`);
}

/**
 * The controls that stand between a hit and the screen, innermost first.
 *
 * **An empty rect is not the test, and this is the measurement that says so.** A
 * body folded by `.collapse` (`grid-template-rows: 0fr` + `overflow: hidden`)
 * keeps its layout boxes, so a match inside it reports a perfectly ordinary
 * `rectHeight: 17` while sitting in a clip box `0px` tall. Reading that rect and
 * scrolling to it would aim at a line nothing draws, which is why the fold has to
 * be opened *before* the jump rather than discovered by it.
 *
 * There are two kinds of fold a hit can be shut inside, and they **nest**, so
 * this walks outwards instead of stopping at the first one: a reasoning or tool
 * body inside a turn whose work is folded away is two shut folds, and opening
 * only the inner one would leave the hit just as invisible as before. The turn's
 * toggle is found by the head it belongs to (a folded run carries `data-turn`, the
 * head carries `data-anchor`), not by its position in the DOM: the two are
 * siblings today, and a jump that depended on that would break silently the day
 * they are not.
 */
function shutFoldsOf(range: Range): HTMLElement[] {
  const heads: HTMLElement[] = [];
  let parent = range.startContainer.parentElement;

  while (parent !== null) {
    const collapsed = parent.closest<HTMLElement>('.collapse.is-collapsed');
    if (collapsed === null) break;

    let head: HTMLElement | null = null;
    const card = collapsed.closest('.e-reason, .e-tool');
    if (card !== null) {
      head = card.querySelector<HTMLElement>('.er-head, .et-head');
    } else if (collapsed.classList.contains('turn-run')) {
      const id = collapsed.dataset.turn;
      head =
        id === undefined
          ? null
          : document.querySelector<HTMLElement>(
              `.turn-head[data-anchor="${CSS.escape(id)}"] .th-fold`,
            );
    }
    // A shut fold with no head to open it is not something this front end drew;
    // going any further out would be guessing.
    if (head === null) break;
    heads.push(head);
    parent = head.parentElement;
  }

  return heads;
}

/**
 * Go to a hit: open whatever folds it is shut inside, then land on its row.
 *
 * Returns whether there was anything to go to. A hit whose row has left the
 * document — the streamed body a final answer replaced between the scan and the
 * press — is refused rather than scrolled to nowhere.
 */
export function jumpToHit(hit: FindHit, scroller: HTMLElement): boolean {
  const row = rowOf(hit.range);
  if (row === null) return false;
  const heads = shutFoldsOf(hit.range);
  if (heads.length > 0) {
    // The reader's own gesture, so the store's fold state is what decides the
    // rows' shape afterwards — a jump that opened a fold some other way would
    // leave the body open with `reasoningOpen` (or `turnFolded`) still saying
    // shut.
    for (const head of heads) head.click();
    // A frame, so the folds' own transitions have begun before the landing reads
    // a height. The row's *top* does not move either way, but the land is a
    // `scrollIntoView` on that row and the folds open downwards inside it.
    requestAnimationFrame(() => landOn(scroller, row));
    return true;
  }
  landOn(scroller, row);
  return true;
}
