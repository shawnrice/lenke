/**
 * ⚠️⚠️ **WHAT DOES WALKING EVERY PAGE COST? (item 2275)** The `page/` screen family and items 1866/1867/1885
 * all measure ONE page; item 2148 closed a single deep `SKIP` as "correctly routed and at its floor". But an
 * application walks the WHOLE result, one page per request — and `"all pages"`, `"page through"` and
 * `"keyset"` appear ZERO times in the review file.
 *
 * 🔑 **THE QUESTION IS CUMULATIVE, NOT PER-PAGE.** If each `ORDER BY … SKIP k LIMIT P` re-scans and
 * re-sorts from scratch, then walking `R/P` pages repeats the whole sort `R/P` times — total work quadratic
 * in the result size where one fetch is linear. The per-page cost can be "at its floor" and the walk still
 * be disastrous.
 *
 *     onepass   ONE query returning every row          — the floor for total work
 *     paged     SKIP k LIMIT P for every page          — what an application does
 *     firstonly ONE page, repeated the same number of times — isolates "is a later page dearer?"
 *
 * ⚠️ `onepass` and `paged` are asserted to yield the SAME number of rows in total, so the arms cannot differ
 * in work delivered. `firstonly` deliberately returns the same rows repeatedly and is a control, not a
 * comparison — its job is to show whether the SKIP depth itself costs anything.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 20000);
const PAGE = Number(process.env.PAGE ?? 50);
const REPS = Number(process.env.REPS ?? 5);
const ARM = process.env.ARM ?? 'paged';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i % 9973, name: `n${i}` } });
}

const PAGES = Math.ceil(N / PAGE);

/*
 * 🔑🔑 **THE INDEX ARM.** Keyset paging removes the SKIP-DEPTH cost but each page still SCANS and SORTS all
 * N rows — ~323 us a page. The engine has property indexes, so `WHERE n.k > $last ORDER BY k LIMIT P` ought
 * to be able to SEEK instead. `ARM=keysetIdx` is `keyset` with an index on `k` created first; if the index
 * is reached, the per-page cost should collapse toward the page size rather than the result size.
 */
if (ARM === 'keysetIdx') {
  /*
   * ⚠️⚠️ **`'ordered'` IS NOT AN `IndexKind` AND THE FIRST VERSION USED IT** — the kinds are
   * `'hash' | 'range' | 'interval' | 'type'`. bun erases types and ran it anyway, so the arm created NO
   * index and read 153.2 ms; I was one step from reporting "an index does not help" from an arm with no
   * index. **The typecheck is what caught it** — the "assert each A/B arm IS the code it claims" rule,
   * enforced by a gate rather than by my own eyes. A RANGE index is the one a `>` cursor could seek.
   */
  g.createIndex({ on: 'vertex', kind: 'range', keys: ['k'] });
}

const med = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

const series: number[] = [];
let rows = 0;

for (let r = 0; r < REPS; r += 1) {
  const t = performance.now();
  let got = 0;

  if (ARM === 'onepass') {
    got = query(g, 'MATCH (n:T) RETURN n.k AS k ORDER BY k', {}).length;
  } else if (ARM === 'keyset' || ARM === 'keysetIdx') {
    /*
     * 🔑🔑 **KEYSET PAGING IS EXPRESSIBLE IN ISO GQL TODAY**, so the offset cost below is a choice rather
     * than a limit — if this arm is fast. Resume from the last key instead of counting past rows:
     * `WHERE n.k > $last ORDER BY k LIMIT P`. ⚠️ The fixture's `k` has ties (`i % 9973` over 20,000 rows),
     * so a strict `>` on the key alone SKIPS tied rows — a correctness trap real keyset paging solves with
     * a tiebreak column. This arm therefore does NOT assert the row total; it measures the COST SHAPE of a
     * resumable scan, and the row count it delivers is printed so the shortfall is visible rather than
     * hidden.
     */
    let last = -1;

    for (let p = 0; p < PAGES; p += 1) {
      const out = query(
        g,
        // eslint-disable-next-line lenke/no-raw-interpolation -- a probe's own numeric cursor, never user input
        `MATCH (n:T) WHERE n.k > ${last} RETURN n.k AS k ORDER BY k LIMIT ${PAGE}`,
        {},
      );

      if (out.length === 0) {
        break;
      }

      got += out.length;
      last = Number(out[out.length - 1]?.k);
    }
  } else {
    for (let p = 0; p < PAGES; p += 1) {
      const skip = ARM === 'firstonly' ? 0 : p * PAGE;

      got += query(
        g,
        // eslint-disable-next-line lenke/no-raw-interpolation -- a probe's own page offset, never user input
        `MATCH (n:T) RETURN n.k AS k ORDER BY k SKIP ${skip} LIMIT ${PAGE}`,
        {},
      ).length;
    }
  }

  series.push(performance.now() - t);
  rows = got;
}

/* ⚠️ `onepass` and `paged` must deliver the SAME rows in total, or the comparison is meaningless. */
if (ARM !== 'firstonly' && !ARM.startsWith('keyset') && rows !== N) {
  throw new Error(`${ARM}: delivered ${rows} rows, expected ${N}`);
}

const m = med(series.slice(1));

console.log(
  `  ARM=${ARM.padEnd(10)} ${m.toFixed(1).padStart(8)} ms total   ${PAGES} pages of ${PAGE}   ${((m * 1e6) / Math.max(rows, 1)).toFixed(0).padStart(6)} ns/row delivered   rows=${rows}`,
);
