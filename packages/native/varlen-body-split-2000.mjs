/**
 * WHICH `var-length` BODY IS EXPENSIVE? (item 2000)
 *
 * **THE FAMILY-LEVEL NUMBER CANNOT ANSWER THIS, AND ITS PER-ROW FIGURE IS MEANINGLESS.**
 * `workload-perf-screen.mjs` reports `var-length` at 39.4 ms/query and **6.8 us/row** — but the row
 * bodies all end `RETURN DISTINCT b.n`, and the fixture has only ~97 distinct `n` values, so the row
 * count is the DISTINCT CARDINALITY while the work is per PATH. Dividing one by the other measures
 * nothing. The screen's own footer says exactly this ("a NOMINATION needs its own floor before it is
 * a finding"); this probe is that floor.
 *
 * **IT IS "VARY ONLY THE PROJECTION" APPLIED INSIDE ONE FAMILY** ([[vary-only-the-projection]]).
 * The seven bodies differ along three axes that each select a different rung, and the family average
 * blends them:
 *
 *   - PROJECTION:  `RETURN DISTINCT b.n`  vs  `RETURN count(*)`
 *   - SEED:        unseeded  vs  `WHERE a.n = $p0`  (items 1978/1979 made the seeded COUNT flat in
 *                  |V|; whether the seeded DISTINCT is also flat is what this asks)
 *   - PATH MODE:   plain  vs  `MATCH TRAIL`  vs  `MATCH ACYCLIC`
 *
 * AND IT SWEEPS |V|, because the question is flat-vs-linear and not a ratio at one size
 * (CLAUDE.md). Item 1979's 897x was found exactly this way: the fast rung was FLAT across 5k-160k
 * while its sibling was linear, and a ratio at one size understates an unbounded gap.
 *
 * ROWS ARE PRINTED BESIDE EVERY TIME. A body that returns 0 rows measures a MISS, and a seeded
 * body whose seed matches nothing is the easiest way to get a flattering number here.
 *
 *     bun varlen-body-split-2000.mjs
 *     SIZES=5000,20000 BOUNDS='{1,2}' bun varlen-body-split-2000.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const SIZES = (process.env.SIZES ?? '5000,20000,40000').split(',').map(Number);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 5);
const BOUNDS = (process.env.BOUNDS ?? '{1,2}').split(';');

/*
 * THE GENERATOR SPLITS ON THE REPEAT INDEX, which is CLAUDE.md's hard rule: `to = (a*k + b) % N`
 * is invariant under `k -> k + N`, so a loop over `k < N*FANOUT` gives one vertex's FANOUT edges all
 * the SAME target. Out-degree, in-degree and isolated-vertex counts all look perfect and the graph is
 * FUNCTIONAL, so a k-hop count is `F^k * N` by construction — which is exactly the defect that made
 * items 1516/1518's fixtures return right answers 14x fast.
 */
const build = (n) => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 97, d: i } });
  }

  for (let e = 0; e < n * FANOUT; e += 1) {
    const i = e % n;
    const hop = Math.floor(e / n);

    g.addEdge({
      id: `e${String(e)}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % n) + 1)),
      labels: ['E'],
      properties: { w: i % 13 },
    });
  }

  // COUNT THE DISTINCT ENDPOINTS, the one line that catches a collapsed generator. A functional
  // graph has |E| distinct (from,to) pairs only if each source's FANOUT edges go to FANOUT targets.
  const seen = new Set();

  for (const v of g.vertices) {
    const box = v.adjFrom?.get('E');

    if (box !== undefined) {
      const tos = new Set();

      for (const edge of box) {
        tos.add(edge.to.id);
      }

      seen.add(tos.size);
    }
  }

  return { g, degrees: [...seen].sort((a, b) => a - b) };
};

/*
 * **THE FULL GRID, BECAUSE THE FIRST VERSION OF THIS PROBE CHANGED TWO AXES AT ONCE.** It
 * carried the screen's seven bodies verbatim, and the two rows that looked like findings —
 * `count(*) ACYCLIC seeded` at 9.8x `count(*) unseeded`, and a seeded DISTINCT linear in |V| — each
 * differed from its comparator in BOTH the seed and the path mode. Neither was attributable.
 * Projection x seed x path mode, every combination, is the only way to read one axis at a time.
 *
 * **AND THE SEED AXIS HAS THREE VALUES, NOT TWO, BECAUSE OF [[closed-perf-targets]] ITEM 570:
 * `WHERE <matches everything>` IS THE CONTROL for "why is the filtered version slower".** Without
 * it, a seeded arm being slower than an unseeded one cannot distinguish "the predicate's PRESENCE
 * changed the rung" from "the seed's SELECTIVITY is not being exploited" — and those have opposite
 * cures. `a.n >= 0` holds for every vertex, so it is a predicate that narrows nothing.
 */
const SEEDS = {
  unseeded: '',
  'WHERE-all': ' WHERE a.n >= 0',
  'seeded-1%': ' WHERE a.n = $p0',
};

const MODES = { plain: 'MATCH', TRAIL: 'MATCH TRAIL', ACYCLIC: 'MATCH ACYCLIC' };
const PROJ = { DISTINCT: 'RETURN DISTINCT b.n AS x', 'count(*)': 'RETURN count(*) AS x' };

const BODIES = {};

for (const [pn, pt] of Object.entries(PROJ)) {
  for (const [mn, mt] of Object.entries(MODES)) {
    for (const [sn, st] of Object.entries(SEEDS)) {
      BODIES[`${pn.padEnd(8)} ${mn.padEnd(7)} ${sn}`] = (b) =>
        `${mt} (a:T)-[:E]->${b}(b:T)${st} ${pt}`;
    }
  }
}

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

for (const bound of BOUNDS) {
  console.log(`\n=== bound ${bound}  fanout ${String(FANOUT)}  median of ${String(REPS)} ===`);
  console.log(
    `body                       ${SIZES.map((s) => `${String(s / 1000)}k`.padStart(11)).join('')}   rows@${String(SIZES.at(-1) / 1000)}k  shape`,
  );

  const graphs = SIZES.map((n) => build(n));

  for (const [name, make] of Object.entries(BODIES)) {
    const text = make(bound);
    const cells = [];
    let rows = 0;

    for (const [i, n] of SIZES.entries()) {
      const { g } = graphs[i];
      const ts = [];

      for (let r = 0; r < REPS; r += 1) {
        const t0 = performance.now();
        const got = [...query(g, text, { p0: 3 })];

        ts.push(performance.now() - t0);
        rows = got.length;
      }

      cells.push(med(ts));
      void n;
    }

    // FLAT vs LINEAR is the signal, not the ratio at one size.
    const growth = cells.at(-1) / cells[0];
    const sizeRatio = SIZES.at(-1) / SIZES[0];
    const shapeOf = (gr) => {
      if (gr < sizeRatio * 0.3) {
        return 'FLAT-ish';
      }

      return gr > sizeRatio * 0.8 ? 'linear+' : 'sub-linear';
    };
    const shape = shapeOf(growth);

    console.log(
      `${name.padEnd(26)} ${cells.map((c) => c.toFixed(2).padStart(11)).join('')}   ${String(rows).padStart(8)}  ${shape}${rows === 0 ? '  EMPTY — measures a MISS' : ''}`,
    );
  }

  console.log(`# distinct out-degrees per source: ${JSON.stringify(graphs.at(-1).degrees)}`);
}
