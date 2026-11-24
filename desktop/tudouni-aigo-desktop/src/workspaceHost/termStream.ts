/**
 * Output bookkeeping for ONE terminal: which bytes have been written, which
 * arriving chunks are repeats, and where the stream has a hole.
 *
 * Pure on purpose (no xterm, no DOM, no client): the rules here are the part of
 * terminal recovery that is invisible when wrong — a replayed chunk written
 * twice looks like a shell echoing itself, a hole nobody announces looks like
 * lost output the person never knew about — so they are asserted in Node
 * against a fake writer (`tests/terminal-host.test.ts`).
 *
 * `seq` is a **byte offset** into the terminal's cumulative output
 * (docs/spec/workspace-host-protocol.md). `lastSeq` is the offset of the next
 * byte this stream expects, i.e. the end of everything it has written.
 *
 *   - a chunk entirely at or before `lastSeq` is a repeat: dropped;
 *   - a chunk that starts before `lastSeq` and ends after it overlaps: only the
 *     new tail is written;
 *   - a chunk that starts after `lastSeq` means bytes were skipped (a `term_gap`
 *     we did not hear about, or a replay that began late): the notice is
 *     written, then the chunk;
 *   - while an attach is in flight, live chunks wait behind its replay, so a
 *     push that overtakes the `term_attach` result cannot be written before the
 *     bytes it follows.
 */

/** What the stream writes into (an xterm instance, or a fake in tests). */
export interface ByteSink {
  write(data: Uint8Array | string): void;
}

export type OutputOutcome = 'written' | 'trimmed' | 'dropped' | 'queued';

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';

/** One dim line on its own row, whatever colour state the program left behind. */
export function noticeLine(text: string): string {
  return `${RESET}\r\n${DIM}${text}${RESET}\r\n`;
}

export class TermStream {
  private next = 0;
  private queue: { seq: number; data: Uint8Array }[] | null = null;

  constructor(
    private readonly sink: ByteSink,
    /** The sentence for "bytes are missing here" (looked up when written). */
    private readonly gapNotice: () => string,
  ) {}

  /** The offset of the next byte expected: what to ask `term_attach` for. */
  get lastSeq(): number {
    return this.next;
  }

  /** An attach is in flight; live output is being held. */
  get attaching(): boolean {
    return this.queue !== null;
  }

  /** Call before sending `term_attach`. */
  beginAttach(): void {
    this.queue = [];
  }

  /** The attach failed: nothing was replayed, and the host is not pushing. */
  cancelAttach(): void {
    this.queue = null;
  }

  /**
   * The `term_attach` result. `fromSeq` is where `data` really starts — later
   * than asked when `gap` (the ring buffer no longer reached back).
   */
  applyAttach(fromSeq: number, data: Uint8Array, gap: boolean): void {
    if (gap && fromSeq > this.next) this.markGap(fromSeq);
    this.place(fromSeq, data);
    const held = this.queue ?? [];
    this.queue = null;
    for (const chunk of held) this.place(chunk.seq, chunk.data);
  }

  /** A `term_output` push. */
  output(seq: number, data: Uint8Array): OutputOutcome {
    if (this.queue !== null) {
      this.queue.push({ seq, data });
      return 'queued';
    }
    return this.place(seq, data);
  }

  /** A `term_gap` push: `[fromSeq, toSeq)` was skipped; output resumes at `toSeq`. */
  skip(_fromSeq: number, toSeq: number): void {
    if (toSeq <= this.next) return; // already past it: a stale announcement
    this.markGap(toSeq);
  }

  private markGap(resumeAt: number): void {
    this.sink.write(noticeLine(this.gapNotice()));
    this.next = resumeAt;
  }

  private place(seq: number, data: Uint8Array): 'written' | 'trimmed' | 'dropped' {
    if (data.length === 0) return 'dropped';
    const end = seq + data.length;
    if (end <= this.next) return 'dropped';
    if (seq > this.next) this.markGap(seq);
    const already = this.next - seq;
    this.sink.write(already > 0 ? data.subarray(already) : data);
    this.next = end;
    return already > 0 ? 'trimmed' : 'written';
  }
}
