/**
 * One counter for every short-lived session row that never got a bridge key.
 *
 * Two placeholders can exist at once (a start-up in flight while the person
 * opens another workspace), and a bucket is only replaced by an explicit
 * rekey — so two `starting-<now>` keys minted in the same millisecond would
 * collide. The same is true of the rows a **failed** remote open leaves
 * behind: a person can press two rows before either dial settles, and one row
 * silently replacing the other is a failure they never see. A monotonic
 * counter cannot produce either.
 *
 * The two prefixes stay distinct on purpose: `starting-` is read as "an open
 * is in flight" by the store and the UI, `failed-` as "this row is a reason,
 * not a conversation", and `bridgeKey` refuses both because neither names a
 * child.
 */
let startingSeq = 0;
let failedSeq = 0;

export function nextStartingKey(): string {
  startingSeq += 1;
  return `starting-${startingSeq}`;
}

export function nextFailedKey(): string {
  failedSeq += 1;
  return `failed-${failedSeq}`;
}
