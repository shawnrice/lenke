import { describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import { query } from './index.js';

// Audit item 253. `compileSubpathUnit` attaches the inner subpath's own per-repetition `WHERE`
// to the INNER unit, and the matcher asks `unit.where !== undefined` of the unit it was HANDED
// — the outermost one — so it was compiled, attached, and never evaluated. Unlike item 249's
// case this one cannot move onto a hop: it is genuinely per-inner-repetition and may read the
// rep's nodes.
//
// The fix passes a GATE into `resolve`, consulted at the moment an inner unit's rep completes.
// It has to live there because `resolve` merges every branch into one `moves` list and one
// `emit` flag, so pruning afterwards cannot name the branch that went through that completion.
// Both continuations are gated — the `close` that leaves the unit and the `again` that starts
// another rep — because a failed rep is on the path either way.
const chain = (): Graph => {
  const g = new Graph();
  const v: Record<string, Vertex> = {};

  for (const id of ['0', '1', '2', '3']) {
    v[id] = g.addVertex({ id, labels: ['N'], properties: { n: Number(id) } });
  }

  // 0 -(w5)-> 1 -(w5)-> 2 -(w1)-> 3.
  g.addEdge({ id: 'a', from: v['0'], to: v['1'], labels: ['R'], properties: { w: 5 } });
  g.addEdge({ id: 'b', from: v['1'], to: v['2'], labels: ['R'], properties: { w: 5 } });
  g.addEdge({ id: 'c', from: v['2'], to: v['3'], labels: ['R'], properties: { w: 1 } });

  return g;
};

const count = (g: Graph, q: string): number => {
  const rows = query(g, q) as Array<Record<string, unknown>>;

  return rows[0].c as number;
};

describe("an inner subpath's own per-repetition WHERE", () => {
  // THE EQUIVALENCE that pins the answer without appealing to the other engine: an inner
  // {1,1} of a one-hop unit, repeated 1..2 times, accepts exactly the 1-2 hop walks whose
  // every hop satisfies the WHERE — the flat {1,2} with the same WHERE. `x.n <> 1` leaves
  // `0->1` and `2->3`, which do not compose, so 2 where unfiltered gives 5.
  test('it matches the flat spelling of the same question', () => {
    const g = chain();

    expect(count(g, 'MATCH (a:N)((x)-[e:R]->(y) WHERE x.n <> 1){1,2} RETURN count(*) AS c')).toBe(
      2,
    );
    expect(count(g, 'MATCH (a:N)(((x)-[e:R]->(y)){1,1}){1,2} RETURN count(*) AS c')).toBe(5);
    // Returned 5 — the UNFILTERED answer — before the gate existed.
    expect(
      count(g, 'MATCH (a:N)(((x)-[e:R]->(y) WHERE x.n <> 1){1,1}){1,2} RETURN count(*) AS c'),
    ).toBe(2);
  });

  test('it prunes a nested group whose quantifiers are both ranges', () => {
    const g = chain();

    expect(count(g, 'MATCH (a:N)(((x)-[e:R]->(y)){1,2}){1,2} RETURN count(*) AS c')).toBe(9);
    expect(
      count(g, 'MATCH (a:N)(((x)-[e:R]->(y) WHERE x.n <> 1){1,2}){1,2} RETURN count(*) AS c'),
    ).toBe(2);
  });

  // The predicate must see its rep's EDGE and its NODES, and the source and target must not
  // resolve to the same binding. `x.n <> 1` leaves two hops that do NOT compose (2); `y.n <> 1`
  // excludes the hop INTO 1 and leaves two that DO compose, reached two ways by the nested
  // shape (4). The two numbers DIFFERING is the discriminator.
  test('it reads its own edge, source and target', () => {
    const g = chain();
    const c = (w: string): number =>
      count(g, `MATCH (a:N)(((x)-[e:R]->(y) WHERE ${w}){1,2}){1,2} RETURN count(*) AS c`);

    expect(c('e.w > x.n')).toBe(4);
    expect(c('e.w > 2')).toBe(4);
    expect(c('x.n <> 1')).toBe(2);
    expect(c('y.n <> 1')).toBe(4);
    expect(c('x.n <> 1')).not.toBe(c('y.n <> 1'));
  });

  // A SIMPLE close must be gated too. The close path computes its own `resolve` to decide
  // whether the hop closes, and REUSING that ungated result let a closing repetition skip the
  // predicate entirely — TS answered 11 where native answered 9. Found by the fuzzer arm added
  // in the same change, on its first run, which is why this test exists rather than the
  // reasoning that would have missed it.
  test('a SIMPLE closing repetition is gated too', () => {
    const g = new Graph();
    const v: Record<string, Vertex> = {};

    for (const id of ['0', '1', '2']) {
      v[id] = g.addVertex({ id, labels: ['N'], properties: { n: Number(id) } });
    }

    // A 3-cycle, so SIMPLE has closes to admit, with the CLOSING edge the one that fails.
    g.addEdge({ id: 'a', from: v['0'], to: v['1'], labels: ['R'], properties: { w: 9 } });
    g.addEdge({ id: 'b', from: v['1'], to: v['2'], labels: ['R'], properties: { w: 9 } });
    g.addEdge({ id: 'c', from: v['2'], to: v['0'], labels: ['R'], properties: { w: 1 } });

    const open = count(g, 'MATCH SIMPLE (a:N)(((x)-[e:R]->(y)){1,2}){1,2} RETURN count(*) AS c');
    const gated = count(
      g,
      'MATCH SIMPLE (a:N)(((x)-[e:R]->(y) WHERE e.w > 2){1,2}){1,2} RETURN count(*) AS c',
    );

    expect(open).toBeGreaterThan(gated);
    // The `w = 1` edge closes every cycle here, so no walk that uses it may survive — which is
    // what an ungated close path let through.
    expect(gated).toBe(
      count(g, 'MATCH SIMPLE (a:N)(((x)-[e:R WHERE e.w > 2]->(y)){1,2}){1,2} RETURN count(*) AS c'),
    );
  });

  // The inner and OUTER per-rep predicates live in different places and must AND.
  test('the inner and outer per-rep WHEREs both apply', () => {
    const g = chain();
    const innerOnly = count(
      g,
      'MATCH (a:N)(((x)-[e:R]->(y) WHERE e.w > 2){1,2}){1,2} RETURN count(*) AS c',
    );
    const both = count(
      g,
      'MATCH (a:N)(((x)-[e:R]->(y) WHERE e.w > 2){1,2} WHERE x[0].n <> 1){1,2} RETURN count(*) AS c',
    );

    expect(innerOnly).toBe(4);
    expect(both).toBeLessThan(innerOnly);
  });

  // Nothing changes for a nested group with no inner WHERE at all — the gate must cost nothing
  // and prune nothing when `unit.where` is undefined, which is the overwhelmingly common case.
  test('a nested group without an inner WHERE is untouched', () => {
    const g = chain();

    expect(count(g, 'MATCH (a:N)(((x)-[e:R]->(y)){1,2}){1,2} RETURN count(*) AS c')).toBe(9);
    expect(count(g, 'MATCH (a:N)(((x)-[e:R]->(y)){1,1}){1,2} RETURN count(*) AS c')).toBe(5);
    expect(count(g, 'MATCH (a:N)(((x)-[e:R]->(y)){1,2}){1,1} RETURN count(*) AS c')).toBe(5);
  });
});
