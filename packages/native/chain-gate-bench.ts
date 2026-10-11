// What an INLINE constraint at one position of a long chain costs, in both engines.
//
// Written to price item 303 and kept as its regression guard. Before that item the TS sweep
// refused any constrained node (`plainNode`), so one gated interior position declined every
// shortcut in the family and fell to the general matcher — 25-82x the unconstrained chain. The
// sweep VISITS every position, so a gate has a once-per-element place to go (item 219's argument,
// one family along), and the TS column now reads 1.2-1.7x.
//
// THE NATIVE COLUMN IS STILL THE OLD STORY, at 28-121x: `try_nhop_sweep_count` carries the base
// label only. That is the open follow-up, and this probe is how it gets priced.
//
// Each case is paired with the UNCONSTRAINED chain it routes beside, because the question is not
// "how long does the filtered count take" but "what does DECLINING cost" — and the honest control
// for a defeated shortcut is the same shape WITHOUT the filter, which item 290's rejected E68/E69
// note makes explicit.
//
// Run: cd packages/native && bun run bench:gate
import { Graph, type Vertex } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

import { nativeBackend } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const NODES = 20_000;
const DEG = 3;
const REPS = 3;

const lines: string[] = [];

for (let i = 0; i < NODES; i++) {
  lines.push(
    JSON.stringify({
      type: 'vertex',
      id: `v${i}`,
      labels: ['N'],
      properties: { k: i % 4, i },
    }),
  );
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

const tsGraph = new Graph();
const ids: Vertex[] = [];

for (let i = 0; i < NODES; i++) {
  ids.push(tsGraph.addVertex({ labels: ['N'], properties: { k: i % 4, i } }));
}

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

const nat = graphFromNdjson(nativeBackend(), `${lines.join('\n')}\n`);

/** A 5-hop chain; `at` is the interior position (1..4) that carries `{k: 1}`, or -1 for none. */
const chain = (at: number): string => {
  let q = 'MATCH (a:N)';

  for (let h = 0; h < 5; h++) {
    const name = `n${h}`;

    q += `-[:E]->(${name}${h === at ? ' {k: 1}' : ''})`;
  }

  return `${q} RETURN count(*) AS c`;
};

const timed = (run: () => number): { ms: number; answer: number } => {
  let best = Infinity;
  let answer = -1;

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    const a = run();

    best = Math.min(best, performance.now() - t0);
    answer = a;
  }

  return { ms: best, answer };
};

/** How many times the gated chain costs what the unconstrained one does. */
const ratio = (ms: number, free: number): string => `${(ms / free).toFixed(1)}x`.padStart(11);

console.log(`${NODES} vertices / ${NODES * DEG} edges, 5 hops, min of ${REPS}`);
console.log('constrained at      ts ms    vs free      native ms    vs free      answer   agree');

const freeTs = timed(() => ([...tsQuery(tsGraph, chain(-1))] as { c: number }[])[0]?.c ?? -1);
const freeNat = timed(() => {
  const rows = nat.query(chain(-1)) as { c: number }[];

  return rows[0]?.c ?? -1;
});

console.log(
  `${'(none)'.padEnd(20)}${freeTs.ms.toFixed(1).padStart(7)}${'-'.padStart(11)}` +
    `${freeNat.ms.toFixed(1).padStart(14)}${'-'.padStart(11)}` +
    `${String(freeTs.answer).padStart(12)}   ${freeTs.answer === freeNat.answer ? 'yes' : 'NO'}`,
);

for (let at = 0; at < 5; at++) {
  const q = chain(at);
  const ts = timed(() => ([...tsQuery(tsGraph, q)] as { c: number }[])[0]?.c ?? -1);
  const nt = timed(() => {
    const rows = nat.query(q) as { c: number }[];

    return rows[0]?.c ?? -1;
  });

  const label = at === 4 ? 'position 4 (last)' : `position ${at}`;

  console.log(
    `${label.padEnd(20)}${ts.ms.toFixed(1).padStart(7)}${ratio(ts.ms, freeTs.ms)}` +
      `${nt.ms.toFixed(1).padStart(14)}${ratio(nt.ms, freeNat.ms)}` +
      `${String(ts.answer).padStart(12)}   ${ts.answer === nt.answer ? 'yes' : `NO (${nt.answer})`}`,
  );
}

nat.free();
