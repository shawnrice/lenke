import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { deserialize } from '@lenke/serialization';

import { query } from './index.js';

// The ISO `<graph element predicate>` family, and the only tests this package has for it.
//
// WHY IT LOOKED UNTESTED AND WAS NOT ENTIRELY. Item 1787's coverage census read
// `graphPredResult` (executor/core.ts) as a 19-line hole, because that census ran this
// package's suite alone. The shapes ARE exercised — by
// `packages/native/src/gql-conformance.test.ts`, which runs them through `@lenke/gql`'s DIST
// and compares byte-for-byte against the Rust engine. What that test pins is AGREEMENT on one
// query; it does not pin the arms, and a per-package census cannot see it at all. So the hole
// was over-stated and the tests were still worth writing: these pin the ARMS, in the package
// that owns them.
//
// THE FOUR PREDICATES, and what is genuinely decided rather than obvious:
//
//   `IS [NOT] DIRECTED`      — every edge in this engine is directed, so the interesting half
//                              is the OTHER operand: a non-edge is UNKNOWN, not FALSE. That is
//                              a three-valued choice and `NOT` cannot turn it into TRUE.
//   `IS SOURCE|DESTINATION OF` — needs a VERTEX on the left and an EDGE on the right. Either
//                              one wrong is UNKNOWN, again not FALSE.
//   `ALL_DIFFERENT(…)`       — pairwise, over ALL pairs rather than adjacent ones.
//   `SAME(…)`                — every operand against the FIRST.
//
// Identity for both of the last two is `sameElement`, which is three things in a trench coat:
// id equality for two vertices or two edges, FALSE whenever exactly one side is an element (or
// one is a node and the other an edge), and structural equality otherwise. The vertex-id and
// edge-id spaces are SEPARATE here (see the 14th cross-engine divergence), so a vertex and an
// edge that share an id string must still be different — which is what the element-vs-element
// arm is for.
//
// NOTE ON NULLS. `ALL_DIFFERENT`/`SAME` take UNKNOWN from ANY null operand, before any
// comparison runs. `IS DIRECTED` and `IS SOURCE OF` get there by a different route — a null is
// not an edge, so the type test is what returns UNKNOWN. The two routes are indistinguishable
// from the answer, so each has its own case below.

const g = (): Graph => {
  const nd = [
    '{"type":"node","id":"1","labels":["P"],"properties":{"n":1}}',
    '{"type":"node","id":"2","labels":["P"],"properties":{"n":2}}',
    // ⚠️ The ids here must NOT collide with a vertex id. The first draft of this fixture gave
    // this edge the id "1" on purpose — a vertex and an edge sharing an id is the only
    // fixture that can tell an identity which compares ids BEFORE kinds from one that checks
    // kinds first. It cannot be used: `addEdge` with an existing vertex's id replaces that
    // vertex's labels and properties, because `elementProperties` and `elementLabels` are one
    // Map each keyed by bare id across two id spaces (item 1588, TS-only, owner-decided
    // WON'T FIX as out of contract). The graph is already corrupt there, so every row below
    // came back empty. The consequence for the kind check is recorded at its own test.
    '{"type":"edge","id":"e1","labels":["E"],"from":"1","to":"2","properties":{"w":1}}',
    '{"type":"edge","id":"e2","labels":["E"],"from":"1","to":"2","properties":{"w":2}}',
  ].join('\n');

  return deserialize(nd, 'ndjson', new Graph());
};

const rows = (q: string): unknown[] => query(g(), q);

// One row, one column, named `r` throughout — the predicates are scalars and the fixture is
// only ever there to supply an element.
const r = (q: string): unknown => (rows(q)[0] as Record<string, unknown>).r;

describe('IS [NOT] DIRECTED', () => {
  test('an edge is DIRECTED; a non-edge is UNKNOWN, not FALSE', () => {
    expect(r(`MATCH ()-[e:E]->() RETURN e IS DIRECTED AS r LIMIT 1`)).toBe(true);
    // A VERTEX is the near miss: it is an element, it is not an edge, and a check written as
    // `!isEdge(x) ? false : true` would answer FALSE here and pass every edge test above.
    expect(r(`MATCH (v:P) RETURN v IS DIRECTED AS r LIMIT 1`)).toBe(null);
    // A plain value, which is the arm that has no element in it at all.
    expect(r(`RETURN 1 IS DIRECTED AS r`)).toBe(null);
    expect(r(`RETURN 'x' IS DIRECTED AS r`)).toBe(null);
    expect(r(`RETURN null IS DIRECTED AS r`)).toBe(null);
  });

  test('NOT negates the TRUE and leaves the UNKNOWN alone', () => {
    expect(r(`MATCH ()-[e:E]->() RETURN e IS NOT DIRECTED AS r LIMIT 1`)).toBe(false);
    // The point of the pair: `negated` is applied AFTER the three-valued result, and `NOT
    // UNKNOWN` is UNKNOWN. A negation that ran on a coerced boolean would answer TRUE.
    expect(r(`MATCH (v:P) RETURN v IS NOT DIRECTED AS r LIMIT 1`)).toBe(null);
  });
});

