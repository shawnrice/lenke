import { describe, expect, test } from 'bun:test';

// The pre-filter that lets a scan reject a candidate before `matchNode` allocates a binding
// for it (item 631) is a SECOND COPY of `satisfies`' two element-direct loops, kept separate
// because extracting a shared helper cost the read path measurably. A copy can drift, so what
// matters is pinned here.
//
// It is safe in ONE direction only. The full `satisfies` still runs after it, so a pre-filter
// that is too LENIENT merely forgoes a saving — but one that is too STRICT silently drops rows
// and the query still returns plausible-looking results.
//
// Driven through a WRITE, deliberately. The pre-filter sits in the seed loops of
// `matchSegments`, and a READ of these shapes can claim a fast-path rung and never arrive
// there — the measurement that started item 631 found a read making ZERO `matchNode` calls
// where the write made 20,000. Asserting on which rows a SET actually touched therefore both
// reaches the code and checks the only thing a user can observe.
import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import type { CPredicate } from './executor.js';
import { rejectedByElementDirect } from './executor.js';
import { query } from './index.js';

const fixture = (): Graph => {
  const g = new Graph();

  for (const v of [
    { id: 'a', labels: ['T'], properties: { n: 1, s: 'x', nil: null } },
    { id: 'b', labels: ['T'], properties: { n: 2, s: 'y' } },
    { id: 'c', labels: ['T'], properties: { n: 10, s: 'zz', other: 10 } },
    // No properties at all: every key is absent.
    { id: 'd', labels: ['T'], properties: {} },
  ]) {
    g.addVertex(v);
  }

  return g;
};

// Expected rows are written out BY HAND rather than taken from either implementation: an
// oracle derived from the engine cannot catch the engine agreeing with itself.
const CASES: [string, string, Record<string, unknown>, string[]][] = [
  ['eq hit', 'WHERE u.n = $v', { v: 2 }, ['2']],
  ['eq miss', 'WHERE u.n = $v', { v: 999 }, []],
  ['eq string', 'WHERE u.s = $v', { v: 'x' }, ['1']],
  ['gt', 'WHERE u.n > $v', { v: 1 }, ['10', '2']],
  ['gte', 'WHERE u.n >= $v', { v: 2 }, ['10', '2']],
  ['lt', 'WHERE u.n < $v', { v: 10 }, ['1', '2']],
  ['ne', 'WHERE u.n <> $v', { v: 2 }, ['1', '10']],
  ['eq AND eq', 'WHERE u.n = $v AND u.s = $w', { v: 1, w: 'x' }, ['1']],
  ['range AND range', 'WHERE u.n > $v AND u.n < $w', { v: 0, w: 100 }, ['1', '10', '2']],
  // `= null` is UNKNOWN, and a filter keeps only TRUE — so NO row, including the one whose
  // property is a stored null. This is the guard `eqProps` has its null check for.
  ['eq null', 'WHERE u.n = $v', { v: null }, []],
  ['eq against a stored null', 'WHERE u.nil = $v', { v: 1 }, []],
  ['eq against an absent key', 'WHERE u.missing = $v', { v: 1 }, []],
  // Shapes that cannot lift to the element-direct lists: the pre-filter must DECLINE, so the
  // rows must be exactly what the general predicate selects.
  ['prop = prop', 'WHERE u.n = u.other', {}, ['10']],
  ['OR', 'WHERE u.n > $v OR u.n < $w', { v: 9, w: 2 }, ['1', '10']],
  ['function over a property', 'WHERE upper(u.s) = $v', { v: 'X' }, ['1']],
  // An inline constraint rather than a clause WHERE.
  ['inline constraint', '', { v: 2 }, ['2']],
];

describe('the element-direct pre-filter', () => {
  for (const [name, where, params, want] of CASES) {
    test(`keeps exactly the right rows: ${name}`, () => {
      const w = name === 'inline constraint' ? '' : where;
      const g = fixture();
      const text =
        name === 'inline constraint'
          ? 'MATCH (u:T {n: $v}) SET u.hit = 1'
          : `MATCH (u:T) ${w} SET u.hit = 1`;

      void [...query(g, text, params)];

      const got = [
        ...(query(g, 'MATCH (u:T) WHERE u.hit = 1 RETURN u.n AS n') as Iterable<{ n: unknown }>),
      ]
        .map((r) => String(r.n))
        .sort();

      expect(got).toEqual(want);
    });
  }

  // 🛑 THE SUITE ABOVE PASSES WITH THE PRE-FILTER STUBBED TO "NEVER REJECT" — it would simply
  // be slower, and every row would still be right. Mutation proved exactly that: the stub
  // SURVIVED a first version of this test, which compared the time of a liftable predicate
  // against a non-liftable one. Those two differ in cost for reasons that have nothing to do
  // with the pre-filter (`upper()` is dearer per candidate than `=` whatever the filter does),
  // so the assertion held with the filter switched off. A timing comparison between two
  // DIFFERENT predicates cannot be evidence about a filter that only one of them uses.
  //
  // So the function is tested DIRECTLY instead, on hand-built predicates. `CPredicate`'s
  // value side is a thunk over the eval env, which makes one cheap to write by hand, and a
  // unit test of the gate is immune to whatever the surrounding engine happens to cost.
  describe('rejects and declines as its contract says', () => {
    const g = fixture();
    const [v1] = [
      ...(query(g, 'MATCH (u:T) WHERE u.n = $v RETURN u.n AS n', { v: 1 }) as Iterable<unknown>),
    ];

    // `v1` only proves the fixture is the one we think it is; the element under test is the
    // vertex itself, fetched through the graph's own accessor.
    expect(v1).toBeDefined();

    const vertexWith = (n: unknown): Vertex => {
      const found = [...g.vertices].find((v) => v.properties.n === n);

      if (found === undefined) {
        throw new Error(`no vertex with n=${String(n)}`);
      }

      return found;
    };
    const eq = (key: string, value: unknown): CPredicate => ({
      props: [],
      eqProps: [{ key, value: () => value }],
    });
    const cmp = (
      key: string,
      op: '=' | '<>' | '<' | '>' | '<=' | '>=',
      value: unknown,
    ): CPredicate => ({ props: [], cmpProps: [{ key, op, value: () => value }] });
    const judge = (element: Vertex, pred: CPredicate): boolean =>
      rejectedByElementDirect(element, pred, new Map() as never, {}, g);

    test('rejects a candidate whose property does not match', () => {
      expect(judge(vertexWith(1), eq('n', 2))).toBe(true);
    });

    test('does NOT reject the candidate that matches', () => {
      expect(judge(vertexWith(2), eq('n', 2))).toBe(false);
    });

    test('rejects a NULL right-hand side outright, for every candidate', () => {
      // `= null` is UNKNOWN and a filter keeps only TRUE, so no row can satisfy it. Accepting
      // the null here instead would hand `structuralEq` an inline-constraint reading, under
      // which a stored null MATCHES — item 210's "route two" in reverse.
      for (const n of [1, 2, 10]) {
        expect(judge(vertexWith(n), eq('n', null))).toBe(true);
      }
    });

    test('rejects on an ordering comparison, and spares the one that passes', () => {
      expect(judge(vertexWith(1), cmp('n', '>', 5))).toBe(true);
      expect(judge(vertexWith(10), cmp('n', '>', 5))).toBe(false);
    });

    test('declines when neither list is present', () => {
      expect(judge(vertexWith(1), { props: [] })).toBe(false);
    });
  });
});
