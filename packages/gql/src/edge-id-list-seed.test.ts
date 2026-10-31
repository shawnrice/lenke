import { describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import { query } from './index.js';

/**
 * Item 1316: `element_id(r) IN [...]` and `element_id(r) = a OR element_id(r) = b` on a REL
 * variable pin the hop to the SET of those edges' endpoints, where item 621 pinned only the
 * single `=`.
 *
 * The id-list twin of item 1315, one level up, and it needed almost no code for a reason worth
 * recording: `collectHints` keys hints by variable with REL variables included, so item 1315's
 * `idIn` hint was already being collected for `element_id(r) IN [...]` and then DROPPED by
 * `pinFor`, which filtered for `kind === 'id'`. Exactly the shape item 621 itself had to fix —
 * collected, then discarded.
 *
 * Measured at 200,000 vertices / 199,999 edges:
 *
 *     = one edge id             0.02447 ms   already pinned at item 621
 *     IN three ids   30.17316 -> 0.05978      505x
 *     OR-chain       40.23598 -> 0.06991      576x
 *
 * ROUTE ASSERTIONS, not rows: an edge pin is answer-equivalent, so a version that declined and
 * drove the whole hop returns exactly these rows. Two instruments, because one is not enough —
 * {@link spyGetEdgeById} shows the hint was produced and resolved, and {@link spyFullScan} shows
 * the resulting seek was actually TAKEN rather than resolved and then declined at the
 * `seekIsWorthIt` gate. Item 1315 learned that distinction the hard way: a mis-reported candidate
 * count survived its entire test file until the scan-side spy was added.
 */
const spyGetEdgeById = (g: Graph): (() => number) => {
  let calls = 0;
  const real = g.getEdgeById;

  (g as unknown as { getEdgeById: typeof real }).getEdgeById = (id: string) => {
    calls += 1;

    return real(id);
  };

  return () => calls;
};

/**
 * Counts the vertices actually PULLED from the map iterator — the route a declined pin falls
 * through to.
 *
 * Counting pulls rather than calls to `values()`, which is what item 1315's version did and is
 * the weaker instrument: `candidateVertices` is a GENERATOR, so `values()` runs when the iterator
 * is created, and a fast path can create one and then abandon it. Zero pulls is "the graph was
 * never walked", which is the claim these tests actually want to make.
 */
const spyFullScan = (g: Graph): (() => number) => {
  let pulled = 0;
  const map = g.verticesById;
  const real = map.values.bind(map);

  (map as unknown as { values: () => IterableIterator<Vertex> }).values = () => {
    const inner = real();

    return {
      [Symbol.iterator]() {
        return this;
      },
      next() {
        const step = inner.next();

        if (!step.done) {
          pulled += 1;
        }

        return step;
      },
    } as IterableIterator<Vertex>;
  };

  return () => pulled;
};

/** 120, so a 3-id pin clears the selectivity gate — see {@link THRESHOLD_NOTE}. */
const N = 120;

/**
 * WHY 120 VERTICES AND NOT 12, measured rather than chosen to make a test pass.
 *
 * A pin is only taken when it is at least `SEEK_MAX_FRACTION` (1/8) selective against the scan it
 * replaces, which is correct — pinning 2 vertices out of 12 is not worth a seek. Bisected on this
 * exact shape, counting vertices pulled:
 *
 *     ids=1   never scans at any size
 *     ids=2   scans while n <= 16, clean from n = 17
 *     ids=3   scans while n <= 24, clean from n = 32
 *
 * So the rule is `|ids| < |V| / 8`, and a 12-vertex fixture puts a 2- or 3-id list BELOW the
 * threshold, where the engine is right to scan. The single-`=` pin clears it at any size because
 * item 621's hint reports a count of 0 or 1.
 *
 * This is why the route assertions below sit on a fixture of 120: at that size a 3-id pin is 40x
 * selective and the gate is not what is being tested. Had the fixture stayed at 12, the only way
 * to make these pass would have been to delete the assertions.
 */
const THRESHOLD_NOTE = true;

/**
 * A chain of {@link N} vertices plus a FORK: `e-fork-a` and `e-fork-b` both leave `v0`, so two
 * edge ids can share an endpoint. That is what makes the `Set` in `edgeEndSetFrom` do real work
 * rather than merely guard against a repeated id, and nothing else in the fixture exercises it.
 */
const fixture = (): Graph => {
  const g = new Graph();
  const at = (id: string): NonNullable<ReturnType<Graph['getVertexById']>> => {
    const v = g.getVertexById(id);

    if (!v) {
      throw new Error(`fixture is broken: no vertex ${id}`);
    }

    return v;
  };

  for (let i = 0; i < N; i++) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } });
  }

  for (let i = 0; i + 1 < N; i++) {
    g.addEdge({
      id: `e${i}`,
      from: at(`v${i}`),
      to: at(`v${i + 1}`),
      labels: ['KNOWS'],
      properties: { w: i },
    });
  }

  g.addEdge({ id: 'e-fork-a', from: at('v0'), to: at('v7'), labels: ['KNOWS'], properties: {} });
  g.addEdge({ id: 'e-fork-b', from: at('v0'), to: at('v9'), labels: ['KNOWS'], properties: {} });

  return g;
};

