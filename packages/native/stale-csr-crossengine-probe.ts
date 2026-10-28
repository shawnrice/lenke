// The SAME 2x2 on BOTH engines: does the TS engine degrade after a write the way native does?
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const LIB = new URL('../../crates/lenke-engine/target/release/liblenke_engine.so', import.meta.url)
  .pathname;
const N = Number(process.env.STALE_N ?? 50_000);
const SEL = Number(process.env.STALE_SEL ?? 50);
const REPS = 14;
const Q = 'MATCH ()-[:WANTED]->(b) RETURN count(*) AS c';

const lines: string[] = [];
const ts = new TsGraph();
const vs: ReturnType<TsGraph['addVertex']>[] = [];

for (let i = 0; i < N; i++) {
  lines.push(`{"type":"node","id":"v${i}","labels":["P"],"properties":{"n":${i}}}`);
  vs.push(ts.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }));
}

for (let e = 0; e < N * 3; e++) {
  const t = e % SEL === 0 ? 'WANTED' : `OTHER${e % 7}`;
  const from = (e * 104729) % N;
  const to = (e * 7919) % N;
  lines.push(
    `{"type":"edge","id":"e${e}","labels":["${t}"],"from":"v${from}","to":"v${to}","properties":{"w":${e % 5}}}`,
  );
  ts.addEdge({ id: `e${e}`, from: vs[from], to: vs[to], labels: [t], properties: { w: e % 5 } });
}

const time = (label: string, run: () => unknown): void => {
  const series: number[] = [];
  let answer: unknown;

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    answer = run();
    series.push(performance.now() - t0);
  }

  const warm = series.slice(3).sort((a, b) => a - b);
  const median = warm[Math.floor(warm.length / 2)] ?? 0;
  console.log(
    `  ${label.padEnd(30)} ${median.toFixed(4).padStart(9)} ms   answer=${String(answer)}`,
  );
};

console.log(`\n# ${N} nodes, ${N * 3} edges, 1 in ${SEL} WANTED\n`);

// TS: before and after a write.
time('ts    BEFORE a write', () => tsQuery(ts, Q)[0]?.c);
ts.addVertex({ id: 'zz1', labels: ['P'] });
ts.addEdge({ id: 'zzE', from: vs[0], to: vs[1], labels: ['OTHER0'], properties: { w: 0 } });
time('ts    AFTER a write', () => tsQuery(ts, Q)[0]?.c);

// native: before and after.
const bytes = new TextEncoder().encode(lines.join('\n'));
using a = graphFromNdjson(createFfiEngineBackend(LIB), bytes);
time('nativ BEFORE a write', () => a.query(Q)[0]?.c);
using b = graphFromNdjson(createFfiEngineBackend(LIB), bytes);
b.query('INSERT (:P {n: -1})-[:OTHER0 {w: 0}]->(:P {n: -2})');
time('nativ AFTER a write', () => b.query(Q)[0]?.c);