describe('IS SOURCE|DESTINATION OF', () => {
  test('a vertex and its edge, both directions, both answers', () => {
    const q = (pred: string): unknown =>
      r(`MATCH (a:P {n: 1})-[e:E]->(b:P {n: 2}) RETURN ${pred} AS r LIMIT 1`);

    expect(q('a IS SOURCE OF e')).toBe(true);
    expect(q('b IS SOURCE OF e')).toBe(false);
    expect(q('b IS DESTINATION OF e')).toBe(true);
    expect(q('a IS DESTINATION OF e')).toBe(false);
    // CONTROL on the two arms being distinct: a predicate that read `edge.from` for both
    // would make every line above agree with SOURCE, and the two FALSE rows would still pass.
    expect(q('a IS SOURCE OF e AND b IS DESTINATION OF e')).toBe(true);
    expect(q('a IS DESTINATION OF e OR b IS SOURCE OF e')).toBe(false);
  });

  test('either operand of the wrong kind is UNKNOWN', () => {
    const q = (pred: string): unknown =>
      r(`MATCH (a:P {n: 1})-[e:E]->(b:P {n: 2}) RETURN ${pred} AS r LIMIT 1`);

    // Edge on the left, where a vertex belongs.
    expect(q('e IS SOURCE OF e')).toBe(null);
    // Vertex on the right, where an edge belongs.
    expect(q('a IS SOURCE OF b')).toBe(null);
    expect(q('a IS DESTINATION OF b')).toBe(null);
    // Neither operand an element at all.
    expect(r(`RETURN 1 IS SOURCE OF 2 AS r`)).toBe(null);
    // A null operand reaches UNKNOWN through the type test rather than a null guard, which is
    // why it is here and not only in the ALL_DIFFERENT section.
    expect(q('a IS SOURCE OF null')).toBe(null);
    expect(q('null IS DESTINATION OF e')).toBe(null);
  });

  test('NOT negates a determinate answer and preserves UNKNOWN', () => {
    const q = (pred: string): unknown =>
      r(`MATCH (a:P {n: 1})-[e:E]->(b:P {n: 2}) RETURN ${pred} AS r LIMIT 1`);

    expect(q('a IS NOT SOURCE OF e')).toBe(false);
    expect(q('b IS NOT SOURCE OF e')).toBe(true);
    expect(q('a IS NOT SOURCE OF b')).toBe(null);
  });
});

describe('ALL_DIFFERENT', () => {
  test('pairwise over ALL pairs, not just adjacent ones', () => {
    // THE SHAPE THAT DECIDES THE LOOP. The duplicate is at positions 0 and 2, so an
    // implementation that only compared neighbours would answer TRUE here and still pass a
    // two-argument test.
    expect(r(`MATCH (a:P {n: 1}), (b:P {n: 2}) RETURN ALL_DIFFERENT(a, b, a) AS r`)).toBe(false);
    expect(r(`MATCH (a:P {n: 1}), (b:P {n: 2}) RETURN ALL_DIFFERENT(a, b) AS r`)).toBe(true);
    // Adjacent duplicate, so that both loop positions are exercised.
    expect(r(`MATCH (a:P {n: 1}), (b:P {n: 2}) RETURN ALL_DIFFERENT(a, a, b) AS r`)).toBe(false);
  });

  test('edges compare by edge id, and two distinct edges on the same pair of vertices differ', () => {
    // The fixture's two edges share `from` and `to` and differ only in id and `w`, so this
    // fails for any identity that keys on the endpoints instead of the edge.
    expect(
      r(`MATCH ()-[x:E]->(), ()-[y:E]->() WHERE x.w = 1 AND y.w = 2
              RETURN ALL_DIFFERENT(x, y) AS r`),
    ).toBe(true);
    expect(
      r(`MATCH ()-[x:E]->(), ()-[y:E]->() WHERE x.w = 1 AND y.w = 1
              RETURN ALL_DIFFERENT(x, y) AS r`),
    ).toBe(false);
  });

  test('ANY null operand is UNKNOWN, whatever the other operands say', () => {
    // Even though `a` and `b` are plainly different, the null settles it to UNKNOWN before
    // any comparison runs — a guard placed after the loop would answer FALSE for the second.
    expect(r(`MATCH (a:P {n: 1}), (b:P {n: 2}) RETURN ALL_DIFFERENT(a, b, null) AS r`)).toBe(null);
    expect(r(`MATCH (a:P {n: 1}) RETURN ALL_DIFFERENT(a, a, null) AS r`)).toBe(null);
  });

  test('non-element operands compare structurally', () => {
    expect(r(`RETURN ALL_DIFFERENT(1, 2, 3) AS r`)).toBe(true);
    expect(r(`RETURN ALL_DIFFERENT(1, 2, 1) AS r`)).toBe(false);
    expect(r(`RETURN ALL_DIFFERENT('a', 'b') AS r`)).toBe(true);
    // Lists are equal by VALUE here, not by reference.
    expect(r(`RETURN ALL_DIFFERENT([1, 2], [1, 2]) AS r`)).toBe(false);
    expect(r(`RETURN ALL_DIFFERENT([1, 2], [2, 1]) AS r`)).toBe(true);
  });
});

