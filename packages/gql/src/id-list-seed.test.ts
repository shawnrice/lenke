import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Item 1315: `WHERE element_id(n) IN [...]` and `element_id(n) = a OR element_id(n) = b` both
 * SEED from `verticesById`, where item 618 had given only the single `=` a seed.
 *
 * This is CLAUDE.md's equivalent-spelling class exactly: the planner recognized one spelling of a
 * predicate and scanned for another that meant the same thing. Measured at 200,000 vertices with
 * four controls (`docs/reviews/2026-08-31-ts-audit.md`, item 1315):
 *
 *     = one id                  0.00612 ms   already seeded at item 618
 *     IN three ids    7.54313 -> 0.01228      614x
 *     OR-chain       18.50733 -> 0.01450     1276x
 *
 * EVERY TEST HERE ASSERTS THE ROUTE, not only the rows, and the two directions are what give it
 * teeth. A seed is answer-equivalent — a version that declined and scanned returns exactly these
 * rows — so an admission case asserts the lookup COUNT and every decline case asserts
 * `calls() === 0`. Without the decline half a mutant that seeds unconditionally passes the file.
 *
 * The counting spy on `Graph.getVertexById` is item 618's instrument, reused deliberately: it is
 * an own arrow property, the seed path calls it and the label scan never does, which makes "did it
 * seed" a deterministic binary observation instead of a timing comparison.
 *
 * WHAT THAT SPY DOES *NOT* SEE, found by mutation and worth stating because it is easy to
 * overclaim: the consumer resolves the ids EAGERLY inside `indexCandidates`, since `orient` needs
 * the candidate count before it can choose a start. So `getVertexById` runs even when
 * `seedVertices` then declines the seek at the `seekIsWorthIt` gate and scans instead. The counter
 * therefore witnesses "the hint was produced and resolved", which is exactly the right signal for
 * every DECLINE case (no hint, no lookups) — but it cannot tell a taken seek from a resolved-then-
 * declined one. A `count: 1e9` mutant survived the whole file for that reason.
 *
 * {@link spyFullScan} is the missing half. `candidateVertices` reaches an unlabelled pattern's
 * vertices through `graph.verticesById.values()`, and a taken seek never calls it, so counting
 * that call IS "was the seek chosen" — and it is the assertion that kills the `count` mutant.
 */
const spyGetVertexById = (g: Graph): (() => number) => {
  let calls = 0;
  const real = g.getVertexById;

  (g as unknown as { getVertexById: typeof real }).getVertexById = (id: string) => {
    calls += 1;

    return real(id);
  };

  return () => calls;
};

/**
 * Counts full scans of the vertex map — `candidateVertices`' route for an unlabelled pattern.
 * Zero means the seek was TAKEN; one means it was declined and the bucket was walked.
 */
const spyFullScan = (g: Graph): (() => number) => {
  let calls = 0;
  const map = g.verticesById;
  const real = map.values.bind(map);

  (map as unknown as { values: typeof real }).values = () => {
    calls += 1;

    return real();
  };

  return () => calls;
};

const fixture = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 40; i++) {
    g.addVertex({
      id: `v${i}`,
      labels: [i % 2 === 0 ? 'P' : 'Q'],
      properties: { n: i },
    });
  }

  const at = (id: string): NonNullable<ReturnType<Graph['getVertexById']>> => {
    const v = g.getVertexById(id);

    if (!v) {
      throw new Error(`fixture is broken: no vertex ${id}`);
    }

    return v;
  };

  g.addEdge({ id: 'e0', from: at('v0'), to: at('v2'), labels: ['KNOWS'], properties: { w: 1 } });
  g.addEdge({ id: 'e1', from: at('v2'), to: at('v4'), labels: ['KNOWS'], properties: { w: 2 } });

  return g;
};

