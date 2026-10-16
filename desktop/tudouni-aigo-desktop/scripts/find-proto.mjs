/**
 * Find prototype: does a browser-style find hold up on this transcript?
 *
 * `tests/*` can assert the match model — *which* entries a query hits is a fact
 * about an `Entry[]`. Five things here cannot be, and all five decide the shape
 * of the layer above the model:
 *
 *   1. **Is CSS Custom Highlight API available, and does a highlight paint?** It
 *      is the one API that lets a find layer draw marks **without touching the
 *      DOM** React owns — the property that keeps it clear of a memoised row list
 *      which re-renders on every streamed chunk.
 *   2. **Do the ranges survive a React commit, and what happens when they do
 *      not?** A highlight is a live `Range` over text nodes React owns. A commit
 *      that reuses a text node leaves its range alive; one that removes the node
 *      moves the range's boundary to an ancestor, where it is empty, draws
 *      nothing, and is still counted by `CSS.highlights.get(...).size`.
 *   3. **What does a scan cost, and does it force the whole transcript to lay
 *      out?** Every row carries `content-visibility: auto` (`app.css`), and the
 *      saving is exactly what a full-document pass would spend. That makes the
 *      scan's side effect — not only its duration — part of the design.
 *   4. **Can a match be invisible while its row is on screen?** A body folded by
 *      `.collapse` keeps its layout boxes, so the answer is not "an empty rect".
 *   5. **Where does a jump land?** The rail documents a 15,561px shortfall and
 *      fixes it by lifting `content-visibility` for the length of a jump. That
 *      number came from another transcript; this measures the same three methods
 *      here, on a **freshly seeded** document, because the condition it depends on
 *      — rows that have never been laid out — is destroyed by any earlier pass
 *      over the transcript.
 *
 * Usage:
 *   npm run dev
 *   chrome --headless=new --remote-debugging-port=9333 about:blank
 *   node scripts/find-proto.mjs [url] [cdpPort] [screenshotPath]
 *
 * ### What it measured (Chromium 155, 1440x900, dark)
 *
 * Transcript: 164 rows — 80 restored turns plus one live turn — holding 548,188
 * characters of conversation text across 162 content containers.
 *
 *   - **The API is there and it paints.** `CSS.highlights`, `Highlight` and
 *     `::highlight()` all present; `find-proto.png` is the frame. (The WebView2
 *     runtime on this machine is 155.0.4283.45, the same Chromium line, so the
 *     engine the app actually ships is not a different case.)
 *   - **A scan costs 8.2ms** for the whole transcript (median of 7, min 6.2) with
 *     a separator per block-level element. With a separator per changed parent —
 *     no `getComputedStyle` at all — the same query is **3.0ms** and finds the
 *     same 80 hits, but cannot match a phrase that spans inline markup.
 *   - **A scan forces no layout.** `scrollHeight` is 38,240 before and after:
 *     `content-visibility: auto`'s saving survives, style reads and all.
 *   - **Rescanning one row costs nothing measurable** (0–0.1ms), and a commit
 *     that rewrites one row **leaves the other rows' ranges alive** — measured
 *     80/80 before and after a live delta. So the paint has to follow the entry
 *     model's "what changed", not the whole transcript.
 *   - **The registry lies about what is drawn.** After a commit replaces a row,
 *     `CSS.highlights.get(...).size` and `isConnected` both still say the ranges
 *     are fine (`registry: 4, connected: 4`) while every one of them is empty and
 *     draws nothing (`live: 0`). Liveness is `!range.collapsed`, and the n/N the
 *     reader sees has to come from the model.
 *   - **A folded match is invisible while its row is on screen, and its rect is
 *     normal**: `rects: 1, rectHeight: 17, inCollapsed: true, clipHeight: 0,
 *     insideClip: false`. Opening the fold makes it `clipHeight: 40,
 *     insideClip: true`. So "hidden" is the folding ancestor's clip box, never an
 *     empty rect.
 *   - **The estimate is materially wrong**: on a freshly seeded document the
 *     transcript reports 38,240px while its real height is 59,256px (1.55x), and
 *     the far answer row reports 34,853px where it really sits at 55,829px
 *     (1.6x). A jump built on those numbers would be arithmetic on a lie — yet on
 *     this transcript all three methods landed (plain 0px, rect arithmetic 40px,
 *     `is-landing` 0px), because each of them reads a rect and so forces the
 *     layout the estimate was standing in for. The rail's 15,561px shortfall does
 *     **not** reproduce here; `is-landing` is adopted for being exact and already
 *     measured, not because the alternatives were measured failing.
 */

import { writeFileSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5178/';
const port = Number(process.argv[3] ?? 9333);
const shotPath = process.argv[4] ?? 'find-proto.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Turns of restored history. Enough that most rows are never laid out. */
const TURNS = 80;
/**
 * Paragraphs per answer. Long on purpose: the whole point of measurement 5 is a
 * row whose real height is many times the 120px `contain-intrinsic-size`
 * fallback, which is the condition under which the estimate is a lie.
 */
const PARAS = 100;
const KEY = 'k-find-proto';

/* Five needles, one per question the prototype asks. */
/** Once per answer: the many-hit case, the text-walk cost, and the far jump. */
const NEEDLE_ANSWER = 'alpha-marker';
/** Only inside one turn's thinking, which renders into a **folded** body. */
const NEEDLE_FOLDED = 'theta-folded';
/** Every tenth prompt, so hits are spread across two row kinds. */
const NEEDLE_USER = 'omega-question';
/** In the live streaming row, and appended to by the deltas below. */
const NEEDLE_STREAM = 'sigma-stream';

/* ============================================================
   the in-page prototype
   ============================================================ */

/**
 * Installed once into the page. Everything that needs a real `Range` lives here;
 * the Node side only ever passes strings in and gets numbers out.
 *
 * The content allowlist is the design decision this encodes: the walk starts at
 * the four containers that hold **conversation text** (`.e-user`, `.e-stream`,
 * `.e-reason-body`, `.e-answer .md`) and never at the row, so chrome — "You",
 * "Model call", "params", metrics — cannot be matched. It is a claim about the
 * class vocabulary of `EntryView.tsx`, so it belongs in a test as well as here.
 */
function installFindProto() {
  const CONTENT = ['.e-user', '.e-stream', '.e-reason-body', '.e-answer .md'];

  const style = document.createElement('style');
  style.id = 'find-proto-style';
  style.textContent = [
    '::highlight(find-proto) { background-color: rgba(255, 196, 0, 0.35); }',
    '::highlight(find-proto-current) { background-color: rgba(255, 122, 0, 0.65); }',
  ].join('\n');
  document.head.appendChild(style);

  /** The transcript's drawn rows, in order. */
  const rows = () => [...document.querySelectorAll('.stream-inner > *')];

  /** The content containers, in document order. */
  function contentRoots() {
    const found = [];
    for (const selector of CONTENT) {
      for (const el of document.querySelectorAll(selector)) found.push({ el, selector });
    }
    found.sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    return found;
  }

  /**
   * One content container as a single string, plus the segments that map it back.
   *
   * A separator is inserted where the walk crosses from one block to the next, so
   * a query cannot match *across* two paragraphs — the false hit a plain
   * concatenation of every text node would produce. Two rules are implemented
   * because they are not equivalent in cost:
   *
   *   - `display` walks up to the nearest element whose computed `display` is not
   *     inline. It is the honest test, and reading `getComputedStyle` on every
   *     element of the transcript is also **the thing that could force the layout
   *     `content-visibility` was added to avoid** — measurement 3.
   *   - `parent` inserts a separator whenever the text node's own parent changes.
   *     No style is read at all, so it cannot force layout; it is coarser (a
   *     `<strong>` inside a paragraph starts a new "block"), and the two rules are
   *     compared on hit count as well as on cost.
   *
   * The segment table is per **text node** rather than per character: a scan over
   * a transcript this size cannot afford one object per character, and offsets are
   * recoverable by binary search.
   */
  function concat(root, rule) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const display = new Map();
    const blockOf = (start) => {
      if (rule === 'parent') return start;
      let el = start;
      while (el !== null && el !== root) {
        let d = display.get(el);
        if (d === undefined) {
          d = getComputedStyle(el).display;
          display.set(el, d);
        }
        if (d !== 'inline' && d !== 'inline-block' && d !== 'contents') return el;
        el = el.parentElement;
      }
      return root;
    };

    const segs = [];
    let text = '';
    let lastBlock = null;
    let node = walker.nextNode();
    while (node !== null) {
      const block = node.parentElement === null ? root : blockOf(node.parentElement);
      if (lastBlock !== null && block !== lastBlock) text += '\n';
      lastBlock = block;
      const value = node.nodeValue ?? '';
      if (value !== '') {
        segs.push({ node, start: text.length, end: text.length + value.length });
        text += value;
      }
      node = walker.nextNode();
    }
    return { text, segs };
  }

  /** Where a concatenated offset lives, or `null` when it is a separator. */
  function locate(segs, offset) {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = segs[mid];
      if (offset < seg.start) hi = mid - 1;
      else if (offset >= seg.end) lo = mid + 1;
      else return { node: seg.node, offset: offset - seg.start };
    }
    return null;
  }

  /** True when [start, start+length) is covered by text and no separator. */
  function contiguous(segs, start, length) {
    const end = start + length - 1;
    let i = 0;
    while (i < segs.length && segs[i].end <= start) i += 1;
    let covered = start;
    while (i < segs.length && covered <= end) {
      if (segs[i].start > covered) return false;
      covered = Math.max(covered, segs[i].end);
      i += 1;
    }
    return covered > end;
  }

  const state = { query: '', ranges: [], where: [] };

  /** Scan the transcript: how many hits, and time it took. */
  function scan(query, rule = 'display') {
    const started = performance.now();
    const ranges = [];
    const where = [];
    const roots = contentRoots();
    let chars = 0;
    if (query !== '') {
      const needle = query.toLowerCase();
      for (let r = 0; r < roots.length; r += 1) {
        const { text, segs } = concat(roots[r].el, rule);
        chars += text.length;
        const hay = text.toLowerCase();
        let at = hay.indexOf(needle);
        while (at >= 0) {
          if (contiguous(segs, at, needle.length)) {
            const a = locate(segs, at);
            const b = locate(segs, at + needle.length - 1);
            if (a !== null && b !== null) {
              const range = document.createRange();
              range.setStart(a.node, a.offset);
              range.setEnd(b.node, b.offset + 1);
              ranges.push(range);
              where.push({ root: r, selector: roots[r].selector });
            }
          }
          at = hay.indexOf(needle, at + 1);
        }
      }
    }
    const ms = performance.now() - started;
    state.query = query;
    state.ranges = ranges;
    state.where = where;
    return { hits: ranges.length, roots: roots.length, chars, ms: Number(ms.toFixed(2)) };
  }

  /**
   * The same scan narrowed to the one container a commit changed.
   *
   * This is the alternative to a full pass per chunk, and the number it produces
   * is what decides whether the paint layer needs a `MutationObserver` to tell it
   * *which* rows moved.
   */
  function scanOne(selector, query, rule = 'display') {
    const el = document.querySelector(selector);
    if (el === null) return { hits: 0, chars: 0, ms: 0 };
    const started = performance.now();
    const { text, segs } = concat(el, rule);
    let hits = 0;
    if (query !== '') {
      const needle = query.toLowerCase();
      const hay = text.toLowerCase();
      let at = hay.indexOf(needle);
      while (at >= 0) {
        if (contiguous(segs, at, needle.length)) hits += 1;
        at = hay.indexOf(needle, at + 1);
      }
    }
    return { hits, chars: text.length, ms: Number((performance.now() - started).toFixed(3)) };
  }

  /** Paint, and report what the browser accepted. */
  function paint(current) {
    const started = performance.now();
    CSS.highlights.set('find-proto', new Highlight(...state.ranges));
    if (current >= 0 && current < state.ranges.length) {
      CSS.highlights.set('find-proto-current', new Highlight(state.ranges[current]));
    } else {
      CSS.highlights.delete('find-proto-current');
    }
    const ms = performance.now() - started;
    return {
      size: CSS.highlights.get('find-proto')?.size ?? -1,
      current: CSS.highlights.get('find-proto-current')?.size ?? -1,
      ms: Number(ms.toFixed(2)),
    };
  }

  /**
   * Are the painted ranges still drawing the text they matched?
   *
   * `isConnected` alone is not the answer, and the prototype is what showed it: a
   * range whose text node is removed has its boundary **moved to the ancestor**
   * that held the node, so the range ends up on a connected node while being
   * empty, and it draws nothing. Liveness is therefore `!collapsed`, and the hit
   * counter the UI shows cannot be read back off the highlight registry at all —
   * it has to come from the model.
   */
  function alive() {
    let connected = 0;
    let live = 0;
    let inStream = 0;
    let streamLive = 0;
    for (const range of state.ranges) {
      const parent = range.startContainer.parentElement;
      if (range.startContainer.isConnected === true) connected += 1;
      if (!range.collapsed) live += 1;
      if (parent !== null && parent.closest('.e-stream') !== null) {
        inStream += 1;
        if (!range.collapsed) streamLive += 1;
      }
    }
    return {
      registry: CSS.highlights.get('find-proto')?.size ?? -1,
      total: state.ranges.length,
      connected,
      live,
      inStream,
      streamLive,
    };
  }

  /**
   * The row a hit sits in, whether that row is on screen, and whether the hit is
   * inside a clip that has been folded shut.
   *
   * **The rect is not the answer, and this is the measurement that says so.** A
   * body folded by `.collapse` (`grid-template-rows: 0fr` + `overflow: hidden`,
   * `global.css`) keeps its layout boxes: the text is still laid out, so
   * `getClientRects()` returns a perfectly ordinary rect for a line of text that
   * nothing draws. What distinguishes it is the **clip rectangle** of the folding
   * ancestor, which is 0px tall while the fold is shut.
   */
  function hitInfo(i) {
    const range = state.ranges[i];
    if (range === undefined) return null;
    const parent = range.startContainer.parentElement;
    const row = parent === null ? null : parent.closest('.stream-inner > *');
    const scroller = document.querySelector('.stream-scroll');
    const rects = range.getClientRects();
    const rowRect = row === null ? null : row.getBoundingClientRect();
    const scrollRect = scroller === null ? null : scroller.getBoundingClientRect();
    const clip = parent === null ? null : parent.closest('.collapse');
    const clipRect = clip === null ? null : clip.getBoundingClientRect();
    const rect = rects.length > 0 ? rects[0] : null;
    const insideClip =
      rect === null || clipRect === null
        ? null
        : rect.bottom > clipRect.top + 0.5 && rect.top < clipRect.bottom - 0.5;
    return {
      selector: state.where[i]?.selector ?? '',
      rects: rects.length,
      rectHeight: rect === null ? 0 : Math.round(rect.height),
      inCollapsed: parent !== null && parent.closest('.collapse.is-collapsed') !== null,
      clipHeight: clipRect === null ? null : Math.round(clipRect.height),
      insideClip,
      collapsed: range.collapsed,
      rowIndex: row === null ? -1 : rows().indexOf(row),
      rowOnScreen:
        rowRect !== null && scrollRect !== null
          ? Math.round(rowRect.top - scrollRect.top) >= 0 &&
            Math.round(rowRect.top - scrollRect.top) < scroller.clientHeight
          : null,
      rowTopInViewport:
        rowRect !== null && scrollRect !== null ? Math.round(rowRect.top - scrollRect.top) : null,
      viewport: scroller === null ? null : scroller.clientHeight,
    };
  }

  /** Open whatever fold holds this hit, through the same click the reader uses. */
  function expand(i) {
    const range = state.ranges[i];
    if (range === undefined) return { expanded: false, why: 'no hit' };
    const parent = range.startContainer.parentElement;
    if (parent === null) return { expanded: false, why: 'detached' };
    if (parent.closest('.collapse.is-collapsed') === null) {
      return { expanded: false, why: 'already open' };
    }
    const card = parent.closest('.e-reason, .e-tool');
    const head = card === null ? null : card.querySelector('.er-head, .et-head');
    if (head === null) return { expanded: false, why: 'no head' };
    head.click();
    return { expanded: true, head: head.className };
  }

  /** The naive jump: rect arithmetic on a document whose heights are estimates. */
  function jumpNaive(i) {
    const range = state.ranges[i];
    const scroller = document.querySelector('.stream-scroll');
    if (range === undefined || scroller === null) return null;
    const before = scroller.scrollTop;
    const top = range.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop = before + top - 40;
    return { before: Math.round(before), after: Math.round(scroller.scrollTop), wanted: Math.round(top) };
  }

  /**
   * `scrollIntoView` and nothing else — the rail's own measured failure, kept
   * here so the difference against `jumpLanding` is a number on this transcript
   * rather than a citation from another one.
   */
  function jumpPlain(i) {
    const range = state.ranges[i];
    const scroller = document.querySelector('.stream-scroll');
    if (range === undefined || scroller === null) return null;
    const parent = range.startContainer.parentElement;
    const row = parent === null ? null : parent.closest('.stream-inner > *');
    if (row === null) return null;
    const before = scroller.scrollTop;
    row.scrollIntoView({ block: 'start' });
    return { before: Math.round(before), after: Math.round(scroller.scrollTop) };
  }

  /**
   * The jump the turn rail already uses: lift `content-visibility` for the length
   * of the jump, pay for the real layout once, then let the browser land it.
   */
  function jumpLanding(i) {
    const range = state.ranges[i];
    const scroller = document.querySelector('.stream-scroll');
    if (range === undefined || scroller === null) return null;
    const parent = range.startContainer.parentElement;
    const row = parent === null ? null : parent.closest('.stream-inner > *');
    if (row === null) return null;
    const before = scroller.scrollTop;
    scroller.classList.add('is-landing');
    void scroller.scrollHeight;
    row.scrollIntoView({ block: 'start' });
    scroller.classList.remove('is-landing');
    return { before: Math.round(before), after: Math.round(scroller.scrollTop) };
  }

  function clear() {
    CSS.highlights.delete('find-proto');
    CSS.highlights.delete('find-proto-current');
    state.ranges = [];
    state.where = [];
    state.query = '';
  }

  clear();

  window.__findProto = {
    scan, scanOne, paint, alive, hitInfo, expand, jumpPlain, jumpNaive, jumpLanding, clear,
    /** The container each hit matched in, in match order — the model the UI's own
     *  navigation would walk. */
    hits: () => state.where,
    features: {
      highlights: typeof CSS !== 'undefined' && !!CSS.highlights,
      highlightCtor: typeof Highlight === 'function',
      pseudo:
        typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
          ? CSS.supports('selector(::highlight(x))')
          : false,
    },
  };
  return window.__findProto.features;
}

