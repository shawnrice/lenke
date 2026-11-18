/**
 * ⚠️⚠️⚠️ **THE BENCH HAS NO CROSS-ENGINE ANSWER CHECK (item 2236).** Every workload in `bench.ts` is
 * `void e.query(...)` — the result is DISCARDED — so a ratio in that table says nothing about whether the
 * two engines did the same work. A `ts,wasm` run reads
 * `query: OPTIONAL + GROUP BY, far key [2124]` at **ts 103.1 ms vs wasm 3.7 ms (27.88x)**, and before
 * that is treated as an optimization target it has to be ruled out as an engine DECLINING the work or
 * answering differently. OPTIONAL is a known divergence area (the 15th registered divergence is
 * `OPTIONAL MATCH` + a raising inline predicate).
 *
 * 🔑 This loads the SAME ndjson into both engines — exactly as `bench.ts` does, via its own backend
 * modules — runs each query on both, and compares the answer three ways: ROW COUNT, the TOTAL of
 * `count(*)` across groups, and a hash of the sorted `group=count` multiset. ⚠️ Row ORDER is deliberately
 * NOT compared: unordered result order is unspecified and comparing it would be a false alarm.
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createWasmEngineBackend } from './src/backend-wasm-engine.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.N ?? 20000);

const WASM = new URL(
  '../../crates/lenke-engine/target-wasm/wasm32-unknown-unknown/release/lenke_engine.wasm',
  import.meta.url,
).pathname;

/* The bench's own `optionalDoc`: HALF the anchors have no out-edge, three edges each for the rest. */
const optionalDoc = (() => {
  const lines = Array.from(
    { length: N },
    (_, i) =>
      `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"age":${i % 90},"k":${i % 97}}}`,
  );
  let id = 0;

  for (let d = 0; d < 3; d += 1) {
    for (let i = 0; i < N; i += 2) {
      lines.push(
        `{"type":"edge","id":"o${id++}","labels":["KNOWS"],"from":"v${i}","to":"v${(i * 7 + 3 + d * 104_729) % N}","properties":{}}`,
      );
    }
  }

  return lines.join('\n');
})();

const QUERIES: Array<[string, string]> = [
  [
    'far key [2124]      ',
    'MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN b.k AS g, count(*) AS c',
  ],
  [
    'start key [2123]    ',
    'MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a.k AS g, count(*) AS c',
  ],
  [
    'plain count (ctl)   ',
    'MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN count(*) AS c',
  ],
  ['non-OPTIONAL (ctl)  ', 'MATCH (a:Person)-[:KNOWS]->(b) RETURN b.k AS g, count(*) AS c'],
];

/** Row count, total of `count(*)`, and a hash of the sorted `g=c` multiset. ⚠️ Row ORDER is not compared. */
const summarize = (out: unknown): string => {
  const rows = (Array.isArray(out) ? out : ((out as { rows?: unknown[] }).rows ?? [])) as Array<
    Record<string, unknown>
  >;
  let total = 0;
  const groups: string[] = [];

  for (const r of rows) {
    total += Number(r.c ?? 0);
    groups.push(`${JSON.stringify(r.g ?? null)}=${String(r.c)}`);
  }

  groups.sort();
  let h = 0;

  for (const s of groups) {
    for (let i = 0; i < s.length; i += 1) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
  }

  return `rows=${String(rows.length).padStart(6)} total=${String(total).padStart(8)} hash=${String(h).padStart(12)}`;
};

const backend = await createWasmEngineBackend(await Bun.file(WASM).arrayBuffer());
const tsGraph = tsDeserialize(optionalDoc, 'ndjson', new TsGraph());
const wasmGraph = graphFromNdjson(backend, optionalDoc);

console.log(`  N=${N}\n`);

let divergences = 0;

for (const [label, q] of QUERIES) {
  const t0 = performance.now();
  const a = summarize(tsQuery(tsGraph, q));
  const t1 = performance.now();
  const b = summarize(wasmGraph.query(q));
  const t2 = performance.now();
  const same = a === b;

  if (!same) {
    divergences += 1;
  }

  console.log(`  ${label} ${same ? 'AGREE   ' : '*** DIVERGE ***'}`);
  console.log(`      ts   ${a}   ${(t1 - t0).toFixed(1)} ms`);
  console.log(`      wasm ${b}   ${(t2 - t1).toFixed(1)} ms`);
}

wasmGraph.free();
console.log(`\n  divergences: ${divergences}`);
