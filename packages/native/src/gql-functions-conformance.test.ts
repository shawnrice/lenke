// Table-driven GQL scalar/function differential: every query string here is run
// on BOTH the TS engine (@lenke/gql) and the Rust core (over bun:ffi) against
// identical data, and their `JSON.stringify`d results are asserted
// byte-identical. This is the guardrail for cross-engine function parity — a
// divergence in any scalar function, operator, or predicate shows up as a red
// diff. Add a case here whenever you touch a function's semantics.
//
// Run: bun test packages/native/src/gql-functions-conformance.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiBackend } from './backend-ffi.js';
import { graphFromFormat } from './graph.js';

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../../crates/lenke-core/target/release/liblenke_core.${LIB_EXT}`,
  import.meta.url,
).pathname;
const hasLib = existsSync(LIB);

if (!hasLib) {
  console.warn(`[gql-functions] skipping: ${LIB} not found — run \`bun run build:rust\`.`);
}

const suite = hasLib ? describe : describe.skip;

// A single-node graph is enough for scalar-function evaluation: every case
// projects a computed value, not graph structure. `n.s`/`n.num`/`n.xs` give a
// string, a number, and a list to feed the functions.
const NDJSON = [
  '{"type":"node","id":"1","labels":["T"],"properties":{"s":"Hello World","num":-3.7,"xs":[3,1,2]}}',
].join('\n');

