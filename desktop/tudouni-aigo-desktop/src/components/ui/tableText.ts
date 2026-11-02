/**
 * The clipboard text of a rendered table.
 *
 * Declared against the slice of `HTMLTableElement` that is actually read, not
 * against the DOM type itself: the tests run in Node with no DOM, and a
 * structural type lets them hand in a plain object while the component hands in
 * the real element.
 */
export interface TableLike {
  rows: ArrayLike<{ cells: ArrayLike<{ textContent: string | null }> }>;
}

/**
 * Tab-separated values, one line per row, header first.
 *
 * TSV rather than Markdown source because that is what a spreadsheet turns back
 * into cells on paste, and it still reads as a table in a plain text box.
 *
 * Cells are read from the element tree rather than from `innerText`: the table
 * is styled `display: block` (see `.md table`), and `innerText` of a box that is
 * not laid out as a table does not promise a tab between cells.
 *
 * A cell can never contain a tab or a line break in the output — runs of
 * whitespace collapse to one space — because either would silently move its
 * neighbours into the wrong column. A cell with a `"` is quoted with the quote
 * doubled, which is how spreadsheets write (and expect) it: left bare, a cell
 * that starts with a quote makes Excel swallow the following tabs as part of
 * the quoted text.
 */
export function tableToTsv(table: TableLike): string {
  return Array.from(table.rows, (row) =>
    Array.from(row.cells, (cell) => {
      const text = (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
      return text.includes('"') ? `"${text.replace(/"/g, '""')}"` : text;
    }).join('\t'),
  ).join('\n');
}
