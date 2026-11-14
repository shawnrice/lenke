import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { csrHopRoute } from './executor/csr-cache.ts';
import { query } from './index.ts';

/**
 * THE FAR-DRIVEN HOP PROJECTION'S CSR ARM (item 1895).
 *
 * ⚠️ IT IS THE MOST COMMON SHAPE IN THE LANGUAGE and the hand floors said the whole gap was the
 * per-vertex `Map` work: iterating `verticesById` and reading `adjTo.get(type)` for each.
 * `gql-hop-ceiling-1895.mjs` at 200,000 vertices / 1,000,000 edges — engine 75.13 ms, the same walk
 * BY HAND 68.83 (1.09x, so no delegation left), the same over a flat (far, degree) index 21.16
 * (3.25x). After the arm: **25.96 ms, 2.89x**, and at fanout 1 the grid's own shape goes
 * **39.23 → 8.22, 4.8x**.
 *
 * ⚠️ ROWS ARE COMPARED AS MULTISETS, which is this engine's contract for an unordered result
 * ([[order-is-unspecified]], and the differential fuzzer compares GQL rows the same way). The CSR
 * walks slots in `verticesById` order, which is the order the existing walk uses anyway, but
 * nothing here depends on that.
 *
 * ⚠️ AND EVERY CASE RUNS TWICE, because the arm declines its own first ask (item 1890's
 * amortization policy): a single `query` measures the old walk. Item 1891 lost five mutants to
 * exactly this.
 */
const fixture = (): Graph => {
  const g = new Graph();

  // Every vertex carries `P` — a VACUOUS label, which the arm must see through. `Q` is selective.
  for (let i = 0; i < 6; i += 1) {
    g.addVertex({
      id: `v${String(i)}`,
      labels: i % 3 === 0 ? ['P', 'Q'] : ['P'],
      properties: { k: i * 10 },
    });
  }

  // v5 has no `k` at all, so a projection of it yields null rather than a missing row.
  g.addVertex({ id: 'bare', labels: ['P'], properties: { other: 1 } });

  for (const spec of [
    { id: 'e0', from: 'v0', to: 'v1' },
    { id: 'e1', from: 'v0', to: 'v2' },
    { id: 'e2', from: 'v1', to: 'v3' },
    { id: 'e3', from: 'v2', to: 'v3' },
    // A second edge into v3, so one far vertex has degree 3 and the clone loop runs.
    { id: 'e4', from: 'v4', to: 'v3' },
    { id: 'e5', from: 'v3', to: 'bare' },
  ]) {
    g.addEdge({
      id: spec.id,
      from: g.getVertexById(spec.from) as never,
      to: g.getVertexById(spec.to) as never,
      labels: ['E'],
    });
  }

  return g;
};

/** Both calls, as MULTISETS, asserted equal — the first is the old walk and the second the CSR. */
const twice = (g: Graph, q: string): unknown[] => {
  const key = (rows: readonly Record<string, unknown>[]): string =>
    JSON.stringify(rows.map((r) => JSON.stringify(r)).sort());
  const first = query(g, q);
  const second = query(g, q);

  expect(key(second)).toStrictEqual(key(first));

  return [...second].map((r) => JSON.stringify(r)).sort();
};

/**
 * ⚠️ THE ROUTE DECISION AS A PURE FUNCTION, because BOTH of its conditions are answer-equivalent and
 * two mutants of them survived every test above. One of those two is the bug the first cut of this
 * arm shipped: reading the label's vacuity from the AST declines every labelled pattern, which is
 * nearly all of them, and it measured as a flat null.
 */
