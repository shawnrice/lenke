/**
 * THE 15th CROSS-ENGINE DIVERGENCE: does TS Gremlin order STRINGS differently from the engine?
 *
 * GQL resolves this explicitly. `compareCodePoints` exists because JS `<` orders by UTF-16 code
 * UNIT and Rust `str::cmp` by code POINT, and the two DISAGREE whenever an astral character meets a
 * BMP character in U+E000..U+FFFF: `''` is code point 57344 in a single unit, while an astral
 * char's FIRST unit is a high surrogate in 0xD800..0xDBFF — numerically LOWER. So a plain `<` ranks
 * the astral char first and the engine ranks `` first.
 *
 * Gremlin's `cmpSameType` sends a string pair to `cmpOrd`, which is a plain
 * `x < y ? -1 : x > y ? 1 : 0` — NO code-point comparison and NO surrogate guard. The Rust side
 * cannot differ by language: `exec/order.rs` compares a `Col::Str` with `v[a].cmp(&v[b])`, and
 * `ir.rs`'s `SortKey` doc says both languages order non-nulls by `cmp_total` with only null
 * PLACEMENT differing (GQL last, Gremlin first).
 *
 * ⚠️ THE TWO TS ENGINES ALREADY DISAGREE WITH EACH OTHER, which is the cheap half of the evidence
 * and needs no native build. This probe adds the half that decides WHICH is wrong: the engine's own
 * answer, through the FFI backend.
 *
 * ⚠️ WHY NO FUZZER FOUND IT: `gremlin-fuzz.test.ts` calls `order(` 59 times and generates ZERO
 * astral and ZERO U+E000..U+FFFF characters, so the dangerous case is never CONSTRUCTED. That is
 * item 921's rule ("a corpus that does not construct the dangerous case will agree with anything")
 * firing in the other engine; the GQL differential fuzzer does build it, which is why GQL is right.
 *
 * ⚠️ THE CHARACTERS ARE BUILT FROM CODE POINTS AND WRITTEN AS JSON ESCAPES, never pasted. A literal
 * astral char in a source file is invisible to `grep` and can be mangled by any tool that rewrites
 * the file; and the NDJSON has to survive a round trip through the engine's own decoder.
 *
 *     bun gremlin-order-codepoint-probe.mjs
 */
// ⚠️ RUN WITH BUN, NOT NODE: the harness is TypeScript and the `.ts` specifier below does not
// resolve under node. That is also why this reaches the backend through `conformance-harness`
// rather than `createFfiEngineBackend` directly -- the harness already knows where the `.so` is and
// whether it exists.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { order, toArray, traversal, V, values } from '@lenke/gremlin';

import { nativeBackend, nativeReady } from './src/conformance-harness.ts';
import { graphFromNdjson } from './src/graph.ts';

const ASTRAL = String.fromCodePoint(0x1f600); // D83D DE00
const BMP_HIGH = String.fromCodePoint(0xe000); // one unit, numerically ABOVE D83D
const VALUES = ['a', ASTRAL, BMP_HIGH, 'z'];

/** Render as code points so the output is unambiguous in a terminal with no emoji font. */
const show = (xs) =>
  xs
    .map((s) =>
      Array.from(String(s))
        .map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`)
        .join(''),
    )
    .join('  ');

const ndjson = VALUES.map(
  (v, i) => `{"type":"node","id":"v${i}","labels":["P"],"properties":{"s":${JSON.stringify(v)}}}`,
).join('\n');

const tsGraph = () => {
  const g = new Graph();

  VALUES.forEach((v, i) => {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { s: v } });
  });

  return g;
};

const g = tsGraph();
const tsGremlin = toArray(traversal(V(), values('s'), order()), g);
const tsGql = query(g, 'MATCH (n:P) RETURN n.s AS k ORDER BY k').map((r) => r.k);

console.log(`values       ${show(VALUES)}`);
console.log(`gremlin TS   ${show(tsGremlin)}`);
console.log(`gql     TS   ${show(tsGql)}`);

if (!nativeReady) {
  console.log('\nSKIPPED the native leg: the engine .so was not found.');
  console.log(
    'Build it with: cargo build --release --features capi  (the capi feature is REQUIRED',
  );
  console.log(
    '-- a bare `cargo build --release` overwrites the .so with one that has no lnk_* symbols.)',
  );
  process.exit(0);
}

const backend = nativeBackend();
const rust = graphFromNdjson(backend, ndjson);
const natGremlin = rust.gremlin("g.V().values('s').order()");

console.log(`gremlin NAT  ${show(natGremlin)}`);
console.log('');
console.log(
  `ts gremlin == native gremlin : ${JSON.stringify(tsGremlin) === JSON.stringify(natGremlin)}`,
);
console.log(
  `ts gql     == native gremlin : ${JSON.stringify(tsGql) === JSON.stringify(natGremlin)}`,
);
console.log('');
// FIXED AT ITEM 1712, so this is now a REGRESSION CHECK: both lines must read true. Before the fix
// the first read false -- TS Gremlin put the astral char before U+E000 where the engine and GQL
// both put it after. The guard that CI actually runs is
// `packages/gremlin/src/string-order.test.ts`; this probe is the three-way view including native,
// which a unit test cannot reach.
console.log('EXPECTED (fixed at item 1712): BOTH lines true. A false on the first is the');
console.log('code-unit/code-point divergence returning.');
