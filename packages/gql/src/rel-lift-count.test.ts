import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 1034: `MATCH ()-[e:T]->() WHERE <reads only e> RETURN count(*)` takes a dedicated
// module-scope walk (`relOnlyHopCount`) that applies the predicate to the EDGE directly, the rel
// mirror of the two endpoint lifts items 995/996 built. The route is answer-equivalent, so the
// perf gate cannot be tested by timing in CI — what IS testable is every way the new walk could
// differ from the tally it replaces, and that is what this file pins.
//
// THE SURVIVOR THAT MADE THIS FILE. Three mutants were applied to the new walk: dropping the
// rel's inline gate and dropping the endpoint label gate both failed a test immediately, while
// `needsBind = false` — which stops binding the rel variable for a predicate that does NOT lift
// completely — SURVIVED the whole 2,803-test suite. The suite had no `count(*)` over a rel-only
// clause `WHERE` that leaves a RESIDUAL expression, so the binding write was untested rather than
// dead. `residualBlock` below is that case.

const fixture = (): Graph => {
  const g = new Graph();
  // DELIBERATELY UNEQUAL weights, and one edge with the key ABSENT: a symmetric fixture cannot
  // see a predicate that keeps the wrong side, and an absent cell is the one a lifted property
  // read and a generic evaluation can disagree about.
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { n: 3 } });

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['T'], properties: { w: 1, tag: 'x' } });
  g.addEdge({ id: 'e2', from: a, to: c, labels: ['T'], properties: { w: 1, tag: 'y' } });
  g.addEdge({ id: 'e3', from: b, to: c, labels: ['T'], properties: { w: 2, tag: 'x' } });
  g.addEdge({ id: 'e4', from: b, to: a, labels: ['T'], properties: { tag: 'z' } });
  g.addEdge({ id: 'e5', from: c, to: a, labels: ['U'], properties: { w: 1, tag: 'x' } });

  return g;
};

const g = fixture();
const cnt = (q: string): unknown => (([...query(g, q)][0] ?? {}) as Record<string, unknown>).c;
/** The same question as a PROJECTION, which takes a different route entirely (item 447's walk).
 *  Every count below is checked against it, so a wrong count cannot be confirmed by a wrong
 *  expectation — the two routes would have to be wrong in the same way. */
const projected = (match: string): number => [...query(g, `${match} RETURN e.tag AS t`)].length;

describe('a rel-only clause WHERE on count(*) (item 1034)', () => {
  test('a fully lifting equality keeps exactly the matching edges', () => {
    expect(cnt('MATCH ()-[e:T]->() WHERE e.w = 1 RETURN count(*) AS c')).toBe(2);
    expect(projected('MATCH ()-[e:T]->() WHERE e.w = 1')).toBe(2);
  });

  test('the ANONYMOUS and NAMED spellings of one question agree', () => {
    expect(cnt('MATCH (x)-[e:T]->(y) WHERE e.w = 1 RETURN count(*) AS c')).toBe(2);
  });

  test('and so does the INLINE spelling, which takes the tally instead', () => {
    expect(cnt('MATCH ()-[e:T {w: 1}]->() RETURN count(*) AS c')).toBe(2);
  });

  test('a comparison lifts too, and excludes the ABSENT cell', () => {
    // `e4` carries no `w`, so it must not count — the tally reaches the same verdict through
    // `asTruth` on a null comparison.
    expect(cnt('MATCH ()-[e:T]->() WHERE e.w >= 1 RETURN count(*) AS c')).toBe(3);
    expect(projected('MATCH ()-[e:T]->() WHERE e.w >= 1')).toBe(3);
  });

  test('the edge TYPE still restricts the walk', () => {
    // `e5` is a `U` with `w: 1` and must be invisible to a `T` hop.
    expect(cnt('MATCH ()-[e:U]->() WHERE e.w = 1 RETURN count(*) AS c')).toBe(1);
  });

  test('an ENDPOINT LABEL still restricts it — the gate the walk keeps from the tally', () => {
    expect(cnt('MATCH (x:P)-[e:T]->(y:Q) WHERE e.w = 1 RETURN count(*) AS c')).toBe(1);
    expect(projected('MATCH (x:P)-[e:T]->(y:Q) WHERE e.w = 1')).toBe(1);
  });

  test("the REL's own INLINE constraint is applied as well as the clause one", () => {
    // Both must hold: `tag: 'x'` inline AND `w = 1` in the clause. `e1` alone qualifies.
    expect(cnt("MATCH ()-[e:T {tag: 'x'}]->() WHERE e.w = 1 RETURN count(*) AS c")).toBe(1);
    expect(projected("MATCH ()-[e:T {tag: 'x'}]->() WHERE e.w = 1")).toBe(1);
  });

  test('a REVERSED hop counts the same edges from the other side', () => {
    expect(cnt('MATCH ()<-[e:T]-() WHERE e.w = 1 RETURN count(*) AS c')).toBe(2);
  });

  test('a predicate matching NOTHING returns 0 rather than raising', () => {
    expect(cnt('MATCH ()-[e:T]->() WHERE e.w = 99 RETURN count(*) AS c')).toBe(0);
  });

  describe('residualBlock — a predicate that does NOT lift completely', () => {
    // These leave a RESIDUAL `where` on the compiled predicate, which is evaluated through the
    // BINDING. The walk must therefore still bind the rel variable, and `needsBind = false`
    // survived 2,803 tests because nothing exercised this.
    test('arithmetic on the edge property', () => {
      expect(cnt('MATCH ()-[e:T]->() WHERE e.w + 1 = 2 RETURN count(*) AS c')).toBe(2);
      expect(projected('MATCH ()-[e:T]->() WHERE e.w + 1 = 2')).toBe(2);
    });

    test('a disjunction of two edge properties', () => {
      expect(cnt("MATCH ()-[e:T]->() WHERE e.w = 2 OR e.tag = 'z' RETURN count(*) AS c")).toBe(2);
      expect(projected("MATCH ()-[e:T]->() WHERE e.w = 2 OR e.tag = 'z'")).toBe(2);
    });

    test('a negation, which must keep the absent cell OUT', () => {
      // `NOT (e.w = 1)`: `e3` has `w: 2` and qualifies; `e4` has no `w` at all, so the
      // comparison is null and the negation is null — not true — and it must not count.
      expect(cnt('MATCH ()-[e:T]->() WHERE NOT (e.w = 1) RETURN count(*) AS c')).toBe(1);
      expect(projected('MATCH ()-[e:T]->() WHERE NOT (e.w = 1)')).toBe(1);
    });

    test('a function call over the edge property', () => {
      expect(cnt("MATCH ()-[e:T]->() WHERE upper(e.tag) = 'X' RETURN count(*) AS c")).toBe(2);
      expect(projected("MATCH ()-[e:T]->() WHERE upper(e.tag) = 'X'")).toBe(2);
    });
  });
});
