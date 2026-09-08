import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/** A connected "road" graph: a ring (one strongly-connected component) + chords. */
const ring = (n: number, chords: number): Graph => {
  const g = new Graph();
  const v = Array.from({ length: n }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: ['Node'], properties: { name: `n${i}` } }),
  );

  for (let i = 0; i < n; i += 1) {
    g.addEdge({ from: v[i], to: v[(i + 1) % n], labels: ['ROAD'], properties: {} });
  }

  // Deterministic pseudo-random chords (xorshift) so the test is stable.
  let x = 0x1234_5678;
  const below = (m: number): number => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;

    return Math.abs(x) % m;
  };

  for (let i = 0; i < chords; i += 1) {
    g.addEdge({ from: v[below(n)], to: v[below(n)], labels: ['ROAD'], properties: {} });
  }

  return g;
};

describe('unbounded var-length + DISTINCT: BFS reachability (no trail-budget fault)', () => {
  // Trail enumeration is exponential here and would exceed TRAIL_BUDGET; the BFS
  // shortcut answers the reachable set directly. A ring reaches every node.
  test('->+ over a 5000-node connected graph completes and returns the reachable set', () => {
    const g = ring(5000, 10_000);

    const rows = query(g, `MATCH (a:Node {name: 'n0'})-[:ROAD]->+(b) RETURN DISTINCT b.name AS n`);
    expect(rows.length).toBe(5000); // every node reachable (n0 too, via the ring cycle)

    const count = query(
      g,
      `MATCH (a:Node {name: 'n0'})-[:ROAD]->+(b) RETURN count(DISTINCT b) AS c`,
    );
    expect(count).toEqual([{ c: 5000 }]);
  });

  test('->* includes the seed; the reachable set is unchanged on a ring', () => {
    const g = ring(3000, 6000);
    const star = query(g, `MATCH (a:Node {name: 'n0'})-[:ROAD]->*(b) RETURN DISTINCT b.name AS n`);
    expect(star.length).toBe(3000);
  });

  // EXISTS { reachability } BFSes instead of enumerating trails — so testing an
  // UNREACHABLE target completes (was: trail-budget fault) and returns false.
  test('EXISTS { ->+ target } completes for reachable and unreachable targets', () => {
    const g = ring(5000, 10_000);
    const reachable = query(
      g,
      `MATCH (a:Node {name: 'n0'}) RETURN EXISTS { (a)-[:ROAD]->+(b:Node {name: 'n2500'}) } AS r`,
    );
    expect(reachable).toEqual([{ r: true }]);

    const unreachable = query(
      g,
      `MATCH (a:Node {name: 'n0'}) RETURN EXISTS { (a)-[:ROAD]->+(b:Node {name: 'nope'}) } AS r`,
    );
    expect(unreachable).toEqual([{ r: false }]);
  });

  // A variable-length relationship may carry a per-hop edge predicate, applied to
  // every edge of the walk (see the byte-identity conformance suite for the
  // execution semantics). Here we only assert it is accepted, not rejected.
  test('var-length relationship accepts a per-hop edge predicate', () => {
    const g = ring(4, 4);
    expect(() => query(g, `MATCH (a)-[e:ROAD WHERE e.w > 5]->{1,4}(b) RETURN b`)).not.toThrow();
  });

  test('a relationship variable on a var-length hop binds the edge-trail LIST', () => {
    // v1 -R(w=5)-> v2 -R(w=7)-> v3. The flat `-[r:R]->{1,2}` spelling binds `r` to the
    // LIST of the walk's edges — identical to the subpath group `((x)-[r:R]->(m)){1,2}`
    // (equivalent spellings must agree) and byte-identical to the Rust engine.
    const g = new Graph();
    const a = g.addVertex({ labels: ['P'] });
    const b = g.addVertex({ labels: ['P'] });
    const c = g.addVertex({ labels: ['P'] });
    g.addEdge({ from: a, to: b, labels: ['R'], properties: { w: 5 } });
    g.addEdge({ from: b, to: c, labels: ['R'], properties: { w: 7 } });

    const flat = (probe: string): unknown[] => query(g, `MATCH (a:P)-[r:R]->{1,2}(b) ${probe}`);
    const grp = (probe: string): unknown[] =>
      query(g, `MATCH (a:P)((x)-[r:R]->(m)){1,2}(b) ${probe}`);

    for (const probe of ['RETURN size(r) AS x', 'RETURN r[0].w AS x', 'RETURN r.w AS x']) {
      // Order is unspecified without ORDER BY — compare as multisets.
      const norm = (rows: unknown[]): string[] => rows.map((r) => JSON.stringify(r)).sort();
      expect(norm(flat(probe))).toEqual(norm(grp(probe)));
    }

    // Concrete: walk sizes are 1 (v1→v2), 2 (v1→v2→v3), 1 (v2→v3).
    const sizes = flat('RETURN size(r) AS x').map((r) => (r as { x: number }).x);

    expect(sizes.sort()).toEqual([1, 1, 2]);
    // A bare property read on the edge LIST is null (not an error) in both engines.
    expect(flat('RETURN r.w AS x')).toEqual([{ x: null }, { x: null }, { x: null }]);
  });
});

describe('quantifier upper bound', () => {
  // `{0,0}` = exactly zero hops → only the start node. Regression: the emit condition
  // checked only the lower bound, so the unconditionally-generated first hop leaked
  // through and `{0,0}` behaved like `{0,1}` (diverging from the native engine).
  test('{0,0} matches exactly zero hops (the start node only)', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['N'], properties: { name: 'a' } });
    const b = g.addVertex({ id: 'b', labels: ['N'], properties: { name: 'b' } });
    g.addEdge({ from: a, to: b, labels: ['R'], properties: {} });

    expect(query(g, "MATCH (a:N {name:'a'})-[:R]->{0,0}(b) RETURN b.name AS n ORDER BY n")).toEqual(
      [{ n: 'a' }],
    );
    // sanity: {0,1} still includes the 1-hop neighbour.
    expect(query(g, "MATCH (a:N {name:'a'})-[:R]->{0,1}(b) RETURN b.name AS n ORDER BY n")).toEqual(
      [{ n: 'a' }, { n: 'b' }],
    );
  });
});
