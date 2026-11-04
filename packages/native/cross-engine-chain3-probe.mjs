/**
 * ONE GRAPH, ONE PROCESS: GQL's 3-hop count against Gremlin's (item 1426).
 *
 * Item 1425 put the two engines' numbers side by side from SEPARATE bench runs — GQL 46-49 ms, GQL
 * with the sweep forced 62, Gremlin 85 — and concluded the Gremlin sweep is 1.37x the GQL sweep.
 * Separate processes and separate benches is not a like-for-like comparison: different fixtures,
 * different warmup, different GC history.
 *
 * This builds ONE graph and asks both engines the same question in one process, arms alternated.
 * The answer is asserted equal across engines, which is also a cross-engine correctness check on a
 * shape the differential fuzzer does not cover (it compares TS against RUST, not GQL against
 * Gremlin).
 *
 * ⚠️ WHAT EACH PLANNER SEES IS NOT IDENTICAL, and that is the point of measuring rather than
 * assuming. GQL's bench row carries `(a:P)` and `(b:P)`; Gremlin's carries `hasLabel('P')` on the
 * start only. On this fixture every vertex is `P`, so both labels narrow NOTHING — GQL's route
 * comparison sees `candidateCount(P) === vertexCount` and keeps the degree product, and Gremlin's
 * `dropVacuousLabels` deletes the step outright (item 540). So the two are semantically the same
 * question reaching different routes, which is exactly what the gap is about.
 *
 *   NODES=100000 node cross-engine-chain3-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, count, hasLabel, out, toArray, traversal } from '@lenke/gremlin';

const N = Number(process.env.NODES ?? 100_000);
const FO = Number(process.env.FANOUT ?? 1);
const REPS = Number(process.env.REPS ?? 10);

const g = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
}

/**
 * ⚠️ THE SUCCESSOR FUNCTION IS A KNOB, and it is worth ~2x on this row (item 1426).
 *
 * `STRIDE=small` is `to = (i * 7 + 3) % N` — what `isolated-row-bench.mjs` builds. A vertex points
 * ~7 slots along, so the walk's successor is partly cache-resident.
 *
 * `STRIDE=random` (the default here) is `from = (k * 7919) % N`, `to = (k * 104729) % N` — both
 * large-stride permutations, so a vertex's successor is effectively random across the whole range.
 *
 * Both give out-degree and in-degree exactly 1 (each multiplier is coprime with N, so each is a
 * permutation) and both answer `N` for a 3-hop count. They differ ONLY in locality — and item 1066
 * measured that family at **9.3x** over far-pool width. Two of my own instruments disagreed 1.91x on
 * the identical query until this was the explanation.
 */
const STRIDE = process.env.STRIDE ?? 'random';

for (let k = 0; k < N * FO; k += 1) {
  const i = k % N;

  g.addEdge({
    id: `e${k}`,
    from: STRIDE === 'small' ? vs[i] : vs[(k * 7919) % N],
    to: STRIDE === 'small' ? vs[(i * 7 + 3) % N] : vs[(k * 104_729) % N],
    labels: ['E'],
  });
}

// GQL as the bench spells it (labels on both ends, both non-narrowing here) and UNLABELLED, so the
// route comparison's input is visible rather than inferred.
const GQL_LABELLED = 'MATCH (a:P)-[:E]->()-[:E]->()-[:E]->(b:P) RETURN count(*) AS c';
const GQL_BARE = 'MATCH (a)-[:E]->()-[:E]->()-[:E]->(b) RETURN count(*) AS c';
const gremlinPlan = traversal(V(), hasLabel('P'), out('E'), out('E'), out('E'), count());

const arms = {
  gqlLabelled: () => query(g, GQL_LABELLED)[0].c,
  gqlBare: () => query(g, GQL_BARE)[0].c,
  gremlin: () => toArray(gremlinPlan, g)[0],
};

const time = (fn) => {
  const xs = [];
  let a;

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();

    a = fn();
    xs.push(performance.now() - t);
  }

  const k = xs.slice(3).sort((x, y) => x - y);

  return { p25: k[Math.floor(k.length * 0.25)], a };
};

/**
 * ⚠️ ONE SHAPE PER PROCESS, selected by `ARM`, and the first version of this probe got it wrong.
 *
 * Running all three arms in one process makes every dispatch site in the executors polymorphic
 * across query shapes — the repo's own rule is "one shape per PROCESS, so no other shape pollutes
 * the dispatch", recorded after a two-shape in-process A/B flattered a change by 1.5x on its
 * CONTROLS. The three-arm version reported GQL at 88.92 ms where its own bench reads ~46 for the
 * identical query on an identically-shaped graph: a 1.9x inflation, which is the confound, not a
 * finding.
 *
 * So each run measures ONE arm and a driver alternates them across processes. That costs three
 * processes instead of one and is the only version whose numbers mean anything.
 */
const { ARM } = process.env;
const names = ARM === undefined ? Object.keys(arms) : [ARM];

if (ARM !== undefined && arms[ARM] === undefined) {
  throw new Error(`unknown ARM ${ARM}; have ${Object.keys(arms).join(',')}`);
}

const got = {};

for (let r = 0; r < 3; r += 1) {
  for (const n of names) {
    (got[n] ??= []).push(time(arms[n]));
  }
}

const med = (x) => {
  const s = [...x].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)];
};

// ⚠️ A CROSS-ENGINE ANSWER CHECK, which nothing else in the tree does for this shape: the
// differential fuzzer compares TS against RUST, not GQL against Gremlin.
const answers = new Set(names.map((n) => got[n][0].a));

if (answers.size !== 1) {
  throw new Error(`ENGINES DISAGREE: ${names.map((n) => `${n}=${got[n][0].a}`).join(' ')}`);
}

// With one arm per process the cross-engine answer check moves to the DRIVER, which compares the
// `answer` field across runs. Kept here for the all-arms mode, which is now only a smoke test.

const V2 = Object.fromEntries(names.map((n) => [n, med(got[n].map((r) => r.p25))]));

console.log(
  JSON.stringify({
    nodes: N,
    fanout: FO,
    answer: [...answers][0],
    arm: ARM ?? 'all',
    ...Object.fromEntries(names.map((n) => [n, Number(V2[n].toFixed(2))])),
  }),
);