describe('csrHopRoute — the route decision', () => {
  const label = (name: string): never => ({ kind: 'label', name }) as never;

  it('declines its own FIRST ask and answers the second — the amortization policy', () => {
    const g = fixture();

    expect(csrHopRoute(g, true, 'E', undefined)).toBeUndefined();
    expect(csrHopRoute(g, true, 'E', undefined)).not.toBeUndefined();
  });

  it('sees through a VACUOUS far label — every vertex carries `P`', () => {
    const g = fixture();

    expect(csrHopRoute(g, true, 'E', label('P'))).toBeUndefined();
    expect(csrHopRoute(g, true, 'E', label('P'))).not.toBeUndefined();
  });

  it('declines a SELECTIVE far label on EVERY ask', () => {
    const g = fixture();

    expect(csrHopRoute(g, true, 'E', label('Q'))).toBeUndefined();
    expect(csrHopRoute(g, true, 'E', label('Q'))).toBeUndefined();
    expect(csrHopRoute(g, true, 'E', label('Q'))).toBeUndefined();
  });

  it('keys the generation per DIRECTION and TYPE', () => {
    const g = fixture();

    expect(csrHopRoute(g, true, 'E', undefined)).toBeUndefined();
    expect(csrHopRoute(g, false, 'E', undefined)).toBeUndefined();
    expect(csrHopRoute(g, true, 'F', undefined)).toBeUndefined();
    expect(csrHopRoute(g, true, 'E', undefined)).not.toBeUndefined();
  });

  it('RESETS on a topology write', () => {
    const g = fixture();

    expect(csrHopRoute(g, true, 'E', undefined)).toBeUndefined();
    expect(csrHopRoute(g, true, 'E', undefined)).not.toBeUndefined();

    g.addEdge({
      id: 'after',
      from: g.getVertexById('v1') as never,
      to: g.getVertexById('v2') as never,
      labels: ['E'],
    });

    expect(csrHopRoute(g, true, 'E', undefined)).toBeUndefined();
  });
});

describe('the far-driven hop projection agrees across both routes', () => {
  it('projects the far end, once per incoming edge', () => {
    const g = fixture();

    // Far ends and their in-degrees: v1(1), v2(1), v3(3), bare(1).
    expect(twice(g, 'MATCH (a)-[:E]->(b) RETURN b.k AS k')).toStrictEqual([
      '{"k":10}',
      '{"k":20}',
      '{"k":30}',
      '{"k":30}',
      '{"k":30}',
      '{"k":null}',
    ]);
  });

  it('sees through a VACUOUS label — every vertex carries `P`', () => {
    const g = fixture();

    expect(twice(g, 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k')).toStrictEqual(
      twice(g, 'MATCH (a)-[:E]->(b) RETURN b.k AS k'),
    );
  });

  /**
   * ⚠️ A SELECTIVE FAR LABEL MUST DECLINE, and the answer is the evidence: `candidateVertexSource`
   * iterates the `Q` bucket where this arm would scan every slot. Item 1688 learned from a test
   * that an answer can be right while the work is wrong — the route half is pinned by the A/B, this
   * half pins that declining still answers.
   */
  it('answers a SELECTIVE far label correctly, on the route it keeps', () => {
    const g = fixture();

    // `Q` is on v0 and v3. Only v3 has in-edges — three of them.
    expect(twice(g, 'MATCH (a)-[:E]->(b:Q) RETURN b.k AS k')).toStrictEqual([
      '{"k":30}',
      '{"k":30}',
      '{"k":30}',
    ]);
  });

  it('serves the REVERSE direction', () => {
    const g = fixture();

    // `<-` makes the far end the edge's SOURCE: v0(2 out), v1(1), v2(1), v3(1), v4(1).
    expect(twice(g, 'MATCH (a)<-[:E]-(b) RETURN b.k AS k')).toStrictEqual([
      '{"k":0}',
      '{"k":0}',
      '{"k":10}',
      '{"k":20}',
      '{"k":30}',
      '{"k":40}',
    ]);
  });

  it('serves a TWO-column projection, where the template is cloned', () => {
    const g = fixture();

    expect(twice(g, 'MATCH (a)-[:E]->(b) RETURN b.k AS k, b.other AS o').length).toBe(6);
  });

  it('still answers after a topology WRITE, which resets the generation', () => {
    const g = fixture();

    expect(twice(g, 'MATCH (a)-[:E]->(b) RETURN b.k AS k').length).toBe(6);

    g.addEdge({
      id: 'later',
      from: g.getVertexById('v4') as never,
      to: g.getVertexById('v1') as never,
      labels: ['E'],
    });

    expect(twice(g, 'MATCH (a)-[:E]->(b) RETURN b.k AS k').length).toBe(7);
  });

  it('answers an EMPTY graph and a type no edge carries', () => {
    const g = fixture();

    expect(twice(g, 'MATCH (a)-[:NOPE]->(b) RETURN b.k AS k')).toStrictEqual([]);
    expect(twice(new Graph(), 'MATCH (a)-[:E]->(b) RETURN b.k AS k')).toStrictEqual([]);
  });
});
