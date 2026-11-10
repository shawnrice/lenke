import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
/**
 * IS "TAKE THE RUNG, THEN DROP k ROWS" ANSWER-EQUIVALENT TO THE GENERAL PATH'S `OFFSET k`?
 * (item 1775)
 *
 * The profile says a skip-only page costs 7.9x purely by declining the projection rung, and that the
 * skip itself is 3.7% of the general path's work. So the obvious fix is to let the rung fire and
 * slice its output. Whether that is LEGAL is a different question from whether it is faster, and it
 * has to be settled first.
 *
 * ⚠️ THE HAZARD IS THAT `OFFSET` WITHOUT `ORDER BY` SKIPS AN UNSPECIFIED SET OF ROWS. This repo's
 * standing position is that unordered result order is unspecified and WON'T-FIX, the way SQL without
 * an `ORDER BY` is, and that cross-engine comparisons are MULTISET comparisons for exactly that
 * reason. But a skip is not order-invariant the way a projection is: skipping the first ten rows of
 * one visit order and the first ten of another yields DIFFERENT MULTISETS. So "order is unspecified"
 * does not by itself license the rewrite — it only says a reader may not rely on which rows come
 * back, which is a weaker claim than the engines being free to disagree with each other, given that
 * byte-identity between the TS and Rust engines is a hard invariant.
 *
 * This probe answers the cheap half empirically: if the rung's visit order ALREADY EQUALS the
 * general path's for these shapes, then slicing the rung returns the identical rows, the rewrite is
 * answer-equivalent in the strict sense, and no semantics decision is needed at all. If the orders
 * differ, the rewrite needs an owner decision and the ISO question answered properly, and this probe
 * says so rather than guessing.
 *
 * Both are checked, because a projection rung and a hop rung seed differently.
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
// pass on a permuted order by luck, so the comparison is positional over the whole row list AND the
// first differing index is reported. `n` is included to widen the row.
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
let bad = 0;

for (const [name, unpaged, pagedPrefix] of CASES) {
  const base = query(g, unpaged);

  for (const skip of SKIPS) {
    // `skip` is `Number()`-coerced from `SKIPS` at the top of this file, so it is a number and
    // cannot carry query text. A `$param` is not an option here: the point of the probe is the
    // ROUTE a literal `OFFSET k` compiles to, and routing a parameter is a different shape.
    // eslint-disable-next-line lenke/no-raw-interpolation -- numeric, Number()-coerced above; a param would change the route under test
    const paged = query(g, `${pagedPrefix}${skip}`);
    const sliced = base.slice(skip);
    let firstDiff = -1;

    if (paged.length !== sliced.length) {
      firstDiff = -2;
    } else {
      for (let i = 0; i < sliced.length; i += 1) {
        if (key(paged[i]) !== key(sliced[i])) {
          firstDiff = i;
          break;
        }
      }
    }

    const ok = firstDiff === -1;

    if (!ok) {
      bad += 1;
    }

    // A multiset check too: if positions differ but the SETS match, the general path and the rung
    // visit the same rows in a different order, which is a different (and milder) finding than the
    // two returning different rows.
    const sameMultiset =
      paged.length === sliced.length &&
      JSON.stringify(paged.map(key).sort()) === JSON.stringify(sliced.map(key).sort());

    const verdict = ok ? 'IDENTICAL (positional)' : `DIFFERS at index ${firstDiff}`;
    const detail = ok ? '' : `   same multiset: ${sameMultiset}`;

    console.log(
      `${name.padEnd(16)} OFFSET ${String(skip).padStart(5)}  ${verdict}${detail}` +
        `   rows ${paged.length}/${sliced.length}`,
    );
  }
}

console.log(
  `\n${bad === 0 ? 'ALL IDENTICAL — slicing the rung is answer-equivalent in the strict sense.' : `${bad} case(s) DIFFER — the rewrite needs an owner decision, not a patch.`}`,
);