describe('GQL edge-id-list pin: the IN spelling', () => {
  test('the fixture is above the pin selectivity threshold', () => {
    // Guards the premise of every route assertion in this file: a 3-id pin on N vertices must
    // be more than 8x selective, or the engine declines the seek and scans, correctly.
    expect(THRESHOLD_NOTE).toBe(true);
    expect(3).toBeLessThan(N / 8);
  });

  test('three edge ids pin, with exactly three edge lookups and no scan', () => {
    const g = fixture();
    const edges = spyGetEdgeById(g);
    const scans = spyFullScan(g);
    const q =
      `MATCH (a)-[r:KNOWS]->(b) WHERE element_id(r) IN ['e2', 'e5', 'e8'] ` +
      `RETURN a.n AS v ORDER BY v`;

    expect(query(g, q)).toEqual([{ v: 2 }, { v: 5 }, { v: 8 }]);
    expect(edges()).toBeGreaterThan(0);
    expect(scans()).toBe(0);
  });

  test('a single-element IN list pins like the bare `=` does', () => {
    const g = fixture();
    const scans = spyFullScan(g);

    expect(
      query(g, `MATCH (a)-[r:KNOWS]->(b) WHERE element_id(r) IN ['e2'] RETURN a.n AS v`),
    ).toEqual([{ v: 2 }]);
    expect(scans()).toBe(0);
  });

  test('a $param list pins', () => {
    const g = fixture();
    const scans = spyFullScan(g);
    const q = `MATCH (a)-[r:KNOWS]->(b) WHERE element_id(r) IN $ids RETURN a.n AS v ORDER BY v`;

    expect(query(g, q, { ids: ['e1', 'e3'] })).toEqual([{ v: 1 }, { v: 3 }]);
    expect(scans()).toBe(0);
  });
});

describe('GQL edge-id-list pin: the OR spelling is the SAME plan', () => {
  test('the OR chain agrees with the IN spelling and pins', () => {
    const inQ = `MATCH (a)-[r:KNOWS]->(b) WHERE element_id(r) IN ['e2', 'e5'] RETURN a.n AS v ORDER BY v`;
    const orQ =
      `MATCH (a)-[r:KNOWS]->(b) WHERE element_id(r) = 'e2' OR element_id(r) = 'e5' ` +
      `RETURN a.n AS v ORDER BY v`;
    const gi = fixture();
    const go = fixture();
    const scans = spyFullScan(go);

    expect(query(go, orQ)).toEqual(query(gi, inQ));
    expect(scans()).toBe(0);
  });

  test('the reversed operand order pins too', () => {
    const g = fixture();
    const scans = spyFullScan(g);
    const q =
      `MATCH (a)-[r:KNOWS]->(b) WHERE 'e2' = element_id(r) OR 'e5' = element_id(r) ` +
      `RETURN a.n AS v ORDER BY v`;

    expect(query(g, q)).toEqual([{ v: 2 }, { v: 5 }]);
    expect(scans()).toBe(0);
  });
});

