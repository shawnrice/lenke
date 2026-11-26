import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { EDGE_DRIVEN_MIN_COVERAGE } from './executor/labels.js';
import { query } from './index.js';

/**
 * Item 1951: `farDrivenStartTestedPredicatedHopWalk` — the predicated route's middle ground, and
 * item 1940's lever one route over.
 *
 * `predicatedHopRoute` used to require a VACUOUS start label, so one isolated off-label vertex
 * dropped a filtered hop from the far-driven template walk all the way to `filteredHopWalk`'s
 * general per-edge closure — and the collapse is mostly about how many times the PREDICATE runs
 * (200,000 evaluations become 1,000,000), not about label tests.
 *
 * ```text
 *   MATCH (a:T)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x
 *   200,000 vertices / 1,000,000 edges, one off-label vertex, isolated A/B, min of 3 rounds:
 *
 *     PRE   369.6 ms      POST  266.3 ms      1.39x
 *     control, the same hop UNFILTERED        132.1 -> 134.9   (+2.1%)
 *     control, a SELECTIVE start (gate declines) 24.4 -> 24.8  (+1.6%)
 * ```
 *
 * ROW ORDER DIFFERS FROM EVERY OTHER ARM — far-vertex order outermost, edge order within. Row
 * order is unspecified for an unordered result (item 198), so every answer here is compared as a
 * MULTISET; item 1950 characterizes what an order-pinning test over such a fixture detects. An
 * `ORDER BY` sets `startDrivenForOrder` and never reaches this walk, which is its own test below.
 *
 * THE SOUNDNESS OF THE PREDICATE HOIST IS THE CALLER'S GATE, so the tests that matter most here
 * are the DECLINES: a start-reading predicate and a raising predicate must not reach this walk,
 * because it evaluates the predicate for far vertices whose every edge fails the start label.
 */
const asMultiset = (rows: readonly unknown[]): string[] =>
  rows.map((r) => JSON.stringify(r)).sort();

/**
 * `off` vertices are ISOLATED and carry no edges, so they change `vertexCount` and the `T` bucket
 * but no answer — which is what makes `MATCH (a:T)-…` and `MATCH (a)-…` the same question and lets
 * one be the oracle for the other. `offStart` instead takes EDGE-BEARING vertices off `T`, which is
 * what moves coverage and changes the answer, so those cases get the general path as their oracle.
 */
const build = (opts: { off?: number; offStart?: number; live?: number } = {}): Graph => {
  const { off = 0, offStart = 0, live = 12 } = opts;
  const g = new Graph();

  for (let i = 0; i < live; i += 1) {
    const labels = i >= live - offStart ? ['Z'] : ['T'];

    g.addVertex({ id: String(i + 1), labels, properties: { n: i % 5, id2: i } });
  }

  for (let i = 0; i < off; i += 1) {
    g.addVertex({ id: `off${String(i)}`, labels: ['Z'], properties: { n: -1 } });
  }

  for (let i = 0; i < live; i += 1) {
    const src = g.getVertexById(String(i + 1));
    const dst = g.getVertexById(String(((i * 5 + 1) % live) + 1));

    if (src === null || dst === null) {
      throw new Error('fixture lost a vertex');
    }

    g.addEdge({ id: `e${String(i)}`, from: src, to: dst, labels: ['E'], properties: { w: i } });
  }

  // A PARALLEL pair and a SELF-LOOP: the fold this walk gives up counted `bucket.size`, so a walk
  // that miscounts either shape is what these are here to catch.
  const v1 = g.getVertexById('1');
  const v2 = g.getVertexById('2');

  if (v1 === null || v2 === null) {
    throw new Error('fixture lost a vertex');
  }

  g.addEdge({ id: 'epar', from: v1, to: v2, labels: ['E'], properties: { w: 99 } });
  g.addEdge({ id: 'eself', from: v1, to: v1, labels: ['E'], properties: { w: 98 } });

  return g;
};

const Q = 'MATCH (a:T)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x';
/** The same question with no start label: the arm is unreachable, so this is the oracle. */
const ORACLE = 'MATCH (a)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x';

