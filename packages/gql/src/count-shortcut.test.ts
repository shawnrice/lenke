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

  test('2-hop with a reversed first segment matches enumeration', () => {
    const g = build();

    // (a)<-[:KNOWS]-(b)-[:KNOWS]->(cc): the shared vertex `b` is e1.from.
    expect(c(g, `MATCH (a)<-[:KNOWS]-(b)-[:KNOWS]->(cc) RETURN count(*) AS c`)).toBe(
      twoHop(isPerson, isPerson, isPerson, true),
    );
  });
});
