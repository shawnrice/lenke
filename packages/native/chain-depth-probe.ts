// Item 298 cross-engine check and the RUST half of the question.
//
// The differential fuzzer does not generate chains of five or more segments, so `longChainCount`
// has no generated coverage — only the clause-WHERE oracle in `long-chain-count.test.ts`. This
// asks the SECOND engine the same questions, which is the check the fuzzer would have been.
//
// It also prices native at the same depths. Native's `exec` tallies an aggregate-over-chain and
// never materializes the frontier (item 296), so it does not OOM — but tallying is still one
// visit per PATH, so the open question is whether it has the same O(degree^hops) cliff in TIME.
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

import { nativeBackend } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const NODES = 200;
const DEG = 5;
const REPS = 3;
const MAX_HOPS = 11;

// One NDJSON corpus, decoded by both engines, so neither can disagree about the fixture.
const ndjson = (): string => {
  const lines: string[] = [];

  for (let i = 0; i < NODES; i++) {
    lines.push(JSON.stringify({ type: 'vertex', id: `v${i}`, labels: ['N'], properties: { i } }));
  }

  for (let i = 0; i < NODES; i++) {
    for (let d = 0; d < DEG; d++) {
      lines.push(
        JSON.stringify({
          type: 'edge',
          id: `e${i}_${d}`,
          from: `v${i}`,
          to: `v${(i * 7 + d * 31 + 1) % NODES}`,
          labels: ['E'],
          properties: {},
        }),
      );
    }
  }

  return `${lines.join('\n')}\n`;
};

const chain = (hops: number): string => {
  let q = 'MATCH (a:N)';

  for (let h = 0; h < hops; h++) {
    q += `-[:E]->(n${h})`;
  }

  return `${q} RETURN count(*) AS c`;
};

const SEED = ndjson();
const tsGraph = new Graph();

// `@lenke/serialization` is the TS decoder; build the TS graph directly instead, from the same
// generator, so this probe depends on one fewer package.
{
  const ids = Array.from({ length: NODES }, (_, i) =>
    tsGraph.addVertex({ labels: ['N'], properties: { i } }),
  );

  for (let i = 0; i < NODES; i++) {
    for (let d = 0; d < DEG; d++) {
      tsGraph.addEdge({
        from: ids[i],
        to: ids[(i * 7 + d * 31 + 1) % NODES],
        labels: ['E'],
        properties: {},
      });
    }
  }
}

const nat = graphFromNdjson(nativeBackend(), SEED);

const timed = (run: () => number): { ms: number; answer: number } => {
  let best = Infinity;
  let answer = -1;

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    const a = run();
    const dt = performance.now() - t0;

    best = Math.min(best, dt);
    answer = a;
  }

  return { ms: best, answer };
};

/** ns per PATH — the RATE, which is what tells a degree product from an enumeration. */
const rate = (ms: number, n: number): string => (n > 0 ? ((ms * 1e6) / n).toFixed(1) : '-');

console.log(`nodes=${NODES} degree=${DEG} min of ${REPS}`);
console.log('hops  paths         ts ms      ts ns/path    native ms   nat ns/path   agree');

for (let hops = 2; hops <= MAX_HOPS; hops++) {
  const q = chain(hops);
  const ts = timed(() => ([...tsQuery(tsGraph, q)] as { c: number }[])[0]?.c ?? -1);
  const nt = timed(() => {
    const rows = nat.query(q) as { c: number }[];

    return rows[0]?.c ?? -1;
  });
  console.log(
    `${String(hops).padEnd(6)}${String(ts.answer).padEnd(14)}` +
      `${ts.ms.toFixed(2).padStart(9)}${rate(ts.ms, ts.answer).padStart(14)}` +
      `${nt.ms.toFixed(2).padStart(13)}${rate(nt.ms, nt.answer).padStart(14)}` +
      `   ${ts.answer === nt.answer ? 'yes' : `NO (native ${nt.answer})`}`,
  );
}

nat.free();
