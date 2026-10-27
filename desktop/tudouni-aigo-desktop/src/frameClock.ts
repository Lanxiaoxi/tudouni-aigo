/**
 * One animation frame per document, shared by everything that needs one.
 *
 * Every streamed row that paces its own text wants a `requestAnimationFrame`
 * loop. A transcript with three live rows would then run three loops, each
 * unaware of the others, each stepping a different amount of text in the same
 * frame — and their commits interleave with React's, so one frame can do three
 * separate layout passes instead of one.
 *
 * This is the single clock they share. It runs while at least one task is
 * registered, and stops as soon as none is, so an idle window has no loop at
 * all rather than a loop that wakes up to find nothing to do.
 *
 * ### The phase order is the whole contract
 *
 * 1. **simulate** — arithmetic only, no DOM reads, no DOM writes. Every task
 *    decides what it wants to show.
 * 2. **write** — the commits. All of them, after all the arithmetic.
 *
 * The split exists so that a frame never reads layout after writing it: a read
 * between two writes forces the browser to flush, and the cost of that is the
 * whole transcript's layout, every frame, per row. Nothing here reads layout at
 * all today — the cursor is arithmetic on strings — but the seam is where a
 * future "does this line wrap yet?" question has to land, and having it in
 * place is cheaper than discovering it is missing.
 *
 * The frame delta is clamped to {@link MAX_FRAME_DT_MS}. An unclamped delta
 * after a long task would make the catch-up reveal proportional to the stall,
 * which is the opposite of what the pacing is for.
 */

/** Longest frame delta the clock will report; see the module note. */
export const MAX_FRAME_DT_MS = 100;

export interface FrameTask {
  readonly id: string;
  /** Arithmetic for this frame. No DOM reads, no DOM writes. */
  onSimulate?: ((dtMs: number, now: number) => boolean) | undefined;
  /** The commit. Runs after every task's simulate has run. */
  onWrite?: ((now: number) => void) | undefined;
}

export class FrameClock {
  private static clocks = new WeakMap<Document, FrameClock>();

  private tasks = new Map<string, FrameTask>();
  private handle: number | null = null;
  private lastTs: number | null = null;
  private nextId = 0;
  private readonly doc: Document;

  private constructor(doc: Document) {
    this.doc = doc;
  }

  /** The clock for one document. Two documents never share a loop. */
  static forDocument(doc: Document = document): FrameClock {
    let clock = FrameClock.clocks.get(doc);
    if (clock === undefined) {
      clock = new FrameClock(doc);
      FrameClock.clocks.set(doc, clock);
    }
    return clock;
  }

  /**
   * Register a task, returning the id to unregister it with.
   *
   * Registering is what arms the clock, so a caller never has to remember to
   * start it separately — and can therefore never forget.
   */
  register(task: Omit<FrameTask, 'id'> & { id?: string }): string {
    const id = task.id ?? `frame-task-${this.nextId++}`;
    this.tasks.set(id, { ...task, id });
    this.arm();
    return id;
  }

  unregister(id: string | null | undefined): void {
    if (id === null || id === undefined) return;
    this.tasks.delete(id);
    if (this.tasks.size === 0) this.stop();
  }

  /**
   * Run exactly one frame now, synchronously, and report whether more is owed.
   *
   * This is the seam the tests drive — and the reason the pacing can be
   * asserted at all: a `requestAnimationFrame` callback is not observable in
   * Node, but the frame body is pure arithmetic plus a write callback.
   */
  runFrame(dtMs: number, now = 0): boolean {
    let active = false;
    const delta = Math.max(1, Math.min(dtMs, MAX_FRAME_DT_MS));
    for (const task of this.tasks.values()) {
      if (task.onSimulate?.(delta, now) === true) active = true;
    }
    for (const task of this.tasks.values()) task.onWrite?.(now);
    return active;
  }

  /** How many tasks are registered. Used by tests to pin the single-clock rule. */
  get size(): number {
    return this.tasks.size;
  }

  /** Whether a real frame loop is currently armed. */
  get armed(): boolean {
    return this.handle !== null;
  }

  /**
   * Fast-forward the new-frame bookkeeping by one frame, without a callback.
   *
   * The pacing is per frame, so a jump from one frame to "run a whole second
   * from here" has to be built out of frames. This is that stepping stone: it
   * runs one frame body at a nominal 60 Hz and reports whether more is owed, and
   * it is what both the tests and the loop use, so a cadence asserted in Node
   * cannot drift from the one in the window.
   */
  advance(dtMs: number): boolean {
    return this.runFrame(dtMs);
  }

  /**
   * Arm the loop if it is not already running.
   *
   * Public because a caller that just made work available from render (a chunk
   * landing as a prop) has to ask for a frame; `register` only covers the
   * first one.
   */
  kick(): void {
    this.arm();
  }

  /** Drop every task and stop the loop. */
  shutdown(): void {
    this.tasks.clear();
    this.stop();
  }

  private arm(): void {
    if (this.handle !== null) return;
    const win = this.doc.defaultView ?? (typeof window === 'undefined' ? null : window);
    if (win === null || typeof win.requestAnimationFrame !== 'function') return;

    const tick = (now: number): void => {
      this.handle = null;
      // The first callback after an idle gap only establishes the time base:
      // measuring the gap itself would report the whole pause as one frame.
      if (this.lastTs === null) {
        this.lastTs = now;
        this.arm();
        return;
      }
      const dtMs = now - this.lastTs;
      this.lastTs = now;
      const active = this.runFrame(dtMs, now);
      if (active) {
        this.arm();
      } else {
        this.lastTs = null;
      }
    };

    this.handle = win.requestAnimationFrame(tick);
  }

  private stop(): void {
    if (this.handle === null) return;
    const win = this.doc.defaultView ?? (typeof window === 'undefined' ? null : window);
    if (win !== null && typeof win.cancelAnimationFrame === 'function') {
      win.cancelAnimationFrame(this.handle);
    }
    this.handle = null;
    this.lastTs = null;
  }
}
