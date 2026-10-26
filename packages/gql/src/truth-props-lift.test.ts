import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compilePredicate, hasPredicate } from './executor.js';
import { query } from './index.js';

// Item 875: a bare property standing alone as a boolean predicate (`WHERE n.flag`) lifts into
// `truthProps` and is read off the element, where it used to fall to the generic evaluator —
// 7.467 ms against 3.315 at 200,000 vertices, and `WHERE n.flag = true` was already on the fast
// route, so the two spellings of one question were 2.25x apart.
//
// THE WHOLE CORRECTNESS QUESTION IS THE RAISE. A property in boolean context is DYNAMIC under the
// static boolean-context check, so a NON-BOOLEAN value must error rather than silently fail to
// match. That is why these are not lifted as an equality against `true`, and it is what the
// second block pins. Every expectation here was compared against the pre-lift build across the
// same seven shapes before being written down; all seven agreed.

const fixture = (): Graph => {
  const g = new Graph();

  // 3 true, 1 false, 1 absent — deliberately UNEQUAL, because a symmetric fixture cannot see a
  // predicate that keeps the wrong side (item 872 watched that mutant survive).
  g.addVertex({ id: 'a', labels: ['T'], properties: { f: true, n: 1 } });
  g.addVertex({ id: 'b', labels: ['T'], properties: { f: true, n: 2 } });
  g.addVertex({ id: 'c', labels: ['T'], properties: { f: true, n: 3 } });
  g.addVertex({ id: 'd', labels: ['T'], properties: { f: false, n: 4 } });
  g.addVertex({ id: 'e', labels: ['T'], properties: { n: 5 } });

  return g;
};

const cnt = (g: Graph, q: string): unknown =>
  (([...query(g, q)][0] ?? {}) as Record<string, unknown>).c;

