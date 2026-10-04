import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `aliasDefinition` substitutes `ORDER BY <alias>` with the expression the alias names, which
// is what lets `ORDER BY … LIMIT n` keep the top-k over INPUT bindings and project only the
// rows it emits. It used to handle only a direct column, which left the COMPUTED case as a
// cross-engine divergence (audit item 145):
//
//   RETURN n.age + 1 AS a, CAST(n.s AS INTEGER) AS b ORDER BY a LIMIT 2
//     ts      RAISED                  — projected every row, so `b` faulted on a row it
//                                       never emits
//     native  [{a:2,b:1},{a:3,b:2}]   — projected only the emitted rows
//
// `vbad` exists for exactly that: an unparseable `s` on the row that sorts LAST, so a `LIMIT`
// never emits it and only an engine that projects discarded rows can fault.
const build = (): Graph => {
  const g = new Graph();

  for (let i = 1; i <= 5; i++) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { s: String(i), age: i } });
  }

  g.addVertex({ id: 'vbad', labels: ['P'], properties: { s: 'nope', age: 99 } });

  return g;
};

/** The result, or the string `raised` — so the two spellings can be compared either way. */
const outcome = (g: Graph, q: string): string => {
  try {
    return JSON.stringify(query(g, q));
  } catch {
    return 'raised';
  }
};

describe('ORDER BY alias substitution', () => {
  test('a computed alias does not project the rows a LIMIT discards', () => {
    const g = build();
    // The regression that matters: `b` faults only on `vbad`, which sorts last and is never
    // emitted. Projecting it would raise — as this engine did, while native did not.
    const q = 'MATCH (n:P) RETURN n.age + 1 AS a, CAST(n.s AS INTEGER) AS b ORDER BY a LIMIT 2';

    expect(outcome(g, q)).toBe(
      JSON.stringify([
        { a: 2, b: 1 },
        { a: 3, b: 2 },
      ]),
    );
  });

  test('the alias and expression spellings agree, including on raising', () => {
    const g = build();
    const pairs: [string, string][] = [
      [
        'MATCH (n:P) RETURN n.age + 1 AS a, CAST(n.s AS INTEGER) AS b ORDER BY a LIMIT 2',
        'MATCH (n:P) RETURN n.age + 1 AS a, CAST(n.s AS INTEGER) AS b ORDER BY n.age + 1 LIMIT 2',
      ],
      [
        'MATCH (n:P) RETURN upper(n.s) AS a ORDER BY a LIMIT 3',
        'MATCH (n:P) RETURN upper(n.s) AS a ORDER BY upper(n.s) LIMIT 3',
      ],
      [
        'MATCH (n:P) RETURN n.age AS a ORDER BY a DESC LIMIT 2',
        'MATCH (n:P) RETURN n.age AS a ORDER BY n.age DESC LIMIT 2',
      ],
      // No LIMIT: every row is projected either way, so BOTH must raise.
      [
        'MATCH (n:P) RETURN n.age + 1 AS a, CAST(n.s AS INTEGER) AS b ORDER BY a',
        'MATCH (n:P) RETURN n.age + 1 AS a, CAST(n.s AS INTEGER) AS b ORDER BY n.age + 1',
      ],
    ];

    for (const [alias, expr] of pairs) {
      expect(outcome(g, alias)).toBe(outcome(g, expr));
    }
  });

  test('a faulting SORT KEY still raises, with or without a LIMIT', () => {
    const g = build();

    // Here the faulting expression IS the key, so it is evaluated for every row however the
    // projection is scheduled — substitution cannot and must not hide this.
    expect(outcome(g, 'MATCH (n:P) RETURN CAST(n.s AS INTEGER) AS a ORDER BY a LIMIT 2')).toBe(
      'raised',
    );
    expect(
      outcome(
        g,
        'MATCH (n:P) RETURN CAST(n.s AS INTEGER) AS a ORDER BY CAST(n.s AS INTEGER) LIMIT 2',
      ),
    ).toBe('raised');
  });

  test('ordering is unchanged for a computed key', () => {
    const g = build();
    const rows = query(g, 'MATCH (n:P) RETURN n.age * -1 AS a ORDER BY a LIMIT 3');

    // `age * -1` reverses the order: 99 sorts first as -99.
    expect(rows).toEqual([{ a: -99 }, { a: -5 }, { a: -4 }]);
  });

  test('an alias whose expression reads an OUTPUT name is NOT substituted', () => {
    const g = build();
    // `n` is both a bound variable and an output column here, so in the sort scope the name
    // resolves to the OUTPUT column — substituting `n.age + 1` would read something else.
    const q = 'MATCH (n:P) RETURN n.age AS n, n.age + 1 AS a ORDER BY a LIMIT 2';

    // Whatever it answers, it must answer the same as the general spelling of the same sort.
    expect(outcome(g, q)).toBe(
      outcome(g, 'MATCH (n:P) RETURN n.age AS n, n.age + 1 AS a ORDER BY a LIMIT 2'),
    );
    expect(outcome(g, q)).not.toBe('raised');
  });

  test('an aggregate alias is never substituted', () => {
    const g = build();
    // An aggregate is defined over the GROUP, not over any one input row.
    const q = 'MATCH (n:P) RETURN count(*) AS c ORDER BY c LIMIT 1';

    expect(query(g, q)).toEqual([{ c: 6 }]);
  });

  test('a grouped query orders by its aggregate alias correctly', () => {
    const g = build();
    // `GROUP BY` precedes `ORDER BY` in the clause order.
    const q = 'MATCH (n:P) LET k = n.age % 2 RETURN k, count(*) AS c GROUP BY k ORDER BY c DESC';

    // Ages are 1, 2, 3, 4, 5, 99 → odd = 1, 3, 5, 99 (four), even = 2, 4 (two).
    expect(query(g, q)).toEqual([
      { k: 1, c: 4 },
      { k: 0, c: 2 },
    ]);
  });

  test('a constant alias is substitutable and keeps every row', () => {
    const g = build();
    const q = 'MATCH (n:P) RETURN 1 AS a ORDER BY a LIMIT 3';

    expect(query(g, q)).toEqual([{ a: 1 }, { a: 1 }, { a: 1 }]);
  });

  test('SKIP with ORDER BY pages the substituted sort', () => {
    const g = build();
    const q = 'MATCH (n:P) RETURN n.age + 1 AS a ORDER BY a SKIP 2 LIMIT 2';

    expect(query(g, q)).toEqual([{ a: 4 }, { a: 5 }]);
  });

  test('two ORDER BY keys, one aliased and one not', () => {
    const g = build();
    const q = 'MATCH (n:P) RETURN n.age % 2 AS a, n.age AS b ORDER BY a, b DESC LIMIT 3';

    expect(query(g, q)).toEqual([
      { a: 0, b: 4 },
      { a: 0, b: 2 },
      { a: 1, b: 99 },
    ]);
  });
});
