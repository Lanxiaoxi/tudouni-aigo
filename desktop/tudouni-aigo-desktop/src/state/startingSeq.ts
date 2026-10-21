/**
 * One counter for every starting placeholder, rather than a timestamp.
 *
 * Two placeholders can exist at once (a start-up in flight while the person
 * opens another workspace), and a bucket is only replaced by an explicit
 * rekey — so two `starting-<now>` keys minted in the same millisecond would
 * collide. A monotonic counter cannot.
 */
let seq = 0;

export function nextStartingKey(): string {
  seq += 1;
  return `starting-${seq}`;
}
