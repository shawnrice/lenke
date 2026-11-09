// TS ⟷ NATIVE parity for STRING ORDERING over an astral column — the CI gap item 1712 left open.
//
// Item 1712 fixed a confirmed byte-identity break: TS Gremlin ordered strings by UTF-16 code UNIT
// where the Rust engine (and TS GQL) order by code POINT, so `g.V().values('s').order()` disagreed
// with the engine on any column mixing an astral character with a BMP character in U+E000..U+FFFF.
// It is guarded TS-side by `packages/gremlin/src/executor/string-order.test.ts`, whose teeth are
// verified (reverting the one-line fix fails 4 of its 6 tests) — but nothing in CI compared TS
// against NATIVE on such a column, which is precisely the comparison that found the bug.
//
// ⚠️ IT IS ITS OWN SMALL CORPUS, DELIBERATELY. Two vertices carrying this pair were added to
// `gremlin-fuzz`'s SHARED corpus at item 1712 and REVERTED: nine vertices instead of seven put
// `orderLocalWithNull` at 0-3 of 400 against its floor of >5, so the fuzzer went red on a COVERAGE
// COUNTER rather than on a divergence. Adding to a shared differential corpus reweights every random
// draw (and item 1130 records the same hazard for a shared bench fixture), so this gap gets a
// fixture of its own instead.
//
// ⚠️ THE CHARACTERS GO IN THE DATA, NOT IN A QUERY LITERAL. The native Gremlin TEXT parser rejects an
// astral char inside a quoted literal ("lenke: query: unexpected character"), which is why the
// predicate half of item 1712 could not be checked across the bridge at all. The traversals here
// carry no literals — the astral values arrive through NDJSON — so both engines see the same data.
//
// ⚠️ BUILT WITH `String.fromCodePoint`, NEVER PASTED, and the NDJSON uses JSON escapes: a literal
// astral char in a source file is invisible to `grep` and can be mangled by a tool that rewrites the
// file in the wrong encoding. This repo has already been bitten searching for the escape form while
// a file held the literal.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { order, toArray, traversal, V, values } from '@lenke/gremlin';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

/** U+1F600 — a surrogate pair whose FIRST unit, 0xD83D, is numerically BELOW U+E000. */
const ASTRAL = String.fromCodePoint(0x1f600);
/** U+E000 — one UTF-16 unit, code point 57344, numerically ABOVE that high surrogate. */
const BMP_HIGH = String.fromCodePoint(0xe000);

/**
 * The values, in an order that is neither the code-unit nor the code-point answer, so a route that
 * simply preserved arrival order would fail too.
 */
const VALUES = ['m', ASTRAL, 'a', BMP_HIGH, 'z'] as const;

/** Code-point order, derived from `Array.from`'s code-point iteration rather than from either engine. */
const byCodePoint = (a: string, b: string): number => {
  const xs = Array.from(a);
  const ys = Array.from(b);
  const n = Math.min(xs.length, ys.length);

  for (let i = 0; i < n; i += 1) {
    const x = xs[i].codePointAt(0) as number;
    const y = ys[i].codePointAt(0) as number;

    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }

  if (xs.length === ys.length) {
    return 0;
  }

  return xs.length < ys.length ? -1 : 1;
};

const ndjson = VALUES.map(
  (v, i) => `{"type":"node","id":"v${i}","labels":["P"],"properties":{"s":${JSON.stringify(v)}}}`,
).join('\n');

const tsGraph = (): Graph => {
  const g = new Graph();

  VALUES.forEach((v, i) => {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { s: v } });
  });

  return g;
};

const suite = nativeReady ? describe : describe.skip;

suite('gremlin string ordering: TS engine ⟷ Rust engine, astral column', () => {
  const expected = [...VALUES].sort(byCodePoint);

  test('both engines sort an astral column by CODE POINT, and agree', () => {
    const ts = toArray(traversal(V(), values('s'), order()), tsGraph());
    const rust = graphFromNdjson(nativeBackend(), ndjson).gremlin("g.V().values('s').order()");

    // The engines agree with each other...
    expect(ts).toEqual(rust);
    // ...and with an oracle derived independently of both.
    expect(ts).toEqual(expected);
  });

  // The crux stated as its own assertion: U+E000 (57344) sorts BEFORE U+1F600 (128512) by code
  // point, and AFTER it by code unit. A regression to code units flips exactly this pair, and only
  // this pair, which is why a column without it would pass either way.
  test('U+E000 precedes the astral char in both engines', () => {
    const ts = toArray(traversal(V(), values('s'), order()), tsGraph()) as string[];
    const rust = graphFromNdjson(nativeBackend(), ndjson).gremlin(
      "g.V().values('s').order()",
    ) as string[];

    // Asserted per engine rather than in a loop, so a failure names which side regressed.
    expect(ts.indexOf(BMP_HIGH)).toBeLessThan(ts.indexOf(ASTRAL));
    expect(rust.indexOf(BMP_HIGH)).toBeLessThan(rust.indexOf(ASTRAL));
  });

  // The NDJSON round trip is part of the claim: if the decoder mangled a surrogate pair, the two
  // engines could agree on a value neither was given.
  test('the astral value survives the NDJSON round trip intact', () => {
    const rust = graphFromNdjson(nativeBackend(), ndjson).gremlin(
      "g.V().values('s').order()",
    ) as string[];

    expect(rust).toContain(ASTRAL);
    expect(Array.from(rust.find((v) => v === ASTRAL) as string)).toHaveLength(1);
  });
});