/**
 * Row-level jump helpers, installed without the find layer.
 *
 * Measurement 5 has to run on a document **nothing has read a rect from yet**,
 * because the estimate a jump is made of disappears the moment the transcript is
 * laid out for real. Installing the find layer would be that read, so these go in
 * alone.
 */
function installJumpHelpers() {
  const scroller = () => document.querySelector('.stream-scroll');
  const lastRow = (selector) => {
    const all = [...document.querySelectorAll(selector)];
    return all.length === 0 ? null : all[all.length - 1];
  };
  const offsetOf = (row, s) =>
    Math.round(row.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop);

  window.__jump = {
    height: () => {
      const s = scroller();
      return s === null ? -1 : s.scrollHeight;
    },
    offset: (selector) => {
      const s = scroller();
      const row = lastRow(selector);
      return s === null || row === null ? null : offsetOf(row, s);
    },
    top: () => {
      const s = scroller();
      if (s === null) return -1;
      s.scrollTop = 0;
      return Math.round(s.scrollTop);
    },
    /** What a find layer would compute from the matched range's own rect. */
    naive: (selector) => {
      const s = scroller();
      const row = lastRow(selector);
      if (s === null || row === null) return null;
      const wanted = offsetOf(row, s) - 40;
      s.scrollTop = Math.max(0, wanted);
      return { wanted, after: Math.round(s.scrollTop) };
    },
    plain: (selector) => {
      const s = scroller();
      const row = lastRow(selector);
      if (s === null || row === null) return null;
      const before = Math.round(s.scrollTop);
      row.scrollIntoView({ block: 'start' });
      return { before, after: Math.round(s.scrollTop) };
    },
    landing: (selector) => {
      const s = scroller();
      const row = lastRow(selector);
      if (s === null || row === null) return null;
      const before = Math.round(s.scrollTop);
      s.classList.add('is-landing');
      void s.scrollHeight;
      row.scrollIntoView({ block: 'start' });
      s.classList.remove('is-landing');
      return { before, after: Math.round(s.scrollTop) };
    },
    /** What `scrollTop` clamps to while the document is still all estimates.
     *
     * This is the trap the rail documents, reduced to one number: a scroll that
     * happens before layout is clamped at the estimated bottom, and the document
     * then grows under it. */
    clamp: () => {
      const s = scroller();
      if (s === null) return null;
      s.scrollTop = 1e9;
      return { clampedTo: Math.round(s.scrollTop), height: s.scrollHeight, viewport: s.clientHeight };
    },
    /** Where the row actually is, and how tall the document really is. */
    landed: (selector) => {
      const s = scroller();
      const row = lastRow(selector);
      if (s === null || row === null) return null;
      return { inViewport: offsetOf(row, s) - Math.round(s.scrollTop), height: s.scrollHeight };
    },
  };
  return true;
}

