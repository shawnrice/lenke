import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `detectGroupedHopCount` (audit item 142): a grouped count over a hop, which fell to the
// general path — one binding and one row per EDGE, then grouping.
//
// Group order is FIRST-SEEN and observable, so every comparison here is on the row ARRAY in
// order. That is not pedantry: the first version of this walk counted every edge correctly and
// emitted the groups in the wrong ORDER, and only an order-sensitive comparison on a fixture
// where edge INSERTION order differs from walk order could tell.

/** `a`,`b` are sources; `y`,`z`,`w` are targets. Edges inserted out of walk order on purpose. */
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, labels: string[], props: Record<string, unknown>) =>
    g.addVertex({ id, labels, properties: props });

  // Label-bucket order is insertion order, so the general path walks a, then b, then the rest.
  const a = v('a', ['P'], { k: 'ka', n: 1 });
  const b = v('b', ['P'], { k: 'kb', n: 2 });
  const y = v('y', ['P', 'Q'], { k: 'KY', n: 10 });
  const z = v('z', ['P'], { k: 'KZ', n: 20 });

  v('w', ['P'], { k: 'KW', n: 30 }); // no edges at all
  // INSERTED OUT OF ORDER: b's edge first, so the adjacency indexes see z before y.
  g.addEdge({ from: b, to: z, labels: ['T'], properties: {} });
  g.addEdge({ from: a, to: y, labels: ['T'], properties: {} });
  g.addEdge({ from: a, to: y, labels: ['T'], properties: {} }); // PARALLEL
  g.addEdge({ from: a, to: z, labels: ['T'], properties: {} });
  g.addEdge({ from: y, to: y, labels: ['T'], properties: {} }); // SELF-LOOP
  g.addEdge({ from: b, to: y, labels: ['S'], properties: {} }); // a second type

  return g;
};

/** The same question through the general grouping path (a second `LET` makes four clauses). */
const viaGeneral = (g: Graph, q: string) => {
  const i = q.indexOf(' RETURN ');

  return query(g, `${q.slice(0, i)} LET _z = 1${q.slice(i)}`);
};

const bothWays = (g: Graph, q: string) => [query(g, q), viaGeneral(g, q)] as const;

/** A vertex that must exist, so the fixture's edges can be typed. */
const at = (g: Graph, id: string) => {
  const v = g.getVertexById(id);

  if (v === null) {
    throw new Error(`fixture lost ${id}`);
  }

  return v;
};