suite('GQL function differential (TS vs native)', () => {
  const backend = createFfiBackend(LIB);
  const nativeGraph = graphFromFormat(backend, NDJSON, 'ndjson');
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  // Each case is a RETURN expression; both engines evaluate it over the single
  // node `n`. The test asserts the two serializations are byte-identical.
  const CASES: string[] = [
    // Baseline (pre-existing functions) — proves the harness itself is sound.
    `upper(n.s)`,
    `lower(n.s)`,
    `abs(n.num)`,
    `size(n.xs)`,
    `char_length(n.s)`,
    // Slice 1 — substring is 1-based (SQL / ISO GQL).
    `substring(n.s, 1, 5)`,
    `substring(n.s, 7)`,
    `substring(n.s, 0, 4)`,
    `substring(n.s, 100)`,
    `substring(n.s, -3, 6)`,
    // Slice 2 — split/reverse operate on UTF-16 code units; astral input is
    // lossy (U+FFFD) but byte-identical across engines.
    `split(n.s, '')`,
    `split(n.s, 'o')`,
    `reverse(n.s)`,
    `split('a😀b', '')`,
    `reverse('a😀b')`,
    `reverse('café')`,
    `split('', '')`,
    `reverse(n.xs)`,
    // Slice 3 — round/sign/pi/e.
    `round(n.num)`,
    `round(n.num, 1)`,
    `round(3.14159, 2)`,
    `round(2.5)`,
    `round(-2.5)`,
    `round(2.675, 2)`,
    `round(1234.5678, -2)`,
    `sign(n.num)`,
    `sign(0)`,
    `sign(5)`,
    `sign(-0.0)`,
    `pi()`,
    `e()`,
    `round(pi(), 4)`,
    // Slice 4 — string bool predicates + conversions.
    `contains(n.s, 'World')`,
    `contains(n.s, 'xyz')`,
    `contains(n.s, '')`,
    `starts_with(n.s, 'Hello')`,
    `starts_with(n.s, 'World')`,
    `ends_with(n.s, 'World')`,
    `contains(null, 'a')`,
    `to_boolean('yes')`,
    `to_boolean('FALSE')`,
    `to_boolean('maybe')`,
    `to_boolean(1)`,
    `to_boolean(0)`,
    `to_boolean(n.num)`,
    `to_boolean(null)`,
    `to_list(n.s)`,
    `to_list(42)`,
    `to_list(n.xs)`,
    `to_list('a😀b')`,
    `byte_length(n.s)`,
    `byte_length('café')`,
    `octet_length('😀')`,
    `byte_length(null)`,
    // Slice 5 — tail / append / range.
    `tail(n.xs)`,
    `tail([1])`,
    `tail([])`,
    `append(n.xs, 9)`,
    `append(n.xs, null)`,
    `append([], 'x')`,
    `range(1, 5)`,
    `range(1, 10, 2)`,
    `range(10, 1, -3)`,
    `range(5, 5)`,
    `range(5, 1)`,
    `range(1, 5, 0)`,
    `size(range(0, 100))`,
    // Slice 6 — || concatenation: lists concat, strings unchanged.
    `[1, 2] || [3, 4]`,
    `n.xs || [9, 8]`,
    `[1] || [] || [2]`,
    `'a' || 'b'`,
    `n.s || '!'`,
    `[1, 2] || null`,
    `null || [1]`,
    `range(1, 3) || range(4, 6)`,
    // Slice 7 — CAST(value AS type) → conversion functions.
    `CAST('42' AS INTEGER)`,
    `CAST(3.7 AS INT)`,
    `CAST(n.num AS INTEGER)`,
    `CAST('3.5' AS FLOAT)`,
    `CAST(42 AS STRING)`,
    `CAST(n.num AS STRING)`,
    `CAST('yes' AS BOOL)`,
    `CAST(1 AS BOOLEAN)`,
    `CAST('ab' AS LIST)`,
    `CAST(n.s AS TEXT)`,
    `CAST(CAST('42' AS INT) AS STRING)`,
    `CAST('nope' AS INT)`,
    // Slice 8 — infix CONTAINS / STARTS WITH / ENDS WITH predicates.
    `n.s CONTAINS 'World'`,
    `n.s CONTAINS 'xyz'`,
    `n.s STARTS WITH 'Hello'`,
    `n.s STARTS WITH 'World'`,
    `n.s ENDS WITH 'World'`,
    `n.s ENDS WITH 'Hello'`,
    `NOT (n.s CONTAINS 'z')`,
    `n.s CONTAINS 'o' AND n.s STARTS WITH 'H'`,
    `n.s CONTAINS 'l' OR n.s STARTS WITH 'z'`,
    // Slice 10 — set-style list functions (dedup first-occurrence; sort reuses
    // the ORDER BY total order). list_contains returns numeric 1/0 per ISO.
    `list_union([1, 2, 2, 3], [3, 4, 5])`,
    `intersection([1, 2, 3, 3], [3, 3, 4, 5])`,
    `difference([1, 2, 2, 3], [3, 4, 5])`,
    `list_union(n.xs, [1, 9])`,
    `intersection(n.xs, [2, 9])`,
    `difference(n.xs, [1])`,
    `list_contains([1, 2, 3], 2)`,
    `list_contains([1, 2, 3], 9)`,
    `list_contains(n.xs, 3)`,
    `list_contains(['a', 'b'], 'b')`,
    `list_sort([3, 1, 4, 1, 5])`,
    `list_sort(n.xs)`,
    `list_sort([3, 1, 2], 'desc')`,
    `list_sort(['b', 'a', 'c'])`,
    `list_sort([3, 1, null, 2])`,
    `list_sort([3, 1, null, 2], 'asc', 'first')`,
    `list_sort([3, 1, null, 2], 'desc', 'last')`,
    // Mixed-type sorts: both engines now share a total order across type groups
    // (number < string < boolean < other; nulls last) — see cmp_total / typeRank.
    `list_sort([2, 'a', 1, 'b'])`,
    `list_sort([true, 1, 'x', false])`,
    `list_sort([2, 'a', 1, null])`,
    `list_sort([2, 'a', 1], 'desc')`,
    `list_sort(['banana', 'apple', 'cherry'])`,
    `list_union([1], 2)`,
  ];

  for (const expr of CASES) {
    test(`RETURN ${expr}`, () => {
      const q = `MATCH (n:T) RETURN ${expr} AS v`;
      const ts = JSON.stringify(tsQuery(tsGraph, q));
      const native = JSON.stringify(nativeGraph.query(q));
      expect(ts).toBe(native);
    });
  }
});
