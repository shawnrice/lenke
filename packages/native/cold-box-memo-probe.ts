/**
 * Does item 1334's adjacency-box read cost anything on a COLD graph?
 *
 * ⚠️ THIS EXISTS BECAUSE A PRIOR REFUTATION SAYS IT SHOULD. `CLOSED.md` records the box-read lever
 * as "ALREADY REFUTED at the site: item 355 measured it, and the box is a MEMO, so first touch is
 * 1.21x WORSE (the same hash plus the memo write) while warm is 1.35x better. The two-hop product
 * visits each middle exactly ONCE per query, so cold is all it would ever get."
 *
 * Item 1334 shipped that lever anyway at 1.92x warm, and did NOT cite this entry — I found
 * `twoHopSide`'s weaker "measured flat" header instead. Two corrections are owed and this probe
 * settles the second:
 *
 *   1. The premise "cold is all it would ever get" is WRONG for a repeated query. `Vertex.adjFrom`
 *      memoizes on the VERTEX and survives across queries until an adjacency write clears it, so
 *      only the first query on a graph is cold. That is a reading of the code, not a measurement.
 *
 *   2. Item 1334's own cold evidence is CONFOUNDED. Its probe reported the first REP of fourteen
 *      (79-97 ms against a 23 ms steady state) — a number dominated by JIT tiering, not by the memo
 *      write. It cannot refute a 1.21x cold penalty because it never isolated one.
 *
 * SO THIS MEASURES THE TRUE COLD CASE: warm the JIT on one graph, then build a FRESH graph of the
 * same shape and time ONE query against it. The only cold thing left is the memo.
 *
 *     ARM=warm|cold   N=200000   DEG=1
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const DEG = Number(process.env.DEG ?? 1);
const ARM = process.env.ARM ?? 'cold';
const WARMUP = Number(process.env.WARMUP ?? 12);

const GQL = 'MATCH (a:P)-[:E]->()-[:E]->(c) RETURN count(*) AS c';
const MULT = [7919, 104729, 1299709];

const build = (): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: N }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { age: i % 90 } }),
  );
  let e = 0;

  for (let d = 0; d < DEG; d++) {
    const m = MULT[d % MULT.length];

    for (let i = 0; i < N; i++) {
      g.addEdge({
        id: `e${e++}`,
        from: vs[i],
        to: vs[(i * m + d + 1) % N],
        labels: ['E'],
        properties: {},
      });
    }
  }

  return g;
};

// PHASE 1 — warm the JIT on a THROWAWAY graph. Its vertices' memos are irrelevant: the measured
// query below runs against a different graph whose boxes have never been touched.
const warmGraph = build();
let sink = 0;

for (let r = 0; r < WARMUP; r++) {
  sink += Number(query(warmGraph, GQL, {})[0]?.c);
}

// PHASE 2 — a FRESH graph. Every `adjFrom`/`adjTo` is unpopulated, so the first query pays whatever
// the memo costs on first touch, with the JIT already at steady state.
const target = build();

if (ARM === 'warm') {
  // The control: touch the boxes first, so the measured query is warm. The DIFFERENCE between the
  // two arms is the memo's cold cost and nothing else.
  query(target, GQL, {});
}

const t0 = performance.now();
const answer = Number(query(target, GQL, {})[0]?.c);
const ms = performance.now() - t0;

console.log(
  `ARM=${ARM}\tN=${N}\tDEG=${DEG}\tanswer=${answer}\twarmup=${WARMUP}` +
    `\tsink=${sink > 0 ? 'ok' : 'ZERO'}\tONE-QUERY ${ms.toFixed(4)} ms`,
);
