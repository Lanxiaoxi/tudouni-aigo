/**
 * The copy button on a markdown table.
 *
 * Three halves, each guarding something a screenshot would not show: the text
 * that lands on the clipboard (a stray tab or newline inside a cell silently
 * moves every cell after it into the wrong column), the markup the real
 * renderer produces around a table, and the stylesheet rules that keep the
 * button from scrolling away with a wide table.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWithTooltip } from './with-tooltip';
import { Markdown } from '@/components/ui/Markdown';
import { tableToTsv } from '@/components/ui/tableText';
import { streamCss as readStreamCss } from './stream-css';

/** A table-shaped object: rows of cell texts. Matches the slice of the DOM
 * `tableToTsv` reads, so no DOM is needed in Node. */
function fake(rows: (string | null)[][]) {
  return { rows: rows.map((cells) => ({ cells: cells.map((textContent) => ({ textContent })) })) };
}

test('a table becomes tab-separated lines, header first', () => {
  const tsv = tableToTsv(
    fake([
      ['Name', 'Qty'],
      ['apple', '3'],
      ['pear', '10'],
    ]),
  );
  assert.equal(tsv, 'Name\tQty\napple\t3\npear\t10');
});

test('a cell never carries a tab or a line break into the output', () => {
  const tsv = tableToTsv(fake([['a\tb', 'c\nd\r\ne'], ['  padded  ', '']]));
  assert.equal(tsv, 'a b\tc d e\npadded\t');
});

test('a cell with a quote is quoted the way a spreadsheet reads it', () => {
  assert.equal(tableToTsv(fake([['say "hi"', 'plain']])), '"say ""hi"""\tplain');
});

test('an empty cell or a missing text is an empty column, not "null"', () => {
  assert.equal(tableToTsv(fake([[null, 'x']])), '\tx');
  assert.equal(tableToTsv(fake([])), '');
});

test('the real renderer wraps a table and puts the button beside it', () => {
  const html = renderWithTooltip(<Markdown text={'| a | b |\n| - | - |\n| 1 | 2 |'} />);
  assert.match(html, /<div class="md-tablewrap"><table>/);
  assert.match(html, /<\/table><button[^>]*md-table-copy/);
  assert.match(html, /aria-label="Copy table"/);
  // The button is outside the table: a wide table scrolls, and a button inside
  // it would scroll away with the first column.
  assert.doesNotMatch(html, /<table>[^]*md-table-copy[^]*<\/table>/);
});

test('an answer with no table gets no table button', () => {
  const html = renderWithTooltip(<Markdown text={'just text'} />);
  assert.doesNotMatch(html, /md-table-copy/);
});

/* ---------------- the stylesheet's half ---------------- */

const streamCss = readStreamCss();

function ruleBody(selector: string): string {
  const index = streamCss.indexOf(`\n${selector} {`);
  assert.notEqual(index, -1, `stream css has no rule for \`${selector}\``);
  const open = streamCss.indexOf('{', index);
  const close = streamCss.indexOf('}', open);
  return streamCss.slice(open + 1, close);
}

test('the button floats over the wrapper, not over the scrolling table', () => {
  assert.match(ruleBody('.md-tablewrap'), /position: relative/);
  assert.match(ruleBody('.md-table-copy'), /position: absolute/);
});

test('the button stays reachable by keyboard', () => {
  // Hidden until hover, so it must also show on focus; otherwise a keyboard
  // user tabs onto an invisible control.
  assert.match(streamCss, /\.md-tablewrap:focus-within \.md-table-copy/);
});
