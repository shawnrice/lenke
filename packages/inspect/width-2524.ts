import { formatRows } from './src/table.js';

/*
 * Item 2524: `table.ts` measures cell width with `s.length` — UTF-16 CODE UNITS, not display
 * columns — and `clip` slices by the same unit. Two consequences, different in kind:
 *
 *   1. ALIGNMENT. A fullwidth/CJK character is one code unit but TWO terminal columns, so its row is
 *      under-padded; a combining mark is two code units and ZERO extra columns, so its row is
 *      over-padded. Cosmetic, but it is the difference between a readable table and a ragged one.
 *   2. CORRUPTION. `clip` cuts at `maxColWidth - 1` CODE UNITS, so a cut that lands between the two
 *      halves of a surrogate pair emits a LONE SURROGATE — not valid text, and not cosmetic.
 *
 * This matters for people data specifically: names are where non-ASCII shows up.
 *
 * ## THE INSTRUMENT, AND THE CIRCULAR VERSION I WROTE FIRST
 *
 * The first version reported the border COLUMN INDEX of each rendered line, and every row read
 * ALIGNED — because an index into a string counts CODE UNITS, the very unit `pad` uses. The
 * instrument shared the bug it was testing for and could only ever agree with it. (Rule xvi: a
 * control validates the instrument, not every row's mechanism.)
 *
 * So `displayWidth` below is INDEPENDENT of the table's arithmetic: it counts East Asian
 * Wide/Fullwidth ranges as 2, combining marks as 0, everything else as 1, and the rows compare the
 * width the table ALLOTS a cell against the width that cell OCCUPIES.
 */
const displayWidth = (s: string): number => {
  let w = 0;

  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;

    if ((c >= 0x0300 && c <= 0x036f) || (c >= 0x20d0 && c <= 0x20f0)) {
      continue; // combining mark: zero columns
    }

    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0x1f300 && c <= 0x1f64f);

    w += wide ? 2 : 1;
  }

  return w;
};

const report = (label: string, cell: string): void => {
  /* What the table gives the column: `max(header.length, cell.length)`, in CODE UNITS. */
  const allotted = Math.max('name'.length, cell.length);
  const actual = displayWidth(cell);
  const verdict =
    allotted === actual
      ? 'ok'
      : `${actual > allotted ? 'UNDER' : 'OVER'}-padded by ${Math.abs(actual - allotted)} column(s)`;
  const cols = [
    label.padEnd(30),
    `allotted ${String(allotted).padStart(2)}`,
    `displays ${String(actual).padStart(2)}`,
    verdict,
  ];

  console.log(`  ${cols.join('  ')}`);
};

console.log('# allotted width vs DISPLAY width, measured independently of the table\n');

report('CONTROL: pure ASCII', 'marko');
report('CONTROL: longer ASCII', 'abcdefgh');
report('CJK name', '中村太郎');
report('fullwidth latin', 'ｍａｒｋｏ');
report('combining mark', 'éclair');
report('emoji (surrogate pair)', '😀 ok');

/*
 * THE CORRUPTION ROW — independent of any width question. `clip` cuts at `maxColWidth - 1` code
 * units, so the fixture puts an astral character STRADDLING that index: maxColWidth is forced to 6
 * and the emoji sits at code units 4-5, so the cut falls between its halves.
 */
const straddle = 'abcd😀efgh';
const [, , , body] = formatRows([{ name: straddle }], { color: false, maxColWidth: 6 }).split('\n');
/*
 * A LONE surrogate is an UNPAIRED one. A first version tested `charCodeAt(0)` of each spread
 * character and reported a lone surrogate even after the fix — because spreading yields CODE POINTS
 * and an INTACT astral character's first code unit is still a high surrogate. False positive on the
 * fixed code; the regex below matches only a high surrogate NOT followed by a low one, or a low one
 * NOT preceded by a high one.
 */
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(body);

console.log('\n# does clip() split a surrogate pair?\n');
console.log(`  input                ${JSON.stringify(straddle)}   (maxColWidth 6)`);
console.log(`  rendered cell line   ${JSON.stringify(body)}`);
console.log(
  lone
    ? '  LONE SURROGATE PRESENT — the cut landed inside the pair. Corrupted output, not cosmetics.'
    : '  no lone surrogate — clip handled the pair.',
);
console.log('\n  Read the CONTROL rows first: if either is not "ok", the probe is wrong.');
