/**
 * ONE SHAPE PER PROCESS: the filtered UNDIRECTED chain count (item 1097).
 *
 * `longChainCount` declined any `both` segment, so a filtered undirected chain fell to the general
 * pipeline — 2420.76 ms at three hops against the directed twin's 68.69 (item 1096 priced it).
 *
 * THE DIRECTED ROWS ARE THE CONTROLS THAT MATTER: `sweepChain` is the hot loop for every directed
 * long chain, and item 1091 measured a direction choice folded into a shared hop body costing a
 * control it could not reach 1.54x. A per-LEG direction loop should cost them nothing; these rows
 * are how that claim is checked rather than asserted.
 *
 *   cd packages/native && SHAPE=b3 bun chain-undirected-probe.ts
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.CU_N ?? 60_000);
const REPS = Number(process.env.CU_REPS ?? 9);

const g = new Graph();
const vs = Array.from({ length: N }, (_, i) =>
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { age: i % 90 } }),
);

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
      labels: ['T'],
      from: vs[i],
      to: vs[target(i, d)],
      properties: { w: 1 },
    });
  }
}

const SHAPES: Record<string, { q: string; reached: boolean }> = {
  // SUBJECTS: an undirected or mixed leg in a filtered chain.
  b3: {
    q: 'MATCH (a:P)-[:T]-(b)-[:T]-(c)-[:T]-(d) WHERE a.age > 60 RETURN count(*) AS c',
    reached: true,
  },
  b4: {
    q: 'MATCH (a:P)-[:T]-(b)-[:T]-(c)-[:T]-(d)-[:T]-(x) WHERE a.age > 60 RETURN count(*) AS c',
    reached: true,
  },
  mixed3: {
    q: 'MATCH (a:P)-[:T]-(b)-[:T]->(c)-[:T]-(d) WHERE a.age > 60 RETURN count(*) AS c',
    reached: true,
  },
  // CONTROLS: the DIRECTED chains, which share `sweepChain` and must not move.
  o3: {
    q: 'MATCH (a:P)-[:T]->(b)-[:T]->(c)-[:T]->(d) WHERE a.age > 60 RETURN count(*) AS c',
    reached: false,
  },
  o4: {
    q: 'MATCH (a:P)-[:T]->(b)-[:T]->(c)-[:T]->(d)-[:T]->(x) WHERE a.age > 60 RETURN count(*) AS c',
    reached: false,
  },
  o5: {
    q: 'MATCH (a:P)-[:T]->(b)-[:T]->(c)-[:T]->(d)-[:T]->(x)-[:T]->(y) WHERE a.age > 60 RETURN count(*) AS c',
    reached: false,
  },
  // The BARE undirected chain, answered by the degree product elsewhere — also untouched.
  bare3: { q: 'MATCH (a:P)-[:T]-(b)-[:T]-(c)-[:T]-(d) RETURN count(*) AS c', reached: false },
};

const name = process.env.SHAPE ?? 'b3';
const shape = SHAPES[name];

if (shape === undefined) {
  console.error(`SHAPE must be one of: ${Object.keys(SHAPES).join(', ')}`);
  process.exit(1);
}

const series: number[] = [];
let answer = '';

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();

  answer = JSON.stringify(query(g, shape.q));
  series.push(performance.now() - t0);
}

const warm = series.slice(2).sort((a, b) => a - b);

console.log(`answer=${answer}`);
console.log(
  `${name.padEnd(8)} ${shape.reached ? 'SUBJECT' : 'CONTROL'}  median(reps 3+) ${warm[Math.floor(warm.length / 2)].toFixed(2)} ms   N=${N}`,
);