/* ============================================================
   the harness
   ============================================================ */

async function main() {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  }).then((r) => r.json());

  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      problems.push(`exception: ${d?.exception?.description ?? d?.text}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      problems.push(`console.error: ${(msg.params.args ?? []).map((a) => a.value ?? a.description).join(' ')}`);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      const detail = r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text;
      throw new Error(`eval threw: ${detail}\n--- expression ---\n${expression.slice(0, 600)}`);
    }
    if (r.error) throw new Error(`CDP error: ${JSON.stringify(r.error)}`);
    return r.result?.result?.value;
  };

  /** A page with the app mounted and nothing else done to it. */
  const openPage = async () => {
    await send('Page.navigate', { url });
    await sleep(3500);
  };

  /** The bucket `applyRuntimeMessage` needs, and the transcript it is fed. */
  const seed = async () => {
    const ready = await evaluate(`(() => {
      const store = window.__aigoStore;
      if (typeof window.__aigoCreateBucket !== 'function') return 'no bucket factory';
      const bucket = window.__aigoCreateBucket(${JSON.stringify(KEY)}, 'C:/work/project', { ericai: false, maxSteps: null });
      store.setState((s) => ({
        sessions: { ...s.sessions, [${JSON.stringify(KEY)}]: bucket },
        order: s.order.includes(${JSON.stringify(KEY)}) ? s.order : [...s.order, ${JSON.stringify(KEY)}],
        activeKey: ${JSON.stringify(KEY)},
      }));
      window.__aigoKey = ${JSON.stringify(KEY)};
      return 'ok';
    })()`);
    if (ready !== 'ok') throw new Error(`harness could not open a bucket: ${ready}`);

    const messages = [];
    for (let t = 1; t <= TURNS; t += 1) {
      const question = t % 10 === 0 ? `question ${t} ${NEEDLE_USER}` : `question ${t}`;
      messages.push({ role: 'user', content: question });
      const paras = [];
      for (let p = 0; p < PARAS; p += 1) {
        if (p === 0) paras.push(`answer ${t} ${NEEDLE_ANSWER}`);
        else paras.push(`Paragraph ${p + 1} of answer ${t}, long enough to be a real line of prose.`);
      }
      messages.push({ role: 'assistant', content: paras.join('\n\n') });
    }

    await evaluate(`(() => {
      const store = window.__aigoStore;
      const key = window.__aigoKey;
      const send = (p) => store.getState().applyRuntimeMessage(key, p);
      send({ v: 1, t: 'init', protocol: 3, session_id: 's-find-proto', resumed: false,
        model: 'deepseek-chat', provider: 'deepseek', thinking: true, effort: 'high',
        effort_levels: ['minimal','low','medium','high','xhigh','max'], workspace: 'C:/work/project',
        max_steps: 120, stream: true, context_tokens: 65536, tools: [], permissions: {},
        audit_path: 'C:/work/project/.tudouni/audit/s-find-proto.jsonl', notices: [] });
      send({ v: 1, t: 'session_load', messages: ${JSON.stringify(messages)} });
      // The live turn: a head, the thinking that carries the folded needle, and a
      // streamed body that stays streaming — so the transcript ends in the one row
      // whose text changes under the reader.
      const run = 'r-proto';
      send({ v: 1, t: 'event', kind: 'run_started', session_id: 's-find-proto', run_id: run,
        step: 0, ts: '2026-01-01T00:00:00Z', model: 'deepseek-chat', provider: 'deepseek' });
      send({ v: 1, t: 'event', kind: 'model_call', session_id: 's-find-proto', run_id: run,
        step: 0, ts: '2026-01-01T00:00:01Z', status: 'ok', duration_ms: 1900,
        prompt_tokens: 1000, cached_tokens: 700, completion_tokens: 40,
        reasoning: 'Live thinking that carries ${NEEDLE_FOLDED} exactly once.' });
      send({ v: 1, t: 'delta', session_id: 's-find-proto', run_id: run, step: 1,
        channel: 'text', text: 'A live body that mentions ${NEEDLE_STREAM} once.', reset: false });
      return true;
    })()`);
    await sleep(900);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });

  /* ============================================================
     Phase A — the match model, the paint, and what a commit does to it
     ============================================================ */

  await openPage();
  await seed();

  const mounted = await evaluate(`(() => JSON.stringify({
    rows: document.querySelectorAll('.stream-inner > *').length,
    answers: document.querySelectorAll('.e-answer .md').length,
    users: document.querySelectorAll('.e-user').length,
    reasons: document.querySelectorAll('.e-reason-body').length,
    streams: document.querySelectorAll('.e-stream').length,
  }))()`);
  console.log('A. transcript:', mounted);

  const features = await evaluate(`(${installFindProto.toString()})()`);
  console.log('A. features:', JSON.stringify(features));

  const expected = {
    [NEEDLE_ANSWER]: TURNS,
    [NEEDLE_FOLDED]: 1,
    [NEEDLE_USER]: Math.floor(TURNS / 10),
    [NEEDLE_STREAM]: 1,
  };

  console.log('\nA. scan (display rule, median of 5)');
  const scans = {};
  for (const [needle, want] of Object.entries(expected)) {
    const runs = [];
    let last = null;
    for (let i = 0; i < 5; i += 1) {
      last = await evaluate(`window.__findProto.scan(${JSON.stringify(needle)})`);
      runs.push(last.ms);
    }
    runs.sort((a, b) => a - b);
    scans[needle] = { ...last, medianMs: runs[2], want };
    console.log(
      `   ${needle.padEnd(15)} hits ${String(last.hits).padStart(3)}/${want}  roots ${last.roots}  ` +
        `chars ${last.chars}  median ${runs[2]}ms  [${runs.join(', ')}]`,
    );
  }

  console.log('\nA. highlight survival');
  const painted = await evaluate(`(() => {
    const p = window.__findProto;
    p.scan(${JSON.stringify(NEEDLE_STREAM)});
    return p.paint(0);
  })()`);
  console.log('   painted:', JSON.stringify(painted));

  for (let i = 1; i <= 3; i += 1) {
    await evaluate(`(() => {
      const store = window.__aigoStore;
      window.__aigoFlushSync(() => {
        store.getState().applyRuntimeMessage(window.__aigoKey, { v: 1, t: 'delta',
          session_id: 's-find-proto', run_id: 'r-proto', step: 1, channel: 'text',
          text: ' churn-' + ${i} + ' ${NEEDLE_STREAM}', reset: false });
      });
      return true;
    })()`);
    console.log(`   after delta ${i}:`, JSON.stringify(await evaluate('window.__findProto.alive()')));
  }

  const narrowStream = await evaluate(`(() => {
    const runs = [];
    for (let i = 0; i < 7; i += 1) runs.push(window.__findProto.scanOne('.e-stream', ${JSON.stringify(NEEDLE_STREAM)}));
    return runs.sort((a, b) => a.ms - b.ms);
  })()`);
  console.log('   narrow rescan of the live row:', JSON.stringify(narrowStream[3]));

  const deltaCost = await evaluate(`(() => {
    const store = window.__aigoStore;
    const p = window.__findProto;
    const timings = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      window.__aigoFlushSync(() => {
        store.getState().applyRuntimeMessage(window.__aigoKey, { v: 1, t: 'delta',
          session_id: 's-find-proto', run_id: 'r-proto', step: 1, channel: 'text',
          text: ' more', reset: false });
      });
      const t1 = performance.now();
      p.scan(${JSON.stringify(NEEDLE_STREAM)});
      p.paint(0);
      const t2 = performance.now();
      timings.push({ commit: Number((t1 - t0).toFixed(2)), scanPaint: Number((t2 - t1).toFixed(2)) });
    }
    return timings;
  })()`);
  console.log('   per-delta commit vs scan+paint:', JSON.stringify(deltaCost));

  const replaced = await evaluate(`(() => {
    const store = window.__aigoStore;
    window.__aigoFlushSync(() => {
      store.getState().applyRuntimeMessage(window.__aigoKey, { v: 1, t: 'ui', kind: 'run_finished',
        session_id: 's-find-proto', run_id: 'r-proto', answer: 'The final answer, which also says ${NEEDLE_STREAM}.' });
    });
    return { streamsLeft: document.querySelectorAll('.e-stream').length };
  })()`);
  console.log('   after the answer replaced the streamed row:', JSON.stringify(replaced));
  console.log('   the ranges that were painted over it:', JSON.stringify(await evaluate('window.__findProto.alive()')));

  console.log('\nA. a folded hit');
  const folded = await evaluate(`(() => {
    const p = window.__findProto;
    const s = p.scan(${JSON.stringify(NEEDLE_FOLDED)});
    p.jumpLanding(0);
    return { scan: s, at: p.hitInfo(0) };
  })()`);
  console.log('   scan + landing on its row:', JSON.stringify(folded));
  const expanded = await evaluate('window.__findProto.expand(0)');
  await sleep(600);
  console.log('   expand:', JSON.stringify(expanded), '->', JSON.stringify(await evaluate('window.__findProto.hitInfo(0)')));

  const narrowAnswer = await evaluate(`(() => {
    const runs = [];
    for (let i = 0; i < 7; i += 1) runs.push(window.__findProto.scanOne('.e-answer .md', ${JSON.stringify(NEEDLE_ANSWER)}));
    return runs.sort((a, b) => a.ms - b.ms);
  })()`);
  console.log('   narrow rescan of one answer row:', JSON.stringify(narrowAnswer[3]));

  // Paint a mark and put it in front of the camera. `size` in the registry is not
  // evidence that anything was drawn — the whole point of `live` is that the
  // registry counts ranges that draw nothing — so the image is the evidence.
  const shown = await evaluate(`(() => {
    const p = window.__findProto;
    const s = p.scan('answer ${TURNS} ${NEEDLE_ANSWER}');
    p.paint(0);
    p.jumpLanding(0);
    return { scan: s, at: p.hitInfo(0), alive: p.alive() };
  })()`);
  await sleep(500);
  const shotAt = await evaluate('window.__findProto.hitInfo(0)');
  console.log('\nA. what the screenshot should show:', JSON.stringify(shown));
  console.log('   after the frame:', JSON.stringify(shotAt));
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const shotData = shot.result?.data;
  if (typeof shotData !== 'string') throw new Error(`no screenshot data: ${JSON.stringify(shot).slice(0, 300)}`);
  writeFileSync(shotPath, Buffer.from(shotData, 'base64'));
  console.log(`\nA. screenshot: ${shotPath} (${Buffer.from(shotData, 'base64').length} bytes)`);

  console.log('\nA. does a commit to one row kill the marks on the others?');
  const crossCommit = await evaluate(`(() => {
    const store = window.__aigoStore;
    const p = window.__findProto;
    p.scan(${JSON.stringify(NEEDLE_ANSWER)});
    p.paint(-1);
    const before = p.alive();
    // A new turn: the transcript gains rows, and one row's text is rewritten.
    // Everything else is a memoised row React does not touch.
    store.getState().applyRuntimeMessage(window.__aigoKey, { v: 1, t: 'event', kind: 'run_started',
      session_id: 's-find-proto', run_id: 'r-later', step: 0, ts: '2026-01-01T00:01:00Z',
      model: 'deepseek-chat', provider: 'deepseek' });
    window.__aigoFlushSync(() => {
      store.getState().applyRuntimeMessage(window.__aigoKey, { v: 1, t: 'delta',
        session_id: 's-find-proto', run_id: 'r-later', step: 1, channel: 'text',
        text: 'a later turn, unrelated to the marks', reset: false });
    });
    return { before, after: p.alive() };
  })()`);
  console.log('   before:', JSON.stringify(crossCommit.before));
  console.log('   after :', JSON.stringify(crossCommit.after));

  console.log('\nA. the two separator rules, warm');
  for (const rule of ['display', 'parent']) {
    const runs = await evaluate(`(() => {
      const out = [];
      for (let i = 0; i < 7; i += 1) {
        out.push(window.__findProto.scan(${JSON.stringify(NEEDLE_ANSWER)}, ${JSON.stringify(rule)}));
      }
      return out;
    })()`);
    const times = runs.map((r) => r.ms).sort((a, b) => a - b);
    console.log(
      `   ${rule.padEnd(7)} hits ${runs[0].hits}  chars ${runs[0].chars}  ` +
        `min ${times[0]}ms  median ${times[3]}ms  [${times.join(', ')}]`,
    );
  }

  /* ============================================================
     Phase B — the jump, on a document nothing has laid out
     ============================================================ */

  console.log('\nB. jump to the far end, on a freshly seeded document');
  for (const how of ['plain', 'naive', 'landing', 'clamp']) {
    await openPage();
    await seed();
    await evaluate(`(${installJumpHelpers.toString()})()`);
    const virgin = await evaluate(`(() => JSON.stringify({
      estimatedHeight: window.__jump.height(),
      estimatedOffset: window.__jump.offset('.e-answer'),
      rows: document.querySelectorAll('.stream-inner > *').length,
    }))()`);
    await evaluate('window.__jump.top()');
    await sleep(200);
    const moved = await evaluate(`window.__jump.${how === 'clamp' ? 'clamp' : how}('.e-answer')`);
    await sleep(500);
    const landed = await evaluate(`window.__jump.landed('.e-answer')`);
    console.log(
      `   ${how.padEnd(8)} virgin ${virgin}  ->  ${JSON.stringify(moved)}  landed ${JSON.stringify(landed)}`,
    );
  }

  /* ============================================================
     Phase C — does the scan itself force the transcript to lay out?
     ============================================================ */

  console.log('\nC. does a scan force the whole transcript to lay out?');
  for (const rule of ['display', 'parent']) {
    await openPage();
    await seed();
    await evaluate(`(${installFindProto.toString()})()`);
    // Nothing reads a layout property before the block below: whatever the scan
    // does to the document has to be the scan's doing.
    const result = await evaluate(`(() => {
      const s = document.querySelector('.stream-scroll');
      const height = () => s.scrollHeight;
      const before = height();
      const scan = window.__findProto.scan(${JSON.stringify(NEEDLE_ANSWER)}, ${JSON.stringify(rule)});
      return { before, after: height(), scan };
    })()`);
    console.log(
      `   rule=${rule.padEnd(7)} hits ${String(result.scan.hits).padStart(3)}  ${result.scan.ms}ms  ` +
        `scrollHeight ${result.before} -> ${result.after} (${(result.after / result.before).toFixed(1)}x)`,
    );
  }

  console.log('\n--- expected vs measured ---');
  for (const [needle, s] of Object.entries(scans)) {
    console.log(`   ${needle.padEnd(15)} ${s.hits === s.want ? 'ok  ' : 'FAIL'} ${s.hits} / ${s.want}`);
  }
  if (problems.length > 0) {
    console.log('\npage problems:');
    for (const p of problems) console.log('   ' + p);
  } else {
    console.log('\nno page errors');
  }

  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
  ws.close();
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
