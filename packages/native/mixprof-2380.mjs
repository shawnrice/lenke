/**
 * What dominates a CPU profile of a MIXED workload — many query shapes against one graph, round-robin,
 * the way an application drives the engine (item 2380).
 *
 * EVERY PROFILE THIS STRETCH HAS BEEN OF A SINGLE SHAPE, and that is the right instrument for an A/B
 * (`mixdelta-2338` measured the sharing penalty at 1-9%, which is what licenses quoting isolated figures).
 * But it answers a different question from this one. A single-shape profile sees monomorphic dispatch; a
 * mixed one sees the sites an application actually creates, and a frame can dominate here that no
 * single-shape profile shows at all.
 *
 * THE FIXTURE IS DELIBERATELY SMALL AND THE LOOP LONG. Item 2372's profile of a single arm was useless
 * because a 60,000-edge build swamped 724 samples; the cure is a build that is negligible against the
 * timed section, and the shapes here are all flat in |E| or linear with a small constant.
 *
 * NOT an A/B tool. It reports where the time goes in the mixed regime, nothing about whether a change
 * helped — for that, one shape per process.
 */
import { Graph } from '@lenke/core';
import * as gql from '@lenke/gql';
import { E, V, count, hasLabel, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 4_000);
const FAN = Number(process.env.FAN ?? 3);
const ROUNDS = Number(process.env.ROUNDS ?? 400);
const LABELS = Number(process.env.LABELS ?? 2);

const graph = new Graph();

for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({
    id: `v${i}`,
    /*
     * LABELS=1 makes the label VACUOUS (every vertex is a `Person`), which is what engages the 43
     * label-elision gates `label-vacuity-gates-fast-paths` records across 7 files. LABELS=2 (the default)
     * gives one vertex in seven a different label, so those gates DECLINE.
     *
     * That knob is the realistic-mode question, and it is NOT what `MIXED=1` tests in the screens:
     * the record says *"`MIXED=1` adds ONE ISOLATED off-label vertex, and a vertex with no edges cannot
     * affect a hop count"*. One isolated vertex declines a gate with a minimal perturbation; a real
     * people-graph has several labels each carrying substantial vertices AND edges, which declines the
     * same gates while every bucket stays large. This measures that regime instead.
     */
    labels: ['Person'],
    properties: { name: `person${i}`, age: i % 90, score: i % 1000, tier: 'a' },
  });
}

/*
 * `LABELS=2` ADDS OFF-LABEL VERTICES; IT DOES NOT RELABEL EXISTING ONES — and the first version did
 * relabel, which was a WORK-PARITY DEFECT that corrupted items 2383 and 2384. Giving one vertex in seven
 * the label `Admin` instead of `Person` left `MATCH (n:Person)` matching 14% FEWER ROWS, so the grouped
 * count read **0.90x** — the realistic arm FASTER — which is fewer rows, not label elision. Item 1934's
 * own setup is the correct one: *"ONE off-label vertex in 50,000 costs the read 6.2x"* — an ADDED vertex.
 *
 * These carry no edges, so they add no hop work either; the ONLY thing that changes between the arms is
 * whether the `Person` label is vacuous.
 */
if (LABELS > 1) {
  for (let i = 0; i < Math.max(1, NODES / 7); i += 1) {
    graph.addVertex({ id: `admin${i}`, labels: ['Admin'], properties: { name: `admin${i}` } });
  }
}

const seen = new Set();

for (let j = 0; j < NODES * FAN; j += 1) {
  const from = j % NODES;
  const to = (from * 7 + Math.floor(j / NODES) * 104_729 + 1) % NODES;

  seen.add(to);

  const a = graph.getVertexById(`v${from}`);
  const b = graph.getVertexById(`v${to}`);

  if (a === null || b === null) {
    throw new Error('fixture: missing endpoint');
  }

  graph.addEdge({ id: `e${j}`, from: a, to: b, labels: ['KNOWS'], properties: { w: j % 89 } });
}

/* A FUNCTIONAL graph answers correctly and measures fast (item 702 / 1518). */
if (seen.size < NODES * 0.5) {
  throw new Error(`degenerate fixture: ${seen.size} distinct endpoints of ${NODES}`);
}

/** `on` is `'vertex'`/`'edge'`, not `'node'` — the engine's own error named the fix. */
graph.createIndex({ on: 'vertex', kind: 'exact', keys: ['name'] });

/*
 * PRECOMPUTED IDS, NOT AN RNG CALL IN THE LOOP, for two reasons. The generator call would appear in the
 * profile as engine-adjacent work it is not, and the first version's indexed point lookup answered
 * rows=0 because one vertex in seven carries `Admin` rather than `Person` -- timing a MISS against a HIT,
 * which is item 2317's trap. These ids are all `Person` by construction.
 */
const PERSON_IDS = [];

