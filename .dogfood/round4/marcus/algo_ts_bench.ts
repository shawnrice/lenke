// Benchmark the TS-core graph algorithms (@lenke/core free functions, in-process).
// Generates a graph, loads it into a TS Graph, and times each algorithm once
// (whole-graph computations). Use to A/B the TS tuning.
//
// Run: N=100000 E=8 bun .dogfood/round4/marcus/algo_ts_bench.ts
import {
  connectedComponents,
  degree,
  Graph,
  labelPropagation,
  pagerank,
  shortestPath,
} from '@lenke/core';
import { deserialize } from '@lenke/serialization';

const N = Number(process.env.N ?? 100000);
const E = Number(process.env.E ?? 8);

// xorshift — deterministic, same shape as the native algo_bench.
let seed = 0x9e3779b97f4a7c15n;
const next = (): bigint => {
  seed ^= (seed << 13n) & 0xffffffffffffffffn;
  seed ^= seed >> 7n;
  seed ^= (seed << 17n) & 0xffffffffffffffffn;
  return seed;
};
const below = (n: number): number => Number(next() % BigInt(n));
const unit = (): number => Number(next() >> 11n) / 2 ** 53;

const lines: string[] = [];
for (let i = 0; i < N; i++) {
  lines.push(`{"type":"node","id":"p${i}","labels":["N"]}`);
}
for (let i = 0; i < N; i++) {
  for (let k = 0; k < E; k++) {
    lines.push(
      `{"type":"edge","from":"p${i}","to":"p${below(N)}","labels":["KNOWS"],"properties":{"w":${(unit() + 0.001).toFixed(6)}}}`,
    );
  }
}

const t0 = performance.now();
const g = deserialize(lines.join('\n'), 'ndjson', new Graph());
console.log(`built ${N} vertices, ~${N * E} edges in ${(performance.now() - t0).toFixed(0)} ms\n`);

const time = async (label: string, fn: () => unknown): Promise<void> => {
  const t = performance.now();
  const r = (await fn()) as unknown[];
  console.log(
    `  [${(performance.now() - t).toFixed(0).padStart(7)} ms] ${label} (${r.length} rows)`,
  );
};

await time('degree (out)', () => degree({ direction: 'out' }, g));
await time('connectedComponents', () => connectedComponents({}, g));
await time('labelPropagation (10 iters)', () => labelPropagation({}, g));
await time('pagerank (20 iters, unweighted)', () => pagerank({}, g));
await time('pagerank (20 iters, weighted)', () => pagerank({ weightProperty: 'w' }, g));
await time('shortestPath BFS (from p0)', () => shortestPath({ source: 'p0' }, g));
await time('shortestPath Dijkstra (from p0)', () =>
  shortestPath({ source: 'p0', weightProperty: 'w' }, g),
);
