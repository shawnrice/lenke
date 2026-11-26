/**
 * DOES A FORKED MULTI-PATTERN MATCH JOIN ON ITS SHARED VARIABLE, OR PRODUCT-THEN-FILTER? (item 1862)
 *
 * The workload screen's `multi-pattern` family is 97% of the screen, and item 1859 nominated its
 * 1376 ns/row against `chain-rows`' 138. Reading the four bodies it draws from separates them:
 *
 *   1. `(a)-[:E]->(b), (b)-[:E]->(c)`          a CHAIN — spliced at item 1844, 9.83x
 *   2. `(a)-[:E]->(b), (a)-[:E]->(c)`          a FORK — shares `a` but is NOT a chain
 *   3. `(a:T), (b:T) WHERE a.n = $p0 AND …`    a filtered product of two scans
 *   4. `(a)-[:E]->(b), (c)-[:F]->(d)`          a GENUINE cross product
 *
 * 3 AND 4 ARE NOT TARGETS AND THAT IS NOT A GUESS: their row COUNT is the answer, so emitting
 * them is the work. 1 is closed. **2 is the one open question**, and it is a large one: `a` is the
 * START of both patterns, so `spliceChainedPatterns` cannot merge them, and the honest answers
 * differ by orders of magnitude —
 *
 *     a HASH JOIN on `a`     O(sum over a of outdeg(a)^2)   = N * F^2   for regular out-degree F
 *     a PRODUCT then FILTER  O(|E| * |E|)                   = (N * F)^2
 *
 * At N = 1500, F = 4 that is 24,000 against 36,000,000 — a 1500x difference that no single-size
 * timing can tell apart, because either could be "slow".
 *
 * SO THE INSTRUMENT IS A SIZE SWEEP, NOT A TIMING. Doubling N multiplies a join's work by 2 and a
 * product's by 4. The RATIO between consecutive sizes is the signal and it needs no baseline to
 * compare against — which is what makes this answerable without an A/B arm. CLAUDE.md's rule is to
 * sweep the size because cache-resident and not are different questions; here the sweep is not a
 * robustness check on the finding, it IS the finding.
 *
 * AND THE ANSWER IS CHECKED AGAINST THE CLOSED FORM, because a wrong row count would make the
 * scaling meaningless. For a graph where every vertex has out-degree exactly F, the fork count is
 * N * F^2 whatever the topology — so it validates the SHAPE being measured, not the fixture. The
 * fixture's own branching is asserted separately.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const FANOUT = Number(process.env.FANOUT ?? 4);
const SIZES = (process.env.SIZES ?? '400,800,1600,3200').split(',').map(Number);

const build = (n) => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 8 } });
  }

  let e = 0;

  for (let h = 0; h < FANOUT; h += 1) {
    for (let i = 0; i < n; i += 1) {
      g.addEdge({
        id: `e${e}`,
        // The repeat index `h` is in the expression, so one vertex's FANOUT edges do NOT all land
        // on one target — CLAUDE.md's `to = (a*k + b) % N` invariance, which every generator here
        // has had to be fixed for.
        from: g.getVertexById(String(i + 1)),
        to: g.getVertexById(String(((i * 7 + 3 + h * 2_654_435_761) % n) + 1)),
        labels: ['E'],
      });
      e += 1;
    }
  }

  return g;
};

/** The fixture must BRANCH, or out-degree F cannot be distinguished from F parallel edges. */
const assertBranches = (g, n) => {
  const v = g.getVertexById('1');
  const seen = new Set();

  for (const row of query(g, 'MATCH (a:T)-[:E]->(b:T) WHERE a.n = 0 RETURN b.n AS x')) {
    seen.add(row.x);
  }

  if (v === null || seen.size < 2) {
    throw new Error(`fixture at n=${n} does not branch: ${seen.size} distinct targets`);
  }
};

const SHAPES = {
  // THE FORK — the question.
  fork: 'MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) RETURN count(*) AS x',
  // THE CONTROL that cannot be a product: one pattern, same two hops' worth of work. If `fork`
  // scales like this, it joins; if it scales quadratically against this, it products.
  chain: 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN count(*) AS x',
  // A SECOND CONTROL, the genuine cross product, which MUST be quadratic — so a sweep that shows
  // nothing quadratic anywhere is a broken instrument rather than good news.
  product: 'MATCH (a:T)-[:E]->(b:T), (c:T)-[:E]->(d:T) RETURN count(*) AS x',
  /**
   * AND THE ROW-RETURNING PAIR, which is what the SCREEN actually draws — its fork body ends
   * `RETURN b.n AS x, c.n AS y`, not `count(*)`. A count rung would not touch it. These two emit
   * the SAME number of rows as their `count` twins above, so putting all four in one sweep is what
   * separates "the fork has no count rung" from "the fork produces rows dearly".
   */
  forkRows: 'MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) RETURN b.n AS x, c.n AS y',
  chainRows: 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN b.n AS x, c.n AS y',
};

const REPS = Number(process.env.REPS ?? 3);

/**
 * THE ROW SHAPES REPORT `rows.length` AND THE COUNT SHAPES REPORT THE VALUE, so the `rows` column
 * means one thing throughout — the number of rows the shape is responsible for. Reading `x` off the
 * first row of a row-returning shape would print a property value in a column labelled `rows`,
 * which is how an instrument reports success while measuring nothing.
 */
const run = (g, text) => {
  const counting = text.includes('count(*)');
  let answer;
  let best = Infinity;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = query(g, text);

    best = Math.min(best, performance.now() - t0);
    answer = counting ? rows[0].x : rows.length;
  }

  return { ms: best, answer };
};

const results = {};

for (const n of SIZES) {
  const g = build(n);

  assertBranches(g, n);
  results[n] = {};

  for (const [name, text] of Object.entries(SHAPES)) {
    // The product shape explodes; skip it past a size where it would dominate the whole run.
    if (name === 'product' && n > 1600) {
      continue;
    }

    results[n][name] = run(g, text);
  }
}

console.log(`FANOUT ${FANOUT}, min of ${REPS}; fork's closed form is N * F^2 = N * ${FANOUT ** 2}`);
console.log('');
console.log('shape      N       ms      rows          vs prev N   expected if');
console.log('-------------------------------------------------------------------');

for (const name of Object.keys(SHAPES)) {
  let prev = null;

  for (const n of SIZES) {
    const got = results[n][name];

    if (got === undefined) {
      continue;
    }

    const ratio = prev === null ? null : got.ms / prev;
    const forky = name === 'fork' || name === 'forkRows';
    const expect = forky ? n * FANOUT ** 2 : '';
    const flag = forky && String(got.answer) !== String(expect) ? `  EXPECTED ${expect}` : '';

    console.log(
      `${name.padEnd(9)} ${String(n).padEnd(7)} ${got.ms.toFixed(1).padStart(7)} ${String(got.answer).padStart(12)}   ${
        ratio === null ? '    —   ' : `${ratio.toFixed(2)}x`.padStart(8)
      }   ${ratio === null ? '' : 'join 2x / product 4x'}${flag}`,
    );
    prev = got.ms;
  }

  console.log('');
}