for (let i = 0; i < NODES && PERSON_IDS.length < 512; i += 1) {
  if (i % 7 !== 0) {
    PERSON_IDS.push(i);
  }
}

const EDGE_IDS = Array.from({ length: 512 }, (_, i) => (i * 17) % (NODES * FAN));
let cursor = 0;

/*
 * THE SHAPES, chosen to span the routes an application mixes rather than to be individually interesting:
 * an indexed point lookup, a scan with a predicate, a hop count, a hop projection, a grouped count, an
 * id-seeded Gremlin lookup, a Gremlin hop and a Gremlin scan count. Each prints its row count so a shape
 * that silently answers nothing cannot pad the profile with a MISS (item 2317).
 */
const SHAPES = [
  [
    'gql point (indexed)',
    () =>
      gql.query(graph, 'MATCH (n:Person) WHERE n.name = $n RETURN n.age AS a', {
        n: `person${PERSON_IDS[cursor++ & 511]}`,
      }),
  ],
  [
    'gql scan + predicate',
    () => gql.query(graph, 'MATCH (n:Person) WHERE n.score > 900 RETURN count(*) AS c'),
  ],
  ['gql hop count', () => gql.query(graph, 'MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c')],
  [
    'gql hop projection',
    () => gql.query(graph, 'MATCH (a:Person)-[:KNOWS]->(b) RETURN b.age AS a LIMIT 50'),
  ],
  [
    'gql grouped count',
    () => gql.query(graph, 'MATCH (n:Person) RETURN n.age AS k, count(*) AS c'),
  ],
  [
    'gremlin V(id).values',
    () => toArray(traversal(V(`v${PERSON_IDS[cursor++ & 511]}`), values('age')), graph),
  ],
  [
    'gremlin E(id).values',
    () => toArray(traversal(E(`e${EDGE_IDS[cursor++ & 511]}`), values('w')), graph),
  ],
  ['gremlin scan count', () => toArray(traversal(V(), hasLabel('Person'), count()), graph)],
];

/* Warm every shape, so the profile is of steady-state dispatch rather than of tiering up. */
for (let w = 0; w < 30; w += 1) {
  for (const [, fn] of SHAPES) {
    fn();
  }
}

const rows = SHAPES.map(([name, fn]) => {
  const r = fn();

  return `${String(name)}=${Array.isArray(r) ? String(r.length) : '?'}`;
});

console.log(
  `  fixture ${NODES} nodes / ${NODES * FAN} edges, ${ROUNDS} rounds of ${SHAPES.length} shapes`,
);
console.log(`  rows: ${rows.join(' ')}`);

const t0 = performance.now();

/*
 * THE SHAPE WEIGHTING, which item 2383 named as its own caveat (item 2384).
 *
 * Item 2383 measured label vacuity at 5.5% over these eight shapes in EQUAL proportion, which no
 * application does, and said so. Inventing a "realistic" weighting would be worse than none, so this
 * brackets it with two defensible EXTREMES instead and reports a range:
 *
 *   equal     — the eight shapes once each (item 2383's figure)
 *   point     — 90% indexed point lookups, the regime where label elision matters MOST
 *   analytic  — 90% grouped counts and hop counts, which do not use label elision at all
 *
 * The weights are a repeat count per round, so no shape is ever dropped: a zero-weight shape would stop
 * its dispatch site being polymorphic and change the measurement for a reason unrelated to weighting.
 */
const WEIGHT = process.env.WEIGHT ?? 'equal';
const PLAN = SHAPES.flatMap(([name, fn]) => {
  let reps = 1;

  if (WEIGHT === 'point' && name.includes('point')) {
    reps = 64;
  }

  if (WEIGHT === 'analytic' && (name.includes('grouped') || name.includes('hop count'))) {
    reps = 32;
  }

  /*
   * `analytic` BUNDLES TWO SHAPE FAMILIES, so it cannot say which one produces the 1.26x item 2384
   * measured. These two weight each alone (item 2385): `grouped` is `detectGroupedNodeCount`'s rung (the
   * 15.6% frame of item 2382's attribution) and `hopcount` is `bareDegreeSum` under `startOnlyHopCount`
   * (the 14.1% frame). One of them walks a label bucket the elision gates can skip; the other may not.
   */
  if (WEIGHT === 'grouped' && name.includes('grouped')) {
    reps = 32;
  }

  if (WEIGHT === 'hopcount' && name.includes('hop count')) {
    reps = 32;
  }

  return Array.from({ length: reps }, () => fn);
});

console.log(`  weighting=${WEIGHT}: ${PLAN.length} queries a round`);

for (let r = 0; r < ROUNDS; r += 1) {
  for (const fn of PLAN) {
    fn();
  }
}

const dt = performance.now() - t0;

console.log(
  `  ${dt.toFixed(0)} ms for ${ROUNDS * PLAN.length} queries = ${((dt * 1000) / (ROUNDS * PLAN.length)).toFixed(2)} us/query`,
);
