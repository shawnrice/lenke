/**
 * Do the TS and native engines agree on min/max over a STORED NaN? (item 1161)
 *
 * Native had a wrong answer here: `scan_fold_minmax` folded with a plain `x > mx`, which skips a
 * NaN, so the MULTI-aggregate spelling of `max` answered the largest finite while the SINGLE-
 * aggregate spelling answered NaN. The contract is the total order (`cmp_num_total`: NaN last,
 * all NaNs tie), and `ORDER BY ... DESC` is its reference.
 *
 * The differential fuzzer could not see it — it generated exactly ONE aggregate per query, and
 * the multi-aggregate folds are reachable only with two or more over one column. This probe is
 * the direct check while that gap is being closed, and it asks the question of BOTH engines
 * because byte-identity means the answer has to be one answer.
 *
 * A stored NaN cannot be ingested (NDJSON coerces it), so it arrives by `SET`, the same route
 * the fuzzer's own `nan` property uses.
 *
 *   cd packages/native && bun minmax-nan-cross-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const doc = [
  '{"type":"node","id":"1","labels":["T"],"properties":{"v":1}}',
  '{"type":"node","id":"2","labels":["T"],"properties":{"v":-1}}',
  '{"type":"node","id":"3","labels":["T"],"properties":{"v":5}}',
].join('\n');

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;

const ts = tsDeserialize(doc, 'ndjson', new TsGraph());
const nat = graphFromNdjson(createFfiEngineBackend(LIB), doc);

// The NaN arrives by SET, because ingest coerces a non-finite.
const SEED = 'MATCH (n:T) WHERE n.v = -1 SET n.v = sqrt(n.v)';

tsQuery(ts, SEED);
nat.query(SEED);

const QUERIES = [
  ['ORDER BY DESC  [the contract reference]', 'MATCH (n:T) RETURN n.v AS c ORDER BY n.v DESC'],
  ['single-agg max', 'MATCH (n:T) RETURN max(n.v) AS c'],
  ['single-agg min', 'MATCH (n:T) RETURN min(n.v) AS c'],
  ['multi-agg  min, max', 'MATCH (n:T) RETURN min(n.v) AS a, max(n.v) AS b'],
  ['multi-agg  sum, min, max', 'MATCH (n:T) RETURN sum(n.v) AS a, min(n.v) AS b, max(n.v) AS c'],
] as const;

console.log('\n  query                                      ts                 native');

let diverged = 0;

for (const [label, q] of QUERIES) {
  const a = JSON.stringify(tsQuery(ts, q));
  const b = JSON.stringify(nat.query(q));

  if (a !== b) {
    diverged += 1;
  }

  console.log(`  ${label.padEnd(42)} ${a.padEnd(18)} ${b}${a === b ? '' : '   <- DIVERGE'}`);
}

console.log(`\n  ${diverged} of ${QUERIES.length} diverged`);

if (diverged > 0) {
  process.exit(1);
}
