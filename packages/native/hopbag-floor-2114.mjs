/*
 * Item 2114 — what WOULD a fused `hop + bag + values` cost? The floor, before anything is built.
 *
 * 🔑 THE OPPORTUNITY, from item 2113's measurements. `hop-values.ts` admits `aggregate`/`store` as
 * RESIDUALS over the fused hop, so the bag and the projection run through the generic step machinery —
 * the route screen reports exactly "2 applyStep calls [store values]":
 *
 * ```text
 *     hop + values (no bag)      13 ns/row     <- the fused hop walk alone
 *     hop + store + values       89 ns/row     <- 6.7x for adding a bag
 *     scan + store + values      39 ns/row     <- FUSED at item 2113, now at its own no-bag floor
 * ```
 *
 * ⚠️⚠️ **THIS FILE'S `handFused` ARM IS NOT A VALID FLOOR, AND THAT IS THE ITEM'S FINDING.** It reads
 * 33-37 ms against the engine's 139, which looked like 4.17x available — so the fusion was built. ⚠️ It
 * delivered **1.00x** (139.9 LIVE against 138.9 KILLED, alternated, with a flat no-bag control), and the
 * reason is this arm: `toArray(traversal(V(), out('E')), g)` MATERIALIZES the hop's 600,000 far vertices
 * into an array first — using the fast bare-hop walk — and the loop below then scans a flat array. The
 * engine walks the LIVE adjacency. Two different traversals, so the comparison was never the bag's cost.
 *
 * 🔑 THE HONEST READING OF THE SAME NUMBERS: `engineBare` (28 ms) against `engine` (139) is **the BAG**,
 * not the step machinery — ~110 ms to push 600,000 vertex objects into an array, which no fusion removes.
 * Measured directly, the fused walk cost 104 ms where the generic route costs ~107.
 *
 * ⚠️ KEPT AS A WARNING RATHER THAN DELETED. A floor built from a materialized intermediate is a floor
 * for a different query; `floor-arm-must-take-same-route` is the rule and this is what breaking it costs.
 *
 * 🔑 THREE ARMS:
 *   - `engine`     — what runs today: fused hop + generic [store, values].
 *   - `handFused`  — the fused hop walk, bagged and projected BY HAND. The floor.
 *   - `engineBare` — the fused hop + `values` with NO bag, for the 13 ns/row reference.
 *
 * ⚠️ AND THE ANSWERS ARE ASSERTED EQUAL. A floor that emits different rows is not a floor.
 */
import { Graph } from '@lenke/core';
import { out, store, toArray, traversal, V, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 11);
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  /*
   * ⚠️ ONE VERTEX IN FIVE LACKS `n`, deliberately. Item 2078's rule is that the bag holds every element
   * the walk VISITS while the rows hold only those carrying the key — so a fixture where they coincide
   * cannot tell a correct fusion from one that bags the row set.
   */
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: i % 5 === 4 ? { other: i } : { n: i % 97 },
  });
}

let e = 0;

for (let d = 0; d < FANOUT; d += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3 + d * 104_729) % N}`),
      labels: ['E'],
      properties: {},
    });
    e += 1;
  }
}

const targets = new Set();

for (const edge of g.edgesById.values()) {
  targets.add(edge.to.id);
}

const arms = {
  /** TODAY: the fused hop with `[store, values]` as a generic residual. */
  engine: () => {
    /*
     * ⚠️ THE BAG IS NOT READ HERE, AND IT CANNOT BE: `toArray(plan, graph)` takes no context, and a bare
     * bag step has no public reader (items 2112 and 2113 both hit this). Appending a `cap` to expose it
     * would change the residual's length and so the route — a different shape, not this one.
     *
     * 🔑 SO THIS IS A PRICING ARM ONLY. The bag's CONTENTS are a correctness question and belong in the
     * engine's own tests, where `ctx.sideEffects` is reachable; what this arm measures is the cost of
     * the route that fills it.
     */
    const rows = toArray(traversal(V(), out('E'), store('x'), values('n')), g);

    return { rows: rows.length, bag: -1 };
  },
  /*
   * 🔑 THE FLOOR: the engine's own fused hop walk, bagged and projected by hand.
   *
   * ⚠️ IT TAKES THE SAME WALK. `traversal(V(), out('E'))` is the fused hop; iterating it and doing the
   * bag + projection in this loop is precisely what a fusion would do inside the walk, so this is an
   * upper bound rather than an unrelated hand traversal.
   */
  handFused: () => {
    const bag = [];
    const rows = [];

    for (const v of toArray(traversal(V(), out('E')), g)) {
      bag.push(v);

      const props = v.properties;

      if ('n' in props) {
        rows.push(props.n);
      }
    }

    return { rows: rows.length, bag: bag.length };
  },
  /** The no-bag reference. */
  engineBare: () => {
    const rows = toArray(traversal(V(), out('E'), values('n')), g);

    return { rows: rows.length, bag: -1 };
  },
};

console.log(
  `  N=${N} FANOUT=${FANOUT} edges=${e} distinct targets=${targets.size} (${((100 * targets.size) / N).toFixed(1)}%), median of ${REPS}\n`,
);

let reference;

for (const [name, fn] of Object.entries(arms)) {
  const series = [];
  let got = { rows: 0, bag: 0 };

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    got = fn();
    series.push(performance.now() - t0);
  }

  // ⚠️ THE ROWS MUST AGREE ACROSS ARMS, and the bag must differ from them (the keyless vertices).
  reference ??= got.rows;

  if (got.rows !== reference) {
    throw new Error(`${name}: ${got.rows} rows, expected ${reference}`);
  }

  /*
   * ⚠️ WHERE THE BAG IS VISIBLE IT MUST EXCEED THE ROWS — the keyless vertices are bagged and not
   * emitted. `-1` means the arm cannot observe its bag (see `engine` above), not that it has none.
   */
  if (got.bag !== -1 && got.bag <= got.rows) {
    throw new Error(
      `${name}: bag ${got.bag} is not LARGER than ${got.rows} rows — the fixture is wrong`,
    );
  }

  const kept = series.slice(3).sort((a, b) => a - b);
  const median = kept[Math.floor(kept.length / 2)];

  console.log(
    `  ${name.padEnd(11)} ${median.toFixed(1).padStart(7)} ms   ${((median * 1e6) / got.rows).toFixed(0).padStart(4)} ns/row   rows=${got.rows} bag=${got.bag}`,
  );
}
