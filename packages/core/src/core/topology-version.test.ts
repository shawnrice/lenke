// `topologyVersion` exists so a consumer can cache an adjacency structure. Three properties make
// that sound, and the signals that already existed fail the first one — which is why item 1571
// designed a CSR cache and declined to build it.
import { describe, expect, test } from 'bun:test';

import { Graph } from './Graph.js';

const seed = (): {
  g: Graph;
  a: ReturnType<Graph['addVertex']>;
  b: ReturnType<Graph['addVertex']>;
} => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

  return { g, a, b };
};

describe('topologyVersion advances SYNCHRONOUSLY, which version and epoch do not', () => {
  /**
   * ⚠️ THE MEASUREMENT THAT DECLINED ITEM 1571'S CACHE, pinned as a test. Both `version` and
   * `epoch(name)` advance on a deferred, veto-checked step, so they read 0 through a sequence of
   * mutations and move only after a task drain. A cache keyed on either hands a STALE result to the
   * ordinary `g.addEdge(...); query(g, …)` shape — a wrong answer, silently.
   */
  test('⚠️ version and epoch are DEFERRED through three mutations; topologyVersion is not', () => {
    const { g, a, b } = seed();
    const before = g.topologyVersion;

    g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
    g.addEdge({ id: 'e2', from: b, to: a, labels: ['F'], properties: {} });

    // The deferred signals have not moved — this is the behaviour item 1571 measured.
    expect(g.version).toBe(0);

    // The synchronous one has: two vertices seeded, then two edges.
    expect(g.topologyVersion).toBe(before + 2);
  });

  test('every topology write bumps it exactly once', () => {
    const g = new Graph();
    const start = g.topologyVersion;

    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    expect(g.topologyVersion).toBe(start + 1);

    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    expect(g.topologyVersion).toBe(start + 2);

    const e = g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });
    expect(g.topologyVersion).toBe(start + 3);

    g.removeEdge(e);
    expect(g.topologyVersion).toBe(start + 4);

    g.removeVertex(b);
    expect(g.topologyVersion).toBe(start + 5);
  });
});

describe('what it does and does NOT respond to', () => {
  /**
   * ⚠️ THE CASE `vertexCount`/`edgeCount` CANNOT COVER, and the reason they were rejected as the
   * key. They advance eagerly, but a delete plus an add leaves both at their original value while
   * the topology differs — so a cache keyed on a count would serve an adjacency structure built for
   * a graph that no longer exists.
   */
  test('⚠️ a delete PLUS an add leaves both counts unchanged, and topologyVersion moves anyway', () => {
    const { g, a, b } = seed();
    const e = g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
    const counts = { v: g.vertexCount, e: g.edgeCount };
    const v = g.topologyVersion;

    g.removeEdge(e);
    g.addEdge({ id: 'e2', from: b, to: a, labels: ['E'], properties: {} });

    // Indistinguishable by count...
    expect(g.vertexCount).toBe(counts.v);
    expect(g.edgeCount).toBe(counts.e);
    // ...and distinguishable by this.
    expect(g.topologyVersion).not.toBe(v);
  });

  /**
   * ⚠️ TOPOLOGY, NOT MUTATION — and this is the property that makes the signal worth having rather
   * than just correct. A cached adjacency structure survives a property or label write, so bumping
   * on those would throw the cache away on every `SET` and the cache would never pay for itself on
   * a read-write workload.
   */
  test('⚠️ a property or label write does NOT bump it', () => {
    const { g, a } = seed();
    const v = g.topologyVersion;

    a.setProperty('k', 99);
    expect(g.topologyVersion).toBe(v);

    a.properties = { k: 100, extra: 'x' };
    expect(g.topologyVersion).toBe(v);

    a.labels = ['P', 'Q'];
    expect(g.topologyVersion).toBe(v);

    a.removeProperty('extra');
    expect(g.topologyVersion).toBe(v);
  });
});

describe('rollback', () => {
  /**
   * ⚠️ THE PROPERTY THAT MAKES IT SAFE WITHOUT UNDO SEMANTICS. The undo log stores inverse
   * operations as CLOSURES OVER THE PUBLIC MUTATORS (`insertEdge`'s inverse calls `removeEdge`,
   * `removeEdge`'s calls `addEdge`), so a rollback replays through the same four writes and bumps
   * this too. A consumer therefore rebuilds after a rollback rather than trusting a structure built
   * from the rolled-back state.
   *
   * It is deliberately NOT asserted that the version returns to its pre-transaction value, and
   * ⚠️ NOT because restoring it would be unsafe — item 1674 believed that and a mutation pass
   * refuted it. A rollback restores state FAITHFULLY, so a counter restored alongside it is
   * CONSISTENT: a cache entry at the pre-transaction version was built from the pre-transaction
   * state, which is exactly the post-rollback state. Both restoring and not restoring are sound,
   * and the mutant that restores it survives this suite CORRECTLY, as an equivalent mutant.
   *
   * What the assertion pins is the weaker, actually-load-bearing property: the version CHANGES
   * when state changes. Not-restoring is simply the simpler choice — it over-invalidates by one
   * rebuild after a rollback and needs no bookkeeping in the undo path.
   */
  test('⚠️ a rolled-back transaction still bumps it — conservative, not exact', () => {
    const { g, a, b } = seed();
    const v = g.topologyVersion;

    expect(() =>
      g.transaction(() => {
        g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });

        throw new Error('rollback');
      }),
    ).toThrow('rollback');

    // The edge is gone...
    expect(g.edgeCount).toBe(0);
    // ...and the version moved, so a cache rebuilds rather than trusting the rolled-back state.
    expect(g.topologyVersion).not.toBe(v);
  });

  test('a committed transaction bumps it too', () => {
    const { g, a, b } = seed();
    const v = g.topologyVersion;

    g.transaction(() => {
      g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
    });

    expect(g.edgeCount).toBe(1);
    expect(g.topologyVersion).not.toBe(v);
  });
});