describe('grouped hop count', () => {
  test('keyed on the FAR end, groups and ORDER match the general path', () => {
    const g = build();
    const q = 'MATCH (x:P)-[:T]->(w) RETURN w.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    // Walk order is a (→y, →y, →z), then b (→z), then y (→y). So KY is seen first even though
    // the indexes hold z first — which is exactly what the first version of this walk got
    // wrong.
    expect(fast).toEqual([
      { a: 'KY', c: 3 },
      { a: 'KZ', c: 2 },
    ]);
    expect(fast).toEqual(slow);
  });

  test('keyed on the START end, groups and order match', () => {
    const g = build();
    const q = 'MATCH (x:P)-[:T]->(w) RETURN x.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual([
      { a: 'ka', c: 3 },
      { a: 'kb', c: 1 },
      { a: 'KY', c: 1 },
    ]);
    expect(fast).toEqual(slow);
  });

  test('the LET spelling agrees with the inline one', () => {
    const g = build();
    const q = 'MATCH (x:P)-[:T]->(w) LET a = w.k RETURN a, count(*) AS c GROUP BY a';

    expect(query(g, q)).toEqual(query(g, 'MATCH (x:P)-[:T]->(w) RETURN w.k AS a, count(*) AS c'));
    expect(query(g, q)).toEqual(viaGeneral(g, q));
  });

  test('a PARALLEL edge counts twice and a SELF-LOOP once', () => {
    const g = build();
    const rows = query(g, 'MATCH (x:P)-[:T]->(w) RETURN w.k AS a, count(*) AS c');

    // KY = two parallel a→y plus the y→y self-loop.
    expect(rows).toContainEqual({ a: 'KY', c: 3 });
  });

  test('a start vertex with no edges contributes nothing', () => {
    const g = build();
    const rows = query(g, 'MATCH (x:P)-[:T]->(w) RETURN x.k AS a, count(*) AS c');

    expect(rows).not.toContainEqual({ a: 'KW', c: 0 });
    expect((rows as unknown[]).length).toBe(3);
  });

  test('the FAR label is applied', () => {
    const g = build();
    // `Q` is only on `y`.
    const q = 'MATCH (x:P)-[:T]->(w:Q) RETURN w.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual([{ a: 'KY', c: 3 }]);
    expect(fast).toEqual(slow);
  });

  test('a reversed hop agrees', () => {
    const g = build();
    const q = 'MATCH (x:P)<-[:T]-(w) RETURN w.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual(slow);
  });

  test('an untyped hop counts every type', () => {
    const g = build();
    const q = 'MATCH (x:P)-[]->(w) RETURN w.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    // The S edge b→y joins the six T edges.
    expect(fast).toEqual(slow);
    expect((fast as { c: number }[]).reduce((n, r) => n + r.c, 0)).toBe(6);
  });

  test('a type DISJUNCTION agrees', () => {
    const g = build();
    const q = 'MATCH (x:P)-[:T|S]->(w) RETURN w.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual(slow);
  });

  test('a MULTI-LABEL edge is counted once, not per label', () => {
    const g = build();

    g.addEdge({
      from: at(g, 'a'),
      to: at(g, 'z'),
      labels: ['T', 'S'],
      properties: {},
    });

    // Summing per-type buckets would count it twice, so the walk must fall to per-edge.
    const q = 'MATCH (x:P)-[:T|S]->(w) RETURN x.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual(slow);
  });

  test('a filter on the KEYED end is applied, both spellings', () => {
    const g = build();
    const clause = 'MATCH (x:P)-[:T]->(w) WHERE w.n > 15 RETURN w.k AS a, count(*) AS c';
    const inline = 'MATCH (x:P)-[:T]->(w {k: "KZ"}) RETURN w.k AS a, count(*) AS c';

    expect(query(g, clause)).toEqual([{ a: 'KZ', c: 2 }]);
    expect(query(g, clause)).toEqual(viaGeneral(g, clause));
    expect(query(g, inline)).toEqual([{ a: 'KZ', c: 2 }]);
    expect(query(g, inline)).toEqual(viaGeneral(g, inline));
  });

  test('a filter on the START end with a START key is applied', () => {
    const g = build();
    const q = 'MATCH (x:P)-[:T]->(w) WHERE x.n < 2 RETURN x.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual([{ a: 'ka', c: 3 }]);
    expect(fast).toEqual(slow);
  });

  test('a filter on the OTHER end declines and is still right', () => {
    const g = build();
    // Key on the far end, filter on the start: the walk has no gate for that, so it must
    // decline — and the answer must still be correct.
    const q = 'MATCH (x:P)-[:T]->(w) WHERE x.n < 2 RETURN w.k AS a, count(*) AS c';

    expect(query(g, q)).toEqual(viaGeneral(g, q));
    expect(query(g, q)).toEqual([
      { a: 'KY', c: 2 },
      { a: 'KZ', c: 1 },
    ]);
  });

  test('a far LABEL is applied even when the key is on the START', () => {
    const g = build();
    // The degree walk adds a whole degree, so it cannot apply a far label — it must fall to
    // the per-edge walk. `Q` is only on `y`, whose in-edges are a→y twice and y→y.
    const q = 'MATCH (x:P)-[:T]->(w:Q) RETURN x.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual([
      { a: 'ka', c: 2 },
      { a: 'KY', c: 1 },
    ]);
    // Ignoring the label would give a 3 for `ka` (its whole degree) and a `kb` group.
    expect(fast).toEqual(slow);
    expect(fast).not.toContainEqual({ a: 'ka', c: 3 });
  });

  test('an inline constraint on the NON-keyed end is not dropped', () => {
    const g = build();
    // Key on the start, inline on the far end: the walks apply nothing to the non-keyed end,
    // so this must decline rather than silently ignore the constraint.
    const q = 'MATCH (x:P)-[:T]->(w {k: "KZ"}) RETURN x.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual([
      { a: 'ka', c: 1 },
      { a: 'kb', c: 1 },
    ]);
    expect(fast).toEqual(slow);
  });

  test('TWO segments with a START key decline', () => {
    const g = build();
    // With a far key this declines because the key names the second segment's node; with a
    // START key the name resolves, so only the segment-count guard stops it.
    const q = 'MATCH (x:P)-[:T]->(m)-[:T]->(w) RETURN x.k AS a, count(*) AS c';

    expect(query(g, q)).toEqual(viaGeneral(g, q));
  });

  test('the START-key walk never evaluates the filter on an edgeless vertex', () => {
    const g = build();

    // A vertex with NO edges carrying a NON-BOOLEAN in boolean context. A cross-type
    // comparison does not raise in this engine, but a non-boolean condition does, so this is
    // the discriminator: the general path never evaluates the predicate on an edgeless
    // vertex, so the hop query must NOT raise — while the bare node scan over the same
    // predicate DOES, which proves the fixture can raise at all.
    //
    // This is the raise-parity rule item 139 had to reject a measured 3.1x over.
    for (const id of ['a', 'b', 'y', 'z', 'w']) {
      at(g, id).setProperty('flag', true);
    }

    // TWO kinds of unreached vertex, because they exit the walk at DIFFERENT points:
    //   `bad`  has no edges at all, so the adjacency lookup misses and it never reaches
    //          either check;
    //   `other` has an edge, but of the WRONG TYPE, so only the degree check stops it — this
    //          is the one that pins the gate's position, and item 139 left the same pair.
    const bad = g.addVertex({ id: 'bad', labels: ['P'], properties: { k: 'KB', flag: 'yes' } });
    const sOnly = g.addVertex({ id: 'other', labels: ['P'], properties: { k: 'KO', flag: 'yes' } });

    g.addEdge({ from: sOnly, to: bad, labels: ['S'], properties: {} });

    const outcome = (qq: string): string => {
      try {
        return JSON.stringify(query(g, qq));
      } catch {
        return 'raised';
      }
    };

    // The scan raises — so the non-boolean really is reachable and really does fault.
    expect(outcome('MATCH (x:P) WHERE x.flag RETURN x.k AS a, count(*) AS c')).toBe('raised');

    // The hop must not, and must agree with the general path.
    const q = 'MATCH (x:P)-[:T]->(w) WHERE x.flag RETURN x.k AS a, count(*) AS c';

    expect(outcome(q)).not.toBe('raised');
    expect(outcome(q)).toBe(
      outcome(`${q.slice(0, q.indexOf(' RETURN '))} LET _z = 1${q.slice(q.indexOf(' RETURN '))}`),
    );
  });

  test('an absent group key groups under null rather than dropping', () => {
    const g = build();

    g.addEdge({
      from: at(g, 'a'),
      to: g.addVertex({ id: 'nk', labels: ['P'], properties: { n: 1 } }),
      labels: ['T'],
      properties: {},
    });

    const q = 'MATCH (x:P)-[:T]->(w) RETURN w.k AS a, count(*) AS c';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toContainEqual({ a: null, c: 1 });
    expect(fast).toEqual(slow);
  });

  test('the column order of count and key is preserved', () => {
    const g = build();
    const q = 'MATCH (x:P)-[:T]->(w) RETURN count(*) AS c, w.k AS a';
    const [fast, slow] = bothWays(g, q);

    expect(Object.keys(fast[0] as object)).toEqual(['c', 'a']);
    expect(fast).toEqual(slow);
  });

  test('two segments decline', () => {
    const g = build();
    const q = 'MATCH (x:P)-[:T]->(m)-[:T]->(w) RETURN w.k AS a, count(*) AS c';

    expect(query(g, q)).toEqual(viaGeneral(g, q));
  });

  test('a named rel variable, a BOTH direction and a path variable decline', () => {
    const g = build();

    for (const q of [
      'MATCH (x:P)-[r:T]->(w) RETURN w.k AS a, count(*) AS c',
      'MATCH (x:P)-[:T]-(w) RETURN w.k AS a, count(*) AS c',
      'MATCH p = (x:P)-[:T]->(w) RETURN w.k AS a, count(*) AS c',
    ]) {
      expect(query(g, q)).toEqual(viaGeneral(g, q));
    }
  });
});
