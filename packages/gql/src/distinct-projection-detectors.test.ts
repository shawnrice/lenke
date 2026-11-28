import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

/**
 * Item 2466: `detectNodeDistinctProjection` and `detectHopDistinctProjection`, from item 2460's
 * coverage map — named in no test, despite 93 `CLOSED.md` mentions of `RETURN DISTINCT`.
 *
 * `detectNodeDistinctProjection` serves the TWO-COLUMN `DISTINCT` specifically; a single-column
 * one is taken by a different rung (`distinctProjection`), and `[[fuzzer-blind-to-one-column-group]]`
 * records that every fuzzer's grouped shape is the two-column form — so this is the arm the
 * generative tests exercise and the one whose GATE nothing pinned.
 *
 * A route choice is answer-equivalent, so every mutant in these guards is invisible to the
 * differential, fuzz and conformance suites (`perf-gate-needs-its-own-test`). Each admission below
 * calls the returned function and compares its ROWS against the engine's own answer
 * (`gate-returning-a-value`), and each decline names the condition it reaches, because a decline
 * only proves SOME guard fired (item 2464).
 *
 * THE SIX-CONDITION CONJUNCTION IS ROW-LEVEL CORRECTNESS, NOT CAUTION, for the window half. The
 * source says why: "`distinctRows` runs AFTER the rows exist, so a window would have to be applied
 * after the dedupe and `detectNodeProjection` would have applied it before. Getting that order
 * wrong returns different ROWS, not a different order."
 */

/** Four P vertices whose `k`/`t` repeat, so DISTINCT has something to collapse. */
const build = (): Graph => {
  const g = new Graph();
  const v: Record<string, ReturnType<Graph['addVertex']>> = {};

  for (const [id, k] of [
    ['a', 1],
    ['b', 2],
    ['c', 1],
    ['d', 2],
  ] as const) {
    v[id] = g.addVertex({ id, labels: ['P'], properties: { k, t: `t${k}` } });
  }

  g.addEdge({ id: 'e1', from: v.a, to: v.b, labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: v.b, to: v.c, labels: ['E'], properties: {} });

  return g;
};

const g = build();

type Linear = Parameters<typeof compileLinear>[0];

const routes = (text: string) => {
  const parsed = parse(text) as { parts?: readonly unknown[] };

  return compileLinear((parsed.parts === undefined ? parsed : parsed.parts[0]) as Linear);
};

const TWO_COL = 'MATCH (n:P) RETURN DISTINCT n.k AS k, n.t AS t';

