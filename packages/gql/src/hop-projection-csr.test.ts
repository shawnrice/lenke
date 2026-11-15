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
/**
 * Item 1941: a BROAD non-vacuous far label no longer declines the CSR arm — it is applied PER SLOT.
 *
 * ```text
 *   MATCH (a)-[:E]->(b:T), ONE off-label vertex in 50,000:   8.70 ms -> 2.77   3.1x
 *   ten off-label                                            8.66    -> 2.46   3.5x
 *   at 0.6 coverage on the sweep                             5.51    -> 2.50   2.2x
 *   at 0.04 coverage (below the gate)                        unchanged — the bucket walk wins 2.4x
 * ```
 *
 * ⚠️ `testFarLabel` IS THE CONTRACT, not a hint: the route admits a label it has not applied, so a
 * caller that ignored the flag would emit rows for off-label far vertices. That is why the return
 * shape changed rather than just the condition.
 */
describe('csrHopRoute — a BROAD far label is admitted and flagged (item 1941)', () => {
  // `label` is defined inside the neighbouring describe's scope, so this block needs its own.
  const label = (name: string): never => ({ kind: 'label', name }) as never;

  it('a vacuous far label is admitted with testFarLabel FALSE', () => {
    const g = fixture();

    // Every vertex carries `P`, so nothing can fail it and no per-slot test is needed.
    expect(csrHopRoute(g, true, 'E', label('P'))).toBeUndefined(); // first ask declines
    const route = csrHopRoute(g, true, 'E', label('P'));

    expect(route).not.toBeUndefined();
    expect(route?.testFarLabel).toBe(false);
  });

  it('no far label at all is admitted with testFarLabel FALSE', () => {
    const g = fixture();

    csrHopRoute(g, true, 'E', undefined);

    expect(csrHopRoute(g, true, 'E', undefined)?.testFarLabel).toBe(false);
  });

  it('⚠️ a SELECTIVE far label still declines — item 1688s lesson is unchanged', () => {
    // `Q` is on 2 of 7 vertices (0.286), BELOW the shared threshold, so bucket iteration wins and
    // the route must stay out of the way. This is the assertion the threshold choice protected:
    // a lower constant would have flipped it, and a 7-vertex fixture is no place to set one.
    const g = fixture();

    expect(csrHopRoute(g, true, 'E', label('Q'))).toBeUndefined();
    expect(csrHopRoute(g, true, 'E', label('Q'))).toBeUndefined();
    expect(csrHopRoute(g, true, 'E', label('Q'))).toBeUndefined();
  });

  it('a BROAD non-vacuous far label is admitted WITH testFarLabel true', () => {
    const g = new Graph();

    // 9 of 10 carry `B`, so coverage is 0.9 — above the threshold, and not vacuous.
    for (let i = 0; i < 10; i += 1) {
      g.addVertex({ id: `w${String(i)}`, labels: i === 0 ? ['A'] : ['A', 'B'], properties: {} });
    }

    for (let i = 0; i < 9; i += 1) {
      const from = g.getVertexById(`w${String(i)}`);
      const to = g.getVertexById(`w${String(i + 1)}`);

      if (from === null || to === null) {
        throw new Error('fixture');
      }

      g.addEdge({ id: `x${String(i)}`, from, to, labels: ['E'], properties: {} });
    }

    csrHopRoute(g, true, 'E', label('B'));
    const route = csrHopRoute(g, true, 'E', label('B'));

    expect(route).not.toBeUndefined();
    expect(route?.testFarLabel).toBe(true);
  });

  it('⚠️ a COMPOUND far label whose coverage is UNREADABLE declines the route', () => {
    /*
     * ⚠️ `labelCoverage` answers only for a PLAIN label — a disjunction's buckets overlap so their
     * sizes do not add. The route must then DECLINE rather than guess, which is what `?? 0` encodes.
     *
     * 🔑 THIS TEST EXISTS BECAUSE A MUTANT SURVIVED WITHOUT IT. Defaulting an unreadable coverage to
     * `?? 1` (i.e. "assume broad") changes NO answer — `matchesLabel` handles compounds, so the
     * per-slot test is still correct — it only sends an O(V) arm at a label that might be selective,
     * where bucket iteration is sub-linear (item 1688). A route-only regression, invisible to every
     * test over rows, so the route decision is asserted directly.
     */
    const g = new Graph();

    // `B` on 5 of 10 and `C` on 2, so `B|C` covers 7 — NOT vacuous, and not readable as a fraction.
    for (let i = 0; i < 10; i += 1) {
      const labels = ['A'];

      if (i < 5) {
        labels.push('B');
      } else if (i < 7) {
        labels.push('C');
      }

      g.addVertex({ id: `z${String(i)}`, labels, properties: { n: i } });
    }

    for (let i = 0; i < 9; i += 1) {
      const from = g.getVertexById(`z${String(i)}`);
      const to = g.getVertexById(`z${String(i + 1)}`);

      if (from === null || to === null) {
        throw new Error('fixture');
      }

      g.addEdge({ id: `y${String(i)}`, from, to, labels: ['E'], properties: {} });
    }

    const or = { kind: 'or', left: label('B'), right: label('C') } as never;

    // Asked twice, because the arm declines its own first ask regardless (item 1890).
    expect(csrHopRoute(g, true, 'E', or)).toBeUndefined();
    expect(csrHopRoute(g, true, 'E', or)).toBeUndefined();
    // ...and the query still answers correctly off that arm.
    expect(query(g, 'MATCH (a)-[:E]->(b:B|C) RETURN b.n AS x', {}).length).toBe(6);
  });

  it('and the rows EXCLUDE the off-label far vertex, so the flag is actually honoured', () => {
    const g = new Graph();

    for (let i = 0; i < 10; i += 1) {
      g.addVertex({
        id: `w${String(i)}`,
        labels: i === 9 ? ['A'] : ['A', 'B'],
        properties: { n: i },
      });
    }

    // Every vertex points at w9, which is the ONLY one lacking `B`. If the per-slot test is
    // skipped, w9 appears as a far endpoint and the count is 9 instead of 0.
    for (let i = 0; i < 9; i += 1) {
      const from = g.getVertexById(`w${String(i)}`);
      const to = g.getVertexById('w9');

      if (from === null || to === null) {
        throw new Error('fixture');
      }

      g.addEdge({ id: `x${String(i)}`, from, to, labels: ['E'], properties: {} });
    }

    const q = 'MATCH (a)-[:E]->(b:B) RETURN b.n AS x';

    query(g, q, {});

    expect(query(g, q, {}).length).toBe(0);
    // ...and the same walk WITHOUT the far label sees all nine.
    expect(query(g, 'MATCH (a)-[:E]->(b) RETURN b.n AS x', {}).length).toBe(9);
  });
});

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
