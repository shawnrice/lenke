import { describe, expect, test } from 'bun:test';

import { formatRows } from './table.js';

/*
 * Item 2524: `formatRows`'s cell truncation must not cut inside a character a reader sees as one.
 *
 * `clip` was `s.slice(0, maxColWidth - 1)`, which counts UTF-16 CODE UNITS. A cut landing between
 * the halves of a surrogate pair emitted a LONE SURROGATE — not valid text, rendered as a
 * replacement glyph. Measured before the fix: `'abcd\u{1F600}efgh'` at `maxColWidth: 6` produced
 * `"abcd\ud83d…"`.
 *
 * Nothing pinned it: the only truncation test used `'x'.repeat(100)`, pure ASCII, so every cut fell
 * on a boundary by construction.
 *
 * The fix cuts by GRAPHEME CLUSTER (`Intl.Segmenter`), not code points, because code points still
 * split a ZWJ emoji sequence or a base character from its combining mark — the rows below cover all
 * three, since a code-point fix would pass the first and fail the other two.
 *
 * ## WHAT THIS DOES NOT FIX, DELIBERATELY
 *
 * Display WIDTH is a separate question and still wrong: `widths`/`pad` use `s.length`, so a CJK cell
 * is allotted 4 columns and occupies 8 (measured in `width-2524.ts`). Fixing that needs a wcwidth
 * table; these tests are about CORRUPTION, not alignment, and must not be read as pinning width.
 */
const UNPAIRED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

const cellLine = (value: string, maxColWidth: number): string => {
  const [, , , body] = formatRows([{ name: value }], { color: false, maxColWidth }).split('\n');

  return body;
};

describe('cell truncation cuts on grapheme boundaries (item 2524)', () => {
  test('an astral character straddling the cut is never split', () => {
    const line = cellLine('abcd\u{1F600}efgh', 6);

    expect(UNPAIRED.test(line)).toBe(false);
    expect(line).toContain('…');
  });

  /*
   * A code-point fix passes the row above and FAILS this one: a ZWJ sequence is several code points
   * that render as one glyph, so slicing between them leaves a dangling joiner and a stray member.
   */
  test('a ZWJ emoji sequence is not cut mid-cluster', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const line = cellLine(`ab${family}cd`, 4);

    expect(UNPAIRED.test(line)).toBe(false);
    // Either the whole cluster survives or it is dropped whole — never a bare joiner at the edge.
    expect(line.includes('‍…')).toBe(false);
  });

  test('a combining mark stays attached to its base character', () => {
    /*
     * HAND-COMPUTED, because my first assertion could not tell pass from fail: it rejected a
     * combining mark sitting directly before the ellipsis, which happens BOTH when the mark is
     * correctly kept (base+mark, then the ellipsis) AND when it is orphaned.
     *
     * 'abcéfgh' is 7 graphemes - a b c é f g h - so at maxColWidth 5 the kept prefix is the
     * first FOUR plus the ellipsis.
     *
     * The source carries a LITERAL combining mark, not an escape: oxfmt rewrites \\u0301 into the
     * character (and into the DECOMPOSED form), which is why a patch anchored on either the escape
     * or a precomposed e-acute cannot match this file.
     */
    expect(cellLine('abcéfgh', 5)).toContain('abcé…');

    // The orphan case stated POSITIVELY: cutting one grapheme earlier ends at `c`, with the accent
    // and its base both gone, rather than the accent surviving alone.
    expect(cellLine('abcéfgh', 4)).toContain('abc…');
  });

  /* CONTROLS — the pre-existing behaviour this must not disturb. */
  test('CONTROL: long ASCII still truncates with an ellipsis', () => {
    const line = cellLine('x'.repeat(100), 10);

    expect(line).toContain('…');
    expect(line).toContain('xxxxxxxxx');
  });

  test('CONTROL: a cell at or under the limit is NOT truncated', () => {
    expect(cellLine('short', 10)).not.toContain('…');
    expect(cellLine('\u{1F600}ok', 10)).toContain('\u{1F600}ok');
  });

  test('CONTROL: an empty result set is unaffected', () => {
    expect(formatRows([], { color: false })).toBe('(0 rows)');
  });
});