describe('GQL id-list seed: the IN spelling', () => {
  test('three ids seed with exactly three lookups, and no scan', () => {
    const g = fixture();
    const calls = spyGetVertexById(g);
    const q = `MATCH (x:P) WHERE element_id(x) IN ['v4', 'v10', 'v22'] RETURN x.n AS v`;

    expect(
      query(g, q)
        .map((r) => r.v)
        .sort((a, b) => Number(a) - Number(b)),
    ).toEqual([4, 10, 22]);
    expect(calls()).toBe(3);
  });

  test('a single-element IN list seeds like the bare `=` does', () => {
    const g = fixture();
    const calls = spyGetVertexById(g);

    expect(query(g, `MATCH (x:P) WHERE element_id(x) IN ['v4'] RETURN x.n AS v`)).toEqual([
      { v: 4 },
    ]);
    expect(calls()).toBe(1);
  });

  test('a $param list seeds — the shape a caller actually writes', () => {
    const g = fixture();
    const calls = spyGetVertexById(g);
    const q = `MATCH (x:P) WHERE element_id(x) IN $ids RETURN x.n AS v`;

    expect(query(g, q, { ids: ['v6', 'v8'] }).map((r) => r.v)).toEqual([6, 8]);
    expect(calls()).toBe(2);
  });

  test('an unlabelled pattern seeds too', () => {
    const g = fixture();
    const calls = spyGetVertexById(g);

    expect(query(g, `MATCH (x) WHERE element_id(x) IN ['v4', 'v5'] RETURN x.n AS v`).length).toBe(
      2,
    );
    expect(calls()).toBe(2);
  });

  test('the seek is actually TAKEN — the whole vertex map is never walked', () => {
    // The assertion the lookup counter cannot make. A declined seek falls through to
    // `candidateVertices`, which reaches an unlabelled pattern via `verticesById.values()`; a
    // taken seek never does. This is what catches a mis-reported candidate `count`, which is
    // otherwise answer-equivalent AND invisible to the lookup counter (see the file header).
    const g = fixture();
    const scans = spyFullScan(g);
    const q = `MATCH (x) WHERE element_id(x) IN ['v4', 'v10', 'v22'] RETURN x.n AS v`;

    expect(query(g, q).length).toBe(3);
    expect(scans()).toBe(0);
  });

  test('the OR spelling takes the seek too, not merely the same rows', () => {
    const g = fixture();
    const scans = spyFullScan(g);
    const q = `MATCH (x) WHERE element_id(x) = 'v4' OR element_id(x) = 'v10' RETURN x.n AS v`;

    expect(query(g, q).length).toBe(2);
    expect(scans()).toBe(0);
  });

  test('and a DECLINED shape does walk the map — the spy is not vacuously zero', () => {
    // The null control for `spyFullScan`. Without it, a spy that never fires for any query
    // would make both assertions above pass while proving nothing.
    const g = fixture();
    const scans = spyFullScan(g);

    expect(query(g, `MATCH (x) WHERE x.n IN [4, 10] RETURN x.n AS v`).length).toBe(2);
    expect(scans()).toBeGreaterThan(0);
  });
});

describe('GQL id-list seed: the OR spelling is the SAME plan', () => {
  test('the OR chain agrees with the IN spelling, row for row, and seeds', () => {
    const inQ = `MATCH (x:P) WHERE element_id(x) IN ['v4', 'v10', 'v22'] RETURN x.n AS v`;
    const orQ =
      `MATCH (x:P) WHERE element_id(x) = 'v4' OR element_id(x) = 'v10' ` +
      `OR element_id(x) = 'v22' RETURN x.n AS v`;

    const gi = fixture();
    const go = fixture();
    const callsOr = spyGetVertexById(go);
    const norm = (rows: readonly Record<string, unknown>[]): unknown[] =>
      rows.map((r) => r.v).sort((a, b) => Number(a) - Number(b));

    expect(norm(query(go, orQ))).toEqual(norm(query(gi, inQ)));
    expect(callsOr()).toBe(3);
  });

  test('the reversed operand order seeds in an OR chain as it does for a bare `=`', () => {
    const g = fixture();
    const calls = spyGetVertexById(g);
    const q = `MATCH (x:P) WHERE 'v4' = element_id(x) OR 'v10' = element_id(x) RETURN x.n AS v`;

    expect(query(g, q).map((r) => r.v)).toEqual([4, 10]);
    expect(calls()).toBe(2);
  });

  test('a parenthesized group flattens, since a same-operator run does not nest', () => {
    const g = fixture();
    const calls = spyGetVertexById(g);
    const q =
      `MATCH (x:P) WHERE (element_id(x) = 'v4' OR element_id(x) = 'v10') ` +
      `OR element_id(x) = 'v22' RETURN x.n AS v`;

    expect(query(g, q).length).toBe(3);
    expect(calls()).toBe(3);
  });
});

