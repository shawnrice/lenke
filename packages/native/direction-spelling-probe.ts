/**
 * Does the TS engine have the same DIRECTION gap items 1153-1155 closed natively? (item 1156)
 *
 * The native typed-hop count gated on `Dir::Out`, so the MIRROR spelling `<-[:T]-` took no
 * shortcut (1510x, item 1153) and neither undirected spelling did (items 1154/1155). All four are
 * now O(1) there. The TS engine is a SEPARATE implementation: its `undirectedHopCount` already
 * existed (the `count 1-hop UNDIRECTED` bench row reads 0.0 for ts), and item 744 fixed its
 * QUANTIFIED mirror — but nothing has priced its plain 1-hop MIRROR, which is exactly the shape
 * that was missing natively.
 *
 * Four spellings, one question each, all answered by the same graph:
 *
 *   T1  -[:KNOWS]->   the directed count, which has a shortcut
 *   T2  <-[:KNOWS]-   the MIRROR — the shape item 1153 found missing natively
 *   T3  -[:KNOWS]-    undirected, which TS is documented to shortcut
 *   C   a label scan, which no direction change can reach
 *
 *   cd packages/native && bun direction-spelling-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.DIR_N ?? 200_000);
const REPS = Number(process.env.DIR_REPS ?? 9);

const lines = Array.from(
  { length: N },
  (_, i) => `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"age":${i % 90}}}`,
);

for (let k = 0; k < N; k += 1) {
  lines.push(
    `{"type":"edge","id":"e${k}","labels":["KNOWS"],"from":"v${(k * 7919) % N}","to":"v${(k * 104_729) % N}","properties":{}}`,
  );
}

const doc = lines.join('\n');
const g = tsDeserialize(doc, 'ndjson', new TsGraph());

// AND THE NATIVE ENGINE ON THE SAME DOCUMENT. Item 1155 added `live_etype_loops`, which the
// undirected count subtracts — so the two implementations must agree on this fixture's self-loop
// count, and TS is the independent oracle for it. The byte-identity fuzzers do not cover this
// shape, so the agreement is asserted here rather than assumed.
const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;
const backend = createFfiEngineBackend(LIB);
const nat = graphFromNdjson(backend, doc);

/** Median of the reps after dropping three as warm-up — item 579's instrument. */
const med = (xs: number[]): number => {
  const warm = xs.slice(3).toSorted((a, b) => a - b);

  return warm[Math.floor(warm.length / 2)];
};

console.log(`\n# ts engine, ${N} nodes / ${N} KNOWS edges, median of ${REPS} dropping 3\n`);
console.log('  spelling                               ms      answer (ts === native, asserted)');

for (const [label, q] of [
  ['T1 -[:KNOWS]->  (directed)', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN count(*) AS c'],
  ['T2 <-[:KNOWS]-  (MIRROR)', 'MATCH (a:Person)<-[:KNOWS]-(x) RETURN count(*) AS c'],
  ['T3 -[:KNOWS]-   (undirected)', 'MATCH (a:Person)-[:KNOWS]-(x) RETURN count(*) AS c'],
  ['C  label scan        [ctl]', 'MATCH (a:Person) RETURN count(*) AS c'],
] as const) {
  const answer = JSON.stringify(tsQuery(g, q));
  const natAnswer = JSON.stringify(nat.query(q));

  if (answer !== natAnswer) {
    throw new Error(`${label}: ts and native DISAGREE — ts ${answer} vs native ${natAnswer}`);
  }

  const series: number[] = [];

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();

    tsQuery(g, q);
    series.push(performance.now() - t);
  }

  console.log(`  ${label.padEnd(34)} ${med(series).toFixed(1).padStart(8)}   ${answer}`);
}
