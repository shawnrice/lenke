/**
 * Item 2409 — THE WEIGHTED FOLD AGAINST THE RUST ENGINE, bit for bit, on the one shape the
 * differential fuzzer generates to expose summation order.
 *
 * `bun run fuzz` passing is NOT evidence on its own. The fuzzer's `n` is a small integer and an
 * integer sum in f64 is EXACT whatever the order or the weights, so almost every aggregate it
 * generates could not separate the two arms. The shapes that CAN are the ones item 1831 added for
 * exactly this reason — `sum(b.n * 0.1)` and `avg(c.n * 0.1)` — and this probe asks about them
 * directly instead of waiting for the generator to draw them.
 *
 * WHAT A DIFFERENCE HERE WOULD AND WOULD NOT MEAN. Item 2401 (owner ruling) made `sum`/`avg`
 * accurate to within `n·ε·Σ|xᵢ|` and explicitly NOT bit-identical across engines, so a last-ulp
 * disagreement is the CONTRACT rather than a defect. What this probe establishes is which it is: a
 * last-ulp difference is fine and worth knowing about; anything larger is a bug.
 *
 *     bun levelsum-native-2409.ts
 */
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const NODES = Number(process.env.NODES ?? 400);
const FANOUT = Number(process.env.FANOUT ?? 3);

/** One NDJSON text, loaded into BOTH engines, so neither can be reading a different graph. */
const lines: string[] = [];

for (let i = 0; i < NODES; i += 1) {
  lines.push(
    JSON.stringify({
      type: 'node',
      id: String(i + 1),
      labels: ['T'],
      // `n` integral (an exact sum in any order) and `f` binary-inexact across three decades, so
      // only `f` and the `n * 0.1` spellings can see a re-association at all.
      properties: { n: i % 8, f: (i % 97) * 0.1 + (i % 3) * 1e3 + (i % 7) * 1e-4 },
    }),
  );
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  lines.push(
    JSON.stringify({
      type: 'edge',
      id: `e${e}`,
      from: String(i + 1),
      // Splits on the REPEAT INDEX — CLAUDE.md's functional-graph fix.
      to: String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1),
      labels: ['E'],
      properties: {},
    }),
  );
}

const ndjson = lines.join('\n');
const backend = nativeBackend();
const nativeGraph = graphFromNdjson(backend, ndjson);
const tsGraph = tsDeserialize(ndjson, 'ndjson', new Graph());

const HOP2 = 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)';
const HOP3 = 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T)';

const CASES: readonly string[] = [
  // THE FUZZER'S OWN TWO, verbatim in shape — the inexact spellings item 1831 added.
  `MATCH (a:T)-[:E]->(b:T) RETURN sum(b.n * 0.1) AS x`,
  `${HOP2} RETURN avg(c.n * 0.1) AS x`,
  // The same question on a stored inexact column rather than a computed one.
  `${HOP2} RETURN sum(c.f) AS x`,
  `${HOP2} RETURN avg(c.f) AS x`,
  `${HOP3} RETURN sum(d.f) AS x`,
  `${HOP3} RETURN avg(d.f) AS x`,
  // CONTROLS: order-insensitive aggregates over the same walk, which must be BIT-IDENTICAL. If one
  // of these moved, the difference is not re-association and the whole reading is void.
  `${HOP2} RETURN min(c.f) AS x`,
  `${HOP2} RETURN max(c.f) AS x`,
  `${HOP2} RETURN count(c.f) AS x`,
];

let identical = 0;
let withinContract = 0;
let bad = 0;

for (const q of CASES) {
  const ts = tsQuery(tsGraph, q, {}).at(0)?.x;
  const nat = nativeGraph.query(q).at(0)?.x;
  const isControl = /min\(|max\(|count\(/.test(q);

  if (Object.is(ts, nat)) {
    identical += 1;
    console.log(`BIT-IDENTICAL  ${String(ts).padEnd(24)} ${q}`);
    continue;
  }

  if (typeof ts !== 'number' || typeof nat !== 'number') {
    bad += 1;
    console.log(`*** TYPE DIFF  ts ${String(ts)} native ${String(nat)}  ${q}`);
    continue;
  }

  const relative = Math.abs(ts - nat) / Math.max(Math.abs(ts), Math.abs(nat), Number.MIN_VALUE);
  /*
   * 1e-9 IS THE REPO'S OWN TOLERANCE and the reason is in CLAUDE.md: it sits ~3 orders above
   * reassociation noise and ~4 below a dropped row, so it still catches a real defect.
   */
  const ok = !isControl && relative < 1e-9;

  if (ok) {
    withinContract += 1;
  } else {
    bad += 1;
  }

  console.log(
    `${ok ? 'CONTRACT      ' : '*** OUT OF BOUND'}  ts ${ts} native ${nat}  ` +
      `rel ${relative.toExponential(3)}${isControl ? '  (A CONTROL — must be bit-identical)' : ''}  ${q}`,
  );
}

console.log(
  `\n${identical} bit-identical, ${withinContract} within item 2401's contract, ${bad} out of bound`,
);

if (bad > 0) {
  process.exitCode = 1;
}