describe('SAME', () => {
  test('every operand is compared against the FIRST', () => {
    expect(r(`MATCH (a:P {n: 1}) RETURN SAME(a, a, a) AS r`)).toBe(true);
    expect(r(`MATCH (a:P {n: 1}), (b:P {n: 2}) RETURN SAME(a, b) AS r`)).toBe(false);
    expect(r(`MATCH (a:P {n: 1}), (b:P {n: 2}) RETURN SAME(a, a, b) AS r`)).toBe(false);
    expect(r(`MATCH (a:P {n: 1}), (b:P {n: 2}) RETURN SAME(a, b, b) AS r`)).toBe(false);
    // ⚠️ NO TEST HERE CAN SEPARATE "every operand against the FIRST" FROM "each against its
    // PREDECESSOR", and the draft of this test claimed `a, b, b` did. A mutant folding against
    // the predecessor SURVIVES, and not for want of a case: `sameElement` is an equivalence
    // relation (id equality, or `structuralEq` which bottoms out at `===`), so an
    // adjacent-equal chain is equal throughout and the two formulations agree on every input.
    // The lines above pin the ANSWER, which is what they are for; they are not evidence that
    // the comparison is anchored.
  });

  test('edges by edge id', () => {
    expect(r(`MATCH ()-[x:E]->() WHERE x.w = 1 RETURN SAME(x, x) AS r`)).toBe(true);
    expect(
      r(`MATCH ()-[x:E]->(), ()-[y:E]->() WHERE x.w = 1 AND y.w = 2
              RETURN SAME(x, y) AS r`),
    ).toBe(false);
  });

  test('a vertex is never the same element as an edge', () => {
    // ⚠️ THIS TEST HAS NO TEETH AGAINST ONE SPECIFIC MUTANT, and saying so is the point.
    // `sameElement` checks the KINDS before the ids, so a vertex and an edge are different
    // whatever their ids. The only fixture that could tell that apart from a bare id
    // comparison is one where a vertex and an edge SHARE an id — and that is out of contract
    // and corrupts the graph (item 1588, see the fixture comment). So an identity rewritten
    // to compare ids first would survive this, and the two engines would still agree, because
    // the shape that separates them cannot be built through the public API.
    expect(r(`MATCH (a:P {n: 1}), ()-[x:E]->() WHERE x.w = 1 RETURN SAME(a, x) AS r`)).toBe(false);
    expect(
      r(`MATCH (a:P {n: 1}), ()-[x:E]->() WHERE x.w = 1
              RETURN ALL_DIFFERENT(a, x) AS r`),
    ).toBe(true);
  });

  test('an element against a non-element is FALSE, not UNKNOWN and not an error', () => {
    // This is the arm that separates a TYPE MISMATCH (false: they are determinately not the
    // same thing) from a NULL operand (unknown: there is nothing to compare).
    //
    // ⚠️ The `isElement(a) || isElement(b)` early return in `sameElement` is REDUNDANT, and a
    // mutant deleting it survives everything here. It cannot not survive: with the vertex and
    // edge arms already taken above it, the only operands that reach it are mixed, and
    // `structuralEq` ends at `a === b`, which is false for two different objects whatever
    // their kinds. The line stays as the statement of intent — without it this engine's
    // mixed-kind answer would be an accident of another module's fallback — but it is a
    // readability guard, not a tested one.
    expect(r(`MATCH (a:P {n: 1}) RETURN SAME(a, 1) AS r`)).toBe(false);
    expect(r(`MATCH (a:P {n: 1}) RETURN SAME(1, a) AS r`)).toBe(false);
    expect(r(`MATCH (a:P {n: 1}) RETURN SAME(a, 'x') AS r`)).toBe(false);
  });

  test('ANY null operand is UNKNOWN', () => {
    expect(r(`MATCH (a:P {n: 1}) RETURN SAME(a, null) AS r`)).toBe(null);
    expect(r(`MATCH (a:P {n: 1}) RETURN SAME(null, a) AS r`)).toBe(null);
    expect(r(`RETURN SAME(null, null) AS r`)).toBe(null);
  });

  test('non-elements compare structurally', () => {
    expect(r(`RETURN SAME(1, 1) AS r`)).toBe(true);
    expect(r(`RETURN SAME(1, 2) AS r`)).toBe(false);
    expect(r(`RETURN SAME('a', 'a') AS r`)).toBe(true);
    expect(r(`RETURN SAME([1, 2], [1, 2]) AS r`)).toBe(true);
    expect(r(`RETURN SAME([1, 2], [2, 1]) AS r`)).toBe(false);
  });

  test('fewer than two operands is a syntax error for both', () => {
    expect(() => rows(`RETURN SAME(1) AS r`)).toThrow();
    expect(() => rows(`RETURN ALL_DIFFERENT(1) AS r`)).toThrow();
  });
});
