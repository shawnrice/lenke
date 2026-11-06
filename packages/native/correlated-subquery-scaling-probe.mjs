/**
 * Does a CORRELATED subquery scale linearly in the number of driving rows? (item 1565)
 *
 * The profile screen had no `CALL` shape. Adding one showed an inline `CALL { … }` costing ~25
 * SECONDS a query at 4,000 vertices, and doubling N took it from 5.7 s to 25.0 s — 4.4x for 2x the
 * data, which is quadratic. This probe is the per-row instrument for that.
 *
 * ⚠️ AND IT SHOWED THAT THE FIRST READING OF THAT WAS WRONG (item 1566). `callinline` here has NO
 * SCOPE LIST, so it is NOT a correlated subquery: the inner `n` is a fresh variable and the body
 * legitimately scans the graph. Running an O(N) body N times is O(N^2) by ISO design, not a
 * defect. The correlated spelling is `CALL (n) { … }` and it was always linear.
 *
 * What the probe is for now: an empty-scope body is LOOP-INVARIANT, and item 1566 hoists it to run
 * once (1358.0 -> 4.7 ms at N=1000, 289x). A `ns/row` column that still TRACKS N on `callinline`
 * means that hoist has regressed.
 *
 * ⚠️ THE FIRST COMPARISON I MADE WAS NOT APPLES-TO-APPLES. The probe's existing `existssub` shape
 * filters with `a.k = 5` BEFORE the subquery, and `k` is `i % 97`, so its subquery runs for about
 * N/97 rows while the `CALL` runs for all N. That is a 97x difference in subquery COUNT, not an
 * algorithmic difference, and quoting the two side by side would have overstated the gap enormously.
 * Every arm here drives the subquery from an UNFILTERED `MATCH (n:P)`, so the row counts match.
 *
 * What separates the arms is only the SUBQUERY FORM, which is the question:
 *
 *   callinline   CALL { MATCH (n)-[:E]->(x) RETURN count(*) AS c }   the ISO inline-CALL scope
 *   countsub     COUNT { MATCH (n)-[:E]->(x) }                       the value-subquery form
 *   existssub    EXISTS { MATCH (n)-[:E]->(x) }                      the predicate form
 *   plainhop     MATCH (n:P)-[:E]->(x) RETURN count(*)              no subquery at all, the floor
 *
 * ns/row is printed against the DRIVING row count, so a flat column is linear and a column that
 * tracks N is the superlinear one. Same presentation as `by-id-scaling-probe.mjs`, and for the same
 * reason: the ratio is the signal, not the absolute.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const SIZES = (process.env.SIZES ?? '250,500,1000,2000').split(',').map(Number);
const REPS = Number(process.env.REPS ?? 3);
const FANOUT = Number(process.env.FANOUT ?? 5);

const build = (n) => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < n; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } }));
  }

  // Split the target on the REPEAT INDEX, not on `i` alone: `(i * a + b) % n` is invariant under
  // `i -> i + n`, so a flat `for (k < n * FANOUT)` loop points all of one vertex's edges at the SAME
  // target and the graph comes out functional (CLAUDE.md's generator rule, items 1516/1518).
  for (let rep = 0; rep < FANOUT; rep += 1) {
    for (let i = 0; i < n; i += 1) {
      g.addEdge({
        id: `e${rep}_${i}`,
        from: vs[i],
        to: vs[(i * 7919 + rep * 104_729 + 1) % n],
        labels: ['E'],
      });
    }
  }

  return g;
};

const ARMS = {
  callinline: 'MATCH (n:P) CALL { MATCH (n)-[:E]->(x) RETURN count(*) AS c } RETURN count(*) AS t',
  countsub: 'MATCH (n:P) RETURN sum(COUNT { MATCH (n)-[:E]->(x) }) AS t',
  existssub: 'MATCH (n:P) WHERE EXISTS { MATCH (n)-[:E]->(x) } RETURN count(*) AS t',
  plainhop: 'MATCH (n:P)-[:E]->(x) RETURN count(*) AS t',
};

const only = process.env.ONLY;
const rows = [];

for (const n of SIZES) {
  const g = build(n);

  // Assert the fixture branches before trusting anything measured on it.
  const seen = new Set();

  for (const e of g.edges) {
    seen.add(e.to.id);
  }

  if (n === SIZES[0]) {
    console.log(
      `fixture: FANOUT=${FANOUT}, ${seen.size} distinct targets of ${n} vertices ` +
        `(${((seen.size / n) * 100).toFixed(1)}%)\n`,
    );
  }

  for (const [name, q] of Object.entries(ARMS)) {
    if (only !== undefined && !name.includes(only)) {
      continue;
    }

    const series = [];

    for (let r = 0; r < REPS; r += 1) {
      const t0 = performance.now();

      query(g, q);
      series.push(performance.now() - t0);
    }

    series.sort((a, b) => a - b);
    rows.push({ name, n, ms: series[Math.floor(series.length / 2)] });
  }
}

const base = new Map();

for (const r of rows) {
  if (!base.has(r.name)) {
    base.set(r.name, (r.ms * 1e6) / r.n);
  }
}

console.log(
  `${'arm'.padEnd(12)} ${'N'.padStart(7)} ${'ms'.padStart(11)} ${'ns/row'.padStart(11)}   vs smallest N`,
);

for (const r of rows) {
  const nsPerRow = (r.ms * 1e6) / r.n;

  console.log(
    `${r.name.padEnd(12)} ${String(r.n).padStart(7)} ${r.ms.toFixed(1).padStart(11)} ` +
      `${nsPerRow.toFixed(0).padStart(11)}   ${(nsPerRow / base.get(r.name)).toFixed(2)}x`,
  );
}

console.log('\nA ns/row column that tracks N is superlinear. Flat is linear.');
