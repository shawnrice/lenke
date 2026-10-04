import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Verifies the direct `count(*)` shortcuts (edge-bucket size + two-hop degree
// product) against an INDEPENDENT enumeration computed here from the known edge
// list — so it can't be circular with the engine's own matcher.

const N = 30;
// A deterministic KNOWS edge list (includes self-loops and parallel edges).
const EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [1, 2],
  [2, 0],
  [2, 3],
  [3, 3], // self-loop
  [3, 6],
  [6, 9],
  [9, 0],
  [1, 4],
  [4, 7],
  [7, 1],
  [0, 1], // parallel
  [6, 6], // self-loop
  [5, 8],
  [8, 11],
  [11, 5],
  [12, 0],
  [0, 12],
  [6, 3],
];
// Labels: everyone is Person; every third vertex is also Admin.
const isPerson = (): boolean => true;
const isAdmin = (id: number): boolean => id % 3 === 0;

const build = (): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: N }, (_, i) =>
    g.addVertex({
      id: `v${i}`,
      labels: isAdmin(i) ? ['Person', 'Admin'] : ['Person'],
      properties: {},
    }),
  );

  for (const [a, b] of EDGES) {
    g.addEdge({ from: vs[a], to: vs[b], labels: ['KNOWS'], properties: {} });
  }

  return g;
};

const c = (g: Graph, q: string): number => (query(g, q)[0] as { c: number }).c;

// Independent enumeration (homomorphic: nodes may repeat, edges may repeat).
const oneHop = (aOk: (n: number) => boolean, bOk: (n: number) => boolean): number =>
  EDGES.filter(([a, b]) => aOk(a) && bOk(b)).length;

// Count 2-paths e1;e2 where e1's `mid` endpoint equals e2's `mid` endpoint. For a
// forward two-hop the shared vertex is e1.to == e2.from; `sharedIsFrom1` picks
// which end of e1 is shared (a `<-` first segment shares e1.from instead).
const twoHop = (
  aOk: (n: number) => boolean,
  bOk: (n: number) => boolean,
  cOk: (n: number) => boolean,
  sharedIsFrom1 = false,
): number => {
  let count = 0;

  for (const [f1, t1] of EDGES) {
    const [far1, mid1] = sharedIsFrom1 ? [t1, f1] : [f1, t1];

    if (!aOk(far1) || !bOk(mid1)) {
      continue;
    }

    for (const [f2, t2] of EDGES) {
      if (f2 === mid1 && cOk(t2)) {
        count += 1;
      }
    }
  }

  return count;
};