describe('bare boolean property lifts into truthProps (item 875)', () => {
  const g = fixture();

  test('keeps only TRUE — not false, and not the absent cell', () => {
    expect(cnt(g, 'MATCH (t:T) WHERE t.f RETURN count(*) AS c')).toBe(3);
    expect(cnt(g, 'MATCH (t:T) WHERE t.f = true RETURN count(*) AS c')).toBe(3);
  });

  test('the spellings agree, which is the point of the item', () => {
    const bare = cnt(g, 'MATCH (t:T) WHERE t.f RETURN count(*) AS c');
    const cmp = cnt(g, 'MATCH (t:T) WHERE t.f = true RETURN count(*) AS c');

    expect(bare).toBe(cmp);
  });

  test('an absent key is UNKNOWN, so it is dropped rather than kept', () => {
    expect(cnt(g, 'MATCH (t:T) WHERE t.missing RETURN count(*) AS c')).toBe(0);
  });

  test('lifted alongside a comparison, in EITHER written order', () => {
    expect(cnt(g, 'MATCH (t:T) WHERE t.f AND t.n > 1 RETURN count(*) AS c')).toBe(2);
    expect(cnt(g, 'MATCH (t:T) WHERE t.n > 1 AND t.f RETURN count(*) AS c')).toBe(2);
  });

  test('two bare properties in one chain', () => {
    const h = new Graph();

    h.addVertex({ id: 'p', labels: ['U'], properties: { x: true, y: true } });
    h.addVertex({ id: 'q', labels: ['U'], properties: { x: true, y: false } });
    h.addVertex({ id: 'r', labels: ['U'], properties: { x: false, y: true } });

    expect(cnt(h, 'MATCH (u:U) WHERE u.x AND u.y RETURN count(*) AS c')).toBe(1);
  });

  test('an INLINE node WHERE lifts the same way', () => {
    expect(cnt(g, 'MATCH (t:T WHERE t.f) RETURN count(*) AS c')).toBe(3);
  });

  // THE RAISE. A lifted equality against `true` would answer 0 here; `asTruth` errors, which is
  // what the generic evaluator did and therefore what this must keep doing.
  test('a NON-BOOLEAN value RAISES rather than failing to match', () => {
    expect(() => [...query(g, 'MATCH (t:T) WHERE t.n RETURN count(*) AS c')]).toThrow(
      /a boolean is required/,
    );

    const s = new Graph();

    s.addVertex({ id: 's', labels: ['S'], properties: { v: 'text' } });
    expect(() => [...query(s, 'MATCH (x:S) WHERE x.v RETURN count(*) AS c')]).toThrow(
      /a boolean is required/,
    );
  });

  test('a row that raises is not hidden by a selective conjunct ahead of it', () => {
    // `t.n > 99` matches nothing, but the bare property still has to be judged per surviving
    // element rather than skipped wholesale — and with nothing surviving there is nothing to
    // raise on, which is the generic path's answer too.
    expect(cnt(g, 'MATCH (t:T) WHERE t.n > 99 AND t.f RETURN count(*) AS c')).toBe(0);
  });

  test('a hop whose FAR node carries the bare property', () => {
    const h = new Graph();

    const x1 = h.addVertex({ id: 'x1', labels: ['A'], properties: {} });
    // `tag` is the same on BOTH, so an inline `{tag: 1}` filters nothing — that is deliberate.
    // With a SELECTIVE inline constraint, dropping the lifted clause predicate still returned the
    // right count and the mutant for it survived: the inline constraint was doing the filtering.
    const y1 = h.addVertex({ id: 'y1', labels: ['B'], properties: { ok: true, tag: 1 } });
    const y2 = h.addVertex({ id: 'y2', labels: ['B'], properties: { ok: false, tag: 1 } });

    h.addEdge({ id: 'e1', labels: ['R'], from: x1, to: y1, properties: {} });
    h.addEdge({ id: 'e2', labels: ['R'], from: x1, to: y2, properties: {} });

    // the clause-WHERE spelling, the inline-WHERE spelling and the far-node merge all have to
    // agree — `mergeFarPreds` has to carry `truthProps` or the predicate is silently DROPPED and
    // the answer is a SUPERSET (2 instead of 1)
    expect(cnt(h, 'MATCH (a:A)-[:R]->(b:B) WHERE b.ok RETURN count(*) AS c')).toBe(1);
    expect(cnt(h, 'MATCH (a:A)-[:R]->(b:B WHERE b.ok) RETURN count(*) AS c')).toBe(1);
    // AN INLINE CONSTRAINT PLUS A LIFTED CLAUSE PREDICATE, which is what `mergeFarPreds` joins.
    // `{tag: 1}` matches both neighbours, so the answer rests ENTIRELY on the clause `WHERE b.ok`
    // surviving the merge. Dropping `truthProps` there answers 2 — a silent SUPERSET, the failure
    // `hasPredicate`'s doc records and the one this assertion exists to catch.
    expect(cnt(h, 'MATCH (a:A)-[:R]->(b:B {tag: 1}) WHERE b.ok RETURN count(*) AS c')).toBe(1);
  });

  // THE ROUTE, asserted directly. The lift is answer-equivalent: with it off the predicate falls
  // to the generic evaluator and every assertion above still passes. So these are the only teeth
  // against the route itself — items 866 and 867 both watched a route mutant survive a whole
  // suite before their predicate was extracted and tested this way.
  test('the lift fires for a bare own-variable property, and only for that', () => {
    const bare = { kind: 'prop', variable: 'n', key: 'f' } as const;
    const lifted = compilePredicate(undefined, bare, 'n');

    expect(lifted.truthProps).toEqual(['f']);
    // and it must not ALSO leave the conjunct behind for the generic evaluator to redo
    expect(lifted.where).toBeUndefined();

    // a property of ANOTHER variable is not element-local and must not lift
    const foreign = compilePredicate(undefined, { kind: 'prop', variable: 'other', key: 'f' }, 'n');

    expect(foreign.truthProps).toBeUndefined();
    expect(foreign.where).toBeDefined();

    // no `ownVar` means no proof the predicate is element-local, so nothing lifts
    const unproven = compilePredicate(undefined, bare, undefined);

    expect(unproven.truthProps).toBeUndefined();

    // mixed with a comparison, BOTH lift and nothing is left behind
    const mixed = compilePredicate(
      undefined,
      {
        kind: 'and',
        items: [
          bare,
          {
            kind: 'compare',
            op: '>',
            left: { kind: 'prop', variable: 'n', key: 'x' },
            right: { kind: 'lit', value: 1 },
          },
        ],
      },
      'n',
    );

    expect(mixed.truthProps).toEqual(['f']);
    expect(mixed.cmpProps?.length).toBe(1);
    expect(mixed.where).toBeUndefined();
  });

  test('hasPredicate counts a truthProps-only predicate as constraining', () => {
    // The failure this guards is specific and documented at `hasPredicate`: a check that misses
    // one of `CPredicate`'s lists reports "no predicate", the filter is skipped, and the answer
    // is a SUPERSET — which no fixture lacking the spelling can catch.
    const lifted = compilePredicate(undefined, { kind: 'prop', variable: 'n', key: 'f' }, 'n');

    expect(lifted.truthProps).toEqual(['f']);
    expect(hasPredicate(lifted)).toBe(true);
  });
});
