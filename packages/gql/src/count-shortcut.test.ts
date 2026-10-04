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
      // `n` exists so an endpoint PREDICATE has something to be true or false about. Without it
      // every `b.n > 3` compares against NULL, drops every row, and a differential test against
      // the general path passes trivially with 0 === 0 — proving nothing. The label and edge
      // counts the other tests assert are unaffected by a property.
      properties: { n: i },
    }),
  );

  for (const [a, b] of EDGES) {
    // `w` likewise, for a predicate on the edge variable.
    g.addEdge({ from: vs[a], to: vs[b], labels: ['KNOWS'], properties: { w: a } });
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

  // A clause WHERE on the endpoints, tallied instead of enumerated. Tested against the GENERAL
  // PATH as oracle: adding `ORDER BY c` makes the detector decline (its projection guard rejects
  // ordering), so the same question is computed the slow way — the strongest oracle available.
  test('a filtered 1-hop count matches the general path', () => {
    const g = build();
    const pairs = (pred: string): readonly [string, string] => [
      `MATCH (a:Person)-[r:KNOWS]->(b) WHERE ${pred} RETURN count(*) AS c`,
      `MATCH (a:Person)-[r:KNOWS]->(b) WHERE ${pred} RETURN count(*) AS c ORDER BY c`,
    ];

    for (const pred of [
      // the far endpoint, the source, and the EDGE variable
      `b.n > 3`,
      `a.n > 3`,
      `r.w >= 0`,
      // both ends at once, and a label on top of the predicate
      `a.n > 1 AND b.n < 20`,
      `b.n IS NOT NULL`,
      // a key no vertex has: the comparison is NULL, which drops the row (three-valued)
      `b.missing > 1`,
      // a label only some vertices carry, so the elision must NOT fire
      `a.n >= 0`,
    ]) {
      const [fast, oracle] = pairs(pred);

      expect(query(g, fast)).toEqual(query(g, oracle));
    }
  });

  // A non-boolean in a truth context is a DATA EXCEPTION, not a truthy coercion, and the
  // shortcut must raise it exactly as the general path does — byte-identity is about which
  // queries raise, not only about which rows come back.
  //
  // `asTruth` is what throws, so writing the filter as `if (pred.fn(env))` would quietly count
  // rows instead. Nothing else in this file catches that: a WHERE can only evaluate to true,
  // false or NULL, and on those three a truthy test agrees with `=== true`. It takes a
  // PARAMETER to reach the fourth case, because a bare non-boolean is rejected at parse time
  // while a param's value is only known at evaluation.
  test('a non-boolean WHERE raises on the tally path too', () => {
    const g = build();
    const q = `MATCH (a:Person)-[:KNOWS]->(b) WHERE $p RETURN count(*) AS c`;

    expect(() => query(g, q, { p: 5 })).toThrow(/boolean is required/);
    // …and a boolean param still works, so the throw is about the VALUE, not the shape.
    expect(query(g, q, { p: true })).toEqual([{ c: EDGES.length }]);
    expect(query(g, q, { p: false })).toEqual([{ c: 0 }]);
  });

  // REGRESSION. An untyped relationship (`-[]->`) means EVERY type, and the filtered tally used
  // to read that as "no types" and answer 0 — for any predicate, over any graph, while the
  // unfiltered spelling of the same query answered correctly. Shipped, then caught by the
  // start-only differential. The filter is what must still be honoured here, so each case is
  // checked against the general path AND against the known edge list.
  test('an untyped relationship in a filtered count means every type, not none', () => {
    const g = build();

    for (const pred of [`a.n > 3`, `b.n > 3`, `r.w >= 0`, `a.n > 1000`]) {
      const q = `MATCH (a:Person)-[r]->(b) WHERE ${pred} RETURN count(*) AS c`;

      expect(query(g, q)).toEqual(query(g, `${q} ORDER BY c`));
    }

    // Every edge in the fixture is a KNOWS, so an untyped walk must agree with the typed one
    // and with the independent enumeration — not answer zero.
    expect(c(g, `MATCH (a:Person)-[]->(b) WHERE a.n >= 0 RETURN count(*) AS c`)).toBe(EDGES.length);
    expect(c(g, `MATCH (a:Person)-[]->(b) WHERE a.n > 3 RETURN count(*) AS c`)).toBe(
      oneHop((n) => n > 3, isPerson),
    );
    expect(c(g, `MATCH (a:Person)-[]->(b) WHERE b.n > 3 RETURN count(*) AS c`)).toBe(
      oneHop(isPerson, (n) => n > 3),
    );
  });

  // A predicate that reads only the START node is counted per-VERTEX (evaluate once, add that
  // vertex's degree) instead of per-edge. Four things can go wrong, and each has a case here.
  test('a start-only filtered count matches the general path', () => {
    const g = build();

    for (const pat of [
      `(a:Person)-[:KNOWS]->(b)`,
      `(a:Person)<-[:KNOWS]-(b)`,
      // `r` named but unread: the slot must still be recognized as unused, or the per-vertex
      // path is never reached for this spelling.
      `(a:Person)-[r:KNOWS]->(b)`,
      // no label on the start at all
      `(a)-[:KNOWS]->(b)`,
      // a label only SOME vertices carry, so the vacuous-label elision must not fire and the
      // per-vertex walk has to apply the label itself
      `(a:Admin)-[:KNOWS]->(b)`,
    ]) {
      for (const pred of [`a.n > 3`, `a.n >= 0`, `a.n > 1000`, `a.missing > 1`, `a.n = 3`]) {
        const q = `MATCH ${pat} WHERE ${pred} RETURN count(*) AS c`;

        expect(query(g, q)).toEqual(query(g, `${q} ORDER BY c`));
      }
    }
  });

  // THE divergence this path is guarded against. `asTruth` throws on a non-boolean, so the
  // per-vertex walk must visit exactly the vertices the per-edge walk would have — a vertex
  // with no matching edge must never reach the predicate, or a graph with nodes but no edges
  // would RAISE where the general path returns 0.
  test('a start-only predicate never evaluates a vertex with no matching edge', () => {
    const noEdges = new Graph();

    noEdges.addVertex({ id: 'p', labels: ['Person'], properties: { n: 1 } });

    const q = `MATCH (a:Person)-[:KNOWS]->(b) WHERE a.n RETURN count(*) AS c`;

    // `a.n` is a NUMBER in a truth context: a data exception for any vertex reached.
    expect(query(noEdges, q)).toEqual([{ c: 0 }]);
    expect(query(noEdges, `${q} ORDER BY c`)).toEqual([{ c: 0 }]);

    // The build() fixture has 30 Person vertices but only some with outgoing KNOWS edges, so
    // this also pins that the ones without are skipped rather than raising first.
    const g = build();

    expect(() => query(g, q)).toThrow(/boolean is required/);
    expect(() => query(g, `${q} ORDER BY c`)).toThrow(/boolean is required/);
  });

  // The per-vertex path adds a whole DEGREE without looking at any far endpoint, so it is only
  // available when the far endpoint is unconstrained. A label there must send the query back to
  // the per-edge tally. Found by mutation: dropping the `pb === undefined` guard survived every
  // other case in this file, because none of them put a label on the far node AND a start-only
  // predicate at the same time.
  test('a start-only predicate with a labelled far endpoint still filters the far end', () => {
    const g = build();

    for (const pred of [`a.n > 3`, `a.n >= 0`]) {
      for (const far of [`(b:Admin)`, `(b:Person)`, `(b)`]) {
        const q = `MATCH (a:Person)-[:KNOWS]->${far} WHERE ${pred} RETURN count(*) AS c`;

        expect(query(g, q)).toEqual(query(g, `${q} ORDER BY c`));
      }
    }

    // `Admin` is every third vertex, so the labelled far end is a strictly smaller count than
    // the unlabelled one — without that the two spellings would be indistinguishable.
    expect(c(g, `MATCH (a:Person)-[:KNOWS]->(b:Admin) WHERE a.n >= 0 RETURN count(*) AS c`)).toBe(
      oneHop(isPerson, isAdmin),
    );
    expect(
      c(g, `MATCH (a:Person)-[:KNOWS]->(b:Admin) WHERE a.n >= 0 RETURN count(*) AS c`),
    ).toBeLessThan(EDGES.length);
  });

  // The other half of the degree-0 guard. A vertex absent from the adjacency index can't be
  // reached at all, but one that HAS edges of a DIFFERENT type is in the index with a matching
  // degree of zero — and must still not reach the predicate. Found by mutation: removing the
  // `deg === 0` check survived, because the no-edge fixture leaves the index empty so the loop
  // body never runs.
  test('a vertex whose only edges are of another type never reaches the predicate', () => {
    const g = new Graph();
    const v0 = g.addVertex({ id: 'z0', labels: ['Person'], properties: { n: 1 } });
    const v1 = g.addVertex({ id: 'z1', labels: ['Person'], properties: { n: 2 } });

    // Only a LIKES edge exists, so both vertices are in the adjacency index while the KNOWS
    // degree of each is 0.
    g.addEdge({ from: v0, to: v1, labels: ['LIKES'], properties: {} });

    // `a.n` is a NUMBER in a truth context: a data exception for any vertex the predicate
    // reaches. No KNOWS edge exists, so it must reach none.
    const q = `MATCH (a:Person)-[:KNOWS]->(b) WHERE a.n RETURN count(*) AS c`;

    expect(query(g, q)).toEqual([{ c: 0 }]);
    expect(query(g, `${q} ORDER BY c`)).toEqual([{ c: 0 }]);

    // …and the LIKES query, which does have an edge, still raises — so the test above passes
    // because of the type filter, not because the predicate stopped throwing.
    const likes = `MATCH (a:Person)-[:LIKES]->(b) WHERE a.n RETURN count(*) AS c`;

    expect(() => query(g, likes)).toThrow(/boolean is required/);
    expect(() => query(g, `${likes} ORDER BY c`)).toThrow(/boolean is required/);
  });

  // Summing per-type bucket sizes double-counts an edge carrying two of the types, so the
  // per-vertex path must decline when that is possible. Three spellings of the same question.
  test('a start-only count over multi-type edges counts an edge once', () => {
    const g = new Graph();
    const v0 = g.addVertex({ id: 'm0', labels: ['Person'], properties: { n: 5 } });
    const v1 = g.addVertex({ id: 'm1', labels: ['Person'], properties: { n: 6 } });

    // ONE edge carrying BOTH types — it sits in two buckets.
    g.addEdge({ from: v0, to: v1, labels: ['KNOWS', 'LIKES'], properties: {} });

    for (const rel of [`[:KNOWS|LIKES]`, `[]`, `[:KNOWS]`]) {
      const q = `MATCH (a:Person)-${rel}->(b) WHERE a.n > 0 RETURN count(*) AS c`;

      expect(query(g, q)).toEqual(query(g, `${q} ORDER BY c`));
      expect(c(g, q)).toBe(1);
    }
  });

  // The relaxation is for the ONE-segment shape only. A WHERE on any other shape must make the
  // detector decline, not be silently ignored — ignoring it would count every edge.
  test('a WHERE on a shape the tally cannot compute is declined', () => {
    const g = build();

    // Zero segments (a node count) and two segments: both must honour the filter.
    expect(c(g, `MATCH (x:Person) WHERE x.n > 1000 RETURN count(*) AS c`)).toBe(0);
    expect(c(g, `MATCH (x:Person) WHERE x.n >= 0 RETURN count(*) AS c`)).toBe(N);
    expect(
      c(g, `MATCH (a)-[:KNOWS]->(b)-[:KNOWS]->(cc) WHERE cc.n > 1000 RETURN count(*) AS c`),
    ).toBe(0);
  });

  test('2-hop with a reversed first segment matches enumeration', () => {
    const g = build();

    // (a)<-[:KNOWS]-(b)-[:KNOWS]->(cc): the shared vertex `b` is e1.from.
    expect(c(g, `MATCH (a)<-[:KNOWS]-(b)-[:KNOWS]->(cc) RETURN count(*) AS c`)).toBe(
      twoHop(isPerson, isPerson, isPerson, true),
    );
  });
});
