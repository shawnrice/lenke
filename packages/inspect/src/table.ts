import { styleFor } from './color.js';
import { plain } from './value.js';

/** A query result row — the shape both the GQL and Gremlin engines return. */
export type Row = Record<string, unknown>;

export type TableOptions = {
  /** Truncate any cell wider than this (default 40; header names are never cut). */
  maxColWidth?: number;
  /** Force color on/off. Default: on only for a TTY with NO_COLOR unset. */
  color?: boolean;
};

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

/*
 * One segmenter for the module: constructing it is not free, and it is immutable shared state of the
 * benign kind (item 2521's distinction — an empty/immutable value is safe to share, a mutable graph
 * is not).
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const pad = (s: string, width: number): string => s + ' '.repeat(width - s.length);

/**
 * Render a result set as a bordered, aligned table — the readable form of
 * `query(...)` / `g.query(...)` output for a console or REPL.
 *
 * ```text
 * ┌───────┬───────┐
 * │ name  │ age   │
 * ├───────┼───────┤
 * │ marko │ 29    │
 * │ vadas │ 27    │
 * └───────┴───────┘
 * (2 rows)
 * ```
 */
export const formatRows = (rows: readonly Row[], options: TableOptions = {}): string => {
  if (rows.length === 0) {
    return '(0 rows)';
  }

  const maxColWidth = options.maxColWidth ?? 40;
  const style = styleFor(options.color);
  const cols = columnsOf(rows);

  /*
   * Cut by GRAPHEME CLUSTER, not code units (item 2524). `s.slice` counts UTF-16 units, so a cut
   * landing between the halves of a surrogate pair emitted a LONE SURROGATE — invalid text, rendered
   * as a replacement character. Measured: `clip('abcd\u{1F600}efgh')` at maxColWidth 6 produced
   * `"abcd\ud83d…"`.
   *
   * Code points would fix THAT case, but they still split a grapheme cluster — a ZWJ emoji sequence
   * or a base character plus its combining mark. `Intl.Segmenter` is the unit a reader actually sees,
   * is built into the runtime (no dependency), and is what oxlint's `no-misused-spread` points at.
   *
   * This does NOT fix display WIDTH: a CJK character is one code point but two terminal columns, so
   * `widths`/`pad` below still under-pad a fullwidth cell (measured: `中村太郎` is allotted 4 columns
   * and occupies 8). That needs a wcwidth table and is a separate, larger question.
   */
  const clip = (s: string): string => {
    const chars = Array.from(segmenter.segment(s), (seg) => seg.segment);

    return chars.length > maxColWidth ? `${chars.slice(0, maxColWidth - 1).join('')}…` : s;
  };

  const body = rows.map((row) => cols.map((col) => clip(plain(row[col]))));
  const widths = cols.map((col, i) =>
    Math.max(col.length, ...body.map((cells) => cells[i].length)),
  );

  const bar = style.dim('│');
  const rule = (left: string, mid: string, right: string): string =>
    style.dim(left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right);
  const rowLine = (cells: readonly string[]): string => `${bar} ${cells.join(` ${bar} `)} ${bar}`;

  const header = rowLine(cols.map((col, i) => style.bold(style.cyan(pad(col, widths[i])))));
  const bodyLines = body.map((cells) =>
    rowLine(cells.map((s, i) => (s === 'null' ? style.dim(pad(s, widths[i])) : pad(s, widths[i])))),
  );
  const count = style.dim(`(${rows.length} row${rows.length === 1 ? '' : 's'})`);

  return [
    rule('┌', '┬', '┐'),
    header,
    rule('├', '┼', '┤'),
    ...bodyLines,
    rule('└', '┴', '┘'),
    count,
  ].join('\n');
};
