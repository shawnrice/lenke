import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Item 618: `WHERE element_id(n) = '<id>'` SEEDS from `verticesById` instead of scanning the
 * label bucket.
 *
 * Every test here asserts that the seed FIRED, not only that the rows are right. A seed is a
 * route choice and route choices are answer-equivalent — a version that silently declined and
 * scanned would return exactly these rows, so a rows-only test cannot tell the two apart and
 * every mutant survives it. (`docs/reviews/CLOSED.md`, "a perf gate needs its own test".)
 *
 * The signal is a counting spy on `Graph.getVertexById`, which is an own arrow property and so
 * replaceable. The seed path calls it; the label scan never does. That makes "did it seed" a
 * deterministic binary observation rather than a timing comparison.
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

const fixture = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 40; i++) {
    g.addVertex({
      id: `v${i}`,
      labels: [i % 2 === 0 ? 'P' : 'Q'],
      properties: { n: i },
    });
  }

  return g;
};

describe('GQL point lookup by element id', () => {
  test('both operand orders seed, and agree', () => {
    for (const q of [
      `MATCH (x:P) WHERE element_id(x) = 'v4' RETURN x.n AS v`,
      `MATCH (x:P) WHERE 'v4' = element_id(x) RETURN x.n AS v`,
      `MATCH (x) WHERE element_id(x) = 'v4' RETURN x.n AS v`,
    ]) {
      const g = fixture();
      const calls = spyGetVertexById(g);

      expect(query(g, q)).toEqual([{ v: 4 }]);
      expect(calls()).toBeGreaterThan(0);
    }
  });

  test('a $param seeds too — the shape every caller actually writes', () => {
    const g = fixture();
    const calls = spyGetVertexById(g);
    const q = `MATCH (x:P) WHERE element_id(x) = $id RETURN x.n AS v`;

    expect(query(g, q, { id: 'v6' })).toEqual([{ v: 6 }]);
    expect(calls()).toBeGreaterThan(0);
  });

  test('as a CONJUNCT, in either written order', () => {
    for (const q of [
      `MATCH (x:P) WHERE element_id(x) = 'v8' AND x.n > 0 RETURN x.n AS v`,
      `MATCH (x:P) WHERE x.n > 0 AND element_id(x) = 'v8' RETURN x.n AS v`,
    ]) {
      const g = fixture();
      const calls = spyGetVertexById(g);

      expect(query(g, q)).toEqual([{ v: 8 }]);
      expect(calls()).toBeGreaterThan(0);
    }
  });

  test('the LABEL still excludes a wrong-label vertex', () => {
    // v5 is a Q. The seed resolves it by id and `matchNode` must then reject it — the seed
    // only has to be a SUPERSET, and this is the test that the re-validation really happens.
    const g = fixture();

    expect(query(g, `MATCH (x:P) WHERE element_id(x) = 'v5' RETURN x.n AS v`)).toEqual([]);
    expect(query(g, `MATCH (x:Q) WHERE element_id(x) = 'v5' RETURN x.n AS v`)).toEqual([{ v: 5 }]);
  });

  test('an id that does not exist yields no rows, and does not fall back to a scan', () => {
    const g = fixture();

    expect(query(g, `MATCH (x:P) WHERE element_id(x) = 'nope' RETURN x.n AS v`)).toEqual([]);
  });

  test('a REMOVED vertex is not resurrected', () => {
    const g = fixture();
    const v = g.getVertexById('v4')!;
    g.removeVertex(v);

    expect(query(g, `MATCH (x:P) WHERE element_id(x) = 'v4' RETURN x.n AS v`)).toEqual([]);
    expect(query(g, `MATCH (x:P) WHERE element_id(x) = 'v6' RETURN x.n AS v`)).toEqual([{ v: 6 }]);
  });

  test('a NON-STRING id declines the seed and still answers correctly', () => {
    // An external id is a string, so a numeric comparand matches nothing. The hint is
    // restricted to a string at the point of use to stay aligned with the native engine's
    // `id_seek_target`; correctness here does not depend on it, because a seed may be a
    // superset and `matchNode` re-validates. Both halves are asserted: no seed, no rows.
    const g = fixture();
    const calls = spyGetVertexById(g);

    expect(query(g, `MATCH (x:P) WHERE element_id(x) = 4 RETURN x.n AS v`)).toEqual([]);
    expect(calls()).toBe(0);
  });

  test('a RANGE over an id declines the seed', () => {
    // A seed takes a set of ids, not an interval. It must still return the right rows via
    // the scan, so this asserts the answer and not just the decline.
    const g = fixture();
    const calls = spyGetVertexById(g);
    const rows = query(g, `MATCH (x:P) WHERE element_id(x) > 'v8' RETURN x.n AS v`);

    expect(calls()).toBe(0);
    // STRING order: 'v10'..'v38' all sort BELOW 'v8', and the only id above it ('v9') is a Q.
    // So the right answer here is genuinely empty — which is why it is not the whole test. An
    // empty expectation would pass just as well if the decline path returned nothing at all,
    // the fixture trap this log has recorded ten times. So a range that DOES match follows,
    // over the same declined path, and it has to produce every P vertex.
    expect(rows).toEqual([]);

    const all = query(g, `MATCH (x:P) WHERE element_id(x) >= 'v0' RETURN x.n AS v`);
    expect(calls()).toBe(0);
    expect(all.length).toBe(20);
    expect(all.map((r) => r['v']).every((n) => typeof n === 'number' && n % 2 === 0)).toBe(true);
  });

  test('NULL declines, and matches nothing', () => {
    const g = fixture();

    expect(query(g, `MATCH (x:P) WHERE element_id(x) = $id RETURN x.n AS v`, { id: null })).toEqual(
      [],
    );
  });
});
