import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
/**
 * IS THE RUNG'S `OFFSET k` THE SAME ANSWER AS THE GENERAL PATH'S? (items 1775, 1776)
 *
 * Item 1775 priced a skip-only page at 7.9x purely for declining the projection rung, and put the
 * skip itself at 3.7% of the general path's work. So the fix is to let the rung fire and slice its
 * output — and whether that is LEGAL is a different question from whether it is faster.
 *
 * ⚠️ THE HAZARD IS THAT `OFFSET` WITHOUT `ORDER BY` SKIPS AN UNSPECIFIED SET OF ROWS. This repo's
 * standing position is that unordered result order is unspecified and WON'T-FIX, the way SQL
 * without an `ORDER BY` is, and that cross-engine comparisons are MULTISET comparisons for exactly
 * that reason. But a skip is not order-invariant the way a projection is: skipping the first ten
 * rows of one visit order and the first ten of another yields DIFFERENT MULTISETS. So "order is
 * unspecified" does not by itself license the rewrite — it only says a reader may not rely on which
 * rows come back, which is a weaker claim than the engines being free to disagree with each other,
 * given that byte-identity between the TS and Rust engines is a hard invariant.
 *
 * ⚠️ REWRITTEN AT ITEM 1776, BECAUSE THE CHANGE IT INFORMED MADE ITS OWN COMPARISON TAUTOLOGICAL.
 * The first version compared the UNPAGED query's rows, sliced, against the PAGED query's — two
 * different ROUTES while the rungs declined every page. Item 1776 gave the page to those same
 * rungs, so that comparison became the rung against itself, and it cannot fail for the shapes it
 * was built to watch. This is the dead oracle of item 1775 in its quieter form: not a probe that
 * will not RUN, but one that will not FAIL. So it now asks both questions and labels them:
 *
 *   - **ROUTE** — the literal `OFFSET k` (the rung) against the PARAMETERIZED `OFFSET $s` (the
 *     general path, which declines on purpose because the route is chosen at compile time while the
 *     value lives in `params`). This is the real cross-route claim, and the one that must hold.
 *   - **SELF** — the paged query against the unpaged query sliced. For a shape whose rung changes
 *     its walk when paged this legitimately DIFFERS, and that is informative rather than wrong:
 *     item 1776 forces the START-DRIVEN walk for a paged hop, whose order is the general path's,
 *     where the unpaged shape may take the far-driven walk, whose order is deliberately different.
 *
 * Only ROUTE decides the exit code. `skip-only-page-parity.ts` is the cross-ENGINE half.
 *
 *     cd packages/native && bun offset-order-equiv.mjs
 */

const NODES = Number(process.env.NODES ?? 5_000);
const SKIPS = (process.env.SKIPS ?? '1,10,97,1000').split(',').map(Number);

const g = new Graph();
const verts = [];

for (let i = 0; i < NODES; i += 1) {
  verts.push(
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 997, n: 20 + (i % 60) } }),
  );
}

for (let i = 0; i < NODES; i += 1) {
  g.addEdge({ id: `e${i}`, from: verts[i], to: verts[(i * 31 + 17) % NODES], labels: ['E'] });
}

// `k` is i % 997 over 5,000 nodes, so values repeat ~5x. A probe comparing only the VALUES could
// pass on a permuted order by luck, so every comparison is positional over the whole row list AND
// the first differing index is reported. `n` is included to widen the row.
const CASES = [
  ['node proj', 'MATCH (n:P) RETURN n.k', 'MATCH (n:P) RETURN n.k OFFSET '],
  ['node proj 2col', 'MATCH (n:P) RETURN n.k, n.n', 'MATCH (n:P) RETURN n.k, n.n OFFSET '],
  ['hop proj', 'MATCH (a:P)-[:E]->(b) RETURN b.k', 'MATCH (a:P)-[:E]->(b) RETURN b.k OFFSET '],
  [
    'hop proj start',
    'MATCH (a:P)-[:E]->(b) RETURN a.k',
    'MATCH (a:P)-[:E]->(b) RETURN a.k OFFSET ',
  ],
];

const key = (r) => JSON.stringify(r);

/** `-1` identical, `-2` a length mismatch, else the first differing index. */
const firstDiff = (a, b) => {
  if (a.length !== b.length) {
    return -2;
  }

  for (let i = 0; i < a.length; i += 1) {
    if (key(a[i]) !== key(b[i])) {
      return i;
    }
  }

  return -1;
};

const sameMultiset = (a, b) =>
  a.length === b.length && key(a.map(key).sort()) === key(b.map(key).sort());

const verdict = (a, b) => {
  const d = firstDiff(a, b);

  return d === -1
    ? 'IDENTICAL'
    : `DIFFERS at ${d === -2 ? 'LENGTH' : `index ${d}`}${sameMultiset(a, b) ? ' (same multiset)' : ' (different rows)'}`;
};

let routeBad = 0;

for (const [name, unpaged, pagedPrefix] of CASES) {
  const base = query(g, unpaged);

  for (const skip of SKIPS) {
    // `skip` is `Number()`-coerced from `SKIPS` at the top of this file, so it is a number and
    // cannot carry query text. A `$param` IS used for the other arm, deliberately: that spelling is
    // the general path, which is the whole point of the ROUTE comparison.
    // eslint-disable-next-line lenke/no-raw-interpolation -- numeric, Number()-coerced above; the parameterized arm below is the general-path route under test
    const viaRung = query(g, `${pagedPrefix}${skip}`);
    // eslint-disable-next-line lenke/no-raw-interpolation -- `pagedPrefix` is a literal from CASES above; the only VALUE here is the `$s` param, which is the point of this arm
    const viaGeneral = query(g, `${pagedPrefix}$s`, { s: skip });
    const route = verdict(viaRung, viaGeneral);
    const self = verdict(viaRung, base.slice(skip));

    if (route !== 'IDENTICAL') {
      routeBad += 1;
    }

    console.log(
      `${name.padEnd(16)} OFFSET ${String(skip).padStart(5)}  ROUTE ${route.padEnd(40)} SELF ${self.padEnd(40)} rows ${viaRung.length}`,
    );
  }
}

console.log(
  routeBad === 0
    ? '\nROUTE identical everywhere — the rung answers what the general path answers.'
    : `\n${routeBad} ROUTE case(s) DIFFER — the rung does NOT answer what the general path answers.`,
);
process.exit(routeBad === 0 ? 0 : 1);