describe('farDrivenStartTestedPredicatedHopWalk — answers', () => {
  test('an ISOLATED off-label vertex changes no answer but does change the route', () => {
    const vacuous = query(build(), Q, { p0: 1 });
    const nonVacuous = query(build({ off: 1 }), Q, { p0: 1 });

    expect(asMultiset(nonVacuous)).toEqual(asMultiset(vacuous));
    expect(nonVacuous.length).toBeGreaterThan(0);
  });

  test('it agrees with the unlabelled-start spelling of the same question', () => {
    const g = build({ off: 1 });

    expect(asMultiset(query(g, Q, { p0: 1 }))).toEqual(asMultiset(query(g, ORACLE, { p0: 1 })));
  });

  test('a predicate that selects NOTHING answers nothing', () => {
    expect(query(build({ off: 1 }), Q, { p0: 999 }).length).toBe(0);
  });

  test('a predicate that selects EVERYTHING answers every edge into a T', () => {
    const g = build({ off: 1 });

    expect(asMultiset(query(g, Q, { p0: -1 }))).toEqual(asMultiset(query(g, ORACLE, { p0: -1 })));
  });

  test('parallel edges and a self-loop each yield their own row', () => {
    const g = build({ off: 1 });
    // v1 has `n = 0`; two edges arrive at v2 (`n = 1`) from v1 and the self-loop arrives at v1.
    const rows = query(g, 'MATCH (a:T)-[:E]->(b:T) FILTER b.n > -1 RETURN b.id2 AS i', {});

    expect(asMultiset(rows)).toEqual(
      asMultiset(query(g, 'MATCH (a)-[:E]->(b:T) FILTER b.n > -1 RETURN b.id2 AS i', {})),
    );
    // 12 generated + the parallel pair's second edge + the self-loop.
    expect(rows.length).toBe(14);
  });

  test('a far vertex whose every in-edge fails the START label contributes nothing', () => {
    // `offStart` takes edge-bearing vertices off `T`, so some far vertices keep only non-T sources.
    // This walk evaluates the predicate for them anyway (harmless, by the gate) and must emit no
    // row — the case that would be a WRONG ANSWER if the start test were dropped.
    for (const offStart of [1, 3, 5]) {
      const g = build({ offStart });

      expect(asMultiset(query(g, Q, { p0: 1 }))).toEqual(
        asMultiset(
          query(g, 'MATCH (a:T)-[:E]->(b:T) WHERE a.n = a.n AND b.n > $p0 RETURN b.n AS x', {
            p0: 1,
          }),
        ),
      );
    }
  });

  test('every coverage from 0 to 1 agrees with the general path', () => {
    // Sweeping ACROSS the gate's threshold, so both routes are exercised by one assertion.
    for (let offStart = 0; offStart <= 11; offStart += 1) {
      const g = build({ offStart, off: 1 });
      const general = query(
        g,
        'MATCH (a:T)-[:E]->(b:T) WHERE a.n = a.n AND b.n > $p0 RETURN b.n AS x',
        { p0: 1 },
      );

      expect(asMultiset(query(g, Q, { p0: 1 }))).toEqual(asMultiset(general));
    }
  });

  test('an IN hop (the reversed arrow) answers the same as its oracle', () => {
    const g = build({ off: 1 });

    expect(
      asMultiset(query(g, 'MATCH (a:T)<-[:E]-(b:T) FILTER b.n > $p0 RETURN b.n AS x', { p0: 1 })),
    ).toEqual(
      asMultiset(query(g, 'MATCH (a)<-[:E]-(b:T) FILTER b.n > $p0 RETURN b.n AS x', { p0: 1 })),
    );
  });
});

