import { beforeAll, describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import { side, sideOfVertex } from './executor/shortcuts.js';
import { query } from './index.js';

/**
 * Item 1334: the unfiltered two-hop count reads each middle's OWN adjacency box instead of looking
 * it up by id string.
 *
 * `side(graph, b.id, …)` does `edgesFromByLabel.get(bId)` — a string-keyed `Map.get`, ~190 ns by
 * item 194's measurement — and the loop calls it TWICE per middle, so 200,000 middles cost 400,000
 * string hashes. `Vertex.adjFrom` is a LAZY MEMO over exactly that lookup, so the first access
 * costs the same and every later one is a private-field read.
 *
 * Whole-file A/B, three rounds order-alternated, at 200,000 vertices:
 *
 *     DEG=1   warm 44.255 -> 23.006  1.92x   cold 97.356 -> 81.857  1.19x
 *     DEG=3   warm 44.245 -> 25.053  1.77x   cold 97.264 -> 85.781  1.13x
 *
 * Both the COLD first rep and the WARM median are reported, because crediting a memo for a change
 * is item 1323's recorded mistake. Cold improves too, so there is no first-query cost traded away.
 * Against Gremlin's twin (30.93 / 30.87) the cross-surface gap is not just closed but REVERSED:
 * GQL goes from 1.42-1.46x slower to 1.23-1.35x faster.
 *
 * ⚠️ WHAT THIS FILE CAN AND CANNOT HOLD. The swap is answer-equivalent AND route-equivalent — both
 * helpers return the same number by construction — so a mutant that simply reverts it SURVIVES,
 * and that is correct rather than a coverage gap: there is no behaviour to observe. The real risk
 * is reading the WRONG BOX (`adjFrom` where `adjTo` is meant), which IS a wrong answer, and that
 * is what the equivalence property below pins.
 */

const N = 400;

let g: Graph;
let vs: Vertex[];

beforeAll(() => {
  g = new Graph();

  // Mixed degrees INCLUDING zero, mixed labels, two edge types, and some self-loops: a self-loop
  // sits in BOTH adjacency maps (item 482) and is the case most likely to differ between a
  // graph-keyed lookup and the vertex's own box.
  vs = Array.from({ length: N }, (_, i) =>
    g.addVertex({
      id: `v${i}`,
      labels: i % 3 === 0 ? ['P', 'Q'] : ['P'],
      properties: { k: i % 17 },
    }),
  );

  let e = 0;

  for (let i = 0; i < N; i++) {
    // Degree 0 for one vertex in seven, so `ways === 0` and the empty-box path are both exercised.
    if (i % 7 === 0) {
      continue;
    }

    for (let d = 0; d < i % 4; d++) {
      g.addEdge({
        id: `e${e++}`,
        from: vs[i],
        to: vs[(i * 31 + d) % N],
        labels: [d % 2 === 0 ? 'E' : 'F'],
        properties: {},
      });
    }
  }

  // Self-loops, on a few vertices only.
  for (let i = 0; i < N; i += 50) {
    g.addEdge({ id: `loop${i}`, from: vs[i], to: vs[i], labels: ['E'], properties: {} });
  }
});

describe('sideOfVertex agrees with side on every shape the loop can hand it', () => {
  const TYPES: (string[] | undefined)[] = [undefined, ['E'], ['F'], ['E', 'F'], ['Z']];

  for (const out of [true, false]) {
    for (const types of TYPES) {
      test(`out=${out} types=${types === undefined ? 'any' : types.join('+')}`, () => {
        let compared = 0;

        for (const v of vs) {
          // The two must agree for EVERY vertex, not on a total — a total can agree while two
          // vertices differ in opposite directions.
          expect(sideOfVertex(v, out, types, undefined)).toBe(side(g, v.id, out, types, undefined));
          compared += 1;
        }

        // The loop must actually have run: an empty vertex list would pass every assertion above.
        expect(compared).toBe(N);
      });
    }
  }

  test('they agree with a FAR LABEL too, where both resolve endpoints', () => {
    for (const v of vs) {
      const label = { kind: 'label', name: 'Q' } as Parameters<typeof sideOfVertex>[3];

      expect(sideOfVertex(v, true, ['E'], label)).toBe(side(g, v.id, true, ['E'], label));
      expect(sideOfVertex(v, false, ['E'], label)).toBe(side(g, v.id, false, ['E'], label));
    }
  });

  test('a vertex with NO edges reads zero from both', () => {
    const isolated = g.addVertex({ id: 'lonely', labels: ['P'], properties: {} });

    expect(sideOfVertex(isolated, true, undefined, undefined)).toBe(0);
    expect(side(g, 'lonely', true, undefined, undefined)).toBe(0);
  });
});

describe('the two-hop counts the change serves are unchanged', () => {
  // The answers are the oracle: these shapes all route through `buildTwoHopCount`, and a wrong box
  // or a flipped direction shows up here as a wrong count.
  const CASES: readonly [string, string][] = [
    ['out-out', 'MATCH (a:P)-[:E]->()-[:E]->(c) RETURN count(*) AS c'],
    ['in-in', 'MATCH (a:P)<-[:E]-()<-[:E]-(c) RETURN count(*) AS c'],
    ['out-in', 'MATCH (a:P)-[:E]->()<-[:E]-(c) RETURN count(*) AS c'],
    ['in-out', 'MATCH (a:P)<-[:E]-()-[:E]->(c) RETURN count(*) AS c'],
    ['mixed types', 'MATCH (a:P)-[:E]->()-[:F]->(c) RETURN count(*) AS c'],
    ['labelled end', 'MATCH (a:P)-[:E]->()-[:E]->(c:Q) RETURN count(*) AS c'],
    ['labelled middle', 'MATCH (a:P)-[:E]->(:Q)-[:E]->(c) RETURN count(*) AS c'],
    ['undirected', 'MATCH (a:P)-[:E]-()-[:E]-(c) RETURN count(*) AS c'],
  ];

  for (const [name, q] of CASES) {
    test(`${name} agrees with the enumerated row count`, () => {
      // The ROW form has no count shortcut to take, so it is the independent oracle — the same
      // argument items 1329 and 1330 use.
      const counted = Number(query(g, q, {})[0]?.c);
      const rows = query(g, q.replace(' RETURN count(*) AS c', ' RETURN 1 AS one'), {});

      expect(counted).toBe(rows.length);
      // And non-zero, or the agreement is free: item 1330's vacuity trap, where two arms both
      // returned 0 and the comparison asserted nothing.
      expect(counted).toBeGreaterThan(0);
    });
  }
});
