/**
 * Does the TS engine have the LABEL-ARITY gap items 1157-1158 closed natively? (item 1159)
 *
 * Natively, `typed_hop_count_from_size` answered one type in O(1) and declined SEVERAL (1205x,
 * item 1157), while its untyped arm paid an O(nodes) `live_edge_count` (90x, item 1158). All three
 * arms are now 0.3us. The TS engine is a separate implementation, so the question is real — and
 * item 1156 is the precedent for it being worth four queries to settle either way.
 *
 * Four spellings over a TWO-TYPE graph, which is the fixture the native corpus did not have:
 *
 *   A1  -[:KNOWS]->          one type
 *   A2  -[:FOLLOWS]->        the other
 *   A3  -[:KNOWS|FOLLOWS]->  SEVERAL — the variant that was missing natively
 *   A4  -[]->                untyped — the arm that was O(nodes) natively
 *
 * Every row asserts the TS and NATIVE answers are EQUAL, which is what made item 1156 worth more
 * than its headline: it independently exercised code shipped the tick before. Here it checks items
 * 1157's per-type sum and 1158's maintained-count formula against an engine that derives both by
 * different means.
 *
 *   cd packages/native && bun label-arity-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.ARITY_N ?? 200_000);
const DEG = Number(process.env.ARITY_DEG ?? 4);
const REPS = Number(process.env.ARITY_REPS ?? 9);

const lines = Array.from(
  { length: N },
  (_, i) => `{"type":"node","id":"v${i}","labels":["Person"],"properties":{}}`,
);

let k = 0;

for (let i = 0; i < N; i += 1) {
  for (let d = 0; d < DEG; d += 1) {
    // Alternate the type so both partitions are large, and single-label so a multi-type hop
    // cannot double-count an edge.
    const ty = d % 2 === 0 ? 'KNOWS' : 'FOLLOWS';

    lines.push(
      `{"type":"edge","id":"e${k}","labels":["${ty}"],"from":"v${i}","to":"v${(k * 104_729) % N}","properties":{}}`,
    );
    k += 1;
  }
}

const doc = lines.join('\n');
const g = tsDeserialize(doc, 'ndjson', new TsGraph());

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

console.log(`\n# ${N} nodes / degree ${DEG} over TWO types, median of ${REPS} dropping 3\n`);
console.log('  label arity                          ts_ms     answer (ts === native, asserted)');

for (const [label, q] of [
  ['A1 -[:KNOWS]->          one', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN count(*) AS c'],
  ['A2 -[:FOLLOWS]->        one', 'MATCH (a:Person)-[:FOLLOWS]->(x) RETURN count(*) AS c'],
  ['A3 -[:KNOWS|FOLLOWS]->  MANY', 'MATCH (a:Person)-[:KNOWS|FOLLOWS]->(x) RETURN count(*) AS c'],
  ['A4 -[]->            untyped', 'MATCH (a:Person)-[]->(x) RETURN count(*) AS c'],
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

  console.log(`  ${label.padEnd(34)} ${med(series).toFixed(1).padStart(7)}   ${answer}`);
}
