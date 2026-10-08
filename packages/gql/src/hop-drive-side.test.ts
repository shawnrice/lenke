import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { hopDrivesFar } from './executor/hop-projection.js';
import { query } from './index.js';

// Item 232. `filteredHopWalk` always drove the pattern's START, so a one-hop projection whose
// LABEL sits on the far end enumerated every vertex in the graph to find it:
//
//   MATCH (a:A)-[:E]->(f) RETURN f.t      7.5ms   drives the 20,000-vertex `:A` bucket
//   MATCH (f)<-[:E]-(a:A) RETURN f.t    130.2ms   drove all 200,000 — same 20,000 rows
//
// 17.4x for one question written two ways, with no predicate anywhere in it. It now drives
// whichever end enumerates fewer vertices, which took the second spelling to 8.6ms.
//
// THE DECISION IS WHAT THESE TEST. A drive side is answer-preserving — that is the point of it —
// so no result-based test can catch choosing the wrong one, and a mutant that simply never
// switches sides passes every row assertion. Items 167/168 hit that wall with no escape; 172 and
// 173 escaped it by testing an exported decision, which is what `hopDrivesFar` is for.
describe('hopDrivesFar: the decision, directly', () => {
  const g = new Graph();

  // 100 vertices: 10 are `:Few`, 90 are `:Many`, all of them `:All`.
  for (let i = 0; i < 100; i++) {
    g.addVertex({
      id: `v${i}`,
      labels: i < 10 ? ['Few', 'All'] : ['Many', 'All'],
      properties: { k: i },
    });
  }

  const lab = (name: string) => ({ kind: 'label', name }) as const;

  test('the far end wins when its bucket is smaller', () => {
    expect(hopDrivesFar(g, lab('Many'), lab('Few'))).toBe(true);
    expect(hopDrivesFar(g, undefined, lab('Few'))).toBe(true);
    expect(hopDrivesFar(g, lab('All'), lab('Few'))).toBe(true);
  });

  test('the start end keeps the walk when it is smaller or EQUAL', () => {
    expect(hopDrivesFar(g, lab('Few'), lab('Many'))).toBe(false);
    expect(hopDrivesFar(g, lab('Few'), undefined)).toBe(false);

    // A TIE keeps the current side on purpose: the two walks meet rows in different orders, so
    // switching for no gain is churn. This is the single-label fixture that first measured the
    // gap — every vertex carrying the label makes its bucket the whole graph.
    expect(hopDrivesFar(g, lab('All'), lab('All'))).toBe(false);
    expect(hopDrivesFar(g, undefined, lab('All'))).toBe(false);
    expect(hopDrivesFar(g, undefined, undefined)).toBe(false);
  });

  test('a label the walk cannot SEED from never wins', () => {
    // `candidateCount` scores a non-simple label as the whole graph, so the strict comparison
    // also establishes seekability — the far-driven walk enumerates a bucket, and there is no
    // bucket for a disjunction. Without this the walk would silently scan everything while
    // believing it had narrowed.
    const either = { kind: 'or', left: lab('Few'), right: lab('Many') } as const;

    expect(hopDrivesFar(g, lab('Many'), either as never)).toBe(false);
    expect(hopDrivesFar(g, undefined, either as never)).toBe(false);

    // And a label NOTHING carries scores 0, which is smaller than anything — correctly, since
    // enumerating an empty bucket is the cheapest possible walk.
    expect(hopDrivesFar(g, lab('Many'), lab('Nobody'))).toBe(true);
  });
});

