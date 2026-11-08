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

    // The synchronous one has: one per edge map write, one per label indexed.
    expect(g.topologyVersion).toBe(before + 4);
  });

  /**
   * ⚠️ EXACT DELTAS, AND THE EXACTNESS IS LOAD-BEARING FOR THE **TEST** EVEN THOUGH THE
   * CONTRACT FORBIDS A **CONSUMER** FROM RELYING ON IT. Those are different claims. A consumer may
   * only ask "is this the same number I saw before?", because the delta is an implementation detail
   * that may change. A test that pins the delta detects a MISSING or REDUNDANT bump, which is the
   * only way to tell a live site from a dead one.
   *
   * This was learned by weakening it. When the signal grew the two edge-label sites, the delta
   * assertions here failed (a singly-labelled `addEdge` bumps twice, not once) and were relaxed to
   * "it changed". The next mutation pass then scored three mutants that the exact version had caught
   * as survivors — deleting the `edgesById.set` bump, deleting the `edgesById.delete` bump, and
   * adding a spurious bump on vertex-label commits — because every one of them leaves SOME other
   * site bumping on the same operation. Relaxing an assertion to match a widened implementation is
   * how a suite quietly stops testing.
   */
  test('the per-site deltas, asserted exactly', () => {
    const g = new Graph();
    const delta = (fn: () => void): number => {
      const before = g.topologyVersion;
      fn();

      return g.topologyVersion - before;
    };

    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    expect(delta(() => g.addVertex({ id: 'b', labels: ['P'], properties: {} }))).toBe(1);

    const b = g.getVertexById('b')!;

    // One for `edgesById.set`, one per label indexed into the type-keyed adjacency.
    expect(
      delta(() => g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} })),
    ).toBe(2);
    expect(
      delta(() => g.addEdge({ id: 'e2', from: a, to: b, labels: ['E', 'F'], properties: {} })),
    ).toBe(3);

    expect(delta(() => g.removeEdge(g.getEdgeById('e1')!))).toBe(2);
    expect(delta(() => g.removeVertex(b))).toBe(1 + 3);
  });

  /**
   * ⚠️ THE ≥1-LABEL INVARIANT MAKES THE TWO EDGE-MAP BUMPS REDUNDANT, which is worth stating
   * because it is why two mutants against them survive and why they are kept anyway.
   *
   * `addEdge` rejects an edge with no labels, so `edgesById.set` can never run without at least one
   * `indexEdgeLabel`, and `edgesById.delete` never without a `deIndexEdgeLabel`. Deleting either
   * edge-map bump therefore cannot under-invalidate: the label site still fires. They are kept as
   * defence in depth — with them, each map's bump is correct on its own terms, and the signal does
   * not silently depend on an invariant enforced elsewhere in the file. The delta test above is what
   * keeps them live rather than dead code.
   */
  test('⚠️ an edge cannot exist without a label, which is why the edge-map bumps are belt-and-braces', () => {
    const { g, a, b } = seed();

    expect(() => g.addEdge({ id: 'e', from: a, to: b, labels: [], properties: {} })).toThrow();
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
  test('⚠️ a property write, or a VERTEX label write, does NOT bump it', () => {
    const { g, a } = seed();
    const v = g.topologyVersion;

    a.setProperty('k', 99);
    expect(g.topologyVersion).toBe(v);

    a.properties = { k: 100, extra: 'x' };
    expect(g.topologyVersion).toBe(v);

    // A vertex's labels feed `verticesByLabel`, which no adjacency structure is derived from.
    //
    // ⚠️ BOTH THE SETTER AND THE METHODS, because they are DIFFERENT PATHS and only the methods
    // reach `commitElementLabels` — `v.labels =` bypasses it (which is a known hazard of its own).
    // A test that exercised only the setter scored a spurious bump on vertex-label commits as a
    // SURVIVOR, since the setter never reaches the site the mutant touched.
    a.labels = ['P', 'Q'];
    expect(g.topologyVersion).toBe(v);

    g.addLabelToVertex('R', a);
    expect(g.topologyVersion).toBe(v);

    g.removeLabelFromVertex('R', a);
    expect(g.topologyVersion).toBe(v);

    a.removeProperty('extra');
    expect(g.topologyVersion).toBe(v);
  });

  /**
   * ⚠️ THE HOLE THAT WOULD HAVE MADE THE FIRST CACHE A WRONG ANSWER, found while writing the
   * consumer rather than by this suite. The adjacency boxes are keyed BY EDGE TYPE, so an edge label
   * write moves the edge between buckets via `indexEdgeLabel`/`deIndexEdgeLabel` and never touches
   * `insertEdge`. A type-filtered CSR cached on a counter that ignored this would keep serving
   * neighbours for a type the edge no longer carries — the correct answer at every step, from a
   * structure describing a graph that no longer exists.
   *
   * So an EDGE label write bumps, where a VERTEX label write does not. The asymmetry is the point.
   */
  test('⚠️ an EDGE label write DOES bump it — adjacency is keyed by type', () => {
    const { g, a, b } = seed();
    const e = g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });

    const added = g.topologyVersion;
    g.addLabelToEdge('F', e);
    expect(g.topologyVersion).not.toBe(added);

    const removed = g.topologyVersion;
    g.removeLabelFromEdge('F', e);
    expect(g.topologyVersion).not.toBe(removed);
  });

  /**
   * The re-bucketing is observable through the public adjacency, which is what makes the bump
   * load-bearing rather than defensive: the same read returns different edges before and after.
   */
  test('and the re-bucketing it guards is observable from the adjacency box', () => {
    const { g, a, b } = seed();
    const e = g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });

    expect(a.adjFrom?.get('F')?.size ?? 0).toBe(0);

    g.addLabelToEdge('F', e);

    expect(a.adjFrom?.get('F')?.size ?? 0).toBe(1);
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
