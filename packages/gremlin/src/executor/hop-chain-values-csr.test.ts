// `stackedWalk` — the depth-3-and-up values walk — now runs over flat slot runs from a cached CSR
// rather than a stack of bucket iterators (item 1680).
//
// ⚠️ ROW ORDER IS THE PROPERTY AT RISK AND IT IS A CONTRACT: Gremlin streams are compared ORDERED by
// the differential fuzzer. Every agreement test here is ordered, against the PIPELINE rather than
// against a hand-rolled expectation, using the `V(...ids)` trick that makes the shortcut decline.
//
// ⚠️ AND A ROUTE CHOICE IS ANSWER-EQUIVALENT, so each of those tests passes whether the walk fires
// or the pipeline does. `tookTheWalk` is the observable that keeps them from being vacuous — the
// `rung/never-fires` mutant survived this file's first mutation pass for exactly that reason.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, hasLabel, has, gte, id, out, in_, run, toArray, traversal, values } from '../index.js';

/**
 * Out-degree VARIES (1..5), which matters for more than realism: on an out-regular graph a k-walk
 * count is `N * F^k` by arithmetic whatever the traversal does, so a regular fixture cannot
 * distinguish a correct walk from a broken one. Item 1677 shipped one by mistake.
 */
const g = (() => {
  const graph = new Graph();
  const vs = [];
  const N = 60;

  for (let i = 0; i < N; i += 1) {
    vs.push(
      graph.addVertex({
        id: `v${i}`,
        labels: i % 7 === 0 ? ['P', 'Q'] : ['P'],
        // Every third vertex LACKS `age`, so `values('age')` has rows to drop.
        properties: i % 3 === 0 ? { n: i } : { n: i, age: i % 17 },
      }),
    );
  }

  let e = 0;

  for (let i = 0; i < N; i += 1) {
    const deg = 1 + ((i * 2654435761) % 5);

    for (let r = 0; r < deg; r += 1) {
      graph.addEdge({
        id: `e${e}`,
        from: vs[i],
        to: vs[(i * 19 + r * 7 + 1) % N],
        labels: [r % 4 === 0 ? 'F' : 'E'],
        properties: {},
      });
      e += 1;
    }
  }

  return graph;
})();

const ALL_IDS = [...g.vertices].map((v) => v.id);

/** `V(...ids)` declines the shortcut, so this is the pipeline — the oracle. */
const viaPipeline = (tail: readonly Parameters<typeof traversal>[number][]): unknown[] =>
  toArray(traversal(V(...ALL_IDS), ...tail), g);

const viaEngine = (tail: readonly Parameters<typeof traversal>[number][]): unknown[] =>
  toArray(traversal(V(), ...tail), g);

/** Only the fused walks carry `drain`, so this says the route actually fired. */
const tookTheWalk = (tail: readonly Parameters<typeof traversal>[number][]): boolean =>
  (run(traversal(V(), ...tail), g) as { drain?: unknown }).drain !== undefined;

describe('the slot walk agrees with the pipeline, ORDERED', () => {
  const CASES: [string, Parameters<typeof traversal>[number][]][] = [
    ['depth 3, values', [hasLabel('P'), out('E'), out('E'), out('E'), values('age')]],
    ['depth 4, values', [hasLabel('P'), out('E'), out('E'), out('E'), out('E'), values('age')]],
    [
      'depth 5, values',
      [hasLabel('P'), out('E'), out('E'), out('E'), out('E'), out('E'), values('age')],
    ],
    ['depth 3, id()', [hasLabel('P'), out('E'), out('E'), out('E'), id()]],
    ['depth 3, bare', [hasLabel('P'), out('E'), out('E'), out('E')]],
    ['depth 3, mixed labels', [hasLabel('P'), out('E'), out('F'), out('E'), values('age')]],
    ['depth 3, inward', [hasLabel('P'), in_('E'), in_('E'), in_('E'), values('age')]],
    ['depth 3, mixed direction', [hasLabel('P'), out('E'), in_('E'), out('E'), values('age')]],
    ['lead gate', [hasLabel('Q'), out('E'), out('E'), out('E'), values('age')]],
    [
      'interior gate',
      [hasLabel('P'), out('E'), has('n', gte(20)), out('E'), out('E'), values('age')],
    ],
    ['far gate', [hasLabel('P'), out('E'), out('E'), out('E'), has('n', gte(20)), values('age')]],
    [
      'gates at every position',
      [
        hasLabel('Q'),
        out('E'),
        has('n', gte(10)),
        out('E'),
        has('n', gte(20)),
        out('E'),
        has('n', gte(5)),
        values('age'),
      ],
    ],
  ];

  for (const [name, tail] of CASES) {
    test(`${name} — element for element`, () => {
      // ⚠️ FIRST: the route must actually be taken, or the comparison below is vacuous.
      expect(tookTheWalk(tail)).toBe(true);

      const want = viaPipeline(tail);
      const got = viaEngine(tail);

      expect(got).toEqual(want);
      // A non-empty result, so an "agrees" that compares two empty arrays cannot pass.
      expect(got.length).toBeGreaterThan(0);
    });
  }
});

