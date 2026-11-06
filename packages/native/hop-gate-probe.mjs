/**
 * What does a filtered HOP's per-element gate cost? (item 1601)
 *
 * Item 1600 pre-resolved each gate conjunct once per query in `nodeScanGate` and measured
 * 1.25-1.31x on a filtered node scan. It also found that the SAME `reduceRight` composition appears
 * EIGHT times in `shortcuts.ts` — the three-hop interior, the two-hop middle, the keyed and
 * anchored walks — and that only `nodeScanGate`'s had the arm.
 *
 * This is the instrument for the other seven. Each shape names which endpoint carries the gate, so
 * a change that reaches one and not another is visible rather than averaged away.
 *
 * ⚠️ ONE SHAPE PER PROCESS (items 737, 762): `SHAPE=<key>` selects. Running them together moved a
 * row 20% by POSITION in item 1600's own probe.
 *
 *     SHAPE=far-count node hop-gate-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 400);
const SHAPE = process.env.SHAPE ?? 'far-count';

const TEXT = {
  // The gate on the FAR endpoint of a one-hop count.
  'far-count': 'MATCH (a:User)-[:E]->(b:User) WHERE b.team = $v RETURN count(*) AS c',
  // The gate on the START, which seeds.
  'start-count': 'MATCH (a:User)-[:E]->(b:User) WHERE a.team = $v RETURN count(*) AS c',
  // Far gate, projecting — a different rung from the count.
  'far-proj': 'MATCH (a:User)-[:E]->(b:User) WHERE b.team = $v RETURN b.score AS s',
  // The inline spelling of the far gate, which must not diverge from the clause one.
  'far-inline': 'MATCH (a:User)-[:E]->(b:User {team: $v}) RETURN count(*) AS c',
  // Two hops, so the MIDDLE gate is the one that runs.
  'mid-count':
    'MATCH (a:User)-[:E]->(b:User)-[:E]->(c:User) WHERE b.team = $v RETURN count(*) AS c',
  // NULL CONTROL: a gate that CANNOT specialize — two conjuncts, so item 1600's arm is
  // unreachable and the gate still runs per element. Movement here is this run's variance.
  'two-conjunct-count':
    'MATCH (a:User)-[:E]->(b:User) WHERE b.team = $v AND b.score > 50 RETURN count(*) AS c',
  // NULL CONTROL: no predicate anywhere, so no gate is built at all.
  'nofilter-count': 'MATCH (a:User)-[:E]->(b:User) RETURN count(*) AS c',
}[SHAPE];

if (TEXT === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}`);
}

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `u${i}`,
    labels: ['User'],
    properties: { name: `user${i}`, score: i % 100, team: `t${i % 50}` },
  });
}

/**
 * ⚠️ THE TARGET IS SPLIT ON THE REPEAT INDEX, NOT ON `k`. `to = (a * k + b) % N` is INVARIANT under
 * `k -> k + N`, so a loop over `k < NODES * FANOUT` gives every one of a vertex's FANOUT edges the
 * SAME target — out-degree, in-degree and isolated counts all look perfect and the graph is
 * FUNCTIONAL (CLAUDE.md, items 1516/1518). `Math.floor(k / NODES)` is what makes the fanout branch.
 */
let edges = 0;

for (let k = 0; k < NODES * FANOUT; k += 1) {
  const from = k % NODES;
  const rep = Math.floor(k / NODES);
  const to = (from * 7 + rep * 2657 + 1) % NODES;

  if (to === from) {
    continue;
  }

  g.addEdge({
    id: `e${k}`,
    from: g.getVertexById(`u${from}`),
    to: g.getVertexById(`u${to}`),
    labels: ['E'],
    properties: {},
  });
  edges += 1;
}

// COUNT THE DISTINCT ENDPOINTS before trusting any number off this fixture — the one line that
// would have caught item 702 and items 1516/1518.
const targets = new Set();
const sources = new Set();

for (const e of g.edges) {
  targets.add(e.to.id);
  sources.add(e.from.id);
}

const degreeOf = new Map();

for (const e of g.edges) {
  degreeOf.set(e.from.id, (degreeOf.get(e.from.id) ?? 0) + 1);
}

const branching = [...degreeOf.values()].filter((d) => d > 1).length;

console.log(
  `${NODES} vertices, ${edges} edges, ${targets.size} distinct targets, ${sources.size} distinct sources, ` +
    `${branching} vertices with out-degree > 1`,
);

if (targets.size < NODES * 0.5 || branching < NODES * 0.5) {
  throw new Error('DEGENERATE FIXTURE — the generator collapsed; see the comment above');
}

const paramOf = (i) => ({ v: `t${i % 50}` });

for (let i = 0; i < 40; i += 1) {
  query(g, TEXT, paramOf(i));
}

const answer = JSON.stringify(query(g, TEXT, paramOf(1)).slice(0, 2));
const t0 = performance.now();

for (let i = 0; i < REPS; i += 1) {
  query(g, TEXT, paramOf(i));
}

const ns = ((performance.now() - t0) * 1e6) / REPS;

console.log(
  `${SHAPE.padEnd(16)} ${ns.toFixed(0).padStart(8)} ns/op   answer ${answer}   (${TEXT})`,
);
