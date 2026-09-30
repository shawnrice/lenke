// The float-to-text TIE between the two engines, pinned.
//
// `CAST(x AS STRING)` routes through `json_fmt::js_number`, which places the decimal point exactly
// per ECMA-262 but takes its DIGITS from Rust's `{:e}`. When an f64's exact value sits exactly
// halfway between two equally SHORT decimals, both round-trip and the runtimes break the tie
// differently: ECMA-262 says "if there are two such possible values of s, choose the one that is
// even", Rust rounds up.
//
// This is a REAL difference in rendered text, not a non-issue, and it is accepted rather than
// fixed because separating a true tie from "very close to the midpoint" needs exact decimal
// arithmetic on the f64's dyadic value — f64 cannot, and the zero-dependency rule rules out a
// crate. Guessing would change output that is currently right.
//
// The differential fuzzer excuses this narrowly (`numericTextTie`), only where both spellings
// parse to the same f64. This file exists so the CASE stays visible: if either engine's formatting
// changes, one of these assertions fails and the deviation is re-examined rather than absorbed.
import { expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const NDJSON = '{"type":"node","id":"1","labels":["N"],"properties":{"n":1}}';
const Q = 'MATCH (n:N) RETURN CAST((9007199254740992 * 0.1) AS STRING) AS v';

test('the known float-to-text tie renders differently but denotes one number', () => {
  expect(nativeReady).toBeTruthy();
  const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());
  const nat = graphFromNdjson(nativeBackend(), NDJSON);
  const tsText = String(tsQuery(ts, Q)[0].v);
  const natText = String(nat.query(Q)[0].v);

  // The exact f64 is 900719925474099.25 — equidistant between two 16-digit decimals.
  expect(tsText).toBe('900719925474099.2'); // ECMA-262: the EVEN last digit
  expect(natText).toBe('900719925474099.3'); // Rust `{:e}`: rounds up
  // They differ as TEXT but denote one number, which is exactly what the fuzzer excuses.
  expect(Number(tsText)).toBe(Number(natText));
  // And the numeric projection does NOT differ: that path renders through the host, so JS
  // formats it on both sides. Only a value that becomes a STRING inside the engine is affected.
  const numQ = 'MATCH (n:N) RETURN (9007199254740992 * 0.1) AS v';

  expect(JSON.stringify(tsQuery(ts, numQ))).toBe(JSON.stringify(nat.query(numQ)));
});
