import type { QueryResultSet } from '../types';

/**
 * Render one SQL result set as an ASCII table.
 *
 * The formatting logic is separated so the execution layer remains framework-
 * agnostic and can later be reused in BuddySQL or other UIs.
 */
export function formatResultSetAsAsciiTable(resultSet: QueryResultSet): string {
  const { columns, rows } = resultSet;

  if (columns.length === 0) {
    return '';
  }

  const widths = columns.map((column, index) => {
    const cellMaxWidth = rows.reduce((max, row) => {
      const value = row[index] ?? '';
      return Math.max(max, value.length);
    }, 0);

    return Math.max(column.length, cellMaxWidth);
  });

  const separator = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`;

  const header = `|${columns
    .map((column, index) => ` ${column.padEnd(widths[index], ' ')} `)
    .join('|')}|`;

  const bodyRows = rows.map((row) => {
    const renderedCells = widths.map((width, index) => {
      const value = row[index] ?? '';
      return ` ${value.padEnd(width, ' ')} `;
    });

    return `|${renderedCells.join('|')}|`;
  });

  return [separator, header, separator, ...bodyRows, separator].join('\n');
}