describe('GQL id-list seed: boundaries that could return the wrong rows', () => {
  test('a miss contributes nothing and does not stop the hits', () => {
    const g = fixture();
    const calls = spyGetVertexById(g);
    const q = `MATCH (x:P) WHERE element_id(x) IN ['v4', 'nope', 'v10'] RETURN x.n AS v`;

    expect(query(g, q).map((r) => r.v)).toEqual([4, 10]);
    expect(calls()).toBe(3);
  });

  test('every id missing answers empty, not everything', () => {
    const g = fixture();

    expect(query(g, `MATCH (x:P) WHERE element_id(x) IN ['no', 'nope'] RETURN x.n AS v`)).toEqual(
      [],
    );
  });

  test('an EMPTY list matches nothing', () => {
    // The spy is BLIND here and the comment is the point: an empty seed and a full scan both make
    // zero `getVertexById` calls, so this case cannot witness the route. What it pins is the
    // ANSWER — an empty `IN` must match NOTHING, and a seed that fell through to "no hint, scan
    // everything" on an empty list would return all 20 `P` rows.
    const g = fixture();

    expect(query(g, `MATCH (x:P) WHERE element_id(x) IN [] RETURN x.n AS v`)).toEqual([]);
  });

  test('a duplicate id yields ONE row, not two', () => {
    // The consumer builds a Set, so this holds structurally rather than by luck; a mutant
    // returning an array would double the row.
    const g = fixture();

    expect(query(g, `MATCH (x:P) WHERE element_id(x) IN ['v4', 'v4'] RETURN x.n AS v`)).toEqual([
      { v: 4 },
    ]);
  });

  test('a non-string entry is skipped, and the string entries still seed', () => {
    // Skipping is CORRECT and not merely safe: `element_id` yields a string, so no vertex can
    // have a numeric id and a number in the list can match nothing.
    const g = fixture();
    const calls = spyGetVertexById(g);
    const q = `MATCH (x:P) WHERE element_id(x) IN ['v4', 5, true, null] RETURN x.n AS v`;

    expect(query(g, q)).toEqual([{ v: 4 }]);
    expect(calls()).toBe(1);
  });

  test('the LABEL still filters the seeded rows — the seed is a superset, re-validated', () => {
    // This is the soundness mechanism the whole item rests on: a GQL seed hint produces a
    // SUPERSET which `matchNode` and the residual WHERE then re-check. `v4` is labelled `P`, so
    // seeding it under `(x:Q)` must yield nothing.
    const g = fixture();
    const calls = spyGetVertexById(g);

    expect(query(g, `MATCH (x:Q) WHERE element_id(x) IN ['v4', 'v5'] RETURN x.n AS v`)).toEqual([
      { v: 5 },
    ]);
    expect(calls()).toBe(2);
  });

  test('an AND conjunct alongside the id list still applies', () => {
    const g = fixture();
    const calls = spyGetVertexById(g);
    const q = `MATCH (x:P) WHERE element_id(x) IN ['v4', 'v10'] AND x.n > 5 RETURN x.n AS v`;

    expect(query(g, q)).toEqual([{ v: 10 }]);
    expect(calls()).toBe(2);
  });

  test('the seeded rows still drive a hop', () => {
    const g = fixture();
    const calls = spyGetVertexById(g);
    const q =
      `MATCH (x:P)-[:KNOWS]->(y) WHERE element_id(x) IN ['v0', 'v2'] ` +
      `RETURN y.n AS v ORDER BY v`;

    expect(query(g, q)).toEqual([{ v: 2 }, { v: 4 }]);
    expect(calls()).toBe(2);
  });
});

describe('GQL id-list seed: what it must DECLINE', () => {
  // Every case here asserts ZERO lookups. A seed may only ever produce a superset of the
  // matches, so each of these would be a WRONG ANSWER rather than a slow one.

  test('a NEGATED id list does not seed', () => {
    const g = fixture();
    const calls = spyGetVertexById(g);
    const q = `MATCH (x:P) WHERE NOT element_id(x) IN ['v4', 'v10'] RETURN x.n AS v`;
    const rows = query(g, q);

    expect(rows.length).toBe(18);
    expect(rows.some((r) => r.v === 4)).toBe(false);
    expect(calls()).toBe(0);
  });

  test('an OR with one non-id branch does not seed', () => {
    // `element_id(x) = 'v4' OR x.n = 6` selects v6, which an id-only seed would MISS. One
    // non-conforming branch has to give up the whole chain.
    const g = fixture();
    const calls = spyGetVertexById(g);
    const q = `MATCH (x:P) WHERE element_id(x) = 'v4' OR x.n = 6 RETURN x.n AS v ORDER BY v`;

    expect(query(g, q)).toEqual([{ v: 4 }, { v: 6 }]);
    expect(calls()).toBe(0);
  });

  test('an OR across TWO variables does not seed', () => {
    const g = fixture();
    const calls = spyGetVertexById(g);
    const q =
      `MATCH (x:P), (y:Q) WHERE element_id(x) = 'v4' OR element_id(y) = 'v5' ` +
      `RETURN count(*) AS c`;

    expect(query(g, q)).toEqual([{ c: 39 }]);
    expect(calls()).toBe(0);
  });

  test('an id INEQUALITY does not seed', () => {
    const g = fixture();
    const calls = spyGetVertexById(g);
    const q = `MATCH (x:P) WHERE element_id(x) <> 'v4' RETURN count(*) AS c`;

    expect(query(g, q)).toEqual([{ c: 19 }]);
    expect(calls()).toBe(0);
  });

  test('a PROPERTY IN list is untouched by this change', () => {
    const g = fixture();
    const calls = spyGetVertexById(g);

    expect(query(g, `MATCH (x:P) WHERE x.n IN [4, 10] RETURN x.n AS v`).length).toBe(2);
    expect(calls()).toBe(0);
  });

  test('an EDGE id list answers correctly even though this seeds only nodes', () => {
    const g = fixture();
    const q = `MATCH ()-[r:KNOWS]->() WHERE element_id(r) IN ['e0'] RETURN r.w AS v`;

    expect(query(g, q)).toEqual([{ v: 1 }]);
  });
});
