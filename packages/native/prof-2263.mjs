/**
 * ⚠️⚠️ **WHAT IS THE SORT PATH'S ~160-190 ns/ROW OF ROW-PIPELINE OVERHEAD? (item 2263)**
 *
 * Item 2262 floored the GQL `ORDER BY` honestly — the engine's own `compareValues` over row objects — and
 * left the engine **2.0-2.5x (string) / 3.8-4.0x (number)** above it, which in absolute terms is
 * **~160-190 ns/row either way**. 🔑 Item 2260 established both arms reach the SAME `hopProjection` rung,
 * so this is work inside one route, and item 1966 located it by ablation as *"the deferred arm's KEY
 * EVALUATION — 67%"*. This profiles it directly.
 *
 * **TWO ARMS, ONE PER PROCESS**, differing only in `ORDER BY`:
 *
 *     PROF_ARM=plain    RETURN x.name AS n               23 ns/row
 *     PROF_ARM=sorted   RETURN x.name AS n ORDER BY n   ~380 ns/row
 *
 * ⚠️ Reads are idempotent, so one graph serves every round and the fixture build stays out of the profile —
 * the exclusion a write arm cannot have (item 1933's note).
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 50000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const ROUNDS = Number(process.env.ROUNDS ?? 20);
const ARM = process.env.PROF_ARM ?? 'sorted';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { name: `n${i % 9973}` } });
}

let e = 0;

for (let d = 0; d < FANOUT; d += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${e++}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3 + d * 104_729) % N}`),
      labels: ['KNOWS'],
      properties: {},
    });
  }
}

const TEXT =
  ARM === 'plain'
    ? 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.name AS n'
    : 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.name AS n ORDER BY n';

let rows = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  rows = query(g, TEXT, {}).length;
}

console.log(`  arm=${ARM} rounds=${ROUNDS} rows=${rows}`);