describe('count(*) shortcut correctness (vs independent enumeration)', () => {
  test('1-hop: bare, labeled source, labeled both', () => {
    const g = build();

    expect(c(g, `MATCH ()-[:KNOWS]->() RETURN count(*) AS c`)).toBe(EDGES.length);
    expect(c(g, `MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c`)).toBe(
      oneHop(isPerson, isPerson),
    );
    expect(c(g, `MATCH (a:Admin)-[:KNOWS]->(b:Person) RETURN count(*) AS c`)).toBe(
      oneHop(isAdmin, isPerson),
    );
    expect(c(g, `MATCH (a)-[:KNOWS]->(b:Admin) RETURN count(*) AS c`)).toBe(
      oneHop(isPerson, isAdmin),
    );
  });

  test('2-hop degree product: unlabeled, mid-labeled, start+mid+end labeled', () => {
    const g = build();

    expect(c(g, `MATCH (a)-[:KNOWS]->(b)-[:KNOWS]->(cc) RETURN count(*) AS c`)).toBe(
      twoHop(isPerson, isPerson, isPerson),
    );
    expect(c(g, `MATCH (a)-[:KNOWS]->(b:Admin)-[:KNOWS]->(cc) RETURN count(*) AS c`)).toBe(
      twoHop(isPerson, isAdmin, isPerson),
    );
    expect(
      c(g, `MATCH (a:Person)-[:KNOWS]->(b:Admin)-[:KNOWS]->(cc:Admin) RETURN count(*) AS c`),
    ).toBe(twoHop(isPerson, isAdmin, isAdmin));
  });

  // A label EVERY vertex carries constrains nothing, so the labelled and unlabelled spellings
  // of one question must agree — and, per the repo's equivalent-spellings rule, cost the same.
  // Before `vacuousLabel` only the unlabelled spelling reached the O(1) bucket-size path:
  // on the 200,000-node / 1,000,000-edge cross-engine bench the labelled one took 586ms and
  // the unlabelled one ~0ms, because the labelled walk paid `edge.from.labels.has('Person')`
  // per edge — 88ms of pointer-chasing for a test that was universally true.
  test('a universal label costs nothing and answers the same as no label', () => {
    const g = build();

    // Every vertex here is a Person, so all four spellings are the same question.
    for (const q of [
      `MATCH (a)-[:KNOWS]->(b) RETURN count(*) AS c`,
      `MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c`,
      `MATCH (a)-[:KNOWS]->(b:Person) RETURN count(*) AS c`,
      `MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN count(*) AS c`,
    ]) {
      expect(c(g, q)).toBe(EDGES.length);
    }
  });

  // The other side of the elision: a label only SOME vertices carry must still be tested, and
  // an absent label must not be mistaken for a universal one (its bucket is empty, and
  // `0 === vertexCount` is false for any non-empty graph).
  test('a partial or absent label is still enforced', () => {
    const g = build();

    expect(c(g, `MATCH (a:Admin)-[:KNOWS]->(b) RETURN count(*) AS c`)).toBe(
      oneHop(isAdmin, isPerson),
    );
    expect(c(g, `MATCH (a:Admin)-[:KNOWS]->(b) RETURN count(*) AS c`)).not.toBe(EDGES.length);
    expect(c(g, `MATCH (a:Absent)-[:KNOWS]->(b) RETURN count(*) AS c`)).toBe(0);
    expect(c(g, `MATCH (a)-[:KNOWS]->(b:Absent) RETURN count(*) AS c`)).toBe(0);
  });

  // An EMPTY graph compares `0 === 0`, so every label is trivially vacuous there. It has no
  // edges either, so the O(1) path must answer 0 rather than divide by anything.
  test('an empty graph counts zero through the elided path', () => {
    const g = new Graph();

    expect(c(g, `MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c`)).toBe(0);
    expect(c(g, `MATCH (a)-[:KNOWS]->(b) RETURN count(*) AS c`)).toBe(0);
  });

  // GROUP BY and HAVING were MISSING from the shortcut's guard, and both are WRONG ANSWERS,
  // not slow paths: the shortcut answers one global count, so a grouped count collapses to a
  // single row and a HAVING that should drop the row never runs. Native is right in every one
  // of these; the TS engine shipped wrong. The `gql-conformance` HAVING case did not catch it
  // because it asks a bare node pattern, which has no shortcut and goes through general
  // execution instead.
  test('a grouped count is not collapsed to one global row', () => {
    const g = build();
    const rows = (q: string): number[] => (query(g, q) as { c: number }[]).map((r) => r.c);

    // One row per distinct `a`, each counting that vertex's out-edges — not one row of 20.
    const perSource = rows(`MATCH (a)-[:KNOWS]->(b) RETURN count(*) AS c GROUP BY a`);

    expect(perSource.length).toBeGreaterThan(1);
    expect(perSource.reduce((x, y) => x + y, 0)).toBe(EDGES.length);

    const twoHopGrouped = rows(
      `MATCH (a)-[:KNOWS]->(b)-[:KNOWS]->(cc) RETURN count(*) AS c GROUP BY a`,
    );

    expect(twoHopGrouped.length).toBeGreaterThan(1);
    expect(twoHopGrouped.reduce((x, y) => x + y, 0)).toBe(twoHop(isPerson, isPerson, isPerson));
  });

  test('HAVING can drop the counted row', () => {
    const g = build();
    const run = (q: string): unknown[] => query(g, q);

    // Over the bound, the row survives; over an impossible bound, no rows at all.
    expect(run(`SELECT count(*) AS c FROM MATCH (a)-[:KNOWS]->(b) HAVING count(*) > 1`)).toEqual([
      { c: EDGES.length },
    ]);
    expect(
      run(`SELECT count(*) AS c FROM MATCH (a)-[:KNOWS]->(b) HAVING count(*) > 10000`),
    ).toEqual([]);
    expect(
      run(
        `SELECT count(*) AS c FROM MATCH (a)-[:KNOWS]->(b)-[:KNOWS]->(cc) HAVING count(*) > 10000`,
      ),
    ).toEqual([]);
  });

  // The bare node count had NO shortcut: `detectCountShortcut` handled one and two segments
  // and fell through for zero, so this enumerated every vertex. 91.1ms against native's ~0.0ms
  // on a 200,000-node graph.
  test('a labelled node count counts only that label', () => {
    const g = build();
    const n = (q: string): number => c(g, q);

    expect(n(`MATCH (x) RETURN count(*) AS c`)).toBe(N);
    expect(n(`MATCH (x:Person) RETURN count(*) AS c`)).toBe(N);
    expect(n(`MATCH (x:Admin) RETURN count(*) AS c`)).toBe(
      Array.from({ length: N }, (_, i) => i).filter(isAdmin).length,
    );
    expect(n(`MATCH (x:Absent) RETURN count(*) AS c`)).toBe(0);
    // A multi-label pattern has no single bucket and must fall through to enumeration.
    expect(n(`MATCH (x:Person&Admin) RETURN count(*) AS c`)).toBe(
      Array.from({ length: N }, (_, i) => i).filter(isAdmin).length,
    );
  });

  // THE ASSUMPTION THE SHORTCUT RESTS ON, driven rather than asserted on a fresh graph.
  // Reading `verticesByLabel.get(L).size` is only exact if the index carries no stale entry.
  // Enumeration tolerates one — `candidateVertices` yields the bucket and `matchNode` re-checks
  // each candidate's labels — so a stale EXTRA would be invisible everywhere except here.
  test('a removed vertex and a removed label both leave the count exact', () => {
    const g = new Graph();
    const vs = Array.from({ length: 5 }, (_, i) =>
      g.addVertex({ id: `r${i}`, labels: ['Person'], properties: {} }),
    );

    expect(c(g, `MATCH (x:Person) RETURN count(*) AS c`)).toBe(5);

    g.removeVertex(vs[0]);
    expect(c(g, `MATCH (x:Person) RETURN count(*) AS c`)).toBe(4);
    expect(c(g, `MATCH (x) RETURN count(*) AS c`)).toBe(4);

    vs[1].removeLabel('Person');
    expect(c(g, `MATCH (x:Person) RETURN count(*) AS c`)).toBe(3);
    // Still a vertex, just no longer a Person.
    expect(c(g, `MATCH (x) RETURN count(*) AS c`)).toBe(4);

    vs[2].addLabel('Admin');
    expect(c(g, `MATCH (x:Admin) RETURN count(*) AS c`)).toBe(1);
    expect(c(g, `MATCH (x:Person) RETURN count(*) AS c`)).toBe(3);
  });

  // The GROUPED count, against the GENERAL PATH as the oracle rather than a hand-written
  // expectation. `WHERE true` is rejected by the detector (`m.where !== undefined`) and cannot
  // change which rows match, so it is the same question computed the slow way — the strongest
  // oracle available, since both fast spellings now take the shortcut.
  test('a grouped node count matches the general path exactly', () => {
    const g = new Graph();
    // Deliberately nasty: a missing key, a STORED null (groups with missing), -0 and 0
    // (one group), NaN (groups with itself), a string and a boolean (distinct kinds).
    g.addVertex({ id: 'a', labels: ['P'], properties: { k: 2 } });
    g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    g.addVertex({ id: 'c', labels: ['P'], properties: { k: null } });
    g.addVertex({ id: 'd', labels: ['P'], properties: { k: 2 } });
    g.addVertex({ id: 'e', labels: ['P'], properties: { k: -0 } });
    g.addVertex({ id: 'f', labels: ['P'], properties: { k: 0 } });
    g.addVertex({ id: 'h', labels: ['P'], properties: { k: Number.NaN } });
    g.addVertex({ id: 'i', labels: ['P'], properties: { k: Number.NaN } });
    g.addVertex({ id: 'j', labels: ['P'], properties: { k: 'two' } });
    // A NUMBER and the STRING of that number are DIFFERENT groups. Without this pair the
    // fixture cannot see the type prefix in `valueKey`: plain `String(raw)` unifies -0/0 and
    // NaN on its own, so it passed every other case here.
    g.addVertex({ id: 'k1', labels: ['P'], properties: { k: 7 } });
    g.addVertex({ id: 'k2', labels: ['P'], properties: { k: '7' } });
    g.addVertex({ id: 'l', labels: ['P'], properties: { k: true } });
    g.addVertex({ id: 'm', labels: ['Q'], properties: { k: 9 } });

    const pairs: readonly (readonly [string, string])[] = [
      // implicit grouping
      [
        `MATCH (n:P) RETURN n.k AS a, count(*) AS c`,
        `MATCH (n:P) WHERE true RETURN n.k AS a, count(*) AS c`,
      ],
      // column order follows the projection, not the shortcut
      [
        `MATCH (n:P) RETURN count(*) AS c, n.k AS a`,
        `MATCH (n:P) WHERE true RETURN count(*) AS c, n.k AS a`,
      ],
      // the ISO `LET` + `GROUP BY` spelling — the same question, so the same answer
      [
        `MATCH (n:P) LET a = n.k RETURN a, count(*) AS c GROUP BY a`,
        `MATCH (n:P) WHERE true RETURN n.k AS a, count(*) AS c`,
      ],
      // unlabelled: every vertex, including the Q
      [
        `MATCH (n) RETURN n.k AS a, count(*) AS c`,
        `MATCH (n) WHERE true RETURN n.k AS a, count(*) AS c`,
      ],
    ];

    for (const [fast, oracle] of pairs) {
      expect(query(g, fast)).toEqual(query(g, oracle));
    }

    // And the group total is every matched vertex, once.
    const rows = query(g, `MATCH (n:P) RETURN n.k AS a, count(*) AS c`) as { c: number }[];

    expect(rows.reduce((x, r) => x + r.c, 0)).toBe(12);
  });

  // Shapes the grouped tally cannot compute must fall through, not answer wrongly.
  test('a grouped count declines the shapes it cannot compute', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1, j: 7 } });
    g.addVertex({ id: 'b', labels: ['P'], properties: { k: 1, j: 8 } });

    // HAVING must still filter; ORDER BY must still order; a key that is not a property of
    // the matched node, and a GROUP BY naming something other than the LET, are not this
    // shape at all.
    expect(
      query(g, `SELECT count(*) AS c, n.k AS a FROM MATCH (n:P) HAVING count(*) > 100`),
    ).toEqual([]);
    expect(query(g, `MATCH (n:P) RETURN n.j AS a, count(*) AS c ORDER BY a DESC`)).toEqual([
      { a: 8, c: 1 },
      { a: 7, c: 1 },
    ]);
    expect(query(g, `MATCH (n:P) LET a = n.k + 1 RETURN a, count(*) AS c GROUP BY a`)).toEqual([
      { a: 2, c: 2 },
    ]);
    // A `GROUP BY` that names something OTHER than the LET groups by that instead — here one
    // row per node, not one row per `k`. Both vertices share `k`, which is what makes the two
    // groupings differ at all; with distinct keys the wrong answer is indistinguishable.
    const shared = new Graph();

    shared.addVertex({ id: 's1', labels: ['P'], properties: { k: 1 } });
    shared.addVertex({ id: 's2', labels: ['P'], properties: { k: 1 } });

    expect(query(shared, `MATCH (n:P) LET a = n.k RETURN a, count(*) AS c GROUP BY n`)).toEqual([
      { a: 1, c: 1 },
      { a: 1, c: 1 },
    ]);
    expect(query(shared, `MATCH (n:P) LET a = n.k RETURN a, count(*) AS c GROUP BY a`)).toEqual([
      { a: 1, c: 2 },
    ]);
  });

  test('2-hop with a reversed first segment matches enumeration', () => {
    const g = build();

    // (a)<-[:KNOWS]-(b)-[:KNOWS]->(cc): the shared vertex `b` is e1.from.
    expect(c(g, `MATCH (a)<-[:KNOWS]-(b)-[:KNOWS]->(cc) RETURN count(*) AS c`)).toBe(
      twoHop(isPerson, isPerson, isPerson, true),
    );
  });
});
