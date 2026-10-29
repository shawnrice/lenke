/**
 * Do the engines agree on a stored `-0.0` through the aggregates? (item 1163)
 *
 * Found while reading TS's `percentileOf` for the item-1162 follow-up: `numArg` collapses `-0`
 * to `+0` ("no negative zero in the numeric model"), so the TS percentile can never RETURN a
 * negative zero. The native engine does not collapse — item 1162's own guard exists precisely
 * because `-0.0` and `0.0` are distinct bit patterns there that `partial_cmp` ties.
 *
 * So the suspicion is a divergence that predates item 1162 entirely: a column holding `-0.0`,
 * asked for its minimum or its 0th percentile, should answer `-0.0` in native and `0.0` in TS.
 *
 * ⚠️ `JSON.stringify` CANNOT SEE THIS — it renders both as `0`. `Object.is` is the only
 * instrument that distinguishes them, which is why this probe walks the values rather than
 * comparing serialized rows, and it is very likely why no fuzzer has caught it: the differential
 * fuzzer compares rendered JSON.
 *
 * WHAT THIS PROBE HAS SETTLED, and what it has NOT (item 1164). Settled: TS keeps the sign bit
 * through a BARE PROJECTION, through `min`, and through `ORDER BY`, and native shows `+0` on all
 * three — five divergent surfaces in total. Also settled: BOTH engines collapse at the
 * numeric-FUNCTION gate (`numArg` / `num_of`), which is why the `atan2` rows agree.
 *
 * NOT settled: WHERE native collapses. The `atan2` rows were added to decide between "native
 * collapses on write" and "native collapses at egress", and they cannot, because `atan2` itself
 * collapses its operand in both engines — so the instrument answers a different question than the
 * one it was built for. An earlier reading of `min` returning `+0` was taken as evidence for the
 * write path; it is not, since an egress collapse looks identical. The two possibilities want the
 * fix in different places, so the next step is to read the native write path directly rather than
 * infer it from the surface.
 *
 *   cd packages/native && bun negzero-cross-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

// Ingest cannot express -0.0 (JSON `-0` parses to -0, but the NDJSON round-trip is not the point
// here), so it arrives by SET, the same route a stored NaN takes.
const doc = [
  '{"type":"node","id":"1","labels":["T"],"properties":{"v":1}}',
  '{"type":"node","id":"2","labels":["T"],"properties":{"v":2}}',
  '{"type":"node","id":"3","labels":["T"],"properties":{"v":3}}',
].join('\n');

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;

const ts = tsDeserialize(doc, 'ndjson', new TsGraph());
const nat = graphFromNdjson(createFfiEngineBackend(LIB), doc);

// `0 - 0` evaluates to +0; a negative zero needs a product or a negation that yields one.
const SEED = 'MATCH (n:T) WHERE n.v = 1 SET n.v = 0 * (0 - 1)';

tsQuery(ts, SEED);
nat.query(SEED);

/** The first row's single column, as a raw value — NOT serialized, so ±0 stays visible. */
const one = (rows: unknown): unknown => {
  const [r] = rows as Record<string, unknown>[];

  if (r === undefined) {
    return undefined;
  }

  const [first] = Object.values(r);

  return first;
};

const show = (v: unknown): string => {
  if (typeof v === 'number' && v === 0) {
    // Object.is is the ONLY instrument that separates these; `===` and JSON cannot.
    return Object.is(v, -0) ? '-0' : '+0';
  }

  return JSON.stringify(v);
};

const QUERIES: [string, string][] = [
  // COMPUTED BUT NEVER STORED, which asks whether the write path is the only site: native's
  // `num_of` collapses on the operand gate, so an expression that produces -0 should come back
  // +0 from a pure projection too.
  ['computed, not stored', 'MATCH (n:T) WHERE n.v = 2 RETURN 0 * (0 - 1) AS c'],
  ['computed via negation', 'MATCH (n:T) WHERE n.v = 2 RETURN -(0) AS c'],
  ['the stored value itself', 'MATCH (n:T) WHERE n.v = 0 RETURN n.v AS c'],
  ['min(n.v)', 'MATCH (n:T) RETURN min(n.v) AS c'],
  ['percentile_disc(n.v, 0)', 'MATCH (n:T) RETURN percentile_disc(n.v, 0) AS c'],
  ['percentile_cont(n.v, 0)', 'MATCH (n:T) RETURN percentile_cont(n.v, 0) AS c'],
  ['ORDER BY n.v  [first row]', 'MATCH (n:T) RETURN n.v AS c ORDER BY n.v'],
  ['sum over the zero alone', 'MATCH (n:T) WHERE n.v = 0 RETURN sum(n.v) AS c'],
  // DECISIVE: does the STORED value carry the sign bit, or does only the egress hide it?
  // `atan2(0, -0)` is pi and `atan2(0, +0)` is 0 — sign-revealing AND finite, so it renders as a
  // real number. (Division was the first instrument tried and is unavailable: `1 / 0` is a data
  // exception in this engine, not an infinity.) Without a row like this, "native collapses on
  // write" and "native collapses at egress" are indistinguishable, and they want the fix in
  // different places.
  ['atan2(0, stored)  [the sign bit]', 'MATCH (n:T) WHERE n.v = 0 RETURN atan2(0, n.v) AS c'],
  ['atan2(0, computed)', 'MATCH (n:T) WHERE n.v = 2 RETURN atan2(0, 0 * (0 - 1)) AS c'],
];

console.log('\n  query                              ts      native   agree?');

let diverged = 0;

for (const [label, q] of QUERIES) {
  const a = one(tsQuery(ts, q));
  const b = one(nat.query(q));
  // Object.is, NOT ===: `-0 === 0` is true and would hide the whole question.
  const same = Object.is(a, b);

  if (!same) {
    diverged += 1;
  }

  console.log(
    `  ${label.padEnd(34)} ${show(a).padStart(6)}  ${show(b).padStart(6)}   ${same ? 'yes' : 'NO  <- DIVERGE'}`,
  );
}

console.log(`\n  ${diverged} of ${QUERIES.length} diverged (by Object.is; JSON renders both as 0)`);