describe('GQL edge-id-list pin: both ends, as item 621 requires', () => {
  test('a LABELLED far node is pinned too, not only the near one', () => {
    // Item 621's note: pinning only the near side left the both-labelled spelling 2500x slower
    // than the unlabelled one, because `orient` starts from the FAR node when both carry a
    // label. The list form inherits that from the same `pinFor` call, so it is asserted here
    // rather than assumed.
    const g = fixture();
    const scans = spyFullScan(g);
    const q =
      `MATCH (a:P)-[r:KNOWS]->(b:P) WHERE element_id(r) IN ['e2', 'e5'] ` +
      `RETURN b.n AS v ORDER BY v`;

    expect(query(g, q)).toEqual([{ v: 3 }, { v: 6 }]);
    expect(scans()).toBe(0);
  });

  test('the `in` direction pins the other end', () => {
    const g = fixture();
    const scans = spyFullScan(g);
    const q = `MATCH (a)<-[r:KNOWS]-(b) WHERE element_id(r) IN ['e2', 'e5'] RETURN a.n AS v ORDER BY v`;

    expect(query(g, q)).toEqual([{ v: 3 }, { v: 6 }]);
    expect(scans()).toBe(0);
  });
});

describe('GQL edge-id-list pin: boundaries that could return the wrong rows', () => {
  test('two edges sharing an endpoint yield ONE row for it', () => {
    // `e-fork-a` and `e-fork-b` both leave `v0`. The Set collapses the endpoint; the rows are
    // then distinguished by the edge, so this must be TWO rows for one shared start.
    const g = fixture();
    const q =
      `MATCH (a)-[r:KNOWS]->(b) WHERE element_id(r) IN ['e-fork-a', 'e-fork-b'] ` +
      `RETURN b.n AS v ORDER BY v`;

    expect(query(g, q)).toEqual([{ v: 7 }, { v: 9 }]);
  });

  test('a missing edge id contributes nothing and does not stop the hits', () => {
    const g = fixture();
    const q = `MATCH (a)-[r:KNOWS]->(b) WHERE element_id(r) IN ['e2', 'nope'] RETURN a.n AS v ORDER BY v`;

    expect(query(g, q)).toEqual([{ v: 2 }]);
  });

  test('every edge id missing answers empty, not everything', () => {
    const g = fixture();

    expect(
      query(g, `MATCH (a)-[r:KNOWS]->(b) WHERE element_id(r) IN ['no', 'nope'] RETURN a.n AS v`),
    ).toEqual([]);
  });

  test('an EMPTY list matches nothing', () => {
    const g = fixture();

    expect(query(g, `MATCH (a)-[r:KNOWS]->(b) WHERE element_id(r) IN [] RETURN a.n AS v`)).toEqual(
      [],
    );
  });

  test('a duplicated edge id yields ONE row', () => {
    const g = fixture();

    expect(
      query(g, `MATCH (a)-[r:KNOWS]->(b) WHERE element_id(r) IN ['e2', 'e2'] RETURN a.n AS v`),
    ).toEqual([{ v: 2 }]);
  });

  test('a non-string entry is skipped WITHOUT a lookup, and the strings still pin', () => {
    // The lookup COUNT is the whole assertion, and without it this test is vacuous: mutation
    // showed that admitting a non-string is behaviourally identical, because `getEdgeById(7)` is
    // just a `Map.get` miss and yields the same rows. So the `typeof` guard cannot be defended by
    // an answer — only by the work it avoids.
    //
    // Asserted RELATIVE to a one-id control rather than as an absolute number. A single string id
    // costs FOUR lookups here, not one: both ends of the segment are pinned, and each end is
    // resolved twice (once for `orient`'s estimate, once to seed). That 2x2 is an implementation
    // detail an absolute assertion would pin by accident, whereas "the two non-strings cost
    // nothing" is the actual claim.
    const mixed = fixture();
    const mixedEdges = spyGetEdgeById(mixed);
    const scans = spyFullScan(mixed);
    const only = fixture();
    const onlyEdges = spyGetEdgeById(only);
    const q = `MATCH (a)-[r:KNOWS]->(b) WHERE element_id(r) IN ['e2', 7, null] RETURN a.n AS v`;
    const ctl = `MATCH (a)-[r:KNOWS]->(b) WHERE element_id(r) IN ['e2'] RETURN a.n AS v`;

    expect(query(mixed, q)).toEqual([{ v: 2 }]);
    expect(query(only, ctl)).toEqual([{ v: 2 }]);
    expect(mixedEdges()).toBe(onlyEdges());
    expect(scans()).toBe(0);
  });

  test('the edge TYPE still filters the pinned rows — the pin is a superset', () => {
    const g = fixture();
    const at = (id: string): NonNullable<ReturnType<Graph['getVertexById']>> => {
      const v = g.getVertexById(id);

      if (!v) {
        throw new Error('fixture');
      }

      return v;
    };

    g.addEdge({ id: 'o1', from: at('v1'), to: at('v2'), labels: ['OTHER'], properties: {} });

    const q = `MATCH (a)-[r:KNOWS]->(b) WHERE element_id(r) IN ['e2', 'o1'] RETURN a.n AS v`;

    expect(query(g, q)).toEqual([{ v: 2 }]);
  });

  test('an AND conjunct alongside the edge id list still applies', () => {
    const g = fixture();
    const q =
      `MATCH (a)-[r:KNOWS]->(b) WHERE element_id(r) IN ['e2', 'e5'] AND a.n > 3 ` +
      `RETURN a.n AS v`;

    expect(query(g, q)).toEqual([{ v: 5 }]);
  });
});