describe('values() drops a far vertex lacking the key', () => {
  /**
   * Every third vertex has no `age`, so the dropped rows are the difference between the two
   * projections. Asserted as a strict inequality rather than a count, which would restate the
   * fixture.
   */
  test('the dropped rows are missing, and only those', () => {
    const tail = [hasLabel('P'), out('E'), out('E'), out('E')];
    const bare = viaEngine(tail);
    const aged = viaEngine([...tail, values('age')]);

    expect(aged.length).toBeLessThan(bare.length);
    expect(aged.every((x) => x !== undefined)).toBe(true);
    expect(aged).toEqual(viaPipeline([...tail, values('age')]));
  });
});

describe('a write between two traversals is seen', () => {
  /**
   * The CSR is cached on `graph.topologyVersion`, so this is the "traverse, write, traverse" shape
   * that a cache with no invalidation answers correctly forever. The count route has its own suite
   * for this (`chain-csr-cache.test.ts`); this one pins that the VALUES route reads the same signal.
   */
  const chain = [hasLabel('P'), out('E'), out('E'), out('E'), values('age')];

  test('an added edge changes the stream', () => {
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['P'], properties: { age: 1 } });
    const b = h.addVertex({ id: 'b', labels: ['P'], properties: { age: 2 } });
    const c = h.addVertex({ id: 'c', labels: ['P'], properties: { age: 3 } });
    const d = h.addVertex({ id: 'd', labels: ['P'], properties: { age: 4 } });

    h.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
    h.addEdge({ id: 'e2', from: b, to: c, labels: ['E'], properties: {} });
    h.addEdge({ id: 'e3', from: c, to: d, labels: ['E'], properties: {} });

    const before = toArray(traversal(V(), ...chain), h);
    expect(before).toEqual([4]);

    h.addEdge({ id: 'e4', from: c, to: a, labels: ['E'], properties: {} });

    const after = toArray(traversal(V(), ...chain), h);
    expect(after).not.toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
  });

  test('⚠️ an edge GAINING the walked label changes the stream', () => {
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['P'], properties: { age: 1 } });
    const b = h.addVertex({ id: 'b', labels: ['P'], properties: { age: 2 } });
    const c = h.addVertex({ id: 'c', labels: ['P'], properties: { age: 3 } });
    const d = h.addVertex({ id: 'd', labels: ['P'], properties: { age: 4 } });

    h.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
    h.addEdge({ id: 'e2', from: b, to: c, labels: ['E'], properties: {} });
    // The third hop is `:F` only, so the `:E` chain cannot complete.
    h.addEdge({ id: 'e3', from: c, to: d, labels: ['F'], properties: {} });

    expect(toArray(traversal(V(), ...chain), h)).toEqual([]);

    h.addLabelToEdge('E', h.getEdgeById('e3')!);

    expect(toArray(traversal(V(), ...chain), h)).toEqual([4]);
  });

  /**
   * A PROPERTY write does not bump `topologyVersion` — deliberately, so a `SET` does not discard the
   * adjacency cache — so the projection must be recomputed per call rather than cached alongside the
   * CSR. If it were cached on that signal this would return the stale value.
   */
  test('⚠️ a property write changes the stream even though the topology did not', () => {
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['P'], properties: { age: 1 } });
    const b = h.addVertex({ id: 'b', labels: ['P'], properties: { age: 2 } });
    const c = h.addVertex({ id: 'c', labels: ['P'], properties: { age: 3 } });
    const d = h.addVertex({ id: 'd', labels: ['P'], properties: { age: 4 } });

    h.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
    h.addEdge({ id: 'e2', from: b, to: c, labels: ['E'], properties: {} });
    h.addEdge({ id: 'e3', from: c, to: d, labels: ['E'], properties: {} });

    expect(toArray(traversal(V(), ...chain), h)).toEqual([4]);

    d.setProperty('age', 99);

    expect(toArray(traversal(V(), ...chain), h)).toEqual([99]);
  });

  /**
   * Likewise a gate reads labels and properties, so the gate masks must be per-call too.
   */
  test('⚠️ a property write changes which rows a gate admits', () => {
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['P'], properties: { n: 1, age: 1 } });
    const b = h.addVertex({ id: 'b', labels: ['P'], properties: { n: 2, age: 2 } });
    const c = h.addVertex({ id: 'c', labels: ['P'], properties: { n: 3, age: 3 } });
    const d = h.addVertex({ id: 'd', labels: ['P'], properties: { n: 4, age: 4 } });

    h.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
    h.addEdge({ id: 'e2', from: b, to: c, labels: ['E'], properties: {} });
    h.addEdge({ id: 'e3', from: c, to: d, labels: ['E'], properties: {} });

    const gated = [hasLabel('P'), out('E'), out('E'), out('E'), has('n', gte(50)), values('age')];

    expect(toArray(traversal(V(), ...gated), h)).toEqual([]);

    d.setProperty('n', 99);

    expect(toArray(traversal(V(), ...gated), h)).toEqual([4]);
  });
});
