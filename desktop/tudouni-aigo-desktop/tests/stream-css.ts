/**
 * The stream stylesheet as one string.
 *
 * `src/styles/stream.css` is now a directory of contiguous slices, imported by
 * `src/styles/index.css` in the order the rules used to appear. Several tests
 * read the old single file as text — a rule deleted in a refactor is invisible
 * to every other kind of test — so this helper rebuilds the same text from the
 * entry point's own import list. Reading the list rather than hard-coding the
 * chunk names keeps the tests correct when a chunk is split again.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function streamCss(): string {
  const styles = resolve(process.cwd(), 'src', 'styles');
  const index = readFileSync(resolve(styles, 'index.css'), 'utf8');
  return [...index.matchAll(/@import '\.\/(stream\/[^']+)'/g)]
    .map((m) => readFileSync(resolve(styles, m[1]), 'utf8'))
    .join('\n');
}
