/**
 * Where does Gremlin's terminal aggregate spend its time? (item 1585)
 *
 * `cross-surface-probe` flags two of this family against their ISO-GQL twins over the same graph:
 *
 *     max     V().values('k').max()   2.571ms   against  RETURN max(n.k)   1.046   2.46x
 *     sum     V().values('k').sum()   2.463            RETURN sum(n.k)   1.514   1.63x
 *
 * Both answer identically, so this is one question costing 1.6-2.5x more on one surface.
 *
 * ⚠️ ONE ARM PER PROCESS (`ARM=`). Items 1578/1579 each produced an IMPOSSIBLE in-process reading
 * because several arms shared a call site and whichever ran first paid — and item 1578 additionally
 * found that the 32-shape Gremlin probe builds every plan ONCE and reuses it, so it has never
 * measured plan construction. This probe builds the plan outside the timed loop DELIBERATELY (the
 * question is the walk, not construction, which item 1577 already took), and says so rather than
 * leaving it ambiguous.
 *
 *     for a in max sum min count fold values gqlmax gqlsum; do ARM=$a node gremlin-agg-probe.mjs; done
 *     ARM=max PROFILE=1 node --cpu-prof --cpu-prof-dir=/tmp/x gremlin-agg-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import * as G from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 50_000);
const REPS = Number(process.env.REPS ?? 15);
const ARM = process.env.ARM ?? 'max';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } });
}

/** Gremlin arms: the plan is built once, outside the timed loop — see the header. */
const GREMLIN = {
  max: G.traversal(G.V(), G.values('k'), G.max()),
  sum: G.traversal(G.V(), G.values('k'), G.sum()),
  min: G.traversal(G.V(), G.values('k'), G.min()),
  mean: G.traversal(G.V(), G.values('k'), G.mean()),
  // The same walk under a COUNT, which is the cheap terminal — so the gap between this and `max`
  // is what the aggregate itself costs over just producing the values.
  count: G.traversal(G.V(), G.values('k'), G.count()),
  // The walk with NO terminal aggregate: the floor for producing 50,000 property values.
  values: G.traversal(G.V(), G.values('k')),
  // `fold` collects to a list, to separate "walk + materialize" from "walk + reduce".
  fold: G.traversal(G.V(), G.values('k'), G.fold()),
  // The element walk with no property read at all, for the other end of the floor.
  justv: G.traversal(G.V(), G.count()),
  // ⚠️ THE SPELLING PAIR. `fuseValuesIsCount` rewrites `values(k).is(p).count()` to
  // `has(k, p).count()` and argues the equivalence carefully: `values(k)` emits one value per
  // element when properties are single-valued, so the two agree on HOW MANY. With no `is` the
  // same argument gives `values(k).count()` == `has(k).count()` — but the rewrite requires an
  // `is`, so the plain spelling is not fused. `has(k).count()` reaches the count rungs.
  hascount: G.traversal(G.V(), G.has('k'), G.count()),
  // And the same pair WITH the predicate, which IS fused — the control that says the rewrite
  // works where it applies.
  valuesiscount: G.traversal(G.V(), G.values('k'), G.is(G.gt(44)), G.count()),
  hasgtcount: G.traversal(G.V(), G.has('k', G.gt(44)), G.count()),
};

/** The GQL twins, so the comparison is in ONE instrument rather than across two. */
const GQL = {
  gqlmax: 'MATCH (n:P) RETURN max(n.k) AS m',
  gqlsum: 'MATCH (n:P) RETURN sum(n.k) AS s',
  gqlmin: 'MATCH (n:P) RETURN min(n.k) AS m',
  gqlcount: 'MATCH (n:P) RETURN count(*) AS c',
  gqlvalues: 'MATCH (n:P) RETURN n.k AS k',
};

const plan = GREMLIN[ARM];
const text = GQL[ARM];

if (plan === undefined && text === undefined) {
  throw new Error(
    `unknown arm ${ARM}; have ${[...Object.keys(GREMLIN), ...Object.keys(GQL)].join(',')}`,
  );
}

const run = plan === undefined ? () => query(g, text) : () => G.toArray(plan, g);
const out = run();
const s = [];

for (let i = 0; i < REPS; i += 1) {
  const t0 = performance.now();

  run();
  s.push(performance.now() - t0);
}

// 15 reps, drop three as warm-up, MEDIAN of the rest — `ts-spelling-probe`'s estimator. The series
// is printed because item 1582 had a 9-rep median land on the wrong mode of a bimodal series.
const kept = s.slice(3).sort((a, b) => a - b);
const first = Array.isArray(out) ? out[0] : out;
const answer =
  first !== null && typeof first === 'object'
    ? `${Array.isArray(out) ? out.length : 1} rows`
    : first;

console.log(
  JSON.stringify({
    arm: ARM,
    surface: plan === undefined ? 'gql' : 'gremlin',
    answer,
    ms: Number((kept[Math.floor(kept.length / 2)] ?? 0).toFixed(3)),
    series: s.map((x) => Number(x.toFixed(1))),
  }),
);