describe('detectNodeDistinctProjection', () => {
  it('serves a two-column DISTINCT over a node scan, and its ROWS are the engine answer', () => {
    const compiled = routes(TWO_COL);
    const expected = [
      { k: 1, t: 't1' },
      { k: 2, t: 't2' },
    ];

    expect(compiled.nodeDistinctProjection).not.toBeNull();
    expect(compiled.nodeDistinctProjection?.(g, {})).toStrictEqual(expected);
    expect(query(g, TWO_COL, {})).toStrictEqual(expected);
  });

  it('DECLINES without DISTINCT, and the plain projection rung takes it', () => {
    const text = 'MATCH (n:P) RETURN n.k AS k, n.t AS t';
    const compiled = routes(text);

    expect(compiled.nodeDistinctProjection).toBeNull();
    expect(compiled.nodeProjection).not.toBeNull();
    // Four vertices, no dedupe.
    expect(query(g, text, {})).toHaveLength(4);
  });

  it('DECLINES `RETURN DISTINCT *`, reaching the `proj.star` condition', () => {
    const compiled = routes('MATCH (n:P) RETURN DISTINCT *');

    expect(compiled.nodeDistinctProjection).toBeNull();
  });

  it('DECLINES a SINGLE column, reaching `items.length < 2` — a sibling rung serves it', () => {
    const text = 'MATCH (n:P) RETURN DISTINCT n.k AS k';
    const compiled = routes(text);

    expect(compiled.nodeDistinctProjection).toBeNull();
    expect(compiled.distinctProjection).not.toBeNull();
    expect(query(g, text, {})).toStrictEqual([{ k: 1 }, { k: 2 }]);
  });

  /*
   * THE WINDOW TRIO. Each is refused for the row-level reason quoted in this file's header, so these
   * three assertions pin a CORRECTNESS condition rather than a performance choice.
   */
  it('DECLINES an ORDER BY', () => {
    const text = `${TWO_COL} ORDER BY k`;

    expect(routes(text).nodeDistinctProjection).toBeNull();
    expect(query(g, text, {})).toStrictEqual([
      { k: 1, t: 't1' },
      { k: 2, t: 't2' },
    ]);
  });

  it('DECLINES a SKIP, and a LIMIT, independently of each other', () => {
    // Row IDENTITY is not asserted here: with no ORDER BY the surviving row depends on walk order,
    // which `order-is-unspecified` makes implementation-dependent. The COUNT is the contract.
    expect(routes(`${TWO_COL} SKIP 1`).nodeDistinctProjection).toBeNull();
    expect(query(g, `${TWO_COL} SKIP 1`, {})).toHaveLength(1);

    expect(routes(`${TWO_COL} LIMIT 1`).nodeDistinctProjection).toBeNull();
    expect(query(g, `${TWO_COL} LIMIT 1`, {})).toHaveLength(1);
  });

  it('DECLINES a HOP, because the inner node-projection detector refuses it', () => {
    // Reaches the last step rather than any of the six conditions: the projection is a valid
    // two-column DISTINCT, and `detectNodeProjection` is what says no.
    const text = 'MATCH (a:P)-[:E]->(x:P) RETURN DISTINCT x.k AS k, x.t AS t';
    const compiled = routes(text);

    expect(compiled.nodeDistinctProjection).toBeNull();
    expect(compiled.hopDistinctProjection).not.toBeNull();
  });
});

describe('detectHopDistinctProjection', () => {
  const HOP_TWO_COL = 'MATCH (a:P)-[:E]->(x:P) RETURN DISTINCT x.k AS k, x.t AS t';

  it('serves the hop form, and its ROWS match the engine as a MULTISET', () => {
    const compiled = routes(HOP_TWO_COL);
    const direct = compiled.hopDistinctProjection?.(g, {}) ?? [];
    const key = (r: unknown) => JSON.stringify(r);

    expect(compiled.hopDistinctProjection).not.toBeNull();
    // Compared as a multiset: an unordered result's row order is not a contract
    // (`order-is-unspecified`), and this shape's walk order differs from the node scan's.
    expect([...direct].map(key).sort()).toStrictEqual(
      [...query(g, HOP_TWO_COL, {})].map(key).sort(),
    );
    expect(direct).toHaveLength(2);
  });

  it('DECLINES the NODE form, which its sibling serves', () => {
    const compiled = routes(TWO_COL);

    expect(compiled.hopDistinctProjection).toBeNull();
    expect(compiled.nodeDistinctProjection).not.toBeNull();
  });

  it('DECLINES a SINGLE-column hop DISTINCT, so `distinctProjection` can serve it', () => {
    /*
     * FOUND BY FLIPPING (item 2466): dropping `items.length < 2` here makes THIS shape flip from
     * `null` to admitted, while nothing else in the fixture set moves. The source states the
     * intent — "TWO columns or more, so this cannot accept a shape `distinctProjection` does" —
     * and unlike its node-side twin this condition is NOT redundant: no other guard refuses it.
     */
    const text = 'MATCH (a:P)-[:E]->(x:P) RETURN DISTINCT x.k AS k';
    const compiled = routes(text);

    expect(compiled.hopDistinctProjection).toBeNull();
    expect(compiled.nodeDistinctProjection).toBeNull();
    expect(query(g, text, {})).toHaveLength(2);
  });

  it('DECLINES the hop form without DISTINCT', () => {
    const compiled = routes('MATCH (a:P)-[:E]->(x:P) RETURN x.k AS k, x.t AS t');

    expect(compiled.hopDistinctProjection).toBeNull();
  });
});