// The rows. These cannot catch a wrong SIDE, but they can catch a wrong mirror: the far-driven
// walk resolves the opposite endpoint, applies the labels and predicates to the opposite ends, and
// binds both variables — every one of which is a chance to swap two things that look alike.
describe('the far-driven walk answers what the start-driven one answers', () => {
  const build = (): Graph => {
    const g = new Graph();
    const vs = [];

    // 60 vertices, 10 of them `:Few`. The hop runs Few -> anything, so driving the far end is
    // chosen whenever `:Few` is the far label.
    for (let i = 0; i < 60; i++) {
      vs.push(
        g.addVertex({
          id: `v${i}`,
          labels: i < 10 ? ['Few'] : ['Many'],
          properties: { k: i, t: i % 3 },
        }),
      );
    }

    // Each `:Few` points at three `:Many`, so the far end has a real degree rather than one edge.
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 3; j++) {
        g.addEdge({
          id: `e${i}_${j}`,
          labels: ['E'],
          from: vs[i],
          to: vs[10 + ((i * 3 + j) % 50)],
          properties: {},
        });
      }
    }

    return g;
  };

  const rows = (text: string, params: Record<string, unknown> = {}): string[] =>
    query(build(), text, params)
      .map((r) => JSON.stringify(r))
      .sort();

  test('a projection reading the START, which is what routes here', () => {
    // `MATCH (f)<-[:E]-(a:Few) RETURN f.t` reads `f`, the START — so `needsStart` sends it to the
    // filtered walk, and `:Few` on the far end makes the mirror the cheaper side. Its forward
    // twin reads the far end and takes a different walk entirely, so this is a cross-walk
    // comparison of one question.
    expect(rows('MATCH (f)<-[:E]-(a:Few) RETURN f.k AS k')).toEqual(
      rows('MATCH (a:Few)-[:E]->(f) RETURN f.k AS k'),
    );
  });

  test('both ends projected, so a swapped endpoint cannot hide', () => {
    // One column from each end. A mirror that resolved the wrong endpoint would return the same
    // NUMBER of rows with the two values exchanged, which a single-column projection cannot see.
    expect(rows('MATCH (f)<-[:E]-(a:Few) RETURN f.k AS fk, a.k AS ak')).toEqual(
      rows('MATCH (a:Few)-[:E]->(f) RETURN f.k AS fk, a.k AS ak'),
    );
  });

  test('a clause WHERE on the far end', () => {
    expect(rows('MATCH (f)<-[:E]-(a:Few) WHERE a.k = 3 RETURN f.k AS fk, a.k AS ak')).toEqual(
      rows('MATCH (a:Few)-[:E]->(f) WHERE a.k = 3 RETURN f.k AS fk, a.k AS ak'),
    );
  });

  test('a clause WHERE reading BOTH ends', () => {
    // The gate must be evaluated with both variables bound, and in the mirror the start is bound
    // inside the edge loop — so a gate reading the start would see a stale binding if the order
    // were wrong.
    expect(rows('MATCH (f)<-[:E]-(a:Few) WHERE a.k < f.k RETURN f.k AS fk, a.k AS ak')).toEqual(
      rows('MATCH (a:Few)-[:E]->(f) WHERE a.k < f.k RETURN f.k AS fk, a.k AS ak'),
    );
  });

  test("an INLINE constraint on the hop's far node", () => {
    expect(rows('MATCH (f)<-[:E]-(a:Few {k: 4}) RETURN f.k AS fk, a.k AS ak')).toEqual(
      rows('MATCH (a:Few {k: 4})-[:E]->(f) RETURN f.k AS fk, a.k AS ak'),
    );
  });

  test('a LABEL on the driven-away end is still applied', () => {
    // `:Many` on `f` must reject the `:Few` vertices. In the mirror this label is tested on the
    // RESOLVED endpoint inside the edge loop rather than inherited from the enumeration, which is
    // the one place it could be dropped silently.
    expect(rows('MATCH (f:Many)<-[:E]-(a:Few) RETURN f.k AS fk, a.k AS ak')).toEqual(
      rows('MATCH (a:Few)-[:E]->(f:Many) RETURN f.k AS fk, a.k AS ak'),
    );

    // And a start label NOTHING satisfies empties the result rather than being ignored.
    expect(rows('MATCH (f:Nobody)<-[:E]-(a:Few) RETURN f.k AS fk')).toEqual([]);
  });

  test('a param carries through', () => {
    expect(rows('MATCH (f)<-[:E]-(a:Few) WHERE a.k = $k RETURN f.k AS fk', { k: 7 })).toEqual(
      rows('MATCH (a:Few)-[:E]->(f) WHERE a.k = $k RETURN f.k AS fk', { k: 7 }),
    );
  });

  test('both arrow directions, so the mirrored index is not inverted', () => {
    // The mirror reads the OPPOSITE adjacency index from the start-driven walk. Getting that
    // backwards yields rows — just the wrong ones — so both directions are compared.
    expect(rows('MATCH (f)-[:E]->(a:Many) RETURN f.k AS fk, a.k AS ak')).toEqual(
      rows('MATCH (a:Many)<-[:E]-(f) RETURN f.k AS fk, a.k AS ak'),
    );
  });
});

describe('the far-driven walk does not raise where the start-driven one does not', () => {
  test('a faulting far constraint is not reached through a start the LABEL rejects', () => {
    // The subtle one, and the reason `farPred` is checked INSIDE the edge loop even though `far`
    // is fixed for the whole loop and hoisting it would be free.
    //
    // `bad` is reachable only from `wrong:Skipr`, which the pattern's `:Keepr` start label rejects.
    // The start-driven walk never reaches `bad`, so it never evaluates the faulting constraint on
    // it. A mirror that hoisted `farPred` out of the edge loop would evaluate it on `bad` while
    // enumerating the far side and raise where the query does not.
    const g = new Graph();
    const ok = g.addVertex({ id: 'ok', labels: ['Target'], properties: { s: 'x' } });
    // `bad.s` is a NUMBER, so `trim(bad.s)` is a data exception.
    const bad = g.addVertex({ id: 'bad', labels: ['Target'], properties: { s: 5 } });

    // TEN `:Keepr`, so the `:Target` bucket (2) is the smaller side and the mirror is chosen.
    // Every one of them points at `ok`.
    for (let i = 0; i < 10; i++) {
      g.addEdge({
        id: `e${i}`,
        labels: ['E'],
        from: g.addVertex({ id: `keep${i}`, labels: ['Keepr'], properties: { k: i } }),
        to: ok,
        properties: {},
      });
    }

    // `bad` has exactly one in-edge, and it comes from a vertex the `:Keepr` start label rejects.
    g.addEdge({
      id: 'eBad',
      labels: ['E'],
      from: g.addVertex({ id: 'skip', labels: ['Skipr'], properties: { k: 99 } }),
      to: bad,
      properties: {},
    });

    // The start-driven walk enumerates the ten `:Keepr` vertices and never reaches `bad`, so it
    // never evaluates the faulting constraint. The mirror enumerates the two `:Target`s — `bad`
    // among them — and must reject its only edge on the START LABEL before touching the
    // constraint. Hoisting `farPred` above the edge loop raises here; the query does not.
    expect(
      query(g, "MATCH (n:Keepr)-[:E]->(t:Target WHERE trim(t.s) = 'x') RETURN n.k AS k").length,
    ).toBe(10);

    // And the same with the constraint as a clause `WHERE`, which arrives as the `gate` rather
    // than as `farPred` — also inside the edge loop, for the same reason.
    expect(
      query(g, "MATCH (n:Keepr)-[:E]->(t:Target) WHERE trim(t.s) = 'x' RETURN n.k AS k").length,
    ).toBe(10);
  });
});
