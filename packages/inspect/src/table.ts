import { plain } from './value.js';

/** A query result row — the shape both the GQL and Gremlin engines return. */
export type Row = Record<string, unknown>;

export type TableOptions = {
  /** Truncate any cell wider than this (default 40; header names are never cut). */
  maxColWidth?: number;
};

const pad = (s: string, width: number): string => s + ' '.repeat(width - s.length);

// Columns in first-seen order across all rows (a row may omit a key — a stored
// null vs. an absent property; the table shows the difference).
const columnsOf = (rows: readonly Row[]): string[] => {
  const cols: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        cols.push(key);
      }
    }
  }

  return cols;
};

/**
 * Render a result set as an aligned, monospaced table — the readable form of
 * `query(...)` / `g.query(...)` output for a console or REPL.
 *
 * ```text
 * name   age
 * ─────  ───
 * marko  29
 * vadas  27
 *
 * (2 rows)
 * ```
 */
export const formatRows = (rows: readonly Row[], options: TableOptions = {}): string => {
  if (rows.length === 0) {
    return '(0 rows)';
  }

  const maxColWidth = options.maxColWidth ?? 40;
  const cols = columnsOf(rows);

  const clip = (s: string): string =>
    s.length > maxColWidth ? `${s.slice(0, maxColWidth - 1)}…` : s;

  const body = rows.map((row) => cols.map((col) => clip(plain(row[col]))));
  const widths = cols.map((col, i) =>
    Math.max(col.length, ...body.map((cells) => cells[i].length)),
  );

  const line = (cells: readonly string[]): string =>
    cells.map((s, i) => pad(s, widths[i])).join('  ');

  const rule = widths.map((w) => '─'.repeat(w)).join('  ');
  const count = `(${rows.length} row${rows.length === 1 ? '' : 's'})`;

  return [line(cols), rule, ...body.map(line), '', count].join('\n');
};
