/**
 * Where does GQL's filtered node count lose 1.61x to Gremlin's?
 *
 * `surface-parity-probe` has `filter-count` at GQL 3.80/4.01 ms against Gremlin 2.43/2.34 for the
 * same question — `MATCH (n:P) WHERE n.age > 45 RETURN count(*)` versus
 * `V().hasLabel('P').has('age', gt(45)).count()`. Both scan 200,000 vertices and keep ~49%, so it
 * is a constant factor on a per-vertex predicate, not a route difference.
 *
 * THE DECOMPOSITION USES `WHERE true` AS THE CONTROL, which is item 570's recorded instrument for
 * exactly this question ("`WHERE true` is THE control for 'why is the filtered version slower'").
 * Three arms separate the costs that get conflated:
 *
 *     bare     no predicate at all — a bucket SIZE, so this is the floor
 *     vacuous  `WHERE true` / `has` that cannot fail — scan machinery WITHOUT predicate work
 *     real     the actual range predicate — scan machinery WITH it
 *
 * `real - vacuous` is the predicate's own cost per vertex; `vacuous - bare` is what the scan
 * machinery costs before any predicate runs. Whichever term carries the 1.61x is the one to fix,
 * and attacking the wrong one is how item 1105 spent a cycle ablating a cost that was free.
 *
 *     SURFACE=gql|grm  ARM=bare|vacuous|real  N=200000
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { count, gt, has, hasLabel, lt, toArray, traversal, V } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 14);
const SURFACE = process.env.SURFACE ?? 'gql';
const ARM = process.env.ARM ?? 'real';

const graph = new Graph();

for (let i = 0; i < N; i++) {
  graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { age: i % 90, tag: `t${i % 7}` } });
}

/**
 * ⚠️ `vacuous` IS `n.age > -1`, NOT `WHERE true`, and the difference invalidated this probe's first
 * run. `WHERE true` is a CONSTANT the planner can fold away, so it measures a scan with no
 * predicate machinery at all — while the Gremlin arm below still reads the property and compares.
 * The two were not the same experiment, and `real - vacuous` was not comparable across surfaces:
 * GQL read 1.8338 against Gremlin's 2.4204 and the difference was the folded predicate, not a
 * faster scan.
 *
 * `n.age > -1` cannot fail (age is `i % 90`) and cannot be folded, so it keeps the property read
 * and the comparison while removing every rejection — the same shape as the Gremlin arm. This is
 * item 1304's trap in its adjacent form: a vacuous arm that tests something different.
 *
 * `trueConst` is kept as a FOURTH arm rather than deleted, because the fold itself is worth a
 * number: it is the floor a filtered count could reach if the predicate were free.
 */
const GQL: Record<string, string> = {
  bare: 'MATCH (n:P) RETURN count(*) AS c',
  trueConst: 'MATCH (n:P) WHERE true RETURN count(*) AS c',
  vacuous: 'MATCH (n:P) WHERE n.age > -1 RETURN count(*) AS c',
  real: 'MATCH (n:P) WHERE n.age > 45 RETURN count(*) AS c',
  // CONTROL for item 1338: TWO comparisons, which `specializeCmpProp`'s single-entry guard
  // refuses, so the specialization cannot reach this row. It must stay flat.
  twoPred: 'MATCH (n:P) WHERE n.age > 45 AND n.age < 80 RETURN count(*) AS c',
};

// `has('age', gt(-1))` is the Gremlin vacuous arm: age is `i % 90` so it CANNOT fail, which keeps
// the predicate machinery in the plan while removing every rejection. A `hasLabel` that matches
// everything would test something different — item 1304 got that group wrong on the GQL side.
const GRM: Record<string, ReturnType<typeof traversal>> = {
  bare: traversal(V(), hasLabel('P'), count()),
  // No Gremlin twin for `trueConst`: there is no constant-predicate spelling to fold, which is
  // itself part of the answer.
  trueConst: traversal(V(), hasLabel('P'), count()),
  vacuous: traversal(V(), hasLabel('P'), has('age', gt(-1)), count()),
  real: traversal(V(), hasLabel('P'), has('age', gt(45)), count()),
  twoPred: traversal(V(), hasLabel('P'), has('age', gt(45)), has('age', lt(80)), count()),
};

const series: number[] = [];
let answer = 0;

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();

  if (SURFACE === 'gql') {
    answer = Number(query(graph, GQL[ARM], {})[0]?.c);
  } else {
    answer = Number(toArray(GRM[ARM], graph)[0]);
  }

  series.push(performance.now() - t0);
}

const kept = series.slice(3).sort((a, b) => a - b);

console.log(
  `${SURFACE}\t${ARM}\tanswer=${answer}\tMEDIAN ${kept[Math.floor(kept.length / 2)].toFixed(4)} ms`,
);
