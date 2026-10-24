import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index';

/**
 * `dropVacuousQuantifier` (item 684): a `{1,1}` quantifier asks what a plain hop asks, so it is
 * dropped — which puts the query back on the fast paths that bail on
 * `segments.some((s) => s.rel.quantifier)`. The gap it closes was 2238x (item 683).
 *
 * Every gate is a shape where the two spellings genuinely DIFFER, so these tests are two claims:
 * where the rewrite fires it must change nothing, and where a gate holds the spellings must stay
 * apart. The second half is the one a rewrite gets wrong.
 */
const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { n: 3 } });

  g.addEdge({ from: a, to: b, labels: ['T'], properties: { w: 1 } });
  g.addEdge({ from: a, to: b, labels: ['T'], properties: { w: 2 } }); // PARALLEL
  g.addEdge({ from: a, to: a, labels: ['T'], properties: { w: 3 } }); // SELF-LOOP
  g.addEdge({ from: b, to: c, labels: ['T'], properties: { w: 4 } });
  g.addEdge({ from: a, to: c, labels: ['U'], properties: { w: 5 } });

  return g;
};

const ms = (rows: readonly unknown[]): string =>
  JSON.stringify(rows.map((r) => JSON.stringify(r)).sort());

describe('a vacuous {1,1} quantifier', () => {
  test('agrees with the plain hop wherever the rewrite fires', () => {
    const g = build();

    // Each pair is the SAME question in two spellings. The rewrite makes the second take the
    // first's path, so a disagreement here is the rewrite changing an answer.
    const pairs: [string, string][] = [
      ['MATCH (x)-[:T]->(y) RETURN count(*) AS c', 'MATCH (x)-[:T]->{1,1}(y) RETURN count(*) AS c'],
      [
        'MATCH (x:P)-[:T]->(y) RETURN count(*) AS c',
        'MATCH (x:P)-[:T]->{1,1}(y) RETURN count(*) AS c',
      ],
      [
        'MATCH (x)-[:T]->(y:Q) RETURN count(*) AS c',
        'MATCH (x)-[:T]->{1,1}(y:Q) RETURN count(*) AS c',
      ],
      ['MATCH (x)<-[:T]-(y) RETURN count(*) AS c', 'MATCH (x)<-[:T]-{1,1}(y) RETURN count(*) AS c'],
      ['MATCH (x)-[:T]-(y) RETURN count(*) AS c', 'MATCH (x)-[:T]-{1,1}(y) RETURN count(*) AS c'],
      [
        'MATCH (x)-[:T]->(y) RETURN y.n AS n ORDER BY n',
        'MATCH (x)-[:T]->{1,1}(y) RETURN y.n AS n ORDER BY n',
      ],
      [
        'MATCH (x)-[:T]->(y) WHERE y.n > 1 RETURN count(*) AS c',
        'MATCH (x)-[:T]->{1,1}(y) WHERE y.n > 1 RETURN count(*) AS c',
      ],
      // The modes at which one hop restricts nothing.
      ...(['WALK', 'TRAIL', 'SIMPLE'] as const).map((m): [string, string] => [
        `MATCH ${m} (x)-[:T]->(y) RETURN count(*) AS c`,
        `MATCH ${m} (x)-[:T]->{1,1}(y) RETURN count(*) AS c`,
      ]),
    ];

    for (const [plain, quantified] of pairs) {
      expect(ms(query(g, quantified))).toEqual(ms(query(g, plain)));
    }
  });

  test('the self-loop and the parallel edges are all counted, in both spellings', () => {
    const g = build();

    // 4 T edges out of `a`/`b`: a->b twice, a->a, b->c. A rewrite that lost the self-loop or
    // collapsed the parallel pair would still "agree" with a plain hop that lost them too, so
    // this pins the NUMBER rather than only the agreement.
    expect(query(g, 'MATCH (x)-[:T]->(y) RETURN count(*) AS c')).toEqual([{ c: 4 }]);
    expect(query(g, 'MATCH (x)-[:T]->{1,1}(y) RETURN count(*) AS c')).toEqual([{ c: 4 }]);
  });

  test('ACYCLIC is NOT rewritten — it drops the self-loop the plain hop keeps', () => {
    const g = build();

    // Measured, and the reason the mode gate exists: `acyclic` forbids any repeated NODE, and
    // one repetition of a self-loop repeats one. Dropping the quantifier here would turn 3
    // into 4.
    expect(query(g, 'MATCH ACYCLIC (x)-[:T]->(y) RETURN count(*) AS c')).toEqual([{ c: 4 }]);
    expect(query(g, 'MATCH ACYCLIC (x)-[:T]->{1,1}(y) RETURN count(*) AS c')).toEqual([{ c: 3 }]);
  });

  test('an edge VARIABLE is NOT rewritten — it binds a list, not a scalar', () => {
    const g = build();

    // The other measured gate. Under a quantifier the edge variable is a group var exposed as a
    // LIST; without one it is a single edge. A rewrite would change the result's TYPE.
    const plain = query(g, 'MATCH (x)-[e:T]->(y) RETURN e AS e') as { e: unknown }[];
    const quant = query(g, 'MATCH (x)-[e:T]->{1,1}(y) RETURN e AS e') as { e: unknown }[];

    expect(plain.length).toBe(4);
    expect(quant.length).toBe(4);
    expect(Array.isArray(plain[0]?.e)).toBe(false);
    expect(Array.isArray(quant[0]?.e)).toBe(true);
  });

  test('a real quantifier is untouched', () => {
    const g = build();

    // {1,2} and {2,2} must keep enumerating; only an exactly-one-repetition bound is vacuous.
    // a->a->a, a->a->b (x2), a->b->c, b->c... — the point is simply that it differs from one hop.
    const one = query(g, 'MATCH (x)-[:T]->{1,1}(y) RETURN count(*) AS c');
    const upToTwo = query(g, 'MATCH (x)-[:T]->{1,2}(y) RETURN count(*) AS c');

    expect(one).toEqual([{ c: 4 }]);
    expect(ms(upToTwo)).not.toEqual(ms(one));
  });

  test('a quantified GROUP is NOT rewritten — its inner vars stay lists', () => {
    const g = build();

    // `((x)-[e]->(y)){1,1}` is a different shape from a hop: the inner variables are GROUP
    // vars, exposed to the outer query as LISTS. Dropping the quantifier would make `e` a
    // scalar. The first mutation run showed neither this test NOR the whole gql suite covered
    // the `{1,1}` group spelling, so the gate was unguarded.
    const rows = query(g, 'MATCH ((x)-[e:T]->(y)){1,1} RETURN e AS e') as { e: unknown }[];

    expect(rows.length).toBe(4);
    expect(Array.isArray(rows[0]?.e)).toBe(true);
    expect(query(g, 'MATCH ((x)-[e:T]->(y)){1,1} RETURN count(*) AS c')).toEqual([{ c: 4 }]);

    // NO EDGE VARIABLE, which is what actually tests THIS gate. With `[e:T]` above, the
    // edge-variable gate blocks the rewrite too, so dropping the group gate changed nothing and
    // the mutant survived — two gates covering one shape, so neither is testable through it.
    // Here only the group gate can block, and the inner NODE vars are still group vars: `y` is a
    // LIST, and `x.n` is therefore null where a plain hop would give 1 or 2.
    const noVar = query(g, 'MATCH ((x)-[:T]->(y)){1,1} RETURN y AS y') as { y: unknown }[];

    expect(noVar.length).toBe(4);
    expect(Array.isArray(noVar[0]?.y)).toBe(true);
    expect(query(g, 'MATCH ((x)-[:T]->(y)){1,1} RETURN x.n AS xn')).toEqual([
      { xn: null },
      { xn: null },
      { xn: null },
      { xn: null },
    ]);
  });

  test('a subpath WHERE keeps its predicate (the gate for it is REDUNDANT)', () => {
    const g = build();

    // `( … WHERE cond ){1,1}` carries a PER-REPETITION predicate, and a plain hop has no
    // `subpathWhere` at all — so losing it would turn 3 into 4.
    //
    // But the `subpathWhere` gate in `vacuousQuantifier` cannot ever decide that, and mutation
    // says so: removing it changes no answer, under this test or the whole gql suite. The
    // reason is structural — `subpathWhere` exists only on a PARENTHESIZED subpath, which is a
    // group, so the `hopFrom`/`hopTo` gate has already declined. It is kept as defence in depth
    // against a future shape that carries one without being a group, not because it is
    // load-bearing today. This test pins the BEHAVIOUR, which is what matters.
    expect(query(g, 'MATCH ((x)-[e:T]->(y) WHERE y.n > 1){1,1} RETURN count(*) AS c')).toEqual([
      { c: 3 },
    ]);
    expect(query(g, 'MATCH ((x)-[e:T]->(y)){1,1} RETURN count(*) AS c')).toEqual([{ c: 4 }]);
  });

  test('a non-walk SELECTOR is NOT rewritten — and a plain hop cannot even carry one', () => {
    const g = build();

    // `ANY` keeps one path per endpoint pair, so it dedupes the PARALLEL a->b edges: 3, not 4.
    // And `ANY` on a plain hop is rejected outright ("support a single variable-length ..."),
    // so dropping the quantifier would turn a valid query into an ERROR rather than a wrong
    // number. The whole gql suite caught this gate; this test did not, until now.
    expect(query(g, 'MATCH ANY (x)-[:T]->{1,1}(y) RETURN count(*) AS c')).toEqual([{ c: 3 }]);
    expect(query(g, 'MATCH ANY SHORTEST (x)-[:T]->{1,1}(y) RETURN count(*) AS c')).toEqual([
      { c: 3 },
    ]);
    expect(() => query(g, 'MATCH ANY (x)-[:T]->(y) RETURN count(*) AS c')).toThrow();
  });

  test('a path variable sees the same edges under both spellings', () => {
    const g = build();

    expect(ms(query(g, 'MATCH p = (x)-[:T]->{1,1}(y) RETURN edges(p) AS p'))).toEqual(
      ms(query(g, 'MATCH p = (x)-[:T]->(y) RETURN edges(p) AS p')),
    );
  });
});
