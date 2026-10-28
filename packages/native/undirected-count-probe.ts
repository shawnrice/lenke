/**
 * Item 1075: what would a START-ONLY arm be worth for a FILTERED UNDIRECTED hop count?
 *
 * `bun run bench`'s `count 1-hop UNDIRECTED` row reads ts 0.00 / native 1.5 ms, which looks like a
 * native gap — and it is one. But widening the family found a much larger TS gap next to it:
 *
 * ```text
 *   MATCH (a:Person)-[:KNOWS]-(x) RETURN count(*)                       ts 0.00  native 1.33
 *   MATCH (a:Person)-[:KNOWS]->(x) RETURN count(*)                         0.00         0.00
 *   MATCH (a:Person)-[]-(x) RETURN count(*)                                6.60         1.30
 *   MATCH (a:Person)-[:KNOWS]-(x) WHERE a.age > 60 RETURN count(*)       242.78         2.29   ← 106x
 * ```
 *
 * THE CAUSE IS EXPLICIT IN THE CODE. `buildOneHopCount` declines outright for a constrained
 * undirected hop:
 *
 * ```ts
 * if (rel.direction === 'both' &&
 *     (pred !== undefined || inNear !== undefined || inFar !== undefined || inRel !== undefined)) {
 *   return null;
 * }
 * ```
 *
 * so the query falls to the general path, which builds a binding and a row per edge. The DIRECTED
 * twin has had a degree-sum walk since item 129 (`startOnlyHopCount`): the answer for a start-only
 * filter is the sum of the passing vertices' degrees, read as bucket SIZES without visiting an edge.
 *
 * Undirected is the same sum over both adjacency boxes — `|adjFrom_T(v)| + |adjTo_T(v)|` — minus
 * one per self-loop, because `expand` emits a loop once where the two boxes hold it twice.
 *
 * THIS PROBE PRICES THE CEILING before the arm is built, because building it means refactoring the
 * per-candidate test out of a hot walk (items 119/159 both measured that costing unrelated shapes).
 * Two arms plus the controls:
 *
 *   degree-sum          the arm's arithmetic, loop-free graph
 *   degree-sum + loops  the same with the per-vertex loop correction, on a graph WITH loops
 *
 * ```text
 * cd packages/native && bun undirected-count-probe.ts
 * ```
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const N = Number(process.env.UC_N ?? 200_000);
const DEG = Number(process.env.UC_DEG ?? 3);
const REPS = Number(process.env.UC_REPS ?? 7);
const LOOPS = Number(process.env.UC_LOOPS ?? 0);

const g = new TsGraph();
const vs: unknown[] = [];

for (let i = 0; i < N; i++) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90 } }));
}

/** A scattered target that is NEVER `i`, so the fixture's loop count is exactly `LOOPS`. */
const target = (i: number, d: number): number => {
  const t = (i * 7919 + d * 104_729) % N;

  return t === i ? (i + 1) % N : t;
};

let e = 0;

for (let i = 0; i < N; i++) {
  for (let d = 0; d < DEG; d++) {
    g.addEdge({
      id: `e${e++}`,
      labels: ['KNOWS'],
      from: vs[i] as never,
      // GUARDED, not re-derived. Two multiplier formulas in a row carried ACCIDENTAL self-loops
      // (`(i * 7919 + d * 104729) % N` has a fixed point at i = 100,000), and the arm's loop
      // correction was gated on the loops I had ADDED rather than the loops the graph HAD — so it
      // answered 386,628 against the engine's 386,626, and then still ran the corrected arm when
      // I thought it was running the loop-free one. The assertion caught the first and the printed
      // `hasLoops` caught the second. A guard is provable where a formula is not.
      to: vs[target(i, d)] as never,
      properties: {},
    });
  }
}

for (let i = 0; i < LOOPS; i++) {
  g.addEdge({
    id: `l${i}`,
    labels: ['KNOWS'],
    from: vs[i] as never,
    to: vs[i] as never,
    properties: {},
  });
}

type E = { from: unknown; to: unknown };
type V = {
  properties: Record<string, unknown>;
  adjFrom?: Map<string, Set<E>>;
  adjTo?: Map<string, Set<E>>;
};

const bucket = (g as unknown as { verticesByLabel: Map<string, Iterable<V>> }).verticesByLabel.get(
  'Person',
) as Iterable<V>;

const med = (f: () => unknown): { ms: number; got: unknown } => {
  const series: number[] = [];
  let got: unknown;

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();

    got = f();
    series.push(performance.now() - t0);
  }

  const w = series.slice(2).sort((a, b) => a - b);

  return { ms: w[Math.floor(w.length / 2)], got };
};

// DETECTED, not assumed: the engine's own arm would ask `loopsOfTypes(graph, types)`, and the
// first cut of this probe asked "did I add any?" instead — which is how an off-by-two got past it.
const hasLoops =
  Number(tsQuery(g, 'MATCH (a)-[:KNOWS]->(b) WHERE a = b RETURN count(*) AS c')[0].c) > 0;

const Q = 'MATCH (a:Person)-[:KNOWS]-(x) WHERE a.age > 60 RETURN count(*) AS c';
const engine = med(() => tsQuery(g, Q));
const want = (engine.got as { c: number }[])[0].c;

// `hasLoops` is printed, not just used: it selects which arm runs, so a reader cannot tell what
// was measured without it — the same reason every arm here asserts its answer.
console.log(`N=${N} degree=${DEG} loops added=${LOOPS} graph HAS loops=${hasLoops} answer=${want}`);
console.log(`${'arm'.padEnd(28)} ${'ms'.padStart(9)}   answer`);
console.log(`${'ENGINE (general path)'.padEnd(28)} ${engine.ms.toFixed(1).padStart(9)}   ${want}`);

/** The arm's arithmetic: bucket SIZES over both boxes, minus one per self-loop. */
const degreeSum = med(() => {
  let n = 0;

  for (const v of bucket) {
    if ((v.properties.age as number) > 60) {
      const f = v.adjFrom?.get('KNOWS');
      const t = v.adjTo?.get('KNOWS');

      n += (f?.size ?? 0) + (t?.size ?? 0);

      // A SELF-LOOP sits in both boxes and `expand` emits it once, so it is counted twice above
      // and corrected here. Gated on the graph HAVING loops in the engine arm — `loopsOfTypes`
      // already exists for that — so a loop-free graph pays nothing for this.
      if (hasLoops && f !== undefined) {
        for (const edge of f) {
          if (edge.from === edge.to) {
            n -= 1;
          }
        }
      }
    }
  }

  return n;
});

if (degreeSum.got !== want) {
  throw new Error(
    `degree-sum answered ${String(degreeSum.got)}, want ${want} — the arm is not doing the work`,
  );
}

console.log(
  `${'degree-sum (the arm)'.padEnd(28)} ${degreeSum.ms.toFixed(1).padStart(9)}   ${String(degreeSum.got)}`,
);

// CONTROL: the same scan and the same filter, with NO degree read — so the distance between this
// and the arm is the two bucket-size lookups and nothing else.
const scanOnly = med(() => {
  let n = 0;

  for (const v of bucket) {
    if ((v.properties.age as number) > 60) {
      n += 1;
    }
  }

  return n;
});

console.log(
  `${'CONTROL scan+filter only'.padEnd(28)} ${scanOnly.ms.toFixed(1).padStart(9)}   ${String(scanOnly.got)} vertices`,
);