describe('GQL edge-id-list pin: what it must DECLINE', () => {
  // Each of these would make the seed a SUBSET and LOSE rows, which is the one direction a seed
  // may never go. They assert the ROWS, since a wrong pin here drops them outright.

  test('an UNDIRECTED hop does not pin — either endpoint can start the walk', () => {
    // Item 620/621's decline: pinning one end of a `both` hop drops the other end's row.
    const g = fixture();
    const q = `MATCH (a)-[r:KNOWS]-(b) WHERE element_id(r) IN ['e2'] RETURN a.n AS v ORDER BY v`;

    expect(query(g, q)).toEqual([{ v: 2 }, { v: 3 }]);
  });

  test('a QUANTIFIED rel does not pin — the variable binds a LIST of edges', () => {
    const g = fixture();
    const q = `MATCH (a)-[r:KNOWS]->{1,2}(b) WHERE element_id(r) IN ['e2'] RETURN count(*) AS c`;

    expect(query(g, q)).toEqual([{ c: 0 }]);
  });

  test('a NEGATED edge id list does not pin', () => {
    const g = fixture();
    const all = query(g, `MATCH (a)-[r:KNOWS]->(b) RETURN count(*) AS c`)[0]?.c;
    const q = `MATCH (a)-[r:KNOWS]->(b) WHERE NOT element_id(r) IN ['e2'] RETURN count(*) AS c`;

    expect(query(g, q)).toEqual([{ c: Number(all) - 1 }]);
  });

  test('an OR mixing an edge id with another predicate does not pin', () => {
    const g = fixture();
    const q =
      `MATCH (a)-[r:KNOWS]->(b) WHERE element_id(r) = 'e2' OR r.w = 5 ` +
      `RETURN a.n AS v ORDER BY v`;

    expect(query(g, q)).toEqual([{ v: 2 }, { v: 5 }]);
  });
});