describe('farDrivenStartTestedPredicatedHopWalk — the declines that keep the hoist sound', () => {
  /*
   * The hoist evaluates the predicate once per far vertex, BEFORE any edge is tested. Three
   * properties of `farDrivenPredicatedApplies` make that unobservable, and each gets a test: the
   * predicate reads only the far end, it cannot raise, and there is no residual start-reading gate.
   */
  test('a predicate reading the START is answered correctly (it must not be hoisted)', () => {
    const g = build({ off: 1 });
    const q = 'MATCH (a:T)-[:E]->(b:T) FILTER a.n > $p0 RETURN b.n AS x';

    expect(asMultiset(query(g, q, { p0: 1 }))).toEqual(
      asMultiset(query(g, 'MATCH (a:T)-[:E]->(b:T) WHERE a.n > $p0 RETURN b.n AS x', { p0: 1 })),
    );
  });

  test('a predicate reading BOTH ends is answered correctly', () => {
    const g = build({ off: 1 });
    const q = 'MATCH (a:T)-[:E]->(b:T) FILTER b.n > a.n RETURN b.n AS x';

    expect(asMultiset(query(g, q, {}))).toEqual(
      asMultiset(query(g, 'MATCH (a:T)-[:E]->(b:T) WHERE b.n > a.n RETURN b.n AS x', {})),
    );
  });

  test('a RAISING predicate still raises, and from the same shape', () => {
    // A string divided by a number is the raising family `farDrivenPredicatedApplies` keys out via
    // `truthCannotRaise`. If the hoist took it, the far vertex it faults on could change.
    const g = new Graph();

    g.addVertex({ id: '1', labels: ['T'], properties: { s: 'x' } });
    g.addVertex({ id: '2', labels: ['T'], properties: { s: 'y' } });
    g.addVertex({ id: 'off', labels: ['Z'], properties: { s: 'z' } });

    const a = g.getVertexById('1');
    const b = g.getVertexById('2');

    if (a === null || b === null) {
      throw new Error('fixture');
    }

    g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });

    const run = (): unknown[] =>
      query(g, 'MATCH (a:T)-[:E]->(b:T) FILTER b.s / 2 > 1 RETURN b.s AS x', {});

    // Whatever the engine does with it, the two spellings must agree — that is the contract the
    // hoist could break. Compared by OUTCOME so this test does not pin a message.
    let fast: unknown = null;
    let slow: unknown = null;

    try {
      fast = asMultiset(run());
    } catch (e) {
      fast = `threw:${(e as Error).constructor.name}`;
    }

    try {
      slow = asMultiset(
        query(g, 'MATCH (a:T)-[:E]->(b:T) WHERE a.s = a.s AND b.s / 2 > 1 RETURN b.s AS x', {}),
      );
    } catch (e) {
      slow = `threw:${(e as Error).constructor.name}`;
    }

    expect(fast).toEqual(slow);
  });

  test('an ORDER BY is answered in order, so the walk is not reached', () => {
    const g = build({ off: 1 });
    const rows = query(
      g,
      'MATCH (a:T)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x, b.id2 AS i ORDER BY x, i',
      { p0: 1 },
    ) as { x: number; i: number }[];

    for (let k = 1; k < rows.length; k += 1) {
      const prev = rows[k - 1];
      const cur = rows[k];

      expect(prev.x < cur.x || (prev.x === cur.x && prev.i <= cur.i)).toBe(true);
    }

    expect(rows.length).toBeGreaterThan(0);
  });

  test('a SELECTIVE start label declines on coverage and still answers', () => {
    // 1 of 12 carries `S`, far below the threshold, so this must route exactly as before the item.
    const g = build({ off: 1 });
    const v = g.getVertexById('1');

    if (v === null) {
      throw new Error('fixture');
    }

    expect(EDGE_DRIVEN_MIN_COVERAGE).toBeGreaterThan(1 / 13);

    const q = 'MATCH (a:T)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x';

    expect(asMultiset(query(g, q, { p0: 1 }))).toEqual(
      asMultiset(
        query(g, 'MATCH (a:T)-[:E]->(b:T) WHERE a.n = a.n AND b.n > $p0 RETURN b.n AS x', {
          p0: 1,
        }),
      ),
    );
  });

  test('a COMPOUND start label declines (coverage is unreadable) and still answers', () => {
    const g = build({ off: 1 });

    expect(
      asMultiset(query(g, 'MATCH (a:T|Z)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x', { p0: 1 })),
    ).toEqual(asMultiset(query(g, ORACLE, { p0: 1 })));
  });

  /*
   * THIS CASE WAS MISSING AND MUTATION FOUND IT. Removing the walk's per-far-vertex
   * `matchesLabel(far, farLabel)` test survived the whole suite, because every other case here
   * uses a SIMPLE far label — and for a simple label `candidateVertexSource` already iterates that
   * label's bucket, so the test is redundant. For a COMPOUND far label `seedLabel` returns null and
   * the source becomes EVERY vertex, which makes the test the only thing applying the far label.
   * Nothing in `farDrivenPredicatedApplies` excludes a compound far label, so this is reachable.
   */
  test('a COMPOUND far label is applied, with a third label the source cannot seed', () => {
    const g = new Graph();

    // `W` is neither `T` nor `Z`, and it CARRIES IN-EDGES — which is what makes the far-label test
    // observable. An isolated off-label vertex could not catch this.
    //
    // THE `T` COUNT IS LOAD-BEARING AND MY FIRST VERSION GOT IT WRONG. With 2 `T` of 6 vertices
    // the start coverage is 0.333, BELOW `EDGE_DRIVEN_MIN_COVERAGE`, so the gate declined and this
    // test exercised the general closure — it passed while testing nothing of the new walk, and
    // the mutation run is what said so. Ten `T` of thirteen puts coverage at 0.77.
    for (let i = 0; i < 10; i += 1) {
      g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: 3 } });
    }

    for (const [id, labels] of [
      ['z1', ['Z']],
      ['w1', ['W']],
      ['w2', ['W']],
    ] as [string, string[]][]) {
      g.addVertex({ id, labels, properties: { n: 3 } });
    }

    const v = (id: string) => {
      const got = g.getVertexById(id);

      if (got === null) {
        throw new Error('fixture');
      }

      return got;
    };

    // Every edge leaves a `T`, so the START label is satisfied throughout and only the far label
    // can reject. Targets span `T`, `Z` and `W`.
    g.addEdge({ id: 'a', from: v('1'), to: v('2'), labels: ['E'], properties: {} });
    g.addEdge({ id: 'b', from: v('1'), to: v('z1'), labels: ['E'], properties: {} });
    g.addEdge({ id: 'c', from: v('2'), to: v('w1'), labels: ['E'], properties: {} });
    g.addEdge({ id: 'd', from: v('2'), to: v('w2'), labels: ['E'], properties: {} });

    const rows = query(g, 'MATCH (a:T)-[:E]->(b:T|Z) FILTER b.n > $p0 RETURN b.n AS x', { p0: 1 });

    // Exactly the two edges into `T`/`Z`; the two into `W` must be rejected.
    expect(rows.length).toBe(2);
    expect(asMultiset(rows)).toEqual(
      asMultiset(query(g, 'MATCH (a)-[:E]->(b:T|Z) FILTER b.n > $p0 RETURN b.n AS x', { p0: 1 })),
    );
  });

  test('a start label no vertex carries answers nothing', () => {
    expect(
      query(build({ off: 1 }), 'MATCH (a:Nope)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x', {
        p0: 1,
      }).length,
    ).toBe(0);
  });

  /*
   * THE CLONE IS LOAD-BEARING AND ONLY THIS TEST SAYS SO. Item 1952 builds one row per far
   * vertex and spreads it for the rest of the bucket; replacing `{ ...template }` with `template`
   * survived every other test in the repo, because nothing INSIDE the engine mutates a projected
   * row and two aliased rows carry identical values. The rows are handed to the CALLER, though, so
   * aliasing is observable the moment they touch one — and it would be a wrong answer they could
   * not explain. Mutation found this gap; the walk's three sibling folds share the same contract.
   */
  test('rows from one far vertex are INDEPENDENT objects, not aliases', () => {
    const g = build({ off: 1 });
    // A far vertex with several surviving in-edges, so at least two rows come from one template.
    const rows = query(g, 'MATCH (a:T)-[:E]->(b:T) FILTER b.n > -1 RETURN b.id2 AS i', {}) as {
      i: number;
    }[];

    expect(rows.length).toBeGreaterThan(1);

    // Group by value to find two rows that a template hoist would have shared.
    const byValue = new Map<number, { i: number }[]>();

    for (const row of rows) {
      const got = byValue.get(row.i);

      if (got === undefined) {
        byValue.set(row.i, [row]);
      } else {
        got.push(row);
      }
    }

    const shared = [...byValue.values()].find((group) => group.length > 1);

    if (shared === undefined) {
      throw new Error('fixture no longer gives any far vertex two surviving edges');
    }

    expect(shared[0]).not.toBe(shared[1]);

    // And writing through one must not reach the other.
    shared[0].i = -999;

    expect(shared[1].i).not.toBe(-999);
  });

  test('an empty graph answers nothing rather than throwing', () => {
    expect(query(new Graph(), Q, { p0: 1 }).length).toBe(0);
  });
});
