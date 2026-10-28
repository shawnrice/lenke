/**
 * ONE SHAPE PER PROCESS: the constrained UNDIRECTED hop count arm (item 1076).
 *
 * `undirected-count-probe.ts` priced the arithmetic (item 1075); this measures the ENGINE before
 * and after, with the controls that say the change reached only what it was meant to.
 *
 *   cd packages/native && SHAPE=clause bun undirected-arm-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const N = Number(process.env.UA_N ?? 200_000);
const REPS = Number(process.env.UA_REPS ?? 14);

const SHAPES: Record<string, { q: string; reached: boolean }> = {
  // SUBJECTS: a start-only constraint on an undirected hop, one typed relationship.
  clause: {
    q: 'MATCH (a:Person)-[:KNOWS]-(x) WHERE a.age > 60 RETURN count(*) AS c',
    reached: true,
  },
  inline: { q: 'MATCH (a:Person {age: 61})-[:KNOWS]-(x) RETURN count(*) AS c', reached: true },
  'clause-indexed': {
    q: 'MATCH (a:Person)-[:KNOWS]-(x) WHERE a.age = 61 RETURN count(*) AS c',
    reached: true,
  },

  // CONTROLS.
  // Unconstrained: keeps the O(1) bucket arithmetic and must NOT move.
  bare: { q: 'MATCH (a:Person)-[:KNOWS]-(x) RETURN count(*) AS c', reached: false },
  // The DIRECTED twin — the arm's own template, reached through `startOnlyHopCount`, which this
  // change calls twice rather than altering. If it moves, the change leaked.
  directed: {
    q: 'MATCH (a:Person)-[:KNOWS]->(x) WHERE a.age > 60 RETURN count(*) AS c',
    reached: false,
  },
  // SUBJECTS since item 1086, which replaced the last three declines with `undirectedTally` — the
  // existing directed tally run once per direction. They were the three LARGEST numbers on this
  // board while they were controls, which is what made them the target:
  //   far-label 362.34 -> 76.17 (4.8x), far-pred 895.82 -> 66.61 (13.5x), rel-pred 913.18 -> 35.57
  //   (25.7x), with `clause` and `untyped` — the degree-sum arm — flat at 0.98x and 1.01x.
  // NOTHING DECLINES HERE ANY MORE, so this file has no `reached: false` rows left except the ones
  // that were never declines: the unconstrained O(1) arithmetic and the directed twin.
  'far-label': {
    q: 'MATCH (a:Person)-[:KNOWS]-(x:Person) WHERE a.age > 60 RETURN count(*) AS c',
    reached: true,
  },
  'far-pred': {
    q: 'MATCH (a:Person)-[:KNOWS]-(x) WHERE x.age > 60 RETURN count(*) AS c',
    reached: true,
  },
  'rel-pred': {
    q: 'MATCH (a:Person)-[r:KNOWS]-(x) WHERE r.w = 1 RETURN count(*) AS c',
    reached: true,
  },
  // SUBJECTS since item 1078, which replaced item 1076's decline on these two with an exact
  // correction: `two-types` 331.53 -> 30.58 and `untyped` 254.07 -> 25.94, both answering what
  // the declining arm answered. They were CONTROLS here for exactly two ticks, and leaving the
  // flag stale would have printed the two subjects of a change as rows it could not reach.
  'two-types': {
    q: 'MATCH (a:Person)-[:KNOWS|LIKES]-(x) WHERE a.age > 60 RETURN count(*) AS c',
    reached: true,
  },
  untyped: { q: 'MATCH (a:Person)-[]-(x) WHERE a.age > 60 RETURN count(*) AS c', reached: true },
};

const name = process.env.SHAPE ?? 'clause';
const shape = SHAPES[name];

if (shape === undefined) {
  console.error(`SHAPE must be one of: ${Object.keys(SHAPES).join(', ')}`);
  process.exit(1);
}

const g = new TsGraph();
const vs: unknown[] = [];

for (let i = 0; i < N; i++) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90 } }));
}

/** Never `i`, so the fixture's self-loop count is exactly zero (item 1075's third correction). */
const target = (i: number, d: number): number => {
  const t = (i * 7919 + d * 104_729) % N;

  return t === i ? (i + 1) % N : t;
};

let e = 0;

for (let i = 0; i < N; i++) {
  for (let d = 0; d < 3; d++) {
    g.addEdge({
      id: `e${e++}`,
      labels: ['KNOWS'],
      from: vs[i] as never,
      to: vs[target(i, d)] as never,
      properties: { w: 1 },
    });
  }
}

// A handful of a SECOND type, so the two-types control is a real alternation.
for (let i = 0; i < 100; i++) {
  g.addEdge({
    id: `l${i}`,
    labels: ['LIKES'],
    from: vs[i] as never,
    to: vs[(i + 7) % N] as never,
    properties: { w: 2 },
  });
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['age'] });

const series: number[] = [];
let answer = '';

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();
  const rows = tsQuery(g, shape.q);

  series.push(performance.now() - t0);
  answer = JSON.stringify(rows);
}

const warm = series.slice(3).sort((a, b) => a - b);

console.log(`answer=${answer}`);
console.log(
  `${name.padEnd(16)} ${shape.reached ? 'SUBJECT' : 'CONTROL'}  median(reps 4+) ${warm[Math.floor(warm.length / 2)].toFixed(2)} ms   N=${N}`,
);
