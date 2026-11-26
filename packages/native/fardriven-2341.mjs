/**
 * **ARE THE THREE GQL GATE RELAXATIONS EXPOSED TO ITEM 2339's SHARING PENALTY? (item 2341)**
 *
 * Items 2293 and 2297/2298 shipped 13.2x, 27x and 24.2x by admitting shapes to far-driven rungs — **all
 * measured one shape per process.** Item 2339 then found a second GQL scan-family query costs `hopGql`
 * 1.06-1.14x through shared-rung polymorphism, and item 2340 confirmed the GREMLIN drains are immune.
 * **The GQL ships sit in the family that is NOT immune.**
 *
 * Arithmetic already bounds the risk: a 1.14x penalty against a 13-27x win is immaterial. **But the
 * penalty on THESE rungs is unmeasured, and assuming 1.14x is exactly the kind of transfer this stretch
 * has been punished for** — so it gets measured rather than reasoned.
 *
 * **THE LABEL IS `Cohort`, NOT `Group`, AND THAT IS ISO CONFORMANCE RATHER THAN TASTE.** `Group` is a
 * RESERVED WORD (it opens `GROUP BY`), so a bare `(g:Group)` is a syntax error — the engine says so and
 * names the fix (backticks for a delimited identifier). Renaming keeps the probe readable; the error
 * message was precise enough to diagnose on the first read.
 *
 * The far-driven shape needs an INDEX and a selective far end, which is what makes it take the rung at
 * all; item 2291 nearly published "an index does not help" from a probe that silently created none, so
 * `seekProof` below asserts the rung is reachable before any timing is believed.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const USERS = Number(process.env.USERS ?? 20_000);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 60);
const REPS = Number(process.env.REPS ?? 9);
const WITH = process.env.WITH ?? '';

const graph = new Graph();

/* A tenant with many users and a FEW groups — the authz shape item 2293 made O(results). */
for (let i = 0; i < USERS; i += 1) {
  graph.addVertex({
    id: `u${i}`,
    labels: ['User'],
    properties: { name: `user${i}`, team: `t${i % 50}`, score: i % 1000 },
  });
}

for (let g = 0; g < 20; g += 1) {
  graph.addVertex({ id: `g${g}`, labels: ['Cohort'], properties: { gname: `grp${g}` } });
}

for (let i = 0; i < USERS; i += 1) {
  graph.addEdge({
    id: `m${i}`,
    from: graph.getVertexById(`u${i}`),
    to: graph.getVertexById(`g${i % 20}`),
    labels: ['MEMBER'],
    properties: {},
  });
}

graph.createIndex({ on: 'vertex', kind: 'hash', keys: ['gname'] });

const SHAPES = {
  /* THE FAR-DRIVEN TARGET: a selective far anchor, which is what items 2293/2297 admitted. */
  farAnchor: () =>
    query(graph, 'MATCH (u:User)-[:MEMBER]->(g:Cohort {gname: $g}) RETURN u.name AS n', {
      g: 'grp7',
    }).length,
  /* THE PARTNER: a GQL scan-family query, the shape item 2339 showed is the culprit. */
  scan: () => query(graph, 'MATCH (u:User) WHERE u.score = 5 RETURN u.name AS nm').length,
  /* A second far-driven shape, to see whether two far-driven queries interfere with each other. */
  farOther: () =>
    query(graph, 'MATCH (u:User)-[:MEMBER]->(g:Cohort {gname: $g}) RETURN u.team AS t', {
      g: 'grp3',
    }).length,
};

/*
 * **THE RUNG MUST BE REACHABLE OR THE TIMING MEANS NOTHING.** A far-driven rung needs the index; with
 * none, the query falls to a whole scan and this probe would compare two scans while claiming to measure a
 * rung. 1,000 users per group against 20,000 total: a reading anywhere near the scan arm's cost would
 * say the rung declined.
 */
const proofRows = SHAPES.farAnchor();

if (proofRows !== USERS / 20) {
  throw new Error(`far anchor returned ${proofRows}, expected ${USERS / 20}`);
}

for (const n of Object.keys(SHAPES)) {
  for (let w = 0; w < 50; w += 1) {
    SHAPES[n]();
  }
}

const inners = {};

for (const n of Object.keys(SHAPES)) {
  let inner = 1;

  for (;;) {
    const t0 = performance.now();

    for (let i = 0; i < inner; i += 1) {
      SHAPES[n]();
    }

    if (performance.now() - t0 >= SAMPLE_MS || inner >= 100_000) {
      break;
    }

    inner *= 2;
  }

  inners[n] = inner;
}

const timeOne = (n) => {
  const fn = SHAPES[n];
  const inner = inners[n];
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    fn();
  }

  return (performance.now() - t0) / inner;
};

const names = WITH === '' ? ['farAnchor'] : ['farAnchor', WITH];
const acc = [];

for (let r = 0; r < REPS; r += 1) {
  for (const n of names) {
    const t = timeOne(n);

    if (n === 'farAnchor') {
      acc.push(t);
    }
  }
}

const med = [...acc].sort((a, b) => a - b)[Math.floor(acc.length / 2)];

console.log(
  `  WITH=${(WITH === '' ? '(alone)' : WITH).padEnd(9)} farAnchor ${(med * 1000).toFixed(1).padStart(8)} us  inner=${String(inners.farAnchor).padStart(5)}  rows=${proofRows}`,
);
