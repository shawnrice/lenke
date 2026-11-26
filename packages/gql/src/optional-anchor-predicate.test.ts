import { describe, expect, test } from 'bun:test';

/**
 * An ANCHOR predicate on an OPTIONAL hop — item 1851.
 *
 * `MATCH (a:T) WHERE <pred> OPTIONAL MATCH (a)-[:E]->(b:T) RETURN …` declined the rung outright,
 * costing **8.3x for IDENTICAL rows** (47.4 ms against 5.7, measured with `WHERE true` so both
 * spellings ask the same question). The walk now tests each anchor against the compiled node.
 *
 * THE SEMANTIC THAT MATTERS IS WHAT A REJECTED ANCHOR PRODUCES: nothing at all, not a
 * NULL-filled row. The `OPTIONAL` applies to the HOP — a start the predicate rejects was never a
 * match — and a walk that emitted a null row for it would return MORE rows than the general path.
 * That is the first test below, stated as a count rather than only as an agreement, because two
 * routes that made the same mistake would agree with each other.
 *
 * THE ORACLE IS A `WHERE true` ON THE *OPTIONAL* CLAUSE, which is refused for a reason that is
 * not going to be relaxed: a `WHERE` there filters the hop, so it changes which anchors get a NULL
 * row. The outer `WHERE true` that item 1849 used as its oracle is no longer one — this item is
 * exactly what taught the rung to take it.
 */
import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return Object.entries(cl)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
};

/**
 * Ten anchors: five with an out-edge and five without, and `k` cycling 0,1,2 so a predicate can
 * select a subset that straddles both groups. `nu` is null on some vertices so a comparison can be
 * UNKNOWN rather than merely false.
 */
const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 10; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['T'],
      properties: i % 4 === 1 ? { k: i % 3 } : { k: i % 3, nu: i },
    });
  }

  for (let i = 0; i < 10; i += 2) {
    const from = g.getVertexById(`v${i}`);
    const to = g.getVertexById(`v${(i + 3) % 10}`);

    if (from === null || to === null) {
      throw new Error('fixture is broken');
    }

    g.addEdge({ id: `e${i}`, from, to, labels: ['E'], properties: { w: i } });
  }

  return g;
};

const rows = (g: Graph, text: string): string[] =>
  query(g, text)
    .map((r) =>
      Object.values(r)
        .map((v) => (v === null ? '<null>' : JSON.stringify(v)))
        .join('/'),
    )
    .sort();

/** The same question with a no-op `WHERE` on the OPTIONAL clause, which declines the rung. */
const viaGeneral = (text: string): string =>
  text.replace('(b:T) RETURN', '(b:T) WHERE true RETURN');

describe('an anchor predicate on an OPTIONAL hop', () => {
  const CASES = [
    'MATCH (a:T) WHERE a.k >= 1 OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y',
    'MATCH (a:T) WHERE a.k = 0 OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y',
    // Selects NOTHING — the rung must return zero rows, not every anchor with nulls.
    'MATCH (a:T) WHERE a.k > 99 OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y',
    // Selects EVERYTHING.
    'MATCH (a:T) WHERE true OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y',
    // The inline spelling. It reaches the rung as a clause `WHERE`, because `liftStartProps`
    // runs before the detectors — so this case does NOT exercise a node-level predicate.
    'MATCH (a:T {k: 1}) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y',
    // THE NODE-LEVEL `WHERE`, which is NOT lifted and so is the only spelling that arrives on
    // the node itself. Without it the `start.where` half of the gate is untested, and a mutant
    // deleting it would survive.
    'MATCH (a:T WHERE a.k = 1) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y',
    // A comparison against a MISSING property is UNKNOWN, which must drop like FALSE.
    'MATCH (a:T) WHERE a.nu >= 4 OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y',
    // A conjunction, and a negation.
    'MATCH (a:T) WHERE a.k >= 1 AND a.k <= 1 OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y',
    'MATCH (a:T) WHERE NOT a.k = 0 OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y',
    // With the sort on top, so it composes with item 1849's rung.
    'MATCH (a:T) WHERE a.k >= 1 OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y ORDER BY x, y',
  ];

  test('answers exactly what the route that declines it answers', () => {
    const g = build();

    for (const text of CASES) {
      expect(rows(g, text)).toEqual(rows(g, viaGeneral(text)));
    }
  });

  test('the rung fires for each, and the oracle does not', () => {
    for (const text of CASES) {
      const fired = routes(text);

      expect(
        fired.includes('optionalHopProjection') || fired.includes('optionalOrderedProjection'),
      ).toBe(true);

      const oracle = routes(viaGeneral(text));

      expect(oracle).not.toContain('optionalHopProjection');
      expect(oracle).not.toContain('optionalOrderedProjection');
    }
  });

  /**
   * THE COUNT IS ASSERTED DIRECTLY, not only against the oracle. A rejected anchor must produce
   * NO row — a walk that emitted a NULL-filled row for it would return ten rows where four are
   * right, and the oracle could not catch that if both routes made the same mistake.
   */
  test('a rejected anchor produces NO row, not a NULL-filled one', () => {
    const g = build();

    // `k` is 0,1,2,0,1,2,… over ten vertices: four have k >= 2? No — k=2 at i=2,5,8, so three.
    const selected = rows(
      g,
      'MATCH (a:T) WHERE a.k = 2 OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y',
    );

    expect(selected.length).toBe(3);
    expect(selected.every((r) => r.startsWith('2/'))).toBe(true);

    // And a predicate matching nothing yields nothing at all.
    expect(
      rows(
        g,
        'MATCH (a:T) WHERE a.k > 99 OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y',
      ),
    ).toEqual([]);
  });

  test('a parameterised anchor predicate works and still fires', () => {
    const g = build();
    const text =
      'MATCH (a:T) WHERE a.k >= $lo OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y';

    expect(routes(text)).toContain('optionalHopProjection');

    const got = query(g, text, { lo: 1 })
      .map((r) => `${JSON.stringify(r.x)}/${r.y === null ? '<null>' : JSON.stringify(r.y)}`)
      .sort();

    expect(got).toEqual(rows(g, viaGeneral(text).replace('$lo', '1')));
  });
});

describe('the OPTIONAL clause’s own WHERE stays refused', () => {
  /**
   * IT IS A DIFFERENT QUESTION, not a harder version of the same one: a `WHERE` on the OPTIONAL
   * MATCH filters the HOP, so an anchor whose every edge it rejects must still appear with a NULL
   * row. The anchor predicate narrows which starts exist at all.
   */
  test('it declines, and the two WHEREs mean different things', () => {
    const g = build();
    const onHop =
      'MATCH (a:T) OPTIONAL MATCH (a)-[:E]->(b:T) WHERE b.k = 99 RETURN a.k AS x, b.k AS y';
    const onAnchor =
      'MATCH (a:T) WHERE a.k = 99 OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.k AS x, b.k AS y';

    expect(routes(onHop)).not.toContain('optionalHopProjection');

    // The hop filter rejects every edge, so every anchor survives with a NULL.
    expect(rows(g, onHop).length).toBe(10);
    expect(rows(g, onHop).every((r) => r.endsWith('<null>'))).toBe(true);
    // The anchor filter rejects every start, so there are no rows at all.
    expect(rows(g, onAnchor)).toEqual([]);
  });
});
