import { describe, expect, test } from 'bun:test';

/**
 * `E()[.hasLabel(L)].values(k)` — the EDGE twin of the fused scan projection, item 1858.
 *
 * FOUND BY A ROUTE SCREEN, NOT A PROFILE, and the asymmetry is the finding: `E().count()` is
 * answered from a counter and `V().values(k)` rides a fused scan, while `E().values(k)` reached
 * NEITHER and fell to the traverser pipeline — 77 ns a row against the vertex twin's 30. The
 * vertex shortcut's `matchShape` requires a `V` source, so the edge spelling of the same question
 * had no rung at all. **2.15x** (15.34 -> 7.14 ms over 200,000 edges).
 *
 * THE ORDER IS PART OF THE ANSWER HERE. Gremlin results are compared ORDERED by the differential
 * fuzzer, so this walk must emit in the same sequence as the pipeline it replaces — every
 * assertion below compares ARRAYS, and the `drain` path is checked against the iterator path
 * because they are two consumers of one loop body and a drift between them would be a cross-engine
 * failure (item 169).
 *
 * AND A MISSING KEY IS NOT A NULL. `values(k)` emits NOTHING for an edge lacking `k` and a NULL
 * for one storing null — the fixture carries both, since a walk that conflated them would pass any
 * fixture where every edge has the key.
 */
import { Graph } from '@lenke/core';

import { E, hasLabel, run, toArray, traversal, values } from '../index.js';

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 12; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: {} });
  }

  const specs: [string, string, string[], Record<string, unknown>][] = [
    ['e0', 'E', ['E'], { w: 1 }],
    ['e1', 'E', ['E'], { w: null }], // a STORED null — emitted as null
    ['e2', 'E', ['E'], {}], // an ABSENT key — emitted not at all
    ['e3', 'F', ['F'], { w: 2 }],
    ['e4', 'F', ['F'], { w: 'two' }], // a string, so the walk cannot assume numbers
    ['e5', 'E', ['E', 'F'], { w: 3 }], // TWO labels: matches either hasLabel
    ['e6', 'G', ['G'], { other: 9 }], // no `w` at all
  ];

  for (const [i, [id, , labels, properties]] of specs.entries()) {
    const from = g.getVertexById(`v${i}`);
    const to = g.getVertexById(`v${i + 1}`);

    if (from === null || to === null) {
      throw new Error('fixture is broken');
    }

    g.addEdge({ id, from, to, labels, properties });
  }

  return g;
};

describe('the fused edge-values walk', () => {
  test('emits the same sequence as the route that cannot take it', () => {
    const g = build();

    for (const [shortcut, oracle] of [
      // THE ORACLE IS A SEEDED SOURCE, which `matchEdgeShape` refuses outright — so it runs the
      // pipeline over the same edges and in the same order. Naming every id keeps the question
      // identical rather than merely similar.
      [
        traversal(E(), values('w')),
        traversal(E('e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'), values('w')),
      ],
      [
        traversal(E(), hasLabel('E'), values('w')),
        traversal(E('e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'), hasLabel('E'), values('w')),
      ],
      [
        traversal(E(), hasLabel('F'), values('w')),
        traversal(E('e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'), hasLabel('F'), values('w')),
      ],
      [
        traversal(E(), hasLabel('E', 'F'), values('w')),
        traversal(E('e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'), hasLabel('E', 'F'), values('w')),
      ],
    ] as const) {
      const got = toArray(shortcut, g);

      expect(got.length).toBeGreaterThan(0);
      expect(JSON.stringify(got)).toBe(JSON.stringify(toArray(oracle, g)));
    }
  });

  /**
   * STATED AS AN EXPLICIT SEQUENCE too, not only against the oracle: two routes that made the
   * same mistake would agree with each other. `e1` stores null (emitted), `e2` and `e6` lack `w`
   * (not emitted), and `e5` carries two labels.
   */
  test('a stored null is emitted and an absent key is not', () => {
    const g = build();

    expect(toArray(traversal(E(), values('w')), g)).toEqual([1, null, 2, 'two', 3]);
    expect(toArray(traversal(E(), hasLabel('F'), values('w')), g)).toEqual([2, 'two', 3]);
  });

  /**
   * `drain` and the iterator are two consumers of ONE loop body; they must not drift.
   *
   * THE LAZY SIDE MUST COME FROM `run`, NOT `toArray`. The first version of this test iterated
   * `toArray`'s own result — an array that had already been drained — so both sides were the same
   * call and it compared `drain` against itself. `toArray` takes the `drain` path when a shortcut
   * offers one; `run` returns the iterable, so stepping that is the other consumer.
   */
  test('drain agrees with lazy iteration', () => {
    const g = build();
    const plan = traversal(E(), values('w'));
    const drained = toArray(plan, g);
    const iterated: unknown[] = [];

    for (const v of run(plan, g)) {
      iterated.push(v);
    }

    expect(JSON.stringify(drained)).toBe(JSON.stringify(iterated));
    expect(iterated.length).toBeGreaterThan(0);
  });

  test('a seeded E(id) source is refused, and still answers', () => {
    const g = build();

    expect(toArray(traversal(E('e3', 'e0'), values('w')), g)).toEqual([2, 1]);
  });

  /** A multi-key `values` is a different question and is refused. */
  test('a multi-key values is refused, and still answers', () => {
    const g = build();
    const got = toArray(traversal(E(), values('w', 'other')), g);

    expect(got.length).toBeGreaterThan(0);
    expect(got).toContain(9);
  });
});
